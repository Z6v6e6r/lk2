#!/bin/sh

set -eu

fail() {
  printf '%s\n' "Legacy runtime-secret bootstrap refused: $*" >&2
  exit 1
}

maybe_fail() {
  phase=$1
  if test "${PHUB_B0_FAIL_AFTER:-}" = "$phase"; then
    fail "injected failure after $phase"
  fi
}

test "$#" -eq 8 ||
  fail 'usage: bootstrap-legacy-runtime-secret-contours.sh <start|finalize|recover> <expected-active-release> <candidate-release> <control-commit> <run-id> <run-attempt> <confirmation> <bundle-path>'

operation=$1
expected_active_release=$2
candidate_release=$3
control_commit=$4
workflow_run_id=$5
workflow_run_attempt=$6
confirmation=$7
bundle_path=$8

case "$operation:$confirmation" in
  start:BOOTSTRAP_STAGING_RUNTIME_SECRETS | finalize:FINALIZE_STAGING_RUNTIME_SECRETS | recover:RECOVER_STAGING_RUNTIME_SECRETS) ;;
  *) fail 'exact operation confirmation is required' ;;
esac
for value in "$expected_active_release" "$candidate_release" "$control_commit"; do
  printf '%s' "$value" | grep -Eq '^[0-9a-f]{40}$' || fail 'release and control commits must be 40-character SHAs'
done
printf '%s' "$workflow_run_id" | grep -Eq '^[0-9]+$' || fail 'workflow run ID is malformed'
printf '%s' "$workflow_run_attempt" | grep -Eq '^[0-9]+$' || fail 'workflow run attempt is malformed'

app_root=${PHUB_APP_ROOT:-/opt/phub}
secret_root=${PHUB_SECRET_ROOT:-/etc/phub}
backup_root="$app_root/backups/releases"
marker="$secret_root/.runtime-secret-isolation.transition.json"
marker_next="$marker.next"
finalized_receipt="$secret_root/.runtime-secret-bootstrap.finalized.json"
compose_next="$app_root/.runtime-secret-bootstrap.compose.next"
release_next="$app_root/.runtime-secret-bootstrap.release.next"

case "$bundle_path" in
  "$app_root"/b0-candidates/*) ;;
  *) fail 'bundle path is outside the durable B0 candidate root' ;;
esac
case "$bundle_path" in *'/../'* | *'/..') fail 'bundle path contains traversal' ;; esac

for directory in "$app_root" "$secret_root" "$bundle_path"; do
  test -d "$directory" && test ! -L "$directory" || fail "required directory is absent or unsafe: $directory"
done
for path in \
  "$app_root/compose.yaml" \
  "$app_root/release.env" \
  "$app_root/infrastructure.env" \
  "$app_root/compose.infrastructure.yaml" \
  "$app_root/tls-ingress/compose.yaml" \
  "$bundle_path/provision-runtime-secret-files.mjs" \
  "$bundle_path/compose.staging.yaml" \
  "$bundle_path/image-digests.env" \
  "$bundle_path/migrations.manifest" \
  "$bundle_path/backup-application.sh" \
  "$bundle_path/rollback-application.sh"; do
  test -f "$path" && test ! -L "$path" || fail "required file is absent or unsafe: $path"
done

exec 9>"$app_root/.runtime-secret-isolation.lock"
flock -n 9 || fail 'another staging transition is active'

sha256() {
  sha256sum "$1" | cut -d ' ' -f 1
}

sync_path() {
  sync "$1"
  sync "$(dirname "$1")"
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
  registry=$(env_value "$file" REGISTRY)
  release=$(env_value "$file" RELEASE)
  latest=$(env_value "$file" LATEST_MIGRATION)
  printf '%s' "$registry" | grep -Eq '^ghcr\.io/[A-Za-z0-9._/-]+$' || fail 'release registry is malformed'
  printf '%s' "$release" | grep -Eq '^[0-9a-f]{40}$' || fail 'release SHA is malformed'
  printf '%s' "$latest" | grep -Eq '^[0-9][0-9A-Za-z._-]*\.sql$' || fail 'latest migration is malformed'
  for service in WEB API WORKER REALTIME MIGRATOR; do
    digest=$(env_value "$file" "${service}_IMAGE_DIGEST")
    printf '%s' "$digest" | grep -Eq '^sha256:[0-9a-f]{64}$' || fail "$service image digest is malformed"
  done
}

require_digest_manifest() {
  file=$1
  test "$(awk -F= 'NF == 2 { print $1 }' "$file" | wc -l | tr -d ' ')" -eq 7 || fail 'digest manifest must contain exactly seven entries'
  allowed='RELEASE REGISTRY WEB_IMAGE_DIGEST API_IMAGE_DIGEST WORKER_IMAGE_DIGEST REALTIME_IMAGE_DIGEST MIGRATOR_IMAGE_DIGEST'
  while IFS='=' read -r key value; do
    test -n "$key" && test -n "$value" || fail 'digest manifest contains an empty entry'
    printf ' %s ' "$allowed" | grep -Fq " $key " || fail 'digest manifest contains an unknown key'
  done < "$file"
  printf '%s' "$(env_value "$file" REGISTRY)" | grep -Eq '^ghcr\.io/[A-Za-z0-9._/-]+$' || fail 'digest manifest registry is malformed'
  printf '%s' "$(env_value "$file" RELEASE)" | grep -Eq '^[0-9a-f]{40}$' || fail 'digest manifest release is malformed'
  for service in WEB API WORKER REALTIME MIGRATOR; do
    printf '%s' "$(env_value "$file" "${service}_IMAGE_DIGEST")" | grep -Eq '^sha256:[0-9a-f]{64}$' || fail "digest manifest $service image is malformed"
  done
  test "$(env_value "$file" RELEASE)" = "$candidate_release" || fail 'digest manifest candidate release differs'
}

registry=$(env_value "$app_root/release.env" REGISTRY)
require_release_shape "$app_root/release.env"
require_digest_manifest "$bundle_path/image-digests.env"
test "$(env_value "$bundle_path/image-digests.env" REGISTRY)" = "$registry" || fail 'candidate registry differs from active registry'
case "$operation:$(env_value "$app_root/release.env" RELEASE)" in
  start:"$expected_active_release" | finalize:"$candidate_release" | recover:"$expected_active_release" | recover:"$candidate_release") ;;
  *) fail 'active release is incompatible with the requested bootstrap operation' ;;
esac

compose_with() {
  definition=$1
  release_file=$2
  shift 2
  docker compose --project-name phub-staging \
    --env-file "$app_root/infrastructure.env" \
    --env-file "$release_file" \
    -f "$definition" "$@"
}

compose() {
  compose_with "$app_root/compose.yaml" "$app_root/release.env" "$@"
}

project_container_id() {
  service=$1
  ids=$(docker ps --filter label=com.docker.compose.project=phub-staging \
    --filter "label=com.docker.compose.service=$service" --format '{{.ID}}')
  test "$(printf '%s\n' "$ids" | awk 'NF { count += 1 } END { print count + 0 }')" -eq 1 ||
    fail "$service must have exactly one running container"
  printf '%s' "$ids"
}

container_health() {
  container=$1
  service=$2
  test "$(docker inspect --format '{{.State.Health.Status}}' "$container")" = healthy || fail "$service is not healthy"
}

container_image_id() {
  value=$(docker inspect --format '{{.Image}}' "$1")
  printf '%s' "$value" | grep -Eq '^sha256:[0-9a-f]{64}$' || fail 'container image ID is malformed'
  printf '%s' "$value"
}

container_image_ref() {
  value=$(docker inspect --format '{{.Config.Image}}' "$1")
  printf '%s' "$value" | grep -Eq '^ghcr\.io/[A-Za-z0-9._/-]+@sha256:[0-9a-f]{64}$' || fail 'container image reference is malformed'
  printf '%s' "$value"
}

image_ref_from() {
  release_file=$1
  service=$2
  upper=$(printf '%s' "$service" | tr '[:lower:]' '[:upper:]')
  printf '%s/phub-%s@%s' "$(env_value "$release_file" REGISTRY)" "$service" "$(env_value "$release_file" "${upper}_IMAGE_DIGEST")"
}

wait_service() {
  service=$1
  expected_ref=$2
  expected_id=$3
  attempt=0
  while test "$attempt" -lt 36; do
    ids=$(docker ps --filter label=com.docker.compose.project=phub-staging \
      --filter "label=com.docker.compose.service=$service" --format '{{.ID}}' 2>/dev/null || true)
    if test "$(printf '%s\n' "$ids" | awk 'NF { count += 1 } END { print count + 0 }')" -eq 1 &&
      test "$(docker inspect --format '{{.State.Health.Status}}' "$ids" 2>/dev/null || true)" = healthy &&
      test "$(docker inspect --format '{{.Config.Image}}' "$ids" 2>/dev/null || true)" = "$expected_ref" &&
      test "$(docker inspect --format '{{.Image}}' "$ids" 2>/dev/null || true)" = "$expected_id"; then
      printf '%s' "$ids"
      return 0
    fi
    attempt=$((attempt + 1))
    sleep 5
  done
  fail "$service did not converge to the exact healthy image within 180 seconds"
}

nginx_id() {
  ids=$(docker compose --env-file "$app_root/infrastructure.env" -f "$app_root/compose.infrastructure.yaml" ps --status running -q nginx)
  test "$(printf '%s\n' "$ids" | awk 'NF { count += 1 } END { print count + 0 }')" -eq 1 || fail 'Nginx must have one running container'
  printf '%s' "$ids"
}

caddy_id() {
  ids=$(docker compose -f "$app_root/tls-ingress/compose.yaml" ps --status running -q caddy)
  test "$(printf '%s\n' "$ids" | awk 'NF { count += 1 } END { print count + 0 }')" -eq 1 || fail 'Caddy must have one running container'
  printf '%s' "$ids"
}

runtime_snapshot() {
  for service in web api worker realtime; do
    id=$(project_container_id "$service")
    printf '%s|%s|%s|%s|%s\n' "$service" "$id" "$(container_image_id "$id")" \
      "$(container_image_ref "$id")" "$(docker inspect --format '{{.State.StartedAt}}' "$id")"
  done | sha256sum | cut -d ' ' -f 1
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
  api=$1
  worker=$2
  realtime=$3
  for container in "$api" "$worker"; do
    for key in PROFILE_PHOTO_CLIENT_SYNC_ENABLED COMMUNITY_INVITES_ENABLED COMMUNITIES_REALTIME_ENABLED COMMUNITY_MEDIA_ENABLED COMMUNITY_LOGO_STABLE_DELIVERY_ENABLED COMMUNITY_LOGO_COMPATIBILITY_BACKFILL_ENABLED; do
      running_flag_disabled "$container" "$key"
    done
  done
  running_flag_disabled "$realtime" COMMUNITIES_REALTIME_ENABLED
}

assert_no_secret_shadowing() {
  for file in "$app_root/staging.auth.env" "$app_root/staging.override.env" "$app_root/staging.games.env" "$app_root/staging.communities.env"; do
    if test -e "$file" || test -L "$file"; then
      test -f "$file" && test ! -L "$file" || fail "runtime override is unsafe: $file"
      grep -Eq '^[[:space:]]*(JWT_REALTIME_SECRET|COMMUNITIES_REALTIME_ENABLED)[[:space:]]*=' "$file" &&
        fail "runtime-secret settings are shadowed in $file"
    fi
  done
}

helper_script="$bundle_path/provision-runtime-secret-files.mjs"
helper_image=''

resolve_helper_image() {
  test -z "$helper_image" || return 0
  active_copy="$bundle_path/active-release.env"
  test -f "$active_copy" && test ! -L "$active_copy" || fail 'durable active release copy is absent'
  old_api_ref=$(image_ref_from "$active_copy" api)
  helper_image=$(docker image inspect --format '{{.Id}}' "$old_api_ref")
  printf '%s' "$helper_image" | grep -Eq '^sha256:[0-9a-f]{64}$' || fail 'helper image ID is malformed'
}

helper_raw() {
  resolve_helper_image
  docker run --rm -i --pull=never --entrypoint node --user 0:0 --network none --read-only \
    --tmpfs /tmp:rw,noexec,nosuid,nodev,size=1m --security-opt no-new-privileges \
    --cap-drop ALL --cap-add CHOWN --memory 128m --pids-limit 64 \
    --mount type=bind,src="$secret_root",dst=/target,rw \
    --mount type=bind,src="$bundle_path",dst=/bundle,ro \
    "$helper_image" --input-type=module - "$@" < "$helper_script"
}

run_helper() {
  mode=$1
  shift
  output=$(helper_raw "$mode" /target "$@") || fail "helper operation $mode failed"
  test "$(printf '%s\n' "$output" | wc -l | tr -d ' ')" -eq 1 || fail "helper operation $mode returned ambiguous output"
  printf '%s\n' "$output" | grep -Eq "^runtime-secret-transition operation=${mode} result=[a-z-]+ status=passed$" ||
    fail "helper operation $mode did not acknowledge completion"
}

state_field() {
  field=$1
  output=$(helper_raw read-bootstrap-field /target "$field") || fail "cannot read bootstrap field $field"
  prefix="runtime-secret-transition field=$field value="
  suffix=' status=passed'
  case "$output" in "$prefix"*"$suffix") ;; *) fail "bootstrap field $field is malformed" ;; esac
  value=${output#"$prefix"}
  value=${value%"$suffix"}
  test -n "$value" || fail "bootstrap field $field is empty"
  printf '%s' "$value"
}

finalized_field() {
  field=$1
  output=$(helper_raw read-bootstrap-finalized-field /target "$field") || fail "cannot read finalized bootstrap field $field"
  prefix="runtime-secret-transition field=$field value="
  suffix=' status=passed'
  case "$output" in "$prefix"*"$suffix") ;; *) fail "finalized bootstrap field $field is malformed" ;; esac
  value=${output#"$prefix"}
  value=${value%"$suffix"}
  test -n "$value" || fail "finalized bootstrap field $field is empty"
  printf '%s' "$value"
}

recover_marker_if_needed() {
  if test -e "$marker_next" || test -L "$marker_next"; then
    run_helper recover-marker
  fi
}

assert_marker_identity() {
  test "$(state_field expectedActiveRelease)" = "$expected_active_release" || fail 'marker active release differs'
  test "$(state_field candidateRelease)" = "$candidate_release" || fail 'marker candidate release differs'
  test "$(state_field controlCommit)" = "$control_commit" || fail 'marker control commit differs'
  test "$(state_field workflowRunId)" = "$workflow_run_id" || fail 'marker workflow run ID differs'
  test "$(state_field workflowRunAttempt)" = "$workflow_run_attempt" || fail 'marker workflow attempt differs'
  test "$(state_field bundlePath)" = "$bundle_path" || fail 'marker bundle path differs'
}

assert_finalized_identity() {
  test "$(finalized_field expectedActiveRelease)" = "$expected_active_release" || fail 'finalized receipt active release differs'
  test "$(finalized_field candidateRelease)" = "$candidate_release" || fail 'finalized receipt candidate release differs'
  test "$(finalized_field controlCommit)" = "$control_commit" || fail 'finalized receipt control commit differs'
  test "$(finalized_field workflowRunId)" = "$workflow_run_id" || fail 'finalized receipt workflow run ID differs'
  test "$(finalized_field workflowRunAttempt)" = "$workflow_run_attempt" || fail 'finalized receipt workflow attempt differs'
  test "$(finalized_field bundlePath)" = "$bundle_path" || fail 'finalized receipt bundle path differs'
}

assert_definition_hash_combination() {
  compose_sha=$(sha256 "$app_root/compose.yaml")
  release_sha=$(sha256 "$app_root/release.env")
  active_compose=$(state_field hashes.activeCompose)
  candidate_compose=$(state_field hashes.candidateCompose)
  active_release_env=$(state_field hashes.activeReleaseEnv)
  candidate_release_env=$(state_field hashes.candidateReleaseEnv)
  case "$compose_sha:$release_sha" in
    "$active_compose:$active_release_env" | "$candidate_compose:$active_release_env" | "$candidate_compose:$candidate_release_env" | "$active_compose:$candidate_release_env") ;;
    *) fail 'active definitions do not match any recorded crash-safe combination' ;;
  esac
}

atomic_install() {
  source=$1
  next=$2
  destination=$3
  test ! -e "$next" && test ! -L "$next" || fail "definition next file already exists: $next"
  install -m 600 "$source" "$next"
  sync_path "$next"
  mv "$next" "$destination"
  sync_path "$destination"
}

stage_definition() {
  source=$1
  next=$2
  test ! -e "$next" && test ! -L "$next" || fail "definition next file already exists: $next"
  install -m 600 "$source" "$next"
  sync_path "$next"
}

stop_runtime() {
  ids=''
  for service in api realtime worker web; do
    found=$(docker ps --filter label=com.docker.compose.project=phub-staging \
      --filter "label=com.docker.compose.service=$service" --format '{{.ID}}')
    test "$(printf '%s\n' "$found" | awk 'NF { count += 1 } END { print count + 0 }')" -le 1 || fail "$service has multiple running containers"
    test -z "$found" || ids="$ids $found"
  done
  test -z "$ids" || docker stop -t 30 $ids >/dev/null
}

attest_service() {
  service=$1
  side=$2
  expected_ref=$(state_field "${side}Images.${service}.ref")
  expected_id=$(state_field "${side}Images.${service}.id")
  id=$(project_container_id "$service")
  container_health "$id" "$service"
  test "$(container_image_ref "$id")" = "$expected_ref" || fail "$service image reference differs"
  test "$(container_image_id "$id")" = "$expected_id" || fail "$service image ID differs"
  printf '%s' "$id"
}

attest_infrastructure_unchanged() {
  test "$(nginx_id)" = "$(state_field infrastructureContainers.nginxId)" || fail 'Nginx changed during bootstrap'
  test "$(caddy_id)" = "$(state_field infrastructureContainers.caddyId)" || fail 'Caddy changed during bootstrap'
  test "$(sha256 "$app_root/compose.infrastructure.yaml")" = "$(state_field hashes.infrastructureCompose)" || fail 'infrastructure Compose changed'
  test "$(stat -c '%d:%i:%s:%Y' "$app_root/infrastructure.env")" = "$(state_field infrastructureIdentity)" || fail 'infrastructure environment identity changed'
}

attest_finalized_service() {
  service=$1
  expected_ref=$(finalized_field "candidateImages.${service}.ref")
  expected_id=$(finalized_field "candidateImages.${service}.id")
  id=$(project_container_id "$service")
  container_health "$id" "$service"
  test "$(container_image_ref "$id")" = "$expected_ref" || fail "$service finalized image reference differs"
  test "$(container_image_id "$id")" = "$expected_id" || fail "$service finalized image ID differs"
}

attest_finalized_infrastructure() {
  test "$(nginx_id)" = "$(finalized_field infrastructureContainers.nginxId)" || fail 'Nginx changed after bootstrap finalization'
  test "$(caddy_id)" = "$(finalized_field infrastructureContainers.caddyId)" || fail 'Caddy changed after bootstrap finalization'
  test "$(sha256 "$app_root/compose.infrastructure.yaml")" = "$(finalized_field hashes.infrastructureCompose)" || fail 'infrastructure Compose changed after finalization'
  test "$(stat -c '%d:%i:%s:%Y' "$app_root/infrastructure.env")" = "$(finalized_field infrastructureIdentity)" || fail 'infrastructure environment changed after finalization'
}

attest_finalized_bootstrap() {
  test -f "$finalized_receipt" && test ! -L "$finalized_receipt" || fail 'finalized bootstrap receipt is absent or unsafe'
  test ! -e "$marker" && test ! -L "$marker" || fail 'bootstrap marker coexists with finalized receipt'
  assert_finalized_identity
  test "$(sha256 "$app_root/compose.yaml")" = "$(finalized_field hashes.candidateCompose)" || fail 'finalized candidate Compose changed'
  test "$(sha256 "$app_root/release.env")" = "$(finalized_field hashes.candidateReleaseEnv)" || fail 'finalized candidate release.env changed'
  for service in realtime api worker web; do attest_finalized_service "$service"; done
  attest_finalized_infrastructure
  assert_flags_disabled "$(project_container_id api)" "$(project_container_id worker)" "$(project_container_id realtime)"
  test "$(runtime_snapshot)" = "$(finalized_field finalSnapshot)" || fail 'finalized serving runtime snapshot differs'
  verify_public_release "$candidate_release"
  run_helper verify-bootstrap-finalized
}

verify_public_release() {
  expected=$1
  manifest=$(curl --fail --silent --show-error --connect-timeout 2 --max-time 15 \
    --resolve lk.nano.padlhub.su:443:127.0.0.1 https://lk.nano.padlhub.su/manifest.json)
  printf '%s' "$manifest" | docker run --rm -i --pull=never --network none --read-only \
    --cap-drop ALL --security-opt no-new-privileges --entrypoint node "$helper_image" -e '
      let input = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", chunk => { input += chunk; });
      process.stdin.on("end", () => {
        try { if (JSON.parse(input).release !== process.argv[1]) process.exit(1); }
        catch { process.exit(1); }
      });
    ' "$expected" || fail 'public manifest release differs'
}

restore_definitions() {
  backup_path=$(state_field backupPath)
  test -f "$backup_path/backup.complete" && test ! -L "$backup_path/backup.complete" || fail 'application backup is absent'
  test "$(sha256 "$backup_path/backup.complete")" = "$(state_field hashes.applicationBackup)" || fail 'application backup identity differs'
  test "$(sha256 "$backup_path/compose.yaml")" = "$(state_field hashes.activeCompose)" || fail 'saved active Compose differs'
  test "$(sha256 "$backup_path/release.env")" = "$(state_field hashes.activeReleaseEnv)" || fail 'saved active release.env differs'
  assert_definition_hash_combination
  rm -f "$compose_next" "$release_next"
  atomic_install "$backup_path/compose.yaml" "$compose_next" "$app_root/compose.yaml"
  atomic_install "$backup_path/release.env" "$release_next" "$app_root/release.env"
}

restore_bootstrap() {
  recover_marker_if_needed
  if test ! -e "$marker" && test ! -L "$marker" && { test -e "$finalized_receipt" || test -L "$finalized_receipt"; }; then
    attest_finalized_bootstrap
    printf '%s\n' 'legacy_runtime_secret_bootstrap operation=recover action=already-finalized status=passed'
    return
  fi
  test -f "$marker" && test ! -L "$marker" || fail 'recoverable bootstrap marker is absent'
  assert_marker_identity
  phase=$(state_field phase)
  case "$phase" in
    verified | finalizing | finalized)
      attest_service realtime candidate >/dev/null
      attest_service api candidate >/dev/null
      attest_service worker candidate >/dev/null
      attest_service web candidate >/dev/null
      attest_infrastructure_unchanged
      verify_public_release "$candidate_release"
      run_helper finalize-bootstrap "$(runtime_snapshot)"
      printf '%s\n' 'legacy_runtime_secret_bootstrap operation=recover action=finalize-forward status=passed'
      return
      ;;
    initial | files-prepared | images-probed)
      test "$(sha256 "$app_root/compose.yaml")" = "$(state_field hashes.activeCompose)" ||
        fail 'pre-runtime recovery found a changed active Compose definition'
      test "$(sha256 "$app_root/release.env")" = "$(state_field hashes.activeReleaseEnv)" ||
        fail 'pre-runtime recovery found a changed active release definition'
      test "$(runtime_snapshot)" = "$(state_field hashes.runtimeSnapshot)" ||
        fail 'pre-runtime recovery found a changed serving runtime'
      if test -e "$compose_next" || test -L "$compose_next"; then
        test -f "$compose_next" && test ! -L "$compose_next" || fail 'candidate Compose next file is unsafe'
        test "$(sha256 "$compose_next")" = "$(state_field hashes.candidateCompose)" || fail 'candidate Compose next file differs'
        rm -f "$compose_next"
      fi
      if test -e "$release_next" || test -L "$release_next"; then
        test -f "$release_next" && test ! -L "$release_next" || fail 'candidate release next file is unsafe'
        test "$(sha256 "$release_next")" = "$(state_field hashes.candidateReleaseEnv)" || fail 'candidate release next file differs'
        rm -f "$release_next"
      fi
      run_helper restore-bootstrap-files
      test "$(runtime_snapshot)" = "$(state_field hashes.runtimeSnapshot)" ||
        fail 'serving runtime changed during files-only recovery'
      attest_infrastructure_unchanged
      run_helper advance-bootstrap-phase files-restored runtime-restored
      run_helper complete-bootstrap-rollback
      printf '%s\n' 'legacy_runtime_secret_bootstrap operation=recover action=files-only-rollback status=passed'
      return
      ;;
  esac
  stop_runtime
  restore_definitions
  run_helper restore-bootstrap-files
  # The old access-key ticket protocol requires old realtime before old API.
  old_realtime_ref=$(state_field oldImages.realtime.ref)
  old_realtime_id=$(state_field oldImages.realtime.id)
  compose up -d --no-deps --force-recreate --pull never realtime
  wait_service realtime "$old_realtime_ref" "$old_realtime_id" >/dev/null
  old_api_ref=$(state_field oldImages.api.ref)
  old_api_id=$(state_field oldImages.api.id)
  compose up -d --no-deps --force-recreate --pull never api
  wait_service api "$old_api_ref" "$old_api_id" >/dev/null
  old_worker_ref=$(state_field oldImages.worker.ref)
  old_worker_id=$(state_field oldImages.worker.id)
  compose up -d --no-deps --force-recreate --pull never worker
  wait_service worker "$old_worker_ref" "$old_worker_id" >/dev/null
  old_web_ref=$(state_field oldImages.web.ref)
  old_web_id=$(state_field oldImages.web.id)
  compose up -d --no-deps --force-recreate --pull never web
  wait_service web "$old_web_ref" "$old_web_id" >/dev/null
  assert_flags_disabled "$(project_container_id api)" "$(project_container_id worker)" "$(project_container_id realtime)"
  attest_infrastructure_unchanged
  verify_public_release "$expected_active_release"
  run_helper advance-bootstrap-phase files-restored runtime-restored
  run_helper complete-bootstrap-rollback
  rm -f "$compose_next" "$release_next"
  printf '%s\n' 'legacy_runtime_secret_bootstrap operation=recover action=rollback status=passed'
}

if test "$operation" = recover; then
  restore_bootstrap
  exit 0
fi

recover_marker_if_needed
if test "$operation" = finalize; then
  if test ! -e "$marker" && test ! -L "$marker" && { test -e "$finalized_receipt" || test -L "$finalized_receipt"; }; then
    attest_finalized_bootstrap
    printf '%s\n' "legacy_runtime_secret_bootstrap operation=finalize release=$candidate_release status=already-finalized"
    exit 0
  fi
  test -f "$marker" && test ! -L "$marker" || fail 'bootstrap marker is absent'
  assert_marker_identity
  test "$(state_field phase)" = web-ready || fail 'bootstrap is not awaiting final attestation'
  attest_service realtime candidate >/dev/null
  attest_service api candidate >/dev/null
  attest_service worker candidate >/dev/null
  attest_service web candidate >/dev/null
  attest_infrastructure_unchanged
  assert_flags_disabled "$(project_container_id api)" "$(project_container_id worker)" "$(project_container_id realtime)"
  test "$(sha256 "$app_root/compose.yaml")" = "$(state_field hashes.candidateCompose)" || fail 'candidate Compose changed'
  test "$(sha256 "$app_root/release.env")" = "$(state_field hashes.candidateReleaseEnv)" || fail 'candidate release.env changed'
  verify_public_release "$candidate_release"
  run_helper advance-bootstrap-phase web-ready verified
  run_helper finalize-bootstrap "$(runtime_snapshot)"
  rm -f "$compose_next" "$release_next"
  printf '%s\n' "legacy_runtime_secret_bootstrap operation=finalize release=$candidate_release status=passed"
  exit 0
fi

for path in "$marker" "$marker_next" "$compose_next" "$release_next" "$finalized_receipt"; do
  test ! -e "$path" && test ! -L "$path" || fail "unresolved transition artifact exists: $path"
done
test "$(stat -c '%u:%g:%a' "$secret_root")" = "0:$(id -g phub-deploy):750" || fail 'secret root ownership or mode differs'
test "$(stat -c '%h:%u:%g:%a' "$secret_root/staging.env")" = "1:0:$(id -g phub-deploy):600" || fail 'staging.env metadata differs'
test "$(df -Pk "$secret_root" | awk 'NR == 2 { print $4 }')" -ge 65536 || fail 'secret filesystem lacks block headroom'
test "$(df -Pi "$secret_root" | awk 'NR == 2 { print $4 }')" -ge 128 || fail 'secret filesystem lacks inode headroom'
assert_no_secret_shadowing

old_nginx=$(nginx_id)
old_caddy=$(caddy_id)
old_runtime_snapshot=$(runtime_snapshot)
for service in web api worker realtime; do
  container=$(project_container_id "$service")
  container_health "$container" "$service"
  expected_ref=$(image_ref_from "$app_root/release.env" "$service")
  test "$(container_image_ref "$container")" = "$expected_ref" || fail "$service does not match active release.env"
  docker image inspect "$expected_ref" >/dev/null 2>&1 || fail "old $service image is not local"
done
assert_flags_disabled "$(project_container_id api)" "$(project_container_id worker)" "$(project_container_id realtime)"

candidate_release_file="$bundle_path/candidate-release.env"
active_release_copy="$bundle_path/active-release.env"
attestation_file="$bundle_path/bootstrap-attestation.json"
for path in "$candidate_release_file" "$active_release_copy" "$attestation_file"; do
  test ! -e "$path" && test ! -L "$path" || fail "durable bundle output already exists: $path"
done
install -m 600 "$app_root/release.env" "$active_release_copy"
sync_path "$active_release_copy"

release_candidate_tmp="$bundle_path/.candidate-release.env.next"
test ! -e "$release_candidate_tmp" && test ! -L "$release_candidate_tmp" || fail 'candidate release next file already exists'
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
  ' "$app_root/release.env" > "$release_candidate_tmp"
chmod 600 "$release_candidate_tmp"
sync_path "$release_candidate_tmp"
mv "$release_candidate_tmp" "$candidate_release_file"
sync_path "$candidate_release_file"
require_release_shape "$candidate_release_file"
test "$(env_value "$candidate_release_file" RELEASE)" = "$candidate_release" || fail 'candidate release file has wrong SHA'
test "$(env_value "$candidate_release_file" LATEST_MIGRATION)" = "$(env_value "$app_root/release.env" LATEST_MIGRATION)" || fail 'B0 may not change latest migration'

RUNTIME_ENV_FILE="$secret_root/staging.env" REALTIME_RUNTIME_ENV_FILE="$secret_root/staging.env" \
  compose_with "$bundle_path/compose.staging.yaml" "$candidate_release_file" --profile migration config --quiet
candidate_images=$(RUNTIME_ENV_FILE="$secret_root/staging.env" REALTIME_RUNTIME_ENV_FILE="$secret_root/staging.env" \
  compose_with "$bundle_path/compose.staging.yaml" "$candidate_release_file" --profile migration config --images)
test "$(printf '%s\n' "$candidate_images" | sed '/^$/d' | wc -l | tr -d ' ')" -eq 5 || fail 'candidate Compose must resolve exactly five images'
for service in web api worker realtime migrator; do
  ref=$(image_ref_from "$candidate_release_file" "$service")
  printf '%s\n' "$candidate_images" | grep -Fxq "$ref" || fail "candidate Compose does not bind $service digest"
  docker pull "$ref" >/dev/null
done

backup_path="$backup_root/pre-b0-$workflow_run_id-$workflow_run_attempt"
PHUB_BACKUP_ROOT="$backup_root" sh "$bundle_path/backup-application.sh" "$backup_path" BACKUP_STAGING_RELEASE
PHUB_ROLLBACK_BACKUP_ROOT="$backup_root" sh "$bundle_path/rollback-application.sh" "$backup_path" --validate-only
test -f "$backup_path/backup.complete" && test ! -L "$backup_path/backup.complete" || fail 'application backup is incomplete'

deploy_uid=$(id -u phub-deploy)
deploy_gid=$(id -g phub-deploy)
control_tree=$(cat "$bundle_path/control-tree")
candidate_tree=$(cat "$bundle_path/candidate-tree")
for value in "$control_tree" "$candidate_tree"; do printf '%s' "$value" | grep -Eq '^[0-9a-f]{40}$' || fail 'recorded tree is malformed'; done

json_image_map() {
  release_file=$1
  shift
  first=true
  printf '{'
  for service in "$@"; do
    ref=$(image_ref_from "$release_file" "$service")
    id=$(docker image inspect --format '{{.Id}}' "$ref")
    $first || printf ','
    first=false
    printf '"%s":{"id":"%s","ref":"%s"}' "$service" "$id" "$ref"
  done
  printf '}'
}

json_old_containers() {
  first=true
  printf '{'
  for service in api worker realtime web; do
    id=$(project_container_id "$service")
    started=$(docker inspect --format '{{.State.StartedAt}}' "$id")
    printf '%s' "$started" | grep -Eq '^[0-9TZ:.-]{20,64}$' || fail 'container StartedAt is malformed'
    $first || printf ','
    first=false
    printf '"%s":{"id":"%s","startedAt":"%s"}' "$service" "$id" "$started"
  done
  printf '}'
}

{
  printf '{'
  printf '"expectedActiveRelease":"%s",' "$expected_active_release"
  printf '"candidateRelease":"%s",' "$candidate_release"
  printf '"controlCommit":"%s",' "$control_commit"
  printf '"controlTree":"%s",' "$control_tree"
  printf '"candidateTree":"%s",' "$candidate_tree"
  printf '"workflowRunId":"%s","workflowRunAttempt":"%s",' "$workflow_run_id" "$workflow_run_attempt"
  printf '"backupPath":"%s","bundlePath":"%s",' "$backup_path" "$bundle_path"
  printf '"infrastructureIdentity":"%s",' "$(stat -c '%d:%i:%s:%Y' "$app_root/infrastructure.env")"
  printf '"hashes":{'
  printf '"runtimeSnapshot":"%s",' "$old_runtime_snapshot"
  printf '"activeCompose":"%s","candidateCompose":"%s",' "$(sha256 "$app_root/compose.yaml")" "$(sha256 "$bundle_path/compose.staging.yaml")"
  printf '"activeReleaseEnv":"%s","candidateReleaseEnv":"%s",' "$(sha256 "$app_root/release.env")" "$(sha256 "$candidate_release_file")"
  printf '"infrastructureCompose":"%s",' "$(sha256 "$app_root/compose.infrastructure.yaml")"
  manifest_sha=$(sha256 "$bundle_path/migrations.manifest")
  printf '"activeMigrationManifest":"%s","candidateMigrationManifest":"%s",' "$manifest_sha" "$manifest_sha"
  printf '"applicationBackup":"%s"},' "$(sha256 "$backup_path/backup.complete")"
  printf '"oldImages":%s,' "$(json_image_map "$app_root/release.env" api worker realtime web)"
  printf '"candidateImages":%s,' "$(json_image_map "$candidate_release_file" api worker realtime web migrator)"
  printf '"oldContainers":%s,' "$(json_old_containers)"
  printf '"infrastructureContainers":{"nginxId":"%s","caddyId":"%s"}' "$old_nginx" "$old_caddy"
  printf '}\n'
} > "$attestation_file"
chmod 600 "$attestation_file"
sync_path "$attestation_file"

on_error() {
  status=$?
  trap - EXIT HUP INT TERM
  if test -e "$marker" || test -L "$marker" || test -e "$marker_next" || test -L "$marker_next"; then
    restore_bootstrap || printf '%s\n' 'legacy_runtime_secret_bootstrap rollback=failed marker=retained' >&2
  fi
  exit "$status"
}
trap on_error EXIT HUP INT TERM
helper_image=$(docker image inspect --format '{{.Id}}' "$(image_ref_from "$app_root/release.env" api)")
run_helper prepare-bootstrap-json "$deploy_uid" "$deploy_gid" /bundle/bootstrap-attestation.json
run_helper verify-bootstrap-prepared
maybe_fail files-prepared

probe_dir=$(mktemp -d /tmp/phub-b0-probe.XXXXXX)
chmod 700 "$probe_dir"
cleanup_probe() { rm -f "$probe_dir/tickets.json"; rmdir "$probe_dir" 2>/dev/null || true; }
trap 'cleanup_probe; on_error' EXIT HUP INT TERM
candidate_api_ref=$(image_ref_from "$candidate_release_file" api)
candidate_realtime_ref=$(image_ref_from "$candidate_release_file" realtime)
docker run --rm --pull=never --network none --read-only --user "$deploy_uid:$deploy_gid" \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=1m --cap-drop ALL --security-opt no-new-privileges \
  --memory 128m --pids-limit 64 \
  --env-file "$secret_root/staging.env" --mount type=bind,src="$probe_dir",dst=/probe,rw \
  --entrypoint node "$candidate_api_ref" --input-type=module -e '
    import { SignJWT } from "jose";
    import { loadApiConfig } from "@phub/config";
    const config = loadApiConfig(process.env);
    const encoder = new TextEncoder();
    const claims = { scope: "realtime:connect", tenantId: "00000000-0000-4000-8000-000000000001", tenantKey: "nano", sid: "00000000-0000-4000-8000-000000000002" };
    const base = () => new SignJWT(claims).setProtectedHeader({alg:"HS256",typ:"JWT"}).setIssuer(config.JWT_ISSUER).setAudience(config.JWT_REALTIME_AUDIENCE).setSubject("00000000-0000-4000-8000-000000000003").setJti(crypto.randomUUID()).setExpirationTime("2m");
    const dedicated = await base().sign(encoder.encode(config.JWT_REALTIME_SECRET));
    const access = await base().sign(encoder.encode(config.JWT_ACCESS_SECRET));
    await import("node:fs/promises").then(fs => fs.writeFile("/probe/tickets.json", JSON.stringify({dedicated,access}), {mode:0o600}));
  ' >/dev/null
docker run --rm --pull=never --network none --read-only --user "$deploy_uid:$deploy_gid" \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=1m --cap-drop ALL --security-opt no-new-privileges \
  --memory 128m --pids-limit 64 \
  --env-file "$secret_root/realtime.env" --mount type=bind,src="$probe_dir",dst=/probe,ro \
  --entrypoint node "$candidate_realtime_ref" --input-type=module -e '
    import { readFile } from "node:fs/promises";
    import { jwtVerify } from "jose";
    import { loadRealtimeConfig } from "@phub/config";
    if (process.env.JWT_ACCESS_SECRET || process.env.JWT_REFRESH_SECRET) process.exit(1);
    const config = loadRealtimeConfig(process.env);
    const tickets = JSON.parse(await readFile("/probe/tickets.json", "utf8"));
    const key = new TextEncoder().encode(config.JWT_REALTIME_SECRET);
    await jwtVerify(tickets.dedicated, key, {issuer:config.JWT_ISSUER,audience:config.JWT_REALTIME_AUDIENCE,algorithms:["HS256"]});
    try { await jwtVerify(tickets.access, key, {issuer:config.JWT_ISSUER,audience:config.JWT_REALTIME_AUDIENCE,algorithms:["HS256"]}); process.exit(1); } catch {}
  ' >/dev/null
cleanup_probe
trap on_error EXIT HUP INT TERM
run_helper advance-bootstrap-phase files-prepared images-probed
maybe_fail images-probed

stage_definition "$bundle_path/compose.staging.yaml" "$compose_next"
stage_definition "$candidate_release_file" "$release_next"
stop_runtime
run_helper advance-bootstrap-phase images-probed runtime-stopped
maybe_fail runtime-stopped
mv "$compose_next" "$app_root/compose.yaml"
sync_path "$app_root/compose.yaml"
run_helper advance-bootstrap-phase runtime-stopped compose-committed
maybe_fail compose-committed
mv "$release_next" "$app_root/release.env"
sync_path "$app_root/release.env"
run_helper advance-bootstrap-phase compose-committed release-committed
maybe_fail release-committed

compose up -d --no-deps --force-recreate --pull never realtime
wait_service realtime "$(state_field candidateImages.realtime.ref)" "$(state_field candidateImages.realtime.id)" >/dev/null
run_helper advance-bootstrap-phase release-committed realtime-ready
maybe_fail realtime-ready
compose up -d --no-deps --force-recreate --pull never api
wait_service api "$(state_field candidateImages.api.ref)" "$(state_field candidateImages.api.id)" >/dev/null
run_helper advance-bootstrap-phase realtime-ready api-ready
maybe_fail api-ready
compose up -d --no-deps --force-recreate --pull never worker
wait_service worker "$(state_field candidateImages.worker.ref)" "$(state_field candidateImages.worker.id)" >/dev/null
run_helper advance-bootstrap-phase api-ready worker-ready
maybe_fail worker-ready
compose up -d --no-deps --force-recreate --pull never web
wait_service web "$(state_field candidateImages.web.ref)" "$(state_field candidateImages.web.id)" >/dev/null
run_helper advance-bootstrap-phase worker-ready web-ready
maybe_fail web-ready
assert_flags_disabled "$(project_container_id api)" "$(project_container_id worker)" "$(project_container_id realtime)"
attest_infrastructure_unchanged
verify_public_release "$candidate_release"
run_helper verify-bootstrap-prepared
trap - EXIT HUP INT TERM
printf '%s\n' "legacy_runtime_secret_bootstrap operation=start release=$candidate_release status=awaiting-authenticated-attestation"
