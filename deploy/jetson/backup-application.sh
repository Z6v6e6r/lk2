#!/bin/sh

set -eu

fail() {
  printf '%s\n' "Application backup refused: $*" >&2
  exit 1
}

if [ "$#" -ne 2 ] || [ "$2" != 'BACKUP_STAGING_RELEASE' ]; then
  fail 'usage: backup-application.sh <saved-release-directory> BACKUP_STAGING_RELEASE'
fi

app_root="${PHUB_BACKUP_APP_ROOT:-/opt/phub}"
backup_root="${PHUB_BACKUP_ROOT:-$app_root/backups/releases}"
requested_backup="$1"

case "$app_root" in
  /*) ;;
  *) fail 'application root must be an absolute path' ;;
esac
[ "$app_root" != / ] || fail 'application root cannot be /'
[ -d "$app_root" ] && [ ! -L "$app_root" ] || fail 'application root is absent or unsafe'
app_root="$(cd -P "$app_root" && pwd -P)"

case "$backup_root" in
  /*) ;;
  *) fail 'backup root must be an absolute path' ;;
esac
install -d -m 700 "$backup_root"
[ ! -L "$backup_root" ] || fail 'backup root cannot be a symlink'
backup_root="$(cd -P "$backup_root" && pwd -P)"

backup_name="$(basename "$requested_backup")"
case "$backup_name" in
  pre-[A-Za-z0-9._-]*) ;;
  *) fail 'saved release directory must use a pre-* name' ;;
esac
requested_parent="$(cd -P "$(dirname "$requested_backup")" && pwd -P)"
[ "$requested_parent" = "$backup_root" ] ||
  fail 'saved release directory must be a direct child of the configured backup root'
requested_backup="$requested_parent/$backup_name"
[ ! -e "$requested_backup" ] || fail 'saved release directory already exists'

for relative_path in \
  compose.yaml \
  release.env \
  nginx/default.conf \
  staging.auth.env \
  tls-ingress/Caddyfile; do
  source_path="$app_root/$relative_path"
  [ -f "$source_path" ] && [ ! -L "$source_path" ] ||
    fail "required current file is absent or unsafe: $relative_path"
done
if [ -e "$app_root/staging.override.env" ]; then
  [ -f "$app_root/staging.override.env" ] && [ ! -L "$app_root/staging.override.env" ] ||
    fail 'current staging.override.env is unsafe'
fi
if [ -e "$app_root/staging.communities.env" ]; then
  [ -f "$app_root/staging.communities.env" ] && [ ! -L "$app_root/staging.communities.env" ] ||
    fail 'current staging.communities.env is unsafe'
fi
if [ -e "$app_root/staging.games.env" ]; then
  [ -f "$app_root/staging.games.env" ] && [ ! -L "$app_root/staging.games.env" ] ||
    fail 'current staging.games.env is unsafe'
fi

release_value() {
  key="$1"
  count="$(awk -F= -v key="$key" '$1 == key { count += 1 } END { print count + 0 }' "$app_root/release.env")"
  [ "$count" -eq 1 ] || fail "release.env must contain exactly one $key"
  sed -n "s/^${key}=//p" "$app_root/release.env"
}
release="$(release_value RELEASE)"
registry="$(release_value REGISTRY)"
api_digest="$(release_value API_IMAGE_DIGEST)"
worker_digest="$(release_value WORKER_IMAGE_DIGEST)"
printf '%s' "$release" | grep -Eq '^[0-9a-f]{40}$' || fail 'current release SHA is invalid'
printf '%s' "$registry" | grep -Eq '^ghcr\.io/[A-Za-z0-9._/-]+$' ||
  fail 'current registry is invalid'
for digest in "$api_digest" "$worker_digest"; do
  printf '%s' "$digest" | grep -Eq '^sha256:[0-9a-f]{64}$' ||
    fail 'current API and worker digests must be immutable'
done

compose() {
  docker compose \
    --env-file "$app_root/infrastructure.env" \
    --env-file "$app_root/release.env" \
    -f "$app_root/compose.yaml" \
    "$@"
}

process_state() {
  service="$1"
  if [ -n "$(compose ps -q "$service")" ]; then
    printf '%s' running
  else
    printf '%s' stopped
  fi
}

web_state="$(process_state web)"
api_state="$(process_state api)"
worker_state="$(process_state worker)"
realtime_state="$(process_state realtime)"
[ "$web_state" = running ] && [ "$api_state" = running ] ||
  fail 'web and api must be running before an application snapshot'
api_id="$(compose ps --status running -q api)"
worker_id="$(compose ps --status running -q worker)"
[ -n "$api_id" ] || fail 'running API container is required for snapshot attestation'
[ "$(docker inspect --format '{{.Config.Image}}' "$api_id")" = "$registry/phub-api@$api_digest" ] ||
  fail 'running API does not match release.env digest'
if [ "$worker_state" = running ]; then
  [ -n "$worker_id" ] || fail 'running worker container is required for snapshot attestation'
  [ "$(docker inspect --format '{{.Config.Image}}' "$worker_id")" = "$registry/phub-worker@$worker_digest" ] ||
    fail 'running worker does not match release.env digest'
fi
api_client_media_rollback_v1=false
if compose exec -T api node -e '
  const code = require("node:fs").readFileSync("/app/apps/api/dist/main.js", "utf8");
  process.exit(code.includes("phub.client-media-rollback.v1") ? 0 : 1);
'; then
  api_client_media_rollback_v1=true
fi
worker_client_media_rollback_v1=false
if [ "$worker_state" = running ] && compose exec -T worker node -e '
  const code = require("node:fs").readFileSync("/app/apps/worker/dist/main.js", "utf8");
  process.exit(code.includes("phub.client-media-rollback.v1") ? 0 : 1);
'; then
  worker_client_media_rollback_v1=true
fi
api_community_logo_rollback_v1=false
if compose exec -T api node -e '
  const code = require("node:fs").readFileSync("/app/apps/api/dist/main.js", "utf8");
  process.exit(code.includes("phub.community-logo-rollback.v1") ? 0 : 1);
'; then
  api_community_logo_rollback_v1=true
fi
worker_community_logo_rollback_v1=false
if [ "$worker_state" = running ] && compose exec -T worker node -e '
  const code = require("node:fs").readFileSync("/app/apps/worker/dist/main.js", "utf8");
  process.exit(code.includes("phub.community-logo-rollback.v1") ? 0 : 1);
'; then
  worker_community_logo_rollback_v1=true
fi

stage_dir="$(mktemp -d "$backup_root/.snapshot.XXXXXX")"
cleanup() {
  rm -rf "$stage_dir"
}
trap cleanup EXIT HUP INT TERM

umask 077
install -m 600 "$app_root/compose.yaml" "$stage_dir/compose.yaml"
install -m 600 "$app_root/release.env" "$stage_dir/release.env"
install -d -m 700 "$stage_dir/nginx" "$stage_dir/tls-ingress"
install -m 644 "$app_root/nginx/default.conf" "$stage_dir/nginx/default.conf"
install -m 600 "$app_root/staging.auth.env" "$stage_dir/staging.auth.env"
if [ -f "$app_root/staging.override.env" ]; then
  install -m 600 "$app_root/staging.override.env" "$stage_dir/staging.override.env"
else
  : > "$stage_dir/staging.override.env.absent"
  chmod 600 "$stage_dir/staging.override.env.absent"
fi
if [ -f "$app_root/staging.communities.env" ]; then
  install -m 600 "$app_root/staging.communities.env" "$stage_dir/staging.communities.env"
else
  : > "$stage_dir/staging.communities.env.absent"
  chmod 600 "$stage_dir/staging.communities.env.absent"
fi
if [ -f "$app_root/staging.games.env" ]; then
  install -m 600 "$app_root/staging.games.env" "$stage_dir/staging.games.env"
else
  : > "$stage_dir/staging.games.env.absent"
  chmod 600 "$stage_dir/staging.games.env.absent"
fi
install -m 644 "$app_root/tls-ingress/Caddyfile" "$stage_dir/tls-ingress/Caddyfile"
{
  printf '%s\n' "WEB=$web_state"
  printf '%s\n' "API=$api_state"
  printf '%s\n' "WORKER=$worker_state"
  printf '%s\n' "REALTIME=$realtime_state"
} > "$stage_dir/process-state.env"
chmod 600 "$stage_dir/process-state.env"
{
  printf '%s\n' "API_CLIENT_MEDIA_ROLLBACK_V1=$api_client_media_rollback_v1"
  printf '%s\n' "WORKER_CLIENT_MEDIA_ROLLBACK_V1=$worker_client_media_rollback_v1"
  printf '%s\n' "API_COMMUNITY_LOGO_ROLLBACK_V1=$api_community_logo_rollback_v1"
  printf '%s\n' "WORKER_COMMUNITY_LOGO_ROLLBACK_V1=$worker_community_logo_rollback_v1"
} > "$stage_dir/worker-capabilities.env"
chmod 600 "$stage_dir/worker-capabilities.env"
printf '%s\n' "$release" > "$stage_dir/backup.complete"
chmod 600 "$stage_dir/backup.complete"
mv "$stage_dir" "$requested_backup"
trap - EXIT HUP INT TERM

printf '%s\n' "Application rollback snapshot ready: $requested_backup"
