# Notification migration package 0099–0101

Preparation scope: one ordered expand-only package over the existing 102-row ledger through
`0098_support_tickets.sql`. This document, descriptor and diagnostic do **not** authorize apply,
role/ACL changes, controller enrollment, backup execution, publication or deployment.
The frozen Timeweb 99→102 runner and backup schemas remain unchanged and reject this package.

## Immutable inputs and checkpoints

The machine-readable source of package inputs is
[`notification-migrations-0099-0101.v1.json`](../../deploy/timeweb/notification-migrations-0099-0101.v1.json).
The offline validator hashes the complete, sorted SQL catalog, its first 102 entries, each pending
file and every checkpoint. Added, removed, reordered or modified SQL makes this package ineligible;
the package must be reviewed again rather than accepting a mutable current-main catalog.

| Step                                       | SQL checksum SHA-256                                               | Ledger rows | Ledger SHA-256                                                     |
| ------------------------------------------ | ------------------------------------------------------------------ | ----------- | ------------------------------------------------------------------ |
| Before apply, through 0098                 | —                                                                  | 102         | `b9bfd91a3985de51b323d9955325b5edabc22b42cfc350bddebe811ca42c2f85` |
| `0099_local_password_reset_proofs.sql`     | `1669477906e7787aa3a4d457cbb35936cdb26976e536f5d2dddb99076ac23306` | 103         | `30a0e396e35739c66291b7bc3143bb9ac9be584d4732ee01ed0dea82da7339f7` |
| `0100_notification_scenarios.sql`          | `0ce280dd9c3fb348b8247728e2e1096399959752c8ecf10deb7a5f00429d5d5b` | 104         | `e5eacd1ea2514df2abe7d8abd89f1b54e103c8b12a1aacf6b4790622236516d8` |
| `0101_notification_lifecycle_channels.sql` | `426bdec1c96a06dbf60a9815e944226e3ca37e6a0354a22f23ea21517962dcd4` | 105         | `7bd0476427e40967f4531972829a86f578d0e9d844ab9e92f16637b868e207fd` |

Ledger digest is SHA-256 of UTF-8 `JSON.stringify(rows.map(r => [r.filename,r.checksum])) + '\n'`,
with rows ordered by filename. `applied_at` is preserved for existing rows and excluded from this hash.
The final main commit, tree, exact-head CI, publication run, canonical manifest and five immutable
image digests are separate execution inputs, frozen only after source integration. This descriptor
neither substitutes an older publication nor pins a future controller to its own unknown commit.

## Read-only diagnostic

Target: Timeweb `lk2.padlhub.su`, server `8886471`, project `262717`, via the existing Tailscale
management profile. CUP is a separate application at `https://padlhub.su/admin`; LK2's CUP harness
is not that deployment target. Never copy SSH private keys, passwords or database URLs into reports.

Through an already authorized read connection, run
[`notification-migrations-0099-0101-diagnostic.sql`](../../deploy/timeweb/notification-migrations-0099-0101-diagnostic.sql)
with `default_transaction_read_only=on`, `psql -X --no-psqlrc -qAt --set=ON_ERROR_STOP=1` and a
15-second statement timeout. The script also opens a repeatable-read, read-only transaction. Save
the single JSON result locally. It reads catalog metadata and migration checksums, never customer
rows, credentials, password hashes, session contents or environment secrets. Do not obtain new
credentials or widen access to run a diagnostic.

Validate the saved JSON offline from the task checkout:

```sh
node --import tsx scripts/prepare-notification-migration-package.ts \
  --diagnostic /absolute/path/diagnostic.json
```

Exit `2` means known diagnostic blockers. Malformed or unknown inputs throw. A diagnostic older
than five minutes or dated in the future is blocked. Exit `0` means only that these preliminary
diagnostic checks passed: every report still carries `authorizesApply:false`,
`deploymentEligible:false` and explicit execution gaps. This is not the production preflight or
postflight validator. Required parent key definitions/owners are checked, while function default
ACLs are inventoried for review. The tool does not certify the full catalog, memberships or effective object ACLs.

The tool has no database client, SSH subprocess, migration execution, operator request, enrollment
hook, override or import from a live controller. It cannot repair a failed check.

## Observed blockers and proposed role strategy

Read-only snapshot **2026-10-22 13:41:49 UTC**, PostgreSQL 16, exact initial ledger 102:

| Blocker                                 | Observed evidence                                                                                    | Required resolution before any DDL                                                      |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `RESET_DEFAULT_ACL_WOULD_WIDEN_RUNTIME` | `phub_migrator` defaults in `identity` grant `phub_runtime` SELECT/INSERT/UPDATE/DELETE              | The two new reset tables must remain owner-only; no general runtime or PUBLIC access    |
| `DELIVERIES_DDL_OWNER_MISMATCH`         | `notifications.deliveries` belongs to `phub_beta`; `phub_migrator` has no effective owner privileges | A reviewed, explicitly authorized ownership strategy for this exact table               |
| `CAPABILITY_notificationsSchema`        | Missing CREATE and/or USAGE for the migration role                                                   | Read both individual privileges; grant only the missing schema capabilities if approved |
| `CAPABILITY_templatesReferences`        | Missing REFERENCES on `(tenant_id,id)` of `notifications.templates`                                  | Narrow column REFERENCES, with no runtime role change                                   |
| `CAPABILITY_intentsReferences`          | Missing REFERENCES on `(tenant_id,id)` of `notifications.intents`                                    | Narrow column REFERENCES, with no runtime role change                                   |

These facts expire; re-read them before proposing or executing any permission operation. An owner
name alone does not prove lack of ALTER: the diagnostic checks effective owner-role USAGE as well.

Proposed preparation for the next reviewed implementation, **not executable approval**:

1. Keep the new identity tables owner-only. Design a transaction-bound 0099 wrapper that removes
   the inherited runtime table defaults for creation and restores the exact previous defaults
   before commit, while verifying actual reset-table ACLs. Existing identity tables must retain
   their original ACLs. Do not modify the immutable 0099 SQL bytes or expose a partially granted
   table between transactions. Default-ACL mutation needs its own explicit authorization.
2. Grant the migration role only missing `notifications` schema capabilities and the two exact
   composite REFERENCES capabilities. Do not make it a member of the broad `phub_beta` owner role.
3. Prefer a separately reviewed transfer of **only** `notifications.deliveries` to the migration
   owner, with an exact pre/post effective ACL matrix and rollback assessment. This changes live
   ownership and requires explicit authority; this package does not perform or authorize it.
4. Keep all eight new notification tables owner-only at expansion. Later runtime activation needs
   a separate least-privilege grant matrix: mutable scenario tables SELECT/INSERT/UPDATE,
   immutable versions/commands SELECT/INSERT, with no DELETE, PUBLIC or grant option. Reset
   activation uses a distinct trusted reset owner under ADR 0004, never this notification role.

Existing support table defaults are inventoried as a preimage; no support tables are created here.
Function defaults are reviewed per resulting function: the two explicit PUBLIC revocations in
0101 must remain, and the immutable-version trigger function is compared against the exact source
catalog. No blanket default-ACL acceptance substitutes for actual `relacl`, `attacl` and function ACLs.

## Execution sequence after prerequisites are resolved

Follow the existing [Timeweb runbook](timeweb-lk2-beta.md),
[publication custody](timeweb-amd64-image-publication.md) and
[delivery ownership](delivery-batches.md). No second deployment system is introduced here.

1. Approve the concrete role/ACL strategy; implement and review the missing 102→105 controller
   mode and ledger-102 pre-0105 backup/restore schema in the existing engines. No legacy bridge
   allowlist widening. Complete their source and rehearsal checks before freezing a release.
2. Merge that complete reviewed source; freeze one final main SHA/tree with successful exact-head
   full CI. Publish that source once through the canonical workflow, retaining its same-run
   manifest, checksum and five digest-pinned images. Candidate/controller source, tree and CI must
   match. Enroll only with exact live authority. Never build on the target or substitute `latest`.
3. Refresh target SSH fingerprint, runtime identities/digests, restart/start times, ledger and role
   diagnostics. Require exclusive release ownership. An active operation or missing terminal
   receipt belongs to its existing owner: never delete its lock or overwrite its operator request.
4. Create a fresh, verified ledger-102 pre-0105 backup and isolated restore through the reviewed canonical
   engine. Bind receipt to final source, CI, target, database system identifier, Postgres digest,
   source/restored ledger 102 and operation identity. Prove cleanup/custody and maximum age.
   A provider snapshot, historical restore or mere backup-file existence is insufficient.
5. Apply only the exact three SQL files in order, one transaction per file, through the reviewed
   controller. Before start prove the 102 preimage and exact pending set. No automatic retry after
   lost acknowledgement. Capture durable plan/start/success receipts and reconcile actual state.
6. Require exact final ledger 105 and an exact reviewed post-DDL catalog: ten empty FORCE-RLS
   tables, columns/defaults, keys/FKs, 27 indexes, eleven policies, three functions/five triggers,
   eight `NOT VALID` checks including the two delivery fences, and the reviewed owner/ACL
   matrix. Check no `internal_only=true` tickets and no scenario timestamps on old deliveries.
   Row checks require an already approved read verification role; RLS-hidden zero rows are no proof.
7. Only then update API/Worker with the same immutable manifest, preserving old digest rollback
   inputs. Apply 0101 before the new API: support queries use `internal_only` even with scenario
   flags off. Provider configuration, send flags, source polling, scenario enablement and real
   outbound notifications remain off until their own activation gates pass.
8. Verify API/Worker identities, readiness, logs, smoke and soak. Verify the separately deployed
   real CUP in the browser. Merged CUP source alone is not a live UI acceptance result.

## Partial failure and rollback

| Observed exact ledger            | Meaning and recovery                                                                                                                                                        |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 102                              | No package file committed. Reconcile the original container/receipts before deciding on a new attempt. Failed 0099 must leave neither reset table.                          |
| 103                              | 0099 committed; 0100 did not. Keep reset tables and old binaries. Verify exact ledger, owner/ACLs and failed transaction before a separately approved continuation.         |
| 104                              | 0099/0100 committed; 0101 did not. Keep expand schema; do not start the new API/extended Worker. Compare old support checks, visibility column absence and delivery fences. |
| 105                              | All files committed. Verify catalog/ACL/business preimage and the original operation's success proof; acknowledgement loss does not justify running another migrator.       |
| Any other count/checksum/catalog | STOP/UNKNOWN; retain locks/evidence and investigate with the owner. No automatic repair, ledger editing, down migration or blind retry.                                     |

Application rollback restores the captured old API/Worker digests through the reviewed controller
and keeps all additive schema, RLS, privacy guards and ledger rows. Old workers do not discover
new extended work; do not remove those fences. A database restore is a separate destructive data
operation, requiring explicit authority and an assessment of writes after the backup, especially
once new scenario/reset rows exist. Do not drop tables/columns or replay provider sends to recover.

## Rehearsal and evidence limits

The existing CI-only staged test in `packages/database/src/local-password-reset-postgres.test.ts`
uses an owned disposable database and the real `scripts/migrate.ts`. It checks exact 102/103/104/105
hashes; injects wrong-shape collisions into 0099's second table, 0100's fifth table and 0101 after
its initial ALTER statements; proves transactional rollback and unchanged ledger timestamps;
continues in order; preserves synthetic credentials/sessions/support; checks ten empty FORCE-RLS
tables and no internal tickets; and proves a full repeat is a no-op. The existing 9999 rollback
test stays in place. This is transaction evidence, not live role/ACL or restore certification.

Pure tests cover observed ACL/ownership blockers, absent capabilities, malformed/stale diagnostics,
unknown/reordered/duplicate/changed SQL and partial checkpoint handling. Local PostgreSQL tests
remain skipped when the existing CI-only disposable-database guard is not satisfied. Do not forge
CI environment variables to connect to a shared database or provision a new local DB implicitly.

## Closed execution profile for 102→105

The preparation descriptor above remains non-authorizing. The executing profiles live in the
existing engines and use distinct schemas; none broadens the frozen 99→102 bridge:

- `PHUB_TIMEWEB_NOTIFICATION_PRE0105_BACKUP_NAMESPACE_V1` in the existing Python backup controller;
- `PHUB_TIMEWEB_NOTIFICATION_0105_MIGRATION_OPERATION_V1` in the existing migration controller;
- `PHUB_TIMEWEB_API_WORKER_NOTIFICATION_0105_OPERATION_V2` in the existing API/Worker controller.

The reviewed source, controller and canonical publication must have exactly the same SHA/tree/CI.
The operation binds raw package/golden hashes and immutable images from that canonical manifest.
An empty or incomplete golden file is a hard stop before server mutation. Four catalog checkpoints
are generated from the independent mixed-owner CI fixture, reviewed, frozen, and then checked by
both the strict image and host probes. They must never be learned from the live database at apply.

The frozen checkpoints were captured by the successful `quality-full` job's mixed-owner PG16 fixture
in CI run `39817124073`, exact head `5b3a450da600c579866c6a3cf192d5bb906b64b8`, diagnostic artifact
`12441769908` (archive SHA256 `4f310b763881cdb6110ecb4b73f68115260124e3f120f5d133ca44bed27cc84c`).
Its 12 ordered chunks bind compact JSON SHA256
`508c9101751d004c07885f36c454ef46fca65e9a9918d1196b40a38a7ff956b4`; checkpoints 102/103/104/105
contain 26/78/194/248 catalog rows. The same test physically restored full owners/ACLs in isolation.
An independent strict-runner replay against this frozen file remains a required consuming CI check.

The new pre-105 backup uses `backups/<controllerSha>-<sourceCiRunId>-1-notification-pre105`.
It retains a full custom dump including owners and ACLs. In a separate ephemeral PostgreSQL
cluster, an allowlisted role closure is created with NOLOGIN/NOSUPERUSER/NOBYPASSRLS/NOINHERIT
and no memberships. No passwords or global role attributes are copied. Database/language and
trusted-extension prerequisites are reconstructed only inside that cluster; ordinary objects,
ACLs and default privileges restore transactionally. A metadata-only security catalog compares
DB/schema/type/relation/column/function ownership and ACLs, RLS/FORCE, complete policies,
default ACLs and extension/language ownership. Large objects and security labels must be absent.
Source ledger/security are rechecked after dump. Restore success alone is insufficient: the
restored ledger and security catalog must match, and namespace/storage cleanup must be proven.
The immutable receipt binds operation, target, dump, security/role-closure hashes and preimage.
Late consumption rechecks current unit/slice/cgroup and storage absence, not just journal events.

Only after that proof and a sealed capsule/shared ownership locks may the nested fixed bootstrap
run: grant notifications USAGE/CREATE and four column REFERENCES to `phub_migrator`, and transfer
only deliveries ownership. Runtime grants and memberships remain unchanged. The role preflight
rejects incoming and outgoing membership, grant options, altered function defaults, or drift.
The strict image accepts only the exact 105-file source catalog and target database/system ID.
Each SQL file and ledger insert commits in its own transaction; 0099 removes/restores identity
runtime defaults within that same transaction. No reset table is visible with inherited grants.
DDL footprint is bounded at 256 MiB per existing affected relation, and all foreign relation locks
on deliveries/tickets/messages must be absent immediately before migration start. SQL timeouts
remain in force; a concurrent lock race still returns a partial checkpoint requiring reconciliation.

Use the existing fixed entry points and request paths, with the new schema in each request:

```sh
python3 -I /opt/phub/timeweb-beta/operator/tools/<controllerSha>/control-timeweb-database-backup.py \
  --execute /opt/phub/timeweb-beta/operator/database-backup-restore.json
node /opt/phub/timeweb-beta/standard/source/scripts/run-timeweb-standard-delivery.js \
  --critical-api-worker-migration /opt/phub/timeweb-beta/operator/api-worker-migration.json
node /opt/phub/timeweb-beta/standard/source/scripts/run-timeweb-standard-delivery.js \
  --critical-api-worker-migration-reconcile /opt/phub/timeweb-beta/operator/api-worker-migration.json
node /opt/phub/timeweb-beta/standard/source/scripts/run-timeweb-standard-delivery.js \
  --critical-api-worker /opt/phub/timeweb-beta/operator/api-worker-upgrade.json
node /opt/phub/timeweb-beta/standard/source/scripts/run-timeweb-standard-delivery.js \
  --critical-api-worker-reconcile /opt/phub/timeweb-beta/operator/api-worker-upgrade.json
```

A bootstrap lost acknowledgement retains ownership for exact pre/post classification. A migration
start acknowledgement loss never creates a second migration container. Postflight probes may adopt
only the original exact operation/kind/image container; exited nonzero or foreign state stops.
Success requires ledger105, exact golden105, ten owner-only empty FORCE-RLS tables, no scenario
markers/internal tickets, fresh runtime+migrator post-probes and an immutable success receipt.
Reconciliation verifies this evidence before releasing ownership. Checkpoints103/104 do not start
the new API and never trigger automatic down migration.

For a first API/Worker deploy, the enrolled controller validates source CI authority, then creates
only the absent canonical `backups/<candidateSha>-<publicationRunId>-1-api-worker` transaction
directory with exclusive `mkdir`, mode0700, and a parent-directory fsync. The parent and resulting
directory must pass root-only custody checks. An existing path is validated without replacement;
a concurrent creation or fsync/custody failure stops. Recovery/reconciliation never create a
missing transaction. Directory creation supplies neither a backup receipt nor rollout ownership,
and a stopped or ambiguous attempt must not be automatically retried.

The API/Worker profile consumes that terminal reconciled migration proof and its verified pre102
backup. Freshness is required before migration; later application recovery verifies immutable
backup custody without making an old proof appear newly created. It preserves the exact secret
set directory/inode/files/release ID and the actual FCM mount on both image sides. It never
provisions/swaps credentials or changes provider/send/source/staff/reset flags. API and Worker
image refs are separately bound to the same manifest; only inert migrator image metadata advances.
Web and Realtime stay unchanged. Runtime readiness, direct public API/Web probes and the 61-sample/15-minute soak
remain mandatory. Timeweb provider/alert history collection is excluded from this release by the
owner; excluded history is not evidence of passing provider monitoring. Application rollback restores previous image refs and keeps additive schema105.

Forward backup execution, migration and API/Worker deployment require source CI authority before
their first write. The notification-only `--attest-disk` path checks terminal custody locally:
installed helper bytes, inode and Git-object installation proof; exact clean enrolled source,
configuration, package descriptor and golden catalogs; terminal journal, kernel cleanup, receipt,
preimage and dump hashes. It does not query GitHub again during the 61 soak samples or offline
application recovery. This read-only proof neither caches nor grants forward execution authority;
host execution and backup reconciliation keep the full source CI check. Before starting the
networkless PRE105 supervisor, the host seals `SOURCE_AUTHORITY_VERIFIED` in the owned chained
journal, binding the exact request, plan, controller/tree/CI, configuration and helper installation.
Only that supervisor uses local source/tool custody plus this operation-specific handoff; it also
proves its exact unit/process identity. Missing, altered or reordered proof stops before namespace
admission or daemon start. The child never queries GitHub and never populates forward authority.
No operation field, CLI switch or environment option can disable host CI checks. Legacy profiles
retain their behavior. An older operation that failed before the namespace receipt remains owned
and requires separately reviewed exact reconciliation; this change does not adopt or replay it.

The global `/opt/phub/timeweb-beta/operator/database-backup-restore.json` is leased immutable
from creation of the pre102 backup request until the final API/Worker `RECONCILED` receipt,
including gaps between backup, migration and rollout. The exclusive release owner must not prepare,
replace or execute another backup request during this lease. Every migration/rollout/recovery proof
requires byte equality with the canonical `backup-operation.json`; drift stops and retains evidence
and locks. Recovery may restore only those exact canonical bytes under the same exclusive owner,
then reconcile the original operation. It never creates a replacement backup to repair that proof.
The closed predecessor retirement below can terminate only its exact expired, unadmitted lease;
it preserves the old canonical backup and requires a distinct new source/CI and fresh backup.

The notification V2 operation accepts only its V2 plan/receipt and a source-fixed observation
policy. Timeweb provider and alert histories are explicitly `NOT_COLLECTED_OUT_OF_RELEASE`;
no provider readback is consumed, copied, synthesized or reported as passing. Legacy profiles
retain their existing monitoring contract. There is no operator/env switch to bypass evidence.
Before preparation the old API/Worker must be ready and public API/Web probes must pass.
Every one of 61 rounds attests exact candidate API/Worker identity, zero restarts, healthy
containers, private ready JSON, preserved secrets/FCM and database proof, then directly probes
public API ready JSON and the Web app marker. Sixty real waits of 15 seconds and elapsed time
of at least 900 seconds are mandatory; public API/Web p95 limits remain 1500/1000 ms.
The strict observation binds the operation and plan hashes and fixed policy. Its exact bytes/hash
are verified before SUCCESS, at SUCCESS reconciliation and when consuming the installed baseline.
After final lock removal, a repeated V2 reconciliation accepts only the byte-identical request,
capsule, materialized plan/operation and terminal RECONCILED receipt. It reattests runtime and,
for SUCCESS, descriptor/observation/public readiness, then returns the same receipt without writes.
Old V1 notification capsules and provider-shaped evidence are rejected, including offline recovery;
recovery retains the existing previous-image path and never manufactures a successful observation.
The new commercial JOIN/subscription boundary must remain disabled: both env files explicitly
set `SUBSCRIPTION_RUNTIME_WARN_MODE=OFF`, with no commercial owner/subscription runtime material.
An inactive reconciliation route may exist in the current main API; it returns unavailable before
any database/provider write. This release does not activate it or change that feature's contract.
Before preparation, live Web and Realtime images must equal the unchanged digests in the
receipt-verified API8158 descriptor.

The fixed `notification-role-bootstrap-0105-inverse.sql` is a recovery artifact without a live
entrypoint. It is eligible only at exact ledger102 before0099, with unchanged runtime/disabled
transports, owned locks and exact saved bootstrap postimage. It restores only the original five
capabilities in one transaction and must be followed by full saved preimage comparison. It is
forbidden at103/104/105. A destructive production data restore remains a separate explicit action;
never restore pre102 over writes made after cutover as an application rollback.

The role-aware CI test additionally restores a full synthetic pre102 dump with original owner/ACL
metadata in a network-isolated fresh cluster, exercises the fixed bootstrap inverse, and checks
the strict image runner. The older staged SQL test characterizes transaction rollback with owned
fixed SQL steps; the strict role-aware test is the executable 102→105 controller proof. CI evidence
is not a claim that a live backup, migration, CUP rollout or deployment has already occurred.

## One-operation recovery for the 518 pre-admission exit

The immutable `39da03f6c57cf76c2522f374e785203e268ce41d573573c3ba51f2cdd4f5e7a6`
backup stopped after `NAMESPACE_UNIT_START_INTENT`, before its first namespace receipt or dump.
Its original helper cannot reconcile this window. Keep the original request, capsule, twelve
journal events, helper installation, source/config `518be74e` and owned lock unchanged.
Do not repeat execute, recreate the unit, fabricate a receipt or enroll a new controller over it.

The existing backup helper has a separate, closed compatibility entry point for **only** that
operation, plan `01a3e1eba8bd4d5bcaeff5a41c9547c79b6922347cf844ee51011a60296839a5`
and original twelve-event hash. Install the reviewed new helper alongside the old one, using its
normal Git-object/installation proof; do not change the enrolled source/config. A root-owned
0600 `/opt/phub/timeweb-beta/operator/notification-early-exit-recovery.json` binds its own exact
helper commit/file/installation/proof, successful main CI run, original operation/plan, expiry,
`dryRunSha256` and confirmation `RECONCILE_39DA_EARLY_EXIT_KEEP_SOURCE_518_NO_REPLAY`.
Its schema is `PHUB_NOTIFICATION_EARLY_EXIT_RECOVERY_V1`; target remains the fixed Timeweb target.
The initial read-only request may have `dryRunSha256:null`. Before the first execution, bind the
returned hash in a fresh exact request; thereafter retain its identical bytes for all recovery.

Run only after independent review and physical CI rehearsal, through `env -i` with the standard
root Python isolation and installed helper path:

```text
--attest-notification-early-exit /opt/phub/timeweb-beta/operator/notification-early-exit-recovery.json
--reconcile-notification-early-exit /opt/phub/timeweb-beta/operator/notification-early-exit-recovery.json
```

Attestation is read-only and returns `authorizesMutation:false`. It verifies both host IPs,
cleanup tool/kernel custody, both helper/source CI authorities, exact request/plan/initial journal,
owned lock and unchanged container/ledger preimage. It requires empty control inventory, absent
storage/loop/mapper/publication, original host mount baselines, absent unit/job/cgroup, no slice
members and exact owned slice identity. Five frozen structured PID1/systemd records must prove
one exact invocation and argv with exit status 1; a text message or collected unit's default
`Result=success` is insufficient. This classifies `UNIT_EXEC_EXITED_BEFORE_NAMESPACE_RECEIPT`,
without treating a missing child receipt as proof of the precise exception that caused exit.

Execution repeats all checks under the existing process lock and requires the exact dry-run hash
and a request expiry within one hour before the first write. It records a distinct classification,
proves storage absence and unit release, and stops only the exact owned empty slice through the
existing lost-ACK-safe release path. It then records `ABORTED` and `RECONCILED` and releases only
its owned global lock. Every suffix boundary, including marker/empty/removed lock after
`UNLOCK_INTENT`, resumes the identical request without starting any unit, daemon, storage or dump.
The journal and original request/capsule remain preserved. Missing/mutated evidence stops with
ownership retained; no generic operator override or network fallback exists.

After terminal readback, recheck unchanged ledger102/catalog26 and runtime before retiring the
aborted request and enrolling the next source through the reviewed process. A new backup uses a
new operation and fresh authority, never a replay. This recovery does not create a verified
backup, authorize migrations/deployment or permit restoring the business database.

The CI kernel rehearsal uses random transient units/slices and a private fixture directory on
an isolated Linux runner. It checks actual `PrivateNetwork`, trusted exit records and lost ACK
before/after slice stop. Its output explicitly distinguishes that contour from the full recovery
state machine, which uses synthetic files and mocked external observations in the Python suite.

## Expired, unadmitted pre105 release: one closed retirement

The successful backup `7ccbaeb4dc278f84ea76ef4b68b85dd349198cc9103c7e42c9f8b3fb551397a2`
for controller `4e8280deb8a1175732ab4145c80256c85ef4e2c1` and expired migration request
`bfc69d198b153b40bc67ae2ab7522d012064cf80681f3a23cc46f2e15ff906dd` have a separate
terminal metadata transition. This is the only exception to the global request lease above.
It never turns an expired request or stale backup into migration admission. Preserve the complete
old canonical backup directory at its original path, including its operation, receipt and dump;
its receipt remains a truthful recovery record. Do not replay backup execute or migration execute.

Install the reviewed new helper alongside the old one with the normal Git-object installation
proof. Keep the old clean source, configuration and runtime enrolled until retirement is complete.
The old authenticated import closure checks the new helper's successful exact main CI; the new
checkout cannot authorize itself. The fixed root-owned 0600 request is
`operator/notification-pre105-retirement.json`, schema `PHUB_NOTIFICATION_PRE105_RETIREMENT_V1`.
It has exactly `schema`, `target`, `toolCommit`, `toolFileSha256`, `toolProofSha256`,
`toolInstallationSha256`, `controllerSourceCiRunId`, `backupOperationSha256`,
`migrationOperationSha256`, `dryRunSha256`, `expiresAt`, and `confirmation`.
The two operation hashes are the fixed predecessors above; confirmation is
`RETIRE_EXPIRED_UNADMITTED_4E_KEEP_7CC_CANONICAL_BACKUP`. Use the usual isolated root Python
entry with the installed helper and the same fixed request path:

```text
--attest-expired-notification-pre105
--retire-expired-notification-pre105
--attest-retired-notification-pre105
```

The first command is read-only; initially `dryRunSha256` may be null. Before execution, bind the
returned `proofSha256` and freeze the new request bytes. Both existing process locks must be
present and owned; neither command creates a missing lock. Execution reattests successful terminal
backup cleanup and full canonical dump integrity, expired migration schema/bytes, absent migration
transaction and containers, absent active/provision/other operation state, exact ledger102/catalog,
full security/default privileges and unchanged runtime and secret hashes. It rejects any103+
preimage, drift or evidence of migration admission. Its first metadata write requires 20–60 minutes
of request validity; an already sealed exact preparation may reconcile after expiry.

Historical migrator containers are retained when they belong to the exact sealed 7cc container
boundary and separately inspect as exited successfully, with no running, restarting, paused or dead
state and PID zero. Two identical snapshots must agree on full container identities, label-filter
membership and stopped state. The target 4e migration container must remain absent. A foreign
container, label/image/start-time drift or nonzero exit status stops retirement before archive or
unlink; no historical container is removed to satisfy this gate.

A fixed preparation record owns the incoming archive namespace before its directory is created.
The incoming directory gets an exact owner marker, then a durable ready record binds its inode
and marker hash before rename without replacement. Foreign empty directories and mixed
incoming/final state stop. The archive name contains both predecessor hashes. It seals both raw
requests and proof before `RETIRE_INTENT`,
then seals an individual unlink intent and inode identity before each exact active-path unlink,
fsyncs the parent, and records each unlink acknowledgement. Absence is recoverable only behind that
file's owned intent and byte-identical archive. Fixed `.incoming` files resume only exact prefixes;
foreign/mixed state stops without deleting it. The stable proof excludes boot identifiers; continuation reattests the same pre102/runtime facts
without changing a sealed proof after a process or host restart. The terminal receipt truthfully says
`PRE_ADMISSION_EXPIRED_RETIRED`, `canonicalBackupRetained:true`, `databaseMutated:false`, and
`runtimeMutated:false`; it is not a migration ABORTED/SUCCESS receipt. Retain this archive,
preparation, fixed retirement request, old helper/source custody and canonical backup.

Before changing source enrollment, consume and pin the terminal receipt hash in the reviewed
enrollment packet. Recheck unchanged preimage/runtime and absent fixed old requests; do not switch
source over a partial retirement. The archive-aware read-only third command checks canonical
identities and hashes after enrollment changes. The new backup/migration/publication must use the
new independently green source identity, naturally giving a different canonical backup namespace.
No file in the old namespace is moved or overwritten. New publication, enrollment and live stages
retain their separate exact-source authority and current runbook prerequisites.

## Migrator cache before a fresh pre105 backup

After terminal retirement and new source enrollment, prepare the exact migrator image before
starting a new backup freshness window. The fixed root-owned 0600
`operator/notification-migrator-prefetch.json` has exactly:

- `schema:PHUB_NOTIFICATION_MIGRATOR_PREFETCH_V1`;
- `operation`: the normal notification migration schema with the exact new source CI,
  canonical publication/manifest, digest, baseline identities, package/catalog and secret hashes;
- `retirementReceiptSha256`: the reviewed terminal predecessor-retirement receipt hash;
- `confirmation:PREFETCH_NOTIFICATION_MIGRATOR_KEEP_DATABASE_AND_RUNTIME`.

The nested operation supplies immutable publication/runtime metadata. It is not the later
`api-worker-migration.json`: that separate request is frozen after verified backup with a fresh
expiry. All nested fields must match it byte-for-byte semantically except `expiresAt`.
Run the installed standard runner with one of these flags and the fixed prefetch request path:

```text
--critical-notification-migrator-prefetch
--critical-notification-migrator-prefetch-reconcile
```

The stage holds the API/Worker executor lock, requires no active backup/migration/rollout request,
checks fresh source CI/canonical publication, archived backup custody, ledger102/golden preimage,
OFF runtime settings and unchanged secrets/containers. Only this cache stage can pull the single
`linux/amd64` migrator by immutable digest using the existing enrolled registry reader. It never
creates/starts a container, prepares SQL/roles, swaps an env file or alters Docker credentials.
Existing images must remain present. Durable original intent precedes the pull. Reconcile adopts
an already complete strictly inspected image; an incomplete pull may resume only the same digest
with original unexpired request, unchanged inputs and fresh authority. It never mints a new intent
or silently pulls a different candidate.

Evidence lives under root-only `standard/notification-prefetch/<source>-<publication>-1/` as
`intent.json` and `receipt.json`, with fixed exact `.incoming` recovery. The returned proof is
`migratorPrefetch:{requestSha256,receiptSha256,migratorImage,imageId}`. Put these exact four fields
in the new pre105 backup operation. They are preserved in its plan, source-authority journal,
backup receipt and terminal proof. The host reattests the image/receipt before its first backup
write; the networkless supervisor only consumes the sealed handoff. Historical receipts without
this binding remain available for read-only custody; new pre105 forward backup rejects them.
Migration consumption checks the same proof hashes and immutable metadata plus the strict current
image inspection. A cached pull does not relax the backup's one-hour freshness check or request TTL.

For a fully cleaned private namespace, canonical reconciliation requires the original admission,
completed daemon/container/mask/alias cleanup, absent storage/loop and unchanged host mount
baselines, then enters the existing release/publication/unlock tail. It does not re-enter a removed
alias. A stopped notification supervisor does not spawn verifier children that could race the
host's sole-member release check; host full source/tool custody remains required. Existing
uncertain pre-intent journal writes remain owned incident evidence rather than being deleted.

### Existing active Android channel: closed V3 app-only rollout

The V2 rollout remains strict-zero. An already active Android/FCM SANDBOX must use the explicit
`PHUB_TIMEWEB_API_WORKER_NOTIFICATION_0105_OPERATION_V3` profile; never disable tenant/provider
rows merely to pass the old guard. V3 binds a full identity snapshot, drains every matching
SENDING after stopping8158, and starts the new lock-aware Worker behind a candidate-only durable
RO directory gate. See [the bounded V3 protocol](../plans/notification-active-android-rollout.md).

A new source/publication uses `publishedMigratorImage`; `completedMigration` separately binds the
old raw successful migration capsule, executed migrator and verified backup. The read-only proof
consumer rechecks byte-identical SQL/catalog/bootstrap/inverse and current native105 under NEW
source authority. It cannot migrate, restore, restamp or reuse old forward authority. Installed
MIGRATOR_IMAGE_DIGEST stays the actually executed image.

Before GATE_RELEASE_INTENT, candidate remains HELD and rollback restores old8158 with its existing
at-least-once behavior, preserving all leases/outcomes. Nonzero existing SENDING blocks promotion,
not recovery of the old sender. After durable GATE_RELEASE_INTENT, only forward completion is
allowed. A missing/foreign proof or unknown candidate holds the operation without rollback.
The original FIRST pre-restore readback is immutable; every recovery also reads current state.

The installed gate receipt/mount/env/config is a retained runtime dependency. API/Web-only
releases preserve its pointer; future API/Worker recreation of this V3 baseline stops explicitly
until a separate previous-gate protocol is implemented. Never prune the referenced directory or
use base Compose to recreate Worker. This source change grants no live authority; require new
exact source/images/enrollment, current backup and row-count/EXPLAIN/duration evidence before a
new operation. New trigger/lifecycle channels and JOIN remain OFF; legacy FCM traffic may resume
after acceptance. Timeweb history remains outside this release.
