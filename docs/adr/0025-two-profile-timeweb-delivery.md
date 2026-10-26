# ADR 0025: Two-profile Timeweb delivery with immutable-only binding

Status: Proposed

## Context

The Android FCM release took roughly two weeks of wall-clock time even though the product change
itself was small. The time went into the bespoke delivery framework, not into Android or FCM:

- the custom controller (`timeweb-api-worker-*.js`, `control-timeweb-database-backup.py`) is about
  9 500 lines and the canonical runbook is about 1 260 lines; it is larger than the feature being
  delivered;
- the frozen bridge pins container identities including `State.StartedAt`. Every interrupted attempt
  that restarted API/Worker made the pinned preimage stale, and the post-migration backup could then
  never prove the pinned baseline again;
- rollout required a fresh provider-monitoring snapshot with a ~130 s wall-clock window, but the
  API/Worker swap plus observation takes minutes, so a healthy rollout failed after its mutations
  and had to roll back;
- the tmpfs restore mode needs `3 * pg_database_size` of RAM. The beta database is ~9.5 GB on a
  12 GB host, so the post-101 backup could not run at all; only the disk (LUKS) mode worked;
- beta never had the least-privilege runtime/migrator roles the frozen contract assumes, and the
  approved monitoring-provider readbacks were not available on the host. Both gaps were discovered
  during the deploy, not during preparation;
- 35 pinned Git blob OIDs are mirrored in JavaScript and in the Python helper. Each contract fix
  required a new controller commit, a new main CI run, a fresh backup and a full operation retry;
  ten such cycles were normal.

The framework was designed as production evidence custody, but it was also the only way to deploy
beta. That coupling turned every beta deploy into a compliance exercise with no dry-run and no
resumability.

## Decision

1. **Two explicit delivery profiles.**
   - `beta` (and any disposable staging): the standard path — pull immutable images, run the
     one-shot migrator, swap the prepared secret set, start services, verify readiness/smoke,
     record evidence. Target: merge → working beta in under one hour.
   - `production`: the existing strict/frozen profile with the full custody, freeze and evidence
     chain. It stays the only path allowed to touch production.
     The profile is an explicit parameter, not an implicit property of the same operation.

2. **Bind immutables, never runtime posture.**
   A deployment/backup/migration proof may bind: candidate SHA/tree, canonical artifact digest,
   manifest SHA, image digests and revisions, secret-set file hashes and release id, database
   ledger digest, controller commit and source CI. It must not bind container ids, PIDs,
   `State.StartedAt`, restart counters, process argv of a running container, or any observation that
   changes when a healthy service restarts. A restart must never invalidate a still-valid release
   proof.

3. **Separate blocking safety gates from recorded evidence.**
   Blocking by default: database backup present and verified, migration ledger matches packaged
   ledger, target has the required database roles/privileges, readiness and smoke pass, rollback
   material is available, locks are owned/clean.
   Recorded but non-blocking by default: provider monitoring snapshots, alert-delivery tests,
   external monitoring IDs. They are attached to the receipt by hash and reviewed after the deploy;
   the `production` profile may still require them. A long apply must not fail a deploy because its
   own pre-captured snapshot aged past a wall-clock window.

4. **Plan-only preflight that fails in minutes, not hours.**
   Every operation gets a `--plan`/preflight mode that performs zero mutations and reports a
   go/no-go list: image availability and digests, canonical artifact, secret set and FCM credential
   custody, database roles and privileges, ledger state, disk/RAM capacity for the chosen restore
   mode, existing locks/transactions, required CI evidence, and rollback inputs. Preflight must
   complete in under two minutes; missing prerequisites are reported by category, not by the first
   exception.

5. **Idempotent, resumable transitions.**
   Each step persists an intent, an acknowledgement window and a terminal receipt; a lost
   acknowledgement is reconciled by exact name/label lookup, never by replaying mutations. A failed
   attempt must leave the runtime in a state that is either resumable or rolled back, and must not
   consume the next attempt's preimage. Reconciliation of a successful operation releases owned
   locks even after activation (or documents the exact gate that makes reconciliation inapplicable).

6. **Single source of contract pins.**
   Pinned blob tuples live in one generated artifact (JSON/TS). The Python helper constants are
   generated from it, and a test fails on drift. A contract fix must not require editing two
   mirrored lists plus a controller/CI/backup cycle; compatible fixes may be delivered by an
   operator-approved hotfix scope instead of a full frozen re-enrollment.

7. **Backup and restore sized for the real database.**
   Disk (LUKS/loop) restore is the default for databases whose `pg_database_size` cannot fit the
   tmpfs formula on the target host. Preflight computes the mode and fails if the host cannot run
   either mode. Audit/outbox retention and database growth alarms are part of release readiness;
   a database that is mostly outbox/audit bloat must be addressed before it silently blocks backups.

8. **Reproducible beta, rehearsed on a schedule.**
   Least-privilege database roles, secret sets, FCM credential custody and monitoring readbacks are
   provisioned by one idempotent bootstrap artifact. The full release chain is rehearsed weekly on a
   staging clone and after any delivery-contract change. The rehearsal is the gate; the first real
   run of a new contract must not be a production/beta deploy.

9. **Small releases and feature flags.**
   Do not accumulate a multi-week frozen candidate. Client/API changes ship behind flags and the
   provider/tenant activation remains a separate operation, as it already does.

## Consequences

- Beta deploys become short and diagnosable; a missing prerequisite fails preflight before any
  downtime or mutation.
- The strict production custody remains intact: production keeps the frozen profile and its
  evidence gates.
- Some evidence moves from blocking to recorded. This is an accepted risk on beta; production keeps
  the stricter policy and the strict profile must not be silently used for beta.
- Contract changes still need review and CI, but no longer a hand-mirrored pin ritual.
- The beta bootstrap is new work; until it exists, preflight reports missing prerequisites and the
  operator bootstrap stays manually documented.
- Interrupted-attempt behaviour must be tested (restart mid-rollout, lost acknowledgement,
  reconcile-after-success) — these become required integration tests, not incident exercises.

## Alternatives considered

- **Keep one frozen path for everything and make beta match production.** Rejected: beta does not
  need production custody, and requiring it there is what caused the two-week loop.
- **Drop the custom controller entirely.** Rejected for production: the frozen custody is valuable
  for audited releases. The decision is to keep it for prod and stop using it as the beta path.
- **Relax only the failing checks as incidents happen.** Rejected: overnight we removed a monitoring
  gate and degraded a backup gate under time pressure; without a policy those become permanent
  unreviewed weakenings. This ADR makes the intended defaults explicit.

## Migration plan

1. Add the `beta` profile contract and the plan-only preflight (this step, with a checklist runbook).
2. Generate Python pin constants from the single JS/JSON source; remove the manual mirror.
3. Move beta to immutable-only binding (no container `startedAt`/preimage identity) and make
   restart-triggered failures impossible on the beta profile.
4. Make disk restore the default for beta and add the capacity preflight from real database size.
5. Rebuild the beta bootstrap (roles, secrets, FCM, monitoring inputs) as one idempotent artifact;
   rehearse on staging.
6. Re-run the complete Android/beta chain on the simplified path; record lead time. Restore the
   strict monitoring/backup gates on production only.
