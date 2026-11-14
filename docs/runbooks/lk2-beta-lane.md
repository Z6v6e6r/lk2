# LK2 disposable beta lane (lk2.padlhub.su)

Status: **retired for lk2.padlhub.su as of 2026-11-13**. Live readback confirmed personal data,
Viva identities/delegations and sessions. Do not run this lane's `plan`, `promote`, `rollback`, reset
or migrator on the current target. Keep historical state, images and backups intact; they are evidence,
not production authority. The operational description below is historical.

The replacement is the explicit [production cutover in the existing strict API/Web controller](timeweb-standard-delivery.md#production-cutover-from-the-retired-beta-lane).
It keeps the real predecessor labels and digests as rollback evidence without claiming canonical
publication or changing the database, runtime secrets, Worker, Realtime or ingress.

## What it replaces and what it keeps

The strict route ([Timeweb beta](timeweb-lk2-beta.md), [R1 tail](r1-tail108-119-migration.md))
needs enrollment, custody capsules and per-migration controllers, and that machinery is paused.
This lane promotes one green main commit in a single command:

1. `plan` pulls the five `ghcr.io/z6v6e6r/phub-*:<sha>` images built by the `Test stand` workflow
   for that green main commit and records their registry digests; `promote` refuses without that
   plan or when a tag now points at a different digest;
2. find the one running API/Realtime/Web/Worker container per service on the `phub-timeweb-beta`
   network, whatever its Compose project (two of one service is a stop), and record them once as
   `baseline` (the first rollback target);
3. `pg_dump -Fc` of `phub_beta`, checked with `pg_restore -l`; last 3 kept. Less than 2x database
   size free only warns (capacity is a provisioning property, not a per-release gate); a dump that
   fails stops the promotion before any migration;
4. stop the Worker, run `migrator --lk2-beta-lane` as the PostgreSQL superuser;
5. start API, Realtime, Web and (if it was running) Worker on the new digests with
   `compose.beta.yaml` in project `phub-timeweb-beta`. A container of the legacy project
   (`phub-timeweb-beta-apps`) is stopped first, never removed, so its address and service name pass
   to the new one. Verify the running digests and smoke `/health/ready`, `/realtime/health/ready`
   and `/`;
6. on a failed start or smoke, return to the previous release automatically; for `baseline` that
   means removing the lane containers and starting the preserved original containers again.

Kept: immutable digests, no build on the host, no `latest`, runtime secrets stay in
`/etc/phub/timeweb-beta/*.env` (the lane never writes them), ingress/Caddy and the operator
dependency containers are untouched, the ledger still refuses unknown or altered applied files.
The script always passes the chat-push maintenance acknowledgement; on lk2 that gate is a no-op
because 0069-0073 are already applied.

Not kept, by decision for a disposable contour: custody capsules, enrollment, restore rehearsal,
per-file controllers for 0099-0104 and the R1 tail, long observation.

## Migrator mode `--lk2-beta-lane`

- Bound to the exact cluster: database `phub_beta`, system identifier `7679125609183186977`, not in
  recovery, connected as a superuser, role `phub_runtime` present. Anything else stops with
  `LK2_BETA_LANE_*` before DDL. `--lk2-beta-lane-plan` prints the pending list and the row-lock
  parent gaps (below) and changes nothing.
- Applies every pending packaged file in order, each in its own transaction with
  `lock_timeout=10s`, `statement_timeout=120s`. A failure rolls back that file only; committed files
  stay. Rerun `promote` to resume.
- Then, in one transaction, makes the `phub_runtime` ACL exact on the 19 tables created by
  0102-0115 (revoke all, grant the reviewed R1 post-119 matrix plus the 0102 photo contract) and
  verifies table- and column-level privileges.
- The new code reads 11 existing parent tables (`identity.users`, `identity.tenants`, `games.games`,
  ...) under `FOR SHARE/UPDATE`, which needs SELECT plus UPDATE on at least one column. On those
  tables grants are only added: missing SELECT, or UPDATE when the role has none on any column, is
  granted and printed as `Granted row-lock parent privileges`. Nothing on older tables is revoked.
  Idempotent; a rerun grants nothing new.
- Tables created by this lane are owned by the superuser `phub_beta`. The 0102-0115 tables on lk2
  were created by the strict route and stay owned by `phub_migrator`; the lane re-applies the same
  runtime ACL on them (revoke, then grant the identical set). The strict `r1-runtime-grants119`
  plan expects `phub_migrator` ownership, so it no longer applies to tables the lane creates.

## Operating it

Prerequisites on the host: Tailscale management access, root, Docker Compose v2.20+ (`--wait-timeout`),
`docker login ghcr.io` with a `read:packages` token if the packages are private, and a checkout (or
copy) of `deploy/timeweb/lk2-beta-lane.sh` next to `deploy/timeweb/compose.beta.yaml` from the
same commit you promote.

Runtime env root: the directory with `api.env`, `realtime.env`, `worker.env` that the running
containers use. The default is `/etc/phub/timeweb-beta`. If lk2 still runs the legacy project, the
script refuses until `TIMEWEB_RUNTIME_ENV_ROOT` is set explicitly (the legacy fast beta used
`/etc/phub/timeweb-beta-fast`); check with `docker inspect` which root those containers were created
from before choosing. A new version that needs env keys the root lacks fails readiness and is rolled
back automatically.

Pick the SHA: a main commit whose `Pull request checks` and `Test stand` runs both succeeded. Each
promote needs the owner's approval for that SHA until standing authority is granted for this lane.

```sh
sudo deploy/timeweb/lk2-beta-lane.sh plan <sha>       # read-only for DB/containers; pulls images, records digests
sudo deploy/timeweb/lk2-beta-lane.sh promote <sha>
sudo deploy/timeweb/lk2-beta-lane.sh status
sudo deploy/timeweb/lk2-beta-lane.sh rollback         # previous lane release, then baseline
```

State lives in `/opt/phub/timeweb-beta/beta-lane` (root, 0700): `plans/<sha>` (digests),
`releases/<sha>.env` (digests and paths only, no credentials), `releases/baseline.services`
(service, container ID, project, digest), `history` (stack of successful promotions), `current`,
`backups/`. Do not delete the stopped legacy containers while `baseline` may still be needed. The superuser connection string is written to a 0600 temp file in that
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

## Current lk2 state

Read-only readback on lk2 (2026-11-06, before any lane run): the strict route had already applied
0103-0115 (08:43-08:47 MSK; 0102 on 2026-10-27), so the ledger is 119 (`0115`). The 19 new tables
are owned by `phub_migrator`, `phub_runtime` holds exactly the R1 post-119 matrix on them and
SELECT plus UPDATE on all 11 row-lock parents. Canonical project `phub-timeweb-beta` runs release
`4474386691e2e16d5dc7ca264c741edff0bee540-42163086533-1` with env root `/etc/phub/timeweb-beta`;
`/health/ready`, `/realtime/health/ready` and `/` answer 200 on the host. The lane has not been run;
its first use is the next main commit that changes the application.

## Evidence

LOCAL (2026-11-06): PostgreSQL 16 at ledger 105 -> beta mode applied 0102-0115, the runtime
grants and only the missing row-lock parent privileges; rerun idempotent; ordinary mode still refuses with
`CLOSED_APPLICATION_MIGRATION_CONTROLLER_REQUIRED`; a non-lk2 cluster is refused with
`LK2_BETA_LANE_TARGET_MISMATCH`; `phub_runtime` can read the new tables, cannot delete command
receipts or write the ledger. Script paths (plan digests, re-pushed tag, backup failure, migration
failure, start failure with automatic rollback, stacked rollback, legacy-project handover and
restore, duplicate containers) are covered by `scripts/lk2-beta-lane-script.test.ts` with fake
docker/curl. No STAGING or PRODUCTION evidence exists until the first owner-approved promote.

## Known follow-ups

- The superuser `DATABASE_URL` is in the migrator container environment while it runs (root-only
  `docker inspect`); a mounted secret file would avoid that.
- The binding is cluster identity only; a disposable marker in the database that the switch to real
  users removes would make the lane fail closed even if this code were forgotten.
- Smoke covers readiness, not database grants through the real application connection;
  `r1RuntimePrivilegeQuery` could be run through the API/Worker role after start.
- `Test stand` tags are mutable through `workflow_dispatch`; the plan/promote digest check limits
  the window but does not prove main ancestry or a green run.
