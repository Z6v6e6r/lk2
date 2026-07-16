# ADR 0007: Serve Home as one PadlHub read-model snapshot

- Status: Accepted
- Date: 2026-07-15

## Context

The legacy LK Home page is a browser-side orchestrator. It requests profile, bookings, two
subscription collections, overlapping game windows, communities, promotion and chat counters. It
then performs N+1 subscription-name hydration, polls chats every 12 seconds and may scan about 22
dates to infer tournament capability. Community selection can also warm detail, feed and rating
requests before those views are needed.

This creates inconsistent loading states, repeated traffic and a source-selection responsibility in
the client. It also makes a redesign unsafe because every visual block has an independent runtime
contract.

## Decision

Add the protected `GET /user/api/v1/{tenantKey}/home` operation and return one versioned
`HomeDashboard` snapshot containing all initial Home blocks.

The production implementation will be a server-owned materialized projection. It is read-only and
does not change domain write ownership. All public entity identifiers are PadlHub UUIDs. Tenant and
user scope are resolved exclusively from the tenant route and verified PadlHub JWT.

Community summaries belong in the snapshot; community detail, feed, rating, members and chat
history are lazy. Booking history and item details are lazy. Unread counters are supplied by the
snapshot and later changed by realtime events rather than polling. Capabilities are computed on the
server rather than inferred by date scans in the browser.

Home source selection is independent from the identity provider mode. `HOME_READ_MODE=mock` serves
the complete synthetic shape in local/CI development. `HOME_READ_MODE=projection` reads one
tenant/user row from `home.dashboard_snapshots`; production requires this mode and never falls back
to mock data. `VIVA_MODE` continues to control only the Viva integration and authentication path.

Projection writers submit a complete contract-valid `LOCAL_PROJECTION` payload with a monotonically
increasing source revision and source-event UUID. A higher revision atomically replaces the row;
same-revision retries are idempotent only when the payload checksum also matches. Writes are audited
without copying the user payload into the audit log. The projection is a derived read model, so this
write does not emit a domain outbox event or become a business-state owner.

Continuous updates use the normalized `home.projection.component.changed.v1` event. Domain owners
write their business state and this outbox event in the same transaction; the Home projector never
calls Viva or another domain during event handling. Components have independent monotonic revisions.
The worker stores them under forced tenant RLS and rebuilds only after profile, messaging, upcoming,
subscriptions, communities, promotion, locations, navigation and capabilities are all present.
Per-user advisory locking, inbox deduplication and a bounded RabbitMQ quorum-queue delivery limit
make rebuilds ordered and retry-safe.

For domains that remain `VIVA_PRIMARY`, `apps/worker` obtains a short-lived user access token from
the encrypted server-side delegation, reads Viva through `@phub/viva-adapter`, maps every external
identifier through `integration.external_entity_map`, and commits the normalized integration source
component plus outbox event in one PostgreSQL transaction. The refresh path shares the API Redis
lease namespace so rotated refresh credentials cannot race. The first implemented pull producers
are profile, active bookings and subscriptions; no Viva credential or identifier enters the public
snapshot. A Viva profile already mapped to a different PadlHub user is a hard identity conflict and
must go through an explicit account-link/merge procedure.

Viva `profile.photo` is integration input, not a public profile URL. The worker copies it into
private S3-compatible storage as a metadata-free, bounded WebP object addressed by its SHA-256.
Provider URL/ETag metadata stays in `integration`; the profile and Home component receive only a
short-lived signed URL for the PadlHub object. Existing local media is retained on transient source
or storage failure. Replacing or removing a photo updates profile state and the audited Home outbox
component atomically, then schedules cleanup of the superseded immutable object after the signed
URL and projection-staleness grace periods.

Profile, upcoming bookings and subscriptions from one Viva pull share the same source timestamp.
The projector defers rebuilds while those three component timestamps differ, so an intermediate
event cannot publish a snapshot that mixes two Viva sync cycles.

## Consequences

- Home requires one business-data request after authentication.
- React StrictMode concurrency is coalesced in the web gateway.
- The visual surface has stable contracts for profile, counters, actions, upcoming items,
  subscriptions, communities, promotion and capabilities.
- Domain detail screens keep their own bounded contracts and are loaded on navigation.
- The API rejects missing, malformed or excessively stale projections with stable 503 errors; it
  never substitutes synthetic data.
- An audited dry-run/apply importer provides the initial operational bridge. Continuous production
  freshness is maintained by the event-driven worker once each source domain publishes its
  normalized component event.
- `HOME_VIVA_SYNC_ENABLED` is an independent feature gate. Enabling source synchronization does not
  switch Home reads; `HOME_READ_MODE=projection` remains blocked until all nine components are ready.
- Any future Home block must first be added to the OpenAPI snapshot and ownership documentation; it
  must not add an independent initial client request.
