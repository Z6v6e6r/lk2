# Timeweb amd64 image publication gates

This runbook retains the historical one-time `linux/amd64` probe and interrupted-publication
evidence for application source `35c8312b79cccdd136f2bfd892efbea629b8b919`. That evidence does
not authorize a new release, deployment, VPS provisioning, database access or database mutation.

## Current exact-source publication contract

The current publication target is source
`595e954bb8f53367baf034d7f39b255af0fda5fd`, with immutable Git tree
`3f4c1e63dd30eb60251533b95f1970fd96754a08`. Dispatch the publication workflow only from its
separately reviewed exact `main` workflow SHA, with:

- `expected_source_sha`: `595e954bb8f53367baf034d7f39b255af0fda5fd`;
- `expected_workflow_sha`: the exact reviewed `main` commit containing the workflow;
- `confirmation`: `PUBLISH_TIMEWEB_AMD64_595E954` for the publishing operation.

Each reconciliation dispatch must pass the same `expected_source_sha`, the exact successful
publication run ID and publication workflow SHA. The workflow rejects a publication artifact, image
record, source tree, immutable tag or final `release-manifest.gitCommit` that does not resolve to the
approved source. Historical run `32625879321` and its digests are not fresh evidence for this
contract.

The current release-evidence sequence is:

1. Dispatch `publish-timeweb-amd64-images.yaml` with the exact inputs above and retain its complete
   five-image publication artifact.
2. Dispatch `reconcile-timeweb-amd64-publication.yaml` with `expected_source_sha`, the successful
   `publication_run_id`, its exact `publication_workflow_sha`, and confirmation
   `RECONCILE_TIMEWEB_AMD64_PUBLICATION`.
3. After the first reconciliation succeeds, dispatch the same reconciliation workflow again with
   the same publication inputs plus `prior_reconciliation_run_id` set to the first successful
   reconciliation run. Only this second identical read-back can produce `release-manifest.json`.

Publication and both reconciliations must succeed for the same source and publication run. Their
artifacts are evidence only; they do not authorize deployment.

The first successful reconciliation emits only non-authorizing evidence. A second successful,
byte-equivalent reconciliation of the same publication emits the deploy-facing pair
`release-manifest.json` and `release-manifest.sha256`. The JSON has exactly one accepted contract:

- `schemaVersion` is `PHUB_TIMEWEB_RELEASE_MANIFEST_V1`;
- `repository`, `gitCommit` and `platform` identify `Z6v6e6r/lk2`, the exact selected source commit
  and `linux/amd64`;
- `images` is an array containing exactly one entry for each of `web`, `api`, `worker`, `realtime`
  and `migrator`; every entry carries its real reconciled root/index digest, repository,
  architecture, source revision and per-image `provenance`, `sbom` and `reconciliation` assertions;
- `reconciliationRuns` contains the two distinct successful read-back run IDs;
- `release-manifest.sha256` contains the SHA-256 custody checksum for the exact manifest bytes.

The production producer copies the real index digests and explicit per-image verification results
from reconciliation evidence, then immediately runs the same strict validator used by deployment
admission. The validator is invoked with `release-manifest.json` and always requires the adjacent,
fixed-name `release-manifest.sha256`; the checksum is not optional. Numeric `schemaVersion: 1`, an
object-valued `images`, top-level `verification`, missing per-image verification, missing digests, a
stale source commit or an invalid checksum all fail closed. Probe, push-receipt, publication and
reconciliation manifests retain their own `schemaVersion: 1` evidence kinds; they are not alternate
deploy-facing release-manifest formats and cannot be passed to the release validator.

## Historical appendix: superseded non-publishing BuildKit attestation probe

The earlier probe for application source
`35c8312b79cccdd136f2bfd892efbea629b8b919` produced non-authorizing local OCI evidence only. Its
workflow has been removed from the active GitHub Actions set, so it cannot be dispatched to mint new
evidence for the superseded source. The original implementation and retained artifacts remain in Git
and Actions history for audit purposes; neither can satisfy the current `595e954...` publication or
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

A partial registry inventory or missing final manifest is `NO-GO` for deployment. Do not retry the
same publication request blindly: inventory the unique run tags first and prepare a new reviewed
attempt if required.

## Historical appendix: superseded interrupted-run reconciliation

The procedure below describes only original run `32625879321`. Its fixed confirmation and digests
are not accepted by the current workflow and are not evidence for source `595e954...`.

If a publication push completed but its custody step was interrupted or failed, do not dispatch the
publication workflow again. Use the separately reviewed
`.github/workflows/reconcile-timeweb-amd64-publication.yaml` from exact reviewed `main`, with its
exact workflow SHA and `RECONCILE_TIMEWEB_AMD64_32625879321` confirmation. This manual workflow is
read-only (`contents: read`, `packages: read`) and can inspect only the five hard-pinned tags from
original run `32625879321` / attempt `1`, with their hard-pinned index digests. It validates the
root index, runtime descriptor, linked attestation manifests, statement blob hashes, runtime
subjects, provenance/SBOM, source tree, original builder URL, reviewed base/scanner materials and
the runtime image shape. It emits a retained reconciliation manifest that explicitly leaves deploy,
VPS provisioning and database mutation unauthorized.

Any tag/digest mismatch, missing linked descriptor, material mismatch, runtime probe failure or
retry exhaustion is `NO-GO`. The reconciliation workflow does not build, push, overwrite, delete,
deploy, access VPS hosts, or connect to PostgreSQL.

## Current Gate 3: staging deployment

Publication evidence never authorizes deployment. Transfer of runtime secrets, database bootstrap,
migration, routing changes, application activation and Jetson retirement remain separate approvals
with their own backup, rollback and post-deploy checks.
