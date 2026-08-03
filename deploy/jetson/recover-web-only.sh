#!/bin/sh
set -eu

: "${WEB_DIGEST:?WEB_DIGEST is required}"
: "${EXPECTED_RELEASE:?EXPECTED_RELEASE is required}"

case "$WEB_DIGEST" in
  sha256:[0-9a-f][0-9a-f]*) ;;
  *) echo "Invalid WEB_DIGEST" >&2; exit 1 ;;
esac
test "${#WEB_DIGEST}" -eq 71

trap 'docker logout ghcr.io >/dev/null 2>&1 || true' EXIT
docker login ghcr.io --username github-actions --password-stdin

cd /opt/phub
cp release.env "release.env.web-pre-$(date -u +%Y%m%dT%H%M%SZ)"
release_tmp="release.env.$$"
trap 'rm -f "$release_tmp"; docker logout ghcr.io >/dev/null 2>&1 || true' EXIT
awk -v digest="$WEB_DIGEST" '
  /^WEB_IMAGE_DIGEST=/ { print "WEB_IMAGE_DIGEST=" digest; replaced=1; next }
  { print }
  END { if (!replaced) print "WEB_IMAGE_DIGEST=" digest }
' release.env > "$release_tmp"
mv "$release_tmp" release.env

compose() {
  docker compose --env-file infrastructure.env --env-file release.env "$@"
}

compose pull web
compose up -d --no-deps web

attempt=0
while [ "$attempt" -lt 18 ]; do
  container_id="$(compose ps -q web)"
  if [ -n "$container_id" ] && \
    [ "$(docker inspect --format '{{.State.Health.Status}}' "$container_id")" = healthy ]; then
    break
  fi
  attempt=$((attempt + 1))
  sleep 5
done
test "$attempt" -lt 18

manifest="$(curl --fail --silent --show-error --max-time 15 \
  --resolve lk.nano.padlhub.su:443:127.0.0.1 \
  https://lk.nano.padlhub.su/manifest.json)"
printf '%s\n' "$manifest"
printf '%s' "$manifest" | grep -F "\"release\": \"$EXPECTED_RELEASE\""
