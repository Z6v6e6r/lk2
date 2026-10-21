# Beta bootstrap readiness and rehearsal

Companion to [ADR 0025](../adr/0025-two-profile-timeweb-delivery.md) and to the
[beta deploy preflight](timeweb-beta-deploy-preflight.md). The bootstrap plan is read-only: it says
whether the disposable beta host has everything the simplified path needs, and what to fix, without
creating roles, secrets or files. Applying role/secret changes is a separate, explicitly authorized
operation because it crosses the database privilege and secret-custody boundary.

## What the plan covers

- least-privilege database roles `phub_runtime` and `phub_migrator`: presence, forbidden service/admin
  flags, migrator `CREATE ON DATABASE` (0098 needs it even when the schema exists) and runtime DML
  coverage across all business tables;
- installed secret set: the canonical five files, `0600` modes and the `.release-identity.json`
  release id;
- candidate secret set when `--candidate-dir` is passed: canonical files, `FCM_ENABLED=true` and the
  full FCM delta in both `api.env` and `worker.env`;
- root-only FCM service-account credential (metadata only, never the key);
- monitoring provider readbacks (recorded evidence on beta, not a deploy gate);
- restore capacity and the exact pre-99/post-101 operation schema from
  `plan-timeweb-beta-restore`.

## Command

```sh
cd /opt/phub/timeweb-beta/standard/source
node --import tsx scripts/plan-timeweb-beta-bootstrap.ts \
  --phase=post101 \
  --candidate-dir=/etc/phub/timeweb-beta-candidates/<release-id>/timeweb-beta \
  --json
```

Exit codes: `0` — `READY` (no blockers; `ACTION` items may remain and are listed with remediations),
`1` — `NOT_READY` (at least one blocker), `2` — the plan itself could not run.

The planner never creates a role, updates a secret file, changes a mode, starts a container or runs a
migration. It is safe to run repeatedly and before every rehearsal.

## Applying gaps

- **Roles/privileges** — apply the least-privilege grants through the canonical database operation
  with an explicit target and review. Do not hand-run ad-hoc `GRANT ALL`; the role validator pins the
  expected privilege shape (`canCreateDatabaseObjects=false` for runtime, `true` for migrator).
- **Secret sets** — install the canonical five files from the reviewed candidate source with
  `0600`/root ownership and the matching `.release-identity.json`. The candidate set is not a copy of
  the installed one: the FCM delta is explicit.
- **FCM credential** — install the operator-provided service-account JSON at the canonical root-only
  path; never print it, never commit it, never place it in an image or a shared env file.
- **Monitoring readbacks** — export the approved provider readbacks into the observability directory;
  beta records them as evidence, production requires them by profile.
- **Restore capacity** — use the schema printed by `plan-timeweb-beta-restore`; if the mode is `none`,
  grow the target or archive audit/outbox data before the backup, never hand-edit the schema.

## Weekly rehearsal

Run at least weekly and after any delivery-contract change, on a staging clone (never as the first
execution of a new contract):

1. `plan-timeweb-beta-bootstrap.ts` → record `READY`/blockers and every remediation.
2. `preflight-timeweb-beta-deploy.ts --profile=beta --phase=rollout` → record the full gap list.
3. `plan-timeweb-beta-restore.ts --phase=post101 --json` → record the selected mode/schema and
   capacity numbers against the current database size.
4. Walk the deploy checklist categories in order: source/CI, images/artifact, database/ledger, backup,
   secrets/FCM, monitoring evidence, locks/host hygiene, readiness/smoke/reconcile.
5. Record lead time for the dry run and the expected apply window; compare with the ADR target
   (merge → working beta under one hour) and note deviations.

A rehearsal that finds a missing prerequisite must fail before any mutation; the fix goes into the
bootstrap inputs, not into an ad-hoc gate relaxation. If a rehearsal requires a code or contract fix,
land it through the normal task-branch → PR → main path before the next real operation.

## Rehearsal evidence

Keep the planner JSON, preflight JSON and restore-plan JSON with the release evidence (they contain no
secrets). Report environment labels exactly: `LOCAL`/`CI`/`STAGING`/`PROVIDER`/`PRODUCTION`; a rehearsal
on a clone is `STAGING`, and a green rehearsal never substitutes for the exact-target operation
approval.
