#!/bin/sh

set -eu

supported_active_release=e308181da5222645d9a87d03642923c6841be8d1
supported_patch_sha256=4634e8f42b256d0a7faf29beab0370529c0e6430a1b3b21ab2ce9a3ffa6e26de

fail() {
  printf '%s\n' "Legacy bootstrap source verification refused: $*" >&2
  exit 1
}

test "$#" -eq 3 || fail 'usage: verify-legacy-runtime-secret-bootstrap-source.sh <expected-active-sha> <candidate-sha> <candidate-checkout>'
expected_active=$1
candidate=$2
candidate_checkout=$3
for value in "$expected_active" "$candidate"; do
  printf '%s' "$value" | grep -Eq '^[0-9a-f]{40}$' || fail 'release inputs must be 40-character SHAs'
done
test "$expected_active" = "$supported_active_release" || fail 'active release is not the reviewed B0 source base'
test -d "$candidate_checkout" && git -C "$candidate_checkout" rev-parse --git-dir >/dev/null 2>&1 || fail 'candidate checkout is absent'
test "$(git -C "$candidate_checkout" rev-parse HEAD)" = "$candidate" || fail 'candidate checkout HEAD differs'
git -C "$candidate_checkout" cat-file -e "$expected_active^{commit}" || fail 'expected active commit is unavailable'

parent_line=$(git -C "$candidate_checkout" rev-list --parents -n 1 "$candidate")
test "$(printf '%s\n' "$parent_line" | awk '{ print NF }')" -eq 2 || fail 'candidate must be a non-merge single-parent commit'
test "$(printf '%s\n' "$parent_line" | awk '{ print $2 }')" = "$expected_active" || fail 'candidate parent is not the exact active release'
actual_patch_sha256=$(git -C "$candidate_checkout" diff --binary "$expected_active..$candidate" | sha256sum | awk '{ print $1 }')
test "$actual_patch_sha256" = "$supported_patch_sha256" || fail 'candidate patch differs from the reviewed immutable B0 source'

expected_paths='apps/api/src/main.ts
apps/api/src/messaging/realtime-ticket-issuer.test.ts
apps/api/src/messaging/realtime-ticket-issuer.ts
apps/realtime/src/app.test.ts
apps/realtime/src/app.ts
apps/realtime/src/main.ts
deploy/compose.staging.yaml
packages/config/src/index.test.ts
packages/config/src/index.ts'
actual_paths=$(git -C "$candidate_checkout" diff --name-only "$expected_active..$candidate" | LC_ALL=C sort)
test "$actual_paths" = "$expected_paths" || fail 'candidate changed-path set differs from the reviewed nine-file B0 allowlist'

for protected in packages/database/migrations contracts package.json package-lock.json; do
  test -z "$(git -C "$candidate_checkout" diff --name-only "$expected_active..$candidate" -- "$protected")" ||
    fail "candidate changes protected path $protected"
done
test -z "$(git -C "$candidate_checkout" diff --name-only "$expected_active..$candidate" -- 'apps/*/Dockerfile')" || fail 'candidate changes a Dockerfile'

candidate_config=$(git -C "$candidate_checkout" show "$candidate:packages/config/src/index.ts")
printf '%s' "$candidate_config" | grep -Fq 'export function loadRealtimeConfig' || fail 'candidate lacks realtime-only loader'
printf '%s' "$candidate_config" | grep -Fq 'export function loadApiConfig' || fail 'candidate lacks API fail-closed loader'
candidate_api_main=$(git -C "$candidate_checkout" show "$candidate:apps/api/src/main.ts")
printf '%s' "$candidate_api_main" | grep -Fq 'loadApiConfig()' || fail 'candidate API does not use its fail-closed loader'
candidate_issuer=$(git -C "$candidate_checkout" show "$candidate:apps/api/src/messaging/realtime-ticket-issuer.ts")
printf '%s' "$candidate_issuer" | grep -Fq 'JWT_REALTIME_SECRET' || fail 'candidate API does not sign with the dedicated key'
candidate_realtime=$(git -C "$candidate_checkout" show "$candidate:apps/realtime/src/main.ts")
printf '%s' "$candidate_realtime" | grep -Fq 'loadRealtimeConfig()' || fail 'candidate realtime does not use the isolated loader'
candidate_compose=$(git -C "$candidate_checkout" show "$candidate:deploy/compose.staging.yaml")
printf '%s' "$candidate_compose" | grep -Fq 'REALTIME_RUNTIME_ENV_FILE:-/etc/phub/realtime.env' || fail 'candidate Compose lacks the isolated realtime contour'
service_has_empty_env() {
  printf '%s\n' "$candidate_compose" | awk -v service="$1" '
    $0 == "  " service ":" { inside = 1; next }
    inside && /^  [a-zA-Z0-9_-]+:$/ { exit }
    inside && $0 == "    env_file: []" { found = 1 }
    END { exit(found ? 0 : 1) }
  '
}
service_has_empty_env web || fail 'candidate web service receives runtime secrets'
service_has_empty_env migrator || fail 'candidate migrator service receives runtime secrets'

active_migrations=$(git -C "$candidate_checkout" ls-tree -r "$expected_active" -- packages/database/migrations)
candidate_migrations=$(git -C "$candidate_checkout" ls-tree -r "$candidate" -- packages/database/migrations)
test "$active_migrations" = "$candidate_migrations" || fail 'candidate migration tree differs from the active release'
active_contracts=$(git -C "$candidate_checkout" ls-tree -r "$expected_active" -- contracts)
candidate_contracts=$(git -C "$candidate_checkout" ls-tree -r "$candidate" -- contracts)
test "$active_contracts" = "$candidate_contracts" || fail 'candidate contract tree differs from the active release'

printf '%s\n' "legacy_bootstrap_source active=$expected_active candidate=$candidate paths=9 migrations=unchanged contracts=unchanged status=passed"
