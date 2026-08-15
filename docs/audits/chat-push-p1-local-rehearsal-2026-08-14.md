# Chats and Web Push P1 local rehearsal — 2026-08-14 (historical)

> Historical pre-integration evidence only. Branch, base, source digest, counters, hashes and review
> verdicts below were superseded by the integrated 2026-08-15 freeze. Do not use this file as a
> release attestation; use
> [chat-push-p1-integrated-readiness-2026-08-15.md](./chat-push-p1-integrated-readiness-2026-08-15.md).

## Verdict and authority boundary

- Local source, migration and single-replica runtime rehearsal: `PASS` with the limitations below.
- Immutable staging checkpoint: blocked until this patch is integrated onto the current main head,
  rebuilt once and rehearsed under the resulting exact image and migration digests.
- Production activation: `NO-GO` until every external gate in this document is closed.
- Branch: `codex/chat-push-p1-hardening-20260814`; base: `123d690`.
- Final source freeze completed on `2026-08-15` (Europe/Moscow).
- Tracked binary patch SHA-256 before this evidence file:
  `c5b671729a1d2509f568e6a5e0e955ee06328242bd65cbb4e2ba71cf554c84d9`.

The rehearsal used only disposable local containers, synthetic tenants, users, endpoint hashes and
messages. It did not call a push provider, mutate a shared database, deploy, commit or push. No
credential, endpoint URL, ciphertext, message body or personal data is retained here.

## Runtime versions and pinned dependency images

- Node.js: `v22.13.1`; npm: `11.1.0`; PostgreSQL: `16.14`.
- `postgres:16-alpine`:
  `sha256:57c72fd2a128e416c7fcc499958864df5301e940bca0a56f58fddf30ffc07777`.
- `redis:7-alpine`:
  `sha256:6ab0b6e7381779332f97b8ca76193e45b0756f38d4c0dcda72dbb3c32061ab99`.
- `rabbitmq:4-management-alpine`:
  `sha256:0753b75ce99094c385483d89449d532a0544fb85e4942a478b21cc497ab66d33`.
- `otel/opentelemetry-collector-contrib:0.120.0`:
  `sha256:85ac41c2db88d0df9bd6145e608a3cb023f5d8443868adbfbbf66efb51087917`.
- `prom/prometheus:v3.2.1`:
  `sha256:6927e0919a144aa7616fd0137d4816816d42f6b816de3af269ab065250859a62`.

These are rehearsal dependency digests, not PadlHub release-image digests.

## Migration, backup and rollback evidence

The initial synthetic baseline contained `110000` notification endpoints across two tenants:

- `90000` live PUSH rows;
- `10000` revoked PUSH rows;
- `10000` active EMAIL rows;
- total endpoint relation size before dump: `62341120` bytes.

Content-free backup/restore measurements on local tmpfs storage:

- custom-format dump: `10204538` bytes, approximately `0.825s`;
- restore: approximately `4.554s`;
- source and restored counts matched exactly: `58` migrations, `3` tenants, `2000` users,
  `110000` endpoints and the same PUSH/EMAIL status split.

Fail-closed scenarios:

1. A synthetic cross-user live PUSH duplicate caused migration 0070 to fail with
   `cannot enforce Web Push endpoint ownership`. Migration 0069 remained applied; no 0070 ledger
   row, index or replacement CHECK survived the rollback.
2. A held `RowExclusiveLock` caused an ungranted migrator `ShareLock`. On release, 0070 completed
   in `3179.68ms`; 0071 in `13.65ms`; 0072 in `18.9ms`.
3. On a separate restored baseline, the same writer lock caused 0070 to fail with PostgreSQL
   `55P03` at the configured lock timeout. No 0070 ledger row, index or replacement CHECK survived.

The lock/failure scenarios used a temporary bounded runner so they could stop at selected
migrations. The release entrypoint was then exercised separately as described below.

### Exact non-bypass preflight and release entrypoint

The restored synthetic baseline had `59` ledger rows through 0069. The release role was verified as:

```text
current_user=padlhub_release_apply_verify
rolsuper=false
rolbypassrls=false
notification_endpoints owner=padlhub_release_apply_verify
row_security=true
force_row_security=true
```

The exact tenant-local duplicate preflight ran under that role:

| RLS context | Endpoint rows | Relation bytes | Cross-user live PUSH duplicate groups |
| ----------- | ------------: | -------------: | ------------------------------------: |
| unset       |             0 |              - |                                     - |
| verify-a    |         55000 |       53444608 |                                     0 |
| verify-b    |         55000 |       53444608 |                                     0 |

The first official runner invocation stopped before any migration because the rehearsal role lacked
`CREATE` on schema `public`, which the runner needs for
`CREATE TABLE IF NOT EXISTS public.schema_migrations`. After granting that single required schema
privilege, the exact release entrypoint succeeded:

```text
npm run db:migrate
Applied 0070_web_push_endpoint_hardening.sql
Applied 0071_messaging_user_blocks.sql
Applied 0072_web_push_endpoint_status_validation.sql
```

A second invocation was a clean no-op, proving checksum compatibility and idempotency. Postchecks
under the same `NOSUPERUSER NOBYPASSRLS` role returned:

- `62` ledger rows through 0072 and all four expected 0069–0072 entries;
- three expected indexes valid and ready;
- the endpoint status CHECK validated;
- zero endpoint rows with unset tenant context;
- `55000` rows and zero duplicate groups in each explicit tenant context.

Additional catalog/runtime invariants were checked on the successful rehearsal database:

- live-owner and quota partial indexes are PUSH-only;
- two active EMAIL rows may share an address hash across users;
- a second live PUSH owner is rejected while revoked history is retained;
- the three new tables use enabled and forced RLS with tenant USING and WITH CHECK policies;
- a separate non-superuser read showed `0/0/0` rows without context and `1/1/1` for each matching
  tenant in the booking fence, block and block-command tables.

### Database credential boundary verifier

The built migrator verifier connected with two distinct synthetic login roles to the same restored
database and PostgreSQL system identifier. The bounded runtime role had no application DDL
authority; the migrator role had only the effective owner, schema, identity and ledger privileges
needed by the runner and migrations 0069–0072. The content-free successful result was:

```json
{
  "result": "PASS",
  "databaseTargetIdentical": true,
  "rolesDistinct": true,
  "runtimeRestricted": true,
  "migratorDdlReady": true
}
```

The following independently exercised catalog/connection variants all failed closed with stable
codes before migration:

- the same login role on both URLs and a migrator login masked by startup `SET ROLE runtime`;
- a superuser-like runtime role, `REPLICATION`, and membership in `pg_read_server_files`;
- database-level `CREATE`, a `NOINHERIT`/`SET`-reachable application relation owner, and a
  `NOINHERIT`/`SET`-reachable schema writer;
- direct, inherited and `NOINHERIT`/`SET`-reachable `TRUNCATE`, direct table `TRIGGER`, and
  `TRIGGER` on an application view;
- an attacker-owned schema containing fake `pg_roles`, `pg_namespace` and `pg_class` views with a
  hostile startup `search_path`; the verifier reset the path to `pg_catalog` and inspected the real
  catalogs;
- a read-only migrator connection, missing schema `USAGE`, missing identity `SELECT`, and a
  `SET`-only third owner of the endpoint table;
- revoked ledger `SELECT`, revoked ledger `INSERT`, and revoked endpoint `SELECT`.

After each temporary synthetic grant or ownership change was reversed, the built verifier returned
the same `PASS` result. It emitted no URL, role name, system identifier or privilege inventory.

### Booking reminder migration 0073 and scheduler proof

A second disposable PostgreSQL 16 rehearsal exercised the latest split-role contract and migration 0073. Synthetic baseline, migrator and runtime roles were created without production credentials or
data. The compiled release migrator applied the baseline and migrations through 0072, ownership was
transferred to the bounded migrator role, and the exact pre-migration role verifier passed. The same
compiled migrator then applied `0073_booking_reminder_scheduler.sql`; the post-migration role
verifier passed immediately afterwards. The official `npm run db:migrate` entrypoint then completed
as a checksum-valid no-op. The branch-local migration checker reports `63` migrations.

The pre/post verifier proved:

- exact migrator ownership of `notifications.tenant_runtime_settings` before ALTER and of both new
  booking-reminder relations after migration;
- safe non-PUBLIC notification default privileges, exact runtime DML and schema usage, with no
  effective `TRUNCATE` or `TRIGGER` authority;
- enabled and forced RLS plus the exact tenant policy on both schedule and recipient relations.

Negative live cases failed closed with their stable codes when the notification default ACL granted
anything to `PUBLIC`, granted `TRUNCATE`, or omitted required `DELETE`; restoring the reviewed ACL
returned the verifier to `PASS`.

The frozen verifier was then rerun against a fresh disposable split-role database after its policy
inventory was tightened from substring matching to an exact `pg_policy` contract. The retained
suite passed `8/8`: canonical post-state, URL guards, an additional permissive `USING (true)` policy
and a canonical-name `OR true` replacement. Both drift cases failed with
`POST_MIGRATION_NOTIFICATION_TABLE_POLICY_INVALID`; cleanup restored the canonical policy and the
same post verifier passed again.

The retained real-database scheduler regression then passed against the same PostgreSQL major
version. It proved a shared batch bound across expired and due work, `SKIP LOCKED` progress for a
second scheduler and another tenant, expired-claim takeover, cancellation between claim and
finalization without outbox emission, tenant-aware recipient FK rejection, and planner use of the
due and claim indexes with 5000 synthetic schedules. FORCE RLS readback returned zero rows without
tenant context, one schedule and one recipient for the selected tenant, zero cross-tenant rows and
one own-tenant update before rollback. The disposable container and temporary path were removed
after the proof.

The activation contract now shares one content-addressed `booking.ru-ru.v3` object with the
provisioner. Its request hash includes every ruleset, template, rule, audience, channel, active-flag
and event-definition field; the unit regression changes each field independently and requires a new
hash. V3 intentionally does not accept a v2 journal row, so upgrading requires a new preview/apply
idempotency key while all scheduler/runtime gates remain default off. Final canonical template and
rule values are taken from the shared object rather than duplicated SQL literals.

The tenant runtime row now binds reminder ON to the exact canonical v3 ruleset version and contract
hash; OFF is constrained to `false/null/null`. The scheduler verifies the exact pair before expired
sweep/claim and again before finalize. A stale v2 binding changes no schedule; a binding change
after claim commits lease release with zero outbox before reporting a stable mismatch.

An initial fresh disposable PostgreSQL 16 binding rehearsal applied all `63` migrations through the
official runner. The exact synthetic post-migration runtime/migrator boundary suite passed `8/8`,
the scheduler/activation suite passed `9/9`, and the boundary suite passed `8/8` again after
canonical policy restoration. Final review then found that PostgreSQL CHECK constraints accept an
`UNKNOWN` result, so `enabled=true`, a valid version and `hash=NULL` needed an explicit hash
non-null term. After that correction, another fresh PostgreSQL 16 database applied the same `63`
migrations through the official runner; the retained scheduler/activation suite passed `9/9`, the
partial-null write failed with `23514`, and catalog readback returned the exact named constraint
with `convalidated=true`. Activation negatives also include a PUSH-only effective rule when only
IN_APP was desired, stale content, an additional custom active reminder rule, a missing canonical
v3 provision journal row, a v2 binding before claim and a binding downgrade after claim. The
provisioner and runtime activation command use the same tenant advisory lock; apply rechecks the
exact rule/template/fingerprint and effective-channel intersection while holding row locks before
changing the tenant gate. All disposable containers and temporary ACL scripts were removed after
the proofs.

## HTTP, Web Push and realtime evidence

The repository Web Push database verifier passed with synthetic provider outcomes:

- registration replay returned the same durable endpoint;
- an accepted delivery became `SENT` with a `PROVIDER_ACCEPTED` receipt;
- a synthetic gone response became `DEAD` and marked the endpoint `INVALID`;
- IN_APP deliveries became `DELIVERED`; intent states reached `DELIVERED` and `PARTIAL`;
- FORCE RLS catalog flags were present on endpoints, deliveries and commands.

This verifier substitutes a result adapter. It does not prove VAPID, DNS/connect-time egress checks,
a real provider response, service-worker delivery or browser display/open tracking.

The local DIRECT HTTP and process-level realtime rehearsal passed:

- conversation create, send, history and read cursor;
- idempotent create/send/read replay;
- bidirectional block concealment for create/list/history/send/read/realtime, repeated with A→B and
  B→A directed rows, plus restoration after unblock;
- a still-valid JWT containing `chat.direct.create` was rejected with
  `403 CHAT_PERMISSION_REQUIRED` after the database permission was revoked;
- inactive actor, revoked current permission and a `chatPolicy=NOBODY` peer failed closed; rejected
  create/send/read/block attempts left message, command and outbox counts unchanged;
- final readback showed zero active blocks and restored current permissions.

The repository `messaging:direct:realtime:verify` command ran against real local API, worker and
realtime processes sharing a disposable PostgreSQL `_verify` database, Redis and RabbitMQ `_verify`
vhost. In the final run all three processes exposed local/CI-only, credential-free target
fingerprints. Before issuing any ticket or writing chat data, the verifier matched API to the exact
database and Redis targets, worker to the exact database and RabbitMQ targets, and realtime to all
three targets. It then connected its own probes to the same validated RabbitMQ vhost and Redis
database and passed with two synthetic messages:

- an attestation ticket was observed in the selected non-zero Redis database and was then consumed
  exactly once by realtime;
- the first API transaction created its identifier-only outbox row, the worker received Rabbit
  confirm and set `published_at`, the Rabbit probe received the exact event, and realtime delivered
  the exact `message.created` hint;
- while the socket was disconnected, a second API transaction followed the same publisher path;
- the Rabbit probe received the exact second event from the validated `_verify` vhost;
- reconnect from sequence `1` returned latest sequence `2` and an HTTP recovery gap;
- real history returned message `2` exactly once; the Web component regression separately proved
  paged recovery, sequence-order merge, duplicate suppression and pending-hint replay.

The content-free final result was:

```json
{
  "result": "PASS",
  "firstSequence": 1,
  "secondSequence": 2,
  "outboxPublished": 2,
  "rabbitEventMatches": 2,
  "redisTicketRoundTrips": 1,
  "realtimeHints": 2,
  "httpRecoveryMatches": 1
}
```

In a separate interruption rehearsal, `rabbitmqctl stop_app` changed realtime readiness to `503`.
After `rabbitmqctl start_app`, realtime re-registered its consumer and recovered; the worker was
restarted cleanly and a second verifier run passed. Concurrent duplicate delivery across old and
new consumer generations is covered separately by the atomic in-flight deduplication regression;
the verifier does not hold a negative-observation window that would prove the absence of a late
duplicate socket hint. Container stop/start was intentionally not treated as product evidence after
RabbitMQ's disposable tmpfs cookie was recreated with invalid permissions; the bounded broker
stop/start path exercises the intended runtime failure instead.

The first expanded matrix exposed a real defect: `chatPolicy=NOBODY` closed HTTP but not realtime
subscription/fanout. The repository authority query was corrected to recheck current permission,
active peer and peer privacy. A new clean database/process run then passed the complete matrix.

## Monitoring evidence

`promtool` from the pinned repository Prometheus image loaded the production rule file successfully:
`SUCCESS: 21 rules found`.

Booking reminder scheduler measurements carry a stable worker instance ID. A fresh per-instance
heartbeat prevents a stopped replica from masking its replacement, while the terminal MISSED alert
is derived from the latest durable database completion timestamp rather than a process-local batch
result. This covers the mixed case in which one reminder commits MISSED and another reminder in the
same scheduler cycle fails later during finalization.

Realtime now exports the configured expected replica count and every readiness/failure/fanout
instrument with a unique `service_instance_id`. `PadlHubRealtimeReplicaCountLow` joins expected
targets only to fresh heartbeat instances, then fires for a low count, a missing target on a live
instance or disagreement between live instances. Consumer readiness is also joined to the matching
fresh heartbeat, so a stopped process cannot leave a permanent stale failure. Static rule parity,
PromQL parsing and `promtool test rules` passed ten scenarios: booking backlog delay, per-instance
scheduler failure, stale scheduler replacement, durable MISSED fire/resolve, realtime low count,
disagreement, missing target, stale-target resolution, per-instance consumer failure and
stale-consumer resolution. A real multi-replica stop/restore and Alertmanager delivery remain
external platform evidence.

With one local realtime process and OTLP export:

- Prometheus target `up{job="chatpush-rehearsal-otel"}` was `1`;
- exactly one `phub_realtime_process_heartbeat_unixtime` series was present;
- `service_instance_id` was `chatpush-rehearsal-realtime-1`;
- live heartbeat age was `21.06s`.

After a clean realtime shutdown:

- at age `63.29s`, `PadlHubRealtimeHeartbeatStale` was `pending`;
- at age `163.40s`, it was `firing`;
- `PadlHubRealtimeMetricsAbsent` remained inactive because the collector retained the gauge.

This proves the timestamp-freshness rule rejects cached OTLP liveness. It is a single-replica proof;
Alertmanager delivery and a real expected-count shortfall remain platform gates.

## Source gates

On the final worktree state represented by the digest and file hashes below:

- `npm run check`: passed outside the filesystem sandbox, including `219` Vitest files,
  `1292` passed tests and `5` intentionally skipped opt-in database tests, plus typecheck, lint,
  formatting, contracts, builds and runtime import checks;
- the final database-role/workflow focused suite passed `68/68` tests;
- focused migration/integration/security suites: passed;
- the opt-in PostgreSQL scheduler/activation suite passed `9/9`; the split-role policy-drift suite
  passed `8/8` real-database tests, including their always-on connection guard cases;
- `npm run db:migrate:check`: passed for `63` migrations; this checker is static-only;
- `git diff --check`: passed;
- both copies of `padlhub-alerts.yaml` were byte-identical;
- pinned Prometheus `promtool check rules` loaded `21` rules and `promtool test rules` passed all
  ten booking/realtime scenarios;
- `sh -n deploy/jetson/verify-cup-integrations.sh`: passed;
- production app/worker and isolated production/staging migration profiles passed
  `docker compose config --quiet`; rendered production config gave the runtime URL only to
  API/worker/realtime and the distinct one-shot URL only to migrator; rendered staging gave zero
  environment keys to static web and only `DATABASE_URL` to migrator;
- both changed workflow documents parsed as YAML and their migration shell blocks passed `sh -n`.
- final independent architecture, security, migration and integration verdicts are recorded after
  the source freeze below; production rollout remains externally gated regardless of local verdict.

The untracked implementation files present in the code-state digest were content-addressed as:

| File                                                                            | SHA-256                                                            |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `apps/migrator/src/database-role-boundary.ts`                                   | `0ea9b824c6619dfcaa4dd93f334a57bab16d7dc9aaa04d8df90403b944477bbe` |
| `apps/migrator/src/database-role-boundary.test.ts`                              | `eb937b0554c4477a3dcbf150b30edf1a46674829f1f8e2e6517ca52c555e6f85` |
| `apps/migrator/src/database-role-boundary.pg.test.ts`                           | `7e7e5d9f0592f020cfdb494be0dfe97856d45fdbf7bb34b1d941c77509f82970` |
| `apps/migrator/src/verify-role-boundary.ts`                                     | `8f3c582cd43030c06faed863f89822eff3709ee3bc2849166e83cf7a00908d6d` |
| `apps/realtime/src/realtime-metrics.ts`                                         | `5711204f4dda30c3f9ed7ed1b8035046f9ada80849346c2a27d73e567fee1e94` |
| `apps/realtime/src/realtime-metrics.test.ts`                                    | `76081d0cfbb4453b7dbf48b2f581a7dd044e39f85e3b7e5639759a72faa041cd` |
| `apps/worker/src/booking-reminder-scheduler.ts`                                 | `8f87b5e4b5db4d2c3ab1eb7fa89019d3610cfe9bb877005896864078501ba732` |
| `apps/worker/src/booking-reminder-scheduler.test.ts`                            | `c97ffbbd3af88068f0a775b65132e43a37ceb3919d2517bd90879f7604aa1a31` |
| `apps/worker/src/booking-reminder-scheduler.pg.test.ts`                         | `ee95690410e448cf1a7b949ed2971c7cce9cc05e872a08c5552e6a02172a706e` |
| `apps/worker/src/web-push-tenant-cycle.ts`                                      | `af237629bceceb98b47e1d3149f16ef5bbf59c87a321d75997083fb2ccb3420d` |
| `apps/worker/src/web-push-tenant-cycle.test.ts`                                 | `418be67ed8949e7a352045c8febeb45921ea441e8d861877f31997f98354ca2b` |
| `infra/monitoring/padlhub-alerts.test.yaml`                                     | `9f647bbc18cc9d140a8c77f48a4ba24adeea0022833d30697854b8486c38da5f` |
| `packages/database/migrations/0069_booking_notification_projection_fence.sql`   | `bd88f71b4cfe56d9085e2d2ce3edbb2535f60f79304509faa54cb5562476cc75` |
| `packages/database/migrations/0070_web_push_endpoint_hardening.sql`             | `fc1fc3e79151bcaf5aa6d23c62c434a1fed6bf9611aaa1c0790ee3f9905c9f8d` |
| `packages/database/migrations/0071_messaging_user_blocks.sql`                   | `272e0f9b06f6583a2676c632107fc59ecd6f2617fa03e9a4d247fcc044b4fcd1` |
| `packages/database/migrations/0072_web_push_endpoint_status_validation.sql`     | `570ce268ff559b2d291fc46a30408178c1c3af9f21e84b6f33c4572948315632` |
| `packages/database/migrations/0073_booking_reminder_scheduler.sql`              | `6da81aca75b2fec842c6686ceab4ae8479c12f411e260f3c5bbeab173631a22c` |
| `packages/database/src/booking-notification-projection-fence-migration.test.ts` | `fd0b15ff71f2f75d304111486d503d9c9c3ec0ca6fec3d5ec152d2323c619201` |
| `packages/database/src/booking-reminder-scheduler-migration.test.ts`            | `fe2bd82477d6becce4bb980daca3e2b7e070395c60bf37459687466bf3e7333c` |
| `packages/database/src/messaging-user-blocks-migration.test.ts`                 | `e8bd2193eacecb5dd3994173b5e58eabc50867492a9542326943d95e344b4975` |
| `packages/database/src/web-push-endpoint-hardening-migration.test.ts`           | `eeac2e684481ad14a4070984d72fcf6ad211ff8aa09ccb2f143552a9b6fae6ef` |
| `scripts/booking-notification-contract.ts`                                      | `ab567928a84c0ee338ca5b3c52d71e35b65b2288f51ffde33f0f3fb3ccecee62` |
| `scripts/booking-notification-contract.test.ts`                                 | `de1647cbaad7f546dbe42f47781f6f328a5a424411a1c835fd430257e2a9e522` |
| `scripts/padlhub-alerts.test.ts`                                                | `2c167b38540fb49634696d8f4f88b8c13147470fd47c1d492938f0513504d182` |
| `scripts/verify-direct-chat-realtime-e2e.ts`                                    | `3227831cd1c4a6ed08c2b86cea087bb8f725384a8fe194f8f36c78c3357e4d79` |
| `scripts/verify-direct-chat-realtime-e2e.test.ts`                               | `25ab0938376b599ac19df43a8e128f76b88e4e55010a96b0d7b5e83ae8ac6cd5` |

## Independent final review

After the binding CHECK correction and its fresh real-PostgreSQL proof, four independent read-only
reviews returned `APPROVE` with no remaining actionable code finding:

- architecture: canonical v3 single source, exact runtime binding, preclaim/finalize fencing and
  mixed-version rollout/rollback;
- security: activation authorization/locks, downgrade and partial-null paths, tenant RLS/FKs and
  content-safe audit metadata;
- migration: additive 0073 shape, validated binding CHECK, split-role boundary and schema postcheck;
- integration: v2 rejection before mutation, locked v3 activation, after-claim downgrade release
  with zero outbox, and old-worker drain ordering.

These approvals cover the frozen local code state, not production volume, provider behavior,
immutable staging images or the missing authoritative booking producer.

## Remaining release gates

Production activation remains blocked until all of the following are complete:

1. Integrate this patch onto the current main head. This frozen branch is seven commits behind the
   locally cached `origin/main`; no rebase, cherry-pick or merge was authorized in this task. Run the
   complete source and migration rehearsal again on the integrated tree.
2. Build immutable API, worker, realtime and migrator images once; record their digests and promote
   those exact artifacts through staging.
3. Provision the mode-`0600`, DATABASE_URL-only staging and production migrator secret files with a
   reviewed DDL role distinct from the application runtime role; verify role/schema/table
   privileges without logging either URL.
4. Run the migration inventory, legacy PUSH decrypt/canonicalization audit, writer drain,
   production-like storage/lock rehearsal, verified backup/restore/RTO and catalog postchecks using
   approved environment roles. Include the 0073 row-volume, planner, RLS, default-ACL and split-role
   pre/post gates on the final integrated digest.
5. Prove a real sandbox Web Push subscription/provider journey, including public-IP enforcement at
   connect time, VAPID, provider 404/410 mapping, timeout/retry/circuit behavior,
   `SUSPENDED_POLICY`, service-worker display and open handling.
6. Repeat the locally passed API outbox → worker → RabbitMQ → realtime and client gap proof on
   the exact immutable staging image digests before tenant expansion, including a bounded Rabbit
   interruption, readiness `503`, consumer re-registration, recovery to `200` and no duplicate
   fanout.
7. Repeat the locally passed block/permission/membership matrix under staging runtime roles and
   network topology, including the pair-lock concurrency case.
8. Configure stable multi-replica instance IDs and the implemented expected-replica target; add
   approved Alertmanager routing, prove stop/fire/restore/resolve, then run backlog/fairness/provider
   failure soaks. Include scheduler replica replacement and durable MISSED fire/resolve evidence.
9. Keep booking reminder activation disabled until an authoritative booking lifecycle producer is
   implemented, the same explicit product-approved lateness bounds are configured on every worker,
   all projector workers are compatible, and active reminder rule/template plus at least one
   delivery transport pass the activation preflight. The durable scheduler is present but cannot
   manufacture authoritative booking facts.
10. Obtain separate authority for integration, commit/push, staging rollout, production rollout and
    any shared-data operation.

The disposable rehearsal containers, network, tmpfs databases and temporary scripts are removed at
the end of this task. The pulled pinned Prometheus image remains in the local image cache.
