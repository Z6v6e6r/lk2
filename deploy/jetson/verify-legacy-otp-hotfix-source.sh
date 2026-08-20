#!/bin/sh

set -eu

supported_active_release=e308181da5222645d9a87d03642923c6841be8d1
supported_patch_sha256=1ce854648f92b6dddf2d9105ad75197b4c6890da78a949245591767d4945b594

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

expected_paths='packages/viva-adapter/src/identity.test.ts
packages/viva-adapter/src/identity.ts'
actual_paths=$(git -C "$candidate_checkout" diff --name-only "$expected_active..$candidate" | LC_ALL=C sort)
test "$actual_paths" = "$expected_paths" || fail 'candidate changed-path set differs from the two-file allowlist'

for protected in packages/database/migrations contracts package.json package-lock.json deploy/compose.staging.yaml; do
  test -z "$(git -C "$candidate_checkout" diff --name-only "$expected_active..$candidate" -- "$protected")" ||
    fail "candidate changes protected path $protected"
done
test -z "$(git -C "$candidate_checkout" diff --name-only "$expected_active..$candidate" -- 'apps/*/Dockerfile')" ||
  fail 'candidate changes a Dockerfile'

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

printf '%s\n' "legacy_otp_hotfix_source active=$expected_active candidate=$candidate paths=2 migrations=unchanged contracts=unchanged compose=unchanged status=passed"
