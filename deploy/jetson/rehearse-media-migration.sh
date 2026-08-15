#!/bin/sh

set -eu

fail() {
  printf '%s\n' "Media migration rehearsal refused: $*" >&2
  exit 1
}

if test "$#" -ne 3; then
  fail 'usage: rehearse-media-migration.sh <backup.dump> <restore-database> <migration-manifest-base64>'
fi

backup_path="$1"
restore_database="$2"
manifest_base64="$3"
test -n "${RUNTIME_DATABASE_URL:-}" || fail 'RUNTIME_DATABASE_URL is required'
test -n "${MIGRATOR_DATABASE_URL:-}" || fail 'MIGRATOR_DATABASE_URL is required'
app_root="${PHUB_APP_ROOT:-/opt/phub}"
backup_root="${PHUB_BACKUP_ROOT:-/opt/phub/backups}"
marker_root="${PHUB_RESTORE_MARKER_ROOT:-$backup_root}"
cd "$app_root"

case "$backup_root" in
  /*) ;;
  *) fail 'backup root must be absolute' ;;
esac
test -d "$backup_root" && test ! -L "$backup_root" || fail 'backup root is absent or unsafe'
case "$marker_root" in
  /*) ;;
  *) fail 'restore marker root must be absolute' ;;
esac
test -d "$marker_root" && test ! -L "$marker_root" || fail 'restore marker root is absent or unsafe'
case "$backup_path" in
  "$backup_root"/postgres-pre-*.dump) ;;
  *) fail 'backup path is outside the approved PostgreSQL backup namespace' ;;
esac
test -f "$backup_path" && test ! -L "$backup_path" && test -s "$backup_path" ||
  fail 'backup archive is absent, empty or unsafe'
case "$restore_database" in
  phub_restore_*) ;;
  *) fail 'restore database name is malformed' ;;
esac
restore_suffix="${restore_database#phub_restore_}"
case "$restore_suffix" in
  '' | _* | *_ | *__* | *[!0-9_]*) fail 'restore database name is malformed' ;;
esac

compose() {
  docker compose --env-file infrastructure.env --env-file release.env "$@"
}

infrastructure() {
  docker compose --env-file infrastructure.env -f compose.infrastructure.yaml "$@"
}

postgres_value() {
  infrastructure exec -T postgres sh -ec '
    exec psql -X -qAt -U "$POSTGRES_USER" -d postgres -v ON_ERROR_STOP=1 -c "$1"
  ' sh "$1"
}

server_version="$(postgres_value 'show server_version_num')"
case "$server_version" in 16????) ;; *) fail "restore rehearsal requires PostgreSQL 16 (observed=$server_version)" ;; esac
test "$(postgres_value 'select rolsuper from pg_catalog.pg_roles where rolname = current_user')" = t ||
  fail 'same-cluster ownership restore requires the infrastructure PostgreSQL superuser'
shared_database="$(infrastructure exec -T postgres sh -ec 'printf %s "$POSTGRES_DB"')"
case "$shared_database" in *[!A-Za-z0-9_]*|'') fail 'shared database name is malformed' ;; esac
test "$restore_database" != "$shared_database" || fail 'restore database must differ from the shared database'

if ! role_target="$(compose --profile migration run --rm --no-deps \
  -e RUNTIME_DATABASE_URL -e MIGRATOR_DATABASE_URL \
  --entrypoint node migrator -e '
  let runtime;
  let migrator;
  try {
    runtime = new URL(process.env.RUNTIME_DATABASE_URL || "");
    migrator = new URL(process.env.MIGRATOR_DATABASE_URL || "");
  } catch {
    process.exit(64);
  }
  const protocols = new Set(["postgresql:", "postgres:"]);
  let runtimeRole;
  let migratorRole;
  let database;
  try {
    runtimeRole = decodeURIComponent(runtime.username);
    migratorRole = decodeURIComponent(migrator.username);
    database = decodeURIComponent(migrator.pathname.replace(/^\//, ""));
  } catch {
    process.exit(64);
  }
  const valid = protocols.has(runtime.protocol) && protocols.has(migrator.protocol) &&
    !runtime.search && !runtime.hash && !migrator.search && !migrator.hash &&
    runtimeRole && migratorRole && runtimeRole !== migratorRole &&
    runtime.hostname === migrator.hostname &&
    (runtime.port || "5432") === (migrator.port || "5432") &&
    runtime.pathname === migrator.pathname;
  if (!valid) process.exit(64);
  process.stdout.write(`${migrator.hostname}|${migrator.port || "5432"}|${database}`);
')"; then
  fail 'runtime and migrator DATABASE_URLs are not distinct local shared PostgreSQL roles'
fi
role_target="$(printf '%s\n' "$role_target" |
  awk -F '|' 'NF == 3 && $1 ~ /^[A-Za-z0-9.-]+$/ && $2 ~ /^[0-9]+$/ && $3 ~ /^[A-Za-z0-9_]+$/ { print; exit }')"
test "$role_target" = "postgres|5432|$shared_database" ||
  fail 'runtime and migrator DATABASE_URLs are not distinct local shared PostgreSQL roles'

database_exists() {
  postgres_value "select count(*) from pg_database where datname = '$restore_database'"
}

marker_path="$marker_root/.restore-cleanup-$restore_database"
unresolved_marker="$(find "$marker_root" -maxdepth 1 \( -type f -o -type l \) \
  -name '.restore-cleanup-phub_restore_*' -print -quit)"
test -z "$unresolved_marker" || fail "unresolved restore cleanup marker exists: $unresolved_marker"
test "$(database_exists)" = 0 || fail 'restore database already exists; refusing destructive cleanup'

clone_created=false
cleanup_restore_database() {
  if test "$clone_created" = true; then
    if ! infrastructure exec -T postgres sh -ec '
      dropdb -U "$POSTGRES_USER" --if-exists --force "$1"
    ' sh "$restore_database" >/dev/null 2>&1; then
      printf 'Media migration rehearsal cleanup failed; marker retained: %s\n' "$marker_path" >&2
      return 1
    fi
    clone_created=false
  fi

  if test -e "$marker_path" || test -L "$marker_path"; then
    marker_state="$(sed -n '1p' "$marker_path" 2>/dev/null || true)"
    case "$marker_state" in
      CANDIDATE | OWNED) ;;
      *)
        printf 'Media migration rehearsal cleanup marker is invalid; marker retained: %s\n' \
          "$marker_path" >&2
        return 1
        ;;
    esac
    database_presence="$(database_exists)" || {
      printf 'Media migration rehearsal could not verify clone absence; marker retained: %s\n' \
        "$marker_path" >&2
      return 1
    }
    if test "$database_presence" != 0; then
      if test "$marker_state" = CANDIDATE; then
        printf 'Media migration rehearsal createdb outcome is uncertain; marker retained: %s\n' \
          "$marker_path" >&2
      else
        printf 'Media migration rehearsal clone still exists; marker retained: %s\n' \
          "$marker_path" >&2
      fi
      return 1
    fi
    rm -f "$marker_path" || {
      printf 'Media migration rehearsal could not remove cleanup marker: %s\n' \
        "$marker_path" >&2
      return 1
    }
  fi
}

on_exit() {
  status=$?
  trap - EXIT HUP INT TERM
  if ! cleanup_restore_database; then
    exit 1
  fi
  exit "$status"
}

on_signal() {
  trap - EXIT HUP INT TERM
  if ! cleanup_restore_database; then
    exit 1
  fi
  exit 130
}

trap on_exit EXIT
trap on_signal HUP INT TERM

if ! (umask 077; set -C; printf '%s\n' CANDIDATE > "$marker_path"); then
  fail 'could not create exclusive restore cleanup marker'
fi
if ! infrastructure exec -T postgres sh -ec '
  createdb -U "$POSTGRES_USER" --template=template0 "$1"
' sh "$restore_database"; then
  fail 'createdb outcome is uncertain; cleanup marker retained'
fi
clone_created=true
printf '%s\n' OWNED > "$marker_path"

restore_started="$(date +%s)"
infrastructure exec -T postgres sh -ec '
  pg_restore -U "$POSTGRES_USER" --dbname="$1" --exit-on-error
' sh "$restore_database" < "$backup_path"

run_clone_role_boundary() {
  boundary_phase="$1"
  DATABASE_ROLE_BOUNDARY_PHASE="$boundary_phase" \
  DATABASE_ROLE_BOUNDARY_SCOPE=media \
  DATABASE_ROLE_BOUNDARY_DATABASE_OVERRIDE="$restore_database" \
    compose --profile migration run --rm --no-deps -T \
      -e RUNTIME_DATABASE_URL -e MIGRATOR_DATABASE_URL \
      -e DATABASE_ROLE_BOUNDARY_PHASE -e DATABASE_ROLE_BOUNDARY_SCOPE \
      -e DATABASE_ROLE_BOUNDARY_DATABASE_OVERRIDE \
      --entrypoint node migrator apps/migrator/dist/verify-role-boundary.js
  printf 'media_clone_role_boundary phase=%s scope=media status=passed\n' "$boundary_phase"
}

run_clone_runtime_probe() {
  MEDIA_RUNTIME_DATABASE_OVERRIDE="$restore_database" \
  MEDIA_RUNTIME_TENANT_KEY=local-padel \
    compose --profile migration run --rm --no-deps -T \
      -e RUNTIME_DATABASE_URL -e MEDIA_RUNTIME_DATABASE_OVERRIDE -e MEDIA_RUNTIME_TENANT_KEY \
      --entrypoint node migrator apps/migrator/dist/verify-media-runtime-role.js
  printf 'media_clone_runtime_role tenant_dml=passed cross_tenant_rls=passed rollback=confirmed status=passed\n'
}

run_clone_role_boundary pre

run_clone_migrator() {
  compose --profile migration run --rm \
    -e "PHUB_RESTORE_DATABASE=$restore_database" \
    -e 'PGOPTIONS=-c lock_timeout=5000 -c statement_timeout=600000 -c idle_in_transaction_session_timeout=600000' \
    --entrypoint sh migrator -ec '
      restore_database_url="$(node -e '\''
        const value = new URL(process.env.DATABASE_URL);
        value.pathname = `/${process.env.PHUB_RESTORE_DATABASE}`;
        process.stdout.write(value.toString());
      '\'')"
      DATABASE_URL="$restore_database_url" exec node apps/migrator/dist/main.js
    '
}

migration_started="$(date +%s)"
run_clone_migrator
migration_seconds=$(($(date +%s) - migration_started))
rerun_output="$(run_clone_migrator)"
test -z "$(printf '%s\n' "$rerun_output" | sed '/^[[:space:]]*$/d')" ||
  fail 'second candidate migrator invocation was not a no-op'
run_clone_role_boundary post
run_clone_runtime_probe

PHUB_APP_ROOT="$app_root" sh "$app_root/verify-media-migration-ledger.sh" \
  "$manifest_base64" "$restore_database"
restore_seconds=$(($(date +%s) - restore_started))

infrastructure exec -T postgres sh -ec '
  dropdb -U "$POSTGRES_USER" --force "$1"
' sh "$restore_database"
test "$(database_exists)" = 0 || fail 'restore database still exists after cleanup'
clone_created=false
rm -f "$marker_path"
trap - EXIT HUP INT TERM
printf 'media_migration_rehearsal database=%s duration_seconds=%s migration_seconds=%s rerun_applied=0 cleanup=confirmed status=passed\n' \
  "$restore_database" "$restore_seconds" "$migration_seconds"
