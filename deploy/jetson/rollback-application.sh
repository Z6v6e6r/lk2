#!/bin/sh

set -eu

fail() {
  printf '%s\n' "Application rollback refused: $*" >&2
  exit 1
}

if [ "$#" -ne 2 ]; then
  fail 'usage: rollback-application.sh <saved-release-directory> <--validate-only|--confirm=ROLLBACK_STAGING_RELEASE>'
fi
case "$2" in
  --validate-only) operation=validate ;;
  --confirm=ROLLBACK_STAGING_RELEASE) operation=rollback ;;
  *)
    fail 'usage: rollback-application.sh <saved-release-directory> <--validate-only|--confirm=ROLLBACK_STAGING_RELEASE>'
    ;;
esac

app_root="${PHUB_ROLLBACK_APP_ROOT:-/opt/phub}"
backup_root="${PHUB_ROLLBACK_BACKUP_ROOT:-$app_root/backups}"
health_attempts="${PHUB_ROLLBACK_HEALTH_ATTEMPTS:-36}"
health_delay_seconds="${PHUB_ROLLBACK_HEALTH_DELAY_SECONDS:-5}"
require_compatible_worker="${PHUB_ROLLBACK_REQUIRE_COMPATIBLE_WORKER:-false}"

case "$app_root" in
  /*) ;;
  *) fail 'application root must be an absolute path' ;;
esac
[ "$app_root" != / ] || fail 'application root cannot be /'
case "$backup_root" in
  /*) ;;
  *) fail 'backup root must be an absolute path' ;;
esac
case "$health_attempts" in
  '' | *[!0-9]* | 0) fail 'health attempts must be a positive integer' ;;
esac
case "$health_delay_seconds" in
  '' | *[!0-9]*) fail 'health delay must be a non-negative integer' ;;
esac
case "$require_compatible_worker" in
  true | false) ;;
  *) fail 'PHUB_ROLLBACK_REQUIRE_COMPATIBLE_WORKER must be true or false' ;;
esac

[ -d "$app_root" ] || fail 'application root does not exist'
[ -d "$backup_root" ] || fail 'backup root does not exist'
[ -f "$app_root/infrastructure.env" ] && [ ! -L "$app_root/infrastructure.env" ] ||
  fail 'infrastructure.env is absent or unsafe'

app_root="$(cd -P "$app_root" && pwd -P)"
backup_root="$(cd -P "$backup_root" && pwd -P)"
requested_backup="$1"
[ -d "$requested_backup" ] || fail 'saved release directory does not exist'
backup_dir="$(cd -P "$requested_backup" && pwd -P)"
case "$backup_dir" in
  "$backup_root"/*) ;;
  *) fail 'saved release directory must be a child of the configured backup root' ;;
esac

stage_dir="$(mktemp -d "$app_root/.rollback-stage.XXXXXX")"
restore_tmp=''
cleanup() {
  if [ -n "$restore_tmp" ]; then
    rm -f "$restore_tmp"
  fi
  rm -rf "$stage_dir"
}
trap cleanup EXIT HUP INT TERM

stage_file() {
  relative_path="$1"
  required="$2"
  mode="$3"
  source_path="$backup_dir/$relative_path"
  if [ ! -e "$source_path" ]; then
    [ "$required" = optional ] && return 1
    fail "required saved file is absent: $relative_path"
  fi
  [ -f "$source_path" ] && [ ! -L "$source_path" ] ||
    fail "saved file is not a regular non-symlink file: $relative_path"
  source_parent="$(cd -P "$(dirname "$source_path")" && pwd -P)"
  case "$source_parent" in
    "$backup_dir" | "$backup_dir"/*) ;;
    *) fail "saved file escapes the release directory: $relative_path" ;;
  esac
  stage_target="$stage_dir/$relative_path"
  install -d -m 700 "$(dirname "$stage_target")"
  install -m "$mode" "$source_path" "$stage_target"
}

stage_file compose.yaml required 600
stage_file release.env required 600
stage_file nginx/default.conf required 644
stage_file staging.auth.env required 600
stage_file tls-ingress/Caddyfile required 644
stage_file process-state.env required 600
stage_file backup.complete required 600
if stage_file worker-capabilities.env optional 600; then
  worker_capabilities_present=true
else
  worker_capabilities_present=false
fi
if stage_file staging.override.env optional 600; then
  override_state=present
else
  stage_file staging.override.env.absent required 600
  [ ! -s "$stage_dir/staging.override.env.absent" ] ||
    fail 'staging.override.env.absent marker must be empty'
  override_state=absent
fi
if stage_file staging.communities.env optional 600; then
  communities_state=present
else
  stage_file staging.communities.env.absent required 600
  [ ! -s "$stage_dir/staging.communities.env.absent" ] ||
    fail 'staging.communities.env.absent marker must be empty'
  communities_state=absent
fi
if stage_file staging.games.env optional 600; then
  games_state=present
else
  stage_file staging.games.env.absent required 600
  [ ! -s "$stage_dir/staging.games.env.absent" ] ||
    fail 'staging.games.env.absent marker must be empty'
  games_state=absent
fi
[ ! -e "$backup_dir/staging.override.env" ] || [ "$override_state" = present ] ||
  fail 'saved runtime override state is ambiguous'
[ ! -e "$backup_dir/staging.override.env.absent" ] || [ "$override_state" = absent ] ||
  fail 'saved runtime override state is ambiguous'
[ ! -e "$backup_dir/staging.communities.env" ] || [ "$communities_state" = present ] ||
  fail 'saved Communities runtime state is ambiguous'
[ ! -e "$backup_dir/staging.communities.env.absent" ] || [ "$communities_state" = absent ] ||
  fail 'saved Communities runtime state is ambiguous'
[ ! -e "$backup_dir/staging.games.env" ] || [ "$games_state" = present ] ||
  fail 'saved Games runtime state is ambiguous'
[ ! -e "$backup_dir/staging.games.env.absent" ] || [ "$games_state" = absent ] ||
  fail 'saved Games runtime state is ambiguous'

process_state_value() {
  process_key="$1"
  process_count="$(awk -F= -v key="$process_key" '$1 == key { count += 1 } END { print count + 0 }' "$stage_dir/process-state.env")"
  [ "$process_count" -eq 1 ] || fail "process-state.env must contain exactly one $process_key"
  process_value="$(sed -n "s/^${process_key}=//p" "$stage_dir/process-state.env")"
  case "$process_value" in
    running | stopped) printf '%s' "$process_value" ;;
    *) fail "process-state.env contains an invalid $process_key state" ;;
  esac
}

web_state="$(process_state_value WEB)"
api_state="$(process_state_value API)"
worker_state="$(process_state_value WORKER)"
realtime_state="$(process_state_value REALTIME)"
[ "$web_state" = running ] && [ "$api_state" = running ] ||
  fail 'saved process state must keep web and api running'
[ "$(wc -l < "$stage_dir/process-state.env" | tr -d ' ')" -eq 4 ] ||
  fail 'process-state.env must contain exactly four lines'

release_env="$stage_dir/release.env"
LC_ALL=C awk '
  function diagnostic_key(line, equals, key) {
    equals = index(line, "=")
    if (equals <= 1) return "NO_KEY"
    key = substr(line, 1, equals - 1)
    if (key ~ /^[A-Z][A-Z0-9_]*$/) return key
    return "UNSAFE_KEY"
  }

  /^[[:space:]]*$/ { next }
  /^#/ { next }
  /^[A-Z][A-Z0-9_]*=[ -~]*$/ { next }
  {
    invalid = 1
    printf "release_env_invalid line=%d key=%s length=%d\n", NR, diagnostic_key($0), length($0)
  }
  END { exit invalid }
' "$release_env" >&2 || fail 'saved release.env contains an unsafe line'

release_value() {
  release_key="$1"
  release_count="$(awk -F= -v key="$release_key" '$1 == key { count += 1 } END { print count + 0 }' "$release_env")"
  [ "$release_count" -eq 1 ] || fail "release.env must contain exactly one $release_key"
  sed -n "s/^${release_key}=//p" "$release_env"
}

registry="$(release_value REGISTRY)"
web_digest="$(release_value WEB_IMAGE_DIGEST)"
api_digest="$(release_value API_IMAGE_DIGEST)"
worker_digest="$(release_value WORKER_IMAGE_DIGEST)"
realtime_digest="$(release_value REALTIME_IMAGE_DIGEST)"
migrator_digest="$(release_value MIGRATOR_IMAGE_DIGEST)"
release="$(release_value RELEASE)"
latest_migration="$(release_value LATEST_MIGRATION)"

compatible_worker_id=''
if [ "$require_compatible_worker" = true ]; then
  [ "$worker_capabilities_present" = true ] ||
    fail 'saved release has no worker capability attestation'
  grep -Fxq 'API_CLIENT_MEDIA_ROLLBACK_V1=true' "$stage_dir/worker-capabilities.env" ||
    fail 'saved API is not attested for phub.client-media-rollback.v1'
  grep -Fxq 'WORKER_CLIENT_MEDIA_ROLLBACK_V1=true' "$stage_dir/worker-capabilities.env" ||
    fail 'saved worker is not attested for phub.client-media-rollback.v1'
  [ "$worker_state" = running ] || fail 'saved compatible worker was not running'
  current_compose() {
    docker compose \
      --env-file "$app_root/infrastructure.env" \
      --env-file "$app_root/release.env" \
      -f "$app_root/compose.yaml" \
      "$@"
  }
  compatible_worker_id="$(current_compose ps --status running -q worker)"
  [ -n "$compatible_worker_id" ] || fail 'attested saved worker is not running'
  compatible_worker_image="$(docker inspect --format '{{.Config.Image}}' "$compatible_worker_id")"
  [ "$compatible_worker_image" = "$registry/phub-worker@$worker_digest" ] ||
    fail 'running worker does not match the attested saved digest'
  if ! docker exec "$compatible_worker_id" node -e '
    const code = require("node:fs").readFileSync("/app/apps/worker/dist/main.js", "utf8");
    process.exit(code.includes("phub.client-media-rollback.v1") ? 0 : 1);
  '; then
    fail 'attested worker does not provide phub.client-media-rollback.v1'
  fi
fi

printf '%s' "$registry" | grep -Eq '^ghcr\.io/[A-Za-z0-9._/-]+$' ||
  fail 'release registry is not an allowed GHCR path'
for digest in "$web_digest" "$api_digest" "$worker_digest" "$realtime_digest" "$migrator_digest"; do
  printf '%s' "$digest" | grep -Eq '^sha256:[0-9a-f]{64}$' ||
    fail 'every saved image reference must use a full sha256 digest'
done
printf '%s' "$release" | grep -Eq '^[0-9a-f]{40}$' || fail 'saved release SHA is invalid'
printf '%s' "$latest_migration" | grep -Eq '^[0-9][0-9A-Za-z._-]*\.sql$' ||
  fail 'saved latest migration name is invalid'
[ "$(cat "$stage_dir/backup.complete")" = "$release" ] ||
  fail 'backup.complete does not match the saved release SHA'

candidate_compose() {
  docker compose \
    --env-file "$app_root/infrastructure.env" \
    --env-file "$stage_dir/release.env" \
    -f "$stage_dir/compose.yaml" \
    "$@"
}

candidate_compose --profile migration config --quiet
candidate_images="$(candidate_compose --profile migration config --images)"
image_count="$(printf '%s\n' "$candidate_images" | sed '/^$/d' | wc -l | tr -d ' ')"
[ "$image_count" -eq 5 ] || fail 'saved Compose definition must resolve exactly five images'
for expected_image in \
  "$registry/phub-web@$web_digest" \
  "$registry/phub-api@$api_digest" \
  "$registry/phub-worker@$worker_digest" \
  "$registry/phub-realtime@$realtime_digest" \
  "$registry/phub-migrator@$migrator_digest"; do
  printf '%s\n' "$candidate_images" | grep -Fxq "$expected_image" ||
    fail 'saved Compose definition does not match every recorded digest'
done

# Rollback must not depend on registry credentials or network availability. Every previous runtime
# image must already be present locally before any on-host release file is changed.
for runtime_image in \
  "$registry/phub-web@$web_digest" \
  "$registry/phub-api@$api_digest" \
  "$registry/phub-worker@$worker_digest" \
  "$registry/phub-realtime@$realtime_digest"; do
  docker image inspect "$runtime_image" >/dev/null 2>&1 ||
    fail 'a saved runtime image digest is not present locally'
done
[ -f "$app_root/compose.infrastructure.yaml" ] ||
  fail 'compose.infrastructure.yaml is required to restore Nginx'
[ -f "$app_root/tls-ingress/compose.yaml" ] ||
  fail 'tls-ingress/compose.yaml is required to restore Caddy'

if [ "$operation" = validate ]; then
  printf '%s\n' "Application rollback snapshot validated for release $release"
  exit 0
fi

recovery_dir="$backup_root/rollback-recovery-$(date -u +%Y%m%dT%H%M%SZ)-$$"
umask 077
mkdir -m 700 "$recovery_dir"

capture_current() {
  relative_path="$1"
  mode="$2"
  current_path="$app_root/$relative_path"
  if [ ! -e "$current_path" ]; then
    return 0
  fi
  [ -f "$current_path" ] && [ ! -L "$current_path" ] ||
    fail "current file is not a regular non-symlink file: $relative_path"
  recovery_target="$recovery_dir/$relative_path"
  install -d -m 700 "$(dirname "$recovery_target")"
  install -m "$mode" "$current_path" "$recovery_target"
}

capture_current compose.yaml 600
capture_current release.env 600
capture_current nginx/default.conf 644
capture_current staging.auth.env 600
if [ -e "$app_root/staging.override.env" ]; then
  capture_current staging.override.env 600
else
  : > "$recovery_dir/staging.override.env.absent"
  chmod 600 "$recovery_dir/staging.override.env.absent"
fi
if [ -e "$app_root/staging.communities.env" ]; then
  capture_current staging.communities.env 600
else
  : > "$recovery_dir/staging.communities.env.absent"
  chmod 600 "$recovery_dir/staging.communities.env.absent"
fi
if [ -e "$app_root/staging.games.env" ]; then
  capture_current staging.games.env 600
else
  : > "$recovery_dir/staging.games.env.absent"
  chmod 600 "$recovery_dir/staging.games.env.absent"
fi
capture_current tls-ingress/Caddyfile 644

restore_staged() {
  relative_path="$1"
  mode="$2"
  staged_path="$stage_dir/$relative_path"
  [ -f "$staged_path" ] || return 0
  target_path="$app_root/$relative_path"
  install -d -m 700 "$(dirname "$target_path")"
  restore_tmp="$target_path.rollback.$$"
  [ ! -e "$restore_tmp" ] || fail "temporary restore target already exists: $relative_path"
  install -m "$mode" "$staged_path" "$restore_tmp"
  mv "$restore_tmp" "$target_path"
  restore_tmp=''
}

restore_staged compose.yaml 600
restore_staged release.env 600
restore_staged nginx/default.conf 644
restore_staged staging.auth.env 600
if [ "$override_state" = present ]; then
  restore_staged staging.override.env 600
else
  rm -f "$app_root/staging.override.env"
fi
if [ "$communities_state" = present ]; then
  restore_staged staging.communities.env 600
else
  rm -f "$app_root/staging.communities.env"
fi
if [ "$games_state" = present ]; then
  restore_staged staging.games.env 600
else
  rm -f "$app_root/staging.games.env"
fi
restore_staged tls-ingress/Caddyfile 644

compose() {
  docker compose \
    --env-file "$app_root/infrastructure.env" \
    --env-file "$app_root/release.env" \
    -f "$app_root/compose.yaml" \
    "$@"
}

docker compose \
  --env-file "$app_root/infrastructure.env" \
  -f "$app_root/compose.infrastructure.yaml" \
  run --rm --no-deps nginx nginx -t
docker compose \
  --env-file "$app_root/infrastructure.env" \
  -f "$app_root/compose.infrastructure.yaml" \
  up -d --force-recreate nginx

(
  cd "$app_root/tls-ingress"
  docker compose run --rm --no-deps caddy caddy validate --config /etc/caddy/Caddyfile
  docker compose up -d --force-recreate caddy
)

compose up -d --remove-orphans web api
stop_and_verify() {
  service="$1"
  compose stop "$service"
  [ -z "$(compose ps --status running -q "$service")" ] ||
    fail "restored $service process did not stop"
}
if [ "$require_compatible_worker" = true ]; then
  restored_worker_id="$(compose ps --status running -q worker)"
  [ "$restored_worker_id" = "$compatible_worker_id" ] ||
    fail 'attested worker container changed during rollback'
  worker_state=running
elif [ "$worker_state" = running ]; then
  compose up -d worker
else
  stop_and_verify worker
fi
if [ "$realtime_state" = running ]; then
  compose up -d realtime
else
  stop_and_verify realtime
fi

service_ready() {
  service="$1"
  port="$2"
  compose exec -T "$service" node -e \
    "fetch('http://127.0.0.1:${port}/health/ready').then(async response => { const body = await response.json(); process.exit(response.ok && body.status === 'ready' ? 0 : 1); }).catch(() => process.exit(1))" \
    >/dev/null 2>&1
}

attempt=0
while [ "$attempt" -lt "$health_attempts" ]; do
  worker_ready=true
  realtime_ready=true
  [ "$worker_state" = stopped ] || service_ready worker 3002 || worker_ready=false
  [ "$realtime_state" = stopped ] || service_ready realtime 3001 || realtime_ready=false
  if service_ready api 3000 && [ "$worker_ready" = true ] && [ "$realtime_ready" = true ]; then
    printf '%s\n' "Application rollback ready for release $release"
    printf '%s\n' "Pre-rollback files saved under $recovery_dir"
    exit 0
  fi
  attempt=$((attempt + 1))
  if [ "$attempt" -lt "$health_attempts" ] && [ "$health_delay_seconds" -gt 0 ]; then
    sleep "$health_delay_seconds"
  fi
done

compose ps -a >&2 || true
fail "restored services did not become ready; pre-rollback files remain under $recovery_dir"
