#!/bin/sh

set -eu

tenant_keys="${1:?approved tenant keys are required}"
candidate_sha="${2:?candidate SHA is required}"
run_id="${3:?run ID is required}"
run_attempt="${4:?run attempt is required}"
expected_active_sha="${5:?expected active release SHA is required}"
application_backup="${6:?application backup path is required}"
operation="${7:?release operation is required}"
candidate_release_input="${8:?candidate release env path is required}"
app_root="${PHUB_APP_ROOT:-/opt/phub}"
backup_tmp=''
release_completed=false
catalog_digest=''

fail() {
  printf '%s\n' "Chat/push foundation release refused: $*" >&2
  exit 1
}

test "$(printf '%s' "$tenant_keys$candidate_sha$run_id$run_attempt$expected_active_sha$application_backup$operation$candidate_release_input" | tr -d '\r\n')" = \
  "$tenant_keys$candidate_sha$run_id$run_attempt$expected_active_sha$application_backup$operation$candidate_release_input" ||
  fail 'release arguments must each be single-line values'
case "$operation" in
  start | recover | prepare-recovery) ;;
  *) fail 'release operation must be start, recover or prepare-recovery' ;;
esac
printf '%s' "$tenant_keys" | grep -Eq '^[a-z0-9][a-z0-9-]{1,62}(,[a-z0-9][a-z0-9-]{1,62})*$' ||
  fail 'approved tenant keys are invalid'
printf '%s' "$candidate_sha" | grep -Eq '^[0-9a-f]{40}$' || fail 'candidate SHA is invalid'
printf '%s' "$expected_active_sha" | grep -Eq '^[0-9a-f]{40}$' ||
  fail 'expected active release SHA is invalid'
case "$run_id:$run_attempt" in
  *[!0-9:]*) fail 'run identity is invalid' ;;
  :* | *:) fail 'run identity is invalid' ;;
esac
test "$run_attempt" = 1 || fail 'foundation workflow reruns are forbidden'
expected_backup="$app_root/backups/releases/pre-$candidate_sha-$run_id-$run_attempt"
test "$application_backup" = "$expected_backup" || fail 'application backup path is not run-bound'
test -d "$application_backup" && test ! -L "$application_backup" ||
  fail 'validated application backup is absent'
test "$(sed -n 's/^RELEASE=//p' "$application_backup/release.env")" = "$expected_active_sha" ||
  fail 'application backup release does not match the approved active release'
test "$(cat "$application_backup/backup.complete")" = "$expected_active_sha" ||
  fail 'application backup completion marker does not match the approved active release'

if test "$operation" = prepare-recovery; then
  test "$candidate_release_input" = "$application_backup/foundation.candidate-release.env" ||
    fail 'stored recovery candidate release path is invalid'
else
  candidate_release_basename="${candidate_release_input#"$app_root"/}"
  test "$candidate_release_input" = "$app_root/$candidate_release_basename" ||
    fail 'candidate release env path is not bounded'
  printf '%s' "$candidate_release_basename" | grep -Eq '^release\.foundation\.[0-9]+\.env$' ||
    fail 'candidate release env path is not bounded'
fi
test -f "$candidate_release_input" && test ! -L "$candidate_release_input" ||
  fail 'candidate release env is absent or unsafe'
test "$(stat -c %a "$candidate_release_input")" = 600 ||
  fail 'candidate release env mode is not 0600'

release_value() {
  release_file="$1"
  release_key="$2"
  test "$(awk -F= -v key="$release_key" '$1 == key { count += 1 } END { print count + 0 }' "$release_file")" -eq 1 ||
    fail "candidate release env must contain exactly one $release_key"
  sed -n "s/^${release_key}=//p" "$release_file"
}

validate_candidate_release() {
  release_file="$1"
  test "$(wc -l < "$release_file" | tr -d ' ')" -eq 10 ||
    fail 'candidate release env must contain exactly ten lines'
  awk -F= '
    $1 == "REGISTRY" ||
    $1 == "WEB_IMAGE_DIGEST" ||
    $1 == "API_IMAGE_DIGEST" ||
    $1 == "WORKER_IMAGE_DIGEST" ||
    $1 == "REALTIME_IMAGE_DIGEST" ||
    $1 == "MIGRATOR_IMAGE_DIGEST" ||
    $1 == "RELEASE" ||
    $1 == "LATEST_MIGRATION" ||
    $1 == "S3_PUBLIC_ENDPOINT" ||
    $1 == "FOUNDATION_MONITORING_RULES_SHA256" { next }
    { exit 1 }
  ' "$release_file" || fail 'candidate release env contains an unexpected key'
  test "$(release_value "$release_file" REGISTRY)" = ghcr.io/z6v6e6r ||
    fail 'candidate registry is invalid'
  test "$(release_value "$release_file" RELEASE)" = "$candidate_sha" ||
    fail 'candidate release SHA does not match the approved candidate'
  for digest_key in WEB_IMAGE_DIGEST API_IMAGE_DIGEST WORKER_IMAGE_DIGEST REALTIME_IMAGE_DIGEST MIGRATOR_IMAGE_DIGEST; do
    release_value "$release_file" "$digest_key" | grep -Eq '^sha256:[0-9a-f]{64}$' ||
      fail "candidate $digest_key is not immutable"
  done
  release_value "$release_file" LATEST_MIGRATION |
    grep -Eq '^[0-9]{4}_[a-z0-9_]+\.sql$' || fail 'candidate migration identity is invalid'
  release_value "$release_file" S3_PUBLIC_ENDPOINT |
    grep -Eq '^https://[^[:space:]]+$' || fail 'candidate public endpoint is invalid'
  release_value "$release_file" FOUNDATION_MONITORING_RULES_SHA256 |
    grep -Eq '^[0-9a-f]{64}$' || fail 'candidate monitoring digest is invalid'
}

validate_candidate_release "$candidate_release_input"
candidate_release_env="$application_backup/foundation.candidate-release.env"
recovery_manifest="$application_backup/chat-push-foundation.recovery"
catalog_digest_path="$application_backup/chat-push-foundation.catalog-digest"
database_backup_pointer="$application_backup/chat-push-foundation.database-backup"
monitoring_digest_path="$application_backup/chat-push-foundation.monitoring-digest"

manifest_value() {
  manifest_key="$1"
  test "$(awk -F= -v key="$manifest_key" '$1 == key { count += 1 } END { print count + 0 }' "$recovery_manifest")" -eq 1 ||
    fail "recovery manifest must contain exactly one $manifest_key"
  sed -n "s/^${manifest_key}=//p" "$recovery_manifest"
}

database_backup_value() {
  backup_key="$1"
  test "$(awk -F= -v key="$backup_key" '$1 == key { count += 1 } END { print count + 0 }' "$database_backup_pointer")" -eq 1 ||
    fail "database backup manifest must contain exactly one $backup_key"
  sed -n "s/^${backup_key}=//p" "$database_backup_pointer"
}

write_phase_marker() {
  phase_state="$1"
  phase_path="$application_backup/chat-push-foundation.phase"
  if test -e "$phase_path" || test -L "$phase_path"; then
    test -f "$phase_path" && test ! -L "$phase_path" ||
      fail 'foundation phase marker is unsafe'
    test "$(stat -c %a "$phase_path")" = 600 || fail 'foundation phase marker mode is invalid'
  fi
  phase_tmp="$application_backup/.chat-push-foundation-phase.$$"
  test ! -e "$phase_tmp" && test ! -L "$phase_tmp" ||
    fail 'foundation phase temporary file already exists'
  printf '%s\n' "$phase_state" > "$phase_tmp"
  chmod 600 "$phase_tmp"
  mv "$phase_tmp" "$phase_path"
}

initialize_recovery_state() {
  for recovery_path in "$candidate_release_env" "$recovery_manifest" "$catalog_digest_path" "$database_backup_pointer" "$monitoring_digest_path" "$application_backup/chat-push-foundation.phase"; do
    test ! -e "$recovery_path" && test ! -L "$recovery_path" ||
      fail 'new foundation backup already contains recovery state'
  done
  install -m 600 "$candidate_release_input" "$candidate_release_env"
  tenant_digest="$(printf '%s' "$tenant_keys" | sha256sum | cut -d ' ' -f 1)"
  release_digest="$(sha256sum "$candidate_release_env" | cut -d ' ' -f 1)"
  manifest_tmp="$application_backup/.chat-push-foundation-recovery.$$"
  {
    printf '%s\n' 'FORMAT=CHAT_PUSH_FOUNDATION_RECOVERY_V1'
    printf '%s\n' "CANDIDATE_SHA=$candidate_sha"
    printf '%s\n' "ORIGINAL_RUN_ID=$run_id"
    printf '%s\n' "ORIGINAL_RUN_ATTEMPT=$run_attempt"
    printf '%s\n' "EXPECTED_ACTIVE_SHA=$expected_active_sha"
    printf '%s\n' "TENANT_KEYS_SHA256=$tenant_digest"
    printf '%s\n' "CANDIDATE_RELEASE_SHA256=$release_digest"
  } > "$manifest_tmp"
  chmod 600 "$manifest_tmp"
  mv "$manifest_tmp" "$recovery_manifest"
}

verify_recovery_state() {
  for recovery_path in "$candidate_release_env" "$recovery_manifest" "$catalog_digest_path" "$database_backup_pointer" "$monitoring_digest_path" "$application_backup/chat-push-foundation.phase"; do
    test -f "$recovery_path" && test ! -L "$recovery_path" ||
      fail 'recovery state is incomplete or unsafe'
    test "$(stat -c %a "$recovery_path")" = 600 || fail 'recovery state mode is not 0600'
  done
  test "$(wc -l < "$recovery_manifest" | tr -d ' ')" -eq 7 ||
    fail 'recovery manifest shape is invalid'
  test "$(manifest_value FORMAT)" = CHAT_PUSH_FOUNDATION_RECOVERY_V1 ||
    fail 'recovery manifest version is invalid'
  test "$(manifest_value CANDIDATE_SHA)" = "$candidate_sha" ||
    fail 'recovery candidate SHA mismatch'
  test "$(manifest_value ORIGINAL_RUN_ID)" = "$run_id" || fail 'recovery run ID mismatch'
  test "$(manifest_value ORIGINAL_RUN_ATTEMPT)" = "$run_attempt" ||
    fail 'recovery run attempt mismatch'
  test "$(manifest_value EXPECTED_ACTIVE_SHA)" = "$expected_active_sha" ||
    fail 'recovery active release mismatch'
  test "$(manifest_value TENANT_KEYS_SHA256)" = "$(printf '%s' "$tenant_keys" | sha256sum | cut -d ' ' -f 1)" ||
    fail 'recovery tenant inventory mismatch'
  test "$(manifest_value CANDIDATE_RELEASE_SHA256)" = "$(sha256sum "$candidate_release_env" | cut -d ' ' -f 1)" ||
    fail 'stored candidate release digest mismatch'
  cmp "$candidate_release_input" "$candidate_release_env" >/dev/null ||
    fail 'recovery build digests differ from the original candidate'
  validate_candidate_release "$candidate_release_env"
  active_release="$app_root/release.env"
  test -f "$active_release" && test ! -L "$active_release" ||
    fail 'active release env is absent or unsafe'
  if ! cmp "$active_release" "$application_backup/release.env" >/dev/null &&
    ! cmp "$active_release" "$candidate_release_env" >/dev/null; then
    fail 'active release changed after the failed foundation run'
  fi
  catalog_digest="$(cat "$catalog_digest_path")"
  printf '%s' "$catalog_digest" | grep -Eq '^[0-9a-f]{64}$' ||
    fail 'stored catalog digest is invalid'
  monitoring_digest="$(cat "$monitoring_digest_path")"
  printf '%s' "$monitoring_digest" | grep -Eq '^[0-9a-f]{64}$' ||
    fail 'stored monitoring digest is invalid'
  test "$monitoring_digest" = "$(sha256sum "$app_root/monitoring/padlhub-alerts.yaml" | cut -d ' ' -f 1)" ||
    fail 'candidate monitoring definition drifted'
  test "$(wc -l < "$database_backup_pointer" | tr -d ' ')" -eq 3 ||
    fail 'database backup manifest shape is invalid'
  awk -F= '
    $1 == "PATH" || $1 == "SIZE" || $1 == "SHA256" { next }
    { exit 1 }
  ' "$database_backup_pointer" || fail 'database backup manifest contains an unexpected key'
  database_backup="$(database_backup_value PATH)"
  database_backup_size="$(database_backup_value SIZE)"
  database_backup_sha256="$(database_backup_value SHA256)"
  case "$database_backup" in
    "$app_root"/backups/postgres-pre-"$candidate_sha"-*.dump) ;;
    *) fail 'stored database backup path is invalid' ;;
  esac
  printf '%s' "$database_backup_size" | grep -Eq '^[1-9][0-9]*$' ||
    fail 'stored database backup size is invalid'
  printf '%s' "$database_backup_sha256" | grep -Eq '^[0-9a-f]{64}$' ||
    fail 'stored database backup digest is invalid'
  test -s "$database_backup" && test -f "$database_backup" && test ! -L "$database_backup" ||
    fail 'stored database backup is absent or unsafe'
  test "$(stat -c %a "$database_backup")" = 600 || fail 'stored database backup mode is invalid'
  test "$(wc -c < "$database_backup" | tr -d ' ')" = "$database_backup_size" ||
    fail 'stored database backup size mismatch'
  test "$(sha256sum "$database_backup" | cut -d ' ' -f 1)" = "$database_backup_sha256" ||
    fail 'stored database backup digest mismatch'
  phase_state="$(cat "$application_backup/chat-push-foundation.phase")"
  case "$phase_state" in
    MIGRATION_STARTED | POST_MIGRATION_VERIFIED | CANDIDATE_RUNTIME_STARTING | CANDIDATE_API_READY | CANDIDATE_WORKER_READY | CANDIDATE_REALTIME_READY | CANDIDATE_WEB_READY | CANDIDATE_RUNTIME_VERIFIED | EXTERNAL_SMOKE_FAILED | RECOVERY_STARTED | RECOVERY_DRAINING | RECOVERY_WRITERS_DRAINED) ;;
    *) fail 'stored recovery phase is invalid' ;;
  esac
}

if test "$operation" = start; then
  initialize_recovery_state
else
  verify_recovery_state
fi

cd "$app_root"

compose() {
  docker compose --env-file infrastructure.env --env-file "$candidate_release_env" "$@"
}

infrastructure() {
  docker compose --env-file infrastructure.env -f compose.infrastructure.yaml "$@"
}

if test "$operation" = recover; then
  infrastructure exec -T postgres pg_restore --list < "$database_backup" >/dev/null ||
    fail 'stored database backup archive is invalid'
fi

if test "$operation" = prepare-recovery; then
  infrastructure exec -T postgres pg_restore --list < "$database_backup" >/dev/null ||
    fail 'stored database backup archive is invalid'
  write_phase_marker RECOVERY_STARTED
  printf '%s\n' 'Chat/push foundation recovery prepared before workflow mutations'
  exit 0
fi

runtime_env=/etc/phub/staging.env
realtime_env=/etc/phub/realtime.env
migrator_env=/etc/phub/staging.migrator.env
test -r "$runtime_env" || fail 'runtime credential file is unreadable'
test -r "$realtime_env" || fail 'realtime credential file is unreadable'
test -r "$migrator_env" || fail 'migrator credential file is unreadable'
test "$(stat -c %a "$migrator_env")" = 600 || fail 'migrator credential mode is not 0600'
test ! "$runtime_env" -ef "$migrator_env" || fail 'runtime and migrator credential files alias'
awk '
  /^[[:space:]]*($|#)/ { next }
  /^DATABASE_URL=/ { next }
  { exit 1 }
' "$migrator_env" || fail 'migrator credential file contains an unexpected key'
test "$(awk -F= '$1 == "DATABASE_URL" { count += 1 } END { print count + 0 }' "$runtime_env")" -eq 1 ||
  fail 'runtime credential file must contain exactly one DATABASE_URL'
test "$(awk -F= '$1 == "DATABASE_URL" { count += 1 } END { print count + 0 }' "$realtime_env")" -eq 1 ||
  fail 'realtime credential file must contain exactly one DATABASE_URL'
test "$(awk -F= '$1 == "DATABASE_URL" { count += 1 } END { print count + 0 }' "$migrator_env")" -eq 1 ||
  fail 'migrator credential file must contain exactly one DATABASE_URL'
runtime_database_url="$(sed -n 's/^DATABASE_URL=//p' "$runtime_env")"
realtime_database_url="$(sed -n 's/^DATABASE_URL=//p' "$realtime_env")"
migrator_database_url="$(sed -n 's/^DATABASE_URL=//p' "$migrator_env")"
case "$runtime_database_url:$realtime_database_url:$migrator_database_url" in
  postgresql://*:postgresql://*:postgresql://* | postgresql://*:postgresql://*:postgres://* | postgresql://*:postgres://*:postgresql://* | postgresql://*:postgres://*:postgres://* | postgres://*:postgresql://*:postgresql://* | postgres://*:postgresql://*:postgres://* | postgres://*:postgres://*:postgresql://* | postgres://*:postgres://*:postgres://*) ;;
  *) fail 'database URLs are invalid' ;;
esac
test "$runtime_database_url" != "$migrator_database_url" || fail 'database roles are not split'

role_verify() {
  role_phase="$1"
  DATABASE_ROLE_BOUNDARY_PHASE="$role_phase" \
  RUNTIME_DATABASE_URL="$runtime_database_url" \
  MIGRATOR_DATABASE_URL="$migrator_database_url" \
    compose --profile migration run --rm --no-deps -T \
      -e RUNTIME_DATABASE_URL -e MIGRATOR_DATABASE_URL -e DATABASE_ROLE_BOUNDARY_PHASE \
      --entrypoint node migrator apps/migrator/dist/verify-role-boundary.js
}

foundation_verify() {
  foundation_phase="$1"
  CHAT_PUSH_FOUNDATION_PHASE="$foundation_phase" \
  CHAT_PUSH_FOUNDATION_TENANT_KEYS="$tenant_keys" \
  RUNTIME_DATABASE_URL="$runtime_database_url" \
  MIGRATOR_DATABASE_URL="$migrator_database_url" \
  CHAT_PUSH_FOUNDATION_EXPECTED_CATALOG_DIGEST="$catalog_digest" \
    compose --profile migration run --rm --no-deps -T \
      -e RUNTIME_DATABASE_URL -e MIGRATOR_DATABASE_URL \
      -e CHAT_PUSH_FOUNDATION_PHASE -e CHAT_PUSH_FOUNDATION_TENANT_KEYS \
      -e CHAT_PUSH_FOUNDATION_EXPECTED_CATALOG_DIGEST \
      --entrypoint node migrator apps/migrator/dist/verify-chat-push-foundation.js
}

admin_database_name="$(infrastructure exec -T postgres sh -ec \
  'psql -X -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atv ON_ERROR_STOP=1 -c "select pg_catalog.current_database()"')"
admin_system_identifier="$(infrastructure exec -T postgres sh -ec \
  'psql -X -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atv ON_ERROR_STOP=1 -c "select system_identifier::text from pg_catalog.pg_control_system()"')"
printf '%s' "$admin_database_name" | grep -Eq '^[A-Za-z_][A-Za-z0-9_$.-]*$' ||
  fail 'infrastructure database identity is invalid'
printf '%s' "$admin_system_identifier" | grep -Eq '^[0-9]+$' ||
  fail 'infrastructure system identifier is invalid'

contour_verify() {
  RUNTIME_DATABASE_URL="$runtime_database_url" \
  REALTIME_DATABASE_URL="$realtime_database_url" \
  MIGRATOR_DATABASE_URL="$migrator_database_url" \
  CHAT_PUSH_FOUNDATION_EXPECTED_DATABASE_NAME="$admin_database_name" \
  CHAT_PUSH_FOUNDATION_EXPECTED_SYSTEM_IDENTIFIER="$admin_system_identifier" \
    compose --profile migration run --rm --no-deps -T \
      -e RUNTIME_DATABASE_URL -e REALTIME_DATABASE_URL -e MIGRATOR_DATABASE_URL \
      -e CHAT_PUSH_FOUNDATION_EXPECTED_DATABASE_NAME \
      -e CHAT_PUSH_FOUNDATION_EXPECTED_SYSTEM_IDENTIFIER \
      --entrypoint node migrator apps/migrator/dist/verify-chat-push-foundation-contour.js
}

foundation_admin_verify() {
  admin_counts="$(infrastructure exec -T postgres sh -ec '
    psql -X -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atv ON_ERROR_STOP=1 <<"SQL"
select
  (select count(*) from integration.notification_endpoints)::text || '"'"'|'"'"' ||
  (select count(*) from audit.outbox_events
    where published_at is null
      and event_type in ('"'"'booking.confirmed.v1'"'"', '"'"'booking.changed.v1'"'"', '"'"'booking.cancelled.v1'"'"'))::text || '"'"'|'"'"' ||
  (select count(*) from notifications.tenant_runtime_settings setting
    where setting.web_push_enabled
       or coalesce((to_jsonb(setting) ->> '"'"'booking_reminders_enabled'"'"')::boolean, false)
       or (to_jsonb(setting) ->> '"'"'booking_reminder_ruleset_version'"'"') is not null
       or (to_jsonb(setting) ->> '"'"'booking_reminder_contract_hash'"'"') is not null)::text || '"'"'|'"'"' ||
  (select count(*) from messaging.tenant_runtime_settings setting
    where setting.http_enabled or setting.direct_enabled
       or setting.realtime_enabled or setting.contextual_enabled)::text;
SQL
  ')"
  test "$admin_counts" = '0|0|0|0' || fail 'privileged foundation inventory is not empty'
}

service_is_healthy() {
  container_id="$(compose ps --status running -q "$1")"
  test -n "$container_id" &&
    test "$(docker inspect --format '{{.State.Health.Status}}' "$container_id")" = healthy
}

wait_for_service() {
  service="$1"
  attempt=0
  while [ "$attempt" -lt 36 ]; do
    if service_is_healthy "$service"; then
      return 0
    fi
    attempt="$((attempt + 1))"
    sleep 5
  done
  compose ps -a
  compose logs --no-color --tail=160 "$service"
  return 1
}

verify_service_image() {
  service="$1"
  digest_key="$2"
  registry="$(release_value "$candidate_release_env" REGISTRY)"
  digest="$(release_value "$candidate_release_env" "$digest_key")"
  container_id="$(compose ps --status running -q "$service")"
  test -n "$container_id" || fail "$service container is absent"
  test "$(docker inspect --format '{{.Config.Image}}' "$container_id")" = \
    "$registry/phub-$service@$digest" || fail "$service image is not the candidate digest"
}

verify_rabbit_inventory() {
  inventory_mode="$1"
  case "$inventory_mode" in
    required) rabbit_mode=rabbit-required ;;
    optional) rabbit_mode=rabbit-optional ;;
    inert) rabbit_mode=rabbit-inert ;;
    *) fail 'Rabbit inventory mode is invalid' ;;
  esac
  queue_json="$(infrastructure exec -T rabbitmq rabbitmqctl -q list_queues \
    name durable type arguments messages_ready messages_unacknowledged consumers \
    --formatter=json --silent)"
  binding_json="$(infrastructure exec -T rabbitmq rabbitmqctl -q list_bindings \
    source_name destination_name destination_kind routing_key \
    --formatter=json --silent)"
  printf '{"queues":%s,"bindings":%s}\n' "$queue_json" "$binding_json" |
    compose --profile migration run --rm --no-deps -T \
      --entrypoint node migrator \
      apps/migrator/dist/verify-chat-push-foundation-operational.js "$rabbit_mode"
}

verify_rabbit_preflight_inventory() {
  optional_inventory=''
  if optional_inventory="$(verify_rabbit_inventory optional 2>/dev/null)"; then
    printf '%s\n' "$optional_inventory"
    return 0
  fi
  verify_rabbit_inventory inert
}

verify_monitoring_ready() {
  curl --fail --silent --show-error --connect-timeout 2 --max-time 5 \
    http://127.0.0.1:9090/-/ready >/dev/null || fail 'Prometheus is not ready'
  curl --fail --silent --show-error --connect-timeout 2 --max-time 5 \
    http://127.0.0.1:9090/api/v1/rules |
    compose --profile migration run --rm --no-deps -T \
      --entrypoint node migrator \
      apps/migrator/dist/verify-chat-push-foundation-operational.js prometheus
  curl --fail --silent --show-error --connect-timeout 2 --max-time 5 \
    'http://127.0.0.1:9090/api/v1/targets?state=active' |
    compose --profile migration run --rm --no-deps -T \
      --entrypoint node migrator \
      apps/migrator/dist/verify-chat-push-foundation-operational.js prometheus-targets
}

verify_monitoring_worker_series() {
  curl --fail --silent --show-error --connect-timeout 2 --max-time 5 --get \
    --data-urlencode "query=phub_worker_operational_collection_heartbeat_unixtime{service_instance_id=\"$candidate_worker_instance_id\"}" \
    http://127.0.0.1:9090/api/v1/query |
    CHAT_PUSH_FOUNDATION_MIN_HEARTBEAT_UNIXTIME="$candidate_worker_minimum_heartbeat" \
    compose --profile migration run --rm --no-deps -T \
      -e CHAT_PUSH_FOUNDATION_MIN_HEARTBEAT_UNIXTIME \
      --entrypoint node migrator \
      apps/migrator/dist/verify-chat-push-foundation-operational.js prometheus-heartbeat
  curl --fail --silent --show-error --connect-timeout 2 --max-time 5 --get \
    --data-urlencode "query=phub_worker_operational_collection_success{service_instance_id=\"$candidate_worker_instance_id\"}" \
    http://127.0.0.1:9090/api/v1/query |
    compose --profile migration run --rm --no-deps -T \
      --entrypoint node migrator \
      apps/migrator/dist/verify-chat-push-foundation-operational.js prometheus-collection-success
  curl --fail --silent --show-error --connect-timeout 2 --max-time 5 --get \
    --data-urlencode "query=phub_worker_notifications_booking_reminder_oldest_due_age_seconds{service_instance_id=\"$candidate_worker_instance_id\"}" \
    http://127.0.0.1:9090/api/v1/query |
    compose --profile migration run --rm --no-deps -T \
      --entrypoint node migrator \
      apps/migrator/dist/verify-chat-push-foundation-operational.js prometheus-gauge-present
}

verify_monitoring_digest() {
  expected_monitoring_digest="$(cat "$monitoring_digest_path")"
  printf '%s' "$expected_monitoring_digest" | grep -Eq '^[0-9a-f]{64}$' ||
    fail 'stored monitoring digest is invalid'
  test -f "$app_root/monitoring/padlhub-alerts.yaml" &&
    test ! -L "$app_root/monitoring/padlhub-alerts.yaml" ||
    fail 'candidate monitoring definition is absent or unsafe'
  test "$(sha256sum "$app_root/monitoring/padlhub-alerts.yaml" | cut -d ' ' -f 1)" = \
    "$expected_monitoring_digest" || fail 'candidate monitoring definition drifted'
}

wait_for_monitoring_ready() {
  monitoring_attempt=0
  while test "$monitoring_attempt" -lt 24; do
    if verify_monitoring_ready >/dev/null 2>&1; then
      return 0
    fi
    monitoring_attempt="$((monitoring_attempt + 1))"
    sleep 5
  done
  verify_monitoring_ready
  fail 'foundation monitoring rules did not become healthy and inactive'
}

wait_for_monitoring_worker_series() {
  monitoring_attempt=0
  while test "$monitoring_attempt" -lt 24; do
    if verify_monitoring_worker_series >/dev/null 2>&1; then
      return 0
    fi
    monitoring_attempt="$((monitoring_attempt + 1))"
    sleep 5
  done
  verify_monitoring_worker_series
  fail 'worker monitoring series did not become fresh'
}

verify_booking_quiet_window() {
  quiet_started="$(cut -d. -f 1 /proc/uptime)"
  printf '%s' "$quiet_started" | grep -Eq '^[0-9]+$' ||
    fail 'monotonic clock is unavailable'
  quiet_deadline="$((quiet_started + 30))"
  while :; do
    foundation_verify live >/dev/null
    foundation_admin_verify
    verify_rabbit_inventory required >/dev/null
    quiet_now="$(cut -d. -f 1 /proc/uptime)"
    printf '%s' "$quiet_now" | grep -Eq '^[0-9]+$' ||
      fail 'monotonic clock is unavailable'
    test "$quiet_now" -ge "$quiet_deadline" && break
    sleep 5
  done
}

wait_for_rabbit_inventory() {
  rabbit_attempt=0
  while test "$rabbit_attempt" -lt 36; do
    if verify_rabbit_inventory required >/dev/null 2>&1; then
      return 0
    fi
    rabbit_attempt="$((rabbit_attempt + 1))"
    sleep 5
  done
  verify_rabbit_inventory required
  fail 'Rabbit foundation topology did not become ready'
}

pending_foundation_count() {
  verification_result="$1"
  pending_count="$(printf '%s\n' "$verification_result" |
    sed -n 's/^.*"pendingFoundationCount":\([0-9][0-9]*\).*$/\1/p')"
  printf '%s' "$pending_count" | grep -Eq '^[0-9]+$' ||
    fail 'foundation pending migration count is absent or invalid'
  test "$(printf '%s\n' "$verification_result" | grep -c '"pendingFoundationCount"')" -eq 1 ||
    fail 'foundation pending migration count is ambiguous'
  printf '%s\n' "$pending_count"
}

compare_preserved_file() {
  relative_path="$1"
  if test -f "$application_backup/$relative_path"; then
    cmp "$application_backup/$relative_path" "$app_root/$relative_path" >/dev/null ||
      fail "$relative_path changed during foundation rollout"
  else
    test -f "$application_backup/$relative_path.absent" ||
      fail "$relative_path backup state is ambiguous"
    test ! -e "$app_root/$relative_path" || fail "$relative_path was created during foundation rollout"
  fi
}

write_recovery_value() {
  recovery_path="$1"
  recovery_value="$2"
  recovery_tmp="$application_backup/.foundation-recovery-value.$$"
  test ! -e "$recovery_path" && test ! -L "$recovery_path" ||
    fail 'foundation recovery value already exists'
  test ! -e "$recovery_tmp" && test ! -L "$recovery_tmp" ||
    fail 'foundation recovery temporary value already exists'
  printf '%s\n' "$recovery_value" > "$recovery_tmp"
  chmod 600 "$recovery_tmp"
  mv "$recovery_tmp" "$recovery_path"
}

write_database_backup_manifest() {
  backup_path_value="$1"
  backup_size_value="$(wc -c < "$backup_path_value" | tr -d ' ')"
  backup_sha256_value="$(sha256sum "$backup_path_value" | cut -d ' ' -f 1)"
  backup_manifest_tmp="$application_backup/.chat-push-foundation-database-backup.$$"
  test ! -e "$database_backup_pointer" && test ! -L "$database_backup_pointer" ||
    fail 'foundation database backup manifest already exists'
  test ! -e "$backup_manifest_tmp" && test ! -L "$backup_manifest_tmp" ||
    fail 'foundation database backup manifest temporary file already exists'
  {
    printf '%s\n' "PATH=$backup_path_value"
    printf '%s\n' "SIZE=$backup_size_value"
    printf '%s\n' "SHA256=$backup_sha256_value"
  } > "$backup_manifest_tmp"
  chmod 600 "$backup_manifest_tmp"
  mv "$backup_manifest_tmp" "$database_backup_pointer"
}

activate_candidate_release() {
  active_release="$app_root/release.env"
  if test -e "$active_release" || test -L "$active_release"; then
    test -f "$active_release" && test ! -L "$active_release" ||
      fail 'active release env is unsafe'
    if ! cmp "$active_release" "$application_backup/release.env" >/dev/null &&
      ! cmp "$active_release" "$candidate_release_env" >/dev/null; then
      fail 'active release env is neither the approved old nor candidate state'
    fi
  fi
  active_tmp="$app_root/.release-foundation.$$"
  test ! -e "$active_tmp" && test ! -L "$active_tmp" ||
    fail 'active release temporary file already exists'
  install -m 600 "$candidate_release_env" "$active_tmp"
  mv "$active_tmp" "$active_release"
  cmp "$active_release" "$candidate_release_env" >/dev/null ||
    fail 'candidate release activation did not persist'
}

cleanup_release() {
  if test -n "$backup_tmp"; then
    rm -f "$backup_tmp"
    backup_tmp=''
  fi
  phase_path="$application_backup/chat-push-foundation.phase"
  if test "$release_completed" != true && { test -e "$phase_path" || test -L "$phase_path"; }; then
    printf '%s\n' 'Foundation phase marker is present; keeping every writer stopped.' >&2
    compose stop api worker realtime ||
      printf '%s\n' 'Could not stop every foundation runtime; immediate operator action is required.' >&2
    sh "$app_root/verify-chat-push-foundation-runtime.sh" drained ||
      printf '%s\n' 'Foundation drained recheck failed; immediate operator action is required.' >&2
    foundation_verify drained ||
      printf '%s\n' 'Foundation database-session recheck failed; immediate operator action is required.' >&2
  fi
}

on_exit() {
  status=$?
  trap - EXIT HUP INT TERM
  cleanup_release
  exit "$status"
}

on_signal() {
  trap - EXIT HUP INT TERM
  cleanup_release
  exit 130
}

trap on_exit EXIT
trap on_signal HUP INT TERM

apply_foundation_migrations() {
  write_phase_marker MIGRATION_STARTED
  MIGRATOR_DATABASE_URL="$migrator_database_url" \
  MIGRATOR_ADVISORY_LOCK_TIMEOUT_MS=30000 \
  CHAT_PUSH_FOUNDATION_MAINTENANCE_ACK=CHAT_PUSH_FOUNDATION_MAINTENANCE_V1 \
    compose --profile migration run --rm --no-deps -T \
      -e CHAT_PUSH_FOUNDATION_MAINTENANCE_ACK \
      -e MIGRATOR_ADVISORY_LOCK_TIMEOUT_MS migrator
}

verify_post_migration() {
  role_verify post
  foundation_verify post
  foundation_admin_verify
  MIGRATOR_DATABASE_URL="$migrator_database_url" \
  MIGRATOR_ADVISORY_LOCK_TIMEOUT_MS=30000 \
    compose --profile migration run --rm --no-deps -T \
      -e MIGRATOR_ADVISORY_LOCK_TIMEOUT_MS migrator
  write_phase_marker POST_MIGRATION_VERIFIED
}

start_candidate_runtime() {
  activate_candidate_release
  write_phase_marker CANDIDATE_RUNTIME_STARTING

  compose up -d --no-deps api
  wait_for_service api
  verify_service_image api API_IMAGE_DIGEST
  sh "$app_root/verify-chat-push-foundation-runtime.sh" api-ready
  write_phase_marker CANDIDATE_API_READY

  candidate_worker_started_unix="$(date +%s)"
  printf '%s' "$candidate_worker_started_unix" | grep -Eq '^[0-9]+$' ||
    fail 'candidate worker start time is invalid'
  candidate_worker_minimum_heartbeat="$((candidate_worker_started_unix + 1))"
  compose up -d --no-deps worker
  wait_for_service worker
  verify_service_image worker WORKER_IMAGE_DIGEST
  sh "$app_root/verify-chat-push-foundation-runtime.sh" worker-ready
  candidate_worker_container_id="$(compose ps --status running -q worker)"
  test -n "$candidate_worker_container_id" || fail 'candidate worker container is absent'
  case "$candidate_worker_container_id" in
    *[!0-9a-f]*) fail 'candidate worker container identity is invalid' ;;
  esac
  candidate_worker_instance_id="$(docker exec "$candidate_worker_container_id" node -e '
    const configured = (process.env.OTEL_SERVICE_INSTANCE_ID ?? "").trim();
    const fallback = (process.env.HOSTNAME ?? "").trim();
    const value = configured || fallback;
    if (!value) process.exit(1);
    process.stdout.write(value);
  ')" || fail 'candidate worker instance identity is unavailable'
  test "$(printf '%s' "$candidate_worker_instance_id" | tr -d '\r\n')" = \
    "$candidate_worker_instance_id" || fail 'candidate worker instance identity is invalid'
  printf '%s' "$candidate_worker_instance_id" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$' ||
    fail 'candidate worker instance identity is invalid'
  wait_for_rabbit_inventory
  wait_for_monitoring_worker_series
  verify_booking_quiet_window
  write_phase_marker CANDIDATE_WORKER_READY

  compose up -d --no-deps realtime
  wait_for_service realtime
  verify_service_image realtime REALTIME_IMAGE_DIGEST
  sh "$app_root/verify-chat-push-foundation-runtime.sh" realtime-ready
  write_phase_marker CANDIDATE_REALTIME_READY

  compose up -d --no-deps web
  wait_for_service web
  verify_service_image web WEB_IMAGE_DIGEST
  write_phase_marker CANDIDATE_WEB_READY

  foundation_verify live
  foundation_admin_verify
  verify_rabbit_inventory required
  verify_monitoring_digest
  verify_monitoring_ready
  for preserved in staging.auth.env staging.override.env staging.communities.env staging.games.env; do
    compare_preserved_file "$preserved"
  done
  write_phase_marker CANDIDATE_RUNTIME_VERIFIED
  release_completed=true
  printf '%s\n' "Chat/push foundation release verified: release=$candidate_sha tenants=approved gates=off"
}

if test "$operation" = recover; then
  # Invalidate a previously healthy marker before pull, monitoring, or any other recovery mutation.
  write_phase_marker RECOVERY_STARTED
fi

available_kb="$(df -Pk / | tail -1 | tr -s ' ' | cut -d ' ' -f 4)"
if test "$available_kb" -lt 8388608; then
  docker image prune --all --force
  available_kb="$(df -Pk / | tail -1 | tr -s ' ' | cut -d ' ' -f 4)"
fi
test "$available_kb" -ge 4194304 || fail 'less than 4 GiB remains after safe image pruning'
compose pull
sh "$app_root/verify-chat-push-foundation-runtime.sh" overlay
wait_for_monitoring_ready

for preserved in staging.auth.env staging.override.env staging.communities.env staging.games.env; do
  compare_preserved_file "$preserved"
done

if test "$operation" = start; then
  test -f "$app_root/monitoring/padlhub-alerts.yaml" &&
    test ! -L "$app_root/monitoring/padlhub-alerts.yaml" ||
    fail 'candidate monitoring definition is absent or unsafe'
  candidate_monitoring_digest="$(
    release_value "$candidate_release_env" FOUNDATION_MONITORING_RULES_SHA256
  )"
  test "$(sha256sum "$app_root/monitoring/padlhub-alerts.yaml" | cut -d ' ' -f 1)" = \
    "$candidate_monitoring_digest" || fail 'installed monitoring definition does not match candidate source'
  write_recovery_value "$monitoring_digest_path" "$candidate_monitoring_digest"
  verify_monitoring_digest

  sh "$app_root/verify-chat-push-foundation-runtime.sh" preflight
  contour_verify
  foundation_admin_verify
  verify_rabbit_preflight_inventory
  verify_monitoring_digest
  role_verify pre
  pre_result="$(foundation_verify pre)"
  printf '%s\n' "$pre_result"
  test "$(pending_foundation_count "$pre_result")" -eq 5 ||
    fail 'initial foundation release requires exactly five pending migrations'

  backup_dir="$app_root/backups"
  backup_timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
  backup_path="$backup_dir/postgres-pre-$candidate_sha-$backup_timestamp.dump"
  umask 077
  if test ! -e "$backup_dir" && test ! -L "$backup_dir"; then
    mkdir -m 700 "$backup_dir"
  fi
  test -d "$backup_dir" && test ! -L "$backup_dir" || fail 'backup directory is unsafe'
  test "$(stat -c %u "$backup_dir")" = "$(id -u)" || fail 'backup directory owner is invalid'
  chmod 700 "$backup_dir"
  test "$(stat -c %a "$backup_dir")" = 700 || fail 'backup directory mode is invalid'
  test ! -e "$backup_path" && test ! -L "$backup_path" || fail 'backup target already exists'
  PHUB_POSTGRES_STORAGE_PATH=/var/lib/docker \
    sh "$app_root/verify-postgres-backup-restore.sh" - \
      "phub_restore_${run_id}_${run_attempt}" VERIFY_STAGING_POSTGRES_CAPACITY

  compose stop api worker realtime
  sh "$app_root/verify-chat-push-foundation-runtime.sh" drained
  contour_verify
  foundation_verify drained
  foundation_admin_verify
  verify_rabbit_preflight_inventory

  backup_tmp="$(mktemp "$backup_dir/.postgres-pre-$candidate_sha-$backup_timestamp.XXXXXX.dump")"
  infrastructure exec -T postgres sh -ec \
    'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom --no-owner --no-acl' \
    > "$backup_tmp"
  test -s "$backup_tmp" || fail 'PostgreSQL backup is empty'
  chmod 600 "$backup_tmp"
  test "$(stat -c %a "$backup_tmp")" = 600 || fail 'PostgreSQL backup mode is invalid'
  infrastructure exec -T postgres pg_restore --list < "$backup_tmp" >/dev/null
  PHUB_POSTGRES_STORAGE_PATH=/var/lib/docker \
    sh "$app_root/verify-postgres-backup-restore.sh" "$backup_tmp" \
      "phub_restore_${run_id}_${run_attempt}" VERIFY_CHAT_PUSH_FOUNDATION_BACKUP
  mv "$backup_tmp" "$backup_path"
  backup_tmp=''
  test "$(stat -c %a "$backup_path")" = 600 || fail 'final PostgreSQL backup mode is invalid'
  write_database_backup_manifest "$backup_path"

  sh "$app_root/verify-chat-push-foundation-runtime.sh" drained
  contour_verify
  foundation_verify drained
  foundation_admin_verify
  verify_rabbit_preflight_inventory
  clone_result="$(
    PHUB_CANDIDATE_RELEASE_ENV="$candidate_release_env" \
    RUNTIME_DATABASE_URL="$runtime_database_url" \
    MIGRATOR_DATABASE_URL="$migrator_database_url" \
      sh "$app_root/verify-chat-push-foundation-clone.sh" \
        "phub_foundation_${run_id}_${run_attempt}" "$tenant_keys" \
        VERIFY_CHAT_PUSH_FOUNDATION_CLONE
  )"
  printf '%s\n' "$clone_result"
  catalog_digest="$(printf '%s\n' "$clone_result" |
    sed -n 's/^.*catalog_digest=\([0-9a-f]\{64\}\).*$/\1/p')"
  printf '%s' "$catalog_digest" | grep -Eq '^[0-9a-f]{64}$' ||
    fail 'clone catalog digest is absent or invalid'
  test "$(printf '%s\n' "$clone_result" | grep -c 'catalog_digest=')" -eq 1 ||
    fail 'clone catalog digest is ambiguous'
  write_recovery_value "$catalog_digest_path" "$catalog_digest"

  # Clone rehearsal can be long. Re-attest every drain and inventory immediately before ACK.
  sh "$app_root/verify-chat-push-foundation-runtime.sh" drained
  contour_verify
  final_pre_result="$(foundation_verify drained)"
  test "$(pending_foundation_count "$final_pre_result")" -eq 5 ||
    fail 'foundation pending set changed during clone rehearsal'
  foundation_admin_verify
  verify_rabbit_preflight_inventory
  verify_monitoring_digest
  role_verify pre
  apply_foundation_migrations
else
  verify_monitoring_digest
  write_phase_marker RECOVERY_DRAINING
  compose stop api worker realtime
  sh "$app_root/verify-chat-push-foundation-runtime.sh" drained
  contour_verify
  recovery_pre_result="$(foundation_verify drained)"
  printf '%s\n' "$recovery_pre_result"
  recovery_pending="$(pending_foundation_count "$recovery_pre_result")"
  test "$recovery_pending" -le 5 || fail 'recovery pending migration count is invalid'
  foundation_admin_verify
  verify_rabbit_preflight_inventory
  write_phase_marker RECOVERY_WRITERS_DRAINED
  if test "$recovery_pending" -gt 0; then
    sh "$app_root/verify-chat-push-foundation-runtime.sh" drained
    contour_verify
    recovery_final_pre="$(foundation_verify drained)"
    test "$(pending_foundation_count "$recovery_final_pre")" -eq "$recovery_pending" ||
      fail 'foundation pending set changed during recovery preflight'
    foundation_admin_verify
    verify_rabbit_preflight_inventory
    verify_monitoring_digest
    role_verify pre
    apply_foundation_migrations
  fi
fi

verify_post_migration
start_candidate_runtime
