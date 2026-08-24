#!/usr/bin/env bash

set -euo pipefail

archive=${1:?OCI archive path is required}
layout=${2:?OCI layout destination is required}
evidence=${3:?Evidence directory is required}

test -f "$archive"
test ! -e "$layout"
mkdir -p "$layout" "$evidence"

LC_ALL=C tar -tf "$archive" > "$evidence/oci-archive-files.txt"
LC_ALL=C tar -tvf "$archive" > "$evidence/oci-archive-files.verbose.txt"

normalized_inventory="$evidence/oci-archive-files.normalized.txt"
sed 's:/$::' "$evidence/oci-archive-files.txt" > "$normalized_inventory"
test -n "$(sed -n '1p' "$normalized_inventory")"
test "$(sort "$normalized_inventory" | uniq -d | wc -l | tr -d ' ')" -eq 0

while IFS= read -r path; do
  if [[ "$path" =~ ^blobs/sha256/[0-9a-f]{64}$ ]]; then
    continue
  fi
  case "$path" in
    blobs | blobs/sha256 | index.json | oci-layout) ;;
    *)
      printf 'Unsafe OCI archive path: %s\n' "$path" >&2
      exit 65
      ;;
  esac
done < "$normalized_inventory"

if awk 'substr($1, 1, 1) != "-" && substr($1, 1, 1) != "d" { exit 1 }' \
  "$evidence/oci-archive-files.verbose.txt"; then
  :
else
  echo 'OCI archive contains a link or unsupported entry type.' >&2
  exit 65
fi

tar -xf "$archive" -C "$layout" --no-same-owner --no-same-permissions
test "$(jq -r '.imageLayoutVersion // empty' "$layout/oci-layout")" = 1.0.0
jq -e '.schemaVersion == 2 and (.manifests | type == "array" and length > 0)' \
  "$layout/index.json" >/dev/null

if command -v sha256sum >/dev/null 2>&1; then
  hash_file() { sha256sum "$1" | awk '{print $1}'; }
else
  hash_file() { shasum -a 256 "$1" | awk '{print $1}'; }
fi

blob_count=0
while IFS= read -r -d '' blob; do
  expected=${blob##*/}
  test "$(hash_file "$blob")" = "$expected"
  blob_count=$((blob_count + 1))
done < <(find "$layout/blobs/sha256" -type f -print0)
test "$blob_count" -gt 0
