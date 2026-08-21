#!/bin/sh
set -eu

PATH=/usr/bin:/bin
export PATH
umask 077

fail() {
  /usr/bin/printf '%s\n' "COMMUNITIES_ROLE_SPLIT_ANCHOR_REHEARSAL_$1" >&2
  exit 1
}

[ "$#" -eq 7 ] || fail INPUT_INVALID
[ "$(/usr/bin/id -u)" = 0 ] || fail ROOT_REQUIRED
PROCESS_UID=$(/usr/bin/id -u phub-preflight 2>/dev/null || true)
PROCESS_GID=$(/usr/bin/id -g phub-preflight 2>/dev/null || true)
[ "$PROCESS_UID" = 998 ] || fail PROCESS_OWNER_INVALID
[ "$PROCESS_GID" = 993 ] || fail PROCESS_OWNER_INVALID
[ -x /usr/bin/timeout ] || fail TIMEOUT_UNAVAILABLE
[ -x /usr/bin/readlink ] || fail INPUT_CUSTODY_INVALID

BUNDLE=$1
BUNDLE_SHA256=$2
PRODUCTION_SUBJECT=$3
PRODUCTION_SUBJECT_SHA256=$4
REHEARSAL_SUBJECT=$5
REHEARSAL_SUBJECT_SHA256=$6
IMAGE_ID=$7
EXPECTED_PRODUCTION_SUBJECT_SHA256=078103b490907098b0815185a2442d5744ecf124c89aa92e103b94aef34dff77
EXPECTED_REHEARSAL_SUBJECT_SHA256=035f03b71776c475e90236f90f789d44eb491fa4af67a34289ced9833f42e7cb

case "$BUNDLE_SHA256:$PRODUCTION_SUBJECT_SHA256:$REHEARSAL_SUBJECT_SHA256" in
  *[!a-f0-9:]* | *::* ) fail INPUT_INVALID ;;
esac
[ "${#BUNDLE_SHA256}" -eq 64 ] || fail INPUT_INVALID
[ "${#PRODUCTION_SUBJECT_SHA256}" -eq 64 ] || fail INPUT_INVALID
[ "${#REHEARSAL_SUBJECT_SHA256}" -eq 64 ] || fail INPUT_INVALID
[ "$PRODUCTION_SUBJECT_SHA256" = "$EXPECTED_PRODUCTION_SUBJECT_SHA256" ] || \
  fail PRODUCTION_SUBJECT_PIN_INVALID
[ "$REHEARSAL_SUBJECT_SHA256" = "$EXPECTED_REHEARSAL_SUBJECT_SHA256" ] || \
  fail REHEARSAL_SUBJECT_PIN_INVALID
case "$IMAGE_ID" in
  sha256:????????????????????????????????????????????????????????????????) ;;
  *) fail IMAGE_ID_INVALID ;;
esac
case "${IMAGE_ID#sha256:}" in *[!a-f0-9]*) fail IMAGE_ID_INVALID ;; esac

assert_root_input() {
  INPUT_PATH=$1
  EXPECTED_SHA256=$2
  [ "${INPUT_PATH#/}" != "$INPUT_PATH" ] || fail INPUT_CUSTODY_INVALID
  case "$INPUT_PATH" in *[!A-Za-z0-9_./-]*) fail INPUT_CUSTODY_INVALID ;; esac
  INPUT_REAL=$(/usr/bin/readlink -f -- "$INPUT_PATH") || fail INPUT_CUSTODY_INVALID
  [ "$INPUT_REAL" = "$INPUT_PATH" ] || fail INPUT_CUSTODY_INVALID
  INPUT_PARENT=$(/usr/bin/dirname -- "$INPUT_PATH") || fail INPUT_CUSTODY_INVALID
  [ "$(/usr/bin/stat -c '%F|%u|%g|%a' -- "$INPUT_PARENT")" = 'directory|0|0|700' ] || \
    fail INPUT_CUSTODY_INVALID
  INPUT_METADATA=$(/usr/bin/stat -c '%F|%u|%g|%a|%h' -- "$INPUT_PATH") || \
    fail INPUT_CUSTODY_INVALID
  [ "$INPUT_METADATA" = 'regular file|0|0|444|1' ] || fail INPUT_CUSTODY_INVALID
  /usr/bin/printf '%s  %s\n' "$EXPECTED_SHA256" "$INPUT_PATH" | /usr/bin/sha256sum -c - \
    >/dev/null || fail INPUT_DIGEST_INVALID
}

assert_root_input "$BUNDLE" "$BUNDLE_SHA256"
assert_root_input "$PRODUCTION_SUBJECT" "$PRODUCTION_SUBJECT_SHA256"
assert_root_input "$REHEARSAL_SUBJECT" "$REHEARSAL_SUBJECT_SHA256"
[ "$BUNDLE" != "$PRODUCTION_SUBJECT" ] && [ "$BUNDLE" != "$REHEARSAL_SUBJECT" ] && \
  [ "$PRODUCTION_SUBJECT" != "$REHEARSAL_SUBJECT" ] || fail INPUT_CUSTODY_INVALID
BUNDLE_ID=$(/usr/bin/stat -c '%d:%i' -- "$BUNDLE") || fail INPUT_CUSTODY_INVALID
PRODUCTION_SUBJECT_ID=$(/usr/bin/stat -c '%d:%i' -- "$PRODUCTION_SUBJECT") || \
  fail INPUT_CUSTODY_INVALID
REHEARSAL_SUBJECT_ID=$(/usr/bin/stat -c '%d:%i' -- "$REHEARSAL_SUBJECT") || \
  fail INPUT_CUSTODY_INVALID
[ "$BUNDLE_ID" != "$PRODUCTION_SUBJECT_ID" ] && \
  [ "$BUNDLE_ID" != "$REHEARSAL_SUBJECT_ID" ] && \
  [ "$PRODUCTION_SUBJECT_ID" != "$REHEARSAL_SUBJECT_ID" ] || fail INPUT_CUSTODY_INVALID

ACTUAL_IMAGE_ID=$(/usr/bin/docker image inspect --format '{{.Id}}' "$IMAGE_ID") || \
  fail IMAGE_UNAVAILABLE
[ "$ACTUAL_IMAGE_ID" = "$IMAGE_ID" ] || fail IMAGE_ID_INVALID

PRODUCTION_ANCHOR=/var/lib/phub-role-split-external-anchor/74478e8f2ec91443709159ced1ee123345eb29e6/production
[ ! -e "$PRODUCTION_ANCHOR" ] && [ ! -L "$PRODUCTION_ANCHOR" ] || \
  fail PRODUCTION_ANCHOR_ALREADY_PRESENT

REHEARSAL_ROOT=/var/lib/phub-role-split-anchor-rehearsals
if [ ! -e "$REHEARSAL_ROOT" ]; then
  /bin/mkdir -m 0700 -- "$REHEARSAL_ROOT" || fail OUTPUT_CUSTODY_INVALID
  /bin/chown 0:0 -- "$REHEARSAL_ROOT" || fail OUTPUT_CUSTODY_INVALID
fi
[ "$(/usr/bin/stat -c '%F|%u|%g|%a' -- "$REHEARSAL_ROOT")" = 'directory|0|0|700' ] || \
  fail OUTPUT_CUSTODY_INVALID

RUN_KEY=$("/usr/bin/printf" '%s' "$BUNDLE_SHA256:$REHEARSAL_SUBJECT_SHA256" | \
  /usr/bin/sha256sum | /usr/bin/cut -d ' ' -f 1)
RUN_ROOT=$REHEARSAL_ROOT/$RUN_KEY
[ ! -e "$RUN_ROOT" ] && [ ! -L "$RUN_ROOT" ] || fail OUTPUT_ALREADY_PRESENT
/bin/mkdir -m 0700 -- "$RUN_ROOT" || fail OUTPUT_CUSTODY_INVALID
/bin/chown 0:0 -- "$RUN_ROOT" || fail OUTPUT_CUSTODY_INVALID

ANCHOR_DIRECTORY=$RUN_ROOT/anchor
STATE_DIRECTORY=$RUN_ROOT/state
BACKUP_DIRECTORY=$RUN_ROOT/backup
/bin/mkdir -m 0700 -- "$ANCHOR_DIRECTORY" "$STATE_DIRECTORY" "$BACKUP_DIRECTORY" || \
  fail OUTPUT_CUSTODY_INVALID
/bin/chown 998:993 -- "$ANCHOR_DIRECTORY" "$STATE_DIRECTORY" "$BACKUP_DIRECTORY" || \
  fail OUTPUT_CUSTODY_INVALID

REPORT_PATH=$RUN_ROOT/report.json
CONTAINER_NAME=phub-role-split-anchor-rehearsal-${RUN_KEY%????????????????????????????????????????????????}

cleanup_container() {
  if /usr/bin/docker container inspect "$CONTAINER_NAME" >/dev/null 2>&1; then
    /usr/bin/docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || return 1
  fi
  return 0
}
on_interrupt() {
  cleanup_container || true
  trap - EXIT
  exit 130
}
on_exit() {
  STATUS=$?
  if ! cleanup_container; then STATUS=1; fi
  trap - EXIT
  exit "$STATUS"
}
trap on_interrupt HUP INT TERM
trap on_exit EXIT

/usr/bin/timeout --signal=TERM --kill-after=10s 120s /usr/bin/docker run --rm \
  --name "$CONTAINER_NAME" \
  --pull never \
  --network none \
  --read-only \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --user 998:993 \
  --pids-limit 64 \
  --memory 256m \
  --cpus 1 \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m,uid=998,gid=993,mode=700 \
  --mount "type=bind,src=$BUNDLE,dst=/opt/phub/rehearsal.mjs,readonly" \
  --mount "type=bind,src=$PRODUCTION_SUBJECT,dst=/input/production-subject.json,readonly" \
  --mount "type=bind,src=$REHEARSAL_SUBJECT,dst=/input/rehearsal-subject.json,readonly" \
  --mount "type=bind,src=$ANCHOR_DIRECTORY,dst=/rehearsal/anchor" \
  --mount "type=bind,src=$STATE_DIRECTORY,dst=/rehearsal/state" \
  --mount "type=bind,src=$BACKUP_DIRECTORY,dst=/rehearsal/backup" \
  --entrypoint node \
  "$IMAGE_ID" \
  /opt/phub/rehearsal.mjs run \
  /input/production-subject.json "$PRODUCTION_SUBJECT_SHA256" \
  /input/rehearsal-subject.json "$REHEARSAL_SUBJECT_SHA256" \
  /opt/phub/rehearsal.mjs >"$REPORT_PATH" || fail REHEARSAL_FAILED

/bin/chmod 0600 -- "$REPORT_PATH" || fail REPORT_INVALID
/bin/chown 0:0 -- "$REPORT_PATH" || fail REPORT_INVALID
[ "$(/usr/bin/stat -c '%F|%u|%g|%a|%h' -- "$REPORT_PATH")" = 'regular file|0|0|600|1' ] || \
  fail REPORT_INVALID
[ "$(/usr/bin/wc -l <"$REPORT_PATH")" -eq 1 ] || fail REPORT_INVALID
REPORT_BYTES=$(/usr/bin/stat -c '%s' -- "$REPORT_PATH") || fail REPORT_INVALID
[ "$REPORT_BYTES" -gt 0 ] && [ "$REPORT_BYTES" -le 16384 ] || fail REPORT_INVALID
/bin/grep -F '"beforeAnchorCrash":"RECOVERED_TO_RESTORE_PENDING"' "$REPORT_PATH" >/dev/null || \
  fail REPORT_INVALID
/bin/grep -F '"afterAnchorCrash":"RECOVERED_TO_RESTORED"' "$REPORT_PATH" >/dev/null || \
  fail REPORT_INVALID
/bin/grep -F '"completeLocalRollback":"STATE_ROLLBACK_DETECTED"' "$REPORT_PATH" >/dev/null || \
  fail REPORT_INVALID
/bin/grep -F '"productionAnchorTouched":false' "$REPORT_PATH" >/dev/null || \
  fail REPORT_INVALID
/bin/grep -F '"databaseAccessed":false' "$REPORT_PATH" >/dev/null || fail REPORT_INVALID
/bin/grep -F '"wholeHostCrashTested":false' "$REPORT_PATH" >/dev/null || fail REPORT_INVALID
/bin/grep -F '"authorizesLeaseRemoval":false' "$REPORT_PATH" >/dev/null || fail REPORT_INVALID
/bin/grep -F "\"productionSubjectSha256\":\"$PRODUCTION_SUBJECT_SHA256\"" "$REPORT_PATH" \
  >/dev/null || fail REPORT_INVALID
/bin/grep -F "\"rehearsalSubjectSha256\":\"$REHEARSAL_SUBJECT_SHA256\"" "$REPORT_PATH" \
  >/dev/null || fail REPORT_INVALID

[ ! -e "$PRODUCTION_ANCHOR" ] && [ ! -L "$PRODUCTION_ANCHOR" ] || \
  fail PRODUCTION_ANCHOR_TOUCHED
REPORT_SHA256=$(/usr/bin/sha256sum "$REPORT_PATH" | /usr/bin/cut -d ' ' -f 1)
/usr/bin/printf '%s\n' \
  "COMMUNITIES_ROLE_SPLIT_ANCHOR_REHEARSAL_PASSED|candidate=74478e8f2ec91443709159ced1ee123345eb29e6|report=$REPORT_SHA256|production_anchor_touched=false|database_accessed=false|authorizes_ceremony=false|authorizes_database_mutation=false"
