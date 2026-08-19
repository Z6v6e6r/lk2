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
staged_rehearsal=false
staged_contract_version=
case "${COMMUNITIES_STAGED_REHEARSAL_CONFIRMATION:-}" in
  '') ;;
  COMMUNITIES_STAGED_REHEARSAL_29_V1)
    staged_rehearsal=true
    staged_contract_version=29_V1
    ;;
  COMMUNITIES_STAGED_REHEARSAL_32_V1)
    fail '32_V1 is clone-evidence preparation only until a separately approved runtime ACL matrix exists'
    ;;
  COMMUNITIES_STAGED_REHEARSAL_33_V1)
    staged_rehearsal=true
    staged_contract_version=33_V1
    test -n "${COMMUNITIES_STAGED_REHEARSAL_ACL_MATRIX_VERSION:-}" ||
      fail '33_V1 requires an exact ACL matrix version'
    case "${COMMUNITIES_STAGED_REHEARSAL_ACL_MATRIX_SHA256:-}" in
      *[!0-9a-f]*|'') fail '33_V1 ACL matrix SHA is invalid' ;;
    esac
    test "${#COMMUNITIES_STAGED_REHEARSAL_ACL_MATRIX_SHA256}" -eq 64 ||
      fail '33_V1 ACL matrix SHA is invalid'
    ;;
  *) fail 'staged rehearsal confirmation is invalid' ;;
esac
test -n "${RUNTIME_DATABASE_URL:-}" || fail 'RUNTIME_DATABASE_URL is required'
test -n "${MIGRATOR_DATABASE_URL:-}" || fail 'MIGRATOR_DATABASE_URL is required'
app_root="${PHUB_APP_ROOT:-/opt/phub}"
backup_root="${PHUB_BACKUP_ROOT:-/opt/phub/backups}"
marker_root="${PHUB_RESTORE_MARKER_ROOT:-$backup_root}"
release_env="$app_root/release.env"
ledger_verifier="${PHUB_MEDIA_LEDGER_VERIFIER:-$app_root/verify-media-migration-ledger.sh}"
compose_file="${PHUB_REHEARSAL_COMPOSE_FILE:-}"
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
if test "$staged_rehearsal" = true; then
  case "$backup_path" in
    "$backup_root"/postgres-communities-rehearsal-*.dump) ;;
    *) fail 'staged backup path is outside the approved Communities backup namespace' ;;
  esac
else
  case "$backup_path" in
    "$backup_root"/postgres-pre-*.dump) ;;
    *) fail 'backup path is outside the approved PostgreSQL backup namespace' ;;
  esac
fi
test -f "$backup_path" && test ! -L "$backup_path" && test -s "$backup_path" ||
  fail 'backup archive is absent, empty or unsafe'
if test "$staged_rehearsal" = true; then
  case "${COMMUNITIES_STAGED_REHEARSAL_EXPECTED_BACKUP_SHA:-}" in
    *[!0-9a-f]*|'') fail 'staged backup SHA is invalid' ;;
  esac
  test "${#COMMUNITIES_STAGED_REHEARSAL_EXPECTED_BACKUP_SHA}" -eq 64 ||
    fail 'staged backup SHA is invalid'
  actual_backup_sha="$(sha256sum "$backup_path" | cut -d ' ' -f 1)"
  test "$actual_backup_sha" = "$COMMUNITIES_STAGED_REHEARSAL_EXPECTED_BACKUP_SHA" ||
    fail 'staged backup SHA does not match the approved evidence'
  case "${COMMUNITIES_STAGED_REHEARSAL_EXPECTED_SOURCE_LEDGER_SHA:-}" in
    *[!0-9a-f]*|'') fail 'staged source ledger SHA is invalid' ;;
  esac
  test "${#COMMUNITIES_STAGED_REHEARSAL_EXPECTED_SOURCE_LEDGER_SHA}" -eq 64 ||
    fail 'staged source ledger SHA is invalid'
  case "${COMMUNITIES_STAGED_REHEARSAL_EXPECTED_CANDIDATE_SHA:-}" in
    *[!0-9a-f]*|'') fail 'staged candidate SHA is invalid' ;;
  esac
  test "${#COMMUNITIES_STAGED_REHEARSAL_EXPECTED_CANDIDATE_SHA}" -eq 40 ||
    fail 'staged candidate SHA is invalid'
  case "${COMMUNITIES_STAGED_REHEARSAL_EXPECTED_MIGRATOR_DIGEST:-}" in
    sha256:[0-9a-f]*) ;;
    *) fail 'staged migrator image digest is invalid' ;;
  esac
  test "${#COMMUNITIES_STAGED_REHEARSAL_EXPECTED_MIGRATOR_DIGEST}" -eq 71 ||
    fail 'staged migrator image digest is invalid'
  release_env="${PHUB_REHEARSAL_RELEASE_ENV:-}"
  case "$release_env" in
    "$app_root"/release.communities-rehearsal-*.env) ;;
    *) fail 'staged release environment path is outside the approved namespace' ;;
  esac
  test -f "$release_env" && test ! -L "$release_env" ||
    fail 'staged release environment is absent or unsafe'
  test "$(stat -c %u "$release_env")" -eq 0 ||
    fail 'staged release environment must be root-owned'
  case "$(stat -c %a "$release_env")" in
    400|440|600|640) ;;
    *) fail 'staged release environment mode is unsafe' ;;
  esac
  release_candidate="$(sed -n 's/^RELEASE=//p' "$release_env")"
  release_migrator_digest="$(sed -n 's/^MIGRATOR_IMAGE_DIGEST=//p' "$release_env")"
  test "$(grep -c '^RELEASE=' "$release_env")" -eq 1 ||
    fail 'staged release environment has an ambiguous release'
  test "$(grep -c '^MIGRATOR_IMAGE_DIGEST=' "$release_env")" -eq 1 ||
    fail 'staged release environment has an ambiguous migrator digest'
  test "$release_candidate" = "$COMMUNITIES_STAGED_REHEARSAL_EXPECTED_CANDIDATE_SHA" ||
    fail 'staged release environment candidate SHA does not match'
  test "$release_migrator_digest" = \
    "$COMMUNITIES_STAGED_REHEARSAL_EXPECTED_MIGRATOR_DIGEST" ||
    fail 'staged release environment migrator digest does not match'
fi
case "$restore_database" in
  phub_restore_*) ;;
  *) fail 'restore database name is malformed' ;;
esac
restore_suffix="${restore_database#phub_restore_}"
case "$restore_suffix" in
  '' | _* | *_ | *__* | *[!0-9_]*) fail 'restore database name is malformed' ;;
esac

compose() {
  if test -n "$compose_file"; then
    docker compose --env-file infrastructure.env --env-file "$app_root/release.env" \
      --env-file "$release_env" -f "$compose_file" "$@"
  else
    docker compose --env-file infrastructure.env --env-file "$release_env" "$@"
  fi
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

if test "$staged_rehearsal" = true; then
  compose pull migrator
  staged_migrator_image="$(compose --profile migration config --images | grep -F "/phub-migrator@$COMMUNITIES_STAGED_REHEARSAL_EXPECTED_MIGRATOR_DIGEST" || true)"
  test -n "$staged_migrator_image" || fail 'staged migrator image is not digest-pinned in Compose'
  test "$(printf '%s\n' "$staged_migrator_image" | wc -l | tr -d ' ')" -eq 1 ||
    fail 'staged migrator image resolution is ambiguous'
  docker image inspect "$staged_migrator_image" >/dev/null 2>&1 ||
    fail 'staged migrator image is not present after pull'
  archive_toc="$(infrastructure exec -T postgres pg_restore --list < "$backup_path")"
  printf '%s\n' "$archive_toc" | awk '
    $4 == "TABLE" && $5 == "profile" && $6 == "privacy_commands" && $7 != "-" { found = 1 }
    END { exit found ? 0 : 1 }
  ' || fail 'staged archive does not preserve the profile privacy owner'
  printf '%s\n' "$archive_toc" | awk '
    $4 == "ACL" && $5 == "-" { found = 1 }
    END { exit found ? 0 : 1 }
  ' || fail 'staged archive does not contain ACL entries'
  printf '%s\n' "$archive_toc" | awk '
    $4 == "DEFAULT" && $5 == "ACL" { found = 1 }
    END { exit found ? 0 : 1 }
  ' || fail 'staged archive does not contain default ACL entries'
fi

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

if test "$staged_rehearsal" = true; then
  restored_source_ledger_manifest="$(infrastructure exec -T postgres sh -ec '
    export PGOPTIONS="-c default_transaction_read_only=on -c statement_timeout=15000 -c lock_timeout=2000 -c search_path=pg_catalog"
    psql -X -U "$POSTGRES_USER" -d "$1" -v ON_ERROR_STOP=1 -At -F "|" \
      -c "select filename, checksum from public.schema_migrations order by filename"
  ' sh "$restore_database")"
  test -n "$restored_source_ledger_manifest" || fail 'restored source ledger is empty'
  restored_source_ledger_sha="$(printf '%s\n' "$restored_source_ledger_manifest" |
    sha256sum | cut -d ' ' -f 1)"
  test "$restored_source_ledger_sha" = \
    "$COMMUNITIES_STAGED_REHEARSAL_EXPECTED_SOURCE_LEDGER_SHA" ||
    fail 'restored source ledger does not match the approved backup evidence'
fi

authoritative_privacy_missing_count() {
  privacy_missing_count="$(infrastructure exec -T postgres sh -ec '
    export PGOPTIONS="-c default_transaction_read_only=on -c statement_timeout=15000 -c lock_timeout=2000 -c search_path=pg_catalog"
    psql -X -qAt -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$1" -c "
      select pg_catalog.count(*)
        from profile.privacy_commands
       where not (result_payload ? '\''visibilityMode'\'')
          or not (result_payload ? '\''sections'\'')
    "
  ' sh "$restore_database")"
  case "$privacy_missing_count" in
    *[!0-9]*|'') fail 'authoritative privacy command audit is invalid' ;;
  esac
  printf '%s' "$privacy_missing_count"
}

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

measure_community_media_quota_indexes() {
  for quota_index in \
    community_media_actor_outstanding_quota_idx \
    community_media_actor_daily_bytes_quota_idx \
    community_media_actor_pipeline_quota_idx \
    community_media_tenant_pipeline_quota_idx
  do
    measurement_duration_ms="$(infrastructure exec -T postgres sh -ec '
      export PGOPTIONS="-c lock_timeout=5000 -c statement_timeout=600000 -c idle_in_transaction_session_timeout=600000"
      psql -X -qAt -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$1" <<SQL
select pg_catalog.clock_timestamp() as measurement_started \gset
begin;
reindex index community_content.$2;
rollback;
select pg_catalog.round(
  pg_catalog.extract(epoch from pg_catalog.clock_timestamp() - :'"'"'measurement_started'"'"'::pg_catalog.timestamptz) * 1000
)::pg_catalog.bigint;
SQL
    ' sh "$restore_database" "$quota_index")"
    case "$measurement_duration_ms" in
      *[!0-9]*|'') fail 'quota index measurement duration is invalid' ;;
    esac
    printf 'community_media_quota_index_measurement index=%s operation=reindex duration_ms=%s rollback=confirmed status=passed\n' \
      "$quota_index" "$measurement_duration_ms"
  done
}

run_clone_role_boundary pre
if test "$staged_rehearsal" = true; then
  privacy_missing_before="$(authoritative_privacy_missing_count)"
fi

run_clone_migrator() {
  rehearsal_phase="${1:-}"
  if test -n "$rehearsal_phase"; then
    COMMUNITIES_STAGED_REHEARSAL_PHASE="$rehearsal_phase" \
    compose --profile migration run --rm \
      -e COMMUNITIES_STAGED_REHEARSAL_CONFIRMATION \
      -e COMMUNITIES_STAGED_REHEARSAL_PHASE \
      -e COMMUNITIES_STAGED_REHEARSAL_ACL_MATRIX_VERSION \
      -e COMMUNITIES_STAGED_REHEARSAL_ACL_MATRIX_SHA256 \
      -e "PHUB_RESTORE_DATABASE=$restore_database" \
      -e 'PGOPTIONS=-c lock_timeout=5000 -c statement_timeout=600000 -c idle_in_transaction_session_timeout=600000' \
      --entrypoint sh migrator -ec '
        restore_database_url="$(node -e '\''
          const value = new URL(process.env.DATABASE_URL);
          value.pathname = `/${process.env.PHUB_RESTORE_DATABASE}`;
          process.stdout.write(value.toString());
        '\'')"
        DATABASE_URL="$restore_database_url" exec node apps/migrator/dist/communities-staged-rehearsal.js
      '
    return
  fi
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

run_eligibility_acl_command() {
  entrypoint="$1"
  boundary_phase="$2"
  ELIGIBILITY_PAYMENT_ACL_PHASE="$boundary_phase" \
    compose --profile migration run --rm --no-deps -T \
      -e RUNTIME_DATABASE_URL \
      -e ELIGIBILITY_PAYMENT_ACL_PHASE \
      -e "ELIGIBILITY_PAYMENT_ACL_MATRIX_VERSION=$COMMUNITIES_STAGED_REHEARSAL_ACL_MATRIX_VERSION" \
      -e "ELIGIBILITY_PAYMENT_ACL_MATRIX_SHA256=$COMMUNITIES_STAGED_REHEARSAL_ACL_MATRIX_SHA256" \
      -e "PHUB_RESTORE_DATABASE=$restore_database" \
      --entrypoint sh migrator -ec '
        entrypoint="$1"
        restore_database="$PHUB_RESTORE_DATABASE"
        migrator_database_url="$(node -e '\''
          const value = new URL(process.env.DATABASE_URL);
          value.pathname = `/${process.env.PHUB_RESTORE_DATABASE}`;
          process.stdout.write(value.toString());
        '\'')"
        runtime_database_url="$(node -e '\''
          const value = new URL(process.env.RUNTIME_DATABASE_URL);
          value.pathname = `/${process.env.PHUB_RESTORE_DATABASE}`;
          process.stdout.write(value.toString());
        '\'')"
        DATABASE_URL="$migrator_database_url" RUNTIME_DATABASE_URL="$runtime_database_url" \
          DATABASE_RUNTIME_ROLE="$(node -e '\''
            process.stdout.write(decodeURIComponent(new URL(process.env.RUNTIME_DATABASE_URL).username));
          '\'')" exec node "$entrypoint"
      ' sh "$entrypoint"
}

run_cup_projection_rehearsal() {
  rehearsal_mode="$1"
  CUP_PLAYER_LEVEL_PROJECTION_REHEARSAL_MODE="$rehearsal_mode" \
    compose --profile migration run --rm --no-deps -T \
      -e RUNTIME_DATABASE_URL \
      -e CUP_PLAYER_LEVEL_PROJECTION_REHEARSAL_MODE \
      -e "PHUB_RESTORE_DATABASE=$restore_database" \
      --entrypoint sh migrator -ec '
        migrator_database_url="$(node -e '\''
          const value = new URL(process.env.DATABASE_URL);
          value.pathname = `/${process.env.PHUB_RESTORE_DATABASE}`;
          process.stdout.write(value.toString());
        '\'')"
        runtime_database_url="$(node -e '\''
          const value = new URL(process.env.RUNTIME_DATABASE_URL);
          value.pathname = `/${process.env.PHUB_RESTORE_DATABASE}`;
          process.stdout.write(value.toString());
        '\'')"
        DATABASE_URL="$migrator_database_url" RUNTIME_DATABASE_URL="$runtime_database_url" \
          exec node apps/migrator/dist/cup-player-level-projection-rehearsal.js
      '
}

migration_started="$(date +%s)"
if test "$staged_rehearsal" = true; then
  expected_pre_foundation_output='Applied 0053_profile_visibility_sections.sql
Applied 0054_community_membership_pin_commands.sql
Applied 0055_community_create_commands.sql
Applied 0056_community_discovery_indexes.sql
Applied 0057_community_membership_lifecycle.sql
Applied 0058_community_direct_invites.sql
Applied 0059_community_direct_invite_quotas.sql
Applied 0060_viva_home_booking_ownership.sql
Applied 0061_community_mine_keyset_index.sql
Applied 0062_community_ownership_transfers.sql
Applied 0063_community_content_foundation.sql
Applied 0064_community_durable_events.sql
Applied 0065_community_content_moderation.sql
Applied 0066_community_member_count_projection.sql
Applied 0067_community_media_lifecycle.sql
Applied 0068_community_event_retention.sql'
  expected_foundation_output='Applied 0069_booking_notification_projection_fence.sql
Applied 0070_web_push_endpoint_hardening.sql
Applied 0071_messaging_user_blocks.sql
Applied 0072_web_push_endpoint_status_validation.sql
Applied 0073_booking_reminder_scheduler.sql'
  expected_post_foundation_output='Applied 0076_community_create_quota_grants.sql
Applied 0077_community_media_operational_recovery.sql
Applied 0078_community_media_issue_quotas.sql
Applied 0079_profile_photo_client_assisted_source.sql
Applied 0080_community_logo_stable_delivery.sql
Applied 0081_community_logo_stable_delivery_validate.sql
Applied 0082_profile_photo_removal_commands.sql
Applied 0083_profile_photo_removal_commands_validate.sql'
  pre_foundation_output="$(run_clone_migrator pre_foundation)"
  test "$pre_foundation_output" = "$expected_pre_foundation_output" ||
    fail 'pre-foundation stage did not apply the exact 16-file plan'
  foundation_output="$(run_clone_migrator foundation)"
  test "$foundation_output" = "$expected_foundation_output" ||
    fail 'foundation stage did not apply the exact 5-file plan'
  post_foundation_output="$(run_clone_migrator post_foundation)"
  test "$post_foundation_output" = "$expected_post_foundation_output" ||
    fail 'post-foundation stage did not apply the exact 8-file plan'
  if test "$staged_contract_version" = 33_V1; then
    pre_acl_output="$(run_eligibility_acl_command apps/migrator/dist/provision-eligibility-payment-cup-projection-acl.js pre)"
    test "$pre_acl_output" = ELIGIBILITY_PAYMENT_ACL_PRE_PROVISIONED ||
      fail '33_V1 pre-migration ACL provisioning failed'
    pre_acl_verify_output="$(run_eligibility_acl_command apps/migrator/dist/verify-eligibility-payment-acl-boundary.js pre)"
    test "$pre_acl_verify_output" = \
      "ELIGIBILITY_PAYMENT_ACL_PRE_READY matrix=$COMMUNITIES_STAGED_REHEARSAL_ACL_MATRIX_VERSION:$COMMUNITIES_STAGED_REHEARSAL_ACL_MATRIX_SHA256" ||
      fail '33_V1 pre-migration ACL verification failed'
    fixture_output="$(run_cup_projection_rehearsal prepare)"
    test "$fixture_output" = 'CUP_PLAYER_LEVEL_PROJECTION_REHEARSAL_PREPARED tenants=2' ||
      fail '33_V1 clone fixture preparation failed'
    expected_eligibility_payment_output='Applied 0084_participation_level_eligibility.sql
Applied 0085_game_payment_confirmation_evidence.sql
Applied 0086_game_payment_provider_exercise_binding.sql'
    eligibility_payment_output="$(run_clone_migrator eligibility_payment)"
    test "$eligibility_payment_output" = "$expected_eligibility_payment_output" ||
      fail 'eligibility/payment stage did not apply the exact 3-file plan'
    cup_projection_output="$(run_clone_migrator cup_projection)"
    test "$cup_projection_output" = 'Applied 0087_cup_player_level_projection.sql' ||
      fail 'CUP projection stage did not apply the exact 1-file plan'
    post_acl_output="$(run_eligibility_acl_command apps/migrator/dist/provision-eligibility-payment-cup-projection-acl.js post)"
    test "$post_acl_output" = ELIGIBILITY_PAYMENT_ACL_POST_PROVISIONED ||
      fail '33_V1 post-migration ACL provisioning failed'
    post_acl_verify_output="$(run_eligibility_acl_command apps/migrator/dist/verify-eligibility-payment-acl-boundary.js post)"
    test "$post_acl_verify_output" = \
      "ELIGIBILITY_PAYMENT_ACL_POST_READY matrix=$COMMUNITIES_STAGED_REHEARSAL_ACL_MATRIX_VERSION:$COMMUNITIES_STAGED_REHEARSAL_ACL_MATRIX_SHA256" ||
      fail '33_V1 post-migration ACL verification failed'
    cup_projection_probe_output="$(run_cup_projection_rehearsal probe)"
    test "$cup_projection_probe_output" = \
      'CUP_PLAYER_LEVEL_PROJECTION_REHEARSAL_PROBE apply=passed replay=passed idempotency=passed cross_tenant_rls=passed' ||
      fail '33_V1 CUP projection runtime probe failed'
    printf 'eligibility_payment_acl matrix=%s pre=passed post=passed privileges=exact status=passed\n' \
      "$COMMUNITIES_STAGED_REHEARSAL_ACL_MATRIX_VERSION"
    printf '%s\n' \
      'cup_player_level_projection_clone_probe apply=passed replay=passed idempotency=passed cross_tenant_rls=passed status=passed'
  fi
else
  run_clone_migrator
fi
migration_seconds=$(($(date +%s) - migration_started))
rerun_output="$(run_clone_migrator)"
test -z "$(printf '%s\n' "$rerun_output" | sed '/^[[:space:]]*$/d')" ||
  fail 'second candidate migrator invocation was not a no-op'
if test "$staged_rehearsal" = true; then
  privacy_missing_after="$(authoritative_privacy_missing_count)"
  test "$privacy_missing_after" -eq 0 ||
    fail 'profile privacy payload backfill is incomplete after staged migration'
  printf 'communities_profile_privacy_audit missing_before=%s missing_after=0 authority=postgres_superuser status=passed\n' \
    "$privacy_missing_before"
fi
run_clone_role_boundary post
run_clone_runtime_probe

test -f "$ledger_verifier" && test ! -L "$ledger_verifier" ||
  fail 'media migration ledger verifier is absent or unsafe'
PHUB_APP_ROOT="$app_root" sh "$ledger_verifier" \
  "$manifest_base64" "$restore_database"
if test "$staged_rehearsal" = true; then
  measure_community_media_quota_indexes
fi
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
if test "$staged_rehearsal" = true; then
  if test "$staged_contract_version" = 33_V1; then
    printf 'communities_staged_migration_rehearsal database=%s contract=33_V1 pre_foundation=16 foundation=5 post_foundation=8 eligibility_payment=3 cup_projection=1 acl_matrix=%s projection_probe=passed quota_index_measurements=4 source_ledger_sha=%s cleanup=confirmed status=passed\n' \
      "$restore_database" "$COMMUNITIES_STAGED_REHEARSAL_ACL_MATRIX_VERSION" \
      "$restored_source_ledger_sha"
  else
    printf 'communities_staged_migration_rehearsal database=%s pre_foundation=16 foundation=5 post_foundation=8 quota_index_measurements=4 source_ledger_sha=%s cleanup=confirmed status=passed\n' \
      "$restore_database" "$restored_source_ledger_sha"
  fi
fi
