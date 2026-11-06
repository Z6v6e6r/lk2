# LK2 disposable beta lane (lk2.padlhub.su)

Status: implemented source, **CRITICAL deploy-mechanism change**; not yet executed on the host.
Valid only while `lk2.padlhub.su` holds synthetic data (AGENTS.md first-version mode, ADR-0026
`beta` lane). When real users or real personal data arrive, delete this lane
(`deploy/timeweb/lk2-beta-lane.sh`, `apps/migrator/src/lk2-beta-lane.ts`) together with the AGENTS.md
bullet, and lk2 returns to the strict production route.

## What it replaces and what it keeps

The strict route ([Timeweb beta](timeweb-lk2-beta.md), [R1 tail](r1-tail108-119-migration.md))
needs enrollment, custody capsules and per-migration controllers. That machinery is paused, and lk2
was stuck at ledger 105 (`0101`). This lane promotes one green main commit in a single command:

1. pull the five `ghcr.io/z6v6e6r/phub-*:<sha>` images built by the `Test stand` workflow for that
   green main commit, and pin them by registry digest;
2. record the running images once as `baseline` (the first rollback target);
3. `pg_dump -Fc` of `phub_beta` (needs > 2x database size free; last 3 kept, checked with
   `pg_restore -l`);
4. stop the Worker, run `migrator --lk2-beta-lane` as the PostgreSQL superuser;
5. start API, Realtime, Web and (if it was running) Worker on the new digests with
   `compose.beta.yaml`, verify the running digests and smoke `/health/ready`,
   `/realtime/health/ready` and `/`;
6. on a failed start or smoke, restart the previous application images automatically.

Kept: immutable digests, no build on the host, no `latest`, runtime secrets stay in
`/etc/phub/timeweb-beta/*.env` (the lane never writes them), ingress/Caddy and the operator
dependency containers are untouched, the ledger still refuses unknown or altered applied files, the
chat-push foundation gate stays.

Not kept, by decision for a disposable contour: custody capsules, enrollment, restore rehearsal,
per-file controllers for 0099-0104 and the R1 tail, long observation.

## Migrator mode `--lk2-beta-lane`

- Bound to the exact cluster: database `phub_beta`, system identifier `7679125609183186977`, not in
  recovery, connected as a superuser, role `phub_runtime` present. Anything else stops with
  `LK2_BETA_LANE_*` before DDL. `--lk2-beta-lane-plan` prints the pending list and changes nothing.
- Applies every pending packaged file in order, each in its own transaction with
  `lock_timeout=10s`, `statement_timeout=120s`. A failure rolls back that file only; committed files
  stay. Rerun `promote` to resume.
- Then, in one transaction, makes the `phub_runtime` ACL exact on the 19 tables created by
  0102-0115 (revoke all, grant the reviewed R1 post-119 matrix plus the 0102 photo contract) and
  verifies it. Older tables keep their existing grants. Idempotent.
- New tables are owned by the superuser `phub_beta` (not `phub_migrator`). The strict
  `r1-runtime-grants119` plan expects `phub_migrator` ownership and is not applicable after this lane.

## Operating it

Prerequisites on the host: Tailscale management access, root, Docker Compose v2.20+ (`--wait-timeout`),
`docker login ghcr.io` with a `read:packages` token if the packages are private, and a checkout (or
copy) of `deploy/timeweb/lk2-beta-lane.sh` next to `deploy/timeweb/compose.beta.yaml` from the
same commit you promote.

Pick the SHA: a main commit whose `Pull request checks` and `Test stand` runs both succeeded. Each
promote needs the owner's approval for that SHA until standing authority is granted for this lane.

```sh
sudo deploy/timeweb/lk2-beta-lane.sh plan <sha>       # read-only for DB/containers; pulls images
sudo deploy/timeweb/lk2-beta-lane.sh promote <sha>
sudo deploy/timeweb/lk2-beta-lane.sh status
sudo deploy/timeweb/lk2-beta-lane.sh rollback         # previous lane release, then baseline
```

State lives in `/opt/phub/timeweb-beta/beta-lane` (root, 0700): `releases/<sha>.env` (digests and
paths only, no credentials), `releases/baseline.env`, `history` (stack of successful promotions),
`current`, `backups/`. The superuser connection string is written to a 0600 temp file in that
directory for the migrator container and removed on exit.

## Failure handling

| Stop                              | State                                       | Next step                                    |
| --------------------------------- | ------------------------------------------- | -------------------------------------------- |
| pull / digest / env-root / backup | nothing changed                             | fix the input, rerun `promote`               |
| `LK2_BETA_LANE_TARGET_*`          | nothing changed                             | wrong cluster or connection: do not override |
| migration file failed             | earlier files committed, worker restarted   | fix forward in a new main commit, `promote`  |
| start / digest / smoke failed     | previous images restarted, new schema stays | read API logs, fix forward                   |
| rollback also failed              | unknown                                     | inspect the host by hand                     |

Rollback never reverses migrations. All 0102-0115 changes are additive; previous images run on the
new schema. A full reset of lk2 data is `pg_restore` of a lane backup and needs its own decision.

## Evidence

LOCAL (2026-11-06): PostgreSQL 16 at ledger 105 -> beta mode applied 0102-0115 and the runtime
grants; rerun idempotent; ordinary mode still refuses with
`CLOSED_APPLICATION_MIGRATION_CONTROLLER_REQUIRED`; a non-lk2 cluster is refused with
`LK2_BETA_LANE_TARGET_MISMATCH`; `phub_runtime` can read the new tables, cannot delete command
receipts or write the ledger. Script paths (plan, promote, migration failure, start failure with
automatic rollback, stacked rollback) are covered by `scripts/lk2-beta-lane-script.test.ts` with fake
docker/curl. No STAGING or PRODUCTION evidence exists until the first owner-approved promote.
