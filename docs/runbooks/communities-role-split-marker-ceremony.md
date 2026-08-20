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
- `apps/migrator/src/communities-staging-role-split-pg-restore-runner.ts` is an unwired,
  descriptor-only `pg_restore` library. It takes an already verified archive `FileHandle` as child
  stdin and an already-open private password-file descriptor as child fd 3; the root-owned reviewed
  PostgreSQL 16 executable is already-open on child fd 4 and executed only as `/proc/self/fd/4`.
  It never takes or reopens an archive path, executable path, database URL or password string. Its fixed argv is
  custom-format, `--exit-on-error` and `--single-transaction`, without `--no-owner`, `--no-acl`,
  `--clean`, `--create` or parallel jobs. It checks an injected exact clone/OID/system/PG16/login
  and restore-role preflight before spawn. The future root-owned wrapper, not this FD-only module,
  must open the executable with `O_NOFOLLOW`; this module then SHA-pins the opened fd 4 for both
  version and restore. It uses `shell:false`, allowlisted environment, discarded bounded stderr and a
  SIGTERM/SIGKILL timeout. A failed, timed-out or response-lost process has
  only a stable redacted code; it cannot advance `RESTORE_PENDING`, retry, or drop a clone.

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

The new runner remains deliberately unwired: the current host request does not yet carry an
immutable restore-login/role identity or a reviewed connection factory. Local target-name/OID argv
binding cannot prove that a privileged restore identity cannot write the source database. Before
any live wiring, staging must enforce and attest source denial for that identity at the server
boundary (HBA/`CONNECT`/fixed proxy or equivalent), as well as the exact clone-only connection
factory used by both preflight and `pg_restore`. The future wrapper must open the reviewed
`pg_restore` executable with no-follow semantics, bind its approved SHA-256, and pass that open
descriptor to the runner. Both the version probe and restore execute the same inherited fd 4;
there is no pathname or injectable production seam inside the runner. This executable-custody
check is not authorization to run a ceremony. `--single-transaction` does not remove PostgreSQL
lock-table limits; the mandatory matrix must include a representative archive to establish that
the restore completes within the isolated clone's capacity.
If the runner reports `TERMINATION_UNCONFIRMED`, reconciliation is mandatory: prove both OS process
absence and absence of the exact restore principal/clone session in `pg_stat_activity` before any
further observation. It must never be treated as a retry or cleanup signal.
The preflight connection factory must accept the runner AbortSignal and close its database client on
abort; an unacknowledged cancellation is `PREFLIGHT_TERMINATION_UNCONFIRMED` and blocks all restore.

`apps/migrator/src/communities-staging-role-split-pg-restore-runner.pg.test.ts` is the real,
descriptor-pinned, opt-in Linux PG16 invalid-archive child-process probe. It skips unless the exact confirmation
`PHUB_COMMUNITIES_MARKER_PG16_VERIFY=I_UNDERSTAND_PG16_VERIFY_IS_DISPOSABLE`, separate loopback
`*_verify` source and clone URLs, and an absolute `pg_restore` path are supplied. It queries the
actual clone identity, proves an OID mismatch fails before spawn, then feeds an invalid custom
archive through the descriptor to prove the real child-process nonzero path without restoring
objects. It only checks the source remains reachable afterwards; it does not prove source-write
denial, ownership/ACL/RLS preservation, valid archive restoration, marker writing or cleanup.

This code does not attest ACL correctness, effective runtime/migrator privileges, tenant RLS or
the provenance of a collected inventory. It does not authorize marker creation, role split,
migration, deployment, import, writes or feature activation.

The separate INPUT_C producer records catalog-derived structured identities and semantic
explicit/effective ACL entries, including redacted grantor evidence and occurrence identity. Its
before/after evaluator is review evidence only and does not authorize the ceremony or any role/ACL
mutation.

After `npm run build -w @phub/migrator`, a separate custodian verifies an independently retained
artifact pin without rewriting the artifact:

```sh
node apps/migrator/dist/verify-communities-staging-role-split-inventory-artifact.js \
  --artifact /absolute/root-owned/private/input-c.json \
  --expected-sha256 '<independently-retained-sha256>'
```

The verifier requires a root-owned regular non-link artifact under the existing bounded evidence
reader, rejects non-canonical JSON bytes or a mismatched digest, and emits no raw role, OID or object
identity. It proves only that the caller-supplied pin matched: the report explicitly does not attest
independent custody or clean-clone provenance and remains non-authorizing.

## Local disposable PostgreSQL 16 gate

`npm run db:communities-role-split:pg16:verify` owns one uniquely named `postgres:16-alpine`
container, one dedicated labelled bridge network and a random loopback port. It uses a fresh
non-logged SCRAM credential, refuses to pull an image, does not join an application network and
removes only resources whose exact ID, name and disposable label match. The runner creates a
synthetic source database, writes a private custom-format `pg_dump`, verifies a real
`pg_restore --list`, creates an empty clone from `template0` and restores through
`pg_restore --exit-on-error` using the already custody-checked archive descriptor. The restore does
not use `--no-owner` or `--no-acl` and uses session authorization for archive owner/grantor
semantics. Because PostgreSQL archives extension creation rather than independently dumping every
extension member ACL/owner change, the fixture pre-seeds the exact pinned `pg_trgm` extension
security baseline before restore. The gate then exercises real PG16
catalog/OID/owner/system/ledger bindings, exact marker readback, receipt restart rejection,
deterministic twelve-category INPUT_C production, a separately pinned canonical artifact readback
and a no-change acceptance evaluation. Quoted identifiers, overloaded functions, a sequence, a
type, FORCE RLS, a named policy and a trusted extension member are present in the synthetic catalog.
The disposable test adapter also injects failures after real side effects. It proves that a lost
`pg_restore` response leaves durable `RESTORE_PENDING` state and is not replayed, a failed
pre-marker cleanup retains the exact clone and state, a lost marker response is reconciled through
the real database comment, and evidence failure or response loss resumes through the exact private
evidence file without rewriting the marker or evidence. These are local synthetic tests and do not
enable the corresponding methods on the unwired production host.

Run `npm install` in the exact checkout or worktree before this gate. The runner refuses parent
directory or global Vitest resolution and requires the checkout-local `./node_modules/.bin/vitest`.

The local gate found and now regresses two real catalog-wire failures: PostgreSQL `name` union type
resolution truncating ACL JSON, and `aclexplode` rejecting a dimensionless empty ACL array.
Extension-managed objects are represented by the protected `extensions` category instead of being
offered a second time to the ownership/ACL plan; implicit relation and array types are likewise not
independent grant targets.

This is local synthetic archive-restore evidence, not trusted staging inventory. It proves that the
test adapter preserves the synthetic owners, explicit/effective ACLs, extension state, FORCE RLS,
policies and ledger through real PostgreSQL 16 archive tools. Database creation ownership and the
database-level CONNECT ACL are established separately because a content-only archive does not
create the target database. The extension pre-seed is part of the pinned synthetic fixture and must
not be generalized to a real target until a trusted clean-clone preimage proves the exact installed
extension names, versions, schemas, owners and member security state. The independently pinned
artifact verifier accepts only exact canonical
INPUT_C bytes from a root-owned private file and emits only digests, counts, booleans and false
authorizations. Local generation and verification in one disposable contour do not prove
organizationally independent pin custody, the production CLI connection path, independently sourced
clean-clone provenance or a cluster-wide DDL fence. The gate creates no
staging/production database, role, key, request or inventory.

## Required before installation or execution

1. Review the exact installation candidate, root-owned fixed request/state/evidence directories,
   forced-command key and operator-selected connections. Repository presence alone grants no
   installation or execution authority.
2. Bind the reviewed ownership-and-ACL-preserving restore command to the exact installed ceremony
   candidate only after review of the fixed clone-only connection factory, descriptor custody and
   server-enforced source denial for the restore identity. Do not reuse a generic
   `--no-owner --no-acl` verifier or infer installation authority from the local disposable adapter.
3. Preserve the completed disposable PostgreSQL 16 response-loss, cleanup-failure and
   evidence-publication matrix when reviewing the exact installation adapter. The local matrix
   and custom-archive gate prove the successful synthetic `pg_restore` path, catalog/RLS, exact
   comment readback, restart behavior and injected failure semantics only. The descriptor-pinned
   invalid-archive gate proves only the fail-closed child-process path. Neither grants staging or
   host execution authority.
4. Execute the structured `pg_catalog.aclexplode` INPUT_C producer against a separately authorized,
   independently sourced clean clone and independently pin the redacted before/after artifacts.
   Verify each exact canonical artifact with the separately built
   `verify-communities-staging-role-split-inventory-artifact` CLI and its independently supplied
   SHA-256. The local synthetic producer/evaluator gate is catalog proof, not trusted inventory;
   mock rows are not catalog proof.
5. Complete independent security and migration review of the real adapter and failure matrix.
6. Obtain separate approvals for installation, forced-command key, one ceremony run and any later
   post-marker cleanup.

Until all six gates pass, do not install the new scripts, create a key, wire a workflow, place
requests on staging or run either ceremony contour. The existing preparation gate must continue to
fail with `EXECUTION_NOT_AUTHORIZED` before PostgreSQL or filesystem mutation.
