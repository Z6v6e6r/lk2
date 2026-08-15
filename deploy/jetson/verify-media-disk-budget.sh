#!/bin/sh

set -eu

fail() {
  printf '%s\n' "Media disk budget refused: $*" >&2
  exit 1
}

if test "$#" -ne 1 || test "$1" != post-pull; then
  fail 'usage: verify-media-disk-budget.sh post-pull'
fi

phase="$1"
app_root="${PHUB_APP_ROOT:-/opt/phub}"
cd "$app_root"

infrastructure() {
  docker compose --env-file infrastructure.env -f compose.infrastructure.yaml "$@"
}

database_size_bytes="$(infrastructure exec -T postgres sh -ec '
  exec env PGOPTIONS="-c default_transaction_read_only=on -c statement_timeout=15000 -c lock_timeout=2000 -c idle_in_transaction_session_timeout=15000" \
    psql -X -qAt -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 \
      -c "select pg_database_size(current_database())"
')"
case "$database_size_bytes" in *[!0-9]*|'') fail 'staging database size is unavailable' ;; esac
database_size_kb=$(((database_size_bytes + 1023) / 1024))

docker_root="$(docker info --format '{{.DockerRootDir}}')"
case "$docker_root" in /*) ;; *) fail 'Docker root directory is unavailable' ;; esac
test -d "$docker_root" || fail 'Docker root directory is unavailable'
app_available_kb="$(df -Pk "$app_root" | awk 'END { print $4 }')"
docker_available_kb="$(df -Pk "$docker_root" | awk 'END { print $4 }')"
app_device="$(df -Pk "$app_root" | awk 'END { print $1 }')"
docker_device="$(df -Pk "$docker_root" | awk 'END { print $1 }')"
safety_reserve_kb="${PHUB_MEDIA_DISK_SAFETY_RESERVE_KB:-4194304}"
for metric in "$app_available_kb" "$docker_available_kb" "$database_size_kb" "$safety_reserve_kb"; do
  case "$metric" in *[!0-9]*|'') fail 'disk budget metric is malformed' ;; esac
done

if test "$app_device" = "$docker_device"; then
  app_required_kb=$((safety_reserve_kb + database_size_kb * 3))
  docker_required_kb="$app_required_kb"
else
  app_required_kb=$((safety_reserve_kb + database_size_kb))
  docker_required_kb=$((safety_reserve_kb + database_size_kb * 2))
fi

test "$app_available_kb" -ge "$app_required_kb" ||
  fail "application filesystem cannot retain dump, clone/WAL and safety reserve after image pull (available=$app_available_kb required=$app_required_kb KiB)"
test "$docker_available_kb" -ge "$docker_required_kb" ||
  fail "Docker filesystem cannot retain clone/WAL and safety reserve after image pull (available=$docker_available_kb required=$docker_required_kb KiB)"

printf 'media_disk_budget phase=%s database_size_bytes=%s app_available_kb=%s app_required_kb=%s docker_available_kb=%s docker_required_kb=%s status=passed\n' \
  "$phase" "$database_size_bytes" "$app_available_kb" "$app_required_kb" \
  "$docker_available_kb" "$docker_required_kb"
