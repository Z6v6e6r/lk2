#!/bin/sh

set -eu

supported_active_release=e308181da5222645d9a87d03642923c6841be8d1
supported_patch_sha256=7fe04830af2ba1cc83a9bd2b6440712ed1251f8ecb1066ddde48ad7704b79597

fail() {
  printf '%s\n' "Legacy OTP hotfix source verification refused: $*" >&2
  exit 1
}

test "$#" -eq 3 ||
  fail 'usage: verify-legacy-otp-hotfix-source.sh <expected-active-sha> <candidate-sha> <candidate-checkout>'
expected_active=$1
candidate=$2
candidate_checkout=$3

for value in "$expected_active" "$candidate"; do
  test "${#value}" -eq 40 || fail 'release inputs must be 40-character SHAs'
  case "$value" in *[!0-9a-f]*) fail 'release inputs must be lowercase hexadecimal SHAs' ;; esac
done
test "$expected_active" = "$supported_active_release" || fail 'active release is not the reviewed legacy base'
test -d "$candidate_checkout" && git -C "$candidate_checkout" rev-parse --git-dir >/dev/null 2>&1 ||
  fail 'candidate checkout is absent'
test "$(git -C "$candidate_checkout" rev-parse HEAD)" = "$candidate" || fail 'candidate checkout HEAD differs'
git -C "$candidate_checkout" cat-file -e "$expected_active^{commit}" || fail 'active commit is unavailable'

parent_line=$(git -C "$candidate_checkout" rev-list --parents -n 1 "$candidate")
test "$(printf '%s\n' "$parent_line" | awk '{ print NF }')" -eq 2 || fail 'candidate must be a non-merge single-parent commit'
test "$(printf '%s\n' "$parent_line" | awk '{ print $2 }')" = "$expected_active" || fail 'candidate parent is not the exact active release'

actual_patch_sha256=$(git -C "$candidate_checkout" diff --binary "$expected_active..$candidate" | sha256sum | awk '{ print $1 }')
test "$actual_patch_sha256" = "$supported_patch_sha256" || fail 'candidate patch differs from the reviewed immutable OTP hotfix'

expected_paths='apps/api/Dockerfile
apps/migrator/Dockerfile
apps/realtime/Dockerfile
apps/worker/Dockerfile
packages/viva-adapter/src/identity.test.ts
packages/viva-adapter/src/identity.ts
scripts/verify-production-workspace-imports.js
scripts/verify-production-workspace-imports.test.ts'
actual_paths=$(git -C "$candidate_checkout" diff --name-only "$expected_active..$candidate" | LC_ALL=C sort)
test "$actual_paths" = "$expected_paths" || fail 'candidate changed-path set differs from the eight-file allowlist'

for protected in packages/database/migrations contracts package.json package-lock.json deploy/compose.staging.yaml; do
  test -z "$(git -C "$candidate_checkout" diff --name-only "$expected_active..$candidate" -- "$protected")" ||
    fail "candidate changes protected path $protected"
done

active_migrations=$(git -C "$candidate_checkout" ls-tree -r "$expected_active" -- packages/database/migrations)
candidate_migrations=$(git -C "$candidate_checkout" ls-tree -r "$candidate" -- packages/database/migrations)
test "$active_migrations" = "$candidate_migrations" || fail 'candidate migration tree differs'
active_contracts=$(git -C "$candidate_checkout" ls-tree -r "$expected_active" -- contracts)
candidate_contracts=$(git -C "$candidate_checkout" ls-tree -r "$candidate" -- contracts)
test "$active_contracts" = "$candidate_contracts" || fail 'candidate contract tree differs'
active_compose=$(git -C "$candidate_checkout" rev-parse "$expected_active:deploy/compose.staging.yaml")
candidate_compose=$(git -C "$candidate_checkout" rev-parse "$candidate:deploy/compose.staging.yaml")
test "$active_compose" = "$candidate_compose" || fail 'candidate staging Compose differs'

identity_source=$(git -C "$candidate_checkout" show "$candidate:packages/viva-adapter/src/identity.ts")
printf '%s' "$identity_source" | grep -Fq "phoneE164.startsWith('+') ? phoneE164.slice(1) : phoneE164" ||
  fail 'candidate lacks the reviewed Viva phone serializer'
printf '%s' "$identity_source" | grep -Fq "url.searchParams.set('phoneNumber', toVivaPhoneNumber(input.phoneE164))" ||
  fail 'candidate SMS request does not use the reviewed serializer'
printf '%s' "$identity_source" | grep -Fq 'phone_number: toVivaPhoneNumber(input.phoneE164)' ||
  fail 'candidate token request does not use the reviewed serializer'

for service in api worker realtime migrator; do
  dockerfile=$(git -C "$candidate_checkout" show "$candidate:apps/$service/Dockerfile")
  printf '%s' "$dockerfile" | grep -Fq 'npm ci --omit=dev --include=optional --workspaces --no-audit --no-fund' ||
    fail "$service image lacks the reviewed clean production install"
  printf '%s' "$dockerfile" | grep -Fq 'find apps packages -name node_modules -prune -exec rm -rf -- {} +' ||
    fail "$service image does not remove copied nested workspace installs"
  printf '%s' "$dockerfile" | grep -Fq "node scripts/verify-production-workspace-imports.js $service" ||
    fail "$service image lacks the reviewed production import probe"
  printf '%s' "$dockerfile" | grep -Fq 'chmod -R a+rX apps packages' ||
    fail "$service image does not normalize workspace read permissions"
  printf '%s' "$dockerfile" | grep -Fq 'scripts node_modules' ||
    fail "$service image does not normalize probe and dependency read permissions"
  printf '%s' "$dockerfile" | grep -Fq 'chmod a+r package.json package-lock.json .npmrc' ||
    fail "$service image does not normalize root manifest read permissions"
  user_line=$(printf '%s\n' "$dockerfile" | grep -nFx 'USER appuser' | cut -d: -f1)
  probe_line=$(printf '%s\n' "$dockerfile" | grep -nF "RUN node scripts/verify-production-workspace-imports.js $service" | cut -d: -f1)
  test -n "$user_line" && test -n "$probe_line" && test "$user_line" -lt "$probe_line" ||
    fail "$service image does not run the import probe as appuser"
  printf '%s\n' "$dockerfile" | grep -Eq 'chmod.*(a\+w|o\+w|777)' &&
    fail "$service image grants broad write permissions"
  printf '%s' "$dockerfile" | grep -Fq 'COPY --from=build /workspace/node_modules ./node_modules' &&
    fail "$service image copies builder node_modules"
  printf '%s' "$dockerfile" | grep -Fq 'npm prune' && fail "$service image prunes a copied dependency tree"
done

migrator_dockerfile=$(git -C "$candidate_checkout" show "$candidate:apps/migrator/Dockerfile")
printf '%s' "$migrator_dockerfile" | grep -Fq 'chmod -R a+rX apps packages migrations scripts node_modules' ||
  fail 'migrator image does not normalize migration read permissions'

probe_source=$(git -C "$candidate_checkout" show "$candidate:scripts/verify-production-workspace-imports.js")
printf '%s' "$probe_source" | grep -Fq "supportedApplications = new Set(['api', 'worker', 'realtime', 'migrator'])" ||
  fail 'candidate import probe does not bind the four Node applications'
printf '%s' "$probe_source" | grep -Fq 'await import(specifier)' ||
  fail 'candidate import probe does not load resolved production dependencies'
printf '%s' "$probe_source" | grep -Fq "join(applicationRoot, 'dist')" ||
  fail 'candidate import probe does not scan built application output'

printf '%s\n' "legacy_otp_hotfix_source active=$expected_active candidate=$candidate paths=8 migrations=unchanged contracts=unchanged compose=unchanged status=passed"
