# Communities role-split marker ceremony

Status: **code-only preparation; neither the unwired PG16 library nor the separate host-facing V2
ceremony is installed or authorized to run**.

The repository contains a pure v2 ceremony state machine and an injected-host orchestrator. They
exist to make partial failures, cleanup and idempotency reviewable. Neither module opens PostgreSQL
connections, reads files, invokes Docker, creates or drops a database, writes a database comment,
publishes evidence or changes roles and ACLs by itself. A separately reviewed shell implementation
exists under `deploy/jetson`, but it remains uninstalled and has no forced-command key, workflow or
execution authority.

## State contract

The only valid forward sequence is:

```text
CANDIDATE -> OWNED -> RESTORE_PENDING -> RESTORED -> VERIFIED -> MARKER_PENDING -> MARKED -> EVIDENCED
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
`RESTORE_PENDING` is persisted before invoking restore. A failed or lost restore response always
retains the clone in that phase and never retries restore automatically; an operator must reconcile
the clone before a separately reviewed continuation.
`MARKED` and `EVIDENCED` prohibit automatic clone cleanup. A lost response from the marker write is
reconciled by exact marker readback before any cleanup decision. Evidence is published only after
the marker is read back exactly; evidence failure retains the marked clone and resumes without
rewriting the marker.

The canonical marker and evidence are strict V2. Their payload binds the independently retained
`creationReceiptSha256`; evidence publication and every consumer must prove the same receipt
digest. Marker/evidence V1 is not accepted as a compatibility fallback.

## Current code-only boundary

- `packages/database/src/communities-staging-role-split-marker-ceremony.ts` defines canonical state,
  transitions, recovery and cleanup decisions.
- `apps/migrator/src/communities-staging-role-split-marker-ceremony.ts` orchestrates those decisions
  through an injected interface used only by tests. It has no CLI or build entry.
- `packages/database/src/communities-staging-role-split-inventory.ts` produces deterministic,
  redacted drift artifacts and diffs. Both artifact and diff explicitly declare
  `authorizes.roleSplit/migration/deploy/activation=false`.
- `apps/migrator/src/communities-staging-role-split-marker-ceremony-pg-host.ts` is an injected,
  non-entrypoint PG16 library. It has no CLI, environment parser, SSH command, Docker invocation
  or installation path. It fails closed on unsafe private-state custody and stale leases.
- `deploy/jetson/run-communities-role-split-restore-marker-ceremony.sh` implements an uninstalled
  two-invocation `CREATE`/`RESUME` contour. `CREATE` always stops for an independently retained
  creation receipt; `RESUME` requires its exact SHA-256 before restore and marker work.
- `deploy/jetson/cleanup-communities-role-split-restore-marker-clone.sh` never drops or renames a
  database. It can record only `QUARANTINE_PENDING_RECONCILIATION_REQUIRED` after exact readback.

The PG16 library validates catalog name/OID/owner bindings, PostgreSQL major version,
source/restored ledger equality and archive/evidence/TOC SHA custody. Its restore callback must
consume the already verified archive descriptor, preserve ownership and ACLs, and must never use
`pg_restore --no-owner` or `--no-acl`. It does not attest ACL/RLS correctness. Marker writing and
evidence publication deliberately fail with `CLUSTER_DDL_FENCE_REQUIRED` and
`OWNERSHIP_ACL_ATTESTATION_REQUIRED`; this prevents the existing evidence schema from asserting
unproved `archiveOwnershipAcl=true`. `dropExactClone` always fails with
`AUTOMATIC_DROP_UNAVAILABLE`: PostgreSQL has no safe atomic `DROP DATABASE` by expected OID, so
cleanup is a separate manual reconciliation gate.
The library requires pre-created mode `0700` state storage and private mode `0600` archive copies
owned by its execution uid. It streams archive hashing and binds the exact declared archive byte
count; it never buffers the archive as a whole. This filesystem lease is not yet a runnable
cluster-wide DDL fence: a future forced command must also provide outer process serialization and a
reviewed PostgreSQL advisory-session lease before clone creation or marker writes.

This code does not attest ACL correctness, effective runtime/migrator privileges, tenant RLS or
the provenance of a collected inventory. It does not authorize marker creation, role split,
migration, deployment, import, writes or feature activation.

The separate INPUT_C producer records catalog-derived structured identities and semantic
explicit/effective ACL entries, including redacted grantor evidence and occurrence identity. Its
before/after evaluator is review evidence only and does not authorize the ceremony or any role/ACL
mutation.

## Local disposable PostgreSQL 16 gate

`npm run db:communities-role-split:pg16:verify` owns one uniquely named `postgres:16-alpine`
container, one dedicated labelled bridge network and a random loopback port. It uses a fresh
non-logged SCRAM credential, refuses to pull an image, does not join an application network and
removes only resources whose exact ID, name and disposable label match. The runner creates a
synthetic source database and a same-cluster template clone, then exercises real PG16
catalog/OID/owner/system/ledger bindings, exact marker readback, receipt restart rejection,
deterministic twelve-category INPUT_C production and a no-change acceptance evaluation. Quoted
identifiers, overloaded functions, a sequence, a type, FORCE RLS, a named policy and a trusted
extension member are present in the synthetic catalog.

The local gate found and now regresses two real catalog-wire failures: PostgreSQL `name` union type
resolution truncating ACL JSON, and `aclexplode` rejecting a dimensionless empty ACL array.
Extension-managed objects are represented by the protected `extensions` category instead of being
offered a second time to the ownership/ACL plan; implicit relation and array types are likewise not
independent grant targets.

This is not archive-restore evidence. The clone uses `CREATE DATABASE ... TEMPLATE ...`, the
injected restore callback performs no `pg_restore`, and the marker/evidence used by INPUT_C is a
synthetic local fixture. It does not prove the production CLI connection path, independent artifact
custody, response-loss handling or a cluster-wide DDL fence. It creates no staging/production
database, role, key, request or inventory.

## Required before installation or execution

1. Review the exact installation candidate, root-owned fixed request/state/evidence directories,
   forced-command key and operator-selected connections. Repository presence alone grants no
   installation or execution authority.
2. Complete the concrete ownership-and-ACL-preserving archive restore callback. Do not reuse the
   generic `--no-owner --no-acl` verifier.
3. Complete the remaining PostgreSQL 16 archive-restore tests for owner/ACL preservation, response
   loss, cleanup failure and evidence failure. The local template-clone gate proves catalog/RLS,
   exact comment readback and restart behavior but is not `pg_restore` evidence.
4. Execute the structured `pg_catalog.aclexplode` INPUT_C producer against a separately authorized,
   independently sourced clean clone and independently pin the redacted before/after artifacts. The
   local synthetic producer/evaluator gate is catalog proof, but not trusted staging inventory.
5. Complete independent security and migration review of the real adapter and failure matrix.
6. Obtain separate approvals for installation, forced-command key, one ceremony run and any later
   post-marker cleanup.

Until all six gates pass, do not install the new scripts, create a key, wire a workflow, place
requests on staging or run either ceremony contour. The existing preparation gate must continue to
fail with `EXECUTION_NOT_AUTHORIZED` before PostgreSQL or filesystem mutation.
