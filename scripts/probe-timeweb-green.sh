#!/bin/sh
set -eu
PATH=/usr/sbin:/usr/bin:/sbin:/bin
IFS=$(printf ' \t\n_')
IFS=${IFS%_}
LANG=C
LC_ALL=C
export PATH IFS LANG LC_ALL
unset CDPATH ENV BASH_ENV CURL_HOME \
  DOCKER_HOST DOCKER_CONTEXT DOCKER_CONFIG \
  COMPOSE_FILE COMPOSE_PROJECT_NAME COMPOSE_PROFILES COMPOSE_ENV_FILES COMPOSE_PATH_SEPARATOR \
  http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY NO_PROXY no_proxy

fail() {
  echo "TIMEWEB_GREEN_PROBE_FAILED|reason=$1" >&2
  exit 1
}

[ "$(id -u)" -eq 0 ] || fail root_required
[ "$#" -eq 1 ] || fail usage
stage=$1
case "$stage" in infrastructure|application-dark|ingress) ;; *) fail invalid_stage ;; esac

curl_probe() {
  curl --fail --silent --show-error --max-time 5 --output /dev/null "$1" || fail "$2"
}

disk_record=$(df -Pk / | awk 'NR == 2 { print $4 "|" $5 }')
disk_free_kib=${disk_record%%|*}
disk_used_percent=${disk_record##*|}
disk_used_percent=${disk_used_percent%%%}
printf '%s' "$disk_free_kib" | grep -Eq '^[0-9]+$' || fail disk_parse
printf '%s' "$disk_used_percent" | grep -Eq '^[0-9]+$' || fail disk_parse
[ "$disk_free_kib" -ge 20971520 ] || fail disk_free_below_20_gib
[ "$disk_used_percent" -lt 70 ] || fail disk_usage_above_budget

memory_record=$(free -b | awk '/^Mem:/ { print $2 "|" $3 }')
memory_total=${memory_record%%|*}
memory_used=${memory_record##*|}
printf '%s' "$memory_total" | grep -Eq '^[0-9]+$' || fail memory_parse
printf '%s' "$memory_used" | grep -Eq '^[0-9]+$' || fail memory_parse
[ "$memory_total" -gt 0 ] || fail memory_total_zero
memory_used_percent=$((memory_used * 100 / memory_total))
[ "$memory_used_percent" -lt 80 ] || fail memory_usage_above_budget

swap_record=$(free -b | awk '/^Swap:/ { print $2 "|" $3 }')
swap_total=${swap_record%%|*}
swap_used=${swap_record##*|}
printf '%s' "$swap_total" | grep -Eq '^[0-9]+$' || fail swap_parse
printf '%s' "$swap_used" | grep -Eq '^[0-9]+$' || fail swap_parse
swap_used_percent=0
if [ "$swap_total" -gt 0 ]; then
  swap_used_percent=$((swap_used * 100 / swap_total))
  [ "$swap_used_percent" -lt 50 ] || fail swap_usage_above_budget
fi

cpu_record_before=$(awk '/^cpu / { idle=$5+$6; total=0; for (i=2; i<=NF; i++) total+=$i; print total "|" idle; exit }' /proc/stat)
sleep 1
cpu_record_after=$(awk '/^cpu / { idle=$5+$6; total=0; for (i=2; i<=NF; i++) total+=$i; print total "|" idle; exit }' /proc/stat)
cpu_total_before=${cpu_record_before%%|*}
cpu_idle_before=${cpu_record_before##*|}
cpu_total_after=${cpu_record_after%%|*}
cpu_idle_after=${cpu_record_after##*|}
cpu_total_delta=$((cpu_total_after - cpu_total_before))
cpu_idle_delta=$((cpu_idle_after - cpu_idle_before))
[ "$cpu_total_delta" -gt 0 ] || fail cpu_parse
cpu_used_percent=$(((cpu_total_delta - cpu_idle_delta) * 100 / cpu_total_delta))
[ "$cpu_used_percent" -lt 70 ] || fail cpu_usage_above_budget

assert_project() {
  project=$1
  expected_services=$2
  records=$(docker ps -a --filter "label=com.docker.compose.project=$project" \
    --format '{{.Names}}|{{.Status}}')
  [ -n "$records" ] || fail "project_${project}_absent"
  for service in $expected_services; do
    printf '%s\n' "$records" | grep -Eq "^${project}-${service}-[0-9]+\|Up " ||
      fail "service_${service}_not_running"
  done
  container_ids=$(docker ps -aq --filter "label=com.docker.compose.project=$project")
  [ -n "$container_ids" ] || fail "project_${project}_absent"
  for container_id in $container_ids; do
    record=$(docker inspect --format '{{.RestartCount}}|{{.State.OOMKilled}}|{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}absent{{end}}' "$container_id")
    [ "$record" = '0|false|running|healthy' ] || fail "project_${project}_container_state"
  done
}

assert_project phub-timeweb-infrastructure \
  'nginx postgres redis rabbitmq otel-collector prometheus grafana swagger-ui swagger-editor'
curl_probe http://127.0.0.1:13133/ otel_health
curl_probe http://127.0.0.1:9090/-/ready prometheus_ready
curl_probe http://127.0.0.1:3101/api/health grafana_health
curl_probe http://127.0.0.1:18080/ swagger_ui_health
curl_probe http://127.0.0.1:18082/ swagger_editor_health
prometheus_up=$(curl --fail --silent --show-error --max-time 5 \
  --get --data-urlencode 'query=up{job="otel-collector"} == 1' \
  http://127.0.0.1:9090/api/v1/query) || fail prometheus_query
printf '%s' "$prometheus_up" | grep -Eq '"result"[[:space:]]*:[[:space:]]*\[[{]' ||
  fail prometheus_otel_target_down

postgres_id=$(docker ps -q \
  --filter label=com.docker.compose.project=phub-timeweb-infrastructure \
  --filter label=com.docker.compose.service=postgres)
[ -n "$postgres_id" ] || fail postgres_container_absent
database_pool=$(docker exec "$postgres_id" psql -U phub -d phub -Atqc \
  "select count(*)::text || '|' || current_setting('max_connections') from pg_stat_activity") ||
  fail database_pool_query
database_connections=${database_pool%%|*}
database_max_connections=${database_pool##*|}
printf '%s' "$database_connections" | grep -Eq '^[0-9]+$' || fail database_pool_parse
printf '%s' "$database_max_connections" | grep -Eq '^[0-9]+$' || fail database_pool_parse
[ "$database_max_connections" -gt 0 ] || fail database_pool_zero
database_pool_percent=$((database_connections * 100 / database_max_connections))
[ "$database_pool_percent" -lt 70 ] || fail database_pool_above_budget

rabbitmq_id=$(docker ps -q \
  --filter label=com.docker.compose.project=phub-timeweb-infrastructure \
  --filter label=com.docker.compose.service=rabbitmq)
[ -n "$rabbitmq_id" ] || fail rabbitmq_container_absent
rabbitmq_rows=$(docker exec "$rabbitmq_id" rabbitmqctl -q list_queues \
  messages_ready messages_unacknowledged 2>/dev/null) || fail rabbitmq_backlog_query
rabbitmq_backlog=$(printf '%s\n' "$rabbitmq_rows" | awk '
    NF == 2 { ready += $1; unacked += $2 }
    END { print ready + 0 "|" unacked + 0 }
  ') || fail rabbitmq_backlog_parse
rabbitmq_ready=${rabbitmq_backlog%%|*}
rabbitmq_unacked=${rabbitmq_backlog##*|}
[ "$rabbitmq_ready" -eq 0 ] && [ "$rabbitmq_unacked" -eq 0 ] || fail rabbitmq_backlog_nonzero

redis_id=$(docker ps -q \
  --filter label=com.docker.compose.project=phub-timeweb-infrastructure \
  --filter label=com.docker.compose.service=redis)
[ -n "$redis_id" ] || fail redis_container_absent
docker exec "$redis_id" sh -eu -c '
  password=$(sed -n "s/^user phub on >\\([^[:space:]]*\\).*/\\1/p" /usr/local/etc/redis/users.acl)
  [ -n "$password" ]
  REDISCLI_AUTH=$password redis-cli --user phub ping
' >/dev/null 2>&1 || fail redis_authenticated_ping

if [ "$stage" = application-dark ] || [ "$stage" = ingress ]; then
  assert_project phub-timeweb-staging 'web api realtime'
  curl_probe http://127.0.0.1:3000/health/ready api_ready
  curl_probe http://127.0.0.1:3001/health/ready realtime_ready
  nginx_id=$(docker ps -q \
    --filter label=com.docker.compose.project=phub-timeweb-infrastructure \
    --filter label=com.docker.compose.service=nginx)
  [ -n "$nginx_id" ] || fail nginx_container_absent
  nginx_logs=$(docker logs --since 5m "$nginx_id" 2>&1) || fail nginx_logs_query
  nginx_5xx=$(printf '%s\n' "$nginx_logs" | grep -Ec '"status":"?5[0-9][0-9]"?' || true)
  [ "$nginx_5xx" -eq 0 ] || fail nginx_5xx_observed
fi

if [ "$stage" = ingress ]; then
  assert_project phub-timeweb-ingress 'caddy'
  domain=$(sed -n 's/^PHUB_STAGING_DOMAIN=//p' /etc/phub/ingress.env)
  printf '%s' "$domain" | grep -Eq '^([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$' ||
    fail ingress_domain
  curl --fail --silent --show-error --max-time 10 --output /dev/null \
    --resolve "$domain:443:127.0.0.1" "https://$domain/healthz" || fail ingress_tls_health
fi

echo "TIMEWEB_GREEN_PROBE_PASSED|stage=$stage|cpu_used_percent=$cpu_used_percent|memory_used_percent=$memory_used_percent|swap_used_percent=$swap_used_percent|disk_used_percent=$disk_used_percent|disk_free_kib=$disk_free_kib|database_pool_percent=$database_pool_percent|rabbitmq_ready=$rabbitmq_ready|rabbitmq_unacked=$rabbitmq_unacked|secrets_printed=false|authorizes_cutover=false"
