# PadlHub target architecture

## Decision summary

PadlHub begins as a modular monolith with asynchronous workers and a separate realtime gateway. All clients call only PadlHub APIs and use PadlHub UUIDs. Viva is a temporary external owner for selected domains behind an anti-corruption layer; it never defines our public contract or database model.

The editable system diagram is [system-context.drawio](system-context.drawio). The dedicated chat,
notification and moderation flow is documented in
[messaging-notifications.drawio](messaging-notifications.drawio) and
[the domain design](../domains/chats-and-notifications.md).

## Runtime processes

- `apps/api`: user/admin/internal HTTP boundaries, authentication, tenant resolution, BFF queries and domain commands.
- `apps/worker`: outbox publishing, Viva synchronization, notification delivery, retries, reconciliation and scheduled work.
- `apps/realtime`: ticket-authenticated WebSocket connections, presence, message updates and realtime notifications.
- `apps/migrator`: the only release job allowed to apply database migrations.

They share domain packages and standards but remain independent processes and images.

## Client platform

React and TypeScript are shared across Vite web bundles, Capacitor iOS/Android shells and the CUP web app. `@phub/api-sdk` owns PadlHub request headers and routes. Native code is limited initially to push, secure storage, deep links, camera and payments.

Tilda contains only a mount element, tenant key and stable loader. The loader fetches a release manifest and immutable content-hashed assets from CDN. Business logic never lives in Tilda HTML.

## API boundary

Canonical namespaces are:

- `/user/api/v1/{tenantKey}`
- `/admin/api/v1/{tenantKey}`
- `/internal/api/v1`

Every request receives a correlation ID, PadlHub auth context, tenant context, rate-limit policy and standardized error envelope. Critical commands additionally require an idempotency record and audit event. User/admin/internal JWT audiences remain separate.

Authentication is provider-neutral. A server-side tenant binding selects `VIVA` or `LOCAL`, while
clients always use PadlHub challenge/session endpoints. A verified `(tenant_id, issuer, subject)`
maps to a stable PadlHub user UUID. The web app holds the short-lived PadlHub access JWT only in
memory; an opaque rotating refresh credential is carried in an `HttpOnly` cookie and stored only as
a hash. Viva OAuth may additionally create a server-encrypted user delegation; only a feature-gated
short-lived Viva access-token for an allowlisted direct route can enter browser memory. See
[ADR 0004](../adr/0004-provider-neutral-authentication.md) and
[ADR 0005](../adr/0005-viva-user-delegation-and-direct-transport.md).

Authentication commands are correlated, audited and retry-safe by idempotency key. Redis provides
shared rate limits, challenge cooldowns and short verification leases; PostgreSQL remains the
source of truth for users, integration identity mappings and rotating session families.

The pre-existing Cabinet OpenAPI is an immutable imported draft. It is migrated operation by operation into OpenAPI 3.1 rather than silently becoming the platform boundary.

## Data and domains

PostgreSQL is the operational source of truth. Logical schemas mirror domains, not services or Viva response shapes. Redis stores only ephemeral cache, locks, rate-limit state and counters. RabbitMQ transports events/retries/DLQ. Files use signed URLs to S3-compatible storage.

Every tenant-owned row contains `tenant_id`; row-level security is part of defense in depth. Modules own their tables and migrations and communicate through public domain interfaces.

Provider-hosted profile photos cross the integration boundary only in `apps/worker`. They are
allowlisted, size-limited, normalized to metadata-free WebP and stored under immutable SHA-256 keys.
PostgreSQL keeps the tenant/user object mapping and provider change validators; clients receive only
short-lived signed URLs to PadlHub-owned objects. A profile/media update and its Home outbox event
share one transaction, while superseded-object deletion is queued until signed URLs and stale
projections can no longer reference it.

## Chats, notifications and moderation

Chats and notifications are one product area with two domain aggregates and a cross-cutting control
module:

- `messaging` owns conversations, participants, ordered messages, attachment metadata, edit
  history and read cursors;
- `notifications` owns versioned templates, trigger rules, recipient intents, the durable in-app
  inbox, user preferences and delivery history;
- `moderation` owns reports, policies, review cases and immutable PadlHub enforcement decisions;
- `integration` owns connector accounts, encrypted delivery endpoints and all external thread,
  contact and provider-message identifiers, including external moderation-signal IDs.

Direct user chats, game chats, tournament chats, community chats and CUP support conversations use
the same conversation/message engine. A notification does not implicitly become a chat message and
a connector does not own a conversation. Product policy may explicitly project a domain event into
either or both aggregates.

Push is implemented as three explicit transports behind the notification delivery port: Web Push
with VAPID and a service worker, APNs for iOS, and FCM for Android. Endpoint payloads are encrypted
at rest, rotate independently per installation and never enter events or telemetry. Provider
acceptance, provider delivery (when available), client display and user open are separate receipts;
the platform never claims that an accepted push was seen.

CUP owns the PadlHub moderation control plane. Optional external moderation systems may submit a
signed signal or recommendation through a service boundary, but they cannot directly mutate a
conversation. PadlHub policy or an authorized moderator converts a signal into an audited,
idempotent action. Emergency quarantine is a PadlHub-owned policy action with an explicit expiry
and review queue, not an external provider side effect.

PostgreSQL is the only source of truth. A message command locks its conversation, assigns a
monotonic sequence, writes the message, audit record and outbox event in one transaction. RabbitMQ
then carries identifier-only events to the worker and realtime gateway. WebSocket delivery is an
optimization: clients detect sequence gaps and recover through the User API. Redis holds only
short-lived presence, typing indicators, connection routing and rate limits.

Inbound connector webhooks are signature-verified and deduplicated by the external message ID held
inside `integration`. Outbound delivery is at-least-once with a stable provider idempotency key,
bounded retries and a DLQ. Attachments are private objects in S3-compatible storage and become
readable only after validation and malware scanning. Message bodies, rendered notification content,
addresses and connector payloads are excluded from logs, metrics and broker events.

See [ADR 0006](../adr/0006-chats-and-notifications-contour.md) for the decision and
[the domain design](../domains/chats-and-notifications.md) for commands, events, access rules,
failure handling and rollout phases. Operational enablement and rollback are defined in the
[runbook](../runbooks/chats-notifications-moderation.md).

## Viva transition

Each `tenant + domain` has one ownership mode:

1. `VIVA_PRIMARY`: Viva accepts commands; confirmed state is projected locally.
2. `SHADOW_COMPARE`: local results are calculated and compared without serving as write owner.
3. `LOCAL_PRIMARY`: PostgreSQL commits state and outbox event atomically; Viva may receive an asynchronous projection.
4. `LOCAL_ONLY`: Viva is absent from the operation.

`SourceRouter` can return `LOCAL`, `SERVER_VIVA`, `DIRECT_VIVA`, `STALE_LOCAL` or `UNAVAILABLE`.
`DIRECT_VIVA` is disabled by default and requires Viva-supported short-lived user delegation, route
allowlisting, a global gate and a tenant routing plan. The LK reads a versioned, short-lived plan;
it never chooses a source. The temporary direct vocabulary is read-only: profile, bookings,
booking details, subscriptions and schedule. Commands, unknown operations, CUP/internal traffic and
expired plans always use PadlHub APIs. Details, switch semantics and rollback are defined in
[ADR 0008](../adr/0008-server-owned-client-routing-plan.md).

## Reliability and observability

Critical local writes use transactional outbox; consumers use inbox deduplication. External calls have timeouts, bounded retries and a circuit-breaker policy. Push and integration work never runs inside the user's HTTP transaction.

OpenTelemetry supplies metrics, logs and traces. Logs include release, environment, tenant, operation and correlation ID but redact tokens, phones, payment data and message content. Alerts follow P0–P3 severity, group duplicates, link to dashboards/logs/runbooks, mark deployments and close on recovery.

## Delivery

Local, CI, staging and production are isolated. CI builds each immutable image once, tags it by Git SHA, records its digest and promotes that digest. Production never builds code, never uses `latest`, and never mounts source.

Staging is automatic after `main`; production accepts only a successful staging workflow run and downloads its recorded image digests. It requires approval, a verified backup, a backward-compatible migration, sequential app nodes, health checks, smoke tests and post-deploy checks. App containers bind to explicitly configured private node addresses reachable only from the load balancer. Application rollback must work without immediate database rollback, hence expand/migrate/contract schema changes.
