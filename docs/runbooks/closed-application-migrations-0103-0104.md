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

## Sequence and ownership

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
