#!/usr/bin/env sh
set -eu

backup_file=${1:-}
restore_database=${2:-}
confirmation=${3:-}
app_root=${PHUB_APP_ROOT:-/opt/phub}
marker_root=${PHUB_RESTORE_MARKER_ROOT:-/opt/phub/backups}
storage_path=${PHUB_POSTGRES_STORAGE_PATH:-/var/lib/docker}

case "$confirmation" in
  VERIFY_STAGING_POSTGRES_CAPACITY|VERIFY_STAGING_POSTGRES_BACKUP|VERIFY_CHAT_PUSH_FOUNDATION_BACKUP) ;;
  *) echo "valid staging PostgreSQL verification confirmation is required" >&2; exit 64 ;;
esac
if [ "$confirmation" = VERIFY_STAGING_POSTGRES_BACKUP ] ||
  [ "$confirmation" = VERIFY_CHAT_PUSH_FOUNDATION_BACKUP ]; then
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

foundation_snapshot_sql="
select concat_ws('|',
  'chat_push_foundation_snapshot_v1',
  (select count(*)::text from public.schema_migrations),
  (select pg_catalog.md5(coalesce(pg_catalog.string_agg(filename || ':' || checksum, ',' order by filename), ''))
     from public.schema_migrations),
  (select count(*)::text from identity.tenants),
  (select pg_catalog.md5(coalesce(pg_catalog.string_agg(id::text || ':' || tenant_key, ',' order by tenant_key, id), ''))
     from identity.tenants),
  (select count(*)::text from notifications.tenant_runtime_settings),
  (select count(*) filter (where web_push_enabled)::text from notifications.tenant_runtime_settings),
  (select count(*)::text from messaging.tenant_runtime_settings),
  (select count(*) filter (where http_enabled or direct_enabled or realtime_enabled or contextual_enabled)::text
     from messaging.tenant_runtime_settings),
  (select count(*)::text from integration.notification_endpoints),
  (select count(*) filter (where status = 'SUSPENDED_POLICY')::text
     from integration.notification_endpoints),
  (select count(*) filter (
     where published_at is null
       and event_type in ('booking.confirmed.v1', 'booking.changed.v1', 'booking.cancelled.v1')
   )::text from audit.outbox_events)
)"

foundation_snapshot() {
  snapshot_database="$1"
  infrastructure exec -T postgres sh -ec \
    'snapshot_database="$1"; if [ "$snapshot_database" = __SOURCE__ ]; then snapshot_database="$POSTGRES_DB"; fi; PGOPTIONS="-c default_transaction_read_only=on" psql -U "$POSTGRES_USER" -d "$snapshot_database" -v ON_ERROR_STOP=1 -Atc "$2"' \
    sh "$snapshot_database" "$foundation_snapshot_sql"
}

foundation_source_snapshot=''
if [ "$confirmation" = VERIFY_CHAT_PUSH_FOUNDATION_BACKUP ]; then
  foundation_source_snapshot="$(foundation_snapshot __SOURCE__)"
  test -n "$foundation_source_snapshot" || {
    echo "foundation source snapshot is empty" >&2
    exit 1
  }
fi

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
foundation_snapshot_sha256=''
if [ "$confirmation" = VERIFY_CHAT_PUSH_FOUNDATION_BACKUP ]; then
  foundation_restored_snapshot="$(foundation_snapshot "$restore_database")"
  if [ "$foundation_restored_snapshot" != "$foundation_source_snapshot" ]; then
    echo "foundation source and restored snapshots differ" >&2
    exit 1
  fi
  foundation_snapshot_sha256="$(printf '%s' "$foundation_source_snapshot" | sha256sum | cut -d ' ' -f 1)"
fi

cleanup_restore
trap - EXIT HUP INT TERM
echo "Restore-verified PostgreSQL backup: size=$backup_size sha256=$backup_sha256 migrations=$restored_migration_count"
if [ -n "$foundation_snapshot_sha256" ]; then
  echo "Chat/push foundation source/restore snapshot verified: sha256=$foundation_snapshot_sha256"
fi
echo "Tools: $pg_dump_version; $pg_restore_version; $psql_version"
