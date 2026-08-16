#!/bin/sh
set -eu

fail() {
  printf 'b0 candidate fetch: %s\n' "$1" >&2
  exit 1
}

candidate_sha=${1:-}
target_dir=${2:-}
repository_url=https://github.com/Z6v6e6r/lk2.git

printf '%s' "$candidate_sha" | grep -Eq '^[0-9a-f]{40}$' || fail 'candidate SHA is malformed'
test -n "$target_dir" || fail 'target directory is required'
test "$target_dir" = candidate || fail 'target directory must be candidate'
test ! -e "$target_dir" || fail 'target directory already exists'

umask 077
mkdir "$target_dir"
git -C "$target_dir" init --quiet
git -C "$target_dir" remote add origin "$repository_url"
git -C "$target_dir" -c protocol.version=2 fetch \
  --quiet \
  --no-tags \
  --no-recurse-submodules \
  --depth=2 \
  origin \
  "$candidate_sha"

test "$(git -C "$target_dir" rev-parse FETCH_HEAD)" = "$candidate_sha" ||
  fail 'fetched candidate differs from the requested SHA'
git -C "$target_dir" -c submodule.recurse=false checkout --quiet --detach "$candidate_sha"
test "$(git -C "$target_dir" rev-parse HEAD)" = "$candidate_sha" ||
  fail 'checked out candidate differs from the requested SHA'
git -C "$target_dir" rev-parse --verify HEAD^ >/dev/null || fail 'candidate parent was not fetched'

git -C "$target_dir" remote remove origin
test -z "$(git -C "$target_dir" remote)" || fail 'candidate checkout retained a remote'
printf 'candidate_sha=%s status=fetched\n' "$candidate_sha"
