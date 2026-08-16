#!/bin/sh

set -eu

repository_url=https://github.com/Z6v6e6r/lk2.git

fail() {
  printf '%s\n' "Legacy bootstrap candidate checkout refused: $*" >&2
  exit 1
}

test "$#" -eq 2 || fail 'usage: checkout-legacy-runtime-secret-bootstrap-candidate.sh <candidate-sha> <destination>'
candidate_sha=$1
destination=$2

printf '%s' "$candidate_sha" | grep -Eq '^[0-9a-f]{40}$' || fail 'candidate SHA is malformed'
test "$destination" = candidate || fail 'candidate checkout destination differs'
test ! -e "$destination" && test ! -L "$destination" || fail 'candidate checkout destination already exists'

git init "$destination" >/dev/null
git -C "$destination" remote add origin "$repository_url"
git -C "$destination" -c protocol.version=2 fetch --no-tags --depth=2 origin "$candidate_sha"
test "$(git -C "$destination" rev-parse FETCH_HEAD)" = "$candidate_sha" ||
  fail 'fetched candidate differs from requested SHA'
git -C "$destination" checkout --detach "$candidate_sha"
test "$(git -C "$destination" rev-parse HEAD)" = "$candidate_sha" ||
  fail 'checked out candidate differs from requested SHA'

printf '%s\n' "legacy_bootstrap_candidate_checkout candidate=$candidate_sha status=passed"
