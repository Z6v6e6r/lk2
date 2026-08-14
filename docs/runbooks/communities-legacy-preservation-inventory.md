# Communities legacy preservation inventory

## Status and boundary

This procedure validates a redacted, single-tenant Communities inventory offline. It never reads
MongoDB or PostgreSQL, never runs a migration and never writes business data.

An `INVENTORY_STRUCTURALLY_CONSISTENT` result means only that the supplied inventory is internally
consistent with a separately approved mapping baseline. It always returns
`activationReady=false` and `authorizesMutation=false`. It is not approval for import, cutover,
commands, media, invites, realtime or production promotion.

## Required inputs

Prepare five independently controlled values:

1. An absolute path to a private (`0600`), current-user-owned regular JSON manifest.
2. An absolute path to a private (`0600`), current-user-owned regular JSON mapping baseline.
3. An absolute path to the private (`0600`) exact exit-`0` Node-RED writer report.
4. The lowercase SHA-256 of the exact approved baseline bytes, recorded through a channel separate
   from the candidate manifest and baseline transfer.
5. The lowercase SHA-256 of the exact approved writer-report bytes, independently recorded before
   preservation verification.

The approved SHA-256 values must not be calculated from the candidate inputs immediately before
running the verifier. Doing that would remove the independent trust boundaries. Do not place raw
identities, phone numbers, names, tokens or source database credentials in any input.

The manifest, baseline and writer report contain pseudonymous evidence. Do not run the verifier until an approved
evidence record identifies the storage location, access owner, permitted operators, retention
period and destruction procedure for all three inputs and the resulting report. Reference that evidence
record in the review; this repository does not define or approve the retention policy.

The manifest is limited to 32 MiB, the baseline to 64 KiB and the writer report to 1 MiB. Symbolic
links, non-regular files, foreign ownership and group/other permissions are rejected. Use an outer
process deadline when the files are stored on a remote or FUSE filesystem.

## Offline verification

Run from the repository root with the separately recorded digest supplied through the environment:

```bash
COMMUNITIES_LEGACY_BASELINE_SHA256_REQUIRED=<approved-lowercase-sha256> \
COMMUNITIES_LEGACY_WRITER_REPORT_SHA256_REQUIRED=<approved-writer-report-sha256> \
  npm run communities:legacy:inventory:verify -- \
  --manifest /absolute/private/communities-manifest.json \
  --baseline /absolute/private/communities-mapping-baseline.json \
  --writer-report /absolute/private/node-red-writer-report.json
```

The verifier writes either a redacted JSON report to standard output or a stable error code to
standard error. It never echoes input paths, schema diagnostics, raw fields or source identifiers.
The report intentionally includes aggregate source-derived counts.

Exit codes:

- `0`: the inventory is structurally consistent; no mutation is authorized;
- `1`: the inputs are valid, but the report contains preservation blockers (`NO_GO`);
- `2`: an input, file safety check, schema, independent pin or writer-report linkage is invalid;
- `3`: verification was inconclusive because of an unexpected internal failure.

Only exit `0` with an empty blocker list may advance to review of a restored-clone import design.
Exit `0` does not authorize creating an importer or connecting this verifier to a live source.

## Evidence to retain

The CLI does not emit evidence metadata. The approved custody/evidence system must independently
capture and bind the redacted report to the manifest raw-byte SHA-256, approved baseline and writer
report raw-byte SHA-256 values, manifest source release/checkpoint reference, exact verifier Git
revision and reviewer decision. Do not derive approved digests from the candidate transfer as part
of the CLI run.

Keep all three inputs only in the storage location and for the retention period named by
the prerequisite evidence record. Follow its destruction procedure when the period expires. Do not
attach any input to GitHub, tickets or chat.

Before any real import, obtain separate authority and prove backup/restore, identity reconciliation,
owner invariants, source-to-destination counts, rating semantics, idempotent rerun and rollback or
forward-fix behavior on a restored clone.

## Node-RED writer inventory

Before generating a real manifest, statically inventory the exact private Node-RED flow export:

```bash
COMMUNITIES_LEGACY_FLOW_SHA256_REQUIRED=<independently-approved-raw-flow-sha256> \
COMMUNITIES_LEGACY_FUNCTION_ALLOWLIST_SHA256_REQUIRED=<independently-approved-function-allowlist-sha256> \
  npm run communities:legacy:writers:verify -- \
  --flow /absolute/private/node-red-flow.json \
  --function-allowlist /absolute/private/reviewed-functions.json
```

The raw-flow SHA-256 must come from an independently controlled export/evidence channel; do not
derive it from the candidate file immediately before this run. The flow file must be a
current-user-owned `0600` regular file no larger than 32 MiB. Treat it as a secret-bearing artifact:
include it in the prerequisite evidence record, keep it only in the approved storage location for
the approved retention period, and never attach it to GitHub, tickets or chat. Export one exact
reviewed graph containing every Communities route plus every linked background/subflow dependency.
The separately approved strict function allowlist must use schema version
`communities-node-red-function-allowlist-v1`, repeat the exact raw-flow SHA-256 and contain the
domain-separated digest of every enabled Function node in that graph. It must be a private `0600`
regular file no larger than 8 MiB. Its raw SHA-256 is a second independent pin: missing, extra or
duplicate function digests are invalid or `NO_GO`. Regex-based direct-driver discovery remains only
an additional signal; the allowlist review is the fail-closed control for computed or indirect
Mongo calls.

The command does not connect to Node-RED or MongoDB and emits only the two pinned SHA-256 values,
aggregate writer counts, reason counts and a digest. Exit `0` means every discovered mutating sink
has a recognized operation, an exact allowed route-to-writer contract and writes one of the ten
preservation collections. Exit `1` is `NO_GO`: unknown operations, collections, sink types,
direct-driver code, ingress ancestry, duplicate handlers or malformed graph edges must be resolved
or explicitly added to the preservation scope. Exit `2` means the file, arguments, SHA pin, JSON or
schema are invalid. Exit `3` means the check is inconclusive because of an unexpected internal
failure. Only exit `0` may populate the manifest writer outcome, source flow SHA-256,
function-allowlist SHA-256, totals and digest; all `NO_GO` graph conditions increase either
`unknown` or `duplicateHandlers`, so the preservation verifier also fails closed.
