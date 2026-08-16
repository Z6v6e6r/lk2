#!/bin/sh

set -eu

fail() {
  printf '%s\n' "Legacy runtime-secret bootstrap observation refused: $*" >&2
  exit 1
}

test "$#" -eq 1 || fail 'usage: verify-legacy-runtime-secret-bootstrap-runtime.sh <candidate-release>'
candidate_release=$1
printf '%s' "$candidate_release" | grep -Eq '^[0-9a-f]{40}$' || fail 'candidate release is malformed'

app_root=${PHUB_APP_ROOT:-/opt/phub}
release_file="$app_root/release.env"
receipt=/etc/phub/.runtime-secret-bootstrap.finalized.json
test -f "$release_file" && test ! -L "$release_file" || fail 'release.env is absent or unsafe'
test -f "$receipt" && test ! -L "$receipt" || fail 'finalized receipt is absent or unsafe'

env_value() {
  key=$1
  count=$(awk -F= -v key="$key" '$1 == key { count += 1 } END { print count + 0 }' "$release_file")
  test "$count" -eq 1 || fail "release.env must contain exactly one $key"
  sed -n "s/^${key}=//p" "$release_file"
}

test "$(env_value RELEASE)" = "$candidate_release" || fail 'serving release differs from candidate'
registry=$(env_value REGISTRY)
printf '%s' "$registry" | grep -Eq '^ghcr\.io/[A-Za-z0-9._/-]+$' || fail 'release registry is malformed'

for service in web api worker realtime; do
  upper=$(printf '%s' "$service" | tr '[:lower:]' '[:upper:]')
  digest=$(env_value "${upper}_IMAGE_DIGEST")
  printf '%s' "$digest" | grep -Eq '^sha256:[0-9a-f]{64}$' || fail "$service digest is malformed"
  expected_ref="$registry/phub-$service@$digest"
  ids=$(docker ps --filter label=com.docker.compose.project=phub-staging \
    --filter "label=com.docker.compose.service=$service" --format '{{.ID}}')
  test "$(printf '%s\n' "$ids" | awk 'NF { count += 1 } END { print count + 0 }')" -eq 1 ||
    fail "$service must have exactly one running container"
  test "$(docker inspect --format '{{.State.Health.Status}}' "$ids")" = healthy || fail "$service is unhealthy"
  test "$(docker inspect --format '{{.Config.Image}}' "$ids")" = "$expected_ref" || fail "$service image reference differs"
  test "$(docker inspect --format '{{.RestartCount}}' "$ids")" = 0 || fail "$service restarted during observation"
  log_output=$(docker logs --since 90s "$ids" 2>&1) || fail "$service logs are unavailable"
  critical_count=$(printf '%s\n' "$log_output" | awk '
    BEGIN { count = 0 }
    { line = tolower($0); if (line ~ /uncaught|unhandledrejection|fatal|panic/) count += 1 }
    END { print count }
  ')
  unset log_output
  test "$critical_count" -eq 0 || fail "$service emitted a critical runtime signal"
done

printf '%s\n' "legacy_runtime_secret_bootstrap observation release=$candidate_release health=ready restarts=0 critical_logs=0 status=passed"
