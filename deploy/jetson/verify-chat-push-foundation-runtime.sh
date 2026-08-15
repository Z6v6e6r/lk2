#!/bin/sh

set -eu

mode="${1:?verification mode is required}"
app_root="${PHUB_APP_ROOT:-/opt/phub}"
foundation_env="$app_root/staging.chat-push-foundation.env"
compose_release_env="$app_root/release.env"

fail() {
  printf '%s\n' "Chat/push foundation runtime verification failed: $*" >&2
  exit 1
}

case "$mode" in
  preflight | drained | api-ready | worker-ready | realtime-ready | overlay) ;;
  candidate-active)
    candidate_release="${2:?candidate release env is required}"
    case "$candidate_release" in
      "$app_root"/backups/releases/*/foundation.candidate-release.env) ;;
      *) fail 'candidate release env path is not bounded' ;;
    esac
    case "$candidate_release" in
      *'/../'* | *'//'*) fail 'candidate release env path is not bounded' ;;
    esac
    test -f "$candidate_release" && test ! -L "$candidate_release" ||
      fail 'candidate release env is absent or unsafe'
    test "$(stat -c %a "$candidate_release")" = 600 ||
      fail 'candidate release env mode must be 0600'
    recovery_manifest="${candidate_release%/foundation.candidate-release.env}/chat-push-foundation.recovery"
    test -f "$recovery_manifest" && test ! -L "$recovery_manifest" ||
      fail 'candidate recovery manifest is absent or unsafe'
    test "$(stat -c %a "$recovery_manifest")" = 600 ||
      fail 'candidate recovery manifest mode must be 0600'
    test "$(awk -F= '$1 == "CANDIDATE_RELEASE_SHA256" { count += 1 } END { print count + 0 }' "$recovery_manifest")" -eq 1 ||
      fail 'candidate recovery manifest digest is ambiguous'
    expected_candidate_digest="$(sed -n 's/^CANDIDATE_RELEASE_SHA256=//p' "$recovery_manifest")"
    printf '%s' "$expected_candidate_digest" | grep -Eq '^[0-9a-f]{64}$' ||
      fail 'candidate recovery manifest digest is invalid'
    test "$(sha256sum "$candidate_release" | cut -d ' ' -f 1)" = "$expected_candidate_digest" ||
      fail 'candidate release digest does not match recovery state'
    compose_release_env="$candidate_release"
    ;;
  *) fail 'unknown verification mode' ;;
esac

cd "$app_root"

test "${RUNTIME_CHAT_PUSH_FOUNDATION_ENV_FILE+x}" != x ||
  fail 'foundation overlay path override is forbidden'
for interpolation_file in infrastructure.env "$compose_release_env"; do
  awk -F= '
    /^[[:space:]]*($|#)/ { next }
    $1 == "RUNTIME_CHAT_PUSH_FOUNDATION_ENV_FILE" { found = 1 }
    END { exit found ? 1 : 0 }
  ' "$interpolation_file" || fail "$interpolation_file redirects the foundation overlay"
done

compose() {
  docker compose --env-file infrastructure.env --env-file "$compose_release_env" "$@"
}

running_ids() {
  compose ps --status running -q "$1"
}

require_running() {
  service="$1"
  ids="$(running_ids "$service")"
  test -n "$ids" || fail "$service is not running"
  for container_id in $ids; do
    case "$container_id" in
      *[!0-9a-f]*) fail "$service returned an invalid container identifier" ;;
    esac
  done
}

require_stopped() {
  service="$1"
  test -z "$(running_ids "$service")" || fail "$service is still running"
}

verify_flags() {
  service="$1"
  ids="$(running_ids "$service")"
  test -n "$ids" || fail "$service is not running"
  for container_id in $ids; do
    docker exec "$container_id" node --input-type=module -e '
      const service = process.argv[1];
      const required = service === "api"
        ? ["WEB_PUSH_ENABLED", "MESSAGING_USER_BLOCK_COMMANDS_ENABLED"]
        : ["WEB_PUSH_ENABLED", "BOOKING_REMINDER_SCHEDULER_ENABLED"];
      if (process.env.APP_ENV !== "staging") process.exit(1);
      const { loadConfig } = await import("@phub/config");
      const config = service === "worker"
        ? loadConfig(process.env, { profilePhotoStorage: true })
        : loadConfig(process.env);
      for (const key of required) {
        const value = process.env[key];
        if (value !== undefined && value !== "false") process.exit(1);
        if (config[key] !== undefined && config[key] !== false) process.exit(1);
      }
    ' "$service" >/dev/null || fail "$service has an enabled or invalid foundation gate"
  done
}

verify_overlay() {
  test -f "$foundation_env" || fail 'foundation overlay is absent'
  test ! -L "$foundation_env" || fail 'foundation overlay must not be a symlink'
  test "$(stat -c %a "$foundation_env")" = 600 || fail 'foundation overlay mode must be 0600'
  test "$(wc -l < "$foundation_env" | tr -d ' ')" -eq 3 ||
    fail 'foundation overlay must contain exactly three lines'
  grep -Fxq 'WEB_PUSH_ENABLED=false' "$foundation_env" || fail 'Web Push kill switch is absent'
  grep -Fxq 'MESSAGING_USER_BLOCK_COMMANDS_ENABLED=false' "$foundation_env" ||
    fail 'block-command kill switch is absent'
  grep -Fxq 'BOOKING_REMINDER_SCHEDULER_ENABLED=false' "$foundation_env" ||
    fail 'booking-reminder kill switch is absent'
  awk -F= '
    $1 == "WEB_PUSH_ENABLED" { web_push += 1; next }
    $1 == "MESSAGING_USER_BLOCK_COMMANDS_ENABLED" { blocks += 1; next }
    $1 == "BOOKING_REMINDER_SCHEDULER_ENABLED" { reminders += 1; next }
    { exit 1 }
    END { exit !(web_push == 1 && blocks == 1 && reminders == 1) }
  ' "$foundation_env" || fail 'foundation overlay contains duplicate or unknown settings'
}

release_value() {
  release_file="$1"
  release_key="$2"
  test "$(awk -F= -v key="$release_key" '$1 == key { count += 1 } END { print count + 0 }' "$release_file")" -eq 1 ||
    fail "candidate release env must contain exactly one $release_key"
  sed -n "s/^${release_key}=//p" "$release_file"
}

verify_candidate_image() {
  service="$1"
  digest_key="$2"
  registry="$(release_value "$candidate_release" REGISTRY)"
  digest="$(release_value "$candidate_release" "$digest_key")"
  test "$registry" = ghcr.io/z6v6e6r || fail 'candidate registry is invalid'
  printf '%s' "$digest" | grep -Eq '^sha256:[0-9a-f]{64}$' ||
    fail "$service candidate digest is invalid"
  container_id="$(running_ids "$service")"
  test -n "$container_id" || fail "$service is not running"
  case "$container_id" in
    *[!0-9a-f]*) fail "$service returned an invalid container identifier" ;;
  esac
  test "$(docker inspect --format '{{.State.Health.Status}}' "$container_id")" = healthy ||
    fail "$service is not healthy"
  test "$(docker inspect --format '{{.Config.Image}}' "$container_id")" = \
    "$registry/phub-$service@$digest" || fail "$service image is not the candidate digest"
}

case "$mode" in
  preflight)
    require_running api
    require_running worker
    require_running realtime
    verify_flags api
    verify_flags worker
    ;;
  drained)
    require_stopped api
    require_stopped worker
    require_stopped realtime
    ;;
  api-ready)
    require_running api
    require_stopped worker
    require_stopped realtime
    verify_flags api
    verify_overlay
    ;;
  worker-ready)
    require_running api
    require_running worker
    require_stopped realtime
    verify_flags api
    verify_flags worker
    verify_overlay
    ;;
  realtime-ready)
    require_running api
    require_running worker
    require_running realtime
    verify_flags api
    verify_flags worker
    verify_overlay
    ;;
  overlay)
    verify_overlay
    ;;
  candidate-active)
    test -f "$app_root/release.env" && test ! -L "$app_root/release.env" ||
      fail 'active release env is absent or unsafe'
    cmp "$app_root/release.env" "$candidate_release" >/dev/null ||
      fail 'active release is not the candidate release'
    verify_candidate_image api API_IMAGE_DIGEST
    verify_candidate_image worker WORKER_IMAGE_DIGEST
    verify_candidate_image realtime REALTIME_IMAGE_DIGEST
    verify_candidate_image web WEB_IMAGE_DIGEST
    verify_flags api
    verify_flags worker
    verify_overlay
    ;;
esac

printf '%s\n' "Chat/push foundation runtime verified: mode=$mode"
