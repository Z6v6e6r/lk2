# Worklog

## 2026-07-16 — first in-app notification vertical slice

- Added a tenant-gated RabbitMQ notification projector that resolves active rules/templates,
  validates an explicit event-user audience, renders an immutable snapshot and writes intent,
  in-app delivery, inbox item, audit and identifier-only outbox events atomically.
- Added durable consumer deduplication, per-user preferences, inactive-user rejection and a shared
  push delivery port while keeping Web Push, APNs and FCM runtime gates disabled.
- Added the protected, non-cacheable notification inbox API with newest-first opaque pagination and
  a user-scoped unread count.
- Added an idempotent, monotonic and audited read-cursor command with durable replay/conflict state
  and a stable outbox event for downstream counters.
- Published the User OpenAPI/SDK surface and a dry-run-by-default, actor-attributed operator command
  for enabling or disabling the in-app gate on one tenant.

## 2026-07-16 — PadlHub-owned profile photo synchronization

- Added strict support for Viva `profile.photo` as a server-only integration input.
- Added bounded HTTPS fetching with a CDN host allowlist, timeout, redirect validation, byte and
  pixel limits; images are autorotated, resized, stripped of metadata and encoded as WebP.
- Added private S3/MinIO content-addressed storage and short-lived signed delivery URLs, using
  separate internal and client-reachable endpoints.
- Added tenant-RLS photo sync metadata with source validators, SHA-256 and object key. The local
  profile URL, sync metadata and Home profile outbox component now update atomically.
- Reused unchanged objects through conditional requests, retained the local avatar on transient
  failures, cleared it when Viva removes the photo and deferred superseded-object deletion until
  signed URLs and stale projections can no longer reference it.

## 2026-07-15 — server-owned mixed Viva client transport

- Added a protected, short-lived and versioned `GET /user/api/v1/{tenantKey}/routing-plan`
  contract. The server, not the LK, selects `PADLHUB_ONLY` or `MIXED_END_USER_READS`.
- Restricted direct Viva transport to five explicit GET operations. Commands, CUP/internal clients,
  unknown operations, missing/expired plans and users without a valid delegation fail closed to the
  PadlHub API.
- Added the browser transport executor with strict URL/query construction, in-memory user access
  tokens, one 401 refresh and no hidden backend fallback after Viva 429/5xx responses.
- Added tenant-RLS routing plan storage and a dry-run-by-default, idempotent, actor-attributed,
  audited switch command. The global direct-read gate remains disabled until the full staging
  preflight and PadlHub UUID normalization are proven.
- Verified Viva browser CORS for the configured LK origins. Viva currently accepts
  `Authorization` but not `X-Correlation-ID`, so direct requests send only the permitted header and
  retain correlation locally for client telemetry.
- Added per-operation rollout in migration 0012, keeping existing plans on an empty safe allowlist.
  Implemented the first complete `profile.read` slice: canonical `/profile` fallback, strict Viva
  schema validation, removal of the external profile ID, rebinding to the authenticated PadlHub UUID
  and a dedicated `/profile` screen that never requests or merges the Home snapshot.
- Added a second fail-closed contract-readiness allowlist shared by API, operator tooling and the
  browser adapter. Only `profile.read` is currently direct-capable; bookings, details, subscriptions
  and schedule stay behind PadlHub even if storage is misconfigured because Viva exposes provider
  identifiers in those payloads.
- Added the protected `/bookings/upcoming` PadlHub aggregate and `/bookings` screen. The response is
  bound to one Home projection version, contains only mapped PadlHub UUIDs and is loaded separately
  without replacing or merging fields from the Home snapshot.
- Replaced the web route fallthrough with explicit protected route resolution: `/profile`,
  `/bookings` and `/` load only their own aggregate, known unfinished sections render a bounded
  section state, and unknown paths render a 404 without requesting Home.
- Fixed repeat Viva OAuth through different social providers: the adapter now verifies the OAuth
  subject and obtains the stable Viva profile ID, while the auth repository resolves that ID to one
  canonical PadlHub UUID. Added an expand migration allowing multiple issuer subjects per canonical
  user and a fail-closed conflict response.
- Reconciled the one local duplicate only after confirming it had no Home, messaging or notification
  business state: its refresh sessions and identity link moved to the existing canonical user, its
  conflicting delegation was revoked, the duplicate was disabled and the operation was audited.

## 2026-07-15 — authenticated Home dashboard contract and interface

- Audited the legacy LK Home request graph: duplicate subscription reads, N+1 name hydration,
  overlapping game windows, tournament date scanning, an independent community widget and chat
  polling made the browser responsible for aggregation.
- Added the protected `GET /user/api/v1/{tenantKey}/home` contract with one consistent snapshot for
  profile, counters, quick actions, upcoming events, subscriptions, communities, promotion and
  capabilities.
- Kept community feeds, rankings, history and details lazy; current memberships are now represented
  by a bounded Home block on the same soft-green surface as the dashboard.
- Added a `VIVA_MODE=mock` synthetic read model and prevented it from running in non-mock modes.
- Replaced the temporary authenticated context card with a responsive desktop/mobile Home interface
  and coalesced concurrent browser reads so the page performs one Home request after authentication.
- Rebuilt the web Home presentation against Figma node `743:2014` on its canonical 375 by 1859
  frame: profile hero, four navigation cards, booking filters/cards, campaign, locations and bottom
  navigation now share the exported dimensions, typography and gradient.
- Extended the same Home snapshot with locations and server-approved additional links, and fitted
  the requested communities strip into the lower white surface without adding another client read.
- Removed simulated iOS system chrome from the web rendering and pinned the application bottom
  navigation to the browser viewport so it remains available while the long Home feed scrolls.
- Moved current communities directly below the profile on the purple Hero surface and added round
  logo support with a generated branded fallback, without introducing a separate communities read.
- Decoupled Home source selection from Viva authentication with `HOME_READ_MODE=mock|projection`;
  production configuration now requires the persisted projection and never falls back to mock.
- Added a forced-RLS, tenant/user-scoped Home snapshot table with monotonic revisions, event IDs,
  checksums, freshness metadata and metadata-only audit records.
- Added runtime contract/user/version/freshness validation and stable not-ready, invalid and stale
  API failures for the real projection path.
- Added a dry-run-by-default projection importer and a switch/rollback runbook for controlled
  initial fill and recovery while the continuous event-driven builder is implemented.
- Added the continuous Home projector contract and shared runtime validator for nine normalized
  domain components; counters are derived in the builder and external identifiers are rejected.
- Added a tenant-RLS component inbox, per-component monotonic revisions, per-user transactional
  rebuild locking and RabbitMQ inbox deduplication with a bounded quorum-queue delivery limit.
- Wired the projector into `apps/worker` and added a dry-run/apply outbox enqueue utility for
  controlled backfill and smoke tests; normal producers remain part of their domain transaction.
- Applied the component migration locally and verified the real Docker path end to end: outbox
  publish, quorum-queue consume, inbox completion and `waiting` without a partial snapshot.
- Added feature-gated server-side Viva producers for profile, enriched active bookings and active
  subscriptions, sharing the API refresh-token lease and encrypted delegation rotation path.
- Added transactional Viva source state, PadlHub UUID mapping and outbox emission; signed balances,
  optional phone suffixes and paused subscriptions now preserve the real upstream semantics.
- Applied the source migration locally and enabled worker sync against two active delegations. One
  user completed profile/upcoming/subscription projection events end to end; the second was safely
  rejected because the same Viva profile is already mapped to another PadlHub UUID.
- Backfilled communities, promotion, locations, navigation and capabilities through five validated,
  idempotent audited-outbox events. The worker published and consumed all five and assembled a full
  nine-component Home snapshot with the live Viva profile, bookings and subscription components.
- Switched the local API runtime to `HOME_READ_MODE=projection` after projection readiness. Real-user
  smoke checks returned HTTP 200 from `/home` and `/bookings/upcoming`, both bound to the same
  `LOCAL_PROJECTION` snapshot, with PadlHub UUIDs only and no integration identifiers exposed.

## 2026-07-14 — chats and notifications architecture

- Added the dedicated product/domain contour for trigger notifications, CUP connector
  correspondence, game/tournament/community chats and direct user conversations.
- Separated canonical messaging state from notification intents/delivery history and kept all
  external connector identifiers and encrypted endpoints inside the integration boundary.
- Defined server-side ordering, command idempotency, transactional outbox, connector deduplication,
  recoverable realtime delivery, attachment safety, privacy, metrics and phased rollout/rollback.
- Added explicit Web Push/VAPID, iOS/APNs and Android/FCM endpoint and receipt mechanics.
- Added PadlHub-owned moderation/control with user reports, CUP cases, reversible automated policy,
  immutable actions and signal-only external moderation providers.
- Added an expand-only tenant-scoped PostgreSQL foundation and an editable architecture diagram.
- Added a staged enablement, smoke, incident-control and digest rollback runbook.

## 2026-07-12 — Viva OAuth cabinet entry and delegation design

- Reworked the web authentication entry screen around Viva OAuth through VK ID/Mail.ru and Yandex,
  while retaining SMS as an explicit fallback.
- Implemented the feature-gated server-owned OAuth start/callback, one-time Redis PKCE state,
  authorization-code exchange in the Viva adapter, PadlHub session issuance and encrypted
  server-side Viva refresh-token persistence.
- Added a one-time callback handoff and authenticated Viva access broker: the browser keeps only a
  short-lived access-token in memory, while multi-node refresh is serialized by a Redis lease and
  rotated refresh credentials are encrypted before replacement. Logout revokes the local Viva
  delegation alongside the PadlHub refresh session.
- Added required public-offer and personal-data-policy confirmations before an OAuth start request;
  the browser sends only the confirmation intent to the PadlHub-owned OAuth start endpoint.
- Persisted that confirmation immediately as a tenant-scoped legal intent keyed by a hash of OAuth
  state; a successful callback binds it to the PadlHub user and creates the two final versioned
  document-acceptance rows.
- Recorded the feature-gated Viva user-delegation model: server-encrypted Viva refresh-token,
  in-memory short-lived browser access-token and refresh/revocation behavior. ADR 0008 later
  narrowed the temporary direct transport to read-only operations.
- Documented an immediate per-tenant/per-operation switch from `DIRECT_VIVA` to `LOCAL`,
  `SERVER_VIVA`, or `UNAVAILABLE`, including reconciliation for already pending commands.

## 2026-07-11 — platform baseline

- Imported and hashed the pre-existing Cabinet OpenAPI draft without altering it.
- Established TypeScript monorepo boundaries for API, worker, realtime, migrator and React/Capacitor clients.
- Added PadlHub JWT/tenant/correlation/rate-limit middleware baseline, source routing, Viva ACL, outbox/inbox tables and tenant RLS.
- Added Docker Compose local services, digest-only deployment definitions, monitoring baseline, Terraform boundary and Ansible host baseline.
- Added CI/CD scaffolding, ADRs, domain ownership and operational runbooks.
- Added canonical OpenAPI 3.1 user/admin/internal roots; SDK generation now uses only the first safe read-only user operation.
- Forced tenant RLS even for table owners, added bounded Viva retry/circuit/ID-mapping enforcement and removed realtime tickets from URLs.
- Pinned dependency and container versions; production promotion now consumes only digests from a successful staging workflow run.
- Verified all local dependencies, API/worker/realtime readiness, real JWT tenant resolution, realtime ticket authentication and a non-root production image.

## 2026-07-11 — first user authentication vertical

- Defined a provider-neutral phone-authentication and PadlHub-session boundary for the protected
  home page; schedule remains out of scope.
- Kept all client traffic on PadlHub APIs; Viva traffic and tokens stay inside
  `@phub/viva-adapter`, while provider bindings and external subjects stay in integration storage.
- Defined per-tenant `VIVA`/`LOCAL` binding, stable PadlHub UUID mapping by provider issuer/subject,
  in-memory web access JWTs and opaque rotating `HttpOnly` refresh cookies stored as hashes.
- Documented ephemeral Redis challenges, production secure-cookie enforcement, synthetic local
  credentials and the Viva timeout/retry/circuit-breaker/telemetry policy.
- Added the provider switch, rollback and local mock verification runbook.
- Added atomic single-use verification, per-phone cooldowns, shared Redis rate limits, correlated
  security audit, retry-safe idempotent session rotation and a full auth smoke test.
