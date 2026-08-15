# Chats, notifications and moderation rollout runbook

## Scope

Use this runbook when enabling or rolling back messaging, Web/iOS/Android push, connector support or
moderation for a tenant. The database migration is an expand-only foundation; it does not authorize
opening public routes by itself.

For Jetson Nano, use the bounded
[Nano test-contour plan](../plans/nano-chats-notifications-test-contour.md). It records the verified
release baseline, separates the notification slice that is already implemented from chat surfaces
that still require M1/M2 implementation, and defines the load ceiling and acceptance gates for
internal testing. A `200` healthcheck or an existing messaging table does not by itself authorize
enabling chats.

## Preconditions

- The exact immutable API, worker and realtime image digests passed CI and staging.
- A verified PostgreSQL backup exists and restore time is known.
- The final integration head was checked for lower-numbered migrations that are not yet in the
  target ledger; gaps are not reservations because the migrator applies every unseen filename.
- The preflight is repeated for every ID from the approved tenant inventory with transaction-local
  `app.tenant_id`; a global query from an ordinary FORCE-RLS application role is invalid evidence.
- The expand migration passed on the target database before application traffic changes.
- Tenant ownership rows for `messaging`, `notifications` and `moderation` are `LOCAL_ONLY`.
- Connector, Web Push/VAPID, APNs, FCM and moderation-provider credentials exist only in the secret
  manager; database configuration contains references, never secret values.
- Retry limits, DLQ alerts, outbox-age alerts, provider circuits and quarantine expiry alerts are
  active.
- A rollback digest and the operator who can approve rollback are recorded.

## Sequential enablement

1. Keep booking producers/rules and Web Push globally/per-tenant off. Drain legacy API endpoint
   writers and workers before applying 0070–0072.
2. Deploy the migration with all new routes and consumers disabled.
3. Deploy API, then worker, then realtime sequentially and verify readiness after each process.
   Keep `MESSAGING_USER_BLOCK_COMMANDS_ENABLED=false`: all readers must enforce blocks before any
   node may create one.
4. After every legacy API/realtime node is drained, roll
   `MESSAGING_USER_BLOCK_COMMANDS_ENABLED=true` across the new API replicas. Mixed values are safe
   because disabled nodes return 404 while every node already enforces stored blocks.
5. Enable HTTP chat read/write for one internal test tenant. Keep external connectors and push off.
6. Enable realtime and verify reconnect plus sequence-gap recovery through HTTP.
7. Enable in-app notification intents/inbox, then one trigger rule with a synthetic audience.
8. Enable push one platform at a time: Web Push sandbox, APNs sandbox, FCM test project, then the
   corresponding production account. Never switch all platforms in one change window.
9. Enable one messaging connector in sandbox; verify inbound/outbound deduplication and DLQ replay.
10. Enable user reports and CUP moderation. Enable reversible auto-quarantine only after expiry and
    reversal tests pass.
11. Enable an external moderation account only in `SIGNAL_ONLY`; move to `RECOMMEND_ONLY` after
    false-positive review. No authoritative mode exists.
12. Expand tenant coverage gradually while watching the metrics below.

### Maintenance-only foundation migration gate

Migrations `0069_booking_notification_projection_fence.sql` through
`0073_booking_reminder_scheduler.sql` are not ordinary rolling migrations. Both the packaged
migrator and `npm run db:migrate` inspect the ledger before creating or changing any relation and
fail with `CHAT_PUSH_FOUNDATION_MAINTENANCE_REQUIRED` while one of those five files is pending.
The ordinary staging and production paths intentionally do not pass the acknowledgement, so they
stop before DDL instead of applying 0070/0071 beside legacy API or worker processes. Staging has a
separate `CHAT_PUSH_FOUNDATION` maintenance profile described below; selecting another profile can
never reach its acknowledgement.

Use the exact one-shot acknowledgement
`CHAT_PUSH_FOUNDATION_MAINTENANCE_ACK=CHAT_PUSH_FOUNDATION_MAINTENANCE_V1` only after all of these
conditions are recorded for the target:

1. verified backup and restore command;
2. `WEB_PUSH_ENABLED=false`, `MESSAGING_USER_BLOCK_COMMANDS_ENABLED=false` and
   `BOOKING_REMINDER_SCHEDULER_ENABLED=false` on every current replica, with no authoritative
   booking lifecycle producer active;
3. `notifications.tenant_runtime_settings.web_push_enabled=false` for every approved tenant,
   verified under each exact tenant RLS context;
4. every API endpoint-registration writer and every worker stopped and confirmed absent on all
   nodes; no old process may restart during the window;
5. the pre-phase database role verifier, tenant-local duplicate inventory and production-like
   clone/lock rehearsal passed for the exact image digest.
6. the ledger diff proves every packaged migration outside 0069–0073 is already applied. The
   migrator rejects the maintenance acknowledgement with
   `CHAT_PUSH_FOUNDATION_MAINTENANCE_UNEXPECTED_PENDING` if any sixth file is pending; combined
   migration batches need a separate rehearsal and are not authorized by this procedure.

Pass the acknowledgement only to the one-shot migrator process, never to a persistent env file or
application container. The production command is self-contained for the production Compose model:

```bash
set -euo pipefail
cd /opt/phub
read_runtime_database_url() {
  local credential_file="${1:?credential file is required}"
  test -r "$credential_file" || return 1
  test "$(awk -F= '$1 == "DATABASE_URL" { count += 1 } END { print count + 0 }' "$credential_file")" -eq 1 || return 1
  sed -n 's/^DATABASE_URL=//p' "$credential_file"
}
read_migrator_database_url() {
  local credential_file="${1:?credential file is required}"
  test -r "$credential_file" || return 1
  test "$(stat -c %a "$credential_file")" = 600 || return 1
  awk '/^[[:space:]]*($|#)/ { next } /^DATABASE_URL=/ { next } { exit 1 }' "$credential_file" || return 1
  test "$(awk -F= '$1 == "DATABASE_URL" { count += 1 } END { print count + 0 }' "$credential_file")" -eq 1 || return 1
  sed -n 's/^DATABASE_URL=//p' "$credential_file"
}
test ! /etc/phub/runtime.env -ef /etc/phub/migrator.env || exit 64
runtime_database_url="$(read_runtime_database_url /etc/phub/runtime.env)" || exit 64
migrator_database_url="$(read_migrator_database_url /etc/phub/migrator.env)" || exit 64
test -n "$runtime_database_url" && test -n "$migrator_database_url" || exit 64
test "$runtime_database_url" != "$migrator_database_url" || exit 64
case "$runtime_database_url" in postgresql://*|postgres://*) ;; *) exit 64 ;; esac
case "$migrator_database_url" in postgresql://*|postgres://*) ;; *) exit 64 ;; esac
compose() { docker compose --env-file release.env "$@"; }
DATABASE_ROLE_BOUNDARY_PHASE=pre RUNTIME_DATABASE_URL="$runtime_database_url" \
MIGRATOR_DATABASE_URL="$migrator_database_url" \
  compose --profile migration run --rm --no-deps -T \
    -e RUNTIME_DATABASE_URL -e MIGRATOR_DATABASE_URL -e DATABASE_ROLE_BOUNDARY_PHASE \
    --entrypoint node migrator apps/migrator/dist/verify-role-boundary.js || exit 70
MIGRATOR_DATABASE_URL="$migrator_database_url" \
CHAT_PUSH_FOUNDATION_MAINTENANCE_ACK=CHAT_PUSH_FOUNDATION_MAINTENANCE_V1 \
  compose --profile migration run --rm -e CHAT_PUSH_FOUNDATION_MAINTENANCE_ACK migrator || exit 70
DATABASE_ROLE_BOUNDARY_PHASE=post RUNTIME_DATABASE_URL="$runtime_database_url" \
MIGRATOR_DATABASE_URL="$migrator_database_url" \
  compose --profile migration run --rm --no-deps -T \
    -e RUNTIME_DATABASE_URL -e MIGRATOR_DATABASE_URL -e DATABASE_ROLE_BOUNDARY_PHASE \
    --entrypoint node migrator apps/migrator/dist/verify-role-boundary.js || exit 70
```

For staging, use its own credential paths and both required Compose env files; do not copy the
production invocation verbatim:

```bash
set -euo pipefail
cd /opt/phub
read_runtime_database_url() {
  local credential_file="${1:?credential file is required}"
  test -r "$credential_file" || return 1
  test "$(awk -F= '$1 == "DATABASE_URL" { count += 1 } END { print count + 0 }' "$credential_file")" -eq 1 || return 1
  sed -n 's/^DATABASE_URL=//p' "$credential_file"
}
read_migrator_database_url() {
  local credential_file="${1:?credential file is required}"
  test -r "$credential_file" || return 1
  test "$(stat -c %a "$credential_file")" = 600 || return 1
  awk '/^[[:space:]]*($|#)/ { next } /^DATABASE_URL=/ { next } { exit 1 }' "$credential_file" || return 1
  test "$(awk -F= '$1 == "DATABASE_URL" { count += 1 } END { print count + 0 }' "$credential_file")" -eq 1 || return 1
  sed -n 's/^DATABASE_URL=//p' "$credential_file"
}
test ! /etc/phub/staging.env -ef /etc/phub/staging.migrator.env || exit 64
runtime_database_url="$(read_runtime_database_url /etc/phub/staging.env)" || exit 64
migrator_database_url="$(read_migrator_database_url /etc/phub/staging.migrator.env)" || exit 64
test -n "$runtime_database_url" && test -n "$migrator_database_url" || exit 64
test "$runtime_database_url" != "$migrator_database_url" || exit 64
case "$runtime_database_url" in postgresql://*|postgres://*) ;; *) exit 64 ;; esac
case "$migrator_database_url" in postgresql://*|postgres://*) ;; *) exit 64 ;; esac
compose() { docker compose --env-file infrastructure.env --env-file release.env "$@"; }
DATABASE_ROLE_BOUNDARY_PHASE=pre RUNTIME_DATABASE_URL="$runtime_database_url" \
MIGRATOR_DATABASE_URL="$migrator_database_url" \
  compose --profile migration run --rm --no-deps -T \
    -e RUNTIME_DATABASE_URL -e MIGRATOR_DATABASE_URL -e DATABASE_ROLE_BOUNDARY_PHASE \
    --entrypoint node migrator apps/migrator/dist/verify-role-boundary.js || exit 70
MIGRATOR_DATABASE_URL="$migrator_database_url" \
CHAT_PUSH_FOUNDATION_MAINTENANCE_ACK=CHAT_PUSH_FOUNDATION_MAINTENANCE_V1 \
  compose --profile migration run --rm -e CHAT_PUSH_FOUNDATION_MAINTENANCE_ACK migrator || exit 70
DATABASE_ROLE_BOUNDARY_PHASE=post RUNTIME_DATABASE_URL="$runtime_database_url" \
MIGRATOR_DATABASE_URL="$migrator_database_url" \
  compose --profile migration run --rm --no-deps -T \
    -e RUNTIME_DATABASE_URL -e MIGRATOR_DATABASE_URL -e DATABASE_ROLE_BOUNDARY_PHASE \
    --entrypoint node migrator apps/migrator/dist/verify-role-boundary.js || exit 70
```

After either block, capture the exact five-row ledger and catalog readback documented below before
starting only the new API/worker images. If any check fails, keep writers stopped and all runtime
gates off. A disposable local `_verify` database uses the same explicit acknowledgement; it is not
an activation signal.

#### Dedicated staging foundation profile

`CHAT_PUSH_FOUNDATION` is a non-promotable initial maintenance profile. It runs only when all five
0069–0073 migrations are pending, installs that expand-only foundation and the same candidate API,
worker, realtime and web images, but it does not
enable chat, Web Push, block commands or booking reminders. It does not refresh routing, rewrite
authentication/Home/Communities/Games settings, change Caddy or Nginx, run a provider call, activate
CUP, or create a production-promotion artifact.

Do not dispatch this profile until the separate GitHub Environment
`staging-foundation-maintenance` has all of the following controls:

- at least one required reviewer, with self-review prevented;
- deployments restricted to `main`, with administrator bypass disabled;
- environment variable `STAGING_FOUNDATION_MAINTENANCE_READY_V1` exactly equal to
  `APPROVED_WITH_REQUIRED_REVIEWER_V1`;
- environment variable `STAGING_FOUNDATION_OPERATOR_IDS` containing only the complete
  comma-separated numeric GitHub actor-ID allowlist.

The initial dispatch must be a new first attempt from `main`, not a workflow rerun. Supply
`deploy_confirmation=DEPLOY_STAGING`, the exact
`foundation_maintenance_confirmation=APPLY_CHAT_PUSH_FOUNDATION_STAGING`, the candidate SHA equal
to the dispatched SHA, the exact active staging release SHA, the complete comma-separated tenant-key
inventory, and `foundation_no_booking_producer_confirmation=NO_BOOKING_PRODUCER_ACTIVE`. The last
value is an operator attestation, not automatic evidence: first inspect every external scheduler,
Viva/Node-RED route and event publisher that could emit booking lifecycle events. Leave every
routing, messaging-test, diagnostic and access input empty.

If the initial run reaches `MIGRATION_STARTED` and then fails, do not rerun it and do not dispatch a
new initial profile. Use only `CHAT_PUSH_FOUNDATION_RECOVERY` with
`foundation_maintenance_confirmation=RESUME_CHAT_PUSH_FOUNDATION_STAGING`, the same candidate and
expected pre-maintenance release SHAs, the same tenant/no-producer attestations, and the original
numeric run ID plus original attempt `1`. Recovery requires the original mode-0600 application
snapshot, candidate release digest set, PostgreSQL archive manifest with exact path, byte size and
SHA-256, clone-derived catalog digest,
source-bound monitoring digest and phase marker. The candidate metadata carries the SHA-256 of the
reviewed monitoring rule file, and the host file must match it before recovery state is created. It
rejects rebuilt image drift, a different tenant inventory,
an arbitrary/non-prefix ledger or any missing/changed recovery input. Recovery never takes a new
backup, restores the database, creates a new clone or starts the old writer images. Before the
workflow installs candidate definitions, monitoring or the foundation overlay, it invokes the
already installed release helper in compare-only `prepare-recovery` mode. That step rechecks the
archive size, SHA-256 and `pg_restore --list`, then atomically changes the old healthy phase to
`RECOVERY_STARTED`; drain progress is recorded as
`RECOVERY_DRAINING` and `RECOVERY_WRITERS_DRAINED`. It skips the
image build and downloads the five digest artifacts from the exact original workflow run; those
artifacts must still exist and match the stored candidate release byte-for-byte. The protected
workflow definition still comes from the current `main`, while verify/deploy checkout the exact
original candidate commit, so advancing `main` does not force a different runtime into recovery.
The candidate Compose definition is uploaded to a run-bound same-directory temporary file,
structurally validated and atomically renamed, so an interrupted transfer cannot corrupt the
known-good definition used by failure containment to stop the writers.

The profile then fails closed in this order:

1. bind the workflow file, checkout and five image digests to the exact candidate SHA; reject a
   rerun, different triggering actor, unexpected active release, artifact symlink/extra file or
   malformed digest;
2. verify the current API, worker and realtime are healthy and all global foundation gates are
   absent or false; snapshot the current release and the present/absent state of
   `staging.auth.env`, `staging.override.env`, `staging.communities.env`, `staging.games.env` and the
   foundation overlay;
3. install a final-precedence mode-0600 API/worker-only overlay containing exactly
   `WEB_PUSH_ENABLED=false`, `MESSAGING_USER_BLOCK_COMMANDS_ENABLED=false` and
   `BOOKING_REMINDER_SCHEDULER_ENABLED=false`; realtime and migrator never receive this file;
4. install and syntax-check the candidate alert definitions while preserving the prior
   present/absent file, then require the two exact alerting expressions, labels, durations,
   inactive state, healthy/fresh evaluation and no active alert. Require the exact
   `otel-collector:8889` Prometheus target to be UP with a fresh scrape. Verify the complete tenant
   inventory under each runtime-role RLS context, all messaging and notification tenant gates off,
   zero endpoint/SUSPENDED rows, zero unpublished booking lifecycle outbox events, zero foundation
   semantic rows, exact five-pending 0069–0073 ledger state, split role boundary and exact empty
   projector/DLQ queue shapes, arguments and explicit booking bindings;
5. stop API, worker and realtime, prove zero named containers and zero other runtime-role database
   sessions, then repeat the database and broker checks;
6. bind the API/worker, realtime, migrator and infrastructure-admin observations to the same
   server `system_identifier` and database; require realtime to use the exact runtime role and the
   migrator to use a distinct restricted role. Take the final PostgreSQL archive after the drain,
   perform a real restore and compare a
   content-free ledger/tenant/gate/endpoint fingerprint, then rehearse the exact remaining prefix on
   an owned same-cluster template clone and drop only that marked clone;
7. derive a SHA-256 digest from the clone's complete relation/column/constraint/index/policy
   catalog. After the clone completes, repeat runtime drain, database target/role/session,
   tenant/admin zero-state, Rabbit and role preflight immediately before writing the irreversible
   phase marker and passing `CHAT_PUSH_FOUNDATION_MAINTENANCE_ACK` only to the single target
   migrator invocation;
8. prove exact ledger, clone-equal catalog digest, FORCE-RLS/ACL/default-off/zero-row postconditions
   and a final no-ACK
   migrator no-op, then write the phase marker before any candidate runtime starts;
9. atomically activate the stored candidate release metadata and start/attest API, then worker,
   then realtime, then web by exact digest. After worker readiness, require a current-instance
   operational heartbeat value emitted after that worker started, collection success exactly `1`
   and the current-instance booking-reminder gauge to exist; then require the exact Rabbit topology
   and a monotonic minimum
   30-second quiet window with a final check at or after the deadline and repeated live
   tenant/admin/outbox/queue
   checks before realtime starts. Finish with the live tenant/zero-row check, inactive healthy
   alerts, ordinary web/smoke checks and byte-for-byte preserved-file comparison.

Any unknown/true gate, tenant mismatch, nonzero endpoint or semantic row, extra pending migration,
checksum/catalog/role drift, unvalidated constraint, runtime session, Rabbit backlog, missing alert,
backup/restore/clone failure, lock/timeout, digest mismatch or preserved-file drift is a stop
condition. Before the phase marker the ordinary application snapshot and prior monitoring file may
be restored. At or after the marker, automation keeps API, worker and realtime stopped and must not
restore the database or restart the previous writer images; continuation is possible only through
the exact protected recovery profile above. If the candidate runtime reached
`CANDIDATE_RUNTIME_VERIFIED` but an external web/smoke check fails, keep that exact candidate
running only after rechecking the active release, health and immutable image digest of API, worker,
realtime and web; atomically record `EXTERNAL_SMOKE_FAILED`, and use the same recovery profile for a bounded
re-attestation. Production remains untouched.

The foundation verifier uses bounded connection, statement and client-query timeouts. The one-shot
migrator also bounds its advisory-lock wait to 30 seconds and clears that temporary timeout after
the lock is acquired. Before dispatch, use an administrator read-only catalog query to prove the
exact runtime/realtime and migrator roles can execute `pg_catalog.pg_control_system()`; absence is
a pre-DDL stop condition and must not be repaired by broad `pg_monitor` membership.

### Direct chat M1 runtime gate

An absent `messaging.tenant_runtime_settings` row keeps every messaging capability off. M1 needs
only `http` and `direct`; keep `realtime` and `contextual` off. Preview and apply both require the
current actor to be active with role `admin` and the existing comms-operator authority
`notifications.manage`. Apply rechecks it after taking the tenant advisory lock.

```bash
npm run messaging:runtime:set -- \
  --tenant-key=<internal-test-tenant> \
  --actor-id=<authorized-padlhub-admin-uuid> \
  --http=on \
  --direct=on

npm run messaging:runtime:set -- \
  --tenant-key=<internal-test-tenant> \
  --actor-id=<authorized-padlhub-admin-uuid> \
  --http=on \
  --direct=on \
  --confirm=APPLY_MESSAGING_RUNTIME
```

Do not run the apply command until migration/API/authorization smokes pass. Roll back the capability
with a reviewed `--http=off --direct=off` apply; leave the expand-only schema in place. Enabling
runtime does not create blocks automatically. Migration `0071_messaging_user_blocks.sql` must be
present before the API is deployed. The mutation routes remain 404 while
`MESSAGING_USER_BLOCK_COMMANDS_ENABLED=false`; enable them only after every API/realtime reader has
the block checks. `PUT|DELETE
/user/api/v1/{tenantKey}/messaging/users/{otherUserId}/block` require the direct command guard and
an `Idempotency-Key`. Either directed row closes DIRECT access to both participants without deleting
history; removing A→B does not override B→A. Verify create/list/history/send/read and realtime all
return the existing non-enumerating not-found behavior while blocked before external rollout.
Before rolling any tenant back to an image that predates block enforcement, set
`MESSAGING_USER_BLOCK_COMMANDS_ENABLED=false` everywhere and check that tenant for retained
`messaging.user_blocks`. If any row exists, turn both DIRECT HTTP and realtime off for that tenant
before the old image starts. Preserve the rows; an old reader must never bypass an active block.

### Direct chat realtime M2 gate

Realtime включается только после HTTP/direct M1. До apply проверьте, что
`/health/ready` realtime показывает `redis=true`, `database=true`, `rabbit=true`, exclusive
instance queue и durable quarantine созданы, а HTTP polling проходит на двух тестовых игроках.

```bash
npm run messaging:runtime:set -- \
  --tenant-key=<internal-test-tenant> \
  --actor-id=<authorized-padlhub-admin-uuid> \
  --http=on --direct=on --realtime=on

npm run messaging:runtime:set -- \
  --tenant-key=<internal-test-tenant> \
  --actor-id=<authorized-padlhub-admin-uuid> \
  --http=on --direct=on --realtime=on \
  --confirm=APPLY_MESSAGING_RUNTIME
```

Before any shared-environment smoke, run the process-level verifier on a disposable local/CI
contour. `DATABASE_URL` must be a query-free loopback URL for a database ending in `_verify`;
`RABBITMQ_URL` must be a query-free loopback URL for a vhost ending in `_verify`; and `REDIS_URL`
must be query-free and select a non-zero database on loopback. The API, worker and realtime URLs
must also be loopback.
Start API, worker and realtime with those exact dependency URLs and
`LOCAL_RUNTIME_CONTOUR_ATTESTATION=true`. This local/CI-only flag adds credential-free target
fingerprints to readiness; configuration rejects it in staging and production. Before issuing a
ticket or writing chat data, the verifier requires the API fingerprint set to match database plus
Redis, worker to match database plus RabbitMQ, and realtime to match all three targets.
Inject the two synthetic JWTs only through
`DIRECT_REALTIME_VERIFY_PLAYER_A_TOKEN` and `DIRECT_REALTIME_VERIFY_PLAYER_B_TOKEN`, never through
CLI arguments or report output.

```bash
npm run messaging:direct:realtime:verify -- \
  --confirm=RUN_LOCAL_DIRECT_REALTIME_VERIFY \
  --api-base-url=http://127.0.0.1:3000 \
  --realtime-base-url=http://127.0.0.1:3001 \
  --worker-base-url=http://127.0.0.1:3002 \
  --tenant-key=<synthetic-tenant> \
  --recipient-user-id=<synthetic-player-b-uuid> \
  --run-id=<content-free-run-id>
```

The bounded message, buffer and authentication failure cases run without a listening socket in the
default unit suite through an injected transport. The same cases retain a real loopback WebSocket
integration suite, which is mandatory when `CI=true` and can be invoked explicitly outside a
restricted sandbox with:

```bash
DIRECT_REALTIME_LOOPBACK_TEST=true npx vitest run \
  scripts/verify-direct-chat-realtime-e2e.loopback.test.ts
```

A PASS means the verifier connected directly to the validated RabbitMQ vhost and Redis database,
then proved one attestation ticket was stored in that Redis target and consumed by realtime. The
first HTTP send created an identifier-only outbox row, the real worker received a Rabbit confirm and
set `published_at`, the probe received the exact event from that RabbitMQ target, and realtime
delivered the matching `message.created`. The verifier then disconnects, sends a second message,
requires the second exact RabbitMQ event, reconnects with the prior sequence, requires an HTTP
recovery gap and verifies that history contains the second message exactly once. Its content-free
PASS report must contain `rabbitEventMatches=2` and `redisTicketRoundTrips=1`.

The verifier does not create its processes or seed identities. It does create or reuse a synthetic
DIRECT conversation, issues three one-time tickets (attestation, first connection and reconnect),
and writes two messages with their outbox/audit rows. Run it only on a disposable contour whose
orchestrator destroys the whole `_verify` database, Rabbit vhost and isolated Redis database
afterward; the verifier itself does not delete those records.

Принятие: ticket используется один раз; после logout/отзыва permission socket
закрывается; снятие membership запрещает subscribe/fanout; разрыв Rabbit даёт
readiness 503 до повторной регистрации consumer; после reconnect клиент забирает gap через
HTTP. В логах, Rabbit и quarantine не должно быть body сообщения.
Web создаёт ticket/socket только для загруженного DIRECT. Для GAME проверьте отсутствие ticket и
reconnect loop при сохранённом 5-секундном HTTP polling.

Rollback: сначала `--realtime=off` с теми же `http/direct=on`; поллинг остаётся
рабочим. При инциденте HTTP/direct выключаются отдельно. Схему и Rabbit queues не удалять.

### In-app runtime gate

The in-app User API and projector are disabled when a tenant has no runtime-settings row. Preview a
change first, using an active PadlHub user UUID as the attributed operator:

```bash
npm run notifications:runtime:set -- \
  --tenant-key=local-padel \
  --actor-id=<padlhub-user-uuid> \
  --in-app=on
```

Apply only after reviewing the tenant/current/desired values:

```bash
npm run notifications:runtime:set -- \
  --tenant-key=local-padel \
  --actor-id=<padlhub-user-uuid> \
  --in-app=on \
  --confirm=APPLY_NOTIFICATION_RUNTIME
```

The command validates the actor inside the tenant, preserves every gate passed as `keep` or omitted,
and appends an audit record. Use `--in-app=off` for the producer and User API rollback before
draining the projector queue.

### Web Push sandbox gate

Generate one VAPID key pair and keep it stable for the lifetime of existing subscriptions. Store
the private key and the 32-byte endpoint-encryption key in the runtime secret manager; never put
them in Git, a client bundle or the provider-account row. Before enabling a tenant, deploy API and
worker with:

```text
WEB_PUSH_ENABLED=true
WEB_PUSH_ENVIRONMENT=SANDBOX
WEB_PUSH_APP_ID=padlhub-web
WEB_PUSH_ALLOWED_ENDPOINT_ORIGINS=<operator-approved-exact-push-service-origins>
WEB_PUSH_BATCH_SIZE=1
WEB_PUSH_ENDPOINTS_PER_USER_MAX=5
WEB_PUSH_VAPID_SUBJECT=mailto:<operations-address>
WEB_PUSH_VAPID_PUBLIC_KEY=<public-vapid-key>
WEB_PUSH_VAPID_PRIVATE_KEY=<secret-manager-value>
NOTIFICATION_ENDPOINT_ENCRYPTION_KEYS={"v1":"<32-byte-base64-key>"}
NOTIFICATION_ENDPOINT_ACTIVE_KEY_ID=v1
```

For local Docker Compose, create protected files outside the repository and a Compose override that
mounts them as Docker secrets. The command refuses to overwrite an existing key set:

```bash
npm run notifications:web-push:secrets:provision -- \
  --directory=/Users/<operator>/.config/padlhub/secrets/web-push-local \
  --subject=mailto:<operations-address> \
  --allowed-endpoint-origins=<operator-approved-exact-push-service-origins>

docker compose \
  -f compose.yaml \
  -f /Users/<operator>/.config/padlhub/secrets/web-push-local/compose.web-push.yaml \
  config
```

The runtime also accepts `WEB_PUSH_VAPID_PRIVATE_KEY_FILE` and
`NOTIFICATION_ENDPOINT_ENCRYPTION_KEYS_FILE`. Direct secret values remain supported for external
secret-injection systems, but must not be written to shared environment files.
`WEB_PUSH_ALLOWED_ENDPOINT_ORIGINS` is an exact origin allowlist: do not add tenant-controlled,
private, loopback or link-local targets. Registration rejects endpoints outside it, and the worker
rechecks both the origin and the resolved IP address at connection time.
`WEB_PUSH_BATCH_SIZE` limits each tenant to that many deliveries per poll cycle. The worker claims
one delivery per tenant per round, rotates the first tenant between rounds and stops early when a
full round finds no due work, preserving fairness without reducing the documented delivery target
to one attempt per poll interval. Keep the value at `1` for the first staging and production canary;
increase it only after a measured provider-timeout soak shows that one complete cycle stays inside
the readiness and backlog budgets.
Tenant-local failures are isolated and exposed as `webPushCycle.degraded` plus
`tenantFailuresLastCycle` on worker readiness; only a global scheduler/query failure or stalled
forward progress makes the Web Push readiness component fail.
Every provider result is also counted by the bounded `environment` and `outcome` labels plus the
stable worker instance ID. The adapter records no provider account, tenant, user, endpoint or
response body. `WEB_PUSH_CIRCUIT_OPEN` increments when calls are suppressed; the reset window starts
at the observed failure time, and only one half-open probe may call the provider after expiry.
Because suppression is not a provider attempt, finalization fences the lease back to `PENDING`,
reverses the claim-time attempt increment and schedules no earlier than the configured circuit reset.
It writes no delivery-attempt or outbox evidence and cannot exhaust `WEB_PUSH_MAX_ATTEMPTS`.
`WEB_PUSH_ENDPOINTS_PER_USER_MAX` is an API-side live endpoint quota; keep the same value on every
API replica. `ACTIVE` and `SUSPENDED_POLICY` rows count, while exact successful replays and rotations
of an existing live installation do not consume another slot. A new endpoint over quota returns
`409 WEB_PUSH_ENDPOINT_LIMIT_REACHED`.

A physical subscription may have only one live owner per tenant/provider/address hash. Registration
serializes that identity, revokes the old owner's row and creates or reactivates a row belonging to
the authenticated target user; it never rewrites `user_id` on a row referenced by old deliveries.
Before migrations `0070_web_push_endpoint_hardening.sql` and
`0072_web_push_endpoint_status_validation.sql`, set global and tenant Web Push gates off, verify the
capability route is closed on every API replica, and drain API registration requests plus all legacy
workers. Resolve every cross-user live duplicate by reviewed evidence. Migration 0070 repeats the
same check after setting `app.tenant_id` for every row in `identity.tenants`, so it does not depend
on a broad RLS-bypass role; the unique index remains the final fail-closed invariant and never
chooses an owner automatically.

Run the digest-pinned migrator with a dedicated one-shot database credential. Production reads it
only from `/etc/phub/migrator.env`; staging reads it only from
`/etc/phub/staging.migrator.env`. Each mode-`0600` file contains only one `DATABASE_URL` for the
reviewed DDL role. Compose clears inherited runtime env files from the migrator service and injects
that URL only for the migration command. The workflows stop before migration when the file is
missing, contains extra keys, aliases the runtime file, or resolves to the runtime `DATABASE_URL`.
The application runtime role must not own tenant tables and must not hold schema `CREATE` or
equivalent DDL authority. Before the migration command, the immutable migrator image connects with
both URLs only long enough to inspect PostgreSQL catalogs. It fails closed unless the driver-level
wire login equals `session_user`, `session_user` equals `current_user` for each URL, the two login
roles differ, and `current_database()` plus the server system identifier match. Runtime must be
`NOSUPERUSER NOBYPASSRLS NOREPLICATION`, must not
reach any privileged/predefined role or migrator role, hold database-level `CREATE`, or control any
application schema, table, partition, view, materialized view, sequence or foreign table directly or
through membership. Neither runtime nor migrator may hold `ADMIN OPTION` on another role. Runtime
must also have no direct, inherited or `SET`-reachable `TRUNCATE` or
`TRIGGER` privilege on application relations because `TRUNCATE` is outside row-level security. The
bounded migrator role must also be
`NOSUPERUSER NOBYPASSRLS NOREPLICATION`, have no database-level `CREATE`, connect to a writable
primary, immediately own the migration ledger and endpoint table, hold actual `SELECT`/`INSERT` on
the ledger and `SELECT` on endpoints, exactly own `notifications.tenant_runtime_settings`, hold
`USAGE` on all five required schemas, `CREATE` on migration-owned schemas, and
`SELECT`/`REFERENCES` on the identity tables required by 0069–0073. Runtime must have `USAGE` on
both runtime-written schemas. The migrator's notifications and messaging table default ACLs must
each give the exact runtime role, directly, all four bounded DML privileges
`SELECT/INSERT/UPDATE/DELETE`; no grant options, other runtime privilege, `PUBLIC` grant or third
grantee is accepted. The same immutable verifier runs again immediately after migration and
requires all five runtime-written tables—the booking projection fence, both reminder tables and both
messaging block tables—to have the exact migrator owner, enabled and forced RLS, the exact tenant
policy, usable runtime DML and no dangerous runtime privilege. Exact means one and only one policy
per table, the canonical name, `FOR ALL`, `PUBLIC`, `PERMISSIVE`, and normalized equality expressions
for both `USING` and `WITH CHECK`; any missing/extra policy, `OR true`, changed operator, role,
command or permissiveness blocks rollout.
The verifier emits only booleans and stable error codes, never roles, server identifiers or
connection strings. Record the content-free result.

On a disposable loopback PostgreSQL database whose name ends in `_verify`, retain a separate
runtime and migrator URL and prove the catalog check against real `pg_policy` rows. The test
temporarily installs policy, schema-USAGE, default/actual grant-option, non-DML privilege, PUBLIC
table/column and unrelated-grantee drift, requires every drift to fail, restores the canonical
policy/ACLs and requires a final post-phase PASS:

```bash
DATABASE_ROLE_BOUNDARY_PG_VERIFY_RUNTIME_URL=postgresql://<runtime-role>@127.0.0.1:<port>/<name>_verify \
DATABASE_ROLE_BOUNDARY_PG_VERIFY_MIGRATOR_URL=postgresql://<migrator-role>@127.0.0.1:<port>/<name>_verify \
  npm run db:role-boundary:verify
```

Provision this boundary outside the release window while connected as the exact bounded migrator
role (replace identifiers from the approved role inventory, never interpolate a DSN value):

```sql
select coalesce(namespace.nspname, '<GLOBAL>') as scope,
       privilege.grantee, privilege.privilege_type, privilege.is_grantable
  from pg_catalog.pg_default_acl defaults
  left join pg_catalog.pg_namespace namespace
    on namespace.oid = defaults.defaclnamespace
 cross join lateral pg_catalog.aclexplode(defaults.defaclacl) privilege
 where defaults.defaclrole = '<migrator-role>'::regrole
   and defaults.defaclobjtype = 'r'
   and (
     defaults.defaclnamespace = 0
     or namespace.nspname in ('notifications', 'messaging')
   );

-- Only after reviewing the global inventory and approving the effect on every future table:
alter default privileges for role "<migrator-role>"
  revoke all on tables from public;
alter default privileges for role "<migrator-role>" in schema notifications
  revoke all on tables from public;
alter default privileges for role "<migrator-role>" in schema notifications
  grant select, insert, update, delete on tables to "<runtime-role>";
alter default privileges for role "<migrator-role>" in schema messaging
  revoke all on tables from public;
alter default privileges for role "<migrator-role>" in schema messaging
  grant select, insert, update, delete on tables to "<runtime-role>";
```

Do not use `GRANT ALL`. Record a catalog-only readback of `pg_default_acl`; the pre-verifier rejects
every global non-owner table default, any notifications or messaging table default grant to
`PUBLIC`, any grantee other than the exact migrator owner or exact runtime role, missing direct
runtime DML, any runtime grant option,
or any runtime privilege outside `SELECT/INSERT/UPDATE/DELETE`. The post-verifier additionally
explodes each actual relation and non-dropped user-column ACL and rejects every effective PUBLIC
privilege, unrelated grantee, runtime grant option, runtime column grant or other non-DML runtime
privilege on all five tables;
a runtime DML check satisfied only through PUBLIC is never accepted.

```sql
begin transaction read only;
select id from identity.tenants order by id;
select set_config('app.tenant_id', '<tenant-uuid-from-approved-inventory>', true);

select count(*) as endpoint_rows,
       pg_total_relation_size('integration.notification_endpoints') as total_bytes
  from integration.notification_endpoints
 where tenant_id = '<same-tenant-uuid>'::uuid;

select tenant_id, provider_account_id, address_hash, array_agg(distinct user_id) as owners
  from integration.notification_endpoints
 where tenant_id = '<same-tenant-uuid>'::uuid
   and channel = 'PUSH' and status in ('ACTIVE', 'SUSPENDED_POLICY')
 group by tenant_id, provider_account_id, address_hash
having count(distinct user_id) > 1;

rollback;
```

Repeat the transaction for every approved tenant ID. A zero from an unset or mismatched tenant
context is not evidence.

New registrations canonicalize the complete endpoint URL before encryption, request hashing and
ownership hashing. Rows written by an older API may contain hashes of noncanonical spellings, so a
raw-hash duplicate query cannot prove that two old rows target different physical subscriptions.
If `endpoint_rows` is non-zero, activation remains blocked until a keyring-authorized, offline
decrypt-and-canonicalize audit or a reviewed re-registration/backfill plan proves one live owner per
canonical endpoint. Keep decrypted endpoints out of stdout, logs and release evidence. An empty
table is sufficient evidence only when the read used the correct tenant context.

Rehearse on a production-like clone and record the table size, elapsed time and observed locks.
0070 has a 5-second lock timeout and 30-second statement timeout, builds the two bounded indexes
before its short status-constraint swap, and rolls back atomically on timeout. 0072 validates the
new check in a separate transaction. Do not increase either timeout without a new measured review.

After the migrator succeeds, record these content-free catalog postchecks and repeat the live-owner
query above in every tenant context:

```sql
select filename, checksum, applied_at
  from public.schema_migrations
 where filename in (
   '0069_booking_notification_projection_fence.sql',
   '0070_web_push_endpoint_hardening.sql',
   '0071_messaging_user_blocks.sql',
   '0072_web_push_endpoint_status_validation.sql',
   '0073_booking_reminder_scheduler.sql'
 )
 order by filename;

select index_class.relname,
       index_catalog.indisunique,
       index_catalog.indisvalid,
       index_catalog.indisready,
       pg_get_indexdef(index_catalog.indexrelid) as definition,
       pg_get_expr(index_catalog.indpred, index_catalog.indrelid) as predicate
  from pg_index index_catalog
  join pg_class index_class on index_class.oid = index_catalog.indexrelid
 where index_class.relname in (
   'notification_endpoints_live_address_owner_unique_idx',
   'notification_endpoints_live_user_quota_idx',
   'user_blocks_reverse_pair_idx',
   'booking_reminder_schedules_due_idx',
   'booking_reminder_schedules_claim_idx',
   'booking_reminder_schedules_missed_idx'
 );

select conname, convalidated, pg_get_constraintdef(oid) as definition
  from pg_constraint
 where conrelid = 'integration.notification_endpoints'::regclass
   and conname = 'notification_endpoints_status_check';

select attribute.attname,
       attribute.attnotnull,
       pg_get_expr(default_value.adbin, default_value.adrelid) as default_expression
  from pg_attribute attribute
  left join pg_attrdef default_value
    on default_value.adrelid = attribute.attrelid
   and default_value.adnum = attribute.attnum
 where attribute.attrelid = 'notifications.tenant_runtime_settings'::regclass
   and attribute.attname in (
     'booking_reminders_enabled',
     'booking_reminder_ruleset_version',
     'booking_reminder_contract_hash'
   )
 order by attribute.attname;

select conrelid::regclass as relation_name,
       conname,
       convalidated,
       pg_get_constraintdef(oid) as definition
  from pg_constraint
 where conrelid in (
   'notifications.tenant_runtime_settings'::regclass,
   'notifications.booking_reminder_schedules'::regclass,
   'notifications.booking_reminder_recipients'::regclass
 )
 order by conrelid::regclass::text, conname;

select namespace.nspname, relation.relname,
       relation.relrowsecurity, relation.relforcerowsecurity
  from pg_class relation
  join pg_namespace namespace on namespace.oid = relation.relnamespace
 where (namespace.nspname, relation.relname) in (
   ('notifications', 'booking_notification_projection_fences'),
   ('notifications', 'booking_reminder_schedules'),
   ('notifications', 'booking_reminder_recipients'),
   ('messaging', 'user_blocks'),
   ('messaging', 'user_block_commands')
 );

select schemaname, tablename, policyname, qual, with_check
  from pg_policies
 where (schemaname, tablename) in (
   ('notifications', 'booking_notification_projection_fences'),
   ('notifications', 'booking_reminder_schedules'),
   ('notifications', 'booking_reminder_recipients'),
   ('messaging', 'user_blocks'),
   ('messaging', 'user_block_commands')
 )
 order by schemaname, tablename, policyname;
```

Require all five ledger rows, valid/ready indexes with the three exact reminder predicates, the two
PUSH-only endpoint predicates, `booking_reminders_enabled NOT NULL DEFAULT false`, nullable
ruleset/hash binding columns, the validated `tenant_runtime_booking_reminder_binding_check`, all
other validated constraints, forced RLS and the exact tenant-isolation policies. The post-migration
immutable role verifier is the ACL source of truth. Any mismatch blocks the application rollout;
do not repair catalog objects manually during the release window.

For every approved tenant, use a read-only transaction with the exact tenant context and an
operator-recorded UTC rollout boundary. These queries are content-free; any non-zero mismatch is a
stop condition:

```sql
begin transaction read only;
select set_config('app.tenant_id', '<tenant-uuid>', true);

select state, count(*)
  from notifications.booking_reminder_schedules
 where tenant_id = '<tenant-uuid>'::uuid
 group by state
 order by state;

select count(*) as schedule_without_current_fence
  from notifications.booking_reminder_schedules schedule
  left join notifications.booking_notification_projection_fences fence
    on fence.tenant_id = schedule.tenant_id and fence.booking_id = schedule.booking_id
 where schedule.tenant_id = '<tenant-uuid>'::uuid
   and schedule.state = 'PENDING'
   and (
     fence.booking_id is null
     or fence.lifecycle_revision <> schedule.lifecycle_revision
     or fence.lifecycle_event_type = 'booking.cancelled.v1'
   );

select count(*) as lifecycle_fence_without_two_schedules
  from notifications.booking_notification_projection_fences fence
  left join notifications.booking_reminder_schedules schedule
    on schedule.tenant_id = fence.tenant_id and schedule.booking_id = fence.booking_id
 where fence.tenant_id = '<tenant-uuid>'::uuid
   and fence.updated_at >= '<rollout-start-utc>'::timestamptz
   and fence.lifecycle_event_type <> 'booking.cancelled.v1'
 group by fence.booking_id
having count(schedule.reminder_kind) <> 2;

select count(*) as emitted_without_outbox
  from notifications.booking_reminder_schedules schedule
  left join audit.outbox_events outbox
    on outbox.tenant_id = schedule.tenant_id and outbox.id = schedule.event_id
 where schedule.tenant_id = '<tenant-uuid>'::uuid
   and schedule.state = 'EMITTED'
   and (outbox.id is null or outbox.event_type <> 'booking.reminder.due.v1');

select count(*) as expired_claims
  from notifications.booking_reminder_schedules
 where tenant_id = '<tenant-uuid>'::uuid
   and state = 'PENDING'
   and claim_expires_at <= clock_timestamp();

rollback;
```

An exact-origin or connect-time public-network policy denial marks the current delivery terminal and
changes an `ACTIVE` endpoint to `SUSPENDED_POLICY`. Projector and new claimant skip it; retained
pending deliveries are exported separately as
`phub.worker.notifications.push_deliveries_policy_suspended`. Re-register only after reviewing the
cause and pending backlog. During rollout keep Web Push off until every legacy API writer and worker
is drained: an old API can violate the new physical-owner invariant and an old claimant does not
understand the suspension. During rollback to an old API/worker keep Web Push globally and
per-tenant disabled; preserve suspended rows.

Preview and then apply the non-secret provider-account record:

```bash
npm run notifications:web-push:provider:set -- \
  --tenant-key=local-padel \
  --actor-id=<padlhub-user-uuid> \
  --state=on \
  --app-id=padlhub-web \
  --environment=SANDBOX

npm run notifications:web-push:provider:set -- \
  --tenant-key=local-padel \
  --actor-id=<padlhub-user-uuid> \
  --state=on \
  --app-id=padlhub-web \
  --environment=SANDBOX \
  --confirm=APPLY_WEB_PUSH_PROVIDER
```

Only after the API capability route reports the expected provider state, preview and apply the
tenant gate without changing in-app delivery:

```bash
npm run notifications:runtime:set -- \
  --tenant-key=local-padel \
  --actor-id=<padlhub-user-uuid> \
  --web-push=on

npm run notifications:runtime:set -- \
  --tenant-key=local-padel \
  --actor-id=<padlhub-user-uuid> \
  --web-push=on \
  --confirm=APPLY_NOTIFICATION_RUNTIME
```

Rollback order is tenant gate off first, then provider account off. Keep `WEB_PUSH_ENABLED=true`
while already-created jobs reach a terminal state; disable the global flag only for a process-wide
incident. `PROVIDER_ACCEPTED` is not a display or open receipt. The current Web slice does not yet
collect client `DISPLAYED`/`OPENED` receipts.

The delivery worker finalizes only while its 60-second database lease is still current; the Web
Push provider timeout is capped at 30 seconds. An expired/lost lease is reported as `stale` and
must not produce attempt, receipt, provider-link or outbox evidence. A conflicting external
provider message ID for the same delivery aborts the transaction rather than silently replacing
the original link.

Runtime evidence is content-free. Alert and retain release evidence for:

```text
phub.worker.notifications.push_deliveries_due
phub.worker.notifications.push_delivery_oldest_due_age_seconds
phub.worker.notifications.push_deliveries_dead
phub.worker.outbox.oldest_age_seconds
phub.worker.dlq.messages_ready
```

The first two gauges and outbox/DLQ must return to the approved baseline after a smoke or retry
window. `push_deliveries_dead` is durable operator work, not a transient success metric; investigate
by delivery UUID and stable error code without querying or logging endpoint ciphertext.

After enablement, verify the live loopback API without exposing JWT or subscription material:

```bash
npm run notifications:web-push:live-smoke -- \
  --tenant-key=local-padel \
  --tenant-id=<padlhub-tenant-uuid> \
  --user-id=<active-padlhub-user-uuid>
```

The smoke checks capability, encrypted registration, idempotent replay, revocation and durable
command state. It uses a synthetic endpoint and does not create a delivery; final provider
acceptance/display requires a user-granted browser subscription from the `/notifications` screen.

### CUP manual notification gate

The CUP client uses the same HttpOnly PadlHub refresh session but requests an access token with the
dedicated `phub-admin` audience. Grant access only through the audited dry-run/apply command; never
put an admin allowlist in frontend code or issue Admin API tokens to every authenticated user.

When the local API must keep `VIVA_MODE=sandbox` for real projections, a single synthetic CUP OTP
may be enabled without changing normal user authentication:

```text
APP_ENV=local
CUP_DEV_AUTH_ENABLED=true
CUP_DEV_AUTH_PHONE_E164=<one-explicit-local-operator-phone>
CUP_DEV_AUTH_OTP_CODE=<four-digit-local-code>
```

Configuration rejects this switch outside `APP_ENV=local`. The bypass applies only to requests
with platform `cup-admin`, resolves exactly one existing active PadlHub user by the configured
phone and still requires role `admin` plus at least one registered admin-only permission. Every
Admin API route separately enforces its own permission, such as `notifications.manage` or
`gift_certificates.catalog.manage`; the bypass never creates a user from a phone and never bypasses
route authorization. Keep the switch disabled in shared staging and production.

Preview:

```bash
npm run user:access:set -- \
  --tenant-key=local-padel \
  --actor-id=<active-operator-user-uuid> \
  --user-id=<target-operator-user-uuid> \
  --roles=client,admin \
  --permissions=profile.read,notifications.manage
```

Apply after reviewing current and desired access:

```bash
npm run user:access:set -- \
  --tenant-key=local-padel \
  --actor-id=<active-operator-user-uuid> \
  --user-id=<target-operator-user-uuid> \
  --roles=client,admin \
  --permissions=profile.read,notifications.manage \
  --confirm=APPLY_USER_ACCESS
```

The canonical local operator surface is the `phab-api-local` CUP at
`http://127.0.0.1:3001/api/ui/admin`. Its built-in **Notifications** tab calls the PadlHub Admin API
directly from the browser. Configure the CUP container with:

```text
PADLHUB_NOTIFICATION_API_BASE_URL=http://127.0.0.1:3000
PADLHUB_NOTIFICATION_TENANT_KEY=local-padel
```

The PadlHub API must allow both `http://localhost:3001` and `http://127.0.0.1:3001` in
`CORS_ORIGINS`. Start API/worker with the Web Push secret override first, then rebuild the local CUP
from `/Users/<operator>/Desktop/ph-ab`:

```bash
docker compose \
  -f compose.yaml \
  -f /Users/<operator>/.config/padlhub/secrets/web-push-local/compose.web-push.yaml \
  up -d api worker

docker compose -f deploy/docker-compose.local.yml up -d --build phab-api-local
```

The standalone `apps/cup-admin` client on port `5174` remains a development harness, not the active
CUP entry point. Open the local CUP on port `3001` and verify that Web Push and in-app reflect live
capability, while Android and iOS remain disabled until the FCM/APNs adapters and provider
credentials exist. Resolve a known internal phone, send one test campaign, then verify:

- one `notifications.admin_campaigns` row and one recipient row;
- one inbox item when `IN_APP` is selected;
- one pending push delivery per active Web endpoint, eventually `SENT` or a stable failure;
- the same `Idempotency-Key` returns the original campaign with `replayed=true`;
- logs and RabbitMQ contain no title, body, phone or endpoint material.

### Nano CUP binding

On Nano the active operator surface is `https://cup.nano.padlhub.su/api/ui/admin`. Configure its
CUP container with these server-side values and recreate that container:

```text
PADLHUB_NOTIFICATION_API_BASE_URL=https://cup.nano.padlhub.su
PADLHUB_NOTIFICATION_TENANT_KEY=local-padel
ADVERTISING_ENGAGEMENT_SECRET=<same 32+ character value as PadlHub PROMOTIONS_ENGAGEMENT_SECRET>
```

Caddy sends only `/user/api/*`, `/admin/api/*` and `/public/api/*` on the CUP host to PadlHub API;
all other paths stay on the CUP showcase. The browser therefore calls PadlHub through a same-origin
PadlHub-controlled route and no system credential enters the bundle. Before the presentation,
grant one real operator `admin` plus `notifications.manage`, enable in-app delivery for the tenant,
and configure Web Push only when Nano has the VAPID and endpoint-encryption secrets in both API and
worker. Then run:

```sh
sh /opt/phub/verify-cup-integrations.sh local-padel
```

The check validates the four advertising sources, the shared engagement secret without printing
it, CUP-to-PadlHub settings, tenant runtime, optional Web Push provider state and an authorized CUP
operator. It does not send a campaign; final acceptance still requires one operator login, one
recipient preview, one test campaign and an inbox read-back.

Revoke access by applying the desired non-admin roles/permissions. Disable the affected tenant
channel before stopping the delivery worker during an incident.

## Required smoke tests

### Booking notification ruleset M1

Provisioning is an explicit, tenant-scoped operation. Ruleset `booking.ru-ru.v3` installs immutable
`ru-RU` template version 2 and rules, but it never changes
`notifications.tenant_runtime_settings`; the existing in-app/Web Push
gates remain authoritative and default off. Both preview and apply require the actor's current
`identity.user_access_profiles` row to contain role `admin` and permission
`notifications.manage`; apply checks this again inside its transaction. Preview first, then apply
with a unique operator idempotency key:

The v2 templates link to the supported `/bookings` list route. Provisioning creates version 2,
repoints each stable rule and only deactivates an older active template; it never rewrites v1
content. Do not provision a booking-detail deep link until an authoritative booking detail model
and matching Web route exist.

Ruleset v3 widens the content-addressed fingerprint to every canonical template, rule, audience,
channel, active flag and event-definition field. A successful v2 journal row is deliberately not
accepted as v3 activation evidence. Preview and apply v3 with a new idempotency key; never reuse a
v2 key for the v3 request.

```bash
npm run notifications:booking:provision -- \
  --tenant-key=local-padel \
  --actor-id=<active-padlhub-user-uuid> \
  --idempotency-key=booking-ruleset-v3-2026-08-15

npm run notifications:booking:provision -- \
  --tenant-key=local-padel \
  --actor-id=<active-padlhub-user-uuid> \
  --idempotency-key=booking-ruleset-v3-2026-08-15 \
  --confirm=APPLY_BOOKING_NOTIFICATION_RULESET
```

Replaying the same key and ruleset returns the stored result; reusing it for different provisioning
content fails closed. Inspect `notifications.ruleset_provision_commands` and the
`BOOKING_NOTIFICATION_RULESET_PROVISIONED` audit record before enabling a runtime transport.

M1 still does not produce booking events. At this revision the repository has no authoritative
booking command/webhook journal that can emit a canonical lifecycle revision in the same
transaction as the business change. Viva-assisted and browser-derived booking read snapshots are
explicitly non-authoritative and must not be used as producers or repair input. Runtime activation
therefore remains blocked until the booking write owner emits confirmed/changed/cancelled events in
the same authoritative transaction.

The projector now persists a monotonic `notifications.booking_notification_projection_fences` row before it
evaluates runtime gates. Lower revisions and semantic replays are acknowledged without creating an
intent; equal-revision conflicts are dead-lettered, and reminders ahead of lifecycle use the
queue's bounded retry. Accepted confirmed/changed lifecycle events also reconcile two durable
`notifications.booking_reminder_schedules` rows in that same inbox/fence transaction; cancellation
closes pending rows under the same booking advisory lock. Applying this expand-only scheduler does
not authorize activation and does not repair the missing producer boundary above.

Recipient UUIDs are normalized into `notifications.booking_reminder_recipients`; the composite
foreign key to `identity.users(tenant_id,id)` rejects cross-tenant persistence. Each schedule has at
most 50 ordered recipient rows. A disabled tenant gate leaves all pending or expired schedules
untouched; once enabled, terminalization and claims share one bounded `SKIP LOCKED` batch budget.

The scheduler has two independent default-off gates:

```text
BOOKING_REMINDER_SCHEDULER_ENABLED=false
notifications.tenant_runtime_settings.booking_reminders_enabled=false
BOOKING_REMINDER_DATABASE_TIMEOUT_MS=5000
```

In staging or production, global enablement is rejected unless both lateness values are explicitly
present. Product/operations must approve them; the repository's local/CI defaults are not a
production decision. Every worker replica must receive the same values:

```text
BOOKING_REMINDER_HOURS_24_MAX_LATENESS_MS=<approved explicit value>
BOOKING_REMINDER_HOURS_2_MAX_LATENESS_MS=<approved explicit value>
```

The eligible interval is half-open. `HOURS_24` expires at the earlier of its configured late bound
or two hours before start; `HOURS_2` expires at the earlier of its configured late bound or start.
At/after expiry the row becomes `MISSED` with no outbox event. Tenant gate changes require current
`admin` + `notifications.manage`, are dry-run by default, are audited, and fail on a concurrent
runtime change. Enabling reminders also fails unless at least one of IN_APP/Web Push is enabled and
the locked data matches the provisioned canonical `booking.ru-ru.v3` fingerprint: exactly one
active `booking.reminder.default` rule, template `booking.reminder` version `2`, locale `ru-RU`,
category `BOOKING`, the canonical audience/content/deep-link/channel fields and an effective
channel intersecting the desired enabled IN_APP/Web Push transport. A custom/old/extra rule,
missing canonical provision journal row, template drift or channel mismatch fails closed:

An enabled tenant row also persists the exact canonical ruleset version and contract hash. OFF
atomically clears both values. The scheduler requires the exact pair before expired sweep, claim
and finalize; an enabled row with an old/unknown binding changes no schedule and degrades that
tenant cycle with `BOOKING_REMINDER_RUNTIME_CONTRACT_MISMATCH`. If the binding changes after claim,
finalize commits lease release before reporting the same failure, with zero outbox emission.

```bash
npm run notifications:runtime:set -- \
  --tenant-key=local-padel \
  --actor-id=<active-authorized-padlhub-user-uuid> \
  --booking-reminders=on

npm run notifications:runtime:set -- \
  --tenant-key=local-padel \
  --actor-id=<active-authorized-padlhub-user-uuid> \
  --booking-reminders=on \
  --confirm=APPLY_NOTIFICATION_RUNTIME
```

Before staging activation, apply the final migrations to a disposable PostgreSQL 16 database whose
name ends in `_verify`, then run the retained concurrency regression. The verifier rejects a
non-loopback host, URL query/hash overrides and a database without that suffix. It writes and
cleans only fixed synthetic tenants in that disposable database:

```bash
BOOKING_REMINDER_PG_VERIFY_URL=postgresql://<verify-role>@127.0.0.1:<port>/<name>_verify \
  npm run db:booking-reminders:verify
```

Require the two-scheduler locked-row/batch-budget case, other-tenant progress, expired-lease
takeover, cancellation between claim/finalize, cross-tenant recipient FK rejection and planner use
of the due/claim partial indexes to pass. The same real-database suite must reject a legacy v2
binding before any schedule mutation, prove only locked canonical v3 activation permits emission,
reject boolean-only ON/off-with-binding writes at the database constraint, and reject a PUSH-only
rule when only IN_APP is desired, changed content, an extra custom active reminder rule and a
missing canonical provision journal row. This local proof does not replace a final-digest staging
rehearsal or production volume/backup evidence.

Safe rollout order is mandatory: provision the exact safe default ACL; pass the immutable pre-role
check; apply migration `0073`; pass the immutable post-role check; deploy every projector/scheduler
worker with the global flag off; prove no boolean-only scheduler worker remains; verify synthetic
schedules, recipient FK/RLS, content-free metrics and alerts; provision the booking ruleset and
prove at least one complete transport; approve and set one identical lateness pair on every replica;
only then add an authoritative producer; enable the global scheduler; finally enable one tenant.
Never enable a producer while any old projector can consume lifecycle events without creating
schedule rows, and never write the tenant binding while a scheduler that ignores version/hash is
running. Rollback before producer activation is gate-off with the current command: tenant OFF must
commit `false/null/null`, then global OFF, before an old image is allowed. After producer activation,
first stop the authoritative producer and prove its lifecycle outbox and Rabbit routes drained or
quarantined; then turn off tenant/global scheduler gates with the current command, retain both
reminder tables and binding columns, run the fence/schedule reconciliation above, and only then
allow an old-worker rollback. Already published reminders cannot be recalled. Browser projection
is forbidden for repair, and whole-database restore is disaster recovery rather than normal
rollback.

- With no messaging runtime row, chat routes return `MESSAGING_DISABLED`; with HTTP only they return
  `DIRECT_MESSAGING_DISABLED`.
- Create a direct conversation twice with one key and verify one canonical pair. A missing,
  inactive or `chatPolicy=NOBODY` target must return the same non-enumerating 404.
- Repeat a send command with the same `Idempotency-Key` and `clientMessageId`; only one sequence is
  allocated and the original response is returned.
- Disconnect realtime, create messages, reconnect with `afterSequence`; the client fills the exact
  gap through HTTP without duplicate rendering.
- Block A→B and confirm both users lose DIRECT list/history/send/read and realtime access; unblock
  A→B while B→A remains and confirm access stays closed. Replay both commands with the same keys.
- Revoke `chat.direct.create` in the database while retaining the previously issued test JWT;
  confirm DIRECT list omits previews and block/unblock returns `CHAT_PERMISSION_REQUIRED` without a
  command, block, audit or outbox write. Repeat with an inactive actor and `chatPolicy=NOBODY` target.
- Open a GAME conversation and confirm the Web client uses HTTP polling without issuing a realtime
  ticket; repeat a DIRECT conversation and confirm ticket/socket recovery still works.
- Remove a test member and confirm both HTTP history and WebSocket subscribe reject access.
- Submit the same connector webhook twice and confirm one canonical message/external mapping.
- Register, rotate and invalidate one Web Push subscription, APNs token and FCM token. Confirm a
  provider acceptance is not shown as `DISPLAYED` or `OPENED` until a client receipt arrives.
- For Web Push, verify `GET /notification-endpoints/web/config`, registration replay with the same
  `Idempotency-Key`, conflict with a reused key and different subscription, logout revocation, a
  synthetic accepted send, retryable provider failure and HTTP 404/410 endpoint invalidation.
- Register distinct installations up to the configured quota and verify the next returns
  `WEB_PUSH_ENDPOINT_LIMIT_REACHED`; transfer one physical browser subscription between two users
  and verify only the new user's endpoint is live and old pending deliveries keep the old endpoint
  row. Force an egress-policy denial and verify `SUSPENDED_POLICY` without a provider-invalid mark.
- Trigger one notification twice with the same source event/dedupe key; create one intent.
- Read `GET /user/api/v1/{tenantKey}/notifications`; verify newest-first pagination, a correct
  tenant/user-scoped unread count and `Cache-Control: no-store`.
- Repeat `PUT /user/api/v1/{tenantKey}/notifications/read-cursor` with the same `Idempotency-Key`;
  verify the stored result is replayed. Reuse that key with another item and expect the stable
  `IDEMPOTENCY_KEY_REUSED` conflict.
- Use a `phub-api` token against Admin API and expect 401; use a `phub-admin` token without
  `notifications.manage` and expect 403. Resolve recipients by phone and verify only masked values
  return. Repeat a manual campaign with the same key and verify one campaign/intent/delivery set.
- Submit the same external moderation signal twice; create one case. Confirm the external service
  cannot redact a message or block a user directly.
- Apply and reverse/expire quarantine through an authorized CUP account and inspect the immutable
  action/audit trail.
- Search logs, traces, metrics and RabbitMQ payloads for test message body, email/phone, push token
  and external contact ID; all must be absent.

## Monitoring gates

Stop expansion when any of these persist beyond the alert window:

- growing outbox age, consumer lag or DLQ depth;
- message sequence gaps not recoverable through HTTP;
- provider retry storm or open circuit across more than one tenant;
- unexpected rise in invalid endpoints on one push platform;
- moderation queue age over SLA or quarantine without a future expiry;
- RLS/authorization denial anomaly or any cross-tenant identifier in telemetry.

### Dead-letter retention check

Worker startup must declare `phub.dead-letter.v1` as a durable quorum queue and bind it to the
`phub.dead-letter` topic exchange with routing key `#`. This is shared retention for rejected
events; it does not change the routing keys or delivery policy of existing consumers.

The notification projector queue is intentionally different: it binds only the four explicit
booking source contracts listed in the domain event catalog. During an in-place upgrade the worker
creates those exact bindings first and then removes the legacy `phub.events` / `#` binding. Verify
that `phub.notification-intent-projector.v1` has no wildcard binding before enabling booking rules.
Every future notification-producing vertical must add its versioned routing key to the code-owned
topology manifest and topology test; a database rule alone must not broaden broker consumption.

Before enabling a new tenant or transport, verify the queue and binding in the target environment:

```bash
docker compose exec rabbitmq rabbitmqctl list_queues \
  name durable arguments messages_ready messages_unacknowledged
docker compose exec rabbitmq rabbitmqctl list_bindings \
  source_name destination_name destination_kind routing_key
```

The queue must be durable, have `x-queue-type=quorum`, and have an exchange-to-queue binding from
`phub.dead-letter` to `phub.dead-letter.v1` with `#`. Any non-zero or growing depth blocks rollout
expansion until the cause is identified. Inspect metadata and `x-death` headers without copying
message bodies or endpoint data into logs or incident tickets. Replay only through a reviewed,
idempotent repair after the failing consumer or contract is fixed.

### Automated worker reliability alerts

The worker exports aggregated, content-free OTLP metrics every 15 seconds. Metrics contain no
tenant, user, phone, message, endpoint or provider identifiers. Prometheus evaluates these rules:

| Alert                                       | Condition                                                      | Severity | Required action                                                                              |
| ------------------------------------------- | -------------------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------- |
| `PadlHubDeadLetterQueueNotEmpty`            | Retained DLQ depth is non-zero for 1 minute                    | P1       | Stop expansion, identify the rejecting consumer and preserve the event for reviewed replay.  |
| `PadlHubOutboxDelayed`                      | Oldest unpublished event is 30-300 seconds old for 5 minutes   | P2       | Inspect publisher throughput and RabbitMQ confirms before increasing tenant coverage.        |
| `PadlHubOutboxStalled`                      | Oldest unpublished event is over 300 seconds old for 2 minutes | P1       | Stop producers if growth continues and restore publication before replaying downstream work. |
| `PadlHubOutboxPublishFailures`              | A publish cycle failed in the last 5 minutes                   | P1       | Inspect PostgreSQL/RabbitMQ connectivity and correlation-safe worker logs.                   |
| `PadlHubOperationalMetricsCollectionFailed` | PostgreSQL/RabbitMQ snapshot failed for 2 minutes              | P2       | Treat backlog monitoring as blind until collection is restored.                              |
| `PadlHubPushDeliveryDelayed`                | Oldest active-endpoint due delivery is 60-300s old for 5m      | P2       | Inspect provider latency, retry policy and tenant fairness.                                  |
| `PadlHubPushDeliveryStalled`                | Oldest active-endpoint due delivery is over 300s for 2m        | P1       | Stop expansion and restore delivery progress.                                                |
| `PadlHubPushDeliveriesDead`                 | Any terminal push delivery remains for 1m                      | P1       | Classify stable error codes before replay or expansion.                                      |
| `PadlHubPushPolicySuspended`                | Retained policy-suspended push backlog remains for 5m          | P2       | Review endpoint policy and backlog before reactivation.                                      |
| `PadlHubWebPushCycleFailed`                 | Web Push cycle remains degraded for 2m                         | P1       | Inspect global query/forward progress and tenant failures.                                   |
| `PadlHubWebPushTenantFailures`              | Any isolated tenant failure in 5m                              | P2       | Repair that tenant while verifying later tenants still progress.                             |
| `PadlHubWebPushCircuitOpen`                 | Any provider circuit suppression in 5m for 1m                  | P1       | Stop expansion; inspect bounded provider outcomes and restore one half-open probe.           |
| `PadlHubBookingReminderDelayed`             | Enabled-tenant reminder is due for over 60s for 2m             | P2       | Stop expansion; inspect scheduler readiness, leases and tenant configuration.                |
| `PadlHubBookingReminderSchedulerFailed`     | Current/recent scheduler cycle failure                         | P1       | Keep producer/runtime gates off until a complete fair cycle succeeds.                        |
| `PadlHubBookingRemindersMissed`             | Any reminder crosses its approved late boundary in 5m          | P1       | Preserve schedule/outbox evidence; do not replay without authoritative reconciliation.       |
| `PadlHubRealtimeHeartbeatStale`             | Freshest realtime timestamp heartbeat is over 60s old for 1m   | P1       | Keep HTTP fallback and restore the process/OTLP export before expansion.                     |
| `PadlHubRealtimeMetricsAbsent`              | Realtime timestamp heartbeat series is absent for 2m           | P1       | Treat realtime monitoring as blind; inspect process and scrape target before expansion.      |
| `PadlHubRealtimeReplicaCountLow`            | Fresh unique instances are below the declared target for 1m    | P1       | Keep HTTP fallback; repair the missing replica or inconsistent target before expansion.      |
| `PadlHubRealtimeConsumerUnavailable`        | Realtime consumer ready gauge is zero for 2m                   | P1       | Keep HTTP fallback, restore Rabbit consumer, then verify gap recovery.                       |
| `PadlHubRealtimeConsumerFailures`           | Any realtime consumer failure in 5m                            | P1       | Inspect Rabbit/projection failure and reconnect state.                                       |
| `PadlHubRealtimeEventsQuarantined`          | Any invalid realtime event in 5m                               | P1       | Preserve hash-only evidence and repair the producer contract.                                |
| `PadlHubRealtimeReconnects`                 | More than two Rabbit reconnects in 10m                         | P2       | Inspect broker/network stability before expansion.                                           |

Each realtime process records its current Unix timestamp every 15 seconds on
`phub.realtime.process.heartbeat_unixtime` with a `service.instance.id` measurement label and
records `REALTIME_EXPECTED_REPLICAS` on `phub.realtime.process.expected_replicas`. Every realtime
readiness gauge and failure/fanout counter carries that same instance label, so two replicas never
collapse into one conflicting Prometheus series.
`PadlHubRealtimeHeartbeatStale` compares Prometheus time with the freshest value, so a collector's
cached last gauge cannot look alive forever; `PadlHubRealtimeMetricsAbsent` remains a supplementary
missing-series fail-safe. Set `OTEL_SERVICE_INSTANCE_ID` to a stable unique value per production
replica and set the same non-zero `REALTIME_EXPECTED_REPLICAS` value on every replica. The hostname
fallback is suitable only when the platform guarantees unique container hostnames. The replica-count
alert joins expected targets only to fresh instance heartbeats, compares the resulting target with
the fresh unique instance count, and also fails when a live instance omits or disagrees on the
target. A stale target from a stopped replica cannot keep an old rollout target active. Consumer
readiness is likewise evaluated only for the matching fresh instance. Before expansion, stop one
replica and prove the alert reaches Alertmanager; then restore it and prove the alert resolves.
Staging and production realtime refuse startup when `REALTIME_EXPECTED_REPLICAS` is omitted; the
default of one is only for local/CI execution.

Backlog depth alone does not change `/health/ready`: restarting a worker does not repair retained or
delayed work and can amplify an incident. Readiness requires PostgreSQL, RabbitMQ, optional Viva
sync Redis, and recent successful forward progress by the worker core cycle. A new worker stays
unready until its first complete core cycle succeeds. Any failed cycle makes it unready until a
later complete cycle succeeds; a running cycle becomes stale when it has made no progress within
`max(30s, 3 * OUTBOX_POLL_INTERVAL_MS, 2 * OUTBOX_CONFIRM_TIMEOUT_MS)`. The readiness response
exposes only content-free `checks` and `coreCycle` state/age fields.

The active tenant list is read globally in deterministic UUID order. Failure to read that list fails
the whole cycle. Work after that boundary is tenant-local: a lifecycle or outbox failure for one
tenant is logged and marks the complete cycle failed, but does not prevent the remaining tenants
from running. The starting offset advances by one on each cycle, including partially failed cycles,
so a repeatedly slow or failing tenant cannot permanently occupy the first slot. Progress is
recorded after every attempted tenant, including failures; readiness still remains false until one
complete cycle finishes without any tenant failure. A terminal RabbitMQ failure sets shutdown state,
which stops the orchestrator from starting another tenant and proceeds through fail-fast exit.

An unexpected RabbitMQ connection `error` or `close` is terminal because all publisher and consumer
channels belong to that connection. The worker first drops readiness, then performs a cleanup
bounded to five seconds and exits with status 1. The configured supervisor must restart it; after
restart, require a successful core cycle and restored consumers before reopening rollout gates. If
the process remains running after a logged terminal Rabbit event, treat supervisor/runtime wiring as
broken rather than manually marking the worker healthy.

Validate both local and Jetson rule copies before promotion:

```bash
cmp infra/monitoring/padlhub-alerts.yaml deploy/jetson/monitoring/padlhub-alerts.yaml
docker compose --profile monitoring exec -T prometheus \
  promtool check rules /etc/prometheus/rules/padlhub-alerts.yaml
docker run --rm --entrypoint promtool \
  -v "$PWD/infra/monitoring:/rules:ro" \
  prom/prometheus:v3.2.1 test rules /rules/padlhub-alerts.test.yaml
```

### Transactional outbox confirm bound

`OUTBOX_CONFIRM_TIMEOUT_MS` applies to both transactional and leased publishers. In transactional
mode, the database row lock is held only until RabbitMQ confirms the batch or this bound expires.
On timeout, the transaction rolls back, the event remains unpublished, the core cycle is marked
failed, and readiness stays false until a later complete cycle succeeds.

A broker may accept an event immediately before the local confirm deadline. Retrying that
unpublished row can therefore deliver the same event again; all consumers must deduplicate on event
`id`. Realtime keeps a bounded cache of recent event IDs per process and reuses it across Rabbit
reconnects. The cache is deliberately not global because every realtime instance must receive the
broadcast event for its local sockets. After process restart or cache eviction, Web merging by
conversation `sequence` plus HTTP recovery remains the final idempotent effect. Do not raise the
timeout to mask RabbitMQ latency. Investigate connection/channel health,
broker resource alarms, confirm latency and outbox age. A repeated
`OUTBOX_CONFIRM_TIMEOUT` blocks rollout expansion even if the TCP connection has not emitted a
terminal event.

### Leased outbox staging gate

Migration `0031_outbox_publish_leases.sql` is expand-only: it adds nullable claim metadata and a
tenant-first partial index. Deploy it before the worker package. The worker remains on the existing
transactional publisher unless `OUTBOX_PUBLISH_MODE=leased` is set explicitly; configuration
rejects leased mode in production.

For one staging worker, set:

```text
APP_ENV=staging
OUTBOX_PUBLISH_MODE=leased
OUTBOX_BATCH_SIZE=50
OUTBOX_CLAIM_TTL_MS=60000
OUTBOX_CONFIRM_TIMEOUT_MS=10000
OUTBOX_FAILURE_BACKOFF_MS=5000
```

The claim transaction commits before RabbitMQ publication. Successful publisher confirms are
followed by a separate token-guarded finalize transaction. A crash before publication is recovered
after lease expiry. A crash after broker confirm but before finalize can deliver the same event
again, so every consumer must continue deduplicating by event `id`; the lease changes lock duration,
not the platform's at-least-once contract.

Do not expand the gate while outbox age, publish failures or DLQ depth grows. To roll back, stop all
leased workers, wait at least `OUTBOX_CLAIM_TTL_MS`, then restart with
`OUTBOX_PUBLISH_MODE=transactional`. A final idempotent duplicate is possible for events confirmed
before a crash. Keep the nullable columns and index; do not reverse the migration during an
incident.

#### P0.4 isolated crash-soak gate

Before enabling leased mode on a shared staging worker, run the repository soak against a disposable
PostgreSQL database and RabbitMQ vhost whose names end in `_verify`. The command refuses any other
target. Never point it at the application database or vhost.

The soak starts independent worker processes with real RabbitMQ confirm channels and a durable
verification queue compatible with RabbitMQ 4. It forces one
process to exit after committing a claim and another after receiving broker confirms but before the
finalize transaction. It then proves lease recovery, the exact at-least-once duplicate set, an empty
DLQ, visible degraded outbox metrics and a clean final snapshot.

```bash
# Provision isolated resources using credentials from the target secret manager.
createdb <padlhub_outbox_verify>
rabbitmqctl add_vhost <padlhub_outbox_verify>
rabbitmqctl set_permissions -p <padlhub_outbox_verify> <worker-user> '.*' '.*' '.*'

DATABASE_URL=<isolated-postgresql-url> \
RABBITMQ_URL=<isolated-amqp-url> \
npm run outbox:lease:soak
```

The gate passes only when all seeded rows are published, the two expired claim batches have exactly
two attempts, only the confirm-before-finalize batch appears twice in RabbitMQ, and both outbox
backlog and DLQ depth return to zero. Delete the disposable database and vhost after retaining the
content-free JSON result in the release evidence.

## Incident controls

- Disable the affected tenant producer before stopping consumers, so queues can drain predictably.
- Disable only the failing connector/provider account when the canonical chat/inbox can remain
  available.
- For a push incident, keep in-app notifications active and disable Web Push, APNs or FCM
  independently.
- For an external moderation incident, disable its integration account; continue PadlHub reports
  and CUP review. Expire or review outstanding quarantines explicitly.
- Replay DLQ messages only after fixing the cause and confirming inbox/provider idempotency.
- Do not edit message rows, delivery attempts or moderation actions manually. Use an audited repair
  command or a reviewed, predicate-guarded reconciliation script.

## Rollback

1. Disable the newest tenant/platform/connector feature gate.
   Before an application rollback that predates user-block enforcement, disable block mutations
   globally and disable DIRECT HTTP/realtime for every tenant that has a retained block row.
2. Stop newly introduced producers and let already claimed jobs reach a stable state or lease
   expiry.
3. Roll API, worker and realtime back sequentially to the recorded image digests, checking
   readiness and HTTP history after each step.
4. Keep the expand-only tables and columns. Do not run a destructive database rollback during the
   incident.
5. Verify outbox/inbox lag, message history, notification terminal states, provider circuits and
   moderation quarantine expiry.
6. Record release, tenant, correlation IDs, affected delivery/case IDs and operator decisions in
   the incident timeline without copying message content or endpoint addresses.
