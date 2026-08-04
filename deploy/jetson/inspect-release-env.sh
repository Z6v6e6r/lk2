#!/bin/sh

set -eu

fail() {
  printf '%s\n' "Release metadata inspection failed: $*" >&2
  exit 1
}

if [ "$#" -ne 1 ]; then
  fail 'usage: inspect-release-env.sh <release.env>'
fi

release_env_path="$1"
[ -f "$release_env_path" ] && [ ! -L "$release_env_path" ] ||
  fail 'release.env is absent or unsafe'

awk '
  function diagnostic_key(line, equals, key) {
    equals = index(line, "=")
    if (equals <= 1) return "NO_KEY"
    key = substr(line, 1, equals - 1)
    if (key ~ /^[A-Z][A-Z0-9_]*$/) return key
    return "UNSAFE_KEY"
  }

  /^[[:space:]]*$/ { next }
  /^#/ { next }
  /^[A-Z][A-Z0-9_]*=[^[:cntrl:]]*$/ { next }
  {
    invalid = 1
    printf "release_env_invalid line=%d key=%s length=%d\n", NR, diagnostic_key($0), length($0)
  }
  END { exit invalid }
' "$release_env_path" >&2 || fail 'release.env contains unsafe metadata; values were redacted'

printf '%s\n' 'release_env_valid'
