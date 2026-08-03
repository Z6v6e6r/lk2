# Push and messenger delivery readiness — 2026-08-03

This document records code-observed readiness. It is not proof that any target environment is
configured or that a device displayed a notification. All new gates remain off and this wave does
not deploy or mutate runtime data.

## Readiness matrix

| Channel       | Code state                                                                                                                                                                         | Runtime evidence required                                                                                                                                                                                                                                    | Current decision                                        |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------- |
| In-app        | Durable inbox and read cursor exist                                                                                                                                                | authenticated create/read smoke                                                                                                                                                                                                                              | ready for gated staging verification                    |
| Web Push      | encrypted installation lifecycle, VAPID adapter, stable delivery key, bounded timeout/retry/circuit, fenced finalizer, provider-acceptance receipt, invalidation, due/dead metrics | same-origin real browser permission + subscription + provider acceptance + service-worker display/open recording; outbox, due/dead and DLQ return to baseline                                                                                                | ready for gated sandbox evidence; not production-proven |
| APNs          | public capability fails closed                                                                                                                                                     | Apple team/key ID, protected `.p8` credential, bundle/topic and sandbox account; encrypted device-token register/rotate/revoke API; native iOS bridge; HTTP/2 adapter; invalid-token mapping; sandbox device evidence                                        | blocked, no adapter or client contract in repo          |
| FCM           | public capability fails closed                                                                                                                                                     | Firebase project and protected HTTP v1 service credential; encrypted registration-token register/refresh/revoke API; Android bridge; HTTP v1 adapter; unregistered-token mapping; test-project device evidence                                               | blocked, no adapter or client contract in repo          |
| MAX messenger | separate compile-time messenger delivery port only; no network adapter or runtime producer                                                                                         | protected bot account/token reference; PadlHub user consent/linking and tenant-scoped `user_id`/`chat_id` mapping; approved message/deep-link policy; production HTTPS webhook/subscription lifecycle; 2 msg/s per-dialog limiter; provider sandbox evidence | blocked fail-closed; it is not APNs/FCM push            |

## Reliability invariants added in this wave

- A delivery finalizer must still own an unexpired database lease. A zero-row fenced update returns
  `stale`; it cannot append an attempt, receipt, provider link or outbox event.
- The Web Push provider timeout is bounded to 30 seconds by configuration and its database lease is
  60 seconds. No lease extension is required for the current adapter.
- Provider acceptance, an optional opaque external message ID, attempt evidence, delivery state and
  identifier-only outbox are committed atomically. The external ID stays only in
  `integration.notification_provider_links`; provider bodies and endpoint material are never
  persisted with receipts, audit or broker events.
- A replay may reuse the same delivery/provider/external-message tuple. A conflicting external ID
  for an existing delivery aborts the transaction fail-closed.
- `PROVIDER_ACCEPTED` does not mean displayed or opened. This wave does not invent display/open
  receipts without a real client event.
- `PENDING`/expired-lease due count, oldest due age and durable `DEAD` count are collected through
  tenant-scoped transactions and exported without notification payloads.

## Web Push sandbox evidence gate

Retain only content-free results and correlation/delivery UUIDs:

1. Verify immutable release SHA/digests, migration set and worker/API readiness.
2. Verify stable VAPID public key and mounted private/encryption-key references without printing
   values. Keep global, tenant and provider gates off until this check passes.
3. Enable one sandbox provider and one tenant using the existing dry-run/apply commands.
4. Register a real same-origin browser subscription from `/notifications`; repeat registration with
   the same idempotency key and prove the endpoint ID is unchanged.
5. Create one approved non-sensitive notification. Prove exactly one delivery reaches `SENT`, one
   `PROVIDER_ACCEPTED` receipt exists and no endpoint/body/provider response appears in logs,
   metrics, audit or RabbitMQ.
6. Prove the service worker displays and opens the expected PadlHub deep link. Record display/open
   only after an authenticated client receipt endpoint exists; until then keep these as visual test
   evidence, not database receipts.
7. Exercise a disposable gone subscription and prove 404/410 produces `DEAD` plus endpoint
   `INVALID`; do not invalidate on 429/5xx/network failures.
8. During a retry test, observe:
   `phub.worker.notifications.push_deliveries_due`,
   `phub.worker.notifications.push_delivery_oldest_due_age_seconds`,
   `phub.worker.notifications.push_deliveries_dead`, outbox age and DLQ depth. All non-terminal
   backlog indicators must return to baseline.
9. Roll back the tenant Web Push gate first. Keep in-app active.

## MAX boundary and required product inputs

The official API describes bot/messenger send as `POST https://platform-api2.max.ru/messages`,
authenticated with the `Authorization` header and addressed by `user_id` or `chat_id`. The stated
limit is 2 messages/second per dialog; production inbound operation uses HTTPS webhook/subscription
mechanics. Primary references:

- <https://dev.max.ru/docs-api/methods/POST/messages>
- <https://dev.max.ru/docs-api>

No PadlHub-to-MAX target mapping or bot-account runtime configuration exists in the repository.
Consequently this wave adds no HTTP client, token variable, webhook route or active provider row.
Before implementation the owner must supply and approve:

1. tenant(s), bot account and protected credential reference/rotation owner;
2. canonical consent/link/unlink flow and source of `user_id`/`chat_id` mappings;
3. whether delivery is one-to-one user or dialog scoped, including opt-out and moderation rules;
4. message template, deep-link behavior and allowed personal-data classification;
5. webhook/subscription verification, replay window and public HTTPS ingress configuration;
6. sandbox/test recipients, rate-limit acceptance and incident/rollback owner.

Without every required input MAX remains fail-closed and must not be represented in UI or metrics
as mobile push.
