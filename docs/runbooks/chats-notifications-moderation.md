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

The command validates the actor inside the tenant, changes only the in-app gate and appends an audit
record. Web/APNs/FCM gates remain off. Use the same command with `--in-app=off` for the producer and
User API rollback before draining the projector queue.

## Required smoke tests

- Repeat a send command with the same `Idempotency-Key` and `clientMessageId`; only one sequence is
  allocated and the original response is returned.
- Disconnect realtime, create messages, reconnect with `afterSequence`; the client fills the exact
  gap through HTTP without duplicate rendering.
- Remove a test member and confirm both HTTP history and WebSocket subscribe reject access.
- Submit the same connector webhook twice and confirm one canonical message/external mapping.
- Register, rotate and invalidate one Web Push subscription, APNs token and FCM token. Confirm a
  provider acceptance is not shown as `DISPLAYED` or `OPENED` until a client receipt arrives.
- Trigger one notification twice with the same source event/dedupe key; create one intent.
- Read `GET /user/api/v1/{tenantKey}/notifications`; verify newest-first pagination, a correct
  tenant/user-scoped unread count and `Cache-Control: no-store`.
- Repeat `PUT /user/api/v1/{tenantKey}/notifications/read-cursor` with the same `Idempotency-Key`;
  verify the stored result is replayed. Reuse that key with another item and expect the stable
  `IDEMPOTENCY_KEY_REUSED` conflict.
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
