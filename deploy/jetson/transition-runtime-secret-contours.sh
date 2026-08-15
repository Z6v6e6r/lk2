#!/bin/sh
set -eu

fail() {
  printf '%s\n' "Runtime secret transition refused: $*" >&2
  exit 1
}

test "$#" -eq 5 || fail 'usage: transition-runtime-secret-contours.sh <transition|finalize|recover> <expected-release> <confirmation> <candidate-compose> <helper>'
operation=$1
expected_release=$2
confirmation=$3
candidate_compose=$4
helper_script=$5
app_root=${PHUB_APP_ROOT:-/opt/phub}
secret_root=${PHUB_SECRET_ROOT:-/etc/phub}
marker="$secret_root/.runtime-secret-isolation.transition.json"
marker_next="$marker.next"
compose_backup="$app_root/.runtime-secret-isolation.compose.backup"
compose_next="$app_root/.runtime-secret-isolation.compose.next"

case "$operation:$confirmation" in
  transition:TRANSITION_STAGING_RUNTIME_SECRETS | finalize:TRANSITION_STAGING_RUNTIME_SECRETS | recover:RECOVER_STAGING_RUNTIME_SECRETS) ;;
  *) fail 'exact operation confirmation is required' ;;
esac
printf '%s' "$expected_release" | grep -Eq '^[0-9a-f]{40}$' || fail 'expected release must be a 40-character SHA'
for path in "$candidate_compose" "$helper_script" "$app_root/release.env" "$app_root/infrastructure.env" "$app_root/compose.yaml" "$app_root/compose.infrastructure.yaml"; do
  test -f "$path" && test ! -L "$path" || fail "required input is absent or unsafe: $path"
done
for path in "$app_root" "$secret_root"; do
  test -d "$path" && test ! -L "$path" || fail "required directory is absent or unsafe: $path"
done

exec 9>"$app_root/.runtime-secret-isolation.lock"
flock -n 9 || fail 'another runtime-secret transition is active'

release_value() {
  key=$1
  count=$(awk -F= -v key="$key" '$1 == key { count += 1 } END { print count + 0 }' "$app_root/release.env")
  test "$count" -eq 1 || fail "release.env must contain exactly one $key"
  sed -n "s/^${key}=//p" "$app_root/release.env"
}

active_release=$(release_value RELEASE)
test "$active_release" = "$expected_release" || fail 'active release differs from the approved release'
registry=$(release_value REGISTRY)
printf '%s' "$registry" | grep -Eq '^ghcr\.io/[A-Za-z0-9._/-]+$' || fail 'release registry is malformed'

compose() {
  docker compose --project-name phub-staging \
    --env-file "$app_root/infrastructure.env" \
    --env-file "$app_root/release.env" \
    -f "$app_root/compose.yaml" "$@"
}

container_id() {
  ids=$(compose ps --status running -q "$1")
  test "$(printf '%s\n' "$ids" | awk 'NF { n += 1 } END { print n + 0 }')" -eq 1 ||
    fail "$1 must have exactly one running container"
  printf '%s' "$ids"
}

health() {
  test "$(docker inspect --format '{{.State.Health.Status}}' "$1")" = healthy || fail "$2 is not healthy"
}

image_id() {
  value=$(docker inspect --format '{{.Image}}' "$1")
  printf '%s' "$value" | grep -Eq '^sha256:[0-9a-f]{64}$' || fail "$2 image ID is malformed"
  printf '%s' "$value"
}

image_ref() {
  docker inspect --format '{{.Config.Image}}' "$1"
}

expected_ref() {
  service=$1
  case "$service" in
    web) key=WEB_IMAGE_DIGEST ;;
    api) key=API_IMAGE_DIGEST ;;
    worker) key=WORKER_IMAGE_DIGEST ;;
    realtime) key=REALTIME_IMAGE_DIGEST ;;
    *) fail 'unknown service image' ;;
  esac
  digest=$(release_value "$key")
  printf '%s' "$digest" | grep -Eq '^sha256:[0-9a-f]{64}$' || fail "$key is malformed"
  printf '%s/phub-%s@%s' "$registry" "$service" "$digest"
}

wait_service() {
  service=$1
  attempt=0
  while test "$attempt" -lt 36; do
    ids=$(compose ps --status running -q "$service" 2>/dev/null || true)
    if test "$(printf '%s\n' "$ids" | awk 'NF { n += 1 } END { print n + 0 }')" -eq 1 &&
      test "$(docker inspect --format '{{.State.Health.Status}}' "$ids" 2>/dev/null || true)" = healthy; then
      printf '%s' "$ids"
      return 0
    fi
    attempt=$((attempt + 1))
    sleep 5
  done
  fail "$service did not become healthy within 180 seconds"
}

nginx_id() {
  ids=$(docker compose --env-file "$app_root/infrastructure.env" -f "$app_root/compose.infrastructure.yaml" ps --status running -q nginx)
  test "$(printf '%s\n' "$ids" | awk 'NF { n += 1 } END { print n + 0 }')" -eq 1 || fail 'Nginx must have one running container'
  printf '%s' "$ids"
}

runtime_snapshot() {
  for service in web api worker realtime; do
    id=$(container_id "$service")
    printf '%s|%s|%s|%s|%s\n' "$service" "$id" "$(image_id "$id" "$service")" "$(image_ref "$id")" "$(docker inspect --format '{{.State.StartedAt}}' "$id")"
  done | sha256sum | cut -d ' ' -f 1
}

running_flag() {
  id=$1
  key=$2
  value=$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$id" | sed -n "s/^${key}=//p" | tail -n 1)
  test "$value" = false || fail "running $key must be false"
}

assert_disabled_flags() {
  api_id=$1
  worker_id=$2
  realtime_id=$3
  assert_application_flags_disabled "$api_id"
  assert_application_flags_disabled "$worker_id"
  running_flag "$realtime_id" COMMUNITIES_REALTIME_ENABLED
}

assert_application_flags_disabled() {
  container=$1
  for key in PROFILE_PHOTO_CLIENT_SYNC_ENABLED COMMUNITY_INVITES_ENABLED COMMUNITIES_REALTIME_ENABLED COMMUNITY_MEDIA_ENABLED COMMUNITY_LOGO_STABLE_DELIVERY_ENABLED COMMUNITY_LOGO_COMPATIBILITY_BACKFILL_ENABLED; do
    running_flag "$container" "$key"
  done
}

assert_no_shadowing() {
  for file in "$app_root/staging.auth.env" "$app_root/staging.override.env" "$app_root/staging.games.env" "$app_root/staging.communities.env"; do
    if test -e "$file" || test -L "$file"; then
      test -f "$file" && test ! -L "$file" || fail "runtime override is unsafe: $file"
      if grep -Eq '^[[:space:]]*(JWT_REALTIME_SECRET|COMMUNITIES_REALTIME_ENABLED)[[:space:]]*=' "$file"; then
        fail "runtime-secret settings are shadowed in $file"
      fi
    fi
  done
}

probe_realtime_candidate() {
  output=$(docker run --rm --pull=never --entrypoint node --network none --read-only \
    --tmpfs /tmp:rw,noexec,nosuid,nodev,size=1m --security-opt no-new-privileges \
    --cap-drop ALL --memory 128m --pids-limit 64 \
    --env-file "$secret_root/realtime.env" "$old_realtime_image" --input-type=module -e '
      const { loadRealtimeConfig } = await import("@phub/config");
      const config = loadRealtimeConfig(process.env);
      if (config.APP_ENV !== "staging" || config.COMMUNITIES_REALTIME_ENABLED || config.REALTIME_EXPECTED_REPLICAS !== 1) process.exit(1);
      process.stdout.write("runtime-secret-transition probe=realtime-config status=passed\n");
    ') || fail 'active realtime image rejected the isolated candidate contour'
  test "$output" = 'runtime-secret-transition probe=realtime-config status=passed' ||
    fail 'realtime candidate probe returned unexpected output'
}

helper_image=''
deploy_uid=$(id -u phub-deploy)
deploy_gid=$(id -g phub-deploy)
printf '%s' "$deploy_uid:$deploy_gid" | grep -Eq '^[1-9][0-9]*:[1-9][0-9]*$' || fail 'deployment UID/GID must be numeric and non-root'

resolve_helper_image() {
  test -z "$helper_image" || return 0
  api_ids=$(compose ps -q api 2>/dev/null || true)
  if test "$(printf '%s\n' "$api_ids" | awk 'NF { n += 1 } END { print n + 0 }')" -eq 1; then
    helper_image=$(image_id "$api_ids" api)
  else
    ref=$(expected_ref api)
    helper_image=$(docker image inspect --format '{{.Id}}' "$ref")
  fi
  printf '%s' "$helper_image" | grep -Eq '^sha256:[0-9a-f]{64}$' || fail 'helper image is not immutable'
  docker image inspect "$helper_image" >/dev/null 2>&1 || fail 'helper image is not local'
}

helper_raw() {
  resolve_helper_image
  docker run --rm -i --pull=never --entrypoint node --user 0:0 --network none --read-only \
    --tmpfs /tmp:rw,noexec,nosuid,nodev,size=1m --security-opt no-new-privileges \
    --cap-drop ALL --cap-add CHOWN --memory 128m --pids-limit 64 \
    --mount type=bind,src="$secret_root",dst=/target,rw \
    "$helper_image" --input-type=module - "$@" < "$helper_script"
}

run_helper() {
  mode=$1
  shift
  output=$(helper_raw "$mode" /target "$@") || fail "helper operation $mode failed"
  test "$(printf '%s\n' "$output" | wc -l | tr -d ' ')" -eq 1 || fail "helper operation $mode returned unexpected output"
  printf '%s\n' "$output" | grep -Eq "^runtime-secret-transition operation=${mode} result=[a-z-]+ status=passed$" ||
    fail "helper operation $mode did not acknowledge completion"
  printf '%s\n' "$output"
}

state_field() {
  field=$1
  output=$(helper_raw read-field /target "$field") || fail "cannot read marker field $field"
  test "$(printf '%s\n' "$output" | wc -l | tr -d ' ')" -eq 1 || fail 'marker field output is ambiguous'
  prefix="runtime-secret-transition field=$field value="
  suffix=' status=passed'
  case "$output" in "$prefix"*"$suffix") ;; *) fail "marker field $field is malformed" ;; esac
  value=${output#"$prefix"}
  value=${value%"$suffix"}
  test -n "$value" || fail "marker field $field is empty"
  printf '%s' "$value"
}

recover_marker_if_needed() {
  if test -e "$marker_next" || test -L "$marker_next"; then
    run_helper recover-marker >/dev/null
  fi
}

attest_recorded_state() {
  test "$(state_field activeRelease)" = "$active_release" || fail 'recorded release differs from active release'
  test "$(state_field releaseEnvSha256)" = "$(sha256sum "$app_root/release.env" | cut -d ' ' -f 1)" || fail 'release.env changed since transition began'
  test "$(state_field infrastructureIdentity)" = "$(stat -c '%d:%i:%s:%Y' "$app_root/infrastructure.env")" || fail 'infrastructure.env identity changed'
  test "$(state_field infrastructureComposeSha256)" = "$(sha256sum "$app_root/compose.infrastructure.yaml" | cut -d ' ' -f 1)" || fail 'infrastructure Compose changed'
  test "$(container_id web)" = "$(state_field oldWebId)" || fail 'web container changed during transition'
  test "$(nginx_id)" = "$(state_field oldNginxId)" || fail 'Nginx container changed during transition'
  test "$(state_field oldApiImageRef)" = "$(expected_ref api)" || fail 'API recorded image ref differs from release.env'
  test "$(state_field oldWorkerImageRef)" = "$(expected_ref worker)" || fail 'worker recorded image ref differs from release.env'
  test "$(state_field oldRealtimeImageRef)" = "$(expected_ref realtime)" || fail 'realtime recorded image ref differs from release.env'
}

attest_candidate_runtime() {
  attest_recorded_state
  test "$(state_field candidateComposeSha256)" = "$(sha256sum "$app_root/compose.yaml" | cut -d ' ' -f 1)" || fail 'candidate Compose changed'
  candidate_api=$(container_id api)
  candidate_worker=$(container_id worker)
  candidate_realtime=$(container_id realtime)
  health "$candidate_api" api
  health "$candidate_worker" worker
  health "$candidate_realtime" realtime
  test "$(image_id "$candidate_api" api)" = "$(state_field oldApiImageId)" &&
    test "$(image_ref "$candidate_api")" = "$(state_field oldApiImageRef)" || fail 'API candidate image differs'
  test "$(image_id "$candidate_worker" worker)" = "$(state_field oldWorkerImageId)" &&
    test "$(image_ref "$candidate_worker")" = "$(state_field oldWorkerImageRef)" || fail 'worker candidate image differs'
  test "$(image_id "$candidate_realtime" realtime)" = "$(state_field oldRealtimeImageId)" &&
    test "$(image_ref "$candidate_realtime")" = "$(state_field oldRealtimeImageRef)" || fail 'realtime candidate image differs'
  assert_disabled_flags "$candidate_api" "$candidate_worker" "$candidate_realtime"
  run_helper verify-prepared >/dev/null
}

restore_transition() {
  recover_marker_if_needed
  test -f "$marker" && test ! -L "$marker" || fail 'transition marker is absent or unsafe'
  attest_recorded_state
  phase=$(state_field phase)
  case "$phase" in verified | finalizing) fail 'verified transition must converge forward' ;; esac
  active_sha=$(state_field activeComposeSha256)
  candidate_sha=$(state_field candidateComposeSha256)
  current_sha=$(sha256sum "$app_root/compose.yaml" | cut -d ' ' -f 1)
  if test -e "$compose_backup" || test -L "$compose_backup"; then
    test -f "$compose_backup" && test ! -L "$compose_backup" || fail 'Compose backup is unsafe'
    test "$(sha256sum "$compose_backup" | cut -d ' ' -f 1)" = "$active_sha" || fail 'Compose backup digest changed'
    case "$current_sha" in
      "$active_sha") rm "$compose_backup" ;;
      "$candidate_sha") mv "$compose_backup" "$app_root/compose.yaml" ;;
      *) fail 'current Compose is neither recorded active nor candidate' ;;
    esac
    sync "$app_root/compose.yaml" "$app_root"
  else
    test "$current_sha" = "$active_sha" || fail 'active Compose backup is missing'
  fi
  rm -f "$compose_next"
  if test "$phase" != runtime-restored; then
    if test "$phase" != files-restored; then
      run_helper restore-files >/dev/null
    fi
    compose stop -t 30 api realtime
    compose up -d --no-deps --force-recreate --pull never realtime
    realtime=$(wait_service realtime)
    compose up -d --no-deps --force-recreate --pull never api
    api=$(wait_service api)
    compose up -d --no-deps --force-recreate --pull never worker
    worker=$(wait_service worker)
  else
    realtime=$(container_id realtime)
    api=$(container_id api)
    worker=$(container_id worker)
  fi
  test "$(image_id "$api" api)" = "$(state_field oldApiImageId)" &&
    test "$(image_ref "$api")" = "$(state_field oldApiImageRef)" || fail 'API rollback image differs'
  test "$(image_id "$worker" worker)" = "$(state_field oldWorkerImageId)" &&
    test "$(image_ref "$worker")" = "$(state_field oldWorkerImageRef)" || fail 'worker rollback image differs'
  test "$(image_id "$realtime" realtime)" = "$(state_field oldRealtimeImageId)" &&
    test "$(image_ref "$realtime")" = "$(state_field oldRealtimeImageRef)" || fail 'realtime rollback image differs'
  assert_disabled_flags "$api" "$worker" "$realtime"
  if test "$phase" != runtime-restored; then
    run_helper advance-phase files-restored runtime-restored >/dev/null
  fi
  run_helper complete-rollback >/dev/null
  printf '%s\n' 'runtime_secret_transition operation=recover status=passed'
}

recover_marker_if_needed
if test "$operation" = recover; then
  test -f "$marker" && test ! -L "$marker" || fail 'no recoverable transition marker exists'
  attest_recorded_state
  phase=$(state_field phase)
  case "$phase" in
    verified | finalizing)
      attest_candidate_runtime
      if test -e "$compose_backup" || test -L "$compose_backup"; then
        test -f "$compose_backup" && test ! -L "$compose_backup" || fail 'Compose backup is unsafe'
        rm "$compose_backup"
        sync "$app_root"
      fi
      run_helper finalize "$(runtime_snapshot)" >/dev/null
      printf '%s\n' 'runtime_secret_transition operation=recover action=finalize status=passed'
      ;;
    *) restore_transition ;;
  esac
  exit 0
fi

if test "$operation" = finalize; then
  test -f "$marker" && test ! -L "$marker" || fail 'transition marker is absent'
  test "$(state_field phase)" = worker-ready || fail 'transition is not ready for final attestation'
  attest_candidate_runtime
  final_snapshot=$(runtime_snapshot)
  run_helper advance-phase worker-ready verified >/dev/null
  test -f "$compose_backup" && test ! -L "$compose_backup" || fail 'Compose backup is absent or unsafe'
  rm "$compose_backup"
  sync "$app_root"
  run_helper finalize "$final_snapshot" >/dev/null
  printf '%s\n' "runtime_secret_transition operation=finalize release=$active_release status=passed"
  exit 0
fi

for path in "$marker" "$marker_next" "$compose_backup" "$compose_next"; do
  test ! -e "$path" && test ! -L "$path" || fail "unresolved transition artifact exists: $path"
done
test "$(stat -c '%u:%g:%a' "$secret_root")" = "0:$deploy_gid:750" || fail 'secret root ownership or mode differs'
test "$(stat -c '%h:%u:%g:%a' "$app_root/compose.yaml")" = "1:$deploy_uid:$deploy_gid:600" || fail 'active Compose metadata differs'
test "$(df -Pk "$secret_root" | awk 'NR == 2 { print $4 }')" -ge 65536 || fail 'secret filesystem lacks block headroom'
test "$(df -Pi "$secret_root" | awk 'NR == 2 { print $4 }')" -ge 128 || fail 'secret filesystem lacks inode headroom'
assert_no_shadowing

old_web=$(container_id web)
old_api=$(container_id api)
old_worker=$(container_id worker)
old_realtime=$(container_id realtime)
old_nginx=$(nginx_id)
health "$old_web" web
health "$old_api" api
health "$old_worker" worker
health "$old_realtime" realtime
test "$(image_ref "$old_web")" = "$(expected_ref web)" || fail 'web image ref differs from release.env'
test "$(image_ref "$old_api")" = "$(expected_ref api)" || fail 'API image ref differs from release.env'
test "$(image_ref "$old_worker")" = "$(expected_ref worker)" || fail 'worker image ref differs from release.env'
test "$(image_ref "$old_realtime")" = "$(expected_ref realtime)" || fail 'realtime image ref differs from release.env'
old_api_image=$(image_id "$old_api" api)
old_worker_image=$(image_id "$old_worker" worker)
old_realtime_image=$(image_id "$old_realtime" realtime)
old_api_ref=$(image_ref "$old_api")
old_worker_ref=$(image_ref "$old_worker")
old_realtime_ref=$(image_ref "$old_realtime")
assert_disabled_flags "$old_api" "$old_worker" "$old_realtime"
helper_image=$old_api_image
initial_snapshot=$(runtime_snapshot)

active_render=$(mktemp)
candidate_render=$(mktemp)
cleanup_render() { rm -f "$active_render" "$candidate_render"; }
trap cleanup_render EXIT HUP INT TERM
render() {
  RUNTIME_ENV_FILE="$secret_root/staging.env" REALTIME_RUNTIME_ENV_FILE="$secret_root/staging.env" \
    docker compose --project-name phub-staging --env-file "$app_root/infrastructure.env" --env-file "$app_root/release.env" -f "$1" config --format json
}
render "$app_root/compose.yaml" > "$active_render" || fail 'active Compose does not render'
render "$candidate_compose" > "$candidate_render" || fail 'candidate Compose does not render'
cmp -s "$active_render" "$candidate_render" || fail 'candidate Compose changes more than the approved realtime env contour'
cleanup_render
trap - EXIT HUP INT TERM

active_compose_sha=$(sha256sum "$app_root/compose.yaml" | cut -d ' ' -f 1)
candidate_compose_sha=$(sha256sum "$candidate_compose" | cut -d ' ' -f 1)
transition_started=false
on_error() {
  status=$?
  trap - EXIT HUP INT TERM
  if test "$transition_started" = true; then
    restore_transition || printf '%s\n' 'runtime_secret_transition rollback=failed marker=retained' >&2
  fi
  exit "$status"
}
trap on_error EXIT HUP INT TERM
transition_started=true
run_helper prepare "$deploy_uid" "$deploy_gid" \
  "$initial_snapshot" "$active_compose_sha" "$candidate_compose_sha" "$active_release" \
  "$(sha256sum "$app_root/release.env" | cut -d ' ' -f 1)" \
  "$(stat -c '%d:%i:%s:%Y' "$app_root/infrastructure.env")" \
  "$(sha256sum "$app_root/compose.infrastructure.yaml" | cut -d ' ' -f 1)" \
  "$old_api_image" "$old_api_ref" "$old_worker_image" "$old_worker_ref" \
  "$old_realtime_image" "$old_realtime_ref" "$old_web" "$old_nginx" >/dev/null
run_helper verify-prepared >/dev/null
probe_realtime_candidate

ln "$app_root/compose.yaml" "$compose_backup"
sync "$compose_backup" "$app_root"
cp "$candidate_compose" "$compose_next"
chmod 600 "$compose_next"
sync "$compose_next" "$app_root"
mv "$compose_next" "$app_root/compose.yaml"
sync "$app_root/compose.yaml" "$app_root"
run_helper advance-phase prepared compose-committed >/dev/null

compose stop -t 30 api realtime
run_helper advance-phase compose-committed runtime-stopped >/dev/null
compose up -d --no-deps --force-recreate --pull never realtime
new_realtime=$(wait_service realtime)
test "$(image_id "$new_realtime" realtime)" = "$old_realtime_image" && test "$(image_ref "$new_realtime")" = "$old_realtime_ref" || fail 'realtime image changed'
running_flag "$new_realtime" COMMUNITIES_REALTIME_ENABLED
run_helper advance-phase runtime-stopped realtime-ready >/dev/null
compose up -d --no-deps --force-recreate --pull never api
new_api=$(wait_service api)
test "$(image_id "$new_api" api)" = "$old_api_image" && test "$(image_ref "$new_api")" = "$old_api_ref" || fail 'API image changed'
assert_application_flags_disabled "$new_api"
run_helper advance-phase realtime-ready api-ready >/dev/null
compose up -d --no-deps --force-recreate --pull never worker
new_worker=$(wait_service worker)
test "$(image_id "$new_worker" worker)" = "$old_worker_image" && test "$(image_ref "$new_worker")" = "$old_worker_ref" || fail 'worker image changed'
assert_application_flags_disabled "$new_worker"
run_helper advance-phase api-ready worker-ready >/dev/null
assert_disabled_flags "$new_api" "$new_worker" "$new_realtime"
test "$(container_id web)" = "$old_web" || fail 'web container changed'
test "$(nginx_id)" = "$old_nginx" || fail 'Nginx container changed'
run_helper verify-prepared >/dev/null
test "$(release_value RELEASE)" = "$expected_release" || fail 'active release changed'
trap - EXIT HUP INT TERM
printf '%s\n' "runtime_secret_transition operation=transition release=$active_release services=realtime,api,worker status=awaiting-attestation"
