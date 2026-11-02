# Exact R1 migration tail108–119

This is a separate migration-only admission on Timeweb `lk2.padlhub.su`, server8886471,
project262717, database `phub_beta`, system identifier `7679125609183186977`.
It neither deploys applications nor changes runtime grants/flags, starts providers, sends
notifications or executes purchases. Migration SQL0105–0115 and historical0103/0104 guards
remain unchanged. Rollback retains the additive schema and journals; database restore or
destructive down migration is a separately reviewed operation.

## Current admission status

`deploy/timeweb/r1-tail108-119.v1.json` fixes all119 SQL byte checksums, exact ledger prefixes108–119,
and conservative5s advisory/5s lock/30s statement/8min process budgets. Unknown inventory,
non-prefix ledger, altered checksum or wrong target is refused.

The checked-in semantic catalog initially has `UNREHEARSED` status. **No forward entry accepts
it.** The existing explicitly owned PostgreSQL16 CI contour registers the additional R1 suite
through one test-only import in `closed-single-migration.pg.test.ts`. Its synthetic artifact is
`.ci-artifacts/test-and-coverage/r1-tail108-119-catalogs.v1.json` within the existing diagnostic
upload. It contains only source-derived catalog fingerprint/count checkpoints, never a live
URL, password, dump, business row or copied production preimage. The export is
`REHEARSED_UNREVIEWED`; independently review it and commit the exact approved catalog as
`REHEARSED_REVIEWED` before source/package admission. CI does not automatically edit trusted
source or grant live authority.

Both `DORMANT` and `SCENARIO_EDITOR_V1` variants have prepared and cleaned owner/ACL states for
every prefix. The serializer reuses existing semantics plus storage, rules, dropped attributes,
lineage and index-storage metadata. New catalog values cannot be supplied in operation JSON.

## Inputs and sequence

The exact new controller source/tree, successful source CI, immutable published migrator index
and amd64 runtime identity are required. Source enrollment is separately scoped against
`50ba9576c2758312917e223b42d5270cebea994e`; unrelated changes, SQL additions and historical
controller-source expansion are refused. Publication builds and enrollment remain separate
reviewed operations. Existing capacity/namespace/backup prerequisites are inherited unchanged.

1. Require exact reconciled subject-link0104 predecessor capsule, plan, role/bootstrap/cleanup
   proofs, stopped successful containers and retained independently restored backups, including
   the0103 chain. This version consumes the strict existing subject-link0104 receipt schema.
   A future predecessor schema/source-family proposal requires explicit narrow compatibility
   review before integration; it is not accepted by weakening this reader.
2. Collect fresh minimized live metadata in approved private custody: exact runtime/PostgreSQL
   identities, secret-file digests, role/membership/default ACL, target, prefix ledger, semantic
   catalog, locks/long transactions and intents/deliveries sizes/counts. This code assumes the
   observed split owners `intents=phub_beta`, `deliveries=phub_migrator`, both RLS/FORCE enabled.
   Seal exact original grantors and intents column REFERENCES; an owner name alone is insufficient.
3. Stage a fixed R1 prefetch request and non-executable pending migration intent at their exact
   operator paths. The migration intent cannot execute before its real backup hashes are filled.
   Prefetch seals intent before the two fixed image pulls. Reconciliation never repeats a pull.
4. Separately authorize the existing namespace backup producer with the prefix-specific R1 schema.
   Its canonical directory includes controller source/CI, prefix and attempt UUID, preventing a
   retry from replacing retained custody. The producer binds the migration intent excluding only
   deferred backup hashes and renewable expiry/confirmation, prefetch proof, source/target,
   ledger and owner/ACL recovery. Require fresh independently restored security and ledger,
   retained dump and reconciled storage cleanup; a dump alone is insufficient.
5. Fill real backup hashes in the final migration operation and renew its20–60min authority.
   The fixed entry in `scripts/r1-tail-migration-runtime.js` accepts only `deploy`/`reconcile`
   with `/opt/phub/timeweb-beta/operator/r1-tail108-119-migration.json`, or
   `prefetch`/`attest-prefetch`/`reconcile-prefetch` with the exact R1 prefetch path. Root, neutral
   Docker/Compose ambient state, clean enrolled source and shared executor custody are required.
   No operation field supplies SQL, executable paths, filenames, budgets or arbitrary callbacks.
6. The controller seals preparation before grants, proves the real migrator role and starts
   exactly one fixed container. It grants only missing fixed schema/column capabilities and
   temporarily transfers intents ownership. Every forward intent has a post-journal freshness
   fence; host effects recheck expiry immediately before their action. SQL, ledger insertion and
   semantic verification commit together for each file. Advisory acquisition and SQL remain bounded;
   errors are redacted to fixed codes. The hard process deadline complements PostgreSQL timeouts.
7. Cleanup restores the exact original intents owner/grantors, runtime DML and column REFERENCES,
   revokes only added privileges, validates cleaned catalog and seals the terminal outcome.
   Success requires exact119, successful stopped immutable container, real-role/cleanup/backup
   proofs and terminal receipt; count119 alone is insufficient.

## Recovery

Never retry a forward command after uncertain SSH/start/wait acknowledgment. Read and reconcile
that same attempt. Reconciliation never creates/starts a migration/probe or repeats a grant.
A running/unobservable container, mismatched custody, mixed catalog/security state or an uncertain
START_INTENT stays UNKNOWN and retains custody.

An exited failed container with exact ledger109–118 is PARTIAL. Earlier commits remain durable;
there is no automatic down/replay. A new exact admitted attempt may resume only its remaining
frozen suffix after validating the old terminal capsule/container/backup and fresh prefix state,
backup/restore freshness and authority. It has a different attempt UUID and its own backup directory.

Lock markers are staged on each destination filesystem, and both inode/stage identities are
persisted before either exclusive shared-name link. PREPARED partial claims can abort without
DB work; terminal partial release removes only the surviving sealed inode/marker and known stage.
Unknown markers/inodes/twins remain untouched. An unpublished stage without a durable identity
record is preserved, never guessed/deleted. Existing exact atomic-twin normalization is reused
only after checking the sealed inode and stage identity.

A lost SUCCESS-file acknowledgment is repaired only from the exact saved terminal receipt after
all immutable proofs validate; it never starts database work again. Cleanup and terminal custody
recovery remain allowed after forward authority expires. Forward execution remains forbidden.

## Evidence boundary

LOCAL unit/mock results, owned-CI PostgreSQL rehearsals, reviewed catalog promotion, target
backup/restore, actual migration and application rollout are distinct evidence. No LOCAL/CI
result in this change proves STAGING, PROVIDER or PRODUCTION execution. Missing live capacity,
predecessor admission, source/catalog publication or private preimages is a real pending gate;
none is bypassed by this mechanism.
