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

The retained evidence contains the OCI index, content-hashed runtime and attestation manifests,
provenance and SBOM statements, the observed Buildx/BuildKit identity, a summary and checksums. The
artifact upload uses an explicit failure-safe condition after a successful OCI build, so partial
diagnostic evidence is retained when extraction or contract validation fails. The final step
compares the real statements with the publication workflow contract: statement and predicate types,
runtime subject, exact remote Git config source and material digest, builder ID, exact Node/Nginx
Package URLs and reviewed `linux/amd64` child digests.

Any failed or cancelled probe is `NO-GO` for image publication. Inspect the evidence artifact and
fix the publication validator or pin the observed BuildKit version in a separately reviewed change;
do not dispatch publication merely because the OCI build itself succeeded.

## Gate 2: immutable image publication

Only after Gate 1 is green and a separate publication approval is recorded, run
`.github/workflows/publish-timeweb-amd64-images.yaml` from the exact reviewed `main` SHA with the
`publish` operation and its exact confirmation input. The publication workflow creates five unique,
non-`latest` image tags and verifies their registry digests, `linux/amd64` runtime manifests,
provenance and SBOM evidence before producing a complete non-authorizing digest manifest.

A partial registry inventory or missing final manifest is `NO-GO` for deployment. Do not retry the
same publication request blindly: inventory the unique run tags first and prepare a new reviewed
attempt if required.

## Gate 3: staging deployment

Publication evidence never authorizes deployment. Transfer of runtime secrets, database bootstrap,
migration, routing changes, application activation and Jetson retirement remain separate approvals
with their own backup, rollback and post-deploy checks.
