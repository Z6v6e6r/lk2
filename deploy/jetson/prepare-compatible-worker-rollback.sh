#!/bin/sh

set -eu

fail() {
  printf '%s\n' "Compatible worker restore refused: $*" >&2
  exit 1
}

if [ "$#" -ne 2 ] || [ "$2" != 'PREPARE_COMPATIBLE_WORKER_ROLLBACK' ]; then
  fail 'usage: prepare-compatible-worker-rollback.sh <saved-release-directory> PREPARE_COMPATIBLE_WORKER_ROLLBACK'
fi

app_root="${PHUB_ROLLBACK_APP_ROOT:-/opt/phub}"
backup_root="${PHUB_ROLLBACK_BACKUP_ROOT:-$app_root/backups/releases}"
health_attempts="${PHUB_ROLLBACK_HEALTH_ATTEMPTS:-36}"
health_delay_seconds="${PHUB_ROLLBACK_HEALTH_DELAY_SECONDS:-5}"
compatibility_floor="${PHUB_ROLLBACK_COMPATIBILITY_FLOOR:-}"
base_runtime_env="${PHUB_ROLLBACK_BASE_RUNTIME_ENV:-/etc/phub/staging.env}"

case "$compatibility_floor" in
  client-media | community-logo) ;;
  *) fail 'PHUB_ROLLBACK_COMPATIBILITY_FLOOR must be client-media or community-logo' ;;
esac

[ -d "$app_root" ] && [ ! -L "$app_root" ] || fail 'application root is absent or unsafe'
[ -d "$backup_root" ] && [ ! -L "$backup_root" ] || fail 'backup root is absent or unsafe'
[ -f "$app_root/infrastructure.env" ] || fail 'infrastructure.env is absent'
[ -f "$base_runtime_env" ] && [ ! -L "$base_runtime_env" ] ||
  fail 'base runtime env is absent or unsafe'
app_root="$(cd -P "$app_root" && pwd -P)"
backup_root="$(cd -P "$backup_root" && pwd -P)"
backup_dir="$(cd -P "$1" && pwd -P)"
case "$backup_dir" in
  "$backup_root"/*) ;;
  *) fail 'saved release directory must be a child of the configured backup root' ;;
esac

for file in compose.yaml release.env worker-capabilities.env backup.complete; do
  [ -f "$backup_dir/$file" ] && [ ! -L "$backup_dir/$file" ] ||
    fail "saved $file is absent or unsafe"
done
grep -Fxq 'WORKER_CLIENT_MEDIA_ROLLBACK_V1=true' "$backup_dir/worker-capabilities.env" ||
  fail 'saved worker lacks phub.client-media-rollback.v1 attestation'
if [ "$compatibility_floor" = community-logo ]; then
  grep -Fxq 'WORKER_COMMUNITY_LOGO_ROLLBACK_V1=true' "$backup_dir/worker-capabilities.env" ||
    fail 'saved worker lacks phub.community-logo-rollback.v1 attestation'
fi

release_value() {
  key="$1"
  count="$(awk -F= -v key="$key" '$1 == key { count += 1 } END { print count + 0 }' "$backup_dir/release.env")"
  [ "$count" -eq 1 ] || fail "saved release.env must contain exactly one $key"
  sed -n "s/^${key}=//p" "$backup_dir/release.env"
}
registry="$(release_value REGISTRY)"
worker_digest="$(release_value WORKER_IMAGE_DIGEST)"
release="$(release_value RELEASE)"
printf '%s' "$registry" | grep -Eq '^ghcr\.io/[A-Za-z0-9._/-]+$' ||
  fail 'saved registry is invalid'
printf '%s' "$worker_digest" | grep -Eq '^sha256:[0-9a-f]{64}$' ||
  fail 'saved worker digest is not immutable'
printf '%s' "$release" | grep -Eq '^[0-9a-f]{40}$' || fail 'saved release SHA is invalid'
[ "$(cat "$backup_dir/backup.complete")" = "$release" ] ||
  fail 'backup.complete does not match the saved release SHA'
worker_image="$registry/phub-worker@$worker_digest"
docker image inspect "$worker_image" >/dev/null 2>&1 ||
  fail 'saved compatible worker image is not present locally'

snapshot_override="$backup_dir/staging.override.env"
[ -f "$snapshot_override" ] || snapshot_override="$backup_dir/staging.override.env.absent"
snapshot_games="$backup_dir/staging.games.env"
[ -f "$snapshot_games" ] || snapshot_games="$backup_dir/staging.games.env.absent"
[ -f "$backup_dir/staging.auth.env" ] || fail 'saved staging.auth.env is absent'
[ -f "$snapshot_override" ] || fail 'saved staging.override.env state is absent'
[ -f "$snapshot_games" ] || fail 'saved staging.games.env state is absent'

file_value() {
  file="$1"
  key="$2"
  sed -n "s/^${key}=//p" "$file" 2>/dev/null | tail -n 1
}

saved_runtime_value() {
  key="$1"
  for file in "$snapshot_games" "$snapshot_override" "$backup_dir/staging.auth.env" "$base_runtime_env"; do
    value="$(file_value "$file" "$key")"
    if [ -n "$value" ]; then
      printf '%s' "$value"
      return 0
    fi
  done
  return 0
}

saved_stable="$(saved_runtime_value COMMUNITY_LOGO_STABLE_DELIVERY_ENABLED)"
saved_backfill="$(saved_runtime_value COMMUNITY_LOGO_COMPATIBILITY_BACKFILL_ENABLED)"
case "$compatibility_floor:$saved_stable:$saved_backfill" in
  client-media:false:false | community-logo:true:false) ;;
  *) fail 'saved worker flags do not match the requested compatibility floor' ;;
esac

compose() {
  RUNTIME_AUTH_ENV_FILE="$backup_dir/staging.auth.env" \
  RUNTIME_OVERRIDE_ENV_FILE="$snapshot_override" \
  RUNTIME_GAMES_ENV_FILE="$snapshot_games" \
    docker compose \
    --project-directory "$app_root" \
    --env-file "$app_root/infrastructure.env" \
    --env-file "$backup_dir/release.env" \
    -f "$backup_dir/compose.yaml" \
    "$@"
}
compose up -d worker

worker_matches_floor() {
  worker_id="$1"
  if ! env_dump="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$worker_id")"; then
    return 1
  fi
  stable="$(printf '%s\n' "$env_dump" |
    sed -n 's/^COMMUNITY_LOGO_STABLE_DELIVERY_ENABLED=//p' | tail -n 1)"
  backfill="$(printf '%s\n' "$env_dump" |
    sed -n 's/^COMMUNITY_LOGO_COMPATIBILITY_BACKFILL_ENABLED=//p' | tail -n 1)"
  case "$compatibility_floor:$stable:$backfill" in
    client-media:false:false)
      docker exec "$worker_id" node -e '
        const code = require("node:fs").readFileSync("/app/apps/worker/dist/main.js", "utf8");
        process.exit(code.includes("phub.client-media-rollback.v1") ? 0 : 1);
      '
      ;;
    community-logo:true:false)
      docker exec "$worker_id" node -e '
        const code = require("node:fs").readFileSync("/app/apps/worker/dist/main.js", "utf8");
        process.exit(
          code.includes("phub.client-media-rollback.v1") &&
          code.includes("phub.community-logo-rollback.v1") ? 0 : 1,
        );
      '
      ;;
    *) return 1 ;;
  esac
}

attempt=0
while [ "$attempt" -lt "$health_attempts" ]; do
  worker_id="$(compose ps --status running -q worker)"
  if [ -n "$worker_id" ] &&
    [ "$(docker inspect --format '{{.Config.Image}}' "$worker_id")" = "$worker_image" ] &&
    worker_matches_floor "$worker_id" &&
    compose exec -T worker node -e '
      fetch("http://127.0.0.1:3002/health/ready")
        .then(async (response) => process.exit(response.ok ? 0 : 1))
        .catch(() => process.exit(1));
    '; then
    printf '%s\n' "Saved compatible worker ready ($compatibility_floor): $worker_image"
    exit 0
  fi
  attempt=$((attempt + 1))
  sleep "$health_delay_seconds"
done

fail 'saved compatible worker did not become ready'
