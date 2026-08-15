#!/bin/sh

set -eu

clone_database="${1:?clone database is required}"
tenant_keys="${2:?approved tenant keys are required}"
confirmation="${3:-}"
app_root="${PHUB_APP_ROOT:-/opt/phub}"
marker_root="${PHUB_FOUNDATION_CLONE_MARKER_ROOT:-$app_root/backups}"
candidate_release_env="${PHUB_CANDIDATE_RELEASE_ENV:-$app_root/release.env}"
runtime_database_url="${RUNTIME_DATABASE_URL:-}"
migrator_database_url="${MIGRATOR_DATABASE_URL:-}"

fail() {
  printf '%s\n' "Chat/push foundation clone verification refused: $*" >&2
  exit 1
}

test "$(printf '%s' "$clone_database$tenant_keys$confirmation" | tr -d '\r\n')" = \
  "$clone_database$tenant_keys$confirmation" || fail 'clone arguments must be single-line values'
test "$confirmation" = VERIFY_CHAT_PUSH_FOUNDATION_CLONE || fail 'exact confirmation is required'
case "$clone_database" in
  phub_foundation_[0-9]*) ;;
  *) fail 'clone database name is invalid' ;;
esac
case "$clone_database" in
  *[!a-z0-9_]*) fail 'clone database name is invalid' ;;
esac
printf '%s' "$tenant_keys" | grep -Eq '^[a-z0-9][a-z0-9-]{1,62}(,[a-z0-9][a-z0-9-]{1,62})*$' ||
  fail 'approved tenant keys are invalid'
test -n "$runtime_database_url" && test -n "$migrator_database_url" ||
  fail 'split database URLs are required'
test "$runtime_database_url" != "$migrator_database_url" || fail 'database roles are not split'
test -d "$app_root" && test -d "$marker_root" && test ! -L "$marker_root" ||
  fail 'clone verification paths are unsafe'
case "$candidate_release_env" in
  "$app_root"/release.env | "$app_root"/backups/releases/*/foundation.candidate-release.env) ;;
  *) fail 'candidate release env path is not bounded' ;;
esac
test -f "$candidate_release_env" && test ! -L "$candidate_release_env" ||
  fail 'candidate release env is absent or unsafe'
test "$(stat -c %a "$candidate_release_env")" = 600 ||
  fail 'candidate release env mode is not 0600'

cd "$app_root"

compose() {
  docker compose --env-file infrastructure.env --env-file "$candidate_release_env" "$@"
}

infrastructure() {
  docker compose --env-file infrastructure.env -f compose.infrastructure.yaml "$@"
}

marker="$marker_root/.foundation-clone-cleanup-$clone_database"
existing_marker="$(find "$marker_root" -maxdepth 1 \( -type f -o -type l \) \
  -name '.foundation-clone-cleanup-phub_foundation_*' -print -quit)"
test -z "$existing_marker" || fail 'an unresolved foundation clone marker exists'

clone_created=false
cleanup_clone() {
  if test "$clone_created" = true; then
    infrastructure exec -T postgres sh -ec \
      'dropdb --if-exists -U "$POSTGRES_USER" --maintenance-db=postgres "$1"' \
      sh "$clone_database" || {
        printf '%s\n' "foundation clone cleanup failed; marker retained: $marker" >&2
        return 1
      }
    clone_created=false
  fi
  if test -e "$marker" || test -L "$marker"; then
    marker_state="$(sed -n '1p' "$marker" 2>/dev/null || true)"
    if test "$marker_state" = CANDIDATE; then
      database_names="$(infrastructure exec -T postgres sh -ec \
        'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "select datname from pg_catalog.pg_database"')" || {
        printf '%s\n' "foundation clone creation is uncertain; marker retained: $marker" >&2
        return 1
      }
      if printf '%s\n' "$database_names" | grep -Fx "$clone_database" >/dev/null; then
        printf '%s\n' "foundation clone creation is uncertain; marker retained: $marker" >&2
        return 1
      fi
    fi
    rm -f "$marker"
  fi
}
on_exit() {
  status=$?
  trap - EXIT HUP INT TERM
  cleanup_clone || exit 1
  exit "$status"
}
on_signal() {
  trap - EXIT HUP INT TERM
  cleanup_clone || exit 1
  exit 130
}
trap on_exit EXIT
trap on_signal HUP INT TERM

existing_databases="$(infrastructure exec -T postgres sh -ec \
  'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "select datname from pg_catalog.pg_database"')"
printf '%s\n' "$existing_databases" | grep -Fx "$clone_database" >/dev/null &&
  fail 'foundation clone database already exists'
source_owner="$(infrastructure exec -T postgres sh -ec \
  'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "select pg_catalog.pg_get_userbyid(datdba) from pg_catalog.pg_database where datname = current_database()"')"
printf '%s' "$source_owner" | grep -Eq '^[A-Za-z_][A-Za-z0-9_$-]*$' || fail 'source database owner is invalid'

if ! (umask 077; set -C; printf '%s\n' CANDIDATE > "$marker"); then
  fail 'could not create the exclusive foundation clone marker'
fi
infrastructure exec -T postgres sh -ec \
  'createdb -U "$POSTGRES_USER" --maintenance-db=postgres --template="$POSTGRES_DB" --owner="$1" "$2"' \
  sh "$source_owner" "$clone_database"
clone_created=true
printf '%s\n' OWNED > "$marker"

rewrite_and_import='const clone = process.env.CHAT_PUSH_FOUNDATION_CLONE_DATABASE;
const rewrite = (value) => { const url = new URL(value); url.pathname = `/${clone}`; return url.toString(); };
process.env.RUNTIME_DATABASE_URL = rewrite(process.env.RUNTIME_DATABASE_URL);
process.env.MIGRATOR_DATABASE_URL = rewrite(process.env.MIGRATOR_DATABASE_URL);'

clone_role_verify() {
  role_phase="$1"
  RUNTIME_DATABASE_URL="$runtime_database_url" \
  MIGRATOR_DATABASE_URL="$migrator_database_url" \
  CHAT_PUSH_FOUNDATION_CLONE_DATABASE="$clone_database" \
  DATABASE_ROLE_BOUNDARY_PHASE="$role_phase" \
    compose --profile migration run --rm --no-deps -T \
      -e RUNTIME_DATABASE_URL -e MIGRATOR_DATABASE_URL \
      -e CHAT_PUSH_FOUNDATION_CLONE_DATABASE -e DATABASE_ROLE_BOUNDARY_PHASE \
      --entrypoint node migrator --input-type=module --eval \
      "$rewrite_and_import
       await import('./apps/migrator/dist/verify-role-boundary.js');"
}

clone_foundation_verify() {
  foundation_phase="$1"
  RUNTIME_DATABASE_URL="$runtime_database_url" \
  MIGRATOR_DATABASE_URL="$migrator_database_url" \
  CHAT_PUSH_FOUNDATION_CLONE_DATABASE="$clone_database" \
  CHAT_PUSH_FOUNDATION_PHASE="$foundation_phase" \
  CHAT_PUSH_FOUNDATION_TENANT_KEYS="$tenant_keys" \
  CHAT_PUSH_FOUNDATION_CAPTURE_CATALOG_BASELINE=true \
    compose --profile migration run --rm --no-deps -T \
      -e RUNTIME_DATABASE_URL -e MIGRATOR_DATABASE_URL \
      -e CHAT_PUSH_FOUNDATION_CLONE_DATABASE -e CHAT_PUSH_FOUNDATION_PHASE \
      -e CHAT_PUSH_FOUNDATION_TENANT_KEYS \
      -e CHAT_PUSH_FOUNDATION_CAPTURE_CATALOG_BASELINE \
      --entrypoint node migrator --input-type=module --eval \
      "$rewrite_and_import
       await import('./apps/migrator/dist/verify-chat-push-foundation.js');"
}

clone_migrate() {
  acknowledgement="$1"
  if test "$acknowledgement" = true; then
    migration_import="$rewrite_and_import
process.env.DATABASE_URL = process.env.MIGRATOR_DATABASE_URL;
process.env.MIGRATOR_ADVISORY_LOCK_TIMEOUT_MS = '30000';
process.env.CHAT_PUSH_FOUNDATION_MAINTENANCE_ACK = 'CHAT_PUSH_FOUNDATION_MAINTENANCE_V1';
await import('./apps/migrator/dist/main.js');"
  else
    migration_import="$rewrite_and_import
process.env.DATABASE_URL = process.env.MIGRATOR_DATABASE_URL;
process.env.MIGRATOR_ADVISORY_LOCK_TIMEOUT_MS = '30000';
delete process.env.CHAT_PUSH_FOUNDATION_MAINTENANCE_ACK;
await import('./apps/migrator/dist/main.js');"
  fi
  RUNTIME_DATABASE_URL="$runtime_database_url" \
  MIGRATOR_DATABASE_URL="$migrator_database_url" \
  CHAT_PUSH_FOUNDATION_CLONE_DATABASE="$clone_database" \
    compose --profile migration run --rm --no-deps -T \
      -e RUNTIME_DATABASE_URL -e MIGRATOR_DATABASE_URL -e CHAT_PUSH_FOUNDATION_CLONE_DATABASE \
      --entrypoint node migrator --input-type=module --eval "$migration_import"
}

clone_role_verify pre
pre_result="$(clone_foundation_verify pre)"
printf '%s\n' "$pre_result"
started_at="$(date +%s)"
if printf '%s' "$pre_result" | grep -Fq '"pendingFoundationCount":0'; then
  clone_migrate false
else
  clone_migrate true
fi
clone_role_verify post
post_result="$(clone_foundation_verify post)"
printf '%s\n' "$post_result"
catalog_digest="$(printf '%s\n' "$post_result" |
  sed -n 's/^.*"catalogDigest":"\([0-9a-f]\{64\}\)".*$/\1/p')"
printf '%s' "$catalog_digest" | grep -Eq '^[0-9a-f]{64}$' ||
  fail 'clone catalog digest is absent or invalid'
test "$(printf '%s\n' "$post_result" | grep -c '"catalogDigest"')" -eq 1 ||
  fail 'clone catalog digest is ambiguous'
clone_migrate false
elapsed_seconds="$(( $(date +%s) - started_at ))"

cleanup_clone
trap - EXIT HUP INT TERM
printf '%s\n' \
  "Chat/push foundation clone verified: elapsed_seconds=$elapsed_seconds catalog_digest=$catalog_digest"
