# Timeweb amd64 image publication gates

This runbook covers the one-time immutable `linux/amd64` publication contour for application
source `35c8312b79cccdd136f2bfd892efbea629b8b919`. It does not authorize deployment, VPS
provisioning, database access or database mutation.

## Gate 1: non-publishing BuildKit attestation probe

First merge the probe workflow to the default branch through its separately reviewed, green PR. A
new `workflow_dispatch` file cannot be run before it exists on the default branch. Then run
`.github/workflows/probe-timeweb-amd64-attestations.yaml` from the exact reviewed merge commit on
`main`. Dispatch with the branch ref `main` only after verifying that its current tip equals the
reviewed SHA; the dispatch API does not accept a raw commit SHA as `ref`. Use these dispatch inputs:

- `expected_source_sha`: `35c8312b79cccdd136f2bfd892efbea629b8b919`;
- `expected_probe_sha`: the exact reviewed `main` commit containing the probe workflow;
- `confirmation`: `PROBE_TIMEWEB_AMD64_ATTESTATIONS_ONLY`.

The workflow has only `contents: read`. It verifies the exact application source/tree, then builds
the API and Web Dockerfiles from an exact remote Git commit context into separate local OCI archives.
The reviewed Buildx version, BuildKit image digest, Node/Nginx base-image digests and SBOM scanner
digest are pinned identically in the probe and publication workflows. It has no registry login,
package-write permission, registry push, staging secrets, SSH, deployment or database step.

The OCI exporter emits one bounded two-level layout: the root index contains exactly one
content-addressed nested index, and that nested index contains exactly one `linux/amd64` runtime
manifest and one linked attestation manifest. The probe rejects direct-root manifests, more than one
root descriptor, additional nesting, duplicate/extra runtime or attestation descriptors, and any
digest or size mismatch. It never performs arbitrary recursive traversal.

The retained evidence contains both OCI indexes, the selected root/runtime/attestation descriptors,
content-hashed runtime and attestation manifests, provenance and SBOM statements, the observed
Buildx/BuildKit identity, a summary and checksums. The artifact upload uses an explicit failure-safe
condition after a successful OCI build, so partial diagnostic evidence is retained when extraction
or contract validation fails. For the pinned local OCI exporter, the provenance and SBOM statements
must have empty subjects. Their runtime custody is instead bound by the content-addressed
attestation manifest, whose subject must match the exact runtime media type, digest and size. The
final step also requires the exact statement and predicate types, remote Git config source and
material, builder ID, Node/Nginx Package URLs with their reviewed multi-platform index digests, and
the pinned SBOM scanner material. The earlier base-image preflight independently binds each reviewed
index to its single reviewed `linux/amd64` child digest; the two contracts are not interchangeable.

Any failed or cancelled probe is `NO-GO` for image publication. Inspect the evidence artifact and
fix the publication validator or pin the observed BuildKit version in a separately reviewed change;
do not dispatch publication merely because the OCI build itself succeeded.

## Gate 2: immutable image publication

Only after Gate 1 is green and a separate publication approval is recorded, run
`.github/workflows/publish-timeweb-amd64-images.yaml` from the exact reviewed `main` SHA with the
`publish` operation and its exact confirmation input. The publication workflow creates five unique,
non-`latest` image tags and verifies their registry digests, `linux/amd64` runtime manifests,
attestation-manifest runtime subjects, provenance and SBOM statement subjects, and the exact
source/base-index/scanner material set before producing a complete non-authorizing digest manifest.
The registry validator intentionally keeps the stricter non-empty runtime subjects on the
statements; the probe's storage-bound empty-subject exception does not authorize publication.

A partial registry inventory or missing final manifest is `NO-GO` for deployment. Do not retry the
same publication request blindly: inventory the unique run tags first and prepare a new reviewed
attempt if required.

## Gate 3: staging deployment

Publication evidence never authorizes deployment. Transfer of runtime secrets, database bootstrap,
migration, routing changes, application activation and Jetson retirement remain separate approvals
with their own backup, rollback and post-deploy checks.
