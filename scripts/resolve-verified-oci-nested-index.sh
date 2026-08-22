#!/usr/bin/env bash

set -euo pipefail

layout=${1:?OCI layout path is required}
evidence=${2:?Evidence directory is required}
root_index="$layout/index.json"

test -f "$root_index"
mkdir -p "$evidence"

if stat -c '%s' "$root_index" >/dev/null 2>&1; then
  file_size() { stat -c '%s' "$1"; }
else
  file_size() { stat -f '%z' "$1"; }
fi

if command -v sha256sum >/dev/null 2>&1; then
  file_digest() { sha256sum "$1" | awk '{print "sha256:" $1}'; }
else
  file_digest() { shasum -a 256 "$1" | awk '{print "sha256:" $1}'; }
fi

jq -e '
  .schemaVersion == 2 and
  .mediaType == "application/vnd.oci.image.index.v1+json" and
  (.manifests | type == "array" and length == 1) and
  .manifests[0].mediaType == "application/vnd.oci.image.index.v1+json" and
  (.manifests[0].digest | test("^sha256:[0-9a-f]{64}$")) and
  (.manifests[0].size | type == "number" and floor == . and . > 0) and
  (.manifests[0].platform == null)
' "$root_index" >/dev/null

jq '.manifests[0]' "$root_index" > "$evidence/selected-root-descriptor.json"
nested_digest=$(jq -r '.digest' "$evidence/selected-root-descriptor.json")
nested_size=$(jq -r '.size' "$evidence/selected-root-descriptor.json")
nested_sha=${nested_digest#sha256:}
nested_blob="$layout/blobs/sha256/$nested_sha"

test -f "$nested_blob"
test ! -L "$nested_blob"
test "$(file_size "$nested_blob")" = "$nested_size"
test "$(file_digest "$nested_blob")" = "$nested_digest"
cp "$nested_blob" "$evidence/oci-nested-index.json"

jq -e '
  def runtime:
    .mediaType == "application/vnd.oci.image.manifest.v1+json" and
    .platform.os == "linux" and
    .platform.architecture == "amd64" and
    ((.platform.variant // "") == "") and
    (.digest | test("^sha256:[0-9a-f]{64}$")) and
    (.size | type == "number" and floor == . and . > 0);
  def attestation($runtime):
    .mediaType == "application/vnd.oci.image.manifest.v1+json" and
    .platform.os == "unknown" and
    .platform.architecture == "unknown" and
    .annotations["vnd.docker.reference.type"] == "attestation-manifest" and
    .annotations["vnd.docker.reference.digest"] == $runtime and
    (.digest | test("^sha256:[0-9a-f]{64}$")) and
    (.size | type == "number" and floor == . and . > 0);
  .schemaVersion == 2 and
  .mediaType == "application/vnd.oci.image.index.v1+json" and
  (.manifests | type == "array" and length == 2) and
  ([.manifests[] | select(runtime)] | length) == 1 and
  (([.manifests[] | select(runtime)][0].digest) as $runtime |
    ([.manifests[] | select(attestation($runtime))] | length) == 1)
' "$evidence/oci-nested-index.json" >/dev/null

jq '
  .manifests[] | select(
    .mediaType == "application/vnd.oci.image.manifest.v1+json" and
    .platform.os == "linux" and
    .platform.architecture == "amd64" and
    ((.platform.variant // "") == "")
  )
' "$evidence/oci-nested-index.json" > "$evidence/runtime-descriptor.json"
runtime_digest=$(jq -r '.digest' "$evidence/runtime-descriptor.json")
jq --arg runtime "$runtime_digest" '
  .manifests[] | select(
    .mediaType == "application/vnd.oci.image.manifest.v1+json" and
    .platform.os == "unknown" and
    .platform.architecture == "unknown" and
    .annotations["vnd.docker.reference.type"] == "attestation-manifest" and
    .annotations["vnd.docker.reference.digest"] == $runtime
  )
' "$evidence/oci-nested-index.json" > "$evidence/attestation-descriptor.json"
