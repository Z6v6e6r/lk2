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
- The expand migration passed on the target database before application traffic changes.
- Tenant ownership rows for `messaging`, `notifications` and `moderation` are `LOCAL_ONLY`.
- Connector, Web Push/VAPID, APNs, FCM and moderation-provider credentials exist only in the secret
  manager; database configuration contains references, never secret values.
- Retry limits, DLQ alerts, outbox-age alerts, provider circuits and quarantine expiry alerts are
  active.
- A rollback digest and the operator who can approve rollback are recorded.

## Sequential enablement

1. Deploy the migration with all new routes and consumers disabled.
2. Deploy API, then worker, then realtime sequentially and verify readiness after each process.
3. Enable HTTP chat read/write for one internal test tenant. Keep external connectors and push off.
4. Enable realtime and verify reconnect plus sequence-gap recovery through HTTP.
5. Enable in-app notification intents/inbox, then one trigger rule with a synthetic audience.
6. Enable push one platform at a time: Web Push sandbox, APNs sandbox, FCM test project, then the
   corresponding production account. Never switch all platforms in one change window.
7. Enable one messaging connector in sandbox; verify inbound/outbound deduplication and DLQ replay.
8. Enable user reports and CUP moderation. Enable reversible auto-quarantine only after expiry and
   reversal tests pass.
9. Enable an external moderation account only in `SIGNAL_ONLY`; move to `RECOMMEND_ONLY` after
   false-positive review. No authoritative mode exists.
10. Expand tenant coverage gradually while watching the metrics below.

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
  --subject=mailto:<operations-address>

docker compose \
  -f compose.yaml \
  -f /Users/<operator>/.config/padlhub/secrets/web-push-local/compose.web-push.yaml \
  config
```

The runtime also accepts `WEB_PUSH_VAPID_PRIVATE_KEY_FILE` and
`NOTIFICATION_ENDPOINT_ENCRYPTION_KEYS_FILE`. Direct secret values remain supported for external
secret-injection systems, but must not be written to shared environment files.

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

- Repeat a send command with the same `Idempotency-Key` and `clientMessageId`; only one sequence is
  allocated and the original response is returned.
- Disconnect realtime, create messages, reconnect with `afterSequence`; the client fills the exact
  gap through HTTP without duplicate rendering.
- Remove a test member and confirm both HTTP history and WebSocket subscribe reject access.
- Submit the same connector webhook twice and confirm one canonical message/external mapping.
- Register, rotate and invalidate one Web Push subscription, APNs token and FCM token. Confirm a
  provider acceptance is not shown as `DISPLAYED` or `OPENED` until a client receipt arrives.
- For Web Push, verify `GET /notification-endpoints/web/config`, registration replay with the same
  `Idempotency-Key`, conflict with a reused key and different subscription, logout revocation, a
  synthetic accepted send, retryable provider failure and HTTP 404/410 endpoint invalidation.
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

Backlog does not change `/health/ready`: restarting a healthy worker does not repair retained or
delayed work and can amplify an incident. Readiness remains dependency-based; alerts drive
containment. Validate both local and Jetson rule copies before promotion:

```bash
cmp infra/monitoring/padlhub-alerts.yaml deploy/jetson/monitoring/padlhub-alerts.yaml
docker compose --profile monitoring exec -T prometheus \
  promtool check rules /etc/prometheus/rules/padlhub-alerts.yaml
```

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
