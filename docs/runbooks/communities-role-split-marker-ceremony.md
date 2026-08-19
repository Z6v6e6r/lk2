# Communities role-split marker ceremony

Status: **code-only preparation; no host adapter, installation or execution authority**.

The repository contains a pure v1 ceremony state machine and an injected-host orchestrator. They
exist to make partial failures, cleanup and idempotency reviewable before a forced command is
implemented. Neither module opens PostgreSQL connections, reads files, invokes Docker, creates or
drops a database, writes a database comment, publishes evidence or changes roles and ACLs by
itself.

## State contract

The only valid forward sequence is:

```text
CANDIDATE -> OWNED -> RESTORED -> VERIFIED -> MARKER_PENDING -> MARKED -> EVIDENCED
```

Every state binds the request SHA-256. `OWNED` and later states bind the exact clone database OID.
`VERIFIED` and later states also bind the canonical marker-payload SHA-256. State transitions must
be persisted by a future host adapter with exclusive create and compare-and-swap semantics. One
execution-wide exclusive lease with a validated fencing token must guard every observation,
side-effect and state write. An ambiguous state-write response retains the clone for reconciliation;
it must never trigger cleanup from the caller's stale phase.

Cleanup is allowed only when all of the following are proven:

- the state is before `MARKED`;
- the clone name and exact recorded OID match;
- authoritative marker/comment presence readback is conclusively absent, regardless of state phase.

An unknown or different clone, marker or evidence result is retained for manual reconciliation.
`MARKED` and `EVIDENCED` prohibit automatic clone cleanup. A lost response from the marker write is
reconciled by exact marker readback before any cleanup decision. Evidence is published only after
the marker is read back exactly; evidence failure retains the marked clone and resumes without
rewriting the marker.

## Current code-only boundary

- `packages/database/src/communities-staging-role-split-marker-ceremony.ts` defines canonical state,
  transitions, recovery and cleanup decisions.
- `apps/migrator/src/communities-staging-role-split-marker-ceremony.ts` orchestrates those decisions
  through an injected interface used only by tests. It has no CLI or build entry.
- `packages/database/src/communities-staging-role-split-inventory.ts` produces deterministic,
  redacted drift artifacts and diffs. Both artifact and diff explicitly declare
  `authorizes.roleSplit/migration/deploy/activation=false`.

This code does not attest ACL correctness, effective runtime/migrator privileges, tenant RLS or
the provenance of a collected inventory. It does not authorize marker creation, role split,
migration, deployment, import, writes or feature activation.

## Required before a runnable forced command

1. Implement a dedicated ownership-and-ACL-preserving PG16 restore adapter. Do not reuse the
   generic `--no-owner --no-acl` verifier.
2. Add root-owned fixed request/state/evidence directories, exact SHA custody and atomic
   exclusive/CAS state persistence.
3. Bind source and clone name/OID/owner/OID, system identifier, active release, archive bytes/SHA/
   TOC, source/restored ledger and installed helper/writer SHA before marker write.
4. Run mandatory PostgreSQL 16 integration tests for owner/ACL/RLS preservation, exact comment
   readback, response loss, cleanup failure, evidence failure and idempotent rerun.
5. Add structured ACL evidence using `pg_catalog.aclexplode`; raw ACL text hashes are drift evidence
   only.
6. Complete independent security and migration review of the real adapter and failure matrix.
7. Obtain separate approvals for installation, forced-command key, one ceremony run and any later
   post-marker cleanup.

Until all seven gates pass, the existing
`deploy/jetson/prepare-communities-role-split-inventory-clone.sh` remains the only host-facing
artifact and must continue to fail with `EXECUTION_NOT_AUTHORIZED` before PostgreSQL or filesystem
mutation.
