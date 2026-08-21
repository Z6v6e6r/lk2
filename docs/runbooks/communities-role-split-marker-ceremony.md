# Communities role-split marker ceremony

Status: **a V3 executable composition and durable restore coordinator now exist as code-only,
unwired modules; the staging host still has only disabled V5 bytes and no ceremony is authorized
to run**.

The repository contains frozen V2 preparation code and a distinct V3 state/authorization contour.
The new composition coordinates injected collaborators only; it contains no environment parser,
SSH command, credential loader or activation path. The installed staging V5 candidate remains
disabled, has no active symlink, forced-command key, workflow or database authority, and does not
contain or authorize the new composition bytes.

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
- `packages/database/src/communities-staging-role-split-restore-execution-descriptor.ts` defines a
  strict canonical V1 `CODE_ONLY_DISABLED` descriptor. It pins the canonical marker-request and
  creation-receipt SHA-256 values, clone OID, loopback-only `sslmode=disable` connection identity,
  same login/restore role name and OID, reviewed `pg_restore` digest, private pgpass basename,
  source-write-denial evidence and bounded timeouts. Every execution, clone, restore, marker,
  evidence, cleanup, role, shared-database, migration, deploy, import and activation authority is
  exactly `false`.
- `packages/database/src/communities-staging-role-split-source-write-denial-attestation.ts` defines
  the strict canonical JSON+LF V1 `SOURCE_CONNECT_DENIED` artifact. It binds the canonical marker
  request, system identifier, PostgreSQL 16, exact source database/owner and a canonical source
  CONNECT-ACL observation hash to the restore principal, canonical membership-observation hash and
  disabled dangerous attributes. The observation artifacts faithfully retain boolean grant/options;
  their binding, rather than their schema, establishes no PUBLIC/principal CONNECT row and no
  membership row. The source owner check and effective CONNECT check are both `false`; connection
  denial occurs before a query with SQLSTATE `42501`. Its SHA-256 is pinned one way by the
  descriptor's `sourceWriteDenialEvidenceSha256`; it deliberately does not hash the descriptor,
  avoiding a circular digest contract. All thirteen authority flags remain exactly `false`, and
  the restore principal OID must differ from the source database owner OID.
- `packages/database/src/communities-staging-role-split-restore-execution-evidence.ts` defines a
  non-authorizing `PREPARATION_ONLY` execution envelope. It observes the one-way request,
  source-write-denial-attestation and descriptor digests plus receipt, clone, system and run
  bindings. It adds no reverse digest edge and keeps execution, state persistence and every other
  authority exactly `false`; it is not marker evidence or an execution command.
- The disabled `CommunitiesStagingRoleSplitRunnerAdapter` path in
  `apps/migrator/src/communities-staging-role-split-runner-adapter.ts` cross-checks the descriptor
  against the canonical request, source-denial attestation, preparation envelope, receipt, clone
  OID and restore-owner binding, then always fails with `EXECUTION_NOT_AUTHORIZED` before it can
  inspect archive/password/executable descriptors, invoke a fence, preflight, spawn `pg_restore`,
  write marker/evidence, or create/drop a clone.
- `packages/database/src/communities-staging-role-split-host-authorization.ts` defines an exact
  canonical V2 twelve-binding host-authorization receipt. Each binding's evidence is itself an
  exact canonical envelope bound to the candidate commit, marker request, creation receipt,
  complete execution subject, binding subject, payload digest and independently reviewed absolute
  custody-path digest. It grants only restore execution, marker write and evidence publication;
  cleanup, role/ACL changes, migration, deploy, import and activation remain false.
- `apps/migrator/src/communities-staging-role-split-host-authorization-loader.ts` accepts the receipt
  only as canonical bytes matching a separately supplied SHA-256. Before returning it, the loader
  reads all twelve distinct evidence files through the existing bounded root-owned, no-follow,
  same-FD custody reader, verifies each canonical envelope and checks its semantic context and
  custody path. Legacy opaque, missing, reordered, aliased, moved, mutable or non-root evidence
  fails before PostgreSQL access.
- `apps/migrator/src/communities-staging-role-split-runner-adapter.ts` retains the old disabled
  descriptor adapter and adds a separate reviewed configuration validator. Its constructor
  cross-binds the loaded authorization, request, creation receipt, clone/OID/login, executable
  digest, connection-factory subject and DDL-fence subject, but `restoreArchive` remains disabled:
  it does not inspect a borrowed lease or call the fence, preflight or FD-pinned runner before V3.
- `apps/migrator/src/communities-staging-role-split-canonical-host-adapter.ts` wraps the durable PG
  host with one execution-wide cluster fence. It validates every filesystem lease, asserts the
  fence before and after each state observation or mutation, routes COMMENT through the pinned
  writer, requires both ownership/ACL/RLS and source-write-denial attestations, and publishes an
  authorization-bound attested envelope only to the separately pinned evidence sink. Recovery
  observations rerun both attestations before accepting exact evidence, so marker-only evidence
  cannot advance state. Marker and evidence response loss retain canonical readback/restart
  semantics without replaying the write; automatic cleanup remains unavailable.
- `apps/migrator/src/communities-staging-role-split-canonical-pg-collaborators.ts` supplies a strict
  loopback clone-only PostgreSQL connection factory, a dedicated-session two-key advisory DDL
  fence and a marker writer composed only with the authorized clone-only connection factory. The
  writer first verifies `current_database`, `session_user`, `current_user`, both role OIDs and the
  system identifier inside the transaction, then holds `ACCESS EXCLUSIVE` on
  `pg_catalog.pg_database`, verifies exact name/OID/owner, writes COMMENT, reads it back and commits.
  The advisory fence is deliberately cooperative and therefore still requires the externally
  reviewed cluster-fence evidence binding; it cannot constrain an unrelated DBA session that does
  not participate in the protocol.
- `apps/migrator/src/communities-staging-role-split-file-evidence-sink.ts` is an independent Linux,
  root-only mode-0700 sink with canonical attested-evidence bytes. It opens the directory once with
  `O_DIRECTORY|O_NOFOLLOW`, performs temporary creation, no-overwrite hard-link installation,
  fsync and readback through `/proc/self/fd/<dirfd>`, then rechecks the configured path and pinned
  inode/mode/owner. It is separate from ceremony state and treats substitution or different
  evidence as a hard failure.
- `packages/database/src/communities-staging-role-split-v3-execution-authorization.ts` defines two
  separate canonical approvals. `CLONE_CREATION_AUTHORIZED` grants only candidate-state
  persistence and clone creation. `EXECUTION_AUTHORIZED` separately binds the exact host and
  durable-restore authorization digests, the exact preceding clone-creation authorization and all
  executable collaborator subjects. The two approvals must share the exact composition,
  state-store and DDL-fence subjects. Continuation grants only state persistence, restore, marker
  write and evidence publication. Neither grants role/ACL, shared-database, migration, deploy,
  import, activation or automatic-cleanup authority.
- `apps/migrator/src/communities-staging-role-split-v3-executable-composition.ts` is the code-only
  two-mode V3 composition. `CREATE` can reach only `OWNED_CONTINUATION_REQUIRED`; it cannot restore
  or mark. `CONTINUE` requires the separate exact execution authorization and drives only the
  canonical forward lifecycle. It refuses durable `RESTORE_PENDING`, reconciles marker response
  loss by exact readback and resumes an already published exact evidence envelope without
  rewriting marker or evidence. At entry it clones and deeply freezes the request and every
  authorization and captures the exact host method references; caller-side mutation or method
  replacement after lease acquisition cannot change the validated execution.
- `apps/migrator/src/communities-staging-role-split-v3-durable-restore-coordinator.ts` implements
  the mandatory restore edge behind the host interface. Under the same injected fence it hashes
  an already-open regular single-link archive, performs the exact `OWNED -> RESTORE_PENDING` CAS,
  creates and consumes a process-local one-shot edge only after that successful CAS, runs the
  pinned adapter, verifies the same device/inode/size/SHA-256 again and performs the exact
  `RESTORE_PENDING -> RESTORED` CAS. Conflict, ambiguous write or lost runner result never retries
  `pg_restore` automatically. Its constructor keeps an internal deeply frozen copy of every
  request, authorization and durable envelope plus bound collaborator method references. The exact
  internal authorization is checked again after the successful pending CAS and immediately before
  runner dispatch.
- `packages/database/src/communities-staging-role-split-v3-attested-evidence.ts` defines a distinct
  V3 evidence V2 envelope bound to the V3 marker evidence, execution- and host-authorization
  digests, ownership/ACL attestation, source-write-denial attestation and independently pinned
  evidence sink. Both attestation subject/evidence pairs must exactly match the current
  context-bound host-authorization bindings; an opaque or replayed digest is rejected. It cannot be
  substituted with the legacy V2 ceremony attested-evidence format or V3 evidence V1 bytes.

Any future live wiring must consume these exact V3 contracts. The existing V2 state, marker and
attested-evidence formats are frozen and cannot be used as a compatibility fallback.

The package-local `communities-staging-role-split-v3-contract` now defines that canonical hash DAG
as code-only preparation. Its V3 `OWNED` state and every later phase require the exact SHA-256 of
the fully cross-bound V1 `PREPARATION_ONLY` restore-execution evidence; the V3 marker payload and
redacted marker evidence carry the same immutable edge. V3 has distinct state, marker prefix,
payload and evidence versions and rejects V1/V2 artifacts rather than converting them. The
contract itself has no side effects and all marker-evidence authority flags remain false. State
persistence and restore are available only through the separately pinned authorizations and
injected code-only composition described above; defining or importing the V3 bytes does not grant
either authority.

The V3 preparation envelope is pure contract code only. It has no persistence, lease, fence, clone
transition, PG, archive, runner, marker or evidence-publication API; all authorization fields are
false, including state persistence, clone/restore, marker/evidence, cleanup and every role, schema,
deploy, import or activation authority. It accepts only `CANDIDATE`, `OWNED` and
`RESTORE_PENDING`, rejects V2 bytes rather than converting or adapting them, and treats its optional
immutable execution-evidence binding as descriptive only. This is not an installation, forced
command, workflow, restore, cleanup or activation.

The V2 host-authorization receipt can describe a reviewed restore contour, but it is not sufficient
execution authority. The additional canonical V3 restore authorization binds the exact
`RESTORE_PENDING` preparation-envelope digest, request, creation receipt, source-denial evidence,
clone OID, system identifier, candidate commit and V2 host-authorization digest. It authorizes only
`restoreExecution`; state persistence, clone creation, marker/evidence writes, cleanup, role/ACL
changes, migration, deploy, import and activation remain false.

`CommunitiesStagingRoleSplitReviewedRunnerAdapter.restoreArchive` remains disabled and continues to
fail with `V3_DURABLE_EXECUTION_CAPABILITY_REQUIRED`; it is not silently upgraded into an execution
path. The new durable coordinator owns the distinct post-CAS one-shot edge and invokes only its
separately pinned runner collaborator. Durable `RESTORE_PENDING` bytes remain non-executable on
restart, response loss or concurrent replay. No installer manifest, forced command, workflow or
CLI currently contains the new composition or either execution authorization. A post-restore
attestation is not a substitute for the pre-restore gate.

## V3 durable restore contract and code-only coordinator

`communities-staging-role-split-v3-durable-state-envelope-v1` is a strict canonical JSON+LF
envelope for only `OWNED`, `RESTORE_PENDING` and `RESTORED`. It binds the request, creation receipt,
restore-execution evidence, clone OID and the exact V3 state without modifying the frozen V2 or
existing V3 preparation formats. `communities-staging-role-split-v3-durable-restore-authorization-v1`
binds the existing V3 restore authorization and V2 host authorization digests, all three one-way
durable-envelope digests, request/receipt/evidence/clone/system/commit bindings and independently
pinned durable-host, state-store and archive-custody subjects. It grants only state persistence and
restore execution; clone creation, markers, evidence, cleanup, roles, shared-database mutation,
migration, deploy, import and activation remain false. The validator accepts only the exact forward
`OWNED -> RESTORE_PENDING -> RESTORED` sequence; no envelope points back to this authorization.

The durable envelopes remain pure bytes. The new coordinator can consume them only through an
injected CAS store, held fence, archive-custody subject and runner whose exact digests are bound by
the separate execution authorization. There is still no environment parser, forced command,
installation target or workflow that supplies those collaborators. The PG16 library validates catalog
name/OID/owner bindings, PostgreSQL major version, source/restored ledger equality and
archive/evidence/TOC SHA custody. Its restore callback must consume the already verified archive
descriptor, preserve ownership and ACLs, and must never use `pg_restore --no-owner` or `--no-acl`.
The unwrapped PG host does not attest ACL/RLS correctness. Its marker write and evidence publication
continue to fail with `CLUSTER_DDL_FENCE_REQUIRED` and `OWNERSHIP_ACL_ATTESTATION_REQUIRED`; only
the separately authorized canonical wrapper can route those operations through the reviewed
collaborators. `dropExactClone` always fails with
`AUTOMATIC_DROP_UNAVAILABLE`: PostgreSQL has no safe atomic `DROP DATABASE` by expected OID, so
cleanup is a separate manual reconciliation gate.
The library requires pre-created mode `0700` state storage and private mode `0600` archive copies
owned by its execution uid. It streams archive hashing and binds the exact declared archive byte
count; it never buffers the archive as a whole. This filesystem lease is not yet a runnable
cluster-wide DDL fence: a future forced command must also provide outer process serialization and a
reviewed PostgreSQL advisory-session lease before clone creation or marker writes.

## V3 durable continuation contract-only prerequisite

`communities-staging-role-split-v3-durable-continuation-envelope-v2` is a separate strict
canonical JSON+LF codec for the post-restore `VERIFIED -> MARKER_PENDING -> MARKED -> EVIDENCED`
sequence. It begins only from the exact digest of the existing durable `RESTORED` V1 envelope and
each envelope points one way to the previous canonical digest. Every phase repeats the immutable
request, receipt, restore-evidence and clone-OID bindings, carries the exact V3 state and one
V3 marker payload/marker pair. `VERIFIED` and `MARKER_PENDING` carry no evidence; `MARKED` and
`EVIDENCED` require the same exact V3 marker-evidence bytes. Only `EVIDENCED` also carries the
SHA-256 of the complete V3 attested-evidence bytes, so the durable terminal state cannot be
reopened with marker-only evidence.

This codec does not validate a catalog/ACL/RLS attestation, INPUT_C, an evidence-sink namespace or
any authority. It does not create state, acquire a fence, write a marker, publish evidence, access
the filesystem or database, call a runner, or provide a host, CLI, installer, workflow or forced
command. Those executable operations remain separately designed, authorized and independently
reviewed gates. This codec does not complete item 2 in the required-before-installation-and-
execution list: it supplies no V3 executable composition, response-loss reconciliation, clone-only
connection factory, source-denial proof or ownership/ACL/RLS attestation.

## V3 durable continuation host (code-only, unwired)

`apps/migrator/src/communities-staging-role-split-v3-durable-continuation-host.ts` is the separate
injected host for the post-restore half only. It refuses candidate creation, clone creation and
restore. It accepts only the exact persisted `RESTORED` durable envelope, acquires the reviewed DDL
fence before the private filesystem lease, and releases filesystem then DDL on every exit. Every
state read, CAS recovery read, observation and injected side effect is fenced before and after.

The host creates no durable authorization token. Its marker capability exists solely in memory
after this invocation has successfully persisted `VERIFIED -> MARKER_PENDING`; it is consumed
before dispatch. A restarted `MARKER_PENDING` host therefore reconciles only the authoritative
marker observation and cannot replay a marker write. Similarly, an evidence-publication capability
is minted only after the same invocation observes the exact V3 attested evidence as absent and is
consumed before publishing. The exact complete attested-evidence digest is persisted in the
`EVIDENCED` envelope after exact readback and is rechecked before any evidence-sink observation on
restart. Lost side-effect responses are reconciled from exact readback; absent, different or
unknown results retain the state for manual reconciliation.

The host deep-freezes authoritative structured inputs and captures collaborator methods during
construction, validates the execution-authorization digest, component subjects and canonical host
adapter subject, and has no PostgreSQL, SSH, filesystem installation, environment parsing or
workflow wiring of its own. It is not an authorization to run a ceremony, migrate, deploy, activate
or clean up a clone. A future exact installation candidate remains subject to independent security
and PostgreSQL review, staging authorization and a separately approved ceremony run.

The full-chain semantic validator additionally requires the exact V3 restore-execution binding and
matches its request, receipt, execution-evidence, clone-OID and system-identifier facts before it
accepts any continuation state. This detects a self-consistent continuation artifact from another
restore context, but still does not prove archive custody, runtime authority or an executable gate.

The reviewed runner and canonical adapter remain deliberately unwired. The authorization receipt
can describe immutable restore-login/role and connection-factory bindings, but code cannot invent
their staging values or prove that a privileged identity cannot write the source database. Before
any live wiring, staging must enforce and independently attest source denial for that identity at
the server boundary (HBA/`CONNECT`/fixed proxy or equivalent). The host wrapper must open the
reviewed `pg_restore` executable with no-follow semantics, bind its approved SHA-256, and pass that open
descriptor to the runner. Both the version probe and restore execute the same inherited fd 4;
there is no pathname or injectable production seam inside the runner. This executable-custody
check is not authorization to run a ceremony. `--single-transaction` does not remove PostgreSQL
lock-table limits; the mandatory matrix must include a representative archive to establish that
the restore completes within the isolated clone's capacity.
If the runner reports `TERMINATION_UNCONFIRMED`, reconciliation is mandatory: prove both OS process
absence and absence of the exact restore principal/clone session in `pg_stat_activity` before any
further observation. It must never be treated as a retry or cleanup signal.
The clone-only preflight connection factory accepts only an exact loopback URL for the clone and
dedicated restore login. It accepts the runner AbortSignal and closes its database client on
abort; an unacknowledged cancellation is `PREFLIGHT_TERMINATION_UNCONFIRMED` and blocks all restore.

The following remain external hard gates and are not satisfied by this code checkpoint:

- an atomic, separately reviewed root-owned backup custody handoff from the producer's private
  `0700/0600` contour into the ceremony's `0750/0440` contour, without changing the producer copy;
- a dedicated forced-command public key and an independently pinned staging `known_hosts` entry;
- operator-selected source and clone connections, the exact restore login/OID and reviewed
  root-owned `pg_restore` executable digest;
- actual source-write-denial and ownership/ACL/RLS attestation artifacts produced from the exact
  retained archive and clone;
- the twelve root-owned evidence files plus a separately retained authorization-receipt SHA-256;
- independent security/PostgreSQL review of the code-only V3 composition and a later exact
  execution-authorizing installation candidate that contains it.

Until all of them exist and a later candidate explicitly verifies them, V3 may install only its
disabled versioned bytes. It remains non-authorizing for execution and every database operation.

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

## Root-custody trusted-inventory preparation

`communities-staging-role-split-inventory-preparation-v1` is a code-only, disabled envelope for
preparing one future `BEFORE` or `AFTER` INPUT_C collection. It binds the candidate commit, exact
request/receipt/clone/source/cluster identity, planned output-path digest and eight ordered evidence
files: marker request, marker evidence, private role mapping, independent-source provenance,
connection descriptor, credential custody, executable custody and output custody. Each binding
contains only its stable code plus the SHA-256 of the absolute path and exact bytes.

`verify-communities-staging-role-split-inventory-preparation` accepts the envelope only from a
root-owned, single-link, non-group/other-writable file matching an independently retained SHA-256.
It validates all absolute paths and path uniqueness before evidence access, parses and pins the
canonical envelope before reading the other files, then reads every evidence file with the bounded
no-follow same-inode reader. It validates the V2 marker request/evidence relationship and private
mapping shape, while treating the other five evidence payloads as externally reviewed opaque
claims. It never reads a database credential, opens a PostgreSQL connection, creates the output
artifact or changes a role/ACL.

After building `@phub/migrator`, the preparation-only command shape is:

```sh
node apps/migrator/dist/verify-communities-staging-role-split-inventory-preparation.js \
  --preparation '<root-owned-preparation-envelope>' \
  --preparation-sha256 '<independently-retained-sha256>' \
  --marker-request '<root-owned-marker-request>' \
  --marker-evidence '<root-owned-marker-evidence>' \
  --role-mapping '<root-owned-private-role-mapping>' \
  --independent-source-provenance '<root-owned-independent-source-evidence>' \
  --connection-descriptor '<root-owned-connection-descriptor-evidence>' \
  --credential-custody '<root-owned-credential-custody-evidence>' \
  --executable-custody '<root-owned-executable-custody-evidence>' \
  --output-custody '<root-owned-output-custody-evidence>' \
  --output-artifact '<planned-absent-output-path>'
```

Success is only `PREPARATION_VERIFIED_REVIEW_ONLY`. The report emits digests, binding booleans,
explicit non-attestation limitations and false authorizations. It cannot designate an inventory as
trusted or authorize connection, read, artifact write, role/ACL mutation, migration, deploy or
activation. It also does not attest parent-directory custody or that the planned output path is
absent. A later separately reviewed execution design must define the credential FD, pinned output
directory, exclusive root-owned output publication, timeout/cancellation, connection read-only
enforcement and exact readback receipt before any inventory collection can be authorized.

## Independently pinned acceptance artifact gate

`apps/migrator/src/verify-communities-role-split-acceptance-artifact.ts` is the local, read-only
bridge between separately retained candidate INPUT_C artifacts and any future executable V3 design.
It accepts only four root-owned, single-link, non-group/other-writable files: the exact canonical
acceptance envelope, the separately retained canonical before and after INPUT_C artifacts, and a
canonical pins artifact. A separately supplied SHA-256 binds the complete pins artifact; that
artifact in turn binds the acceptance envelope, both INPUT_C artifacts and manifests, the mapping,
marker, marker evidence, request, creation receipt, object manifest and ledger.

The verifier requires the envelope's embedded before/after snapshots to be byte-identical to the
external INPUT_C artifacts and runs the authoritative cross-field acceptance evaluator. Its output
contains only digests, comparison counts, true binding booleans, explicit external-review
limitations and false authorizations. `ACCEPTANCE_PASS_REVIEW_ONLY` is not a trusted-inventory
designation and does not authorize an execution candidate, key, ceremony or database mutation.
Independent custody, independently sourced clean-clone provenance and the DBA role matrix remain
external evidence gates.

After building `@phub/migrator`, the command shape is:

```sh
node apps/migrator/dist/verify-communities-role-split-acceptance-artifact.js \
  --envelope '<root-owned-acceptance-envelope>' \
  --before '<root-owned-before-input-c>' \
  --after '<root-owned-after-input-c>' \
  --pins '<root-owned-acceptance-pins>' \
  --pins-sha256 '<independently-retained-pins-sha256>'
```

The verifier performs no PostgreSQL, SSH, Docker, filesystem mutation, role/ACL change, migration,
deploy or activation. An invalid, noncanonical, unpinned, cross-boundary or incomplete artifact
fails with one fixed public error.

## Exact disabled installable candidate

`scripts/prepare-communities-role-split-installation-candidate.ts` now builds and verifies a
private, deterministic V7 candidate directory from an independently supplied exact Git commit. It
reads every artifact from Git objects rather than the mutable worktree, validates each expected Git
mode, disables Git replacement objects, rejects any replacement ref and requires the raw local repository origin
to be exactly `https://github.com/Z6v6e6r/lk2.git`, refuses an existing output, and accepts only a
private mode-0700 parent owned by the invoking user. Every candidate file is mode 0600 and
single-link. Verification requires the same independently supplied commit and rejects changed,
missing, additional, linked or non-canonical bytes.

The candidate is `status=INSTALLABLE_DISABLED` and `installable=true`, but installation is its only
true authorization. It contains:

- a dependency-free root installer/verifier;
- an installed command that always emits `COMMUNITIES_ROLE_SPLIT_EXECUTION_NOT_AUTHORIZED` and
  exits nonzero without reading input or touching PostgreSQL;
- mode-0444 exact source snapshots of the reviewed canonical host adapter, clone-only connection
  factory, DDL fence, marker writer, evidence sink, authorization loader, runner and root-owned
  evidence reader;
- three additional mode-0444 source snapshots for the canonical inventory-preparation contract,
  its verifier and its CLI. They are deliberately unwired and non-runnable: the candidate contains
  no Node runtime, compiled bundle, credential, preparation envelope or evidence payload.
- twelve additional mode-0444 source snapshots for the reviewed V3 durable host, continuation
  host, restore coordinator, executable composition, state/continuation/authorization envelopes
  and host-bound attested evidence. These
  are code-only review bytes: the candidate still has no compiled entrypoint, concrete restore
  executor, DDL-fence lease wiring or runtime loader.

The host entrypoint is a POSIX shell program bound to the exact GNU coreutils paths present on the
ARM64 staging node; `/usr/bin/node` is not required. Its file-count validation uses shell numeric
matching rather than AWK character classes because the staging host provides legacy `mawk 1.3.3`,
which rejects otherwise valid `[[:space:]]` and `[[:digit:]]` expressions. The canonical control
ledger is independently pinned and binds the fixed artifact paths, target-relative paths, modes,
byte counts, SHA-256 values and false execution authorizations. The shell verifier reconstructs
the complete canonical JSON bytes from that fixed policy and the exact control records, then
requires its SHA-256 to equal both the supplied pin and the candidate file digest. A freshly pinned
authorization change, added field or V6 downgrade therefore fails before target creation.
The V7 installed readback requires exactly twenty-five controlled artifacts plus the source
directory and immutable receipt (`27` entries total); both install and verify loops require an
exact count of twenty-five control records. The fifth controlled artifact is the immutable shared
DDL-fence source. The host-control version is V4 so a V6 allowlist cannot be accepted with freshly
pinned V7 digests.
The installer accepts independently retained manifest, control and artifact-set SHA-256 values. It installs
only a previously absent version directory below
`/usr/local/libexec/phub/communities-role-split/candidates/<commit>`, refuses an existing target or
an abandoned `.incomplete` directory, verifies post-copy hashes, fsyncs before publication and
writes an exact `INSTALLED_DISABLED` receipt. It creates no current/active symlink, configuration,
request/state directory, credential, key or `authorized_keys` entry. A partial failure is retained
for manual reconciliation and is never deleted or overwritten automatically.

The manifest still contains no forced command (`command=null`, `commandIncluded=false`), public key,
cleanup exposure, workflow wiring, staging connection or runtime configuration. Key provisioning,
staging access, database mutation, ceremony, cleanup, role split, migration, deploy and activation
are all false. The twelve host-binding codes remain `REQUIRED_FOR_EXECUTION`; their evidence is not
needed to install disabled bytes, but no installed artifact can consume or replace that evidence.
Changing any of those authorizations requires a new reviewed candidate version.

After a checkpoint commit, build and verify only in a fresh private local directory:

```sh
candidate_review_root=$(mktemp -d)
npm run db:communities-role-split:installation-candidate -- build \
  --repository "$PWD" \
  --candidate-sha '<checkpoint-sha>' \
  --output "$candidate_review_root/communities-role-split-installation-candidate-<checkpoint-sha>"
npm run db:communities-role-split:installation-candidate -- verify \
  --repository "$PWD" \
  --candidate-sha '<checkpoint-sha>' \
  --candidate "$candidate_review_root/communities-role-split-installation-candidate-<checkpoint-sha>"
```

Both success lines contain only the commit, manifest digest, control digest, artifact-set digest,
`installable=true`, `authorizes_installation=true` and `authorizes_ceremony=false`. Build and verify
perform no installation, SSH, Docker, PostgreSQL, network or staging operation. A local
`.incomplete` directory is retained after an interrupted build for manual inspection; the tool
never deletes or replaces it automatically.

Installation is a later, separately approved host gate. Before invoking the candidate installer,
the administrator must transfer the already verified candidate into a root-owned mode-0700
directory with mode-0600 single-link files and independently retain the three digests from the local
verification result. The later command shape is:

```sh
sudo -- /bin/sh \
  '<root-owned-candidate>/payload/installer.sh' install \
  --candidate '<root-owned-candidate>' \
  --candidate-sha '<checkpoint-sha>' \
  --manifest-sha256 '<independently-retained-manifest-sha256>' \
  --control-sha256 '<independently-retained-control-sha256>' \
  --artifact-set-sha256 '<independently-retained-artifact-set-sha256>'
```

The read-only post-check uses the same exact arguments with `verify`. It must also execute the
versioned `disabled-command.sh` and observe exit 78 with the single fixed denial line. Neither
command authorizes or runs the ceremony.

## V3 durable preparation boundary

`apps/migrator/src/communities-staging-role-split-v3-durable-host.ts` is an unwired library-only
boundary. It validates the merged durable authorization and all three exact V3 state envelopes,
then acquires the existing cluster DDL fence before a private filesystem lease. It refuses the V2
`ceremony.lock` and artifact namespace, persists only canonical exact bytes through
`OWNED -> RESTORE_PENDING`, fsyncs and reads back each boundary, and asks an injected custody
collaborator to attest the archive before minting an opaque one-shot capability.

The capability now has a single same-host consumer. `restore(capability)` accepts only the exact
WeakMap-owned capability, rechecks the shared DDL fence, exact `RESTORE_PENDING` bytes and archive
custody before invoking an independently SHA-bound executor, then rechecks the fence and archive
before the one allowed `RESTORE_PENDING -> RESTORED` CAS. Exact response-loss readback may complete
only within that same invocation; any other outcome retains the durable ambiguity boundary and the
capability cannot be reused. An executor rejection is always treated as outcome-ambiguous, never as
proof that no restore occurred. Cleanup remains archive, filesystem lease, then DDL fence.
After executor dispatch and before exact `RESTORED` confirmation, every failure remains
`RESTORE_OUTCOME_AMBIGUOUS`; if cleanup also fails, the same stable error retains
`cleanupIncomplete=true` rather than hiding the restore ambiguity. A cleanup-only failure after
exact `RESTORED` confirmation remains `CLEANUP_INCOMPLETE`.

`apps/migrator/src/communities-staging-role-split-v3-pg-restore-executor.ts` is a separate,
unwired descriptor bridge. It consumes only exact canonical `RESTORE_PENDING` bytes, an already
held external DDL-fence lease and three pairwise-distinct borrowed descriptors (by FD and by
device/inode). Its independently
retained execution-authorization digest binds the bridge subject to `runnerAdapterSha256` (not the
canonical-host adapter), validates the clone-creation/host/durable authorization DAG, verifies the
archive descriptor's device, inode, size and SHA-256 before and after dispatch, and never closes a
borrowed descriptor or acquires/releases the supplied fence. Once dispatch begins, every runner,
fence, output, response-loss or archive-observation failure is `RESTORE_OUTCOME_AMBIGUOUS` and the
instance cannot be reused.

This remains review-only code: the reviewed runner adapter still returns
`V3_DURABLE_EXECUTION_CAPABILITY_REQUIRED`, and there is no command, executable-composition import,
installer snapshot, workflow, environment, key, SSH, Docker or PostgreSQL entrypoint for the new
bridge. It therefore neither makes a restore runnable nor changes the existing disabled candidate.

## Remaining gates before execution

1. The exact disabled V5 candidate at commit
   `55655760a4dee1ab0a614cf464ad9d2b68bbf8c0` has been installed and its disabled readback passed.
   It contains no active link and grants no execution or database authority. It predates and does
   not contain the new V3 composition.
2. The independent re-review of the exact V3 security-fix range completed with no reportable P0-P2
   findings. V3 evidence V2 binds both attestations to the exact host authorization, and the
   composition/coordinator retain immutable entry snapshots. V6 packages those reviewed sources
   only as disabled mode-0444 bytes and adds no key, workflow or live configuration. Do not reuse
   the legacy V2 marker/attested-evidence contour, V3 evidence V1 or the permanently disabled
   reviewed-runner path as a compatibility fallback.
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
5. Complete independent security and migration review of the final executor bridge, any later
   installed adapter/candidate manifest, and the failure matrix. A review-only bridge is not an
   installable or execution-authorizing artifact.
6. Obtain separate approvals, in order, for the new disabled installation, execution-authorizing
   candidate, forced-command key, one ceremony run and any later post-marker cleanup.

Until items 2-6 pass, do not create a key, wire a workflow, place requests on staging or run either
ceremony contour. The currently installed V5 command and existing preparation gate must continue
to fail with `EXECUTION_NOT_AUTHORIZED` before PostgreSQL or mutable ceremony filesystem access.
