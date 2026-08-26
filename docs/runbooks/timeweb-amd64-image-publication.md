# Timeweb amd64 image publication gates

This runbook retains the historical one-time `linux/amd64` probe and interrupted-publication
evidence for application source `35c8312b79cccdd136f2bfd892efbea629b8b919`. That evidence does
not authorize a new release, deployment, VPS provisioning, database access or database mutation.

## Current exact-source publication contract

The publication workflow has no static source commit or tree. A separately approved future
publication must run from the exact current `main` commit and use that same commit for
`github.sha`, `github.workflow_sha`, `expected_source_sha` and `expected_workflow_sha`. Its
confirmation is `PUBLISH_TIMEWEB_AMD64_<FIRST_12_SHA_UPPERCASE>`. A Draft PR head, an earlier main
commit, or a reverted publication source is not eligible.

The publication workflow reads the live default-branch ref, resolves the application tree from the
exact checked-out source with Git and rejects a publication artifact, image record, source tree,
immutable tag or final
`release-manifest.gitCommit`/`gitTree` pair that does not resolve to the approved source. Historical
run `32625879321` and its digests are not fresh evidence for this contract.

Run `33011023879` attempt 1 is a failed partial publication for exact source/workflow
`5a7d3c14c8c413f7243da9772b00b5ded6cdf81b`. All five unique tags reached GHCR, but the former
inline provenance matcher rejected BuildKit v0.32.2's canonical combined material PURL
`pkg:docker/<normalized-package>@<locked-tag>?digest=sha256:<locked-index>&platform=linux%2Famd64`.
The run has no complete publication artifact and no same-run canonical V2 artifact. It must never be
rerun, reconciled, retagged, deleted, copied into another release identity or used by deployment.
Its partial tags and digests remain immutable non-authorizing incident evidence.

The normal release-evidence sequence is:

1. Dispatch `publish-timeweb-amd64-images.yaml` with the exact inputs above and retain its complete
   five-image publication artifact and same-run canonical artifact.
2. Verify that the one publication run succeeded only after all five publish, digest, platform,
   provenance, SBOM, internal manifest, canonical manifest, checksum and artifact-upload gates.

No reconciliation run ID, later workflow artifact or second manual dispatch is part of this normal
path. The artifacts are evidence only; they do not authorize deployment.

The publication run keeps two artifact classes deliberately separate:

- `timeweb-amd64-publication-<run-id>-1` is the internal, detailed custody artifact containing
  `timeweb-amd64-publication-manifest.json`, registry records and attestation evidence;
- `timeweb-amd64-canonical-release-<source-sha>-<run-id>-1` is the canonical artifact and contains
  exactly `release-manifest.json` and `release-manifest.sha256`.

The current canonical JSON contract is an explicit incompatible transition to
`PHUB_TIMEWEB_RELEASE_MANIFEST_V2`:

- `repository`, `gitCommit`, literal `gitTree` and `platform` identify `Z6v6e6r/lk2`, the exact
  selected application commit and resolved tree, and `linux/amd64`;
- `publication` binds the manifest to the publication workflow path, exact workflow SHA, same run ID
  and first run attempt;
- `baseLock` binds the raw SHA-256 and `PHUB_TIMEWEB_BASE_IMAGES_V2` marker from
  `deploy/timeweb/base-images.lock.json`, while `baseImages` carries the exact three logical base
  identities derived from that same lock;
- `images` is an array containing exactly one entry for each of `web`, `api`, `worker`, `realtime`
  and `migrator`; every entry carries its immutable root/index digest, immutable runtime digest,
  repository, architecture, source revision and per-image `provenance`, `sbom` and `publication`
  assertions;
- `release-manifest.sha256` contains the SHA-256 custody checksum for the exact manifest bytes.

The shared production contract code resolves the Git tree, copies only complete five-image
publication evidence into the canonical manifest and immediately validates the exact JSON and
sidecar that will be uploaded. Same-run validation also supplies the expected workflow SHA, run ID
and run attempt. Missing or duplicate components, mutable-only references, missing digests,
incorrect platform or source identity, missing provenance/SBOM subjects, base-lock or base-identity
drift, altered bytes or sidecar filename all fail closed.

Publication and optional reconciliation use the same semantic provenance-material verifier. It
normalizes only the explicitly reviewed Docker package aliases (`node`/`docker.io/library/node`,
`nginx`/`docker.io/library/nginx`, and `docker/buildkit-syft-scanner` with or without the
`docker.io/` prefix), then requires the locked version, digest qualifier, `linux/amd64` platform,
matching statement digest object, exact source material, exact Dockerfile, exact builder attempt and
the complete service closure. Tag-only, digest-only, malformed, double-encoded, duplicate, unknown,
substituted or extra material forms fail closed. Diagnostic records always keep
`authorizesPublication=false` and `authorizesDeploy=false`.

Pull-request CI also builds no-push OCI outputs for `web` and `api` with Buildx v0.36.1, BuildKit
v0.32.2 and the locked scanner. It extracts the actual max-mode provenance and runs that same
verifier at the exact PR head. The probe has `contents: read`, no GHCR login, no package write,
publication tag, environment approval, host port or long-lived builder, and uploads only sanitized
non-authorizing material diagnostics. It supplements rather than replaces the existing five
exact-head no-push AMD64 image builds.

Historical `PHUB_TIMEWEB_RELEASE_MANIFEST_V1` artifacts remain readable through the legacy schema
for audit compatibility. They keep their two reconciliation run IDs and do not acquire a fabricated
tree or publication identity. V1 cannot satisfy V2 same-publication-run validation. Probe,
push-receipt, internal publication and recovery reconciliation manifests retain their own numeric
`schemaVersion: 1` evidence kinds; they are not alternate deploy-facing release-manifest formats.

`reconcile-timeweb-amd64-publication.yaml` remains a separately authorized, optional read-only
recovery/read-back workflow. It checks out the historical publication source into a separate path,
validates that source's lock and Dockerfiles, and compares their raw lock checksum and identities to
the original publication artifact. A later main lock cannot redefine historical custody. If the
same-run canonical pair exists, reconciliation only revalidates it. Otherwise it may emit only
`PHUB_TIMEWEB_RECONCILIATION_EVIDENCE_V1`, with all authority flags false and `notCanonical: true`.

## Historical appendix: superseded non-publishing BuildKit attestation probe

The earlier probe for application source
`35c8312b79cccdd136f2bfd892efbea629b8b919` produced non-authorizing local OCI evidence only. Its
workflow has been removed from the active GitHub Actions set, so it cannot be dispatched to mint new
evidence for the superseded source. The original implementation and retained artifacts remain in Git
and Actions history for audit purposes; neither can satisfy the current exact-main publication or
deployment gates.

## Current Gate 1: immutable image publication

After a separate publication approval is recorded, run
`.github/workflows/publish-timeweb-amd64-images.yaml` from the exact reviewed `main` SHA with the
`publish` operation and its exact confirmation input. The publication workflow creates five unique,
non-`latest` image tags and verifies their registry digests, `linux/amd64` runtime manifests,
attestation-manifest runtime subjects, provenance and SBOM statement subjects, and the exact
source/base-index/scanner material set before producing a complete non-authorizing digest manifest.
The registry validator intentionally keeps the stricter non-empty runtime subjects on the
statements; the probe's storage-bound empty-subject exception does not authorize publication.
Immediately after a push, GHCR may expose the exact root index before every linked attestation
descriptor is readable. The custody reader therefore retries only bounded, exact digest-addressed
reads (five attempts with exponential delays) and emits `PHUB_GHCR_CUSTODY_READ`,
`PHUB_GHCR_CUSTODY_RETRY`, `PHUB_GHCR_CUSTODY_PASSED`, or a fail-closed
`PHUB_GHCR_CUSTODY_EXHAUSTED` stage marker. Each retry hashes the temporary response against the
expected root, attestation, statement, or runtime digest before atomically preserving it. A retry
never falls back to a tag, a different digest, or an unbounded wait.

Production bases are controlled only by `deploy/timeweb/base-images.lock.json`. The five production
Dockerfiles contain fully qualified tag-plus-index-digest projections of the lock. Before GHCR
login, the reusable verifier strictly rejects duplicate JSON keys, validates every Dockerfile stage,
and reads the locked public Docker Hub indexes, runnable AMD64 child manifests and configs by digest.
The annotation tags are human context only: tag movement neither fails immutable validation nor
authorizes a replacement digest.

A partial registry inventory or missing final manifest is `NO-GO` for deployment. Do not retry the
same publication request blindly. Run `33011023879` is permanently non-repeatable and
non-reconcilable; any future publication requires a different exact-current-main identity and a
separate explicit authorization after the source fix is merged and its exact-head CI is green.

## Current Gate 2: optional read-only reconciliation

If a successful publication push needs independent recovery or read-back, do not dispatch the
publication workflow again. After a separate reconciliation approval, run
`.github/workflows/reconcile-timeweb-amd64-publication.yaml` from exact reviewed `main` with:

- `expected_workflow_sha`: the exact reviewed `main` SHA containing the reconciliation workflow;
- `expected_source_sha`: the exact source SHA recorded by the successful publication run;
- `publication_run_id`: the exact successful first-attempt publication run to read back;
- `publication_workflow_sha`: the exact `main` SHA that executed that publication run;
- `confirmation`: `RECONCILE_TIMEWEB_AMD64_PUBLICATION`.

The workflow is read-only (`contents: read`, `actions: read`, `packages: read`). It first binds those
inputs to the successful first-attempt publication run and immutable publication artifact, then
uses the source commit's own lock and Dockerfiles while validating the five index digests, root
indexes, runtime descriptors, linked attestation manifests, statement blob hashes, runtime
subjects, provenance/SBOM, source tree, original builder URL, reviewed base/scanner materials and
runtime image shape. It cannot recreate missing canonical evidence.

Any tag/digest mismatch, missing linked descriptor, material mismatch, runtime probe failure or
retry exhaustion is `NO-GO`. The reconciliation workflow does not build, push, overwrite, delete,
deploy, access VPS hosts, or connect to PostgreSQL.

Historical failed or incomplete runs are retained only in Git and Actions history. A run that is
not completed successfully on attempt one, lacks the exact original publication artifact, or has
fewer than five complete images cannot enter reconciliation or satisfy canonical V2.

## Current Gate 3: staging deployment

Publication evidence never authorizes deployment. Transfer of runtime secrets, database bootstrap,
migration, routing changes, application activation and Jetson retirement remain separate approvals
with their own backup, rollback and post-deploy checks.
