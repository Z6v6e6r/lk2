# Timeweb amd64 image publication gates

This runbook retains the historical one-time `linux/amd64` probe and interrupted-publication
evidence for application source `35c8312b79cccdd136f2bfd892efbea629b8b919`. That evidence does
not authorize a new release, deployment, VPS provisioning, database access or database mutation.

## Current exact-source publication contract

The publication target is always the exact fetched `origin/main` commit that contains the reviewed
workflow. Freeze that commit as `SOURCE_SHA`, resolve its immutable tree as `SOURCE_TREE`, and
dispatch the workflow only from that same commit, with:

- `expected_source_sha`: `SOURCE_SHA`;
- `expected_workflow_sha`: the same `SOURCE_SHA`;
- `confirmation`: `PUBLISH_TIMEWEB_AMD64_<FIRST_12_SOURCE_SHA_CHARACTERS_IN_UPPERCASE>`.

The publication workflow rejects a dispatch when its workflow SHA, the freshly fetched
`origin/main`, and `expected_source_sha` are not identical. It resolves the application tree with
Git and rejects an artifact, image record, source tree, immutable tag or final
`release-manifest.gitCommit`/`gitTree` pair that does not resolve to that commit. Historical run
`32625879321` and its digests are not fresh evidence for a later commit.

The normal release-evidence sequence is:

1. Dispatch `publish-timeweb-amd64-images.yaml` with the exact inputs above and retain its complete
   five-image publication artifact and same-run canonical artifact. A rerun attempt is invalid;
   prepare a fresh reviewed first attempt instead.
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
- `images` is an array containing exactly one entry for each of `web`, `api`, `worker`, `realtime`
  and `migrator`; every entry carries its immutable root/index digest, immutable runtime digest,
  repository, architecture, source revision and per-image `provenance`, `sbom` and `publication`
  assertions;
- `release-manifest.sha256` contains the SHA-256 custody checksum for the exact manifest bytes.

The shared production contract code resolves the Git tree, copies only complete five-image
publication evidence into the canonical manifest and immediately validates the exact JSON and
sidecar that will be uploaded. Same-run validation also supplies the expected workflow SHA, run ID
and run attempt. Missing or duplicate components, mutable-only references, missing digests,
incorrect platform or source identity, missing provenance/SBOM, publication identity drift, altered
bytes or sidecar filename all fail closed.

Historical `PHUB_TIMEWEB_RELEASE_MANIFEST_V1` artifacts remain readable through the legacy schema
for audit compatibility. They keep their two reconciliation run IDs and do not acquire a fabricated
tree or publication identity. V1 cannot satisfy V2 same-publication-run validation. Probe,
push-receipt, internal publication and recovery reconciliation manifests retain their own numeric
`schemaVersion: 1` evidence kinds; they are not alternate deploy-facing release-manifest formats.

`reconcile-timeweb-amd64-publication.yaml` remains a separately authorized, optional read-only
recovery/read-back workflow. It no longer accepts `prior_reconciliation_run_id` and never produces
the canonical pair, so it cannot replace or contradict the canonical artifact from the publication
run.

## Historical appendix: superseded non-publishing BuildKit attestation probe

The earlier probe for application source
`35c8312b79cccdd136f2bfd892efbea629b8b919` produced non-authorizing local OCI evidence only. Its
workflow has been removed from the active GitHub Actions set, so it cannot be dispatched to mint new
evidence for the superseded source. The original implementation and retained artifacts remain in Git
and Actions history for audit purposes; neither can satisfy a current exact-main publication or
deployment gate.

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

A partial registry inventory or missing final manifest is `NO-GO` for deployment. Do not retry the
same publication request blindly: inventory the unique run tags first and prepare a new reviewed
attempt if required.

## Current Gate 2: optional read-only reconciliation

If a successful publication push needs independent recovery or read-back, do not dispatch the
publication workflow again. After a separate reconciliation approval, run
`.github/workflows/reconcile-timeweb-amd64-publication.yaml` from exact reviewed `main` with:

- `expected_workflow_sha`: the exact reviewed `main` SHA containing the reconciliation workflow;
- `expected_source_sha`: the source SHA recorded by the original publication artifact;
- `publication_run_id`: the exact successful first-attempt publication run to read back;
- `publication_workflow_sha`: the exact `main` SHA that executed that publication run;
- `confirmation`: `RECONCILE_TIMEWEB_AMD64_PUBLICATION`.

The workflow is read-only (`contents: read`, `packages: read`). It first binds those inputs to the
immutable publication artifact from the named run, then validates the five recorded tags and index
digests, root indexes, runtime descriptors, linked attestation manifests, statement blob hashes,
runtime subjects, provenance/SBOM, source tree, original builder URL, reviewed base/scanner
materials and runtime image shape. It emits a retained reconciliation manifest that explicitly
leaves deploy, VPS provisioning and database mutation unauthorized.

Any tag/digest mismatch, missing linked descriptor, material mismatch, runtime probe failure or
retry exhaustion is `NO-GO`. The reconciliation workflow does not build, push, overwrite, delete,
deploy, access VPS hosts, or connect to PostgreSQL.

Historical run `32625879321`, its fixed digests and confirmation
`RECONCILE_TIMEWEB_AMD64_32625879321` are retained only in Git and Actions history. They are not
accepted by the current workflow and are not evidence for a current exact-main release.

## Current Gate 3: staging deployment

Publication evidence never authorizes deployment. Use `timeweb-lk2-beta.md` for the independent
host, database, secrets, TLS, activation, rollback and post-deploy gates.
