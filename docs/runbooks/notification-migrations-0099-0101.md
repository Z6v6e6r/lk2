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
- `PHUB_TIMEWEB_API_WORKER_NOTIFICATION_0105_OPERATION_V1` in the existing API/Worker controller.

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

The API/Worker profile consumes that terminal reconciled migration proof and its verified pre102
backup. Freshness is required before migration; later application recovery verifies immutable
backup custody without making an old proof appear newly created. It preserves the exact secret
set directory/inode/files/release ID and the actual FCM mount on both image sides. It never
provisions/swaps credentials or changes provider/send/source/staff/reset flags. API and Worker
image refs are separately bound to the same manifest; only inert migrator image metadata advances.
Web and Realtime stay unchanged. The existing monitoring, readiness and 61-sample/15-minute soak
remain mandatory. Application rollback restores previous image refs and keeps additive schema105.

The global `/opt/phub/timeweb-beta/operator/database-backup-restore.json` is leased immutable
from creation of the pre102 backup request until the final API/Worker `RECONCILED` receipt,
including gaps between backup, migration and rollout. The exclusive release owner must not prepare,
replace or execute another backup request during this lease. Every migration/rollout/recovery proof
requires byte equality with the canonical `backup-operation.json`; drift stops and retains evidence
and locks. Recovery may restore only those exact canonical bytes under the same exclusive owner,
then reconcile the original operation. It never creates a replacement backup to repair that proof.

This notification profile validates monitoring against the actual wall clock before preparation,
each service activation, every observation round and final evidence capture. Initial provider and
alert bytes/hashes are sealed in the plan/capsule. The alert bytes stay unchanged. Approved fresh
provider captures may update only `readAt`, per-monitor `lastCheckAt` and
`successfulConsecutiveRounds`; all are nondecreasing, identities/configuration stay exact, and
incidents stay zero. A capture older than 30 seconds or checks older than 130 seconds stop the
rollout. The approved read-only provider collector must keep these receipts current during the
whole operation; copying old timestamps forward is forbidden. Before preparation, live Web and
Realtime images must equal the unchanged digests in the receipt-verified API8158 descriptor.

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
