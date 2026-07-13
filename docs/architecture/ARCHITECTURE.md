# PadlHub target architecture

## Decision summary

PadlHub begins as a modular monolith with asynchronous workers and a separate realtime gateway. All clients call only PadlHub APIs and use PadlHub UUIDs. Viva is a temporary external owner for selected domains behind an anti-corruption layer; it never defines our public contract or database model.

The editable system diagram is [system-context.drawio](system-context.drawio).

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

## Viva transition

Each `tenant + domain` has one ownership mode:

1. `VIVA_PRIMARY`: Viva accepts commands; confirmed state is projected locally.
2. `SHADOW_COMPARE`: local results are calculated and compared without serving as write owner.
3. `LOCAL_PRIMARY`: PostgreSQL commits state and outbox event atomically; Viva may receive an asynchronous projection.
4. `LOCAL_ONLY`: Viva is absent from the operation.

`SourceRouter` can return `LOCAL`, `SERVER_VIVA`, `DIRECT_VIVA`, `STALE_LOCAL` or `UNAVAILABLE`.
`DIRECT_VIVA` is disabled by default and requires Viva-supported short-lived user delegation, route
allowlisting and a per-tenant feature flag. Its approved browser routes are profile, available slots
and the purchase/cancellation transport described in ADR 0005. Client-returned command completion
is untrusted and remains pending until webhook/provider-receipt/reconciliation confirmation;
therefore it cannot itself authorize bookings, prices, payments or rights.

## Reliability and observability

Critical local writes use transactional outbox; consumers use inbox deduplication. External calls have timeouts, bounded retries and a circuit-breaker policy. Push and integration work never runs inside the user's HTTP transaction.

OpenTelemetry supplies metrics, logs and traces. Logs include release, environment, tenant, operation and correlation ID but redact tokens, phones, payment data and message content. Alerts follow P0–P3 severity, group duplicates, link to dashboards/logs/runbooks, mark deployments and close on recovery.

## Delivery

Local, CI, staging and production are isolated. CI builds each immutable image once, tags it by Git SHA, records its digest and promotes that digest. Production never builds code, never uses `latest`, and never mounts source.

Staging is automatic after `main`; production accepts only a successful staging workflow run and downloads its recorded image digests. It requires approval, a verified backup, a backward-compatible migration, sequential app nodes, health checks, smoke tests and post-deploy checks. App containers bind to explicitly configured private node addresses reachable only from the load balancer. Application rollback must work without immediate database rollback, hence expand/migrate/contract schema changes.
