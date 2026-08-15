#!/usr/bin/env sh
set -eu

backup_file=${1:-}
restore_database=${2:-}
confirmation=${3:-}
app_root=${PHUB_APP_ROOT:-/opt/phub}
marker_root=${PHUB_RESTORE_MARKER_ROOT:-/opt/phub/backups}
storage_path=${PHUB_POSTGRES_STORAGE_PATH:-/var/lib/docker}
expected_source_ledger_digest=${PHUB_EXPECTED_SOURCE_LEDGER_DIGEST:-}

case "$confirmation" in
  VERIFY_STAGING_POSTGRES_CAPACITY|VERIFY_STAGING_POSTGRES_BACKUP) ;;
  *) echo "valid staging PostgreSQL verification confirmation is required" >&2; exit 64 ;;
esac
if [ "$confirmation" = VERIFY_STAGING_POSTGRES_BACKUP ]; then
  case "$backup_file" in
    /*) ;;
    *) echo "backup path must be absolute" >&2; exit 64 ;;
  esac
elif [ "$backup_file" != - ]; then
  echo "capacity-only verification requires '-' as the backup argument" >&2
  exit 64
fi
case "$restore_database" in
  phub_restore_[0-9]*) ;;
  *) echo "restore database name is invalid" >&2; exit 64 ;;
esac
case "$restore_database" in
  *[!a-z0-9_]*) echo "restore database name is invalid" >&2; exit 64 ;;
esac
if [ ! -d "$app_root" ] || [ ! -d "$marker_root" ] || [ -L "$marker_root" ] || [ ! -d "$storage_path" ]; then
  echo "restore verification path is absent" >&2
  exit 1
fi

cd "$app_root"
marker_path="$marker_root/.restore-cleanup-$restore_database"
unresolved_marker="$(find "$marker_root" -maxdepth 1 \( -type f -o -type l \) \
  -name '.restore-cleanup-phub_restore_*' -print -quit)"
if [ -n "$unresolved_marker" ]; then
  echo "unresolved restore cleanup marker exists: $unresolved_marker" >&2
  exit 1
fi

infrastructure() {
  docker compose --env-file infrastructure.env -f compose.infrastructure.yaml "$@"
}

restore_created=false
cleanup_restore() {
  if [ "$restore_created" = true ]; then
    if ! infrastructure exec -T postgres sh -ec \
      "dropdb --if-exists -U \"\$POSTGRES_USER\" \"\$1\"" \
      sh "$restore_database"
    then
      echo "restore database cleanup failed; marker retained: $marker_path" >&2
      return 1
    fi
    remaining_database_names="$(infrastructure exec -T postgres sh -ec \
      "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -Atc \"select datname from pg_database\"")" || {
        echo "could not verify restore database cleanup; marker retained: $marker_path" >&2
        return 1
      }
    if printf "%s\n" "$remaining_database_names" | grep -Fx "$restore_database" >/dev/null; then
      echo "restore database still exists after cleanup; marker retained: $marker_path" >&2
      return 1
    fi
    restore_created=false
  fi
  if [ -e "$marker_path" ] || [ -L "$marker_path" ]; then
    marker_state="$(sed -n '1p' "$marker_path" 2>/dev/null || true)"
    if [ "$marker_state" = CANDIDATE ]; then
      candidate_names="$(infrastructure exec -T postgres sh -ec \
        "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -Atc \"select datname from pg_database\"")" || {
          echo "createdb outcome is uncertain; marker retained: $marker_path" >&2
          return 1
        }
      if printf "%s\n" "$candidate_names" | grep -Fx "$restore_database" >/dev/null; then
        echo "createdb outcome is uncertain; marker retained: $marker_path" >&2
        return 1
      fi
    fi
    rm -f "$marker_path"
  fi
}
on_exit() {
  status=$?
  trap - EXIT HUP INT TERM
  if ! cleanup_restore; then
    exit 1
  fi
  exit "$status"
}
on_signal() {
  trap - EXIT HUP INT TERM
  if ! cleanup_restore; then
    exit 1
  fi
  exit 130
}
trap on_exit EXIT
trap on_signal HUP INT TERM

existing_database_names="$(infrastructure exec -T postgres sh -ec \
  "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -Atc \"select datname from pg_database\"")"
if printf "%s\n" "$existing_database_names" | grep -Fx "$restore_database" >/dev/null; then
  echo "restore verification database already exists; refusing to reuse it" >&2
  exit 1
fi

available_kb="$(df -Pk "$storage_path" | tail -1 | tr -s " " | cut -d " " -f 4)"
database_bytes="$(infrastructure exec -T postgres sh -ec \
  "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -Atc \"select pg_database_size(current_database())\"")"
case "$available_kb:$database_bytes" in
  *[!0-9:]*) echo "could not determine restore capacity" >&2; exit 1 ;;
  :*|*:) echo "could not determine restore capacity" >&2; exit 1 ;;
esac
database_kb="$(( (database_bytes + 1023) / 1024 ))"
restore_required_kb="$(( database_kb * 3 + 1048576 ))"
if [ "$available_kb" -lt "$restore_required_kb" ]; then
  echo "insufficient disk headroom for backup plus restore verification" >&2
  echo "available_kb=$available_kb database_kb=$database_kb required_kb=$restore_required_kb" >&2
  exit 1
fi

if [ "$confirmation" = VERIFY_STAGING_POSTGRES_CAPACITY ]; then
  echo "PostgreSQL restore capacity verified: available_kb=$available_kb database_kb=$database_kb required_kb=$restore_required_kb"
  trap - EXIT HUP INT TERM
  exit 0
fi

if [ ! -f "$backup_file" ] || [ -L "$backup_file" ] || [ ! -s "$backup_file" ]; then
  echo "backup archive is absent or unsafe" >&2
  exit 1
fi

backup_size="$(wc -c < "$backup_file" | tr -d " ")"
backup_sha256="$(sha256sum "$backup_file" | cut -d " " -f 1)"
pg_dump_version="$(infrastructure exec -T postgres pg_dump --version)"
pg_restore_version="$(infrastructure exec -T postgres pg_restore --version)"
psql_version="$(infrastructure exec -T postgres psql --version)"

if ! (umask 077; set -C; printf "%s\n" CANDIDATE > "$marker_path"); then
  echo "could not create exclusive restore cleanup marker" >&2
  exit 1
fi
infrastructure exec -T postgres sh -ec \
  "createdb --template=template0 -U \"\$POSTGRES_USER\" \"\$1\"" \
  sh "$restore_database"
restore_created=true
printf "%s\n" OWNED > "$marker_path"

infrastructure exec -T postgres sh -ec \
  "pg_restore -U \"\$POSTGRES_USER\" -d \"\$1\" --exit-on-error --no-owner --no-acl" \
  sh "$restore_database" < "$backup_file"
restored_migration_count="$(infrastructure exec -T postgres sh -ec \
  "psql -U \"\$POSTGRES_USER\" -d \"\$1\" -Atc \"select count(*) from public.schema_migrations\"" \
  sh "$restore_database")"
case "$restored_migration_count" in
  ""|*[!0-9]*) echo "restored migration ledger count is invalid" >&2; exit 1 ;;
esac
if [ "$restored_migration_count" -lt 1 ]; then
  echo "restored migration ledger is empty" >&2
  exit 1
fi
restored_server_version="$(infrastructure exec -T postgres sh -ec \
  "psql -U \"\$POSTGRES_USER\" -d \"\$1\" -Atc \"show server_version_num\"" \
  sh "$restore_database")"
case "$restored_server_version" in
  16[0-9][0-9][0-9][0-9]) ;;
  *) echo "restored PostgreSQL major version is not 16" >&2; exit 1 ;;
esac
restored_ledger_manifest="$(infrastructure exec -T postgres sh -ec \
  "psql -U \"\$POSTGRES_USER\" -d \"\$1\" -At -F '|' -c \"select filename, checksum from public.schema_migrations order by filename\"" \
  sh "$restore_database")"
restored_ledger_digest="$(printf '%s\n' "$restored_ledger_manifest" | sha256sum | cut -d ' ' -f 1)"
if [ -n "$expected_source_ledger_digest" ] && [ "$restored_ledger_digest" != "$expected_source_ledger_digest" ]; then
  echo "restored migration ledger digest does not match the source snapshot" >&2
  exit 1
fi

cleanup_restore
[ ! -e "$marker_path" ]
trap - EXIT HUP INT TERM
echo "Restore-verified PostgreSQL backup: size=$backup_size sha256=$backup_sha256 migrations=$restored_migration_count ledger_sha256=$restored_ledger_digest"
echo "Tools: $pg_dump_version; $pg_restore_version; $psql_version"
