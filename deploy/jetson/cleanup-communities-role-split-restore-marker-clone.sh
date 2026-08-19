#!/usr/bin/env sh
set -eu

PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
unset DOCKER_HOST DOCKER_CONTEXT COMPOSE_FILE COMPOSE_PROJECT_NAME COMPOSE_PROFILES \
  COMPOSE_ENV_FILES COMPOSE_PATH_SEPARATOR COMPOSE_PARALLEL_LIMIT

script_path=$(readlink -f "$0" 2>/dev/null || true)
test -n "$script_path" && test -f "$script_path" && test ! -L "$script_path" || exit 1
test "$(stat -c %u "$script_path" 2>/dev/null || true)" = 0 || exit 1
timeout_path=/usr/bin/timeout
test -f "$timeout_path" && test ! -L "$timeout_path" && test -x "$timeout_path" &&
  test "$(stat -c %u "$timeout_path" 2>/dev/null || true)" = 0 &&
  test "$(stat -c %h "$timeout_path" 2>/dev/null || true)" = 1 || exit 1
"$timeout_path" --version 2>/dev/null | grep -F 'GNU coreutils' >/dev/null || exit 1
if test "${1:-}" != __PHUB_COMMUNITIES_MARKER_CLEANUP_BOUNDED_CHILD_V1; then
  exec "$timeout_path" --signal=TERM --kill-after=15s 20m \
    /usr/bin/env -i PATH="$PATH" SSH_ORIGINAL_COMMAND="${SSH_ORIGINAL_COMMAND:-}" \
    "$script_path" __PHUB_COMMUNITIES_MARKER_CLEANUP_BOUNDED_CHILD_V1
fi
test "$#" -eq 1 || exit 1

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
  '^CLEANUP_COMMUNITIES_ROLE_SPLIT_RESTORE_MARKER_CLONE_V1 [A-Za-z0-9._-]+ [0-9a-f]{64} [A-Za-z0-9._-]+ [0-9a-f]{64}$' \
  >/dev/null 2>&1 || fail CONFIRMATION_INVALID
old_ifs=$IFS; IFS=' '; set -f; set -- $original_command; set +f; IFS=$old_ifs
test "$#" -eq 5 || fail CONFIRMATION_INVALID
request_basename=$2
expected_cleanup_request_sha=$3
runtime_basename=$4
expected_runtime_sha=$5
printf '%s' "$request_basename" | grep -Eq \
  '^communities-role-split-marker-cleanup-request-[1-9][0-9]*-[1-9][0-9]*\.txt$' \
  >/dev/null 2>&1 || fail REQUEST_PATH_INVALID
is_sha256 "$expected_cleanup_request_sha" || fail REQUEST_SHA_INVALID
printf '%s' "$runtime_basename" | grep -Eq \
  '^communities-role-split-marker-runtime-[1-9][0-9]*-[1-9][0-9]*\.txt$' \
  >/dev/null 2>&1 || fail RUNTIME_PATH_INVALID
is_sha256 "$expected_runtime_sha" || fail RUNTIME_SHA_INVALID

request_root=/var/lib/phub-preflight/role-split-marker-cleanup-requests
runtime_root=/var/lib/phub-preflight/role-split-marker-requests
state_root=/var/lib/phub-preflight/role-split-marker-state
app_root=/opt/phub
current_uid=$(id -u 2>/dev/null || true)
current_gid=$(id -g 2>/dev/null || true)
is_positive_decimal "$current_uid" && is_positive_decimal "$current_gid" || fail CUSTODY_INVALID
for directory in "$request_root:0:$current_gid:750" "$runtime_root:0:$current_gid:750" \
  "$state_root:$current_uid:$current_gid:700"; do
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
    1:PHUB_COMMUNITIES_ROLE_SPLIT_CLONE_MARKER_CLEANUP_REQUEST_V2) ;;
    2:restoreDatabase=*) restore_database=${line#*=} ;;
    3:cloneDatabaseOid=*) clone_oid=${line#*=} ;;
    4:cloneDatabaseOwner=*) clone_owner=${line#*=} ;;
    5:cloneDatabaseOwnerOid=*) clone_owner_oid=${line#*=} ;;
    6:markerRequestSha256=*) marker_request_sha=${line#*=} ;;
    7:markerValue=*) marker=${line#*=} ;;
    8:restoreRunId=*) run_id=${line#*=} ;;
    9:restoreRunAttempt=*) run_attempt=${line#*=} ;;
    10:cleanupWriterSha256=*) cleanup_writer_sha=${line#*=} ;;
    *) fail REQUEST_SHAPE_INVALID ;;
  esac
done < "$request"
test "$line_number" -eq 10 || fail REQUEST_SHAPE_INVALID
is_positive_decimal "$run_id" && is_positive_decimal "$run_attempt" &&
  is_positive_decimal "$clone_oid" || fail REQUEST_BINDING_INVALID
test "$restore_database" = "phub_restore_${run_id}_${run_attempt}" || fail REQUEST_BINDING_INVALID
test "$request_basename" = "communities-role-split-marker-cleanup-request-${run_id}-${run_attempt}.txt" ||
  fail REQUEST_BINDING_INVALID
is_sha256 "$marker_request_sha" && is_sha256 "$cleanup_writer_sha" || fail REQUEST_BINDING_INVALID
case "$clone_owner" in ''|[0-9]*|*[!A-Za-z0-9_]*) fail REQUEST_BINDING_INVALID ;; esac
is_positive_decimal "$clone_owner_oid" || fail REQUEST_BINDING_INVALID
case "$marker" in phub-communities-role-split-clone-v1:*) ;;
  *) fail REQUEST_BINDING_INVALID ;;
esac
marker_payload_sha=${marker#phub-communities-role-split-clone-v1:}
is_sha256 "$marker_payload_sha" || fail REQUEST_BINDING_INVALID

runtime=$runtime_root/$runtime_basename
test -f "$runtime" && test ! -L "$runtime" && test "$(stat -c %u "$runtime")" = 0 &&
  test "$(stat -c %g "$runtime")" = "$current_gid" && test "$(stat -c %a "$runtime")" = 440 ||
  fail RUNTIME_CUSTODY_INVALID
test "$(file_sha256 "$runtime" RUNTIME_SHA_INVALID)" = "$expected_runtime_sha" || fail RUNTIME_SHA_INVALID
runtime_line=0
while IFS= read -r line || test -n "$line"; do
  runtime_line=$((runtime_line + 1))
  case "$runtime_line:$line" in
    1:PHUB_COMMUNITIES_ROLE_SPLIT_MARKER_RUNTIME_BINDING_V1) ;;
    2:appRootDevice=*) app_root_device=${line#*=} ;;
    3:appRootInode=*) app_root_inode=${line#*=} ;;
    4:infrastructureEnvSha256=*) infrastructure_env_sha=${line#*=} ;;
    5:composeInfrastructureSha256=*) compose_sha=${line#*=} ;;
    6:releaseEnvSha256=*) release_env_sha=${line#*=} ;;
    7:composeProjectName=*) compose_project=${line#*=} ;;
    8:postgresContainerId=*) postgres_container_id=${line#*=} ;;
    9:postgresImageId=sha256:*) postgres_image_id=${line#*=} ;;
    *) fail RUNTIME_SHAPE_INVALID ;;
  esac
done < "$runtime"
test "$runtime_line" -eq 9 &&
  test "$runtime_basename" = "communities-role-split-marker-runtime-${run_id}-${run_attempt}.txt" ||
  fail RUNTIME_BINDING_INVALID
is_positive_decimal "$app_root_device" && is_positive_decimal "$app_root_inode" || fail RUNTIME_BINDING_INVALID
for value in "$infrastructure_env_sha" "$compose_sha" "$release_env_sha" "$postgres_container_id"; do
  is_sha256 "$value" || fail RUNTIME_BINDING_INVALID
done
is_sha256 "${postgres_image_id#sha256:}" || fail RUNTIME_BINDING_INVALID
case "$compose_project" in ''|[0-9]*|*[!a-z0-9_-]*) fail RUNTIME_BINDING_INVALID ;; esac
test "$(stat -c %u "$app_root")" = 0 && test "$(stat -c %d "$app_root")" = "$app_root_device" &&
  test "$(stat -c %i "$app_root")" = "$app_root_inode" && test "$(stat -c %h "$app_root")" = 1 ||
  fail APP_ROOT_CUSTODY_INVALID
app_root_mode=$(stat -c %a "$app_root")
case "$app_root_mode" in [0-7][0-7][0-7]) ;; *) fail APP_ROOT_CUSTODY_INVALID ;; esac
case "$app_root_mode" in ?[2367]?|??[2367]) fail APP_ROOT_CUSTODY_INVALID ;; esac
for binding in "infrastructure.env:READABLE:$infrastructure_env_sha" \
  "compose.infrastructure.yaml:644:$compose_sha" "release.env:644:$release_env_sha"; do
  old_ifs=$IFS; IFS=:; set -- $binding; IFS=$old_ifs
  artifact=$app_root/$1
  test -f "$artifact" && test ! -L "$artifact" && test "$(stat -c %u "$artifact")" = 0 &&
    test "$(stat -c %h "$artifact")" = 1 || fail APP_ARTIFACT_CUSTODY_INVALID
  if test "$2" = READABLE; then
    artifact_mode=$(stat -c %a "$artifact")
    test "$(stat -c %g "$artifact")" = "$current_gid" && test -r "$artifact" ||
      fail APP_ARTIFACT_CUSTODY_INVALID
    case "$artifact_mode" in 440|640) ;; *) fail APP_ARTIFACT_CUSTODY_INVALID ;; esac
  else
    test "$(stat -c %g "$artifact")" = 0 && test "$(stat -c %a "$artifact")" = "$2" ||
      fail APP_ARTIFACT_CUSTODY_INVALID
  fi
  before=$(stat -c '%d:%i:%s:%Y:%Z' "$artifact")
  test "$(file_sha256 "$artifact" APP_ARTIFACT_DIGEST_INVALID)" = "$3" &&
    test "$(stat -c '%d:%i:%s:%Y:%Z' "$artifact")" = "$before" || fail APP_ARTIFACT_CHANGED
done
if test -e "$app_root/.env" || test -L "$app_root/.env"; then
  env_mode=$(stat -c %a "$app_root/.env")
  test -f "$app_root/.env" && test ! -L "$app_root/.env" && test "$(stat -c %u "$app_root/.env")" = 0 &&
    test "$(stat -c %g "$app_root/.env")" = "$current_gid" && test "$(stat -c %h "$app_root/.env")" = 1 &&
    test -r "$app_root/.env" || fail APP_ARTIFACT_CUSTODY_INVALID
  case "$env_mode" in 440|640) ;; *) fail APP_ARTIFACT_CUSTODY_INVALID ;; esac
fi

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
  "MARKER_PENDING|$marker_request_sha|$clone_oid|$marker_value_sha"|"MARKED|$marker_request_sha|$clone_oid|$marker_value_sha"|"QUARANTINE_PENDING_RECONCILIATION_REQUIRED|$marker_request_sha|$clone_oid|$clone_owner|$clone_owner_oid|$marker_value_sha|$expected_cleanup_request_sha") ;;
  *) fail STATE_BINDING_INVALID ;;
esac

cd "$app_root"
atomic_state() {
  state_value=$1
  state_tmp=$(mktemp "$state_root/.state-${run_id}-${run_attempt}.XXXXXX")
  chmod 600 "$state_tmp"
  printf '%s\n' "$state_value" > "$state_tmp"
  /usr/bin/sync -f "$state_tmp"
  mv -f "$state_tmp" "$state_path"
  /usr/bin/sync -f "$state_root"
}
capture_command() {
  test -n "$1" || return 1
  shift
  command_status=$(mktemp "$state_root/.command-status-${run_id}-${run_attempt}.XXXXXX")
  chmod 600 "$command_status"
  captured=$(
    ("$@"; printf '%s' "$?" > "$command_status") 2>/dev/null |
      head -c 65537
  )
  status=$(cat "$command_status" 2>/dev/null || true)
  rm -f "$command_status"
  test "$status" = 0 || return 1
  test "$(printf '%s' "$captured" | wc -c)" -le 65536 || fail DIAGNOSTIC_OVERSIZE
  printf '%s' "$captured"
}
docker_capture() {
  capture_command DOCKER docker "$@"
}
container_exec() {
  capture_command DOCKER_EXEC docker exec -i "$postgres_container_id" "$@"
}
assert_container() {
  observed_container_binding=$(docker_capture inspect --format \
    '{{.Id}}|{{.Image}}|{{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "com.docker.compose.service"}}' \
    "$postgres_container_id") || fail CONTAINER_IDENTITY_INVALID
  test "$observed_container_binding" = "$postgres_container_id|$postgres_image_id|$compose_project|postgres" ||
    fail CONTAINER_IDENTITY_INVALID
}
admin_psql() {
  container_exec sh -ec \
    'PGOPTIONS="-c default_transaction_read_only=on -c statement_timeout=15000 -c lock_timeout=2000 -c search_path=pg_catalog" psql -X -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -At -F "|" -c "$1"' \
    sh "$1"
}
assert_container
observed=$(admin_psql "select d.oid::text||'|'||d.datname||'|'||r.rolname||'|'||r.oid::text||'|'||coalesce(shobj_description(d.oid, 'pg_database'), '') from pg_catalog.pg_database d join pg_catalog.pg_roles r on r.oid=d.datdba where d.oid=$clone_oid::oid;") ||
  fail QUARANTINE_RECONCILIATION_REQUIRED
test "$observed" = "$clone_oid|$restore_database|$clone_owner|$clone_owner_oid|$marker" ||
  fail QUARANTINE_RECONCILIATION_REQUIRED
atomic_state "QUARANTINE_PENDING_RECONCILIATION_REQUIRED|$marker_request_sha|$clone_oid|$clone_owner|$clone_owner_oid|$marker_value_sha|$expected_cleanup_request_sha"

printf '%s\n' \
  'schemaVersion=communities-role-split-clone-marker-cleanup-evidence-v1' \
  'status=QUARANTINE_PENDING_RECONCILIATION_REQUIRED' \
  "cleanupRequestSha256=$expected_cleanup_request_sha" \
  "markerRequestSha256=$marker_request_sha" \
  "markerValueSha256=$marker_value_sha" \
  "cloneDatabaseOid=$clone_oid" \
  "restoreRunId=$run_id" \
  "restoreRunAttempt=$run_attempt" \
  'binding.marker=true' \
  'binding.request=true' \
  'binding.cloneOid=true' \
  'authorizesDatabaseDeletion=false' \
  'authorizesDatabaseRename=false' \
  'authorizes.roleCreation=false' \
  'authorizes.roleSplit=false' \
  'authorizes.sharedDatabaseMutation=false' \
  'authorizes.migration=false' \
  'authorizes.deploy=false' \
  'authorizes.import=false' \
  'authorizes.activation=false'
