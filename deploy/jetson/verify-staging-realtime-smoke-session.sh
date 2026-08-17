#!/bin/sh
set -eu

fail() {
  printf '%s\n' "staging_realtime_smoke_session status=failed code=$1" >&2
  exit 1
}

test "$#" -eq 1 || fail SMOKE_WRAPPER_USAGE_INVALID
bundle_path=$1
case "$bundle_path" in
  /opt/phub/b0-candidates/* | /opt/phub/staging-realtime-smoke-runs/*) ;;
  *) fail SMOKE_BUNDLE_PATH_INVALID ;;
esac
bundle_id=${bundle_path##*/}
printf '%s' "$bundle_id" | grep -Eq '^[0-9]+-[0-9]+$' || fail SMOKE_BUNDLE_PATH_INVALID
test -d "$bundle_path" && test ! -L "$bundle_path" || fail SMOKE_BUNDLE_UNSAFE
helper_path="$bundle_path/staging-realtime-smoke-session.mjs"
test -f "$helper_path" && test ! -L "$helper_path" || fail SMOKE_HELPER_UNSAFE
test "$(stat -c '%h:%u:%g:%a' "$bundle_path")" = "2:$(id -u):$(id -g):700" ||
  fail SMOKE_BUNDLE_METADATA_UNSAFE
test "$(stat -c '%h:%u:%g:%a' "$helper_path")" = "1:$(id -u):$(id -g):400" ||
  fail SMOKE_HELPER_METADATA_UNSAFE

state_directory=/etc/phub/staging-realtime-smoke
state_path=$state_directory/session.json
lock_path=$state_directory/session.lock
deploy_uid=$(id -u)
deploy_gid=$(id -g)
test -d "$state_directory" && test ! -L "$state_directory" || fail SMOKE_STATE_DIRECTORY_UNSAFE
test -f "$state_path" && test ! -L "$state_path" || fail SMOKE_STATE_FILE_UNSAFE
test "$(stat -c '%h:%u:%g:%a' "$state_directory")" = "2:$deploy_uid:$deploy_gid:700" ||
  fail SMOKE_STATE_DIRECTORY_UNSAFE
test "$(stat -c '%F:%h:%u:%g:%a' "$state_path")" = "regular file:1:$deploy_uid:$deploy_gid:600" ||
  fail SMOKE_STATE_FILE_UNSAFE

umask 077
if test -e "$lock_path" || test -L "$lock_path"; then
  test "$(stat -c '%F:%h:%u:%g:%a' "$lock_path")" = "regular empty file:1:$deploy_uid:$deploy_gid:600" ||
    fail SMOKE_LOCK_FILE_UNSAFE
else
  : > "$lock_path"
fi
if find "$state_directory" -mindepth 1 -maxdepth 1 \
  ! -name session.json ! -name session.lock ! -name 'session.json.next-*' -print -quit | grep -q .; then
  fail SMOKE_STATE_DIRECTORY_CONTENT_INVALID
fi
exec 9>"$lock_path"
flock -n 9 || fail SMOKE_LOCK_BUSY

cd /opt/phub
container_id=$(docker compose --env-file infrastructure.env --env-file release.env ps -q api)
test -n "$container_id" || fail SMOKE_API_CONTAINER_MISSING
test "$(docker inspect --format '{{.State.Running}}' "$container_id")" = true ||
  fail SMOKE_API_CONTAINER_NOT_RUNNING
image_id=$(docker inspect --format '{{.Image}}' "$container_id")
printf '%s' "$image_id" | grep -Eq '^sha256:[0-9a-f]{64}$' || fail SMOKE_API_IMAGE_INVALID

docker run --rm --pull=never --network bridge --add-host lk.nano.padlhub.su:host-gateway --read-only \
  --user "$deploy_uid:$deploy_gid" \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=1m \
  --cap-drop ALL --security-opt no-new-privileges \
  --memory 128m --pids-limit 64 \
  --env HTTP_PROXY= --env HTTPS_PROXY= --env ALL_PROXY= --env NO_PROXY=lk.nano.padlhub.su \
  --mount type=bind,src="$state_directory",dst=/state \
  --mount type=bind,src="$helper_path",dst=/app/staging-realtime-smoke-session.mjs,readonly \
  --entrypoint node "$image_id" /app/staging-realtime-smoke-session.mjs /state/session.json
