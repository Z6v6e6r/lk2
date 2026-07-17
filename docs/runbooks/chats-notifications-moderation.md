# Chats, notifications and moderation rollout runbook

## Scope

Use this runbook when enabling or rolling back messaging, Web/iOS/Android push, connector support or
moderation for a tenant. The database migration is an expand-only foundation; it does not authorize
opening public routes by itself.

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
phone and still requires role `admin` plus `notifications.manage`. It never creates a user from a
phone and never bypasses Admin API authorization. Keep the switch disabled in shared staging and
production.

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
