#!/bin/sh

set -eu

fail() {
  printf '%s\n' "Media binary API verification failed: $*" >&2
  exit 1
}

if test "$#" -ne 2; then
  fail 'usage: verify-media-binary-api.sh <expected-web-release> <expected-candidate-release>'
fi

expected_web_release="$1"
expected_candidate_release="$2"
for release in "$expected_web_release" "$expected_candidate_release"; do
  case "$release" in
    *[!0-9a-f]*|'') fail 'expected release identifier is malformed' ;;
  esac
  test "${#release}" -eq 40 || fail 'expected release identifier is malformed'
done

app_root="${PHUB_APP_ROOT:-/opt/phub}"
cd "$app_root"

compose() {
  docker compose --env-file infrastructure.env --env-file release.env "$@"
}

infrastructure() {
  docker compose --env-file infrastructure.env -f compose.infrastructure.yaml "$@"
}

sql() {
  infrastructure exec -T postgres sh -ec '
    exec env PGOPTIONS="-c default_transaction_read_only=on -c statement_timeout=15000 -c lock_timeout=2000 -c idle_in_transaction_session_timeout=15000" \
      psql -X -qAt -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -c "$1"
  ' sh "$1"
}

api_container="$(compose ps --status running -q api)"
test -n "$api_container" || fail 'candidate API is not running'
test "$(docker inspect --format '{{.State.Health.Status}}' "$api_container")" = healthy ||
  fail 'candidate API is not healthy'
active_release="$(sed -n 's/^RELEASE=//p' release.env)"
registry="$(sed -n 's/^REGISTRY=//p' release.env)"
api_digest="$(sed -n 's/^API_IMAGE_DIGEST=//p' release.env)"
test "$active_release" = "$expected_candidate_release" || fail 'candidate release metadata differs'
test "$registry" = ghcr.io/z6v6e6r || fail 'candidate registry is not approved'
case "$api_digest" in sha256:*) ;; *) fail 'candidate API digest is malformed' ;; esac
api_digest_hex="${api_digest#sha256:}"
case "$api_digest_hex" in *[!0-9a-f]*|'') fail 'candidate API digest is malformed' ;; esac
test "${#api_digest_hex}" -eq 64 || fail 'candidate API digest is malformed'
api_image_ref="$(docker inspect --format '{{.Config.Image}}' "$api_container")"
test "$api_image_ref" = "$registry/phub-api@$api_digest" ||
  fail 'running API is not the exact candidate digest'

profile_target="$(sql "begin transaction read only;
  select tenant_id::text || '|' || delivery_id::text
  from integration.user_profile_photo_sync
  where object_key is not null
  order by synced_at desc limit 1;
  commit;")"
profile_target="$(printf '%s\n' "$profile_target" | awk -F '|' 'NF == 2 { print; exit }')"
test -n "$profile_target" || fail 'no existing profile-photo mapping is available for API smoke'
profile_tenant="${profile_target%%|*}"
profile_delivery="${profile_target#*|}"

community_target="$(sql "begin transaction read only;
  select tenant_id::text || '|' || community_id::text
  from integration.community_logo_sync
  where object_key is not null
  order by synced_at desc limit 1;
  commit;")"
community_target="$(printf '%s\n' "$community_target" | awk -F '|' 'NF == 2 { print; exit }')"
test -n "$community_target" || fail 'no existing community-logo mapping is available for API smoke'
community_tenant="${community_target%%|*}"
community_id="${community_target#*|}"

probe_direct_webp() {
  path="$1"
  result="$(curl --silent --show-error --output /dev/null \
    --connect-timeout 2 --max-time 10 \
    --write-out '%{http_code}|%{content_type}' "http://127.0.0.1:3000$path")"
  test "$result" = '200|image/webp' || fail "candidate direct media read returned an unexpected status/type ($result)"
}

probe_canonical_webp() {
  path="$1"
  attempt=0
  result='unavailable'
  while test "$attempt" -lt 15; do
    result="$(curl --silent --show-error --output /dev/null \
      --connect-timeout 2 --max-time 10 \
      --resolve lk.nano.padlhub.su:443:127.0.0.1 \
      --write-out '%{http_code}|%{content_type}' "https://lk.nano.padlhub.su$path" 2>/dev/null || true)"
    test "$result" = '200|image/webp' && return 0
    attempt=$((attempt + 1))
    sleep 2
  done
  fail "canonical HTTPS media read returned an unexpected status/type ($result)"
}

profile_path="/public/api/v1/media/profile-photos/$profile_tenant/$profile_delivery"
community_path="/public/api/v1/media/community-logos/$community_tenant/$community_id"
probe_direct_webp "$profile_path"
probe_direct_webp "$community_path"
probe_canonical_webp "$profile_path"
probe_canonical_webp "$community_path"

manifest=''
attempt=0
while test "$attempt" -lt 15; do
  manifest="$(curl --fail --silent --show-error --connect-timeout 2 --max-time 10 \
    --resolve lk.nano.padlhub.su:443:127.0.0.1 \
    https://lk.nano.padlhub.su/manifest.json 2>/dev/null || true)"
  if printf '%s' "$manifest" | compose exec -T api node -e '
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => {
      try {
        if (JSON.parse(input).release !== process.argv[1]) process.exit(1);
      } catch { process.exit(1); }
    });
  ' "$expected_web_release"; then
    break
  fi
  manifest=''
  attempt=$((attempt + 1))
  sleep 2
done
test -n "$manifest" || fail 'public web release does not match the expected compatibility boundary'

printf 'media_binary_api candidate_release=%s web_release=%s direct_media=passed canonical_https_media=passed manifest=matched profile_photo=webp community_logo=webp status=passed\n' \
  "$expected_candidate_release" "$expected_web_release"
