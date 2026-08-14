# Communities legacy preservation inventory

## Status and boundary

This procedure validates a redacted, single-tenant Communities inventory offline. It never reads
MongoDB or PostgreSQL, never runs a migration and never writes business data.

An `INVENTORY_STRUCTURALLY_CONSISTENT` result means only that the supplied inventory is internally
consistent with a separately approved mapping baseline. It always returns
`activationReady=false` and `authorizesMutation=false`. It is not approval for import, cutover,
commands, media, invites, realtime or production promotion.

## Required inputs

Prepare three independently controlled values:

1. An absolute path to a private (`0600`), current-user-owned regular JSON manifest.
2. An absolute path to a private (`0600`), current-user-owned regular JSON mapping baseline.
3. The lowercase SHA-256 of the exact approved baseline bytes, recorded through a channel separate
   from the candidate manifest and baseline transfer.

The approved SHA-256 must not be calculated from the candidate baseline immediately before running
the verifier. Doing that would remove the independent mapping trust boundary. Do not place raw
identities, phone numbers, names, tokens or source database credentials in either file.

The manifest and baseline contain pseudonymous data. Do not run the verifier until an approved
evidence record identifies the storage location, access owner, permitted operators, retention
period and destruction procedure for both inputs and the resulting report. Reference that evidence
record in the review; this repository does not define or approve the retention policy.

The manifest is limited to 32 MiB and the baseline to 64 KiB. Symbolic links, non-regular files,
foreign ownership and group/other permissions are rejected. Use an outer process deadline when the
files are stored on a remote or FUSE filesystem.

## Offline verification

Run from the repository root with the separately recorded digest supplied through the environment:

```bash
COMMUNITIES_LEGACY_BASELINE_SHA256_REQUIRED=<approved-lowercase-sha256> \
  npm run communities:legacy:inventory:verify -- \
  --manifest /absolute/private/communities-manifest.json \
  --baseline /absolute/private/communities-mapping-baseline.json
```

The verifier writes either a redacted JSON report to standard output or a stable error code to
standard error. It never echoes input paths, schema diagnostics, raw fields or source identifiers.
The report intentionally includes aggregate source-derived counts.

Exit codes:

- `0`: the inventory is structurally consistent; no mutation is authorized;
- `1`: the inputs are valid, but the report contains preservation blockers (`NO_GO`);
- `2`: the input, file safety, schema or independent baseline pin is invalid;
- `3`: verification was inconclusive because of an unexpected internal failure.

Only exit `0` with an empty blocker list may advance to review of a restored-clone import design.
Exit `0` does not authorize creating an importer or connecting this verifier to a live source.

## Evidence to retain

The CLI does not emit evidence metadata. The approved custody/evidence system must independently
capture and bind the redacted report to the manifest raw-byte SHA-256, approved baseline raw-byte
SHA-256, manifest source release/checkpoint reference, exact verifier Git revision and reviewer
decision. Do not derive the approved baseline digest from the candidate transfer as part of the CLI
run.

Keep the manifest and baseline only in the storage location and for the retention period named by
the prerequisite evidence record. Follow its destruction procedure when the period expires. Do not
attach either input to GitHub, tickets or chat.

Before any real import, obtain separate authority and prove backup/restore, identity reconciliation,
owner invariants, source-to-destination counts, rating semantics, idempotent rerun and rollback or
forward-fix behavior on a restored clone.
