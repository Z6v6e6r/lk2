#!/bin/sh

set -u
umask 077
PATH=/usr/bin:/bin
LANG=C
LC_ALL=C
export PATH LANG LC_ALL
unset CDPATH ENV BASH_ENV
IFS=$(printf ' \t')

fail() {
  printf '%s\n' "COMMUNITIES_ROLE_SPLIT_SHELL_INSTALLATION_$1" >&2
  exit 1
}

for tool in \
  /bin/cat /bin/chmod /bin/cp /bin/grep /bin/mkdir /bin/mv /bin/rmdir /bin/sed \
  /bin/sh /bin/sync /usr/bin/awk /usr/bin/basename /usr/bin/find /usr/bin/id \
  /usr/bin/install /usr/bin/realpath /usr/bin/sha256sum /usr/bin/stat /usr/bin/wc
do
  [ -x "$tool" ] || fail HOST_TOOL_MISSING
done

sha40='[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
sha64="${sha40}[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]"

is_sha40() {
  case "$1" in
    $sha40) return 0 ;;
    *) return 1 ;;
  esac
}

is_sha256() {
  case "$1" in
    $sha64) return 0 ;;
    *) return 1 ;;
  esac
}

safe_absolute_path() {
  case "$1" in
    / | /[A-Za-z0-9_./-]*) ;;
    *) return 1 ;;
  esac
  case "$1" in
    *[!A-Za-z0-9_./-]*) return 1 ;;
  esac
  case "$1" in
    *..* | *//* | */.) return 1 ;;
  esac
  return 0
}

sha_file() {
  result=$(/usr/bin/sha256sum -- "$1" 2>/dev/null) || fail HASH_FAILED
  result=${result%% *}
  is_sha256 "$result" || fail HASH_FAILED
  printf '%s\n' "$result"
}

stat_fields() {
  /usr/bin/stat -c '%F|%u|%g|%a|%h|%s' -- "$1" 2>/dev/null || fail CUSTODY_INVALID
}

assert_directory() {
  path=$1
  expected_uid=$2
  expected_gid=$3
  expected_mode=$4
  fields=$(stat_fields "$path")
  old_ifs=$IFS
  IFS='|'
  set -- $fields
  IFS=$old_ifs
  [ "$#" -eq 6 ] || fail CUSTODY_INVALID
  [ "$1" = directory ] || fail CUSTODY_INVALID
  [ "$2" = "$expected_uid" ] || fail CUSTODY_INVALID
  [ "$3" = "$expected_gid" ] || fail CUSTODY_INVALID
  [ "$4" = "$expected_mode" ] || fail CUSTODY_INVALID
}

assert_safe_parent_directory() {
  path=$1
  expected_uid=$2
  expected_gid=$3
  fields=$(stat_fields "$path")
  old_ifs=$IFS
  IFS='|'
  set -- $fields
  IFS=$old_ifs
  [ "$#" -eq 6 ] || fail TARGET_CUSTODY_INVALID
  [ "$1" = directory ] || fail TARGET_CUSTODY_INVALID
  [ "$2" = "$expected_uid" ] || fail TARGET_CUSTODY_INVALID
  [ "$3" = "$expected_gid" ] || fail TARGET_CUSTODY_INVALID
  mode_value=$((0$4))
  [ $((mode_value & 18)) -eq 0 ] || fail TARGET_CUSTODY_INVALID
}

assert_file() {
  path=$1
  expected_uid=$2
  expected_gid=$3
  expected_mode=$4
  fields=$(stat_fields "$path")
  old_ifs=$IFS
  IFS='|'
  set -- $fields
  IFS=$old_ifs
  [ "$#" -eq 6 ] || fail CUSTODY_INVALID
  [ "$1" = 'regular file' ] || fail CUSTODY_INVALID
  [ "$2" = "$expected_uid" ] || fail CUSTODY_INVALID
  [ "$3" = "$expected_gid" ] || fail CUSTODY_INVALID
  [ "$4" = "$expected_mode" ] || fail CUSTODY_INVALID
  [ "$5" = 1 ] || fail CUSTODY_INVALID
}

file_size() {
  /usr/bin/stat -c '%s' -- "$1" 2>/dev/null || fail CUSTODY_INVALID
}

read_exact_line() {
  IFS= read -r line <&3 || fail "$1"
  [ "$line" = "$2" ] || fail "$1"
}

expected_artifact() {
  case "$1" in
    1) printf '%s\n' 'payload/installer.sh|installer.sh|0755' ;;
    2) printf '%s\n' 'payload/disabled-command.sh|disabled-command.sh|0755' ;;
    3) printf '%s\n' 'payload/source/canonical-host-adapter.ts|source/canonical-host-adapter.ts|0444' ;;
    4) printf '%s\n' 'payload/source/canonical-pg-collaborators.ts|source/canonical-pg-collaborators.ts|0444' ;;
    5) printf '%s\n' 'payload/source/communities-staging-role-split-file-evidence-sink.ts|source/communities-staging-role-split-file-evidence-sink.ts|0444' ;;
    6) printf '%s\n' 'payload/source/communities-staging-role-split-host-authorization-loader.ts|source/communities-staging-role-split-host-authorization-loader.ts|0444' ;;
    7) printf '%s\n' 'payload/source/communities-staging-role-split-runner-adapter.ts|source/communities-staging-role-split-runner-adapter.ts|0444' ;;
    8) printf '%s\n' 'payload/source/communities-staging-role-split-pg-restore-runner.ts|source/communities-staging-role-split-pg-restore-runner.ts|0444' ;;
    9) printf '%s\n' 'payload/source/root-owned-evidence.ts|source/root-owned-evidence.ts|0444' ;;
    *) fail CONTROL_INVALID ;;
  esac
}

parse_artifact_line() {
  original_line=$1
  index=$2
  case "$original_line" in artifact=*) ;; *) fail CONTROL_INVALID ;; esac
  record=${original_line#artifact=}
  old_ifs=$IFS
  IFS='|'
  set -- $record
  IFS=$old_ifs
  [ "$#" -eq 5 ] || fail CONTROL_INVALID
  artifact_path=$1
  target_relative=$2
  install_mode=$3
  artifact_bytes=$4
  artifact_sha=$5
  [ "$artifact_path|$target_relative|$install_mode" = "$(expected_artifact "$index")" ] ||
    fail CONTROL_INVALID
  case "$artifact_bytes" in '' | *[!0-9]*) fail CONTROL_INVALID ;; esac
  [ "$artifact_bytes" -ge 1 ] 2>/dev/null || fail CONTROL_INVALID
  [ "$artifact_bytes" -le 2097152 ] 2>/dev/null || fail CONTROL_INVALID
  is_sha256 "$artifact_sha" || fail CONTROL_INVALID
}

walk_count() {
  count=$(/usr/bin/find "$1" -xdev -mindepth 1 -printf x 2>/dev/null | /usr/bin/wc -c) ||
    fail FILE_SET_INVALID
  set -- $count
  [ "$#" -eq 1 ] || fail FILE_SET_INVALID
  count=$1
  case "$count" in '' | *[!0-9]*) fail FILE_SET_INVALID ;; esac
  printf '%s\n' "$count"
}

verify_candidate() {
  assert_directory "$candidate" "$expected_uid" "$expected_gid" 700
  [ "$(walk_count "$candidate")" = 14 ] || fail FILE_SET_INVALID
  assert_directory "$candidate/payload" "$expected_uid" "$expected_gid" 700
  assert_directory "$candidate/payload/source" "$expected_uid" "$expected_gid" 700
  for fixed in installation-candidate.json installation-candidate.control installation-candidate.sha256
  do
    assert_file "$candidate/$fixed" "$expected_uid" "$expected_gid" 600
  done
  [ "$(sha_file "$candidate/installation-candidate.json")" = "$manifest_sha" ] ||
    fail MANIFEST_DIGEST_MISMATCH
  [ "$(sha_file "$candidate/installation-candidate.control")" = "$control_sha" ] ||
    fail CONTROL_DIGEST_MISMATCH

  [ "$(/bin/grep -Fxc '  "schemaVersion": "communities-role-split-installation-candidate-v4",' "$candidate/installation-candidate.json" 2>/dev/null)" = 1 ] || fail MANIFEST_INVALID
  [ "$(/bin/grep -Fxc '    "runtime": "POSIX_SH_GNU_COREUTILS",' "$candidate/installation-candidate.json" 2>/dev/null)" = 1 ] || fail MANIFEST_INVALID
  [ "$(/bin/grep -Fxc '    "entrypoint": "payload/installer.sh",' "$candidate/installation-candidate.json" 2>/dev/null)" = 1 ] || fail MANIFEST_INVALID
  [ "$(/bin/grep -Fxc "    \"controlSha256\": \"$control_sha\"," "$candidate/installation-candidate.json" 2>/dev/null)" = 1 ] || fail MANIFEST_INVALID
  [ "$(/bin/grep -Fxc '    "nodeRequired": false' "$candidate/installation-candidate.json" 2>/dev/null)" = 1 ] || fail MANIFEST_INVALID

  exec 3< "$candidate/installation-candidate.sha256" || fail DIGEST_INVALID
  read_exact_line DIGEST_INVALID PHUB_COMMUNITIES_ROLE_SPLIT_INSTALLATION_CANDIDATE_DIGEST_V4
  read_exact_line DIGEST_INVALID "candidateCommitSha=$candidate_sha"
  read_exact_line DIGEST_INVALID "manifestSha256=$manifest_sha"
  read_exact_line DIGEST_INVALID "controlSha256=$control_sha"
  read_exact_line DIGEST_INVALID "artifactSetSha256=$artifact_set_sha"
  read_exact_line DIGEST_INVALID installable=true
  read_exact_line DIGEST_INVALID authorizesInstallation=true
  read_exact_line DIGEST_INVALID authorizesCeremony=false
  if IFS= read -r line <&3; then fail DIGEST_INVALID; fi
  exec 3<&-

  exec 3< "$candidate/installation-candidate.control" || fail CONTROL_INVALID
  read_exact_line CONTROL_INVALID PHUB_COMMUNITIES_ROLE_SPLIT_HOST_INSTALL_CONTROL_V1
  read_exact_line CONTROL_INVALID "candidateCommitSha=$candidate_sha"
  read_exact_line CONTROL_INVALID "artifactSetSha256=$artifact_set_sha"
  read_exact_line CONTROL_INVALID artifactCount=9
  read_exact_line CONTROL_INVALID installable=true
  read_exact_line CONTROL_INVALID authorizesInstallation=true
  read_exact_line CONTROL_INVALID authorizesCeremony=false
  read_exact_line CONTROL_INVALID authorizesDatabaseMutation=false
  index=1
  while [ "$index" -le 9 ]
  do
    IFS= read -r line <&3 || fail CONTROL_INVALID
    parse_artifact_line "$line" "$index"
    source_path="$candidate/$artifact_path"
    assert_file "$source_path" "$expected_uid" "$expected_gid" 600
    [ "$(file_size "$source_path")" = "$artifact_bytes" ] || fail PAYLOAD_INVALID
    [ "$(sha_file "$source_path")" = "$artifact_sha" ] || fail PAYLOAD_INVALID
    index=$((index + 1))
  done
  if IFS= read -r line <&3; then fail CONTROL_INVALID; fi
  exec 3<&-
}

ensure_target_parents() {
  for relative in usr usr/local usr/local/libexec usr/local/libexec/phub usr/local/libexec/phub/communities-role-split usr/local/libexec/phub/communities-role-split/candidates
  do
    path="$root_prefix/$relative"
    if [ ! -e "$path" ]; then
      /bin/mkdir -m 755 -- "$path" 2>/dev/null || fail TARGET_PARENT_CREATE_FAILED
    fi
    assert_safe_parent_directory "$path" "$expected_uid" "$expected_gid"
  done
}

receipt_bytes() {
  printf '%s\n' \
    '{' \
    '  "schemaVersion": "communities-role-split-code-installation-receipt-v2",' \
    "  \"candidateCommitSha\": \"$candidate_sha\"," \
    "  \"manifestSha256\": \"$manifest_sha\"," \
    "  \"controlSha256\": \"$control_sha\"," \
    "  \"artifactSetSha256\": \"$artifact_set_sha\"," \
    '  "status": "INSTALLED_DISABLED",' \
    "  \"targetRoot\": \"/usr/local/libexec/phub/communities-role-split/candidates/$candidate_sha\"," \
    '  "authorizesCeremony": false,' \
    '  "authorizesDatabaseMutation": false,' \
    '  "authorizesRoleSplit": false,' \
    '  "authorizesMigration": false,' \
    '  "authorizesDeploy": false,' \
    '  "authorizesActivation": false' \
    '}'
}

verify_installed() {
  assert_directory "$target" "$expected_uid" "$expected_gid" 755
  [ "$(walk_count "$target")" = 11 ] || fail INSTALLED_FILE_SET_INVALID
  assert_directory "$target/source" "$expected_uid" "$expected_gid" 755
  exec 3< "$candidate/installation-candidate.control" || fail CONTROL_INVALID
  index=0
  while IFS= read -r line <&3
  do
    case "$line" in artifact=*)
      index=$((index + 1))
      parse_artifact_line "$line" "$index"
      installed_path="$target/$target_relative"
      assert_file "$installed_path" "$expected_uid" "$expected_gid" "${install_mode#0}"
      [ "$(file_size "$installed_path")" = "$artifact_bytes" ] || fail INSTALLED_PAYLOAD_INVALID
      [ "$(sha_file "$installed_path")" = "$artifact_sha" ] || fail INSTALLED_PAYLOAD_INVALID
      ;;
    esac
  done
  exec 3<&-
  [ "$index" = 9 ] || fail CONTROL_INVALID
  receipt="$target/installation-complete.json"
  assert_file "$receipt" "$expected_uid" "$expected_gid" 444
  expected_receipt_sha=$(receipt_bytes | /usr/bin/sha256sum | /usr/bin/awk '{print $1}') ||
    fail RECEIPT_INVALID
  expected_receipt_bytes=$(receipt_bytes | /usr/bin/wc -c | /bin/sed 's/[[:space:]]//g') ||
    fail RECEIPT_INVALID
  [ "$(file_size "$receipt")" = "$expected_receipt_bytes" ] || fail RECEIPT_INVALID
  [ "$(sha_file "$receipt")" = "$expected_receipt_sha" ] || fail RECEIPT_INVALID
  receipt_sha=$expected_receipt_sha
}

lock=''
cleanup_lock() {
  if [ -n "$lock" ] && [ -d "$lock" ]; then
    /bin/rmdir -- "$lock" >/dev/null 2>&1 || true
  fi
}
trap 'cleanup_lock' EXIT
trap 'fail INTERRUPTED' HUP INT TERM

if [ "$#" -ne 11 ] && [ "$#" -ne 13 ]; then fail USAGE; fi
action=$1
[ "$action" = install ] || [ "$action" = verify ] || fail USAGE
[ "$2" = --candidate ] || fail USAGE
candidate=$3
[ "$4" = --candidate-sha ] || fail USAGE
candidate_sha=$5
[ "$6" = --manifest-sha256 ] || fail USAGE
manifest_sha=$7
[ "$8" = --control-sha256 ] || fail USAGE
control_sha=$9
shift 9
[ "$1" = --artifact-set-sha256 ] || fail USAGE
artifact_set_sha=$2
shift 2
installation_root=/
if [ "$#" -eq 2 ]; then
  [ "$1" = --installation-root ] || fail USAGE
  installation_root=$2
fi

is_sha40 "$candidate_sha" || fail PIN_INVALID
is_sha256 "$manifest_sha" || fail PIN_INVALID
is_sha256 "$control_sha" || fail PIN_INVALID
is_sha256 "$artifact_set_sha" || fail PIN_INVALID
safe_absolute_path "$candidate" || fail CANDIDATE_PATH_INVALID
safe_absolute_path "$installation_root" || fail TARGET_ROOT_INVALID
[ "$(/usr/bin/realpath -e -- "$candidate" 2>/dev/null)" = "$candidate" ] || fail CANDIDATE_PATH_INVALID
[ "$(/usr/bin/basename -- "$candidate")" = "communities-role-split-installation-candidate-$candidate_sha" ] || fail CANDIDATE_PATH_INVALID
[ "$(/usr/bin/realpath -e -- "$installation_root" 2>/dev/null)" = "$installation_root" ] || fail TARGET_ROOT_INVALID

expected_uid=$(/usr/bin/id -u) || fail UID_INVALID
expected_gid=$(/usr/bin/id -g) || fail UID_INVALID
if [ "$installation_root" = / ]; then
  [ "$expected_uid" = 0 ] || fail ROOT_REQUIRED
  root_prefix=''
  assert_safe_parent_directory / 0 0
else
  root_prefix=$installation_root
  assert_directory "$installation_root" "$expected_uid" "$expected_gid" 700
fi

verify_candidate
target_parent="$root_prefix/usr/local/libexec/phub/communities-role-split/candidates"
target="$target_parent/$candidate_sha"

if [ "$action" = install ]; then
  ensure_target_parents
  lock="$target_parent/.install-$candidate_sha.lock"
  /bin/mkdir -m 700 -- "$lock" 2>/dev/null || fail INSTALLATION_LOCKED
  [ ! -e "$target" ] || fail TARGET_EXISTS
  incomplete="$target_parent/.$candidate_sha.incomplete"
  [ ! -e "$incomplete" ] || fail INCOMPLETE_EXISTS
  /bin/mkdir -m 755 -- "$incomplete" 2>/dev/null || fail INCOMPLETE_CREATE_FAILED
  /bin/mkdir -m 755 -- "$incomplete/source" 2>/dev/null || fail INCOMPLETE_CREATE_FAILED

  exec 3< "$candidate/installation-candidate.control" || fail CONTROL_INVALID
  index=0
  while IFS= read -r line <&3
  do
    case "$line" in artifact=*)
      index=$((index + 1))
      parse_artifact_line "$line" "$index"
      /usr/bin/install -m "$install_mode" -- "$candidate/$artifact_path" "$incomplete/$target_relative" 2>/dev/null || fail COPY_FAILED
      assert_file "$incomplete/$target_relative" "$expected_uid" "$expected_gid" "${install_mode#0}"
      [ "$(file_size "$incomplete/$target_relative")" = "$artifact_bytes" ] || fail TARGET_READBACK_INVALID
      [ "$(sha_file "$incomplete/$target_relative")" = "$artifact_sha" ] || fail TARGET_READBACK_INVALID
      /bin/sync -f "$incomplete/$target_relative" 2>/dev/null || fail SYNC_FAILED
      ;;
    esac
  done
  exec 3<&-
  [ "$index" = 9 ] || fail CONTROL_INVALID
  receipt_bytes > "$incomplete/installation-complete.json" || fail RECEIPT_WRITE_FAILED
  /bin/chmod 444 -- "$incomplete/installation-complete.json" 2>/dev/null || fail RECEIPT_WRITE_FAILED
  /bin/sync -f "$incomplete/installation-complete.json" 2>/dev/null || fail SYNC_FAILED
  /bin/sync -f "$incomplete" 2>/dev/null || fail SYNC_FAILED
  /bin/mv -n -T -- "$incomplete" "$target" 2>/dev/null || fail PUBLICATION_FAILED
  [ ! -e "$incomplete" ] || fail PUBLICATION_RACE
  /bin/sync -f "$target_parent" 2>/dev/null || fail SYNC_FAILED
fi

verify_installed
printf '%s\n' "COMMUNITIES_ROLE_SPLIT_CODE_$(printf '%s' "$action" | /usr/bin/awk '{ print toupper($0) }')_PASSED|candidate=$candidate_sha|receipt=$receipt_sha|status=disabled|authorizes_ceremony=false|authorizes_database_mutation=false"
