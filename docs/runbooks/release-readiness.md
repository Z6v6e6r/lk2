# Release readiness report (ADR-0026 Phase 1)

Read-only preflight that prints one GO/NO-GO report by category for an exact release package. It
implements the `--plan` contract from ADR-0026: a fresh preflight must finish in seconds and name the
blocking category instead of failing later inside a mutation.

The report never contacts the host, GitHub, Docker or the database. The operator supplies the exact
evidence collected by the canonical read-only probes.

## Usage

```sh
npm run release:readiness -- --input release-readiness.json
npm run release:readiness -- --input release-readiness.json --json
```

Exit codes: `0` — GO; `2` — NO_GO; `1` — malformed input.

## Input packet

```json
{
  "source": {
    "sha": "<40-hex>",
    "mainSha": "<40-hex>",
    "ci": { "runId": "40087508274", "attempt": 1, "conclusion": "success" }
  },
  "publication": {
    "runId": "40091652483",
    "attempt": 1,
    "conclusion": "success",
    "sourceSha": "<40-hex>",
    "manifestSha256": "<64-hex>",
    "artifactDigest": "sha256:<64-hex>"
  },
  "capacity": {
    "databaseBytes": 11176434711,
    "requiredDiskBytes": 47453667687,
    "freeDiskBytes": 42928771072,
    "profile": "beta"
  },
  "ledger": { "current": 102, "target": 105 },
  "approval": {
    "approvedRequestSha256": "<64-hex>",
    "currentRequestSha256": "<64-hex>",
    "approvedAt": "2026-10-24T18:00:00.000Z",
    "expiresAt": "2026-10-25T00:11:58.000Z",
    "now": "2026-10-25T08:05:11.000Z"
  },
  "locks": { "activeOperations": 0, "activeLease": false },
  "rollback": {
    "previousApiDigest": "sha256:<64-hex>",
    "previousWebDigest": "sha256:<64-hex>"
  }
}
```

`capacity.requiredDiskBytes` must come from the canonical capacity readback; the module does not
invent a restore formula. The packaged fallback (`2 x database + 5 GiB`) is only used by explicit
callers that do not supply the canonical value.

## Categories

| Category      | GO when                                                                                      |
| ------------- | -------------------------------------------------------------------------------------------- |
| `SOURCE`      | source SHA equals current main and first-attempt push CI succeeded                           |
| `PUBLICATION` | canonical publication succeeded on attempt 1 for this source, with manifest/artifact digests |
| `CAPACITY`    | free disk ≥ required bytes from the readback                                                 |
| `LEDGER`      | a positive forward migration path is known                                                   |
| `APPROVAL`    | approval is still valid, or may be extended because the exact request hash is unchanged      |
| `LOCKS`       | no active operation and no active lease                                                      |
| `ROLLBACK`    | previous API/Web digests are recorded and distinct                                           |

Missing evidence is `NO_GO` with a `*_MISSING` code; it is never an implicit pass.

## Approval extension

`scripts/release-approval-window.ts` implements the ADR-0026 rule: an approval may be extended by a
fresh preflight only while `approvedRequestSha256 === currentRequestSha256`, capped by the extension
and total limits. A changed request, source identity or target requires a new human approval. The
report shows `APPROVAL_EXTENDED` and the new expiry; it does not write or grant approval.

## What this does not do

It does not execute a transition, create a backup, resize a disk, contact a host, or replace the
canonical controllers. A GO report is a precondition, not deployment authority. The operator still
needs the exact-package approval and the canonical runbook sequence.
