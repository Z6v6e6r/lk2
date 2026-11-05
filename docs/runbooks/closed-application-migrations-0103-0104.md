# Closed game-reminder and phone-link schema steps

This controller prepares two separately authorized additive migrations on Timeweb
`lk2.padlhub.su`, server 8886471/project 262717, database `phub_beta`, system identifier
`7679125609183186977`. It never deploys API/Worker, changes runtime secrets, grants runtime
access to the new tables, enables flags, imports business records, or sends messages.
Merge, publication, controller/tool enrollment, each backup and each migration remain
separate live decisions. A green source PR is not authorization for any of them.

## Immutable package and compatibility

The descriptor `deploy/timeweb/closed-application-migrations-0103-0104.v1.json` pins all
108 packaged SQL files, prefix ledgers 106/107/108 and both closed catalog variants:
`DORMANT` and `SCENARIO_EDITOR_V1`. The latter preserves the previously enabled scenario
editor's nine privileges. The controller does not infer a variant from the database.

- `game_start_0103`: exactly ledger 106 → 107; backup `game-start-pre0103`.
- `subject_link_0104`: exactly ledger 107 → 108; backup `subject-link-pre0104`.

Both operations pin current API/Worker/PostgreSQL identity, immutable migrator image/index
and amd64 child, same controller source/tree and successful CI, the five-file runtime
secret set by digest, full catalog and exact pre-existing ACL. PostgreSQL container and
image are fixed to the admitted target. An ordinary populated-database migrator refuses
these steps; the image accepts only its corresponding explicit closed-mode argument.
Historical notification/photo catalogs and admission allowlists remain separate.

The source closure is explicitly enrolled against base `871cc2f8660ec98ec4b95f50a78aad1e6d1b1cfe`
and tree `a76bc4ce1f472e2465a0bbb0075f1ec0efba294c`. Foreign runtime changes, symlinks,
deletions, dirty Git metadata and any other CI patch fail admission. This is not a generic
controller-promotion exemption. A source change or base drift requires fresh review.

## Explicit patched119 package for the R1 prefix

The historical108 schemas, CLI arguments and871 source closure above remain unchanged. The R1
release explicitly selects `PHUB_TIMEWEB_R1_GAME_START_0103_MIGRATION_OPERATION_V1` or
`PHUB_TIMEWEB_R1_SUBJECT_LINK_0104_MIGRATION_OPERATION_V1` and the corresponding fixed
`--r1-game-start-migration-0103` / `--r1-subject-link-migration-0104` image arguments.
There is no selection by observed package length and no ordinary-mode fallback.

`deploy/timeweb/closed-application-prefix108-package119.v1.json` pins the full119 inventory through
`r1-tail108-119.v1.json`, the immutable108 descriptor bytes and the same106/107/108 checkpoints.
The existing single-step hooks still execute only the selected0103 or0104;0105–0115 remain pending.
An old108 argument rejects119; a new argument rejects108/120, omitted SQL and changed prefix/suffix.

The new schema family uses the existing manual entry, shared executor, ACL/catalog checks,
manifest verification and namespace backup producer. Controller source, source CI and published
image remain one exact tuple. Its separately reviewed source closure starts at
`27d8527f2f36e1a647012a86f92f4a51b9dd50eb`, tree
`f144d66d2aaa3dfdb53177c62d35bcb7b327253f`; only the fixed prefix-compatibility files and later
reviewed tail-catalog artifact promotion are allowed. Root dependencies, migration SQL, workflows
and foreign application files are excluded. This inherits the patched lockfile; it does not reuse
an old application-package image by pretending its source is a new controller.

Backup requests explicitly use `PHUB_TIMEWEB_R1_GAME_START_PRE0103_BACKUP_NAMESPACE_V1` or
`PHUB_TIMEWEB_R1_SUBJECT_LINK_PRE0104_BACKUP_NAMESPACE_V1`; their receipt/terminal/preimage schemas
are distinct, while the fixed source/CI-scoped paths and106/107 ledgers are reused. Existing
historical receipts remain valid for historical consumers. Stage proof schemas remain shared,
with exact operation/plan hashes binding the declared package family and source. A0103/0104 chain
cannot mix old and R1 families. The tail reader preserves its historical branch; an R1 predecessor
must match the current119 tail source/tree/source CI/publication/image tuple.

R1_PACKAGE119 intents for0103/0104 may select `backupGeneration`: exactly32 lowercase
hexadecimal characters, chosen before sealing any prefetch/backup/request hashes. It belongs only
inside `migrationIntent`; the outer backup schema is unchanged. Historical108 rejects the field.
When absent, request bytes/binding and canonical paths retain their existing representation.
When present, the backup directory gains `-generation-<id>` after its mode, and the closed
prefetch directory gains the same suffix after its candidate. Migration transaction roots,
container names, shared request paths and tail UUID namespaces do not change.

A new generation requires a new matching prefetch intent/receipt and a separately authorized
fresh dump/restore. Existing generation roots remain immutable: the same generation cannot repeat
the producer or pull; its exact evidence may only be attested/reconciled. Generation participates
in the existing migration binding; expiry-only renewal cannot change it or reuse another
generation's receipt. Fresh admission still rejects a restore receipt older than one hour.
Never restamp, move, archive, delete or overwrite an old verified backup to renew freshness.
Retained0103 and tail predecessor readers bind the exact saved generation from each operation.
The shared completed backup/prefetch requests require the separately reviewed operational handoff
before staging another exact intent; this source change performs no request archival or enrollment.
The R1 controller type closure additionally admits exactly
`scripts/timeweb-api-worker-migration.d.ts` and
`scripts/timeweb-closed-application-profile.d.ts` as regular non-executable declarations.
Symlinks, executable modes, deletions and foreign declaration paths remain refused; no wildcard
or additional runtime-file admission is introduced.

The existing explicitly owned PostgreSQL16 contour rehearses106→107→108 using all119 packaged
files and the real restricted migrator login, proves that0105 is not applied, then exercises the
fixed tail. This is synthetic CI evidence, not live migration or restore evidence. The tail's
`UNREHEARSED` semantic catalog still denies forward tail admission until its CI export is
independently reviewed and committed. Capacity and independent restore gates are unchanged.

## Sequence and ownership

The retained API/Worker release `702625eb669643c52bf69f55bc65c2e3e74f5ef9` omits three
activation switches and its configuration parser defaults them to false. Admission recognizes
that case only for the pinned API/Worker image digests and exact historical parser/startup
source hashes. It checks sealed env files and actual container environments independently.
Explicit true, blank, malformed or duplicate values still fail; another image, revision,
changed source blob or unavailable Git object cannot use this exception. The earlier
pre-capability ancestor rule remains unchanged. This is an OFF-state compatibility proof,
not permission to change flags, recreate containers or enable delivery.

Current-main source admission also pins the already merged quarter-court CREATE route and
deterministic training-date test as an exact two-blob prerequisite. Those application files
are not editable controller paths. Listed R1 Markdown evidence may change only as regular
non-executable files; SQL inventory, catalog, source/CI/publication tuple and all migration
prerequisites remain enforced. A new controller source still requires its own successful CI,
immutable publication and enrollment before use. Retain any request rejected before prefetch
intent; reconcile its no-admission state rather than replaying it under changed source.

Use the canonical request paths returned by `closedApplicationProductionPaths`; do not
reuse the photo/notification request. With the reviewed source already enrolled, the
manual entry is:

```sh
node scripts/timeweb-closed-application-controller.js MODE KIND REQUEST_PATH
```

Allowed modes are `prefetch`, `attest-prefetch`, `reconcile-prefetch`, `deploy`, `reconcile`;
allowed kinds are `game_start_0103`, `subject_link_0104`. The entry requires root, the
exact stage-specific path, a clean ambient Docker/Compose environment and the existing
shared API/Worker executor lock. JSON supplies data only; it cannot supply callbacks,
SQL, executable paths or arbitrary Docker arguments.

For each stage, in order:

1. Seal the exact migration intent and a separate 20–60 minute prefetch authorization.
   The runtime snapshot does not require the future migration request while no matching
   migration/probe container exists. If such a container is present, its exact request
   hash remains mandatory for custody validation. Never stage a migration request merely
   to satisfy a prefetch read: the phase-exclusion check correctly rejects that overlap.
   Recheck source CI/publication, runtime/env OFF switches, secret digests, target and
   pre-state. Persist the intent before the one image pull. Attestation never writes;
   reconciliation can seal a missing receipt only if both immutable image refs already
   exist. An uncertain/missing pull result requires an owner decision; it is never retried.
2. Separately authorize the existing backup controller's private namespace dump/restore.
   Its shared request is `/opt/phub/timeweb-beta/operator/database-backup-restore.json`.
   The closed profile binds the full migration intent (except renewable expiry and its
   fixed confirmation), migrator prefetch, pre-ledger, target, variant and owner/ACL
   recovery. The restore child checks local fs/Git source only; host source CI and runtime
   authority are sealed before entering its private namespace. Require a reconciled
   terminal receipt proving owner/ACL restoration and storage cleanup, plus retained dump.
3. Seal a fresh exact migration request. The controller first records preparation/plan,
   claims shared locks, and probes the migrator role. It adds only missing schema CREATE
   and column REFERENCES privileges for that migration. Each grant/revoke transaction
   checks the complete sealed ACL before and after; existing grants are retained.
4. Start one fixed migration container. SQL, ledger insertion and post-catalog validation
   are one transaction. Advisory acquisition is bounded before the lock call; lock and
   statement timeouts remain bounded. After the post-state, remove only the controller's
   added privileges and seal probes, ACL proofs, backup linkage and SUCCESS.
5. Run `reconcile` and require terminal `RECONCILED` / `SUCCESS` before the next stage.
   Successful deploy deliberately retains locks until this reconciliation completes.

Step 0104 requires exact retained 0103 capsule, plan, SUCCESS hash, reconciled receipt,
both stopped successful role probes, stopped successful migration container, full ACL
proofs and retained backup. First-stage request files may remain only at their verified
byte hashes. Unknown or edited requests block the next stage; the controller does not
delete or archive them. The game backup's read-only `--attest-closed-retained` entry reads
its canonical saved operation rather than the shared request now belonging to stage two.

## Failure and recovery

Never repeat a forward command after an ambiguous SSH result. Read the durable capsule,
journal, container state, ledger/catalog and lock custody, then use only the exact
operation's reconciliation. Reconciliation never creates or starts a migration/probe
container. Before start, a proven pre-state can be aborted after removing only added
ACL. A proven successful post-state can finish cleanup and SUCCESS. `START_INTENT`, a
running container, absent custody, mixed state or failed cleanup without a complete
proof requires owner recovery and keeps locks. It is not permission to replay or restore.

Expiry is rechecked after slow custody reads, and directly before forward grants,
container creation and start. Expiry does not prohibit the narrowly owned ACL cleanup
needed for recovery. There is no destructive down migration or automatic production
database restore; either needs its own reviewed recovery plan and explicit authority.

## Evidence levels

Synthetic PostgreSQL16 tests exercise both variants, SQL/ledger atomicity, target rejection,
role/ACL drift, bounded locks, fresh/stale backup binding, retained first-stage proof,
prefetch no-replay and deploy/reconcile crash points with the real catalog validators.
Simulated production target metadata is explicitly marked in those tests; the actual
synthetic cluster is rejected as a production target. Logical dump/restore tests do not
establish physical Linux namespace/cryptsetup behavior. The existing Linux CI rehearsal
and later exact-host preflight remain separate evidence.

After these migrations, all new runtime ACL, application rollout, safe phone linking,
scenario creation/activation and the one authorized self-test notification still require
their own concrete packages. No success receipt from this controller proves a delivered
notification or authenticated photo-editor acceptance.

### Canonical publication attempt representation

The V2 release manifest records `publication.runAttempt` as the exact string `"1"`,
matching the publication workflow and manifest schema. Closed 0103/0104 and R1 tail
migration admission validate that string without coercion or rewriting the immutable
manifest. GitHub run metadata and migration operation `publicationRunAttempt` remain
numeric `1`; later attempts and noncanonical representations are rejected.

### Exact native JOIN lifetime prerequisite

The R1 source closure can additionally contain one complete, independently reviewed
pair: `NativeGameJoin.tsx` blob `5f0bd216b2236ad3dceb759dec01e9d56e261d36` →
`76175a62bd0a25ac281dd2ddf949f94add1106f5`, and its regression test blob
`f428b2d54b2f88d415fa936eca66b4b6d68435a3` → `89350edf3ad31bdef5662197b95f554ce72182c6`.
The correction activates the JOIN lifetime before a visible enabled action accepts input;
the deterministic test fails on the prior implementation with zero dispatched requests.
Both closed-prefix and tail validators use the same all-or-none exact blob check. These
paths are not added to the editable controller allowlist. Partial pairs, different blobs,
mode/status changes and other application paths are rejected. Base27d, SQL/catalog/ledger,
ACL/backup guards and controller=migrator source identity remain unchanged. This source
exception does not activate an application, mobile build/store or provider operation.

### R1 restricted-role probe and temporary games access

The `R1_PACKAGE119` operation family resolves its parent relation ACLs through
`pg_catalog.pg_namespace` and `pg_catalog.pg_class` OIDs. Its pre-bootstrap wire-role
probe must succeed without schema `games` USAGE. The historical108 SQL/probe contract
remains byte-identical; family selection comes from the existing operation schema.

For both R1 game-start0103 and subject-link0104, capture `schema:games` in the exact privilege preimage, including
its confirmed owner, explicit ACL and effective USAGE/CREATE. The supported owner is
`phub_beta`; an unknown owner, missing row or null schema ACL fails closed. If USAGE is
absent, bootstrap adds only that privilege for `phub_migrator`, alongside the existing
scoped column REFERENCES grants. 0103 needs USAGE for its foreign key; both migration
modes also need it while validating the canonical games parent catalog. It never adds
games CREATE or table DML. Cleanup
revokes only privileges added by this attempt, preserving prior runtime/migrator grants.
Both transactions compare the whole preimage before and after, including schema ACL.
A rolled-back migration still requires the same guarded ACL cleanup.

This source correction requires a newly reviewed controller/migrator source tuple and
fresh matching backup/probe/input hashes. Previously sealed b989 operations and their
backup generations are immutable and must not be reinterpreted using the new ACL plan.
A source test or disposable PG16 rehearsal is not permission to mutate a live ACL.

## Exact JOIN60 source prerequisite

The JOIN60 correction admits the following complete group only: exact old/new Git blobs,
regular `M 100644 → 100644`, no duplicate, missing, added, renamed or extra-field rows.
These application and test paths remain outside the editable controller allowlist.
The prior source without this group remains accepted.

| Path                                                               | Old blob (fixed 27d base)                  | Reviewed new blob                          |
| ------------------------------------------------------------------ | ------------------------------------------ | ------------------------------------------ |
| `apps/api/src/games/game-commercial-join.test.ts`                  | `6350c1d9d1e213a02351327e372c11ef930b1d88` | `23fa1a6b8fd83042645ef82d96dc2329942dd34d` |
| `apps/api/src/games/game-join-conditions-owner.ts`                 | `3ea378e81b3ab71cb263e0f1b9fc14d0a3650ef0` | `bae4a56b46088d9445f30a0956406832e65f3c24` |
| `apps/api/src/games/game-join-conditions-resolver.test.ts`         | `6ae655278baadea2c9cbcaeca30894c047f88c4e` | `4d810ff830dd5d03adf1e083e253a6458e8312f7` |
| `apps/api/src/games/game-join-conditions.test-fixture.ts`          | `4af7f33ddf6a193e5b57440d920582081e4f6436` | `3b93df7f80095bea1542922b8bfd9eb2588f71fd` |
| `apps/api/src/games/game-join-conditions.test.ts`                  | `020305559f9a351f50db8c4eb22cbf7f96d364bd` | `2dd7c344ad9f929495d1f1e50e47d5c2b639b0ac` |
| `apps/api/src/games/game-join-conditions.ts`                       | `fcedef03338f747145d08ac0796f0440d73e885a` | `f8c9e62ec57ca639bd8ad33f8b4f3fd09f997fa9` |
| `docs/contracts/game-join-conditions.md`                           | `b5009d30579e65caef133116bfb2f58cd2b0be36` | `af199d739153277becdbca1df6c0499108ed0d4f` |
| `packages/database/src/game-join-conditions-context-repository.ts` | `e4b084d60905099f1babdae0915f6cc6c8ed08ef` | `2945dc681ee0eca5e9a6df8ed5a2f77fb21bd3a3` |
| `packages/viva-adapter/src/game-subscription-selection.ts`         | `d3f3518ade36ffc400c5ea7e1fe8064d5f52ba7f` | `055441ccc3363db241af1d378eadc3c23f5e62dd` |
| `apps/api/src/games/game-commercial-join-runtime.test.ts`          | `c5a7bbc5fd82da33a84044bb48ffef0fea6a158c` | `27471920361d91db421106a33e450823cd8bf438` |

A merged JOIN60 source is a new immutable source/artifact tuple. Obtain its successful
source CI, publication, canonical manifest, enrollment and fresh target evidence before
execution; never relabel the existing 2d042 artifacts or backup freshness. The same
106→107→108→119 migration/ACL semantics apply. Rollout leaves commercial activation
separate and disabled until its exact product/configuration admission.
