#!/usr/bin/env sh
set -eu

fail() {
  printf '%s\n' "COMMUNITIES_ROLE_SPLIT_RESTORE_MARKER_CLEANUP_$1" >&2
  exit 1
}

is_sha256() {
  test "${#1}" -eq 64 || return 1
  case "$1" in *[!0-9a-f]*) return 1 ;; esac
}

is_positive_decimal() {
  case "$1" in ''|0|0*|*[!0-9]*) return 1 ;; esac
}

file_sha256() {
  output=$(sha256sum "$1" 2>/dev/null || true)
  digest=${output%%[[:space:]]*}
  is_sha256 "$digest" || fail "$2"
  printf '%s' "$digest"
}

original_command=${SSH_ORIGINAL_COMMAND:-}
printf '%s' "$original_command" | grep -Eq \
  '^CLEANUP_COMMUNITIES_ROLE_SPLIT_RESTORE_MARKER_CLONE_V1 [A-Za-z0-9._-]+ [0-9a-f]{64}$' \
  >/dev/null 2>&1 || fail CONFIRMATION_INVALID
old_ifs=$IFS; IFS=' '; set -f; set -- $original_command; set +f; IFS=$old_ifs
test "$#" -eq 3 || fail CONFIRMATION_INVALID
request_basename=$2
expected_cleanup_request_sha=$3
printf '%s' "$request_basename" | grep -Eq \
  '^communities-role-split-marker-cleanup-request-[1-9][0-9]*-[1-9][0-9]*\.txt$' \
  >/dev/null 2>&1 || fail REQUEST_PATH_INVALID
is_sha256 "$expected_cleanup_request_sha" || fail REQUEST_SHA_INVALID

request_root=/var/lib/phub-preflight/role-split-marker-cleanup-requests
state_root=/var/lib/phub-preflight/role-split-marker-state
app_root=/opt/phub
current_uid=$(id -u 2>/dev/null || true)
current_gid=$(id -g 2>/dev/null || true)
is_positive_decimal "$current_uid" && is_positive_decimal "$current_gid" || fail CUSTODY_INVALID
for directory in "$request_root:0:$current_gid:750" "$state_root:$current_uid:$current_gid:700"; do
  old_ifs=$IFS; IFS=:; set -- $directory; IFS=$old_ifs
  test -d "$1" && test ! -L "$1" || fail CUSTODY_INVALID
  test "$(stat -c %u "$1")" = "$2" && test "$(stat -c %g "$1")" = "$3" &&
    test "$(stat -c %a "$1")" = "$4" || fail CUSTODY_INVALID
done
test -d "$app_root" && test ! -L "$app_root" || fail CUSTODY_INVALID

request=$request_root/$request_basename
test -f "$request" && test ! -L "$request" || fail REQUEST_CUSTODY_INVALID
test "$(stat -c %u "$request")" = 0 && test "$(stat -c %g "$request")" = "$current_gid" &&
  test "$(stat -c %a "$request")" = 440 || fail REQUEST_CUSTODY_INVALID
request_bytes=$(wc -c < "$request" | tr -d ' ')
is_positive_decimal "$request_bytes" && test "$request_bytes" -le 4096 || fail REQUEST_SHAPE_INVALID
test "$(file_sha256 "$request" REQUEST_SHA_INVALID)" = "$expected_cleanup_request_sha" ||
  fail REQUEST_SHA_INVALID
request_octets=$(od -An -v -tu1 "$request" 2>/dev/null) || fail REQUEST_SHAPE_INVALID
test -n "$request_octets" || fail REQUEST_SHAPE_INVALID
printf '%s\n' "$request_octets" | awk -v expected="$request_bytes" '
  { for (i = 1; i <= NF; i += 1) {
      byte=$i+0; count+=1
      if (!(byte == 10 || byte == 45 || byte == 46 || byte == 58 || byte == 61 ||
            (byte >= 48 && byte <= 57) || (byte >= 65 && byte <= 90) ||
            byte == 95 || (byte >= 97 && byte <= 122))) invalid=1
  }}
  END { exit (!invalid && count == expected) ? 0 : 1 }
' >/dev/null 2>&1 || fail REQUEST_SHAPE_INVALID
last_byte=$(tail -c 1 "$request" 2>/dev/null || true; printf x)
test "$last_byte" = "$(printf '\nx')" || fail REQUEST_SHAPE_INVALID

line_number=0
while IFS= read -r line || test -n "$line"; do
  line_number=$((line_number + 1))
  case "$line_number:$line" in
    1:PHUB_COMMUNITIES_ROLE_SPLIT_CLONE_MARKER_CLEANUP_REQUEST_V1) ;;
    2:restoreDatabase=*) restore_database=${line#*=} ;;
    3:cloneDatabaseOid=*) clone_oid=${line#*=} ;;
    4:markerRequestSha256=*) marker_request_sha=${line#*=} ;;
    5:markerValue=*) marker=${line#*=} ;;
    6:restoreRunId=*) run_id=${line#*=} ;;
    7:restoreRunAttempt=*) run_attempt=${line#*=} ;;
    8:cleanupWriterSha256=*) cleanup_writer_sha=${line#*=} ;;
    *) fail REQUEST_SHAPE_INVALID ;;
  esac
done < "$request"
test "$line_number" -eq 8 || fail REQUEST_SHAPE_INVALID
is_positive_decimal "$run_id" && is_positive_decimal "$run_attempt" &&
  is_positive_decimal "$clone_oid" || fail REQUEST_BINDING_INVALID
test "$restore_database" = "phub_restore_${run_id}_${run_attempt}" || fail REQUEST_BINDING_INVALID
test "$request_basename" = "communities-role-split-marker-cleanup-request-${run_id}-${run_attempt}.txt" ||
  fail REQUEST_BINDING_INVALID
is_sha256 "$marker_request_sha" && is_sha256 "$cleanup_writer_sha" || fail REQUEST_BINDING_INVALID
case "$marker" in phub-communities-role-split-clone-v1:*) ;;
  *) fail REQUEST_BINDING_INVALID ;;
esac
marker_payload_sha=${marker#phub-communities-role-split-clone-v1:}
is_sha256 "$marker_payload_sha" || fail REQUEST_BINDING_INVALID

script=$(readlink -f "$0" 2>/dev/null || true)
test -f "$script" && test ! -L "$script" && test "$(stat -c %u "$script")" = 0 ||
  fail SCRIPT_CUSTODY_INVALID
case "$(stat -c %a "$script")" in 700|744|755) ;; *) fail SCRIPT_CUSTODY_INVALID ;; esac
test "$(file_sha256 "$script" SCRIPT_CUSTODY_INVALID)" = "$cleanup_writer_sha" ||
  fail SCRIPT_CUSTODY_INVALID

lock_path=$state_root/.communities-role-split-marker.lock
if test -e "$lock_path" || test -L "$lock_path"; then
  test -f "$lock_path" && test ! -L "$lock_path" &&
    test "$(stat -c %u "$lock_path")" = "$current_uid" || fail LOCK_CUSTODY_INVALID
else
  (umask 077; set -C; : > "$lock_path") || fail LOCK_CUSTODY_INVALID
fi
chmod 600 "$lock_path"
exec 9<>"$lock_path"
flock -n 9 || fail LOCK_BUSY
state_path=$state_root/.communities-role-split-marker-${run_id}-${run_attempt}.state
test -f "$state_path" && test ! -L "$state_path" && test "$(stat -c %u "$state_path")" = "$current_uid" &&
  test "$(stat -c %a "$state_path")" = 600 || fail STATE_INVALID
marker_value_sha=$(printf '%s' "$marker" | sha256sum | cut -d ' ' -f 1)
state=$(sed -n '1p' "$state_path")
case "$state" in
  "MARKED|$marker_request_sha|$clone_oid|$marker_value_sha"|"OWNED|$marker_request_sha|$clone_oid") ;;
  *) fail STATE_BINDING_INVALID ;;
esac

cd "$app_root"
infrastructure() {
  docker compose --env-file infrastructure.env -f compose.infrastructure.yaml "$@"
}
admin_psql() {
  infrastructure exec -T postgres sh -ec \
    'PGOPTIONS="-c default_transaction_read_only=on -c statement_timeout=15000 -c lock_timeout=2000 -c search_path=pg_catalog" psql -X -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -At -F "|" -c "$1"' \
    sh "$1"
}
observed=$(admin_psql "select oid::text||'|'||coalesce(shobj_description(oid, 'pg_database'), '') from pg_catalog.pg_database where datname='$restore_database';")
test "$observed" = "$clone_oid|$marker" || fail DATABASE_BINDING_INVALID
infrastructure exec -T postgres sh -ec 'dropdb -U "$POSTGRES_USER" "$1"' \
  sh "$restore_database"
test -z "$(admin_psql "select oid::text from pg_catalog.pg_database where datname='$restore_database';")" ||
  fail DATABASE_REMAINS
printf 'CLEANED|%s|%s|%s\n' "$marker_request_sha" "$clone_oid" "$expected_cleanup_request_sha" > "$state_path"

printf '%s\n' \
  'schemaVersion=communities-role-split-clone-marker-cleanup-evidence-v1' \
  'status=CLEANED' \
  "cleanupRequestSha256=$expected_cleanup_request_sha" \
  "markerRequestSha256=$marker_request_sha" \
  "markerValueSha256=$marker_value_sha" \
  "cloneDatabaseOid=$clone_oid" \
  "restoreRunId=$run_id" \
  "restoreRunAttempt=$run_attempt" \
  'binding.marker=true' \
  'binding.request=true' \
  'binding.cloneOid=true' \
  'authorizes.roleCreation=false' \
  'authorizes.roleSplit=false' \
  'authorizes.sharedDatabaseMutation=false' \
  'authorizes.migration=false' \
  'authorizes.deploy=false' \
  'authorizes.import=false' \
  'authorizes.activation=false'
