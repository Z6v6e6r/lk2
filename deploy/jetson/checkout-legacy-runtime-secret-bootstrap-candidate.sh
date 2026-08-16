#!/bin/sh

set -eu

repository_url=https://github.com/Z6v6e6r/lk2.git

fail() {
  printf '%s\n' "Legacy bootstrap candidate checkout refused: $*" >&2
  exit 1
}

test "$#" -eq 2 ||
  fail 'usage: checkout-legacy-runtime-secret-bootstrap-candidate.sh <candidate-sha> <destination>'
candidate_sha=$1
destination=$2

test "${#candidate_sha}" -eq 40 || fail 'candidate SHA is malformed'
case "$candidate_sha" in *[!0-9a-f]*) fail 'candidate SHA is malformed' ;; esac
test "$destination" = candidate || fail 'candidate checkout destination differs'
test ! -e "$destination" && test ! -L "$destination" || fail 'candidate checkout destination already exists'

umask 077
mkdir "$destination"
git -C "$destination" init --quiet
git -C "$destination" remote add origin "$repository_url"
git -C "$destination" -c protocol.version=2 fetch \
  --quiet \
  --no-tags \
  --no-recurse-submodules \
  --depth=2 \
  origin \
  "$candidate_sha"
test "$(git -C "$destination" rev-parse FETCH_HEAD)" = "$candidate_sha" ||
  fail 'fetched candidate differs from requested SHA'
git -C "$destination" -c submodule.recurse=false checkout --quiet --detach "$candidate_sha"
test "$(git -C "$destination" rev-parse HEAD)" = "$candidate_sha" ||
  fail 'checked out candidate differs from requested SHA'
git -C "$destination" rev-parse --verify HEAD^ >/dev/null || fail 'candidate parent was not fetched'

git -C "$destination" remote remove origin
test -z "$(git -C "$destination" remote)" || fail 'candidate checkout retained a remote'

printf '%s\n' "legacy_bootstrap_candidate_checkout candidate=$candidate_sha status=passed"
