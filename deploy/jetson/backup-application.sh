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

release_count="$(awk -F= '$1 == "RELEASE" { count += 1 } END { print count + 0 }' "$app_root/release.env")"
[ "$release_count" -eq 1 ] || fail 'release.env must contain exactly one RELEASE'
release="$(sed -n 's/^RELEASE=//p' "$app_root/release.env")"
printf '%s' "$release" | grep -Eq '^[0-9a-f]{40}$' || fail 'current release SHA is invalid'

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
install -m 644 "$app_root/tls-ingress/Caddyfile" "$stage_dir/tls-ingress/Caddyfile"
printf '%s\n' "$release" > "$stage_dir/backup.complete"
chmod 600 "$stage_dir/backup.complete"
mv "$stage_dir" "$requested_backup"
trap - EXIT HUP INT TERM

printf '%s\n' "Application rollback snapshot ready: $requested_backup"
