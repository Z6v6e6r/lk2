#!/usr/bin/env sh
set -eu

original_command=${SSH_ORIGINAL_COMMAND:-}
if [ -z "$original_command" ]; then
  echo "exact SSH original command is required" >&2
  exit 64
fi
set -f
previous_ifs=$IFS
IFS=' '
set -- $original_command
IFS=$previous_ifs
set +f
confirmation=${1:-}
expected_active_release=${2:-}
expected_source_ledger_digest=${3:-}
expected_target_database=${4:-}
expected_system_identifier=${5:-}
expected_backup_script_sha=${6:-}
expected_restore_helper_sha=${7:-}
app_root=${PHUB_APP_ROOT:-/opt/phub}
backup_dir=${PHUB_BACKUP_ROOT:-/var/lib/phub-preflight/backups}
restore_helper=${PHUB_RESTORE_HELPER:-/usr/local/libexec/phub/verify-postgres-backup-restore.sh}
storage_path=${PHUB_POSTGRES_STORAGE_PATH:-/var/lib/docker}

if [ "$confirmation" != BACKUP_RESTORE_COMMUNITIES_STAGING ]; then
  echo "exact Communities staging backup confirmation is required" >&2
  exit 64
fi
if [ "$#" -ne 7 ]; then
  echo "exact inventory binding tuple is required" >&2
  exit 64
fi
case "$expected_active_release:$expected_source_ledger_digest" in
  *[!0-9a-f:]*) echo "inventory release or ledger binding is invalid" >&2; exit 64 ;;
esac
if [ "${#expected_active_release}" -ne 40 ] || [ "${#expected_source_ledger_digest}" -ne 64 ]; then
  echo "inventory release or ledger binding is invalid" >&2
  exit 64
fi
case "$expected_target_database" in
  ''|[!a-zA-Z_]*|*[!a-zA-Z0-9_-]*) echo "inventory database binding is invalid" >&2; exit 64 ;;
esac
[ "${#expected_target_database}" -le 63 ] || { echo "inventory database binding is invalid" >&2; exit 64; }
case "$expected_system_identifier" in
  ''|*[!0-9]*) echo "inventory system binding is invalid" >&2; exit 64 ;;
esac
case "$expected_backup_script_sha:$expected_restore_helper_sha" in
  *[!0-9a-f:]*) echo "installed command binding is invalid" >&2; exit 64 ;;
esac
if [ "${#expected_backup_script_sha}" -ne 64 ] || [ "${#expected_restore_helper_sha}" -ne 64 ]; then
  echo "installed command binding is invalid" >&2
  exit 64
fi

validate_root_command() {
  command_path="$(readlink -f "$1")"
  if [ ! -f "$command_path" ] || [ -L "$command_path" ] || [ "$(stat -c %u "$command_path")" -ne 0 ]; then
    echo "Communities staging backup command is not a root-owned regular file" >&2
    exit 1
  fi
  case "$(stat -c %a "$command_path")" in
    700|744|755) ;;
    *) echo "Communities staging backup command mode is unsafe" >&2; exit 1 ;;
  esac
  printf '%s' "$command_path"
}

script_path="$(validate_root_command "$0")"
if [ "${PHUB_BACKUP_TIMEOUT_ACTIVE:-}" != 1 ]; then
  exec /usr/bin/timeout --signal=TERM --kill-after=30s 150m \
    /usr/bin/env PHUB_BACKUP_TIMEOUT_ACTIVE=1 "$script_path" "$@"
fi
restore_helper="$(validate_root_command "$restore_helper")"
actual_backup_script_sha="$(sha256sum "$script_path" | cut -d ' ' -f 1)"
actual_restore_helper_sha="$(sha256sum "$restore_helper" | cut -d ' ' -f 1)"
if [ "$actual_backup_script_sha" != "$expected_backup_script_sha" ] || \
   [ "$actual_restore_helper_sha" != "$expected_restore_helper_sha" ]; then
  echo "installed backup command does not match the requested release" >&2
  exit 1
fi
validate_readonly_input() {
  if [ ! -e "$1" ] || [ -L "$1" ] || [ -w "$1" ] || [ "$(stat -c %u "$1")" -eq "$(id -u)" ]; then
    echo "staging input is absent or writable by the forced-command principal: $1" >&2
    exit 1
  fi
}
validate_readonly_input "$app_root"
validate_readonly_input "$app_root/infrastructure.env"
validate_readonly_input "$app_root/compose.infrastructure.yaml"
validate_readonly_input "$app_root/release.env"
if [ -e "$app_root/.env" ] || [ -L "$app_root/.env" ]; then
  validate_readonly_input "$app_root/.env"
fi

cd "$app_root"
infrastructure() {
  docker compose --env-file infrastructure.env -f compose.infrastructure.yaml "$@"
}
source_ledger_manifest() {
  infrastructure exec -T postgres sh -ec '
    export PGOPTIONS="-c default_transaction_read_only=on -c statement_timeout=15000 -c lock_timeout=2000 -c search_path=pg_catalog"
    psql -X -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -At -F "|" \
      -c "begin transaction isolation level repeatable read read only; select filename, checksum from public.schema_migrations order by filename; commit;"
  ' | sed -e '/^BEGIN$/d' -e '/^COMMIT$/d'
}
source_identity_manifest() {
  infrastructure exec -T postgres sh -ec '
    export PGOPTIONS="-c default_transaction_read_only=on -c statement_timeout=15000 -c lock_timeout=2000 -c search_path=pg_catalog"
    psql -X -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -At \
      -c "select current_database(); select system_identifier::text from pg_catalog.pg_control_system();"
  '
}
postgres_tool_version() {
  version_output="$(infrastructure exec -T postgres "$1" --version)"
  version_number="$(printf '%s\n' "$version_output" | sed -n "s/^$1 (PostgreSQL) \([0-9][0-9.]*\).*$/\1/p")"
  case "$version_number" in
    16|16.*) printf '%s' "$version_number" ;;
    *) echo "PostgreSQL 16 $1 version could not be verified" >&2; exit 1 ;;
  esac
}

umask 077
if [ ! -d "$backup_dir" ] || [ -L "$backup_dir" ] || \
   [ "$(stat -c %u "$backup_dir")" -ne "$(id -u)" ] || \
   [ "$(stat -c %a "$backup_dir")" != 700 ]; then
  echo "Communities staging backup directory is absent or unsafe" >&2
  exit 1
fi

backup_tmp=
cleanup() {
  if [ -n "$backup_tmp" ]; then rm -f "$backup_tmp"; fi
}
on_signal() {
  trap - EXIT HUP INT TERM
  cleanup
  exit 130
}
trap cleanup EXIT
trap on_signal HUP INT TERM

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
restore_database="phub_restore_$(date -u +%s)_$$"
backup_path="$backup_dir/postgres-communities-preflight-$timestamp-$$.dump"
case "$restore_database" in
  phub_restore_[0-9]*) ;;
  *) echo "generated restore database name is invalid" >&2; exit 1 ;;
esac
[ ! -e "$backup_path" ]
[ ! -L "$backup_path" ]

source_manifest_before="$(source_ledger_manifest)"
test -n "$source_manifest_before"
source_ledger_digest="$(printf '%s\n' "$source_manifest_before" | sha256sum | cut -d ' ' -f 1)"
source_identity_before="$(source_identity_manifest)"
if [ "$(printf '%s\n' "$source_identity_before" | wc -l | tr -d ' ')" -ne 2 ]; then
  echo "source database identity is invalid" >&2
  exit 1
fi
source_database="$(printf '%s\n' "$source_identity_before" | sed -n '1p')"
source_system_identifier="$(printf '%s\n' "$source_identity_before" | sed -n '2p')"
active_release="$(sed -n 's/^RELEASE=//p' release.env 2>/dev/null || true)"
case "$active_release" in
  ''|*[!0-9a-f]*) echo "source release is invalid" >&2; exit 1 ;;
esac
[ "${#active_release}" -eq 40 ] || { echo "source release is invalid" >&2; exit 1; }
case "$source_database" in
  ''|[!a-zA-Z_]*|*[!a-zA-Z0-9_-]*) echo "source database name is invalid" >&2; exit 1 ;;
esac
[ "${#source_database}" -le 63 ] || { echo "source database name is invalid" >&2; exit 1; }
case "$source_system_identifier" in
  ''|*[!0-9]*) echo "source system identifier is invalid" >&2; exit 1 ;;
esac
if [ "$active_release" != "$expected_active_release" ] || \
   [ "$source_ledger_digest" != "$expected_source_ledger_digest" ] || \
   [ "$source_database" != "$expected_target_database" ] || \
   [ "$source_system_identifier" != "$expected_system_identifier" ]; then
  echo "source no longer matches the inventory binding; refusing backup" >&2
  exit 1
fi
pg_dump_version="$(postgres_tool_version pg_dump)"
pg_restore_version="$(postgres_tool_version pg_restore)"
psql_version="$(postgres_tool_version psql)"

capacity_summary="$(PHUB_APP_ROOT="$app_root" \
PHUB_RESTORE_MARKER_ROOT="$backup_dir" \
PHUB_POSTGRES_STORAGE_PATH="$storage_path" \
  sh "$restore_helper" - "$restore_database" VERIFY_STAGING_POSTGRES_CAPACITY)"
test -n "$capacity_summary"

backup_tmp="$(mktemp "$backup_dir/.postgres-communities-preflight.XXXXXX.dump")"
dump_started="$(date +%s)"
infrastructure exec -T postgres sh -ec \
  'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom --no-owner --no-acl' \
  > "$backup_tmp"
dump_seconds="$(( $(date +%s) - dump_started ))"
test -s "$backup_tmp"
chmod 600 "$backup_tmp"
[ "$(stat -c %a "$backup_tmp")" = 600 ]
infrastructure exec -T postgres pg_restore --list < "$backup_tmp" >/dev/null

source_manifest_after="$(source_ledger_manifest)"
source_identity_after="$(source_identity_manifest)"
active_release_after="$(sed -n 's/^RELEASE=//p' release.env 2>/dev/null || true)"
if [ "$source_manifest_before" != "$source_manifest_after" ] || \
   [ "$source_identity_before" != "$source_identity_after" ] || \
   [ "$active_release" != "$active_release_after" ]; then
  echo "source release, identity, or migration ledger changed while the backup was created" >&2
  exit 1
fi

restore_started="$(date +%s)"
restore_summary="$(PHUB_APP_ROOT="$app_root" \
PHUB_RESTORE_MARKER_ROOT="$backup_dir" \
PHUB_POSTGRES_STORAGE_PATH="$storage_path" \
PHUB_EXPECTED_SOURCE_LEDGER_DIGEST="$source_ledger_digest" \
  sh "$restore_helper" "$backup_tmp" "$restore_database" VERIFY_STAGING_POSTGRES_BACKUP)"
test -n "$restore_summary"
restore_seconds="$(( $(date +%s) - restore_started ))"

backup_size="$(wc -c < "$backup_tmp" | tr -d ' ')"
backup_sha256="$(sha256sum "$backup_tmp" | cut -d ' ' -f 1)"
mv "$backup_tmp" "$backup_path"
backup_tmp=
chmod 600 "$backup_path"
[ "$(stat -c %a "$backup_path")" = 600 ]

printf 'META|backupScriptSha|%s\n' "$actual_backup_script_sha"
printf 'META|restoreHelperSha|%s\n' "$actual_restore_helper_sha"
printf 'META|sourceLedgerSha|%s\n' "$source_ledger_digest"
printf 'META|targetDatabase|%s\n' "$source_database"
printf 'META|systemIdentifier|%s\n' "$source_system_identifier"
printf 'META|activeRelease|%s\n' "$active_release"
printf 'META|backupPath|%s\n' "$backup_path"
printf 'META|backupBytes|%s\n' "$backup_size"
printf 'META|backupSha|%s\n' "$backup_sha256"
printf 'META|dumpSeconds|%s\n' "$dump_seconds"
printf 'META|restoreSeconds|%s\n' "$restore_seconds"
printf 'META|pgDumpVersion|%s\n' "$pg_dump_version"
printf 'META|pgRestoreVersion|%s\n' "$pg_restore_version"
printf 'META|psqlVersion|%s\n' "$psql_version"

trap - EXIT HUP INT TERM
