#!/usr/bin/env sh
set -eu

fail() {
  printf '%s\n' "COMMUNITIES_STAGING_ROLE_SPLIT_RESTORE_MARKER_WRITER_$1" >&2
  exit 1
}

is_sha256() {
  test "${#1}" -eq 64 || return 1
  case "$1" in
    *[!0-9a-f]*) return 1 ;;
  esac
}

is_positive_decimal() {
  case "$1" in
    ''|0|0*|*[!0-9]*) return 1 ;;
  esac
}

is_identifier() {
  case "$1" in
    ''|[0-9]*|*[!A-Za-z0-9_]*) return 1 ;;
  esac
}

file_uid() {
  stat -c %u "$1" 2>/dev/null || fail "$2"
}

file_mode() {
  stat -c %a "$1" 2>/dev/null || fail "$2"
}

file_gid() {
  stat -c %g "$1" 2>/dev/null || fail "$2"
}

file_sha256() {
  digest_output=$(sha256sum "$1" 2>/dev/null || true)
  digest=${digest_output%%[[:space:]]*}
  is_sha256 "$digest" || fail "$2"
  printf '%s' "$digest"
}

assert_root_regular_file() {
  path=$1
  error=$2
  test -f "$path" && test ! -L "$path" || fail "$error"
  test "$(file_uid "$path" "$error")" = 0 || fail "$error"
  test "$(file_gid "$path" "$error")" = "$current_gid" || fail "$error"
  test "$(file_mode "$path" "$error")" = 440 || fail "$error"
}

assert_root_command() {
  path=$1
  error=$2
  test -f "$path" && test ! -L "$path" || fail "$error"
  test "$(file_uid "$path" "$error")" = 0 || fail "$error"
  case "$(file_mode "$path" "$error")" in
    700|744|755) ;;
    *) fail "$error" ;;
  esac
}

original_command=${SSH_ORIGINAL_COMMAND:-}
printf '%s' "$original_command" | grep -Eq \
  '^PREPARE_COMMUNITIES_ROLE_SPLIT_INVENTORY_CLONE_V1 [A-Za-z0-9._-]+ [0-9a-f]{64}$' \
  >/dev/null 2>&1 || fail CONFIRMATION_INVALID
old_ifs=$IFS
IFS=' '
set -f
set -- $original_command
set +f
IFS=$old_ifs
test "$#" -eq 3 || fail CONFIRMATION_INVALID
test "$1" = PREPARE_COMMUNITIES_ROLE_SPLIT_INVENTORY_CLONE_V1 || fail CONFIRMATION_INVALID
request_basename=$2
expected_request_sha=$3
case "$request_basename" in
  communities-role-split-marker-request-*.txt) ;;
  *) fail REQUEST_PATH_INVALID ;;
esac
printf '%s' "$request_basename" | grep -Eq \
  '^communities-role-split-marker-request-[1-9][0-9]*-[1-9][0-9]*\.txt$' \
  >/dev/null 2>&1 || fail REQUEST_PATH_INVALID
is_sha256 "$expected_request_sha" || fail REQUEST_SHA_INVALID

request_root=/var/lib/phub-preflight/role-split-marker-requests
backup_root=/var/lib/phub-preflight/backups
restore_helper=/usr/local/libexec/phub/verify-postgres-backup-restore.sh
expected_manifest_sha=4898518b26d8adfccc2494bbcb03d82d2a051d94be05f07f08a6702ad190c605

current_uid=$(id -u 2>/dev/null || true)
current_gid=$(id -g 2>/dev/null || true)
is_positive_decimal "$current_uid" || fail BACKUP_ROOT_CUSTODY_INVALID
is_positive_decimal "$current_gid" || fail BACKUP_ROOT_CUSTODY_INVALID
test -d "$request_root" && test ! -L "$request_root" || fail REQUEST_ROOT_CUSTODY_INVALID
test "$(file_uid "$request_root" REQUEST_ROOT_CUSTODY_INVALID)" = 0 ||
  fail REQUEST_ROOT_CUSTODY_INVALID
test "$(file_gid "$request_root" REQUEST_ROOT_CUSTODY_INVALID)" = "$current_gid" ||
  fail REQUEST_ROOT_CUSTODY_INVALID
test "$(file_mode "$request_root" REQUEST_ROOT_CUSTODY_INVALID)" = 750 ||
  fail REQUEST_ROOT_CUSTODY_INVALID
test -d "$backup_root" && test ! -L "$backup_root" || fail BACKUP_ROOT_CUSTODY_INVALID
test "$(file_uid "$backup_root" BACKUP_ROOT_CUSTODY_INVALID)" = "$current_uid" ||
  fail BACKUP_ROOT_CUSTODY_INVALID
test "$(file_mode "$backup_root" BACKUP_ROOT_CUSTODY_INVALID)" = 700 ||
  fail BACKUP_ROOT_CUSTODY_INVALID

request=$request_root/$request_basename
assert_root_regular_file "$request" REQUEST_CUSTODY_INVALID
request_bytes=$(wc -c < "$request" 2>/dev/null | tr -d ' ' || true)
is_positive_decimal "$request_bytes" || fail REQUEST_SHAPE_INVALID
test "$request_bytes" -le 8192 || fail REQUEST_SHAPE_INVALID
test "$(file_sha256 "$request" REQUEST_SHA_INVALID)" = "$expected_request_sha" ||
  fail REQUEST_SHA_INVALID
request_octets=$(od -An -v -tu1 "$request" 2>/dev/null) || fail REQUEST_SHAPE_INVALID
test -n "$request_octets" || fail REQUEST_SHAPE_INVALID
printf '%s\n' "$request_octets" | awk -v expected="$request_bytes" '
  {
    for (i = 1; i <= NF; i += 1) {
      byte = $i + 0
      count += 1
      if (!(byte == 10 || byte == 45 || byte == 46 || byte == 61 ||
            (byte >= 48 && byte <= 57) || (byte >= 65 && byte <= 90) ||
            byte == 95 || (byte >= 97 && byte <= 122))) invalid = 1
    }
  }
  END { exit (!invalid && count == expected) ? 0 : 1 }
' >/dev/null 2>&1 || fail REQUEST_SHAPE_INVALID
request_last_byte=$(tail -c 1 "$request" 2>/dev/null || true; printf x)
test "$request_last_byte" = "$(printf '\nx')" || fail REQUEST_SHAPE_INVALID

script=$(readlink -f "$0" 2>/dev/null || true)
test -n "$script" || fail SCRIPT_CUSTODY_INVALID
assert_root_command "$script" SCRIPT_CUSTODY_INVALID

line_number=0
while IFS= read -r line || test -n "$line"; do
  line_number=$((line_number + 1))
  case "$line_number" in
    1) test "$line" = PHUB_COMMUNITIES_ROLE_SPLIT_CLONE_MARKER_REQUEST_V1 || fail REQUEST_SHAPE_INVALID ;;
    2) case "$line" in restoreDatabase=*) restore_database=${line#*=} ;; *) fail REQUEST_SHAPE_INVALID ;; esac ;;
    3) case "$line" in expectedCloneDatabaseOwner=*) clone_owner=${line#*=} ;; *) fail REQUEST_SHAPE_INVALID ;; esac ;;
    4) case "$line" in expectedCloneDatabaseOwnerOid=*) clone_owner_oid=${line#*=} ;; *) fail REQUEST_SHAPE_INVALID ;; esac ;;
    5) case "$line" in sourceDatabase=*) source_database=${line#*=} ;; *) fail REQUEST_SHAPE_INVALID ;; esac ;;
    6) case "$line" in sourceDatabaseOid=*) source_database_oid=${line#*=} ;; *) fail REQUEST_SHAPE_INVALID ;; esac ;;
    7) case "$line" in sourceDatabaseOwner=*) source_owner=${line#*=} ;; *) fail REQUEST_SHAPE_INVALID ;; esac ;;
    8) case "$line" in sourceDatabaseOwnerOid=*) source_owner_oid=${line#*=} ;; *) fail REQUEST_SHAPE_INVALID ;; esac ;;
    9) case "$line" in systemIdentifier=*) system_identifier=${line#*=} ;; *) fail REQUEST_SHAPE_INVALID ;; esac ;;
    10) case "$line" in backupBasename=*) backup_basename=${line#*=} ;; *) fail REQUEST_SHAPE_INVALID ;; esac ;;
    11) case "$line" in backupSha256=*) backup_sha=${line#*=} ;; *) fail REQUEST_SHAPE_INVALID ;; esac ;;
    12) case "$line" in backupBytes=*) backup_bytes=${line#*=} ;; *) fail REQUEST_SHAPE_INVALID ;; esac ;;
    13) case "$line" in backupEvidenceBasename=*) evidence_basename=${line#*=} ;; *) fail REQUEST_SHAPE_INVALID ;; esac ;;
    14) case "$line" in backupEvidenceSha256=*) evidence_sha=${line#*=} ;; *) fail REQUEST_SHAPE_INVALID ;; esac ;;
    15) case "$line" in archiveTocSha256=*) archive_toc_sha=${line#*=} ;; *) fail REQUEST_SHAPE_INVALID ;; esac ;;
    16) case "$line" in sourceLedgerSha256=*) ledger_sha=${line#*=} ;; *) fail REQUEST_SHAPE_INVALID ;; esac ;;
    17) case "$line" in sourceLedgerCount=*) ledger_count=${line#*=} ;; *) fail REQUEST_SHAPE_INVALID ;; esac ;;
    18) case "$line" in activeRelease=*) active_release=${line#*=} ;; *) fail REQUEST_SHAPE_INVALID ;; esac ;;
    19) case "$line" in restoreRunId=*) run_id=${line#*=} ;; *) fail REQUEST_SHAPE_INVALID ;; esac ;;
    20) case "$line" in restoreRunAttempt=*) run_attempt=${line#*=} ;; *) fail REQUEST_SHAPE_INVALID ;; esac ;;
    21) case "$line" in postgresMajor=*) postgres_major=${line#*=} ;; *) fail REQUEST_SHAPE_INVALID ;; esac ;;
    22) case "$line" in objectManifestSha256=*) manifest_sha=${line#*=} ;; *) fail REQUEST_SHAPE_INVALID ;; esac ;;
    23) case "$line" in restoreHelperSha256=*) helper_sha=${line#*=} ;; *) fail REQUEST_SHAPE_INVALID ;; esac ;;
    24) case "$line" in markerWriterSha256=*) writer_sha=${line#*=} ;; *) fail REQUEST_SHAPE_INVALID ;; esac ;;
    *) fail REQUEST_SHAPE_INVALID ;;
  esac
done < "$request"
test "$line_number" -eq 24 || fail REQUEST_SHAPE_INVALID

is_positive_decimal "$run_id" || fail REQUEST_BINDING_INVALID
is_positive_decimal "$run_attempt" || fail REQUEST_BINDING_INVALID
test "$request_basename" = "communities-role-split-marker-request-${run_id}-${run_attempt}.txt" ||
  fail REQUEST_BINDING_INVALID
test "$restore_database" = "phub_restore_${run_id}_${run_attempt}" || fail REQUEST_BINDING_INVALID
is_identifier "$clone_owner" || fail REQUEST_BINDING_INVALID
is_identifier "$source_database" || fail REQUEST_BINDING_INVALID
is_identifier "$source_owner" || fail REQUEST_BINDING_INVALID
test "$source_database" != "$restore_database" || fail REQUEST_BINDING_INVALID
for value in "$clone_owner_oid" "$source_database_oid" "$source_owner_oid" "$system_identifier" \
  "$backup_bytes" "$ledger_count"; do
  is_positive_decimal "$value" || fail REQUEST_BINDING_INVALID
done
printf '%s' "$backup_basename" | grep -Eq \
  '^postgres-communities-rehearsal-[0-9]{8}T[0-9]{6}Z-[1-9][0-9]*\.dump$' \
  >/dev/null 2>&1 || fail REQUEST_BINDING_INVALID
test "$evidence_basename" = "$backup_basename.evidence" || fail REQUEST_BINDING_INVALID
for value in "$backup_sha" "$evidence_sha" "$archive_toc_sha" "$ledger_sha" "$manifest_sha" \
  "$helper_sha" "$writer_sha"; do
  is_sha256 "$value" || fail REQUEST_BINDING_INVALID
done
test "${#active_release}" -eq 40 || fail REQUEST_BINDING_INVALID
case "$active_release" in *[!0-9a-f]*) fail REQUEST_BINDING_INVALID ;; esac
test "$postgres_major" = 16 || fail REQUEST_BINDING_INVALID
test "$manifest_sha" = "$expected_manifest_sha" || fail REQUEST_BINDING_INVALID

assert_root_command "$restore_helper" RESTORE_HELPER_CUSTODY_INVALID
test "$(file_sha256 "$restore_helper" RESTORE_HELPER_CUSTODY_INVALID)" = "$helper_sha" ||
  fail RESTORE_HELPER_CUSTODY_INVALID
test "$(file_sha256 "$script" SCRIPT_CUSTODY_INVALID)" = "$writer_sha" ||
  fail SCRIPT_CUSTODY_INVALID

backup=$backup_root/$backup_basename
evidence=$backup_root/$evidence_basename
test -f "$backup" && test ! -L "$backup" && test -s "$backup" || fail BACKUP_CUSTODY_INVALID
test "$(file_uid "$backup" BACKUP_CUSTODY_INVALID)" = "$current_uid" || fail BACKUP_CUSTODY_INVALID
test "$(file_mode "$backup" BACKUP_CUSTODY_INVALID)" = 600 || fail BACKUP_CUSTODY_INVALID
observed_backup_bytes=$(wc -c < "$backup" 2>/dev/null | tr -d ' ' || true)
test "$observed_backup_bytes" = "$backup_bytes" || fail BACKUP_CUSTODY_INVALID
test "$(file_sha256 "$backup" BACKUP_CUSTODY_INVALID)" = "$backup_sha" || fail BACKUP_CUSTODY_INVALID

assert_root_regular_file "$evidence" BACKUP_EVIDENCE_CUSTODY_INVALID
test "$(file_sha256 "$evidence" BACKUP_EVIDENCE_CUSTODY_INVALID)" = "$evidence_sha" ||
  fail BACKUP_EVIDENCE_CUSTODY_INVALID

fail EXECUTION_NOT_AUTHORIZED
