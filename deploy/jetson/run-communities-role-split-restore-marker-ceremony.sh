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
if test "${PHUB_COMMUNITIES_MARKER_TIMEOUT_ACTIVE:-}" != 1; then
  exec "$timeout_path" --signal=TERM --kill-after=15s 45m \
    /usr/bin/env -i PATH="$PATH" PHUB_COMMUNITIES_MARKER_TIMEOUT_ACTIVE=1 \
    SSH_ORIGINAL_COMMAND="${SSH_ORIGINAL_COMMAND:-}" "$script_path"
fi

fail() {
  printf '%s\n' "COMMUNITIES_ROLE_SPLIT_RESTORE_MARKER_CEREMONY_$1" >&2
  exit 1
}

is_sha256() {
  test "${#1}" -eq 64 || return 1
  case "$1" in *[!0-9a-f]*) return 1 ;; esac
}

is_positive_decimal() {
  case "$1" in ''|0|0*|*[!0-9]*) return 1 ;; esac
}

is_identifier() {
  case "$1" in ''|[0-9]*|*[!A-Za-z0-9_]*) return 1 ;; esac
}

file_value() {
  stat -c "$2" "$1" 2>/dev/null || fail "$3"
}

file_sha256() {
  output=$(sha256sum "$1" 2>/dev/null || true)
  digest=${output%%[[:space:]]*}
  is_sha256 "$digest" || fail "$2"
  printf '%s' "$digest"
}

assert_file() {
  path=$1 expected_uid=$2 expected_gid=$3 expected_mode=$4 error=$5
  test -f "$path" && test ! -L "$path" || fail "$error"
  test "$(file_value "$path" %u "$error")" = "$expected_uid" || fail "$error"
  test "$(file_value "$path" %g "$error")" = "$expected_gid" || fail "$error"
  test "$(file_value "$path" %a "$error")" = "$expected_mode" || fail "$error"
}

original_command=${SSH_ORIGINAL_COMMAND:-}
printf '%s' "$original_command" | grep -Eq \
  '^RUN_COMMUNITIES_ROLE_SPLIT_RESTORE_MARKER_CEREMONY_V1 [A-Za-z0-9._-]+ [0-9a-f]{64} [A-Za-z0-9._-]+ [0-9a-f]{64}$' \
  >/dev/null 2>&1 || fail CONFIRMATION_INVALID
old_ifs=$IFS
IFS=' '
set -f
set -- $original_command
set +f
IFS=$old_ifs
test "$#" -eq 5 || fail CONFIRMATION_INVALID
request_basename=$2
expected_request_sha=$3
runtime_basename=$4
expected_runtime_sha=$5
printf '%s' "$request_basename" | grep -Eq \
  '^communities-role-split-marker-request-[1-9][0-9]*-[1-9][0-9]*\.txt$' \
  >/dev/null 2>&1 || fail REQUEST_PATH_INVALID
is_sha256 "$expected_request_sha" || fail REQUEST_SHA_INVALID
printf '%s' "$runtime_basename" | grep -Eq \
  '^communities-role-split-marker-runtime-[1-9][0-9]*-[1-9][0-9]*\.txt$' \
  >/dev/null 2>&1 || fail RUNTIME_PATH_INVALID
is_sha256 "$expected_runtime_sha" || fail RUNTIME_SHA_INVALID

request_root=/var/lib/phub-preflight/role-split-marker-requests
backup_root=/var/lib/phub-preflight/backups
state_root=/var/lib/phub-preflight/role-split-marker-state
app_root=/opt/phub
restore_helper=/usr/local/libexec/phub/verify-postgres-backup-restore.sh
expected_manifest_sha=4898518b26d8adfccc2494bbcb03d82d2a051d94be05f07f08a6702ad190c605

current_uid=$(id -u 2>/dev/null || true)
current_gid=$(id -g 2>/dev/null || true)
is_positive_decimal "$current_uid" || fail CUSTODY_INVALID
is_positive_decimal "$current_gid" || fail CUSTODY_INVALID
for directory in "$request_root:0:$current_gid:750" "$backup_root:0:$current_gid:750" \
  "$state_root:$current_uid:$current_gid:700"; do
  old_ifs=$IFS; IFS=:; set -- $directory; IFS=$old_ifs
  test -d "$1" && test ! -L "$1" || fail CUSTODY_INVALID
  test "$(file_value "$1" %u CUSTODY_INVALID)" = "$2" || fail CUSTODY_INVALID
  test "$(file_value "$1" %g CUSTODY_INVALID)" = "$3" || fail CUSTODY_INVALID
  test "$(file_value "$1" %a CUSTODY_INVALID)" = "$4" || fail CUSTODY_INVALID
done
test -d "$app_root" && test ! -L "$app_root" || fail CUSTODY_INVALID

request=$request_root/$request_basename
assert_file "$request" 0 "$current_gid" 440 REQUEST_CUSTODY_INVALID
request_bytes=$(wc -c < "$request" 2>/dev/null | tr -d ' ' || true)
is_positive_decimal "$request_bytes" || fail REQUEST_SHAPE_INVALID
test "$request_bytes" -le 8192 || fail REQUEST_SHAPE_INVALID
test "$(file_sha256 "$request" REQUEST_SHA_INVALID)" = "$expected_request_sha" ||
  fail REQUEST_SHA_INVALID
request_octets=$(od -An -v -tu1 "$request" 2>/dev/null) || fail REQUEST_SHAPE_INVALID
test -n "$request_octets" || fail REQUEST_SHAPE_INVALID
printf '%s\n' "$request_octets" | awk -v expected="$request_bytes" '
  { for (i = 1; i <= NF; i += 1) {
      byte = $i + 0; count += 1
      if (!(byte == 10 || byte == 45 || byte == 46 || byte == 61 ||
            (byte >= 48 && byte <= 57) || (byte >= 65 && byte <= 90) ||
            byte == 95 || (byte >= 97 && byte <= 122))) invalid = 1
  }}
  END { exit (!invalid && count == expected) ? 0 : 1 }
' >/dev/null 2>&1 || fail REQUEST_SHAPE_INVALID
last_byte=$(tail -c 1 "$request" 2>/dev/null || true; printf x)
test "$last_byte" = "$(printf '\nx')" || fail REQUEST_SHAPE_INVALID

line_number=0
while IFS= read -r line || test -n "$line"; do
  line_number=$((line_number + 1))
  case "$line_number:$line" in
    1:PHUB_COMMUNITIES_ROLE_SPLIT_CLONE_MARKER_REQUEST_V1) ;;
    2:restoreDatabase=*) restore_database=${line#*=} ;;
    3:expectedCloneDatabaseOwner=*) clone_owner=${line#*=} ;;
    4:expectedCloneDatabaseOwnerOid=*) clone_owner_oid=${line#*=} ;;
    5:sourceDatabase=*) source_database=${line#*=} ;;
    6:sourceDatabaseOid=*) source_database_oid=${line#*=} ;;
    7:sourceDatabaseOwner=*) source_owner=${line#*=} ;;
    8:sourceDatabaseOwnerOid=*) source_owner_oid=${line#*=} ;;
    9:systemIdentifier=*) system_identifier=${line#*=} ;;
    10:backupBasename=*) backup_basename=${line#*=} ;;
    11:backupSha256=*) backup_sha=${line#*=} ;;
    12:backupBytes=*) backup_bytes=${line#*=} ;;
    13:backupEvidenceBasename=*) evidence_basename=${line#*=} ;;
    14:backupEvidenceSha256=*) evidence_sha=${line#*=} ;;
    15:archiveTocSha256=*) archive_toc_sha=${line#*=} ;;
    16:sourceLedgerSha256=*) ledger_sha=${line#*=} ;;
    17:sourceLedgerCount=*) ledger_count=${line#*=} ;;
    18:activeRelease=*) active_release=${line#*=} ;;
    19:restoreRunId=*) run_id=${line#*=} ;;
    20:restoreRunAttempt=*) run_attempt=${line#*=} ;;
    21:postgresMajor=*) postgres_major=${line#*=} ;;
    22:objectManifestSha256=*) manifest_sha=${line#*=} ;;
    23:restoreHelperSha256=*) helper_sha=${line#*=} ;;
    24:markerWriterSha256=*) writer_sha=${line#*=} ;;
    *) fail REQUEST_SHAPE_INVALID ;;
  esac
done < "$request"
test "$line_number" -eq 24 || fail REQUEST_SHAPE_INVALID

is_positive_decimal "$run_id" && is_positive_decimal "$run_attempt" || fail REQUEST_BINDING_INVALID
test "$request_basename" = "communities-role-split-marker-request-${run_id}-${run_attempt}.txt" ||
  fail REQUEST_BINDING_INVALID
test "$restore_database" = "phub_restore_${run_id}_${run_attempt}" || fail REQUEST_BINDING_INVALID
for value in "$clone_owner" "$source_database" "$source_owner"; do
  is_identifier "$value" || fail REQUEST_BINDING_INVALID
done
test "$source_database" != "$restore_database" || fail REQUEST_BINDING_INVALID
for value in "$clone_owner_oid" "$source_database_oid" "$source_owner_oid" \
  "$system_identifier" "$backup_bytes" "$ledger_count"; do
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
case "$active_release" in *[!0-9a-f]*) fail REQUEST_BINDING_INVALID ;; esac
test "${#active_release}" -eq 40 || fail REQUEST_BINDING_INVALID
test "$postgres_major" = 16 && test "$manifest_sha" = "$expected_manifest_sha" ||
  fail REQUEST_BINDING_INVALID

runtime=$request_root/$runtime_basename
assert_file "$runtime" 0 "$current_gid" 440 RUNTIME_CUSTODY_INVALID
test "$(file_sha256 "$runtime" RUNTIME_SHA_INVALID)" = "$expected_runtime_sha" ||
  fail RUNTIME_SHA_INVALID
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
test "$runtime_line" -eq 9 || fail RUNTIME_SHAPE_INVALID
test "$runtime_basename" = "communities-role-split-marker-runtime-${run_id}-${run_attempt}.txt" ||
  fail RUNTIME_BINDING_INVALID
is_positive_decimal "$app_root_device" && is_positive_decimal "$app_root_inode" ||
  fail RUNTIME_BINDING_INVALID
for value in "$infrastructure_env_sha" "$compose_sha" "$release_env_sha" "$postgres_container_id"; do
  is_sha256 "$value" || fail RUNTIME_BINDING_INVALID
done
case "$postgres_image_id" in sha256:*) is_sha256 "${postgres_image_id#sha256:}" || fail RUNTIME_BINDING_INVALID ;; esac
case "$compose_project" in ''|[0-9]*|*[!a-z0-9_-]*) fail RUNTIME_BINDING_INVALID ;; esac

test "$(file_value "$app_root" %u APP_ROOT_CUSTODY_INVALID)" = 0 &&
  test "$(file_value "$app_root" %d APP_ROOT_CUSTODY_INVALID)" = "$app_root_device" &&
  test "$(file_value "$app_root" %i APP_ROOT_CUSTODY_INVALID)" = "$app_root_inode" ||
  fail APP_ROOT_CUSTODY_INVALID
for binding in "infrastructure.env:600:$infrastructure_env_sha" \
  "compose.infrastructure.yaml:644:$compose_sha" "release.env:644:$release_env_sha"; do
  old_ifs=$IFS; IFS=:; set -- $binding; IFS=$old_ifs
  artifact=$app_root/$1
  assert_file "$artifact" 0 0 "$2" APP_ARTIFACT_CUSTODY_INVALID
  test "$(file_value "$artifact" %h APP_ARTIFACT_CUSTODY_INVALID)" = 1 ||
    fail APP_ARTIFACT_CUSTODY_INVALID
  before=$(stat -c '%d:%i:%s:%Y:%Z' "$artifact")
  test "$(file_sha256 "$artifact" APP_ARTIFACT_DIGEST_INVALID)" = "$3" ||
    fail APP_ARTIFACT_DIGEST_INVALID
  test "$(stat -c '%d:%i:%s:%Y:%Z' "$artifact")" = "$before" ||
    fail APP_ARTIFACT_CHANGED
done
cd "$app_root"

script=$(readlink -f "$0" 2>/dev/null || true)
test -n "$script" || fail SCRIPT_CUSTODY_INVALID
script_uid=$(file_value "$script" %u SCRIPT_CUSTODY_INVALID)
assert_file "$script" "$script_uid" "$(file_value "$script" %g SCRIPT_CUSTODY_INVALID)" \
  "$(file_value "$script" %a SCRIPT_CUSTODY_INVALID)" SCRIPT_CUSTODY_INVALID
case "$(file_value "$script" %a SCRIPT_CUSTODY_INVALID)" in 700|744|755) ;; *) fail SCRIPT_CUSTODY_INVALID ;; esac
test "$script_uid" = 0 || fail SCRIPT_CUSTODY_INVALID
helper_gid=$(file_value "$restore_helper" %g RESTORE_HELPER_CUSTODY_INVALID)
helper_mode=$(file_value "$restore_helper" %a RESTORE_HELPER_CUSTODY_INVALID)
assert_file "$restore_helper" 0 "$helper_gid" "$helper_mode" RESTORE_HELPER_CUSTODY_INVALID
case "$helper_mode" in 700|744|755) ;; *) fail RESTORE_HELPER_CUSTODY_INVALID ;; esac
test "$(file_sha256 "$script" SCRIPT_CUSTODY_INVALID)" = "$writer_sha" || fail SCRIPT_CUSTODY_INVALID
test "$(file_sha256 "$restore_helper" RESTORE_HELPER_CUSTODY_INVALID)" = "$helper_sha" ||
  fail RESTORE_HELPER_CUSTODY_INVALID

backup=$backup_root/$backup_basename
evidence=$backup_root/$evidence_basename
assert_file "$backup" 0 "$current_gid" 440 BACKUP_CUSTODY_INVALID
test "$(file_value "$backup" %h BACKUP_CUSTODY_INVALID)" = 1 || fail BACKUP_CUSTODY_INVALID
test -s "$backup" || fail BACKUP_CUSTODY_INVALID
backup_stat=$(stat -c '%d:%i:%s:%Y:%Z:%h:%u:%g:%a' "$backup")
test "$(printf '%s' "$backup_stat" | cut -d: -f3)" = "$backup_bytes" || fail BACKUP_CUSTODY_INVALID
exec 8<"$backup"
backup_fd=/proc/$$/fd/8
test "$(stat -c '%d:%i' "$backup_fd")" = "$(stat -c '%d:%i' "$backup")" || fail BACKUP_CUSTODY_INVALID
test "$(file_sha256 "$backup_fd" BACKUP_CUSTODY_INVALID)" = "$backup_sha" || fail BACKUP_CUSTODY_INVALID
test "$(stat -c '%d:%i:%s:%Y:%Z:%h:%u:%g:%a' "$backup")" = "$backup_stat" || fail BACKUP_CHANGED
assert_file "$evidence" 0 "$current_gid" 440 BACKUP_EVIDENCE_CUSTODY_INVALID
test "$(file_sha256 "$evidence" BACKUP_EVIDENCE_CUSTODY_INVALID)" = "$evidence_sha" ||
  fail BACKUP_EVIDENCE_CUSTODY_INVALID

lock_path=$state_root/.communities-role-split-marker.lock
if test -e "$lock_path" || test -L "$lock_path"; then
  test -f "$lock_path" && test ! -L "$lock_path" || fail LOCK_CUSTODY_INVALID
  test "$(file_value "$lock_path" %u LOCK_CUSTODY_INVALID)" = "$current_uid" ||
    fail LOCK_CUSTODY_INVALID
else
  (umask 077; set -C; : > "$lock_path") || fail LOCK_CUSTODY_INVALID
fi
chmod 600 "$lock_path"
exec 9<>"$lock_path"
flock -n 9 || fail LOCK_BUSY
unresolved=$(find "$state_root" -maxdepth 1 -type f -name '.communities-role-split-marker-*.state' \
  ! -exec grep -Eq '^CLEANED(_PRE_MARKER)?\|' {} \; -print -quit)
test -z "$unresolved" || fail UNRESOLVED_STATE
state_path=$state_root/.communities-role-split-marker-${run_id}-${run_attempt}.state
atomic_state() {
  state_value=$1
  state_tmp=$(mktemp "$state_root/.state-${run_id}-${run_attempt}.XXXXXX")
  chmod 600 "$state_tmp"
  printf '%s\n' "$state_value" > "$state_tmp"
  /usr/bin/sync -f "$state_tmp"
  mv -f "$state_tmp" "$state_path"
  /usr/bin/sync -f "$state_root"
}
test ! -e "$state_path" && test ! -L "$state_path" || fail STATE_CREATE_FAILED
atomic_state "CANDIDATE|$expected_request_sha"

infrastructure() {
  capture_command DOCKER_COMPOSE docker compose --project-name "$compose_project" \
    --env-file infrastructure.env -f compose.infrastructure.yaml "$@"
}
capture_command() {
  label=$1
  shift
  diagnostic_out=$(mktemp "$state_root/.diagnostic-${run_id}-${run_attempt}-${label}.out.XXXXXX")
  diagnostic_err=$(mktemp "$state_root/.diagnostic-${run_id}-${run_attempt}-${label}.err.XXXXXX")
  chmod 600 "$diagnostic_out" "$diagnostic_err"
  if (ulimit -f 128; "$@") >"$diagnostic_out" 2>"$diagnostic_err"; then
    test "$(wc -c < "$diagnostic_out")" -le 65536 &&
      test "$(wc -c < "$diagnostic_err")" -le 65536 || fail DIAGNOSTIC_OVERSIZE
    cat "$diagnostic_out"
    rm -f "$diagnostic_out" "$diagnostic_err"
    return 0
  fi
  return 1
}
docker_capture() {
  capture_command DOCKER docker "$@"
}
assert_container() {
  observed_container=$(infrastructure ps -q postgres) || fail CONTAINER_IDENTITY_INVALID
  test "$observed_container" = "$postgres_container_id" || fail CONTAINER_IDENTITY_INVALID
  observed_container_binding=$(docker_capture inspect --format \
    '{{.Id}}|{{.Image}}|{{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "com.docker.compose.service"}}' \
    "$postgres_container_id") || fail CONTAINER_IDENTITY_INVALID
  test "$observed_container_binding" = "$postgres_container_id|$postgres_image_id|$compose_project|postgres" ||
    fail CONTAINER_IDENTITY_INVALID
}
admin_psql() {
  infrastructure exec -T postgres sh -ec \
    'PGOPTIONS="-c default_transaction_read_only=on -c statement_timeout=15000 -c lock_timeout=2000 -c search_path=pg_catalog" psql -X -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -At -F "|" -c "$1"' \
    sh "$1"
}
database_psql() {
  database=$1 sql=$2
  infrastructure exec -T postgres sh -ec \
    'PGOPTIONS="-c default_transaction_read_only=on -c statement_timeout=15000 -c lock_timeout=2000 -c search_path=pg_catalog" psql -X -U "$POSTGRES_USER" -d "$1" -v ON_ERROR_STOP=1 -At -F "|" -c "$2"' \
    sh "$database" "$sql"
}
source_identity() {
  admin_psql "select d.oid::text, r.rolname, r.oid::text, (select system_identifier::text from pg_catalog.pg_control_system()) from pg_catalog.pg_database d join pg_catalog.pg_roles r on r.oid=d.datdba where d.datname='$source_database';"
}
source_ledger() {
  database_psql "$source_database" 'select filename, checksum from public.schema_migrations order by filename;'
}
assert_container
clone_created=false
clone_oid=
cleanup_forbidden=false
payload=
cleanup_before_marker() {
  if test -n "$payload" && test -f "$payload" && test ! -L "$payload"; then
    rm -f "$payload"
    payload=
  fi
  test "$cleanup_forbidden" = false || return 0
  if test "$clone_created" = true; then
    test -n "$clone_oid" || return 1
    assert_container || return 1
    observed_binding=$(admin_psql "select d.oid::text||'|'||r.rolname||'|'||r.oid::text||'|'||coalesce(shobj_description(d.oid, 'pg_database'), '') from pg_catalog.pg_database d join pg_catalog.pg_roles r on r.oid=d.datdba where d.datname='$restore_database';") || return 1
    test "$observed_binding" = "$clone_oid|$clone_owner|$clone_owner_oid|" || return 1
    atomic_state "PRE_MARKER_DROPPING|$expected_request_sha|$clone_oid"
    if ! infrastructure exec -T postgres sh -ec 'dropdb -U "$POSTGRES_USER" "$1"' \
      sh "$restore_database" >/dev/null; then
      remaining_oid=$(admin_psql "select oid::text from pg_catalog.pg_database where datname='$restore_database';") || return 1
      test -z "$remaining_oid" || return 1
    fi
    remaining_oid=$(admin_psql "select oid::text from pg_catalog.pg_database where datname='$restore_database';") || return 1
    test -z "$remaining_oid" || return 1
    atomic_state "CLEANED_PRE_MARKER|$expected_request_sha|$clone_oid"
    clone_created=false
  else
    atomic_state "CLEANED_PRE_MARKER|$expected_request_sha|NONE"
  fi
}
on_exit() {
  status=$?
  trap - EXIT HUP INT TERM
  if test "$status" -ne 0 && ! cleanup_before_marker; then
    printf '%s\n' COMMUNITIES_ROLE_SPLIT_RESTORE_MARKER_CEREMONY_CLEANUP_REQUIRES_RECONCILIATION >&2
    exit 1
  fi
  exit "$status"
}
on_signal() {
  trap - EXIT HUP INT TERM
  cleanup_before_marker || exit 1
  exit 130
}
trap on_exit EXIT
trap on_signal HUP INT TERM

source_identity_before=$(source_identity)
test "$source_identity_before" = "$source_database_oid|$source_owner|$source_owner_oid|$system_identifier" ||
  fail SOURCE_IDENTITY_MISMATCH
source_ledger_before=$(source_ledger)
test -n "$source_ledger_before" || fail SOURCE_LEDGER_MISMATCH
observed_source_count=$(printf '%s\n' "$source_ledger_before" | wc -l | tr -d ' ')
observed_source_sha=$(printf '%s\n' "$source_ledger_before" | sha256sum | cut -d ' ' -f 1)
test "$observed_source_count" = "$ledger_count" && test "$observed_source_sha" = "$ledger_sha" ||
  fail SOURCE_LEDGER_MISMATCH
observed_role=$(admin_psql "select r.rolname||'|'||r.oid::text from pg_catalog.pg_roles r where r.rolname='$clone_owner' and r.rolcanlogin and not r.rolsuper and not r.rolbypassrls and not r.rolcreatedb and not r.rolcreaterole and not r.rolreplication and not exists (select 1 from pg_catalog.pg_auth_members m where m.roleid=r.oid or m.member=r.oid);")
test "$observed_role" = "$clone_owner|$clone_owner_oid" || fail CLONE_OWNER_INVALID
server_version_num=$(admin_psql "show server_version_num;")
case "$server_version_num" in 16[0-9][0-9][0-9][0-9]) ;; *) fail POSTGRES_MAJOR_MISMATCH ;; esac
observed_release=$(sed -n 's/^RELEASE=//p' "$app_root/release.env" 2>/dev/null || true)
test "$observed_release" = "$active_release" || fail ACTIVE_RELEASE_MISMATCH
test -z "$(admin_psql "select oid::text from pg_catalog.pg_database where datname='$restore_database';")" ||
  fail CLONE_ALREADY_EXISTS

test "$(stat -c '%d:%i:%s:%Y:%Z:%h:%u:%g:%a' "$backup")" = "$backup_stat" || fail BACKUP_CHANGED
archive_toc=$(infrastructure exec -T postgres pg_restore --list < "$backup_fd") || fail ARCHIVE_TOC_INVALID
test "$(stat -c '%d:%i:%s:%Y:%Z:%h:%u:%g:%a' "$backup")" = "$backup_stat" || fail BACKUP_CHANGED
test -n "$archive_toc" || fail ARCHIVE_TOC_INVALID
test "$(printf '%s\n' "$archive_toc" | sha256sum | cut -d ' ' -f 1)" = "$archive_toc_sha" ||
  fail ARCHIVE_TOC_INVALID
printf '%s\n' "$archive_toc" | awk '$4 == "ACL" || ($4 == "DEFAULT" && $5 == "ACL") { found=1 } END { exit found ? 0 : 1 }' ||
  fail ARCHIVE_ACL_MISSING

assert_container
if ! infrastructure exec -T postgres sh -ec \
  'createdb -U "$POSTGRES_USER" --template=template0 --owner="$1" "$2"' \
  sh "$clone_owner" "$restore_database" >/dev/null; then
  atomic_state "CANDIDATE_RECONCILIATION_REQUIRED|$expected_request_sha"
  cleanup_forbidden=true
  fail CREATEDB_AMBIGUOUS
fi
clone_created=true
clone_identity=$(admin_psql "select d.oid::text, r.rolname, r.oid::text from pg_catalog.pg_database d join pg_catalog.pg_roles r on r.oid=d.datdba where d.datname='$restore_database';")
clone_oid=${clone_identity%%|*}
is_positive_decimal "$clone_oid" || fail CLONE_IDENTITY_MISMATCH
test "$clone_oid" != "$source_database_oid" && test "$clone_identity" = "$clone_oid|$clone_owner|$clone_owner_oid" ||
  fail CLONE_IDENTITY_MISMATCH
atomic_state "OWNED|$expected_request_sha|$clone_oid"

assert_container
test "$(stat -c '%d:%i:%s:%Y:%Z:%h:%u:%g:%a' "$backup")" = "$backup_stat" || fail BACKUP_CHANGED
infrastructure exec -T postgres sh -ec \
  'pg_restore -U "$POSTGRES_USER" --exit-on-error --no-password --dbname="$1"' \
  sh "$restore_database" < "$backup_fd" >/dev/null || fail RESTORE_FAILED
test "$(stat -c '%d:%i:%s:%Y:%Z:%h:%u:%g:%a' "$backup")" = "$backup_stat" || fail BACKUP_CHANGED
clone_ledger=$(database_psql "$restore_database" 'select filename, checksum from public.schema_migrations order by filename;')
test "$clone_ledger" = "$source_ledger_before" || fail CLONE_LEDGER_MISMATCH
test "$(source_identity)" = "$source_identity_before" && test "$(source_ledger)" = "$source_ledger_before" ||
  fail SOURCE_CHANGED
test "$(admin_psql "select d.oid::text||'|'||r.rolname||'|'||r.oid::text from pg_catalog.pg_database d join pg_catalog.pg_roles r on r.oid=d.datdba where d.datname='$restore_database';")" = "$clone_oid|$clone_owner|$clone_owner_oid" ||
  fail CLONE_IDENTITY_MISMATCH

payload=$(mktemp "$state_root/.marker-payload.XXXXXX")
printf '%s\n' \
  PHUB_COMMUNITIES_ROLE_SPLIT_CLONE_MARKER_V1 \
  "requestSha256=$expected_request_sha" \
  "restoreDatabase=$restore_database" \
  "cloneDatabaseOid=$clone_oid" \
  "cloneDatabaseOwner=$clone_owner" \
  "cloneDatabaseOwnerOid=$clone_owner_oid" \
  "sourceDatabase=$source_database" \
  "sourceDatabaseOid=$source_database_oid" \
  "sourceDatabaseOwner=$source_owner" \
  "sourceDatabaseOwnerOid=$source_owner_oid" \
  "systemIdentifier=$system_identifier" \
  "backupSha256=$backup_sha" \
  "backupBytes=$backup_bytes" \
  "backupEvidenceSha256=$evidence_sha" \
  "archiveTocSha256=$archive_toc_sha" \
  "sourceLedgerSha256=$ledger_sha" \
  "sourceLedgerCount=$ledger_count" \
  "activeRelease=$active_release" \
  "restoreRunId=$run_id" \
  "restoreRunAttempt=$run_attempt" \
  "postgresMajor=$postgres_major" \
  "objectManifestSha256=$manifest_sha" \
  "restoreHelperSha256=$helper_sha" \
  "markerWriterSha256=$writer_sha" > "$payload"
marker_payload_sha=$(file_sha256 "$payload" PAYLOAD_INVALID)
marker="phub-communities-role-split-clone-v1:$marker_payload_sha"
marker_value_sha=$(printf '%s' "$marker" | sha256sum | cut -d ' ' -f 1)
clone_binding_sha=$(printf '%s\0%s' "$restore_database" "$clone_oid" | sha256sum | cut -d ' ' -f 1)
source_binding_sha=$(printf '%s\0%s\0%s' "$source_database" "$source_database_oid" "$system_identifier" | sha256sum | cut -d ' ' -f 1)
rm -f "$payload"
payload=

atomic_state "MARKER_PENDING|$expected_request_sha|$clone_oid|$marker_value_sha"
cleanup_forbidden=true
assert_container
comment_sql="do \$\$ declare observed_oid oid; observed_owner oid; observed_comment text; begin select d.oid,d.datdba,shobj_description(d.oid,'pg_database') into observed_oid,observed_owner,observed_comment from pg_catalog.pg_database d where d.datname='$restore_database'; if observed_oid is distinct from $clone_oid::oid or observed_owner is distinct from $clone_owner_oid::oid or observed_comment is not null then raise exception 'binding mismatch'; end if; execute format('COMMENT ON DATABASE %I IS %L','$restore_database','$marker'); end \$\$;"
if ! infrastructure exec -T postgres sh -ec \
  'psql -X -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -c "$1"' \
  sh "$comment_sql" >/dev/null; then
  fail MARKER_ACTION_AMBIGUOUS
fi
readback=$(admin_psql "select d.oid::text||'|'||r.rolname||'|'||r.oid::text||'|'||coalesce(shobj_description(d.oid, 'pg_database'), '') from pg_catalog.pg_database d join pg_catalog.pg_roles r on r.oid=d.datdba where d.datname='$restore_database';")
test "$readback" = "$clone_oid|$clone_owner|$clone_owner_oid|$marker" || fail MARKER_READBACK_MISMATCH
atomic_state "MARKED|$expected_request_sha|$clone_oid|$marker_value_sha"
test "$(source_identity)" = "$source_identity_before" && test "$(source_ledger)" = "$source_ledger_before" ||
  fail SOURCE_CHANGED

printf '%s\n' \
  'schemaVersion=communities-role-split-clone-marker-evidence-v1' \
  'status=MARKED' \
  "requestSha256=$expected_request_sha" \
  "markerPayloadSha256=$marker_payload_sha" \
  "markerValueSha256=$marker_value_sha" \
  "backupSha256=$backup_sha" \
  "sourceLedgerSha256=$ledger_sha" \
  "sourceLedgerCount=$ledger_count" \
  "cloneDatabaseOid=$clone_oid" \
  "cloneBindingSha256=$clone_binding_sha" \
  "sourceBindingSha256=$source_binding_sha" \
  "restoreRunId=$run_id" \
  "restoreRunAttempt=$run_attempt" \
  "restoreHelperSha256=$helper_sha" \
  "markerWriterSha256=$writer_sha" \
  'binding.request=true' \
  'binding.backup=true' \
  'binding.archiveOwnershipAcl=true' \
  'binding.sourceStable=true' \
  'binding.restoredLedger=true' \
  'binding.cloneIdentity=true' \
  'binding.markerReadback=true' \
  'authorizes.roleCreation=false' \
  'authorizes.roleSplit=false' \
  'authorizes.sharedDatabaseMutation=false' \
  'authorizes.migration=false' \
  'authorizes.deploy=false' \
  'authorizes.import=false' \
  'authorizes.activation=false'

trap - EXIT HUP INT TERM
