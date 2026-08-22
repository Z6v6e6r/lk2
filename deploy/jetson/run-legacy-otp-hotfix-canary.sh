#!/bin/sh

set -eu

fail() {
  printf '%s\n' "Legacy OTP hotfix canary refused: $*" >&2
  exit 1
}

maybe_fail() {
  phase=$1
  if test "${PHUB_OTP_HOTFIX_FAIL_AFTER:-}" = "$phase"; then
    fail "injected failure after $phase"
  fi
}

test "$#" -eq 8 ||
  fail 'usage: run-legacy-otp-hotfix-canary.sh <start|attest|rollback> <active-sha> <candidate-sha> <control-sha> <run-id> <run-attempt> <confirmation> <bundle-path>'
operation=$1
expected_active_release=$2
candidate_release=$3
control_commit=$4
workflow_run_id=$5
workflow_run_attempt=$6
confirmation=$7
bundle_path=$8

case "$operation:$confirmation" in
  start:START_LEGACY_OTP_HOTFIX_CANARY | attest:ATTEST_LEGACY_OTP_HOTFIX_CANARY | rollback:ROLLBACK_LEGACY_OTP_HOTFIX_CANARY) ;;
  *) fail 'exact operation confirmation is required' ;;
esac
for value in "$expected_active_release" "$candidate_release" "$control_commit"; do
  test "${#value}" -eq 40 || fail 'release and control commits must be 40-character SHAs'
  case "$value" in *[!0-9a-f]*) fail 'release and control commits must be lowercase hexadecimal' ;; esac
done
for value in "$workflow_run_id" "$workflow_run_attempt"; do
  test -n "$value" || fail 'workflow identity is absent'
  case "$value" in *[!0-9]*) fail 'workflow identity must be numeric' ;; esac
done

supported_active_release=e308181da5222645d9a87d03642923c6841be8d1
supported_active_compose_sha=a9227a66be5044d0286592afb27aca073d50aa8d2ff21067504a0ffdb1804c2a
test "$expected_active_release" = "$supported_active_release" || fail 'active release is not the reviewed legacy base'
test "$candidate_release" != "$expected_active_release" || fail 'candidate release must differ from the active release'

app_root=${PHUB_APP_ROOT:-/opt/phub}
backup_root="$app_root/backups/releases"
marker="$app_root/.legacy-otp-hotfix.transition.env"
marker_next="$marker.next"
release_next="$app_root/.legacy-otp-hotfix.release.next"
lock_path="$app_root/.runtime-secret-isolation.lock"

case "$bundle_path" in "$app_root"/legacy-otp-hotfix-candidates/*) ;; *) fail 'bundle path is outside the durable candidate root' ;; esac
case "$bundle_path" in *'/../'* | *'/..') fail 'bundle path contains traversal' ;; esac
test "$bundle_path" = "$app_root/legacy-otp-hotfix-candidates/$workflow_run_id-$workflow_run_attempt" ||
  fail 'bundle path does not match the workflow identity'
for directory in "$app_root" "$backup_root" "$bundle_path"; do
  test -d "$directory" && test ! -L "$directory" || fail "required directory is absent or unsafe: $directory"
done
for path in "$app_root/compose.yaml" "$app_root/release.env" "$app_root/infrastructure.env" "$app_root/compose.infrastructure.yaml"; do
  test -f "$path" && test ! -L "$path" || fail "required file is absent or unsafe: $path"
done
for path in "$bundle_path/image-digests.env" "$bundle_path/compose.staging.yaml" "$bundle_path/backup-application.sh" "$bundle_path/rollback-application.sh"; do
  test -f "$path" && test ! -L "$path" || fail "bundle file is absent or unsafe: $path"
done

exec 9>"$lock_path"
flock -n 9 || fail 'another staging transition is active'

sha256() {
  sha256sum "$1" | cut -d ' ' -f 1
}

sync_path() {
  sync "$1"
  sync "$(dirname "$1")"
}

require_headroom_kib() {
  required=$1
  available=$(df -Pk "$app_root" | awk 'NR == 2 { print $4 }')
  test "$available" -ge "$required" || fail 'application filesystem lacks required free space'
  test "$(df -Pi "$app_root" | awk 'NR == 2 { print $4 }')" -ge 1024 ||
    fail 'application filesystem lacks required free inodes'
}

env_value() {
  file=$1
  key=$2
  count=$(awk -F= -v key="$key" '$1 == key { count += 1 } END { print count + 0 }' "$file")
  test "$count" -eq 1 || fail "$(basename "$file") must contain exactly one $key"
  sed -n "s/^${key}=//p" "$file"
}

require_release_shape() {
  file=$1
  test "$(wc -l < "$file" | tr -d ' ')" -ge 8 || fail 'release file is unexpectedly short'
  printf '%s' "$(env_value "$file" REGISTRY)" | grep -Eq '^ghcr\.io/[A-Za-z0-9._/-]+$' || fail 'registry is malformed'
  printf '%s' "$(env_value "$file" RELEASE)" | grep -Eq '^[0-9a-f]{40}$' || fail 'release SHA is malformed'
  printf '%s' "$(env_value "$file" LATEST_MIGRATION)" | grep -Eq '^[0-9][0-9A-Za-z._-]*\.sql$' || fail 'latest migration is malformed'
  for service in WEB API WORKER REALTIME MIGRATOR; do
    printf '%s' "$(env_value "$file" "${service}_IMAGE_DIGEST")" | grep -Eq '^sha256:[0-9a-f]{64}$' ||
      fail "$service digest is malformed"
  done
}

require_digest_manifest() {
  file=$1
  test "$(awk -F= 'NF == 2 { count += 1 } END { print count + 0 }' "$file")" -eq 7 ||
    fail 'digest manifest must contain exactly seven entries'
  allowed=' RELEASE REGISTRY WEB_IMAGE_DIGEST API_IMAGE_DIGEST WORKER_IMAGE_DIGEST REALTIME_IMAGE_DIGEST MIGRATOR_IMAGE_DIGEST '
  while IFS='=' read -r key value; do
    test -n "$key" && test -n "$value" || fail 'digest manifest contains an empty entry'
    printf '%s' "$allowed" | grep -Fq " $key " || fail 'digest manifest contains an unknown key'
  done < "$file"
  require_release_shape_candidate="$file"
  printf '%s' "$(env_value "$file" REGISTRY)" | grep -Eq '^ghcr\.io/[A-Za-z0-9._/-]+$' || fail 'candidate registry is malformed'
  test "$(env_value "$file" RELEASE)" = "$candidate_release" || fail 'candidate manifest release differs'
  for service in WEB API WORKER REALTIME MIGRATOR; do
    printf '%s' "$(env_value "$file" "${service}_IMAGE_DIGEST")" | grep -Eq '^sha256:[0-9a-f]{64}$' ||
      fail "candidate $service digest is malformed"
  done
  unset require_release_shape_candidate
}

compose_with() {
  release_file=$1
  shift
  docker compose --project-name phub-staging --env-file "$app_root/infrastructure.env" --env-file "$release_file" -f "$app_root/compose.yaml" "$@"
}

compose() {
  compose_with "$app_root/release.env" "$@"
}

infrastructure() {
  docker compose --env-file "$app_root/infrastructure.env" -f "$app_root/compose.infrastructure.yaml" "$@"
}

image_ref_from() {
  release_file=$1
  service=$2
  upper=$(printf '%s' "$service" | tr '[:lower:]' '[:upper:]')
  printf '%s/phub-%s@%s' "$(env_value "$release_file" REGISTRY)" "$service" "$(env_value "$release_file" "${upper}_IMAGE_DIGEST")"
}

verify_candidate_runtime_imports() {
  service=$1
  case "$service" in api | worker | realtime | migrator) ;; *) fail 'candidate import service is unsupported' ;; esac
  ref=$(image_ref_from "$candidate_release_file" "$service")
  probe_name="phub-legacy-otp-import-$workflow_run_id-$workflow_run_attempt-$service"
  test "$(docker image inspect --format '{{.Architecture}}' "$ref" 2>/dev/null)" = arm64 ||
    fail "$service candidate image architecture is not arm64"
  probe_status=0
  if timeout --signal=TERM --kill-after=5s 60s docker run --rm \
    --name "$probe_name" \
    --pull=never \
    --network none \
    --read-only \
    --user 1001:1001 \
    --cap-drop ALL \
    --security-opt no-new-privileges:true \
    --pids-limit 64 \
    --memory 256m \
    --cpus 1 \
    --entrypoint node \
    "$ref" \
    scripts/verify-production-workspace-imports.js "$service" >/dev/null 2>&1; then
    :
  else
    probe_status=$?
  fi
  if ! leftover=$(bounded_docker ps -a --filter "name=^/$probe_name$" --format '{{.ID}}' 2>/dev/null); then
    fail "$service candidate import cleanup attestation failed"
  fi
  if test -n "$leftover"; then
    bounded_docker rm -f "$probe_name" >/dev/null 2>&1 || fail "$service candidate import cleanup failed"
  fi
  test "$probe_status" -eq 0 || fail "$service candidate runtime imports failed"
  test -z "$leftover" || fail "$service candidate import container required cleanup"
  printf '%s\n' "legacy_otp_hotfix candidate_runtime_imports service=$service status=passed"
}

project_container_id() {
  service=$1
  ids=$(docker ps --filter label=com.docker.compose.project=phub-staging --filter "label=com.docker.compose.service=$service" --format '{{.ID}}')
  test "$(printf '%s\n' "$ids" | awk 'NF { count += 1 } END { print count + 0 }')" -eq 1 || fail "$service must have exactly one running container"
  printf '%s' "$ids"
}

attest_service() {
  service=$1
  release_file=$2
  id=$(project_container_id "$service")
  test "$(docker inspect --format '{{.State.Running}}' "$id")" = true || fail "$service is not running"
  test "$(docker inspect --format '{{.State.Health.Status}}' "$id")" = healthy || fail "$service is not healthy"
  test "$(docker inspect --format '{{.Config.Image}}' "$id")" = "$(image_ref_from "$release_file" "$service")" || fail "$service image differs from release.env"
}

normalize_boolean() {
  case "$1" in true | false) printf '%s' "$1" ;; *) printf 'unknown' ;; esac
}

normalize_number() {
  case "$1" in '' | *[!0-9]*) printf 'unknown' ;; *) printf '%s' "$1" ;; esac
}

normalize_health() {
  case "$1" in healthy | unhealthy | starting | none) printf '%s' "$1" ;; *) printf 'unknown' ;; esac
}

bounded_docker() {
  timeout --signal=TERM --kill-after=1s 5s docker "$@"
}

container_http_status() {
  service=$1
  id=$2
  kind=$3
  case "$service:$kind" in
    realtime:live) url=http://127.0.0.1:3001/health/live ;;
    realtime:ready) url=http://127.0.0.1:3001/health/ready ;;
    api:live) url=http://127.0.0.1:3000/health/live ;;
    api:ready) url=http://127.0.0.1:3000/health/ready ;;
    worker:live) url=http://127.0.0.1:3002/health/live ;;
    worker:ready) url=http://127.0.0.1:3002/health/ready ;;
    web:live | web:ready) url=http://127.0.0.1:8080/healthz ;;
    *) printf 'unavailable'; return 0 ;;
  esac
  if test "$service" = web; then
    if bounded_docker exec "$id" wget -q -O /dev/null "$url" 2>/dev/null; then
      printf '200'
    else
      printf 'unavailable'
    fi
    return 0
  fi
  status=$(
    bounded_docker exec "$id" node -e \
      "fetch('${url}', { signal: AbortSignal.timeout(3000) }).then((response) => process.stdout.write(String(response.status))).catch(() => process.exit(1))" \
      2>/dev/null || true
  )
  case "$status" in [1-5][0-9][0-9]) printf '%s' "$status" ;; *) printf 'unavailable' ;; esac
}

classify_container_logs() {
  id=$1
  logs=$(bounded_docker logs --tail 200 "$id" 2>&1 || true)
  case "$logs" in
    *ERR_MODULE_NOT_FOUND* | *MODULE_NOT_FOUND* | *'Cannot find package'*) printf 'runtime_module_missing' ;;
    *'Invalid environment'* | *ZodError* | *'configuration is invalid'*) printf 'configuration_invalid' ;;
    *ACCESS_REFUSED* | *'authentication failed'* | *'password authentication failed'*) printf 'dependency_authentication' ;;
    *ECONNREFUSED* | *ETIMEDOUT* | *ENOTFOUND* | *'Connection timeout'* | *'connect ECONN'*) printf 'dependency_connectivity' ;;
    *EACCES* | *'Permission denied'* | *'permission denied'*) printf 'permission_denied' ;;
    '') printf 'no_logs' ;;
    *) printf 'unclassified' ;;
  esac
}

diagnose_service_readiness() {
  service=$1
  case "$service" in realtime | api | worker | web) ;; *) fail 'readiness diagnostic service is unsupported' ;; esac
  ids=$(bounded_docker ps -a --filter label=com.docker.compose.project=phub-staging --filter "label=com.docker.compose.service=$service" --format '{{.ID}}' 2>/dev/null || true)
  container_count=$(printf '%s\n' "$ids" | awk 'NF { count += 1 } END { print count + 0 }')
  if test "$container_count" -ne 1; then
    case "$container_count" in 0) container_count=none ;; *) container_count=multiple ;; esac
    printf '%s\n' "service_readiness_diagnostic service=$service container_count=$container_count"
    return 0
  fi
  running=$(normalize_boolean "$(bounded_docker inspect --format '{{.State.Running}}' "$ids" 2>/dev/null || true)")
  health=$(normalize_health "$(bounded_docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$ids" 2>/dev/null || true)")
  exit_code=$(normalize_number "$(bounded_docker inspect --format '{{.State.ExitCode}}' "$ids" 2>/dev/null || true)")
  oom_killed=$(normalize_boolean "$(bounded_docker inspect --format '{{.State.OOMKilled}}' "$ids" 2>/dev/null || true)")
  restart_count=$(normalize_number "$(bounded_docker inspect --format '{{.RestartCount}}' "$ids" 2>/dev/null || true)")
  live_status=$(container_http_status "$service" "$ids" live)
  ready_status=$(container_http_status "$service" "$ids" ready)
  log_class=$(classify_container_logs "$ids")
  printf '%s\n' \
    "service_readiness_diagnostic service=$service running=$running health=$health exit_code=$exit_code oom_killed=$oom_killed restart_count=$restart_count live_http=$live_status ready_http=$ready_status log_class=$log_class"
}

emit_otp_stage_diagnostics() {
  api_id=$1
  since=$2
  log_source=unavailable
  otp_logs=''
  if otp_logs=$(bounded_docker logs --since "$since" --tail 5000 "$api_id" 2>/dev/null); then
    log_source=available
  fi

  printf '%s\n' "$otp_logs" | awk -v source="$log_source" '
    function status_bucket(status) {
      if (status == "") return "no_status"
      if (status >= 200 && status < 300) return "http_2xx"
      if (status >= 300 && status < 400) return "http_3xx"
      if (status >= 400 && status < 500) return "http_4xx"
      if (status >= 500 && status < 600) return "http_5xx"
      return "http_other"
    }
    function extract_number(field, value) {
      if (match($0, "\\\"" field "\\\":[0-9]+")) {
        value = substr($0, RSTART, RLENGTH)
        sub("^\\\"" field "\\\":", "", value)
        return value + 0
      }
      return ""
    }
    function extract_string(field, value) {
      if (match($0, "\\\"" field "\\\":\\\"[^\\\"]+\\\"")) {
        value = substr($0, RSTART, RLENGTH)
        sub("^\\\"" field "\\\":\\\"", "", value)
        sub("\\\"$", "", value)
        return value
      }
      return ""
    }
    function record_route(operation, status, bucket) {
      route_total[operation] += 1
      bucket = status_bucket(status)
      route_status[operation, bucket] += 1
    }
    function record_metric(operation, outcome, status, bucket) {
      metric_total[operation] += 1
      metric_outcome[operation, outcome] += 1
      bucket = status_bucket(status)
      metric_status[operation, bucket] += 1
      if (outcome != "unavailable") return
      if (operation == "request_code") {
        metric_failure[operation, status == "" ? "request" : "response"] += 1
      } else if (operation == "verify_code") {
        if (status == "") metric_failure[operation, "token_request"] += 1
        else if (status >= 200 && status < 300) metric_failure[operation, "post_token"] += 1
        else metric_failure[operation, "token_response"] += 1
      } else if (operation == "profile_read") {
        if (status == "") metric_failure[operation, "profile_request"] += 1
        else if (status >= 200 && status < 300) metric_failure[operation, "profile_payload"] += 1
        else metric_failure[operation, "profile_response"] += 1
      }
    }
    {
      if (index($0, "\"msg\":\"incoming request\"") > 0 && index($0, "\"method\":\"POST\"") > 0) {
        request_id = extract_string("reqId")
        if (request_id != "") {
          if (index($0, "\"url\":\"/user/api/v1/local-padel/auth/challenges\"") > 0) {
            route_by_request[request_id] = "padlhub_challenge_create"
          } else if ($0 ~ /\"url\":\"\/user\/api\/v1\/local-padel\/auth\/challenges\/[^\/\"?]+\/verify\"/) {
            route_by_request[request_id] = "padlhub_challenge_verify"
          }
        }
      }
      if (index($0, "\"msg\":\"request completed\"") > 0) {
        status = extract_number("statusCode")
        request_id = extract_string("reqId")
        if (index($0, "\"method\":\"POST\"") > 0 && index($0, "\"url\":\"/user/api/v1/local-padel/auth/challenges\"") > 0) {
          record_route("padlhub_challenge_create", status)
        } else if (index($0, "\"method\":\"POST\"") > 0 && $0 ~ /\"url\":\"\/user\/api\/v1\/local-padel\/auth\/challenges\/[^\/\"?]+\/verify\"/) {
          record_route("padlhub_challenge_verify", status)
        } else if (request_id != "" && route_by_request[request_id] != "") {
          record_route(route_by_request[request_id], status)
        }
        if (request_id != "") delete route_by_request[request_id]
      }
      if (index($0, "\"msg\":\"identity provider operation\"") == 0) next
      operation = ""
      outcome = ""
      if (index($0, "\"operation\":\"request_code\"") > 0) operation = "request_code"
      else if (index($0, "\"operation\":\"verify_code\"") > 0) operation = "verify_code"
      else if (index($0, "\"operation\":\"profile_read\"") > 0) operation = "profile_read"
      if (index($0, "\"outcome\":\"success\"") > 0) outcome = "success"
      else if (index($0, "\"outcome\":\"invalid\"") > 0) outcome = "invalid"
      else if (index($0, "\"outcome\":\"rate_limited\"") > 0) outcome = "rate_limited"
      else if (index($0, "\"outcome\":\"unavailable\"") > 0) outcome = "unavailable"
      if (operation != "" && outcome != "") {
        record_metric(operation, outcome, extract_number("status"))
      }
    }
    END {
      for (route_index = 1; route_index <= 2; route_index += 1) {
        operation = route_index == 1 ? "padlhub_challenge_create" : "padlhub_challenge_verify"
        printf "legacy_otp_hotfix otp_stage_diagnostic scope=local-padel_api_route window=tail_5000 source=%s operation=%s total=%d http_2xx=%d http_3xx=%d http_4xx=%d http_5xx=%d no_status=%d http_other=%d\n", source, operation, route_total[operation], route_status[operation, "http_2xx"], route_status[operation, "http_3xx"], route_status[operation, "http_4xx"], route_status[operation, "http_5xx"], route_status[operation, "no_status"], route_status[operation, "http_other"]
      }
      operation = "request_code"
      printf "legacy_otp_hotfix otp_stage_diagnostic scope=candidate_api_window attribution=aggregate window=tail_5000 source=%s operation=%s total=%d success=%d invalid=%d rate_limited=%d unavailable=%d http_2xx=%d http_3xx=%d http_4xx=%d http_5xx=%d no_status=%d http_other=%d failure_request=%d failure_response=%d\n", source, operation, metric_total[operation], metric_outcome[operation, "success"], metric_outcome[operation, "invalid"], metric_outcome[operation, "rate_limited"], metric_outcome[operation, "unavailable"], metric_status[operation, "http_2xx"], metric_status[operation, "http_3xx"], metric_status[operation, "http_4xx"], metric_status[operation, "http_5xx"], metric_status[operation, "no_status"], metric_status[operation, "http_other"], metric_failure[operation, "request"], metric_failure[operation, "response"]
      operation = "verify_code"
      printf "legacy_otp_hotfix otp_stage_diagnostic scope=candidate_api_window attribution=aggregate window=tail_5000 coverage=partial source=%s operation=%s total=%d success=%d invalid=%d rate_limited=%d unavailable=%d http_2xx=%d http_3xx=%d http_4xx=%d http_5xx=%d no_status=%d http_other=%d failure_token_request=%d failure_token_response=%d failure_post_token=%d\n", source, operation, metric_total[operation], metric_outcome[operation, "success"], metric_outcome[operation, "invalid"], metric_outcome[operation, "rate_limited"], metric_outcome[operation, "unavailable"], metric_status[operation, "http_2xx"], metric_status[operation, "http_3xx"], metric_status[operation, "http_4xx"], metric_status[operation, "http_5xx"], metric_status[operation, "no_status"], metric_status[operation, "http_other"], metric_failure[operation, "token_request"], metric_failure[operation, "token_response"], metric_failure[operation, "post_token"]
      operation = "profile_read"
      printf "legacy_otp_hotfix otp_stage_diagnostic scope=candidate_api_window attribution=aggregate window=tail_5000 source=%s operation=%s total=%d success=%d invalid=%d rate_limited=%d unavailable=%d http_2xx=%d http_3xx=%d http_4xx=%d http_5xx=%d no_status=%d http_other=%d failure_profile_request=%d failure_profile_response=%d failure_profile_payload=%d\n", source, operation, metric_total[operation], metric_outcome[operation, "success"], metric_outcome[operation, "invalid"], metric_outcome[operation, "rate_limited"], metric_outcome[operation, "unavailable"], metric_status[operation, "http_2xx"], metric_status[operation, "http_3xx"], metric_status[operation, "http_4xx"], metric_status[operation, "http_5xx"], metric_status[operation, "no_status"], metric_status[operation, "http_other"], metric_failure[operation, "profile_request"], metric_failure[operation, "profile_response"], metric_failure[operation, "profile_payload"]
    }
  '
  unset otp_logs
}

emit_otp_session_evidence() {
  source=$1
  evidence_count=$2
  if test "$source" != available; then
    evidence_outcome=unknown
  else
    case "$evidence_count" in
    0) evidence_outcome=none ;;
    1) evidence_outcome=exactly_one ;;
    '' | *[!0-9]*) evidence_outcome=unknown ;;
    *) evidence_outcome=multiple ;;
    esac
  fi
  printf '%s\n' "legacy_otp_hotfix otp_stage_diagnostic scope=local-padel_database source=$source operation=session_evidence outcome=$evidence_outcome"
}

wait_service() {
  service=$1
  release_file=$2
  expected_ref=$(image_ref_from "$release_file" "$service")
  attempt=0
  while test "$attempt" -lt 36; do
    ids=$(docker ps --filter label=com.docker.compose.project=phub-staging --filter "label=com.docker.compose.service=$service" --format '{{.ID}}' 2>/dev/null || true)
    if test "$(printf '%s\n' "$ids" | awk 'NF { count += 1 } END { print count + 0 }')" -eq 1 &&
      test "$(docker inspect --format '{{.State.Health.Status}}' "$ids" 2>/dev/null || true)" = healthy &&
      test "$(docker inspect --format '{{.Config.Image}}' "$ids" 2>/dev/null || true)" = "$expected_ref"; then
      return 0
    fi
    attempt=$((attempt + 1))
    sleep 5
  done
  diagnose_service_readiness "$service"
  fail "$service did not become healthy on the exact image within 180 seconds"
}

running_flag_disabled() {
  container=$1
  key=$2
  environment=$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$container")
  count=$(printf '%s\n' "$environment" | awk -F= -v key="$key" '$1 == key { count += 1 } END { print count + 0 }')
  case "$count" in
    0) return 0 ;;
    1)
      value=$(printf '%s\n' "$environment" | awk -F= -v key="$key" '$1 == key { print substr($0, length(key) + 2) }')
      test "$value" = false || fail "running $key must be absent or false"
      ;;
    *) fail "running $key must occur at most once" ;;
  esac
}

assert_flags_disabled() {
  api=$(project_container_id api)
  worker=$(project_container_id worker)
  realtime=$(project_container_id realtime)
  for container in "$api" "$worker"; do
    for key in PROFILE_PHOTO_CLIENT_SYNC_ENABLED COMMUNITY_INVITES_ENABLED COMMUNITIES_REALTIME_ENABLED COMMUNITY_MEDIA_ENABLED COMMUNITY_LOGO_STABLE_DELIVERY_ENABLED COMMUNITY_LOGO_COMPATIBILITY_BACKFILL_ENABLED; do
      running_flag_disabled "$container" "$key"
    done
  done
  running_flag_disabled "$realtime" COMMUNITIES_REALTIME_ENABLED
}

verify_public_release() {
  expected=$1
  body=$(curl --fail --silent --show-error --connect-timeout 3 --max-time 15 --resolve lk.nano.padlhub.su:443:127.0.0.1 https://lk.nano.padlhub.su/manifest.json)
  actual=$(printf '%s' "$body" | sed -n 's/.*"release"[[:space:]]*:[[:space:]]*"\([0-9a-f]*\)".*/\1/p')
  test "$actual" = "$expected" || fail 'public manifest release differs'
}

stop_runtime() {
  ids=''
  for service in api realtime worker web; do
    found=$(docker ps --filter label=com.docker.compose.project=phub-staging --filter "label=com.docker.compose.service=$service" --format '{{.ID}}')
    test "$(printf '%s\n' "$found" | awk 'NF { count += 1 } END { print count + 0 }')" -le 1 || fail "$service has multiple running containers"
    test -z "$found" || ids="$ids $found"
  done
  test -z "$ids" || docker stop -t 30 $ids >/dev/null
}

atomic_install() {
  source=$1
  temporary=$2
  destination=$3
  staged_phase=$4
  test ! -e "$temporary" && test ! -L "$temporary" || fail "temporary file already exists: $temporary"
  install -m 600 "$source" "$temporary"
  sync_path "$temporary"
  maybe_fail "$staged_phase"
  mv "$temporary" "$destination"
  sync_path "$destination"
}

remove_bounded_next_artifact() {
  path=$1
  if test ! -e "$path" && test ! -L "$path"; then
    return 0
  fi
  test -f "$path" && test ! -L "$path" || fail "transition next artifact is unsafe: $path"
  test "$(stat -c '%F:%h:%u:%g:%a' "$path")" = "regular file:1:$(id -u):$(id -g):600" ||
    fail "transition next artifact metadata is unsafe: $path"
  rm -f "$path"
  sync "$(dirname "$path")"
}

clear_bounded_next_artifacts() {
  remove_bounded_next_artifact "$marker_next"
  remove_bounded_next_artifact "$release_next"
}

marker_value() {
  key=$1
  count=$(awk -F= -v key="$key" '$1 == key { count += 1 } END { print count + 0 }' "$marker")
  test "$count" -eq 1 || fail "marker must contain exactly one $key"
  sed -n "s/^${key}=//p" "$marker"
}

validate_marker() {
  test -f "$marker" && test ! -L "$marker" || fail 'hotfix marker is absent or unsafe'
  test "$(stat -c '%F:%h:%u:%g:%a' "$marker")" = "regular file:1:$(id -u):$(id -g):600" || fail 'hotfix marker metadata is unsafe'
  test "$(wc -l < "$marker" | tr -d ' ')" -eq 10 || fail 'hotfix marker shape is invalid'
  test "$(marker_value VERSION)" = 1 || fail 'hotfix marker version is unsupported'
  test "$(marker_value EXPECTED_ACTIVE_RELEASE)" = "$expected_active_release" || fail 'marker active release differs'
  test "$(marker_value CANDIDATE_RELEASE)" = "$candidate_release" || fail 'marker candidate release differs'
  test "$(marker_value CONTROL_COMMIT)" = "$control_commit" || fail 'marker control commit differs'
  test "$(marker_value WORKFLOW_RUN_ID)" = "$workflow_run_id" || fail 'marker workflow run ID differs'
  test "$(marker_value WORKFLOW_RUN_ATTEMPT)" = "$workflow_run_attempt" || fail 'marker workflow run attempt differs'
  test "$(marker_value BUNDLE_PATH)" = "$bundle_path" || fail 'marker bundle path differs'
  started_at_epoch=$(marker_value STARTED_AT_EPOCH)
  case "$started_at_epoch" in '' | *[!0-9]*) fail 'marker start epoch is malformed' ;; esac
  candidate_ready_at_epoch=$(marker_value CANDIDATE_READY_AT_EPOCH)
  case "$candidate_ready_at_epoch" in '' | *[!0-9]*) fail 'marker candidate-ready epoch is malformed' ;; esac
  backup_path=$(marker_value BACKUP_PATH)
  case "$backup_path" in "$backup_root"/pre-legacy-otp-*) ;; *) fail 'marker backup path is outside the bounded root' ;; esac
  test -d "$backup_path" && test ! -L "$backup_path" || fail 'marker backup path is absent or unsafe'
}

start_runtime() {
  release_file=$1
  side=$2
  for service in realtime api worker web; do
    compose_with "$release_file" up -d --no-deps --force-recreate --pull never "$service"
    wait_service "$service" "$release_file"
    maybe_fail "$side-$service-ready"
  done
}

restore_from_marker() {
  validate_marker
  clear_bounded_next_artifacts
  saved_release="$backup_path/release.env"
  test -f "$saved_release" && test ! -L "$saved_release" || fail 'saved release.env is absent or unsafe'
  require_release_shape "$saved_release"
  test "$(env_value "$saved_release" RELEASE)" = "$expected_active_release" || fail 'saved release is not the exact legacy release'
  stop_runtime
  maybe_fail restore-runtime-stopped
  atomic_install "$saved_release" "$release_next" "$app_root/release.env" restore-release-staged
  maybe_fail restore-release-installed
  start_runtime "$app_root/release.env" restore
  for service in realtime api worker web; do attest_service "$service" "$app_root/release.env"; done
  assert_flags_disabled
  verify_public_release "$expected_active_release"
  clear_bounded_next_artifacts
  rm -f "$marker"
  sync "$app_root"
  printf '%s\n' "legacy_otp_hotfix operation=rollback release=$expected_active_release status=passed"
}

require_release_shape "$app_root/release.env"
require_digest_manifest "$bundle_path/image-digests.env"

if test "$operation" = attest; then
  validate_marker
  test "$(env_value "$app_root/release.env" RELEASE)" = "$candidate_release" || fail 'OTP candidate is not active during attestation'
  for service in realtime api worker web; do attest_service "$service" "$app_root/release.env"; done
  assert_flags_disabled
  verify_public_release "$candidate_release"
  test "$candidate_ready_at_epoch" -gt 0 || fail 'candidate-ready evidence is absent'
  candidate_ready_at_iso=$(date -u -d "@$candidate_ready_at_epoch" '+%Y-%m-%dT%H:%M:%SZ')
  evidence_source=unavailable
  evidence_count=''
  if evidence_count=$(infrastructure exec -T postgres sh -eu -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atqc "$1"' sh "
    select count(*)
    from (
      select distinct session_audit.correlation_id
      from identity.tenants tenant
      join audit.audit_log session_audit
        on session_audit.tenant_id = tenant.id
       and session_audit.action = 'AUTH_SESSION_CREATED'
       and session_audit.result = 'SUCCESS'
      join audit.audit_log legal_audit
        on legal_audit.tenant_id = session_audit.tenant_id
       and legal_audit.actor_id = session_audit.actor_id
       and legal_audit.correlation_id = session_audit.correlation_id
       and legal_audit.action = 'PHONE_OTP_LEGAL_ACCEPTANCE_RECORDED'
       and legal_audit.result = 'SUCCESS'
      join integration.external_identity_map external_identity
        on external_identity.tenant_id = session_audit.tenant_id
       and external_identity.user_id = session_audit.actor_id
       and external_identity.provider = 'VIVA'
      join integration.user_delegations delegation
        on delegation.tenant_id = session_audit.tenant_id
       and delegation.user_id = session_audit.actor_id
       and delegation.provider = 'VIVA'
       and delegation.revoked_at is null
       and (delegation.refresh_expires_at is null or delegation.refresh_expires_at > now())
      where tenant.tenant_key = 'local-padel'
        and session_audit.occurred_at >= timestamptz '$candidate_ready_at_iso'
        and legal_audit.occurred_at >= timestamptz '$candidate_ready_at_iso'
        and external_identity.last_seen_at >= timestamptz '$candidate_ready_at_iso'
        and delegation.updated_at >= timestamptz '$candidate_ready_at_iso'
    ) evidence
  " 2>/dev/null); then
    evidence_source=available
  fi
  if test "$evidence_source" = available && test "$evidence_count" = 1; then
    emit_otp_session_evidence "$evidence_source" "$evidence_count"
    printf '%s\n' 'legacy_otp_hotfix otp_canary_evidence=correlation-bound status=passed'
    exit 0
  fi
  emit_otp_stage_diagnostics "$(project_container_id api)" "$candidate_ready_at_iso" || true
  emit_otp_session_evidence "$evidence_source" "$evidence_count"
  test "$evidence_source" = available || fail 'correlation-bound local-padel phone OTP evidence query is unavailable'
  fail 'expected exactly one correlation-bound local-padel phone OTP success during the canary window'
fi

if test "$operation" = rollback; then
  if test ! -e "$marker" && test ! -L "$marker"; then
    test "$(env_value "$app_root/release.env" RELEASE)" = "$expected_active_release" || fail 'marker is absent while legacy release is not active'
    for service in realtime api worker web; do attest_service "$service" "$app_root/release.env"; done
    assert_flags_disabled
    verify_public_release "$expected_active_release"
    clear_bounded_next_artifacts
    printf '%s\n' "legacy_otp_hotfix operation=rollback release=$expected_active_release status=already-restored"
    exit 0
  fi
  restore_from_marker
  exit 0
fi

for path in "$marker" "$marker_next" "$release_next" /etc/phub/.runtime-secret-isolation.transition.json /etc/phub/.runtime-secret-isolation.transition.json.next /etc/phub/.runtime-secret-bootstrap.finalized.json; do
  test ! -e "$path" && test ! -L "$path" || fail "unresolved staging transition artifact exists: $path"
done
test "$(env_value "$app_root/release.env" RELEASE)" = "$expected_active_release" || fail 'active release differs from the exact legacy base'
test "$(sha256 "$app_root/compose.yaml")" = "$supported_active_compose_sha" || fail 'active Compose differs from the exact legacy definition'
test "$(sha256 "$bundle_path/compose.staging.yaml")" = "$supported_active_compose_sha" || fail 'candidate Compose differs from the exact legacy definition'
verify_public_release "$expected_active_release"
require_headroom_kib 8388608
for service in realtime api worker web; do
  attest_service "$service" "$app_root/release.env"
  docker image inspect "$(image_ref_from "$app_root/release.env" "$service")" >/dev/null 2>&1 || fail "old $service image is not local"
done
assert_flags_disabled

candidate_release_file="$bundle_path/candidate-release.env"
test ! -e "$candidate_release_file" && test ! -L "$candidate_release_file" || fail 'candidate release file already exists'
awk -F= \
  -v release="$candidate_release" \
  -v web="$(env_value "$bundle_path/image-digests.env" WEB_IMAGE_DIGEST)" \
  -v api="$(env_value "$bundle_path/image-digests.env" API_IMAGE_DIGEST)" \
  -v worker="$(env_value "$bundle_path/image-digests.env" WORKER_IMAGE_DIGEST)" \
  -v realtime="$(env_value "$bundle_path/image-digests.env" REALTIME_IMAGE_DIGEST)" \
  -v migrator="$(env_value "$bundle_path/image-digests.env" MIGRATOR_IMAGE_DIGEST)" '
    $1 == "RELEASE" { print "RELEASE=" release; next }
    $1 == "WEB_IMAGE_DIGEST" { print "WEB_IMAGE_DIGEST=" web; next }
    $1 == "API_IMAGE_DIGEST" { print "API_IMAGE_DIGEST=" api; next }
    $1 == "WORKER_IMAGE_DIGEST" { print "WORKER_IMAGE_DIGEST=" worker; next }
    $1 == "REALTIME_IMAGE_DIGEST" { print "REALTIME_IMAGE_DIGEST=" realtime; next }
    $1 == "MIGRATOR_IMAGE_DIGEST" { print "MIGRATOR_IMAGE_DIGEST=" migrator; next }
    { print }
  ' "$app_root/release.env" > "$candidate_release_file"
chmod 600 "$candidate_release_file"
sync_path "$candidate_release_file"
require_release_shape "$candidate_release_file"
test "$(env_value "$candidate_release_file" RELEASE)" = "$candidate_release" || fail 'candidate release file has wrong SHA'
test "$(env_value "$candidate_release_file" LATEST_MIGRATION)" = "$(env_value "$app_root/release.env" LATEST_MIGRATION)" || fail 'OTP hotfix may not change latest migration'
test "$(env_value "$candidate_release_file" REGISTRY)" = "$(env_value "$app_root/release.env" REGISTRY)" || fail 'candidate registry differs'

candidate_images=$(compose_with "$candidate_release_file" --profile migration config --images)
test "$(printf '%s\n' "$candidate_images" | sed '/^$/d' | wc -l | tr -d ' ')" -eq 5 || fail 'candidate Compose must resolve exactly five images'
for service in web api worker realtime migrator; do
  ref=$(image_ref_from "$candidate_release_file" "$service")
  printf '%s\n' "$candidate_images" | grep -Fxq "$ref" || fail "candidate Compose does not bind $service digest"
  docker pull "$ref" >/dev/null
done
for service in api worker realtime migrator; do
  verify_candidate_runtime_imports "$service"
done
require_headroom_kib 2097152

backup_path="$backup_root/pre-legacy-otp-$workflow_run_id-$workflow_run_attempt"
PHUB_BACKUP_ROOT="$backup_root" sh "$bundle_path/backup-application.sh" "$backup_path" BACKUP_STAGING_RELEASE
PHUB_ROLLBACK_BACKUP_ROOT="$backup_root" sh "$bundle_path/rollback-application.sh" "$backup_path" --validate-only
test "$(sha256 "$backup_path/compose.yaml")" = "$supported_active_compose_sha" || fail 'saved Compose differs from exact e308'
test "$(env_value "$backup_path/release.env" RELEASE)" = "$expected_active_release" || fail 'saved release differs from exact e308'

database_backup="$app_root/backups/postgres-pre-legacy-otp-$candidate_release-$(date -u +%Y%m%dT%H%M%SZ).dump"
database_tmp="$database_backup.next"
test ! -e "$database_backup" && test ! -L "$database_backup" && test ! -e "$database_tmp" && test ! -L "$database_tmp" || fail 'database backup path already exists'

on_error() {
  status=$?
  trap - EXIT HUP INT TERM
  if test -e "$marker" || test -L "$marker"; then
    flock -u 9 >/dev/null 2>&1 || :
    if PHUB_OTP_HOTFIX_FAIL_AFTER= sh "$0" \
      rollback \
      "$expected_active_release" \
      "$candidate_release" \
      "$control_commit" \
      "$workflow_run_id" \
      "$workflow_run_attempt" \
      ROLLBACK_LEGACY_OTP_HOTFIX_CANARY \
      "$bundle_path"; then
      :
    else
      printf '%s\n' 'legacy_otp_hotfix rollback=failed marker=retained' >&2
    fi
  else
    rm -f "$database_tmp" "$database_backup" "$candidate_release_file" "$marker_next" "$release_next"
  fi
  exit "$status"
}
trap on_error EXIT HUP INT TERM

umask 077
infrastructure exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom --no-owner --no-acl' > "$database_tmp"
test -s "$database_tmp" || fail 'database backup is empty'
infrastructure exec -T postgres pg_restore --list < "$database_tmp" >/dev/null
chmod 600 "$database_tmp"
sync_path "$database_tmp"
mv "$database_tmp" "$database_backup"
sync_path "$database_backup"

{
  printf 'VERSION=1\n'
  printf 'EXPECTED_ACTIVE_RELEASE=%s\n' "$expected_active_release"
  printf 'CANDIDATE_RELEASE=%s\n' "$candidate_release"
  printf 'CONTROL_COMMIT=%s\n' "$control_commit"
  printf 'WORKFLOW_RUN_ID=%s\n' "$workflow_run_id"
  printf 'WORKFLOW_RUN_ATTEMPT=%s\n' "$workflow_run_attempt"
  printf 'BUNDLE_PATH=%s\n' "$bundle_path"
  printf 'STARTED_AT_EPOCH=%s\n' "$(date -u +%s)"
  printf 'CANDIDATE_READY_AT_EPOCH=0\n'
  printf 'BACKUP_PATH=%s\n' "$backup_path"
} > "$marker_next"
chmod 600 "$marker_next"
sync_path "$marker_next"
maybe_fail marker-staged
mv "$marker_next" "$marker"
sync_path "$marker"
maybe_fail marker-published
stop_runtime
maybe_fail candidate-runtime-stopped
atomic_install "$candidate_release_file" "$release_next" "$app_root/release.env" candidate-release-staged
maybe_fail candidate-release-installed
start_runtime "$app_root/release.env" candidate
for service in realtime api worker web; do attest_service "$service" "$app_root/release.env"; done
assert_flags_disabled
verify_public_release "$candidate_release"
maybe_fail candidate-public-verified
candidate_ready_at_epoch=$(date -u +%s)
awk -F= -v ready="$candidate_ready_at_epoch" '
  $1 == "CANDIDATE_READY_AT_EPOCH" { print "CANDIDATE_READY_AT_EPOCH=" ready; next }
  { print }
' "$marker" > "$marker_next"
chmod 600 "$marker_next"
sync_path "$marker_next"
maybe_fail candidate-ready-marker-staged
mv "$marker_next" "$marker"
sync_path "$marker"
trap - EXIT HUP INT TERM
printf '%s\n' "legacy_otp_hotfix operation=start release=$candidate_release database_backup=retained status=canary-window-open"
