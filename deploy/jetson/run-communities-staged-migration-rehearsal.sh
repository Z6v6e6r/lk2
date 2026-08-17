#!/usr/bin/env sh
set -eu

fail() {
  printf '%s\n' "Communities staged rehearsal refused: $*" >&2
  exit 1
}

original_command=${SSH_ORIGINAL_COMMAND:-}
test -n "$original_command" || fail 'exact SSH original command is required'
set -f
previous_ifs=$IFS
IFS=' '
set -- $original_command
IFS=$previous_ifs
set +f

confirmation=${1:-}
expected_contract_version=${2:-}
expected_pending_set_sha=${3:-}
expected_active_release=${4:-}
expected_source_ledger_sha=${5:-}
expected_target_database=${6:-}
expected_system_identifier=${7:-}
expected_candidate_sha=${8:-}
expected_migrator_digest=${9:-}
expected_release_env_sha=${10:-}
expected_compose_sha=${11:-}
expected_manifest_sha=${12:-}
manifest_base64=${13:-}
expected_wrapper_sha=${14:-}
expected_rehearsal_sha=${15:-}
expected_ledger_verifier_sha=${16:-}
expected_restore_helper_sha=${17:-}

case "$confirmation" in
  REHEARSE_COMMUNITIES_STAGING_29_V1) ;;
  REHEARSE_COMMUNITIES_STAGING_32_V1)
    fail '32_V1 is clone-evidence preparation only until a separately approved runtime ACL matrix exists'
    ;;
  *) fail 'exact staged rehearsal confirmation is required' ;;
esac
test "$#" -eq 17 || fail 'exact staged rehearsal binding tuple is required'
test "$expected_contract_version" = 29_V1 || fail 'staged rehearsal contract version is invalid'
test "$expected_pending_set_sha" = 13b5ca1d0930fdc4b67852f01418c27f8946f538f2311d7e5f755ecb2df12747 ||
  fail 'staged rehearsal pending set binding is invalid'

validate_hex() {
  value=$1
  length=$2
  label=$3
  case "$value" in ''|*[!0-9a-f]*) fail "$label is invalid" ;; esac
  test "${#value}" -eq "$length" || fail "$label is invalid"
}

validate_hex "$expected_active_release" 40 'active release binding'
validate_hex "$expected_pending_set_sha" 64 'pending set binding'
validate_hex "$expected_source_ledger_sha" 64 'source ledger binding'
validate_hex "$expected_candidate_sha" 40 'candidate release binding'
validate_hex "$expected_release_env_sha" 64 'candidate release file binding'
validate_hex "$expected_compose_sha" 64 'candidate Compose binding'
validate_hex "$expected_manifest_sha" 64 'migration manifest binding'
validate_hex "$expected_wrapper_sha" 64 'wrapper command binding'
validate_hex "$expected_rehearsal_sha" 64 'rehearsal command binding'
validate_hex "$expected_ledger_verifier_sha" 64 'ledger verifier binding'
validate_hex "$expected_restore_helper_sha" 64 'restore helper binding'
case "$expected_migrator_digest" in sha256:[0-9a-f]*) ;; *) fail 'migrator digest binding is invalid' ;; esac
test "${#expected_migrator_digest}" -eq 71 || fail 'migrator digest binding is invalid'
case "$expected_target_database" in
  ''|[!a-zA-Z_]*|*[!a-zA-Z0-9_-]*) fail 'target database binding is invalid' ;;
esac
test "${#expected_target_database}" -le 63 || fail 'target database binding is invalid'
case "$expected_system_identifier" in ''|*[!0-9]*) fail 'system identifier binding is invalid' ;; esac
case "$manifest_base64" in ''|*[!A-Za-z0-9+/=]*) fail 'migration manifest encoding is invalid' ;; esac

app_root=${PHUB_APP_ROOT:-/opt/phub}
backup_root=${PHUB_REHEARSAL_BACKUP_ROOT:-/var/lib/phub-preflight/backups}
storage_path=${PHUB_POSTGRES_STORAGE_PATH:-/var/lib/docker}
rehearsal_command=${PHUB_REHEARSAL_COMMAND:-/usr/local/libexec/phub/rehearse-media-migration.sh}
ledger_verifier=${PHUB_MEDIA_LEDGER_VERIFIER:-/usr/local/libexec/phub/verify-media-migration-ledger.sh}
restore_helper=${PHUB_RESTORE_HELPER:-/usr/local/libexec/phub/verify-postgres-backup-restore.sh}
runtime_env=${PHUB_RUNTIME_ENV:-/etc/phub/staging.env}
migrator_env=${PHUB_MIGRATOR_ENV:-/etc/phub/staging.migrator.env}
release_env="$app_root/release.communities-rehearsal-$expected_candidate_sha.env"
compose_file="$app_root/compose.communities-rehearsal-$expected_candidate_sha.yaml"

validate_root_command() {
  command_path="$(readlink -f "$1")"
  test -f "$command_path" && test ! -L "$command_path" || fail 'installed command is absent or unsafe'
  test "$(stat -c %u "$command_path")" -eq 0 || fail 'installed command is not root-owned'
  case "$(stat -c %a "$command_path")" in 700|744|755) ;; *) fail 'installed command mode is unsafe' ;; esac
  printf '%s' "$command_path"
}

wrapper_path="$(validate_root_command "$0")"
if test "${PHUB_REHEARSAL_TIMEOUT_ACTIVE:-}" != 1; then
  exec /usr/bin/timeout --signal=TERM --kill-after=30s 180m \
    /usr/bin/env PHUB_REHEARSAL_TIMEOUT_ACTIVE=1 "$wrapper_path" "$@"
fi
rehearsal_command="$(validate_root_command "$rehearsal_command")"
ledger_verifier="$(validate_root_command "$ledger_verifier")"
restore_helper="$(validate_root_command "$restore_helper")"

actual_wrapper_sha="$(sha256sum "$wrapper_path" | cut -d ' ' -f 1)"
actual_rehearsal_sha="$(sha256sum "$rehearsal_command" | cut -d ' ' -f 1)"
actual_ledger_verifier_sha="$(sha256sum "$ledger_verifier" | cut -d ' ' -f 1)"
actual_restore_helper_sha="$(sha256sum "$restore_helper" | cut -d ' ' -f 1)"
test "$actual_wrapper_sha" = "$expected_wrapper_sha" || fail 'installed wrapper does not match the requested release'
test "$actual_rehearsal_sha" = "$expected_rehearsal_sha" || fail 'installed rehearsal command does not match the requested release'
test "$actual_ledger_verifier_sha" = "$expected_ledger_verifier_sha" || fail 'installed ledger verifier does not match the requested release'
test "$actual_restore_helper_sha" = "$expected_restore_helper_sha" || fail 'installed restore helper does not match the requested release'

decoded_manifest="$(printf '%s' "$manifest_base64" | base64 -d)" ||
  fail 'migration manifest could not be decoded'
test -n "$decoded_manifest" || fail 'migration manifest is empty'
canonical_manifest_base64="$(printf '%s\n' "$decoded_manifest" | base64 -w 0)"
test "$canonical_manifest_base64" = "$manifest_base64" || fail 'migration manifest encoding is not canonical'
printf '%s\n' "$decoded_manifest" | awk -F '|' '
  NF != 2 || $1 !~ /^[0-9a-f]{64}$/ || $2 !~ /^[0-9]{4}_[A-Za-z0-9_]+[.]sql$/ { exit 1 }
' || fail 'migration manifest contents are invalid'
actual_manifest_sha="$(printf '%s\n' "$decoded_manifest" | sha256sum | cut -d ' ' -f 1)"
test "$actual_manifest_sha" = "$expected_manifest_sha" || fail 'migration manifest does not match the requested release'

validate_readonly_input() {
  test -e "$1" && test ! -L "$1" && test ! -w "$1" || fail "staging input is absent or writable: $1"
  test "$(stat -c %u "$1")" -ne "$(id -u)" || fail "staging input is owned by the forced-command principal: $1"
}

validate_readonly_input "$app_root"
validate_readonly_input "$app_root/infrastructure.env"
validate_readonly_input "$app_root/compose.infrastructure.yaml"
validate_readonly_input "$app_root/release.env"
validate_readonly_input "$runtime_env"
validate_readonly_input "$migrator_env"
validate_readonly_input "$release_env"
validate_readonly_input "$compose_file"
test -f "$release_env" || fail 'candidate rehearsal release file is not a regular file'
test -f "$compose_file" || fail 'candidate rehearsal Compose file is not a regular file'
test "$(stat -c %u "$release_env")" -eq 0 || fail 'candidate rehearsal release file is not root-owned'
test "$(stat -c %u "$compose_file")" -eq 0 || fail 'candidate rehearsal Compose file is not root-owned'
case "$(stat -c %a "$release_env")" in 400|440|600|640) ;; *) fail 'candidate rehearsal release file mode is unsafe' ;; esac
case "$(stat -c %a "$compose_file")" in 400|440|444|600|640|644) ;; *) fail 'candidate rehearsal Compose file mode is unsafe' ;; esac

release_candidate="$(sed -n 's/^RELEASE=//p' "$release_env")"
release_migrator_digest="$(sed -n 's/^MIGRATOR_IMAGE_DIGEST=//p' "$release_env")"
test "$(grep -c '^RELEASE=' "$release_env")" -eq 1 || fail 'candidate rehearsal release is ambiguous'
test "$(grep -c '^MIGRATOR_IMAGE_DIGEST=' "$release_env")" -eq 1 || fail 'candidate rehearsal migrator digest is ambiguous'
test "$(wc -l < "$release_env" | tr -d ' ')" -eq 2 || fail 'candidate rehearsal release file must contain exactly two bindings'
grep -Eq '^RELEASE=[0-9a-f]{40}$' "$release_env" || fail 'candidate rehearsal release binding is malformed'
grep -Eq '^MIGRATOR_IMAGE_DIGEST=sha256:[0-9a-f]{64}$' "$release_env" || fail 'candidate rehearsal migrator binding is malformed'
test "$release_candidate" = "$expected_candidate_sha" || fail 'candidate rehearsal release does not match'
test "$release_migrator_digest" = "$expected_migrator_digest" || fail 'candidate rehearsal migrator digest does not match'
actual_release_env_sha="$(sha256sum "$release_env" | cut -d ' ' -f 1)"
test "$actual_release_env_sha" = "$expected_release_env_sha" || fail 'candidate rehearsal release file does not match'
actual_compose_sha="$(sha256sum "$compose_file" | cut -d ' ' -f 1)"
test "$actual_compose_sha" = "$expected_compose_sha" || fail 'candidate rehearsal Compose file does not match'

secret_root=${PHUB_SECRET_ROOT:-/etc/phub}
test -d "$secret_root" && test ! -L "$secret_root" && test -x "$secret_root" ||
  fail 'runtime-secret transition root is not safely inspectable'
for artifact in \
  "$secret_root/.runtime-secret-isolation.transition.json" \
  "$secret_root/.runtime-secret-isolation.transition.json.next" \
  "$secret_root/.runtime-secret-isolation.staging.backup" \
  "$secret_root/.runtime-secret-isolation.staging.next" \
  "$secret_root/.runtime-secret-isolation.realtime.next" \
  "$app_root/.runtime-secret-isolation.compose.backup" \
  "$app_root/.runtime-secret-isolation.compose.next" \
  "$app_root/.runtime-secret-bootstrap.compose.next" \
  "$app_root/.runtime-secret-bootstrap.release.next"; do
  test ! -e "$artifact" && test ! -L "$artifact" || fail 'unresolved runtime-secret transition blocks rehearsal'
done

test -d "$backup_root" && test ! -L "$backup_root" || fail 'rehearsal backup root is absent or unsafe'
test "$(stat -c %u "$backup_root")" -eq "$(id -u)" || fail 'rehearsal backup root has the wrong owner'
test "$(stat -c %a "$backup_root")" = 700 || fail 'rehearsal backup root mode is unsafe'

database_url_from() {
  input=$1
  test "$(grep -c '^DATABASE_URL=' "$input")" -eq 1 || fail 'database role input is ambiguous'
  sed -n 's/^DATABASE_URL=//p' "$input"
}
runtime_database_url="$(database_url_from "$runtime_env")"
migrator_database_url="$(database_url_from "$migrator_env")"
test "$runtime_database_url" != "$migrator_database_url" || fail 'runtime and migrator database roles must differ'

cd "$app_root"
infrastructure() {
  docker compose --env-file infrastructure.env -f compose.infrastructure.yaml "$@"
}
candidate_compose() {
  docker compose --env-file infrastructure.env --env-file "$app_root/release.env" \
    --env-file "$release_env" -f "$compose_file" "$@"
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
source_release() {
  sed -n 's/^RELEASE=//p' "$app_root/release.env"
}
assert_source_binding() {
  observed_manifest="$(source_ledger_manifest)"
  test -n "$observed_manifest" || fail 'source ledger is empty'
  observed_ledger_sha="$(printf '%s\n' "$observed_manifest" | sha256sum | cut -d ' ' -f 1)"
  observed_identity="$(source_identity_manifest)"
  test "$(printf '%s\n' "$observed_identity" | wc -l | tr -d ' ')" -eq 2 || fail 'source identity is invalid'
  observed_database="$(printf '%s\n' "$observed_identity" | sed -n '1p')"
  observed_system_identifier="$(printf '%s\n' "$observed_identity" | sed -n '2p')"
  observed_release="$(source_release)"
  test "$observed_release" = "$expected_active_release" && \
    test "$observed_ledger_sha" = "$expected_source_ledger_sha" && \
    test "$observed_database" = "$expected_target_database" && \
    test "$observed_system_identifier" = "$expected_system_identifier" ||
    fail 'source no longer matches the inventory binding'
  source_manifest_bound=$observed_manifest
  source_identity_bound=$observed_identity
}

# Every trust, artifact and target check above is read-only. Filesystem/database mutation starts here.
assert_source_binding
source_manifest_before=$source_manifest_bound
source_identity_before=$source_identity_bound

candidate_compose pull migrator >/dev/null 2>&1 || fail 'candidate migrator image pull failed'
candidate_migrator_image="$(candidate_compose --profile migration config --images | grep -F "/phub-migrator@$expected_migrator_digest" || true)"
test -n "$candidate_migrator_image" || fail 'candidate migrator image is not digest-pinned in Compose'
test "$(printf '%s\n' "$candidate_migrator_image" | wc -l | tr -d ' ')" -eq 1 ||
  fail 'candidate migrator image resolution is ambiguous'
docker image inspect "$candidate_migrator_image" >/dev/null 2>&1 || fail 'candidate migrator image is unavailable'
assert_source_binding
test "$source_manifest_before" = "$source_manifest_bound" && test "$source_identity_before" = "$source_identity_bound" ||
  fail 'source changed while the candidate image was prepared'

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
restore_database="phub_restore_$(date -u +%s)_$$"
backup_path="$backup_root/postgres-communities-rehearsal-$timestamp-$$.dump"
backup_tmp=
rehearsal_stdout=
rehearsal_stderr=
backup_retained=false
backup_path_created=false
cleanup() {
  test -z "$backup_tmp" || rm -f "$backup_tmp"
  test -z "$rehearsal_stdout" || rm -f "$rehearsal_stdout"
  test -z "$rehearsal_stderr" || rm -f "$rehearsal_stderr"
  if test "$backup_path_created" = true && test "$backup_retained" != true; then
    rm -f "$backup_path"
  fi
}
on_signal() {
  trap - EXIT HUP INT TERM
  cleanup
  exit 130
}
trap cleanup EXIT
trap on_signal HUP INT TERM

capacity_summary="$(PHUB_APP_ROOT="$app_root" PHUB_RESTORE_MARKER_ROOT="$backup_root" \
  PHUB_POSTGRES_STORAGE_PATH="$storage_path" \
  sh "$restore_helper" - "$restore_database" VERIFY_STAGING_POSTGRES_CAPACITY)"
test -n "$capacity_summary" || fail 'restore capacity evidence is empty'

umask 077
backup_tmp="$(mktemp "$backup_root/.postgres-communities-rehearsal.XXXXXX.dump")"
dump_started="$(date +%s)"
infrastructure exec -T postgres sh -ec \
  'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom' > "$backup_tmp"
dump_seconds="$(( $(date +%s) - dump_started ))"
test -s "$backup_tmp" || fail 'ownership-preserving backup is empty'
chmod 600 "$backup_tmp"
archive_toc="$(infrastructure exec -T postgres pg_restore --list < "$backup_tmp")"
printf '%s\n' "$archive_toc" | awk '
  $4 == "TABLE" && $5 == "profile" && $6 == "privacy_commands" && $7 != "-" { found = 1 }
  END { exit found ? 0 : 1 }
' || fail 'ownership-preserving backup does not contain the profile privacy owner'
printf '%s\n' "$archive_toc" | awk '$4 == "ACL" && $5 == "-" { found = 1 } END { exit found ? 0 : 1 }' ||
  fail 'ownership-preserving backup does not contain ACL entries'
printf '%s\n' "$archive_toc" | awk '$4 == "DEFAULT" && $5 == "ACL" { found = 1 } END { exit found ? 0 : 1 }' ||
  fail 'ownership-preserving backup does not contain default ACL entries'

assert_source_binding
test "$source_manifest_before" = "$source_manifest_bound" && test "$source_identity_before" = "$source_identity_bound" ||
  fail 'source identity or ledger changed while the backup was created'

backup_bytes="$(wc -c < "$backup_tmp" | tr -d ' ')"
backup_sha="$(sha256sum "$backup_tmp" | cut -d ' ' -f 1)"
ln "$backup_tmp" "$backup_path" || fail 'could not retain the backup under an exclusive path'
backup_path_created=true
rm -f "$backup_tmp"
backup_tmp=
test "$(stat -c %a "$backup_path")" = 600 || fail 'retained backup mode is unsafe'

rehearsal_stdout="$(mktemp "$backup_root/.communities-rehearsal.stdout.XXXXXX")"
rehearsal_stderr="$(mktemp "$backup_root/.communities-rehearsal.stderr.XXXXXX")"
if ! COMMUNITIES_STAGED_REHEARSAL_CONFIRMATION=COMMUNITIES_STAGED_REHEARSAL_29_V1 \
  COMMUNITIES_STAGED_REHEARSAL_EXPECTED_BACKUP_SHA="$backup_sha" \
  COMMUNITIES_STAGED_REHEARSAL_EXPECTED_SOURCE_LEDGER_SHA="$expected_source_ledger_sha" \
  COMMUNITIES_STAGED_REHEARSAL_EXPECTED_CANDIDATE_SHA="$expected_candidate_sha" \
  COMMUNITIES_STAGED_REHEARSAL_EXPECTED_MIGRATOR_DIGEST="$expected_migrator_digest" \
  PHUB_APP_ROOT="$app_root" PHUB_BACKUP_ROOT="$backup_root" \
  PHUB_RESTORE_MARKER_ROOT="$backup_root" PHUB_REHEARSAL_RELEASE_ENV="$release_env" \
  PHUB_REHEARSAL_COMPOSE_FILE="$compose_file" \
  PHUB_MEDIA_LEDGER_VERIFIER="$ledger_verifier" \
  RUNTIME_DATABASE_URL="$runtime_database_url" MIGRATOR_DATABASE_URL="$migrator_database_url" \
  sh "$rehearsal_command" "$backup_path" "$restore_database" "$manifest_base64" \
    > "$rehearsal_stdout" 2> "$rehearsal_stderr"; then
  fail 'isolated Communities staged rehearsal failed; inspect the retained cleanup marker locally'
fi
test ! -s "$rehearsal_stderr" || fail 'isolated Communities staged rehearsal emitted unexpected stderr'
completion_evidence="communities_staged_migration_rehearsal database=$restore_database pre_foundation=16 foundation=5 post_foundation=8 quota_index_measurements=4 source_ledger_sha=$expected_source_ledger_sha cleanup=confirmed status=passed"
grep -Fx "$completion_evidence" "$rehearsal_stdout" >/dev/null ||
  fail 'staged rehearsal completion evidence is missing'
quota_evidence="$(grep '^community_media_quota_index_measurement .* rollback=confirmed status=passed$' "$rehearsal_stdout")"
test "$(printf '%s\n' "$quota_evidence" | wc -l | tr -d ' ')" -eq 4 ||
  fail 'staged rehearsal quota index evidence is incomplete'
privacy_evidence="$(grep -E '^communities_profile_privacy_audit missing_before=[0-9]+ missing_after=0 authority=postgres_superuser status=passed$' "$rehearsal_stdout")"
test "$(printf '%s\n' "$privacy_evidence" | wc -l | tr -d ' ')" -eq 1 ||
  fail 'staged rehearsal privacy audit evidence is incomplete'

assert_source_binding
test "$source_manifest_before" = "$source_manifest_bound" && test "$source_identity_before" = "$source_identity_bound" ||
  fail 'shared source changed during the isolated rehearsal'

printf 'META|wrapperSha|%s\n' "$actual_wrapper_sha"
printf 'META|rehearsalScriptSha|%s\n' "$actual_rehearsal_sha"
printf 'META|ledgerVerifierSha|%s\n' "$actual_ledger_verifier_sha"
printf 'META|restoreHelperSha|%s\n' "$actual_restore_helper_sha"
printf 'META|activeRelease|%s\n' "$expected_active_release"
printf 'META|contractVersion|%s\n' "$expected_contract_version"
printf 'META|pendingSetSha|%s\n' "$expected_pending_set_sha"
printf 'META|sourceLedgerSha|%s\n' "$expected_source_ledger_sha"
printf 'META|targetDatabase|%s\n' "$expected_target_database"
printf 'META|systemIdentifier|%s\n' "$expected_system_identifier"
printf 'META|candidateSha|%s\n' "$expected_candidate_sha"
printf 'META|migratorDigest|%s\n' "$expected_migrator_digest"
printf 'META|releaseEnvSha|%s\n' "$expected_release_env_sha"
printf 'META|composeSha|%s\n' "$expected_compose_sha"
printf 'META|manifestSha|%s\n' "$expected_manifest_sha"
printf 'META|backupPath|%s\n' "$backup_path"
printf 'META|backupSha|%s\n' "$backup_sha"
printf 'META|backupBytes|%s\n' "$backup_bytes"
printf 'META|dumpSeconds|%s\n' "$dump_seconds"
printf 'META|restoreDatabase|%s\n' "$restore_database"
printf 'META|rehearsalStatus|passed\n'
printf 'META|authorizesSharedMigration|false\n'
printf 'META|authorizesDeploy|false\n'
printf 'META|authorizesImport|false\n'
printf 'META|authorizesActivation|false\n'
printf '%s\n' "$privacy_evidence"
printf '%s\n' "$quota_evidence"
printf '%s\n' "$completion_evidence"

backup_retained=true
rm -f "$rehearsal_stdout" "$rehearsal_stderr"
rehearsal_stdout=
rehearsal_stderr=
trap - EXIT HUP INT TERM
