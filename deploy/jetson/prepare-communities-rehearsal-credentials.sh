#!/bin/sh
set -eu

fail() {
  printf '%s\n' "Communities rehearsal credential provisioning refused: $*" >&2
  exit 1
}

confirmation=${1:-}
operation=${2:-}
test "$confirmation" = PREPARE_COMMUNITIES_REHEARSAL_CREDENTIALS_V1 ||
  fail 'exact provisioning confirmation is required'
case "$operation" in prepare|verify) ;; *) fail 'operation must be prepare or verify' ;; esac
test "$(id -u)" -eq 0 || fail 'root execution is required'

runtime_source=${PHUB_RUNTIME_ENV_SOURCE:-/etc/phub/staging.env}
migrator_source=${PHUB_MIGRATOR_ENV_SOURCE:-/etc/phub/staging.migrator.env}
realtime_source=${PHUB_REALTIME_ENV_SOURCE:-/etc/phub/realtime.env}
staging_override=${PHUB_STAGING_OVERRIDE_SOURCE:-/opt/phub/staging.override.env}
staging_games=${PHUB_STAGING_GAMES_SOURCE:-/opt/phub/staging.games.env}
target_dir=${PHUB_REHEARSAL_CREDENTIAL_ROOT:-/etc/phub/communities-rehearsal}
runtime_target="$target_dir/runtime.database.env"
migrator_target="$target_dir/migrator.database.env"
receipt_target="$target_dir/realtime-isolation.receipt"
isolation_verifier=${PHUB_RUNTIME_ISOLATION_VERIFIER:-/usr/local/libexec/phub/verify-runtime-env-isolation.sh}
deploy_user=${PHUB_DEPLOY_USER:-phub-deploy}
preflight_group=${PHUB_PREFLIGHT_GROUP:-phub-preflight}

validate_path() {
  case "$1" in /*) ;; *) fail "$2 path must be absolute" ;; esac
  case "$1" in *[!A-Za-z0-9_./-]*) fail "$2 path contains an unsafe character" ;; esac
}
validate_path "$runtime_source" runtime-source
validate_path "$migrator_source" migrator-source
validate_path "$realtime_source" realtime-source
validate_path "$staging_override" staging-override
validate_path "$staging_games" staging-games
validate_path "$target_dir" target-directory
validate_path "$isolation_verifier" isolation-verifier

deploy_uid=$(id -u "$deploy_user") || fail 'deployment user is absent'
deploy_gid=$(id -g "$deploy_user") || fail 'deployment group is absent'
preflight_gid=$(getent group "$preflight_group" | awk -F: 'NR == 1 { print $3 }')
case "$preflight_gid" in ''|*[!0-9]*) fail 'preflight group is absent or invalid' ;; esac

validate_target_directory() {
  test -d "$target_dir" && test ! -L "$target_dir" || fail 'rehearsal credential directory is absent or unsafe'
  test "$(stat -c %u "$target_dir")" -eq 0 || fail 'rehearsal credential directory is not root-owned'
  test "$(stat -c %g "$target_dir")" -eq "$preflight_gid" || fail 'rehearsal credential directory has the wrong group'
  test "$(stat -c %a "$target_dir")" = 750 || fail 'rehearsal credential directory mode is not 0750'
}

if test "$operation" = prepare && test ! -e "$target_dir" && test ! -L "$target_dir"; then
  target_parent=${target_dir%/*}
  test -d "$target_parent" && test ! -L "$target_parent" || fail 'rehearsal credential parent is absent or unsafe'
  test "$(stat -c %u "$target_parent")" -eq 0 || fail 'rehearsal credential parent is not root-owned'
  case "$(stat -c %a "$target_parent")" in 700|710|750|755) ;; *) fail 'rehearsal credential parent mode is unsafe' ;; esac
  mkdir -m 750 "$target_dir"
  chown "0:$preflight_gid" "$target_dir"
fi
validate_target_directory
exec 9<"$target_dir"
flock -n 9 || fail 'another rehearsal credential operation is active'

metadata_identity() {
  stat -c '%d:%i:%s:%y:%z:%u:%g:%a:%h' "$1"
}

validate_source_file() {
  path=$1
  label=$2
  ownership=$3
  test -f "$path" && test ! -L "$path" || fail "$label source is absent or unsafe"
  test "$(stat -c %h "$path")" = 1 || fail "$label source must be a single-link file"
  test "$(stat -c %a "$path")" = 600 || fail "$label source mode is not 0600"
  source_uid=$(stat -c %u "$path")
  source_gid=$(stat -c %g "$path")
  case "$ownership" in
    deploy)
      test "$source_uid" -eq "$deploy_uid" && test "$source_gid" -eq "$deploy_gid" ||
        fail "$label source ownership differs"
      ;;
    privileged)
      test "$source_gid" -eq "$deploy_gid" || fail "$label source group differs"
      test "$source_uid" -eq 0 || test "$source_uid" -eq "$deploy_uid" ||
        fail "$label source owner is neither root nor the deployment identity"
      ;;
    *) fail 'internal source ownership contract is invalid' ;;
  esac
}

database_url_from() {
  path=$1
  label=$2
  test "$(awk -F= '$1 == "DATABASE_URL" { count += 1 } END { print count + 0 }' "$path")" -eq 1 ||
    fail "$label source must contain exactly one DATABASE_URL"
  value=$(sed -n 's/^DATABASE_URL=//p' "$path")
  case "$value" in postgresql://*|postgres://*) ;; *) fail "$label DATABASE_URL is malformed" ;; esac
  case "$value" in *[[:space:]]*) fail "$label DATABASE_URL contains whitespace" ;; esac
  printf '%s' "$value"
}

validate_migrator_shape() {
  awk '
    NR == 1 && /^DATABASE_URL=[^[:space:]]+$/ { found = 1; next }
    { exit 1 }
    END { if (NR != 1 || found != 1) exit 1 }
  ' "$migrator_source" || fail 'migrator source must contain exactly one DATABASE_URL line'
}

optional_identity() {
  path=$1
  if test ! -e "$path" && test ! -L "$path"; then
    printf '%s' absent
    return
  fi
  test -f "$path" && test ! -L "$path" || fail 'runtime override is unsafe'
  test "$(stat -c %h "$path")" = 1 || fail 'runtime override must be a single-link file'
  metadata_identity "$path"
}

source_fingerprint() {
  printf '%s:%s' "$(metadata_identity "$1")" "$(sha256sum "$1" | cut -d ' ' -f 1)"
}

optional_fingerprint() {
  path=$1
  if test ! -e "$path" && test ! -L "$path"; then
    printf '%s' absent
    return
  fi
  optional_identity "$path" >/dev/null
  source_fingerprint "$path"
}

validate_installed_command() {
  command_path=$(readlink -f "$1")
  test -f "$command_path" && test ! -L "$command_path" || fail 'runtime isolation verifier is absent or unsafe'
  test "$(stat -c %u "$command_path")" -eq 0 || fail 'runtime isolation verifier is not root-owned'
  case "$(stat -c %a "$command_path")" in 700|744|755) ;; *) fail 'runtime isolation verifier mode is unsafe' ;; esac
  printf '%s' "$command_path"
}

validate_source_file "$runtime_source" runtime deploy
validate_source_file "$migrator_source" migrator privileged
validate_source_file "$realtime_source" realtime deploy
test ! "$runtime_source" -ef "$migrator_source" || fail 'runtime and migrator sources alias'
test ! "$runtime_source" -ef "$realtime_source" || fail 'runtime and realtime sources alias'
test ! "$migrator_source" -ef "$realtime_source" || fail 'migrator and realtime sources alias'
runtime_database_url=$(database_url_from "$runtime_source" runtime)
migrator_database_url=$(database_url_from "$migrator_source" migrator)
validate_migrator_shape
test "$runtime_database_url" != "$migrator_database_url" || fail 'runtime and migrator database roles must differ'
isolation_verifier=$(validate_installed_command "$isolation_verifier")

runtime_before=$(source_fingerprint "$runtime_source")
migrator_before=$(source_fingerprint "$migrator_source")
realtime_before=$(source_fingerprint "$realtime_source")
override_before=$(optional_fingerprint "$staging_override")
games_before=$(optional_fingerprint "$staging_games")
"$isolation_verifier" "$runtime_source" "$realtime_source" "$deploy_user" false >/dev/null
test "$runtime_before" = "$(source_fingerprint "$runtime_source")" || fail 'runtime source changed during isolation verification'
test "$migrator_before" = "$(source_fingerprint "$migrator_source")" || fail 'migrator source changed during isolation verification'
test "$realtime_before" = "$(source_fingerprint "$realtime_source")" || fail 'realtime source changed during isolation verification'
test "$override_before" = "$(optional_fingerprint "$staging_override")" || fail 'staging override changed during isolation verification'
test "$games_before" = "$(optional_fingerprint "$staging_games")" || fail 'staging games override changed during isolation verification'

validate_target_file() {
  path=$1
  label=$2
  test -f "$path" && test ! -L "$path" || fail "$label target is absent or unsafe"
  test "$(stat -c '%u:%g:%a:%h' "$path")" = "0:$preflight_gid:440:1" ||
    fail "$label target ownership or mode differs"
}

receipt_value() {
  key=$1
  test "$(awk -F= -v key="$key" '$1 == key { count += 1 } END { print count + 0 }' "$receipt_target")" -eq 1 ||
    fail "receipt must contain exactly one $key"
  sed -n "s/^${key}=//p" "$receipt_target"
}

validate_receipt() {
  validate_target_file "$receipt_target" receipt
  test "$(wc -l < "$receipt_target" | tr -d ' ')" -eq 13 || fail 'receipt has the wrong shape'
  awk -F= '
    $1 == "CONTRACT" ||
    $1 == "API_ENV_PATH" ||
    $1 == "API_ENV_IDENTITY" ||
    $1 == "REALTIME_ENV_PATH" ||
    $1 == "REALTIME_ENV_IDENTITY" ||
    $1 == "STAGING_OVERRIDE_PATH" ||
    $1 == "STAGING_OVERRIDE_IDENTITY" ||
    $1 == "STAGING_GAMES_PATH" ||
    $1 == "STAGING_GAMES_IDENTITY" ||
    $1 == "RUNTIME_CREDENTIAL_IDENTITY" ||
    $1 == "MIGRATOR_CREDENTIAL_IDENTITY" ||
    $1 == "EXPECTED_COMMUNITIES_REALTIME_ENABLED" ||
    $1 == "ISOLATION_VERIFIER_SHA256" { next }
    { exit 1 }
  ' "$receipt_target" || fail 'receipt contains an unexpected key'
  test "$(receipt_value CONTRACT)" = COMMUNITIES_REHEARSAL_CREDENTIALS_V1 || fail 'receipt contract differs'
  test "$(receipt_value API_ENV_PATH)" = "$runtime_source" || fail 'receipt API path differs'
  test "$(receipt_value API_ENV_IDENTITY)" = "$(metadata_identity "$runtime_source")" || fail 'receipt API identity differs'
  test "$(receipt_value REALTIME_ENV_PATH)" = "$realtime_source" || fail 'receipt realtime path differs'
  test "$(receipt_value REALTIME_ENV_IDENTITY)" = "$(metadata_identity "$realtime_source")" || fail 'receipt realtime identity differs'
  test "$(receipt_value STAGING_OVERRIDE_PATH)" = "$staging_override" || fail 'receipt override path differs'
  test "$(receipt_value STAGING_OVERRIDE_IDENTITY)" = "$(optional_identity "$staging_override")" || fail 'receipt override identity differs'
  test "$(receipt_value STAGING_GAMES_PATH)" = "$staging_games" || fail 'receipt games path differs'
  test "$(receipt_value STAGING_GAMES_IDENTITY)" = "$(optional_identity "$staging_games")" || fail 'receipt games identity differs'
  test "$(receipt_value RUNTIME_CREDENTIAL_IDENTITY)" = "$(metadata_identity "$runtime_target")" || fail 'receipt runtime credential identity differs'
  test "$(receipt_value MIGRATOR_CREDENTIAL_IDENTITY)" = "$(metadata_identity "$migrator_target")" || fail 'receipt migrator credential identity differs'
  test "$(receipt_value EXPECTED_COMMUNITIES_REALTIME_ENABLED)" = false || fail 'receipt realtime state differs'
  case "$(receipt_value ISOLATION_VERIFIER_SHA256)" in
    ''|*[!0-9a-f]*) fail 'receipt verifier SHA-256 is invalid' ;;
  esac
  test "${#verifier_sha}" -eq 64 || fail 'runtime isolation verifier SHA-256 is invalid'
  test "$(receipt_value ISOLATION_VERIFIER_SHA256)" = "$verifier_sha" || fail 'receipt verifier SHA-256 differs'
}

validate_installed_credentials() {
  validate_target_directory
  validate_target_file "$runtime_target" runtime
  validate_target_file "$migrator_target" migrator
  test ! "$runtime_target" -ef "$migrator_target" || fail 'runtime and migrator targets alias'
  target_runtime_url=$(database_url_from "$runtime_target" runtime-target)
  target_migrator_url=$(database_url_from "$migrator_target" migrator-target)
  test "$(wc -l < "$runtime_target" | tr -d ' ')" -eq 1 || fail 'runtime target has the wrong shape'
  test "$(wc -l < "$migrator_target" | tr -d ' ')" -eq 1 || fail 'migrator target has the wrong shape'
  test "$target_runtime_url" = "$runtime_database_url" || fail 'runtime target does not match the canonical source'
  test "$target_migrator_url" = "$migrator_database_url" || fail 'migrator target does not match the canonical source'
  validate_receipt
  unset target_runtime_url target_migrator_url
}

verifier_sha=$(sha256sum "$isolation_verifier" | cut -d ' ' -f 1)
if test "$operation" = verify; then
  validate_installed_credentials
  unset runtime_database_url migrator_database_url
  printf '%s\n' 'COMMUNITIES_REHEARSAL_CREDENTIALS|operation=verify|status=passed|secrets_exposed=false'
  exit 0
fi

for path in "$runtime_target" "$migrator_target" "$receipt_target"; do
  if test -e "$path" || test -L "$path"; then
    validate_target_file "$path" existing
  fi
done

runtime_next=$(mktemp "$target_dir/.runtime.database.env.next.XXXXXX")
migrator_next=$(mktemp "$target_dir/.migrator.database.env.next.XXXXXX")
receipt_next=''
cleanup() {
  test -z "$runtime_next" || rm -f "$runtime_next"
  test -z "$migrator_next" || rm -f "$migrator_next"
  test -z "$receipt_next" || rm -f "$receipt_next"
}
trap cleanup EXIT HUP INT TERM
printf 'DATABASE_URL=%s\n' "$runtime_database_url" > "$runtime_next"
printf 'DATABASE_URL=%s\n' "$migrator_database_url" > "$migrator_next"
chmod 440 "$runtime_next" "$migrator_next"
chown "0:$preflight_gid" "$runtime_next" "$migrator_next"
sync -f "$runtime_next"
sync -f "$migrator_next"

test "$runtime_before" = "$(source_fingerprint "$runtime_source")" || fail 'runtime source changed before credential commit'
test "$migrator_before" = "$(source_fingerprint "$migrator_source")" || fail 'migrator source changed before credential commit'
test "$realtime_before" = "$(source_fingerprint "$realtime_source")" || fail 'realtime source changed before credential commit'
test "$override_before" = "$(optional_fingerprint "$staging_override")" || fail 'staging override changed before credential commit'
test "$games_before" = "$(optional_fingerprint "$staging_games")" || fail 'staging games override changed before credential commit'
mv -f "$runtime_next" "$runtime_target"
runtime_next=''
mv -f "$migrator_next" "$migrator_target"
migrator_next=''
sync -f "$target_dir"

test "$runtime_before" = "$(source_fingerprint "$runtime_source")" || fail 'runtime source changed during credential commit'
test "$migrator_before" = "$(source_fingerprint "$migrator_source")" || fail 'migrator source changed during credential commit'
test "$realtime_before" = "$(source_fingerprint "$realtime_source")" || fail 'realtime source changed during credential commit'
test "$override_before" = "$(optional_fingerprint "$staging_override")" || fail 'staging override changed during credential commit'
test "$games_before" = "$(optional_fingerprint "$staging_games")" || fail 'staging games override changed during credential commit'

receipt_next=$(mktemp "$target_dir/.realtime-isolation.receipt.next.XXXXXX")
{
  printf 'CONTRACT=COMMUNITIES_REHEARSAL_CREDENTIALS_V1\n'
  printf 'API_ENV_PATH=%s\n' "$runtime_source"
  printf 'API_ENV_IDENTITY=%s\n' "$(metadata_identity "$runtime_source")"
  printf 'REALTIME_ENV_PATH=%s\n' "$realtime_source"
  printf 'REALTIME_ENV_IDENTITY=%s\n' "$(metadata_identity "$realtime_source")"
  printf 'STAGING_OVERRIDE_PATH=%s\n' "$staging_override"
  printf 'STAGING_OVERRIDE_IDENTITY=%s\n' "$(optional_identity "$staging_override")"
  printf 'STAGING_GAMES_PATH=%s\n' "$staging_games"
  printf 'STAGING_GAMES_IDENTITY=%s\n' "$(optional_identity "$staging_games")"
  printf 'RUNTIME_CREDENTIAL_IDENTITY=%s\n' "$(metadata_identity "$runtime_target")"
  printf 'MIGRATOR_CREDENTIAL_IDENTITY=%s\n' "$(metadata_identity "$migrator_target")"
  printf 'EXPECTED_COMMUNITIES_REALTIME_ENABLED=false\n'
  printf 'ISOLATION_VERIFIER_SHA256=%s\n' "$verifier_sha"
} > "$receipt_next"
chmod 440 "$receipt_next"
chown "0:$preflight_gid" "$receipt_next"
sync -f "$receipt_next"
mv -f "$receipt_next" "$receipt_target"
receipt_next=''
sync -f "$target_dir"
validate_installed_credentials
unset runtime_database_url migrator_database_url
printf '%s\n' 'COMMUNITIES_REHEARSAL_CREDENTIALS|operation=prepare|status=passed|secrets_exposed=false'
