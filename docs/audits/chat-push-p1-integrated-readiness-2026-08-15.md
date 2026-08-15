# Chats, realtime and Web Push integrated readiness — 2026-08-15

## Verdict

- Integrated local code readiness: `PASS` for review/commit preparation.
- Open blocker/high code findings: `0` after independent architecture, security, migration and
  cross-system re-reviews; all four verdicts are `APPROVE` for this frozen source snapshot.
- Production activation: `NO-GO` until every external gate below is closed against the exact
  immutable image digest.
- No commit, push, deployment, shared migration, provider call or shared-data mutation was
  performed while producing this evidence.

The earlier
[chat-push-p1-local-rehearsal-2026-08-14.md](./chat-push-p1-local-rehearsal-2026-08-14.md)
is historical pre-integration evidence and is not a release attestation for this snapshot.

## Frozen source boundary

- Branch: `codex/chat-push-p1-main-integration-20260815`.
- `HEAD`, `origin/main` and their merge base:
  `2f50e4667351b675ac23d55cf1a240021d73afc3`.
- The prior dirty patch was backed up, stashed, fast-forwarded from `752c374` to current main and
  reapplied. Seven overlapping paths merged automatically. The sole textual conflict in
  `apps/worker/src/main.ts` was resolved as a semantic union that retains both the Communities logo
  resilience/rollback work and the chat, Web Push, booking-reminder and runtime-contour work.
- The worktree has zero unmerged and zero staged entries. This is a current-main source snapshot,
  not a commit or immutable-image attestation.
- Tracked changed files: `69`.
- Untracked source/evidence inputs in the manifest below: `31`.
- This audit file is the thirty-second untracked file and is intentionally excluded from its own
  self-referential manifest.
- SHA-256 of `git diff --binary` before this audit file:
  `f8fce3b97275f3ed0f8e8c887c3427d010dd39ff33edb8beac5eef4b2233c954`.

Untracked SHA-256 manifest:

```text
885453d938c266f88cbc4da96a0799029e059e41d9f8ee5cd21286f3fe459f48  apps/migrator/src/database-role-boundary.pg.test.ts
9fcbceec1742bc55cdbb90d7a88cd041e1ebaec214d80991c5ece34d24b90c7b  apps/migrator/src/database-role-boundary.test.ts
bdac14222dd3c42a27957b41a97ed9ad1f4a25cef8679e56df8abc6e5736619d  apps/migrator/src/database-role-boundary.ts
8f3c582cd43030c06faed863f89822eff3709ee3bc2849166e83cf7a00908d6d  apps/migrator/src/verify-role-boundary.ts
10bd3d2e18c1f62ab25b5ff001e2b9b9d800f62c5942c95b23671aeb40420065  apps/realtime/src/rabbit-registration.test.ts
7dacf63272fc8ef7f63f59c1cf9be5795d4b8a9254f2fdd28697739ff594c2cb  apps/realtime/src/rabbit-registration.ts
76081d0cfbb4453b7dbf48b2f581a7dd044e39f85e3b7e5639759a72faa041cd  apps/realtime/src/realtime-metrics.test.ts
5711204f4dda30c3f9ed7ed1b8035046f9ada80849346c2a27d73e567fee1e94  apps/realtime/src/realtime-metrics.ts
ee95690410e448cf1a7b949ed2971c7cce9cc05e872a08c5552e6a02172a706e  apps/worker/src/booking-reminder-scheduler.pg.test.ts
c97ffbbd3af88068f0a775b65132e43a37ceb3919d2517bd90879f7604aa1a31  apps/worker/src/booking-reminder-scheduler.test.ts
8f87b5e4b5db4d2c3ab1eb7fa89019d3610cfe9bb877005896864078501ba732  apps/worker/src/booking-reminder-scheduler.ts
418be67ed8949e7a352045c8febeb45921ea441e8d861877f31997f98354ca2b  apps/worker/src/web-push-tenant-cycle.test.ts
af237629bceceb98b47e1d3149f16ef5bbf59c87a321d75997083fb2ccb3420d  apps/worker/src/web-push-tenant-cycle.ts
a2c3c4ff3c2312915ba5cf35ff54560df741d5c45381d199c07d1eb4b72504a8  docs/audits/chat-push-p1-local-rehearsal-2026-08-14.md
79ace2ef1155cb9527e5ebbe0530e61a9fb985f08718697770d2994de8b654f6  infra/monitoring/padlhub-alerts.test.yaml
bd88f71b4cfe56d9085e2d2ce3edbb2535f60f79304509faa54cb5562476cc75  packages/database/migrations/0069_booking_notification_projection_fence.sql
fc1fc3e79151bcaf5aa6d23c62c434a1fed6bf9611aaa1c0790ee3f9905c9f8d  packages/database/migrations/0070_web_push_endpoint_hardening.sql
272e0f9b06f6583a2676c632107fc59ecd6f2617fa03e9a4d247fcc044b4fcd1  packages/database/migrations/0071_messaging_user_blocks.sql
570ce268ff559b2d291fc46a30408178c1c3af9f21e84b6f33c4572948315632  packages/database/migrations/0072_web_push_endpoint_status_validation.sql
6da81aca75b2fec842c6686ceab4ae8479c12f411e260f3c5bbeab173631a22c  packages/database/migrations/0073_booking_reminder_scheduler.sql
fd0b15ff71f2f75d304111486d503d9c9c3ec0ca6fec3d5ec152d2323c619201  packages/database/src/booking-notification-projection-fence-migration.test.ts
fe2bd82477d6becce4bb980daca3e2b7e070395c60bf37459687466bf3e7333c  packages/database/src/booking-reminder-scheduler-migration.test.ts
e8bd2193eacecb5dd3994173b5e58eabc50867492a9542326943d95e344b4975  packages/database/src/messaging-user-blocks-migration.test.ts
3d43bfc07887a0d4c9795c1752fdd2d7bda05e212fb61dd5aaa8d75f25ef90d9  packages/database/src/migration-execution-policy.test.ts
c00a03d7b44842ea8461a10824833980e14f6f7b31afe7d56d33a0dbc3a7f350  packages/database/src/migration-execution-policy.ts
eeac2e684481ad14a4070984d72fcf6ad211ff8aa09ccb2f143552a9b6fae6ef  packages/database/src/web-push-endpoint-hardening-migration.test.ts
de1647cbaad7f546dbe42f47781f6f328a5a424411a1c835fd430257e2a9e522  scripts/booking-notification-contract.test.ts
ab567928a84c0ee338ca5b3c52d71e35b65b2288f51ffde33f0f3fb3ccecee62  scripts/booking-notification-contract.ts
6adc2eb36e021b53258c312203aa2d62f0c7e977f94ea95bd65803f3234e34b1  scripts/padlhub-alerts.test.ts
25ab0938376b599ac19df43a8e128f76b88e4e55010a96b0d7b5e83ae8ac6cd5  scripts/verify-direct-chat-realtime-e2e.test.ts
3227831cd1c4a6ed08c2b86cea087bb8f725384a8fe194f8f36c78c3357e4d79  scripts/verify-direct-chat-realtime-e2e.ts
```

## Blockers closed in code

- Direct chat HTTP/realtime recovery is sequence-fenced and deduplicated; broker cancellation
  invalidates readiness atomically for both messaging and Communities consumers.
- User block/unblock commands recheck current actor access inside the locked transaction and retain
  tenant-isolated idempotency/audit behavior.
- Web Push endpoint registration is canonicalized, tenant/quota bounded and restricted to approved
  HTTPS origins with DNS/IP egress checks. Tenant delivery is fair and failure-isolated.
- Web Push circuit reset begins at actual failure time, permits one half-open probe, emits bounded
  metrics/alerts and defers circuit-suppressed deliveries without consuming an attempt even after
  lease expiry; a newer claim remains protected by the exact attempt fence.
- Booking event projection is revision-fenced. Reminder scheduling is durable, expiry-bounded,
  canonical-ruleset-bound and default-off globally and per tenant.
- Migration runners fail before DDL unless the exact authorization applies. Maintenance mode permits
  only pending 0069–0073; a sixth pending file fails closed. The separate fresh-database token also
  requires an empty ledger and an empty user catalog.
- Runtime/migrator role verification rejects session/target spoofing, DDL authority, `ADMIN OPTION`,
  missing schema `USAGE`, PUBLIC or third-party default/table/column ACLs, grant options and every
  runtime privilege outside direct table `SELECT/INSERT/UPDATE/DELETE`. Postflight verifies exact
  owner, forced RLS and canonical single tenant policy on all five runtime-written tables.
- The live PostgreSQL rehearsal exposed and closed a verifier blocker missed by static tests:
  runtime inspection used an empty role name for migrator-only ACL projections and PostgreSQL
  failed with `42704`. It now binds SQL `NULL`, while the migrator inspection still receives the
  exact runtime role name; a source regression and the real pre/post verifier cover the path.
- Realtime and worker metrics carry stable instance labels. Alert rules cover replica disagreement,
  consumer readiness, reminder failures/misses and Web Push circuit-open outcomes.
- Current-main Communities/media source resilience and staging PostgreSQL backup/restore changes
  remain integrated with the chat/push patch; their focused regression suites pass.

## Verification evidence

- `npm run check`: `PASS` on the frozen code snapshot with loopback binding allowed. It ran format,
  lint, typecheck, OpenAPI lint, the full tests, all workspace/app builds and runtime import
  verification. A preceding sandboxed run stopped only on four `listen EPERM 127.0.0.1` fixture
  binds; the permitted full rerun passed those tests.
- Full test result inside the final gate: `305` files passed, `2` skipped; `1947` tests passed,
  `28` skipped.
- The current-main overlap-focused run passed `29` files and `259` tests.
- `npm run db:migrate:check`: `PASS`, `85` migration files.
- `npm run contracts:lint`: `PASS` with the same six non-blocking baseline warnings.
- Root, staging and production `docker compose ... config --quiet --no-interpolate`: `PASS`.
- Alert copies are byte-identical. Pinned `prom/prometheus:v3.2.1` reported `32` valid rules and
  `SUCCESS` for the rule-unit suite.
- `git diff --check`: `PASS`.
- Final focused role suite before runtime rehearsal: `73` passed; `13` opt-in PostgreSQL drift tests
  skipped without `_verify` URLs. The live result is recorded below.

## Current-main disposable PostgreSQL 16 rehearsal

This is source-run evidence for the current-main manifest above, not an immutable PadlHub image, target-data
clone, staging or production attestation. The contour was a unique loopback-only
`postgres:16-alpine` container, PostgreSQL `16.14`, image ID
`sha256:57c72fd2a128e416c7fcc499958864df5301e940bca0a56f58fddf30ffc07777`, tmpfs data directory,
no named volume and no shared Compose service. The historical empty-database rebuild required
temporary database ownership and `BYPASSRLS` for legacy migrations that write after `FORCE RLS`;
both were removed before the first role-boundary attestation. This bootstrap is not part of the
production lower-gap upgrade path.

- The synthetic lower-gap baseline contained exactly `80` current migration files with exact
  checksums: 0076–0081 were present, 0069–0073 were absent, and there were no missing or unexpected
  ledger entries. Pre-role verification passed with distinct bounded runtime and migrator roles.
- The baseline held `10,000` synthetic active PUSH endpoints, `5,000` per synthetic tenant, in a
  `5,791,744`-byte endpoint relation before dump. Web Push was off for both tenants and the preflight
  found zero cross-user live-owner conflicts.
- A dump attempted through the bounded migrator was correctly rejected by FORCE RLS. The separate
  container backup administrator produced a mode-`0600` custom-format dump of `1,436,479` bytes
  with SHA-256 `f812d5529931034a61950887de6254b1a5cd35e4d9dedba5fdc710383e6eec18`;
  the PostgreSQL 16.14 TOC was readable. A real restore into a second `_verify` database reproduced
  the exact 80-row ledger digest
  `4e732939c2632f937c78e016c33fec38494e162471cd85b458a85845006857fe` and all
  tenant/channel/status row counts. The restored endpoint relation occupied `5,169,152` bytes;
  these local sizes and timings are not production capacity or RTO evidence.
- No ACK and the fresh-database token on the non-empty baseline both failed with
  `CHAT_PUSH_FOUNDATION_MAINTENANCE_REQUIRED` before DDL. Adding a harmless sixth pending file failed
  with `CHAT_PUSH_FOUNDATION_MAINTENANCE_UNEXPECTED_PENDING`; ledger and catalog stayed unchanged.
- With an `ACCESS EXCLUSIVE` lock held longer than five seconds, 0070 failed on `lock_timeout` after
  the separately committed 0069; neither new endpoint index nor the new CHECK remained. The retry
  applied 0070–0072. A second long lock on `tenant_runtime_settings` made 0073 fail atomically with
  no reminder columns or tables, and the next runner applied only 0073.
- A separate restore with one synthetic cross-user live address conflict made 0070 fail closed with
  stable PostgreSQL code `P0001`; it left no 0070 index or constraint residue.
- A separate two-runner restore held the endpoint table lock for three seconds, below the five-second
  limit. The catalog showed one advisory lock holder and one waiter; one official runner applied
  exactly 0069–0073, the other completed as a no-op, and post-role verification passed.
- Final catalog checks found all five exact ledger rows, all six expected valid/ready indexes, the
  validated endpoint status CHECK, default-off reminder binding columns, validated reminder
  constraints, forced RLS and exactly one canonical tenant policy on each of the five runtime-written
  tables. Per-tenant read-only checks returned 5,000 endpoints, zero owner conflicts, zero reminder
  anomalies and both runtime gates off.
- The opt-in role suite passed `19/19` on PostgreSQL 16: six URL guards and all 13 live ACL/RLS drift
  cases. The booking-reminder PostgreSQL suite passed `9/9`; the current-main Communities direct
  invite and media quota/concurrency suites passed `4/4` and `8/8`. A subsequent canonical
  post-verifier passed. The final official run without ACK was a clean no-op, and the ledger
  contained `85/85` exact checksums with digest
  `067078462239c41f157c816d77ffcc1f90efd6be716e70ed3f092063b61c988d`.
- No provider was called, no shared service or database was mutated, and no endpoint plaintext,
  credential or DSN is retained in this evidence.

## Independent R4 review verdicts

- Architecture: `APPROVE` for the current-main semantic union; current source retains both sides of
  all eight overlaps without a blocker/high code finding.
- Security: `APPROVE`; no blocker/high/medium bypass, leak or denial-of-service finding remains in
  the exact current-main source snapshot.
- Data migration: `APPROVE`; no P0/P1/P2 finding remains in the current-main 0069–0073 design,
  workflow ordering or recorded PostgreSQL 16 rehearsal.
- Cross-system integration: `APPROVE`; no actionable code finding remains across chat, Web Push,
  booking foundation, Communities, media and the staging backup/restore overlap.

## External release gates still open

Production remains `NO-GO` until all of the following are captured for this exact frozen source and
the immutable image built from it:

1. Rehearse the exact target ledger and target data on a production-like clone. The current-main
   10,000-row synthetic run does not replace verified target backup/restore, measured target volume,
   lock behavior or the keyring-authorized offline decrypt-and-canonicalize endpoint audit.
2. Execute the maintenance window with writers drained, all new global/tenant gates off, pre/post
   role-boundary PASS and exact five-row ledger/catalog readback.
3. Build once and promote the same immutable digest to staging. Capture multi-replica readiness,
   Alertmanager routing and a bounded RabbitMQ interruption showing `503 -> reconnect -> 200`,
   consumer re-registration and no duplicate fanout.
4. Complete Web Push sandbox/VAPID registration and real provider-response delivery, including
   circuit/half-open soak, endpoint invalidation behavior and content-free metrics.
5. Run the authenticated direct-chat verifier against the exact staging digest and its isolated
   Redis/Rabbit/PostgreSQL contour, including HTTP recovery after a real disconnect.
6. Implement and independently verify an authoritative transactional booking lifecycle producer.
   Until then keep the booking producer, global reminder scheduler and every tenant reminder gate
   disabled; booking reminder production activation is explicitly `NO-GO`.

Rollback remains application-first: keep the additive schema, disable new runtime gates and restore
the previous application digest. Do not perform a destructive schema rollback during incident
recovery.
