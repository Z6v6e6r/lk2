# Worklog

## 2026-07-18 — verifiable Nano release identity

- Passed the immutable Git commit SHA into ARM64 image builds as `PHUB_RELEASE`, so the web
  bootstrap manifest identifies the exact source release instead of the generic `development`
  fallback.
- Added a public post-deploy manifest check to the staging workflow. A Nano rollout now fails if
  the served `/manifest.json` release differs from the commit whose image digests were deployed.

## 2026-07-17 — CUP advertising on the LK Home page

- Expanded Home from one placeholder promotion to an ordered deck of active CUP cards while
  retaining the first-card field for backward-compatible rollout.
- Added a bounded worker-side bridge to the existing public CUP `cabinet_home` placement, stable
  PadlHub UUID mapping, tenant-RLS producer state, transactional Home outbox events and delayed
  media garbage collection. The browser still performs only the single authenticated Home request.
- Added metadata-free content-addressed WebP delivery with separate bounded desktop and exact
  750×480 mobile derivatives; legacy asset URLs never reach the client.
- Added accessible automatic rotation that honors the CUP switch, pauses during interaction and for
  reduced motion, plus manual pagination controls and focused source/media/UI regression tests.

## 2026-07-17 — locations editorial vertical slice

- Added a tenant-RLS `LOCAL_ONLY` public location profile aggregate, idempotent/versioned admin
  commands, audit metadata and transactional `locations.profile.changed.v1` events without Viva IDs.
- Published separate CUP Admin and authenticated User Location APIs with PadlHub UUIDs, draft and
  archive isolation, completeness-gated publication and server-computed open status/navigation.
- Added ЦУП → Настройки → Станции with list, search, create/edit, HTTPS gallery, weekly hours,
  amenities, contacts, Home order, publication controls and a mobile card preview.
- Added the cabinet location directory and reference-shaped detail card, plus a touch-native
  scroll-snapped Home locations carousel backed by the stored Home projection.
- Added the worker fan-out from published tenant profiles to existing user Home components, strict
  contracts, regression tests, ADR, domain ownership documentation and a publication runbook.

## 2026-07-17 — games domain and API contract foundation

- Added the dependency-free `@phub/games` kernel with independent lifecycle, roster, viewer,
  payment, result and presentation states plus strict aggregate/card invariants.
- Added one server-owned card policy with explicit registration-closed and waitlist-leave states,
  stable actions and separate safe anonymous projection.
- Published anonymous discovery and authenticated Games OpenAPI contracts. Ten state-changing User
  API commands require correlation, PadlHub JWT, `Idempotency-Key` and stable conflict codes.
- Added durable operation resources for booking/payment work without exposing Viva, booking,
  payment or caller-selected identity identifiers.
- Added 16 strict Games domain events, six provider-neutral internal commands and an explicit
  consumer routing matrix. Events reuse the standard outbox envelope and expose no PII/provider
  fields or complete card payloads.
- Added service-only command submission and read-only event inspection to Internal OpenAPI, with
  generated public/User/Internal types and contract/domain drift tests. No database, handlers or UI
  are enabled by this foundation release.

## 2026-07-17 — games persistence and command foundation

- Added expand-only migration `0023_games_foundation.sql` with twelve Games-owned tables for the
  aggregate, roster/reservations/waitlist, immutable result workflow, invitations, operations,
  card projections, idempotency and scheduled commands.
- Added tenant-aware foreign keys, capacity/active-membership uniqueness constraints, discovery and
  due-work indexes, forced RLS on every table and `LOCAL_PRIMARY` Games ownership.
- Implemented an atomic create repository that stores canonical `PROVISIONING` state, organizer,
  operation, replayable command result, audit, `game.created.v1`,
  `game.provisioning.requested.v1` and the process-manager command in one transaction.
- Added monotonic card projection writes, public keyset reads, bounded `SKIP LOCKED` scheduling and
  worker-owned completion/retry operations.
- Verified all migrations against a clean PostgreSQL 16 database, forced-RLS visibility with two
  tenants, exact idempotent replay/conflict behavior and one aggregate transaction producing one
  audit row and two safe outbox events without the raw idempotency key.

## 2026-07-17 — games concurrent roster commands

- Added persistence-safe join, waitlist, leave and waitlist-leave policies that use canonical game
  facts rather than presentation cards and keep capacity, cutoff and membership rules in one domain
  policy.
- Implemented transactionally serialized roster commands. A final seat can be won only once;
  no-payment/organizer-paid joins become participants, while split/subscription joins create a
  15-minute reservation and a durable expiry command.
- Persisted both successful and rejected user commands with matching idempotent replay, audit rows,
  aggregate revision changes and safe outbox facts in the same PostgreSQL transaction.
- Added explicit waitlist joined, left and promoted facts. Leave and expiry reopen capacity and
  schedule process-manager promotion; promotion revalidates the locked queue head and capacity
  before creating a participant or reservation.
- Added process-manager expiry/promotion handlers with a service principal, replay safety and
  no-op/not-due behavior, plus domain/repository tests for all paths.
- Verified real PostgreSQL races in a disposable `_verify` database: parallel final-seat joins and
  reservations each had exactly one winner, waitlist promotion happened once, reservation expiry
  happened once, and the final audit/outbox state matched the asserted transaction history.

## 2026-07-17 — games roster User API foundation

- Registered explicit join, join-waitlist, leave and leave-waitlist User API handlers backed by the
  roster repository; no generic roster mutation or caller-selected user identity was introduced.
- Required verified JWT tenant membership, the server-issued `games.play` permission,
  `Idempotency-Key`, strict request fields and server-generated correlation/request hashes before
  any command reaches persistence.
- Added stable domain/idempotency error mapping and runtime validation of the operation-shaped HTTP
  response. Immediate commands return `200`; paid reservations return an honest `202 PROCESSING`
  with no fabricated payment URL.
- Added tenant-and-actor-scoped durable operation reads from command idempotency, including exact
  committed timestamps and replayed results.
- Kept production Games repository injection disabled until Commerce can create a durable payment
  next action and consume verified payment confirmation; unconfigured routes fail closed with 503.
- Re-ran the disposable PostgreSQL race scenario and additionally proved the winning operation can
  be read only through its tenant/user ownership; the temporary verification database was dropped.

## 2026-07-17 — games card projector and read API slice

- Added an atomic Games card projector consumer on a bounded quorum queue. Inbox deduplication,
  aggregate/roster dependency reads, monotonic projection write and inbox completion share one
  tenant transaction.
- Built one canonical projection snapshot from Games, active roster/reservations/waitlist, local
  profile summaries and station presentation; no Viva/provider identifiers or client-selected
  sources enter the card.
- Added anonymous public list/detail reads with future public/scheduled isolation, strict filters,
  bounded scan and filter-bound opaque keyset cursors. Public cards remove PadlHub user UUIDs and
  the private result summary before serialization.
- Added authenticated upcoming/history list and owned-detail reads. Viewer membership is selected
  from the same versioned projection JSON; outsiders receive not found, and Messaging-owned
  conversation data remains explicitly null.
- Kept both public/User read repositories unconfigured in production wiring, so the new routes fail
  closed until release verification and load evidence are complete.
- Unit, API, domain, lint and TypeScript checks passed. The extended clean-PostgreSQL projector
  script was prepared, but its rerun was blocked by the execution approval usage limit; the empty
  temporary database was dropped and this postcheck remains open.

## 2026-07-17 — viewer-filtered player profiles

- Added the canonical `/profiles/{padlHubUserId}` User API while retaining `/profile` as the
  migration-compatible self aggregate.
- Introduced a server-owned `PlayerProfileView` policy with `BASIC`, `EXTENDED`, `INTERACTION` and
  `SELF` access tiers and stable capability lock reasons.
- Moved balance and phone suffix into an optional self-only `privateAccount`; other viewers never
  receive those fields, and numeric rating is omitted without extended access.
- Added separate server permissions for extended data, mediated contact and direct chat. Target
  privacy can still fail closed, and future commands must revalidate current access.
- Added `/profile/{userId}` UI routing, neutral locked-action states and privacy wording
  without loading or merging the Home dashboard.
- Updated the canonical OpenAPI, generated SDK contract, policy/API/web regression tests, ADR and
  profile domain documentation.
- Added the `LOCAL_ONLY` tenant-RLS profile privacy aggregate with `AUTHORIZED`/`NOBODY` policy,
  optimistic/idempotent self-service updates, audit and transactional outbox event.
- Applied persisted target policy to viewer-filtered reads and added owner switches for contact and
  direct chat on `/profile` without exposing raw contact data.
- Explicitly left the source of interaction permissions outside the profile contour: subscriptions
  and memberships are not read, inferred or connected until a separate architecture decision.

## 2026-07-17 — community directory foundation and legacy read bridge

- Reduced the Home community summary to five stable fields plus PadlHub UUID/route, removed role,
  member count and presentation color, and kept continuation cursors out of the Home response.
- Added canonical tenant-RLS community and membership tables that prevent duplicate active owners
  and provide an expand-only `LOCAL_ONLY` ownership foundation.
- Added a shared community domain package with strict summaries, deterministic pinned/activity
  ordering and opaque keyset pagination.
- Published the protected `/communities/mine` User API/OpenAPI/SDK operation and a responsive LK
  directory that loads 20 memberships and continues on demand without requesting Home.
- Added an explicit temporary legacy read mode. Server-resolved identity is sent only from the API;
  returned memberships are mapped to PadlHub UUIDs and stripped of phones, client IDs, members,
  graph connections, invites and legacy media URLs.
- Added response limits, timeout, bounded retry, circuit breaker, redacted metrics and normalized
  short caching around the current LK source. Mock memberships are forbidden in production.
- Kept rollout backward-compatible with persisted Home snapshots by normalizing the previous
  community-card shape until all projections have been rebuilt.
- Applied migration `0018` locally, activated `COMMUNITIES_READ_MODE=legacy`, recreated the API
  with the existing Web Push secrets override and verified the authenticated `/communities` page:
  18 current memberships, PadlHub UUID routes, no UI error and a successful redacted legacy read.
- Replaced the seeded Home community component with a background producer fed by the same real
  directory. The worker persists a five-item normalized source component, advances safely beyond
  older revisions and emits it through outbox/projector without adding legacy fan-out to Home.
- Applied migration `0019` locally and verified the full projection path: worker source revision 2
  produced `home-v1-236`, and authenticated Home rendered five real memberships with no seeded
  community cards remaining.
- Added the community-logo media bridge: legacy logo URLs stay worker-only, while allowlisted images
  are bounded, converted to WebP and stored under content-addressed PadlHub UUID object keys.
- Added tenant-RLS logo mapping and delayed object-GC state in migration `0020`. Logo metadata and
  the Home community component commit together; unchanged assets are reused and transient failures
  retain the last local logo.
- Split community projection into its own bounded worker cycle so a Viva authentication/provider
  outage cannot block community membership or logo refresh.
- Applied migration `0020` locally and imported all five visible Home logos from legacy relative
  media paths. Verified private `image/webp` objects at 512 by 512, component revision 5,
  `home-v1-243`, five rendered Home images and the same five local images in the 18-item directory.
- Made Home community labels deterministic two-line captions with balanced word-boundary splits,
  per-line ellipsis for long text and vertical centering for single-word names without changing the
  fixed community-section height.
- Turned the Home community row into a touch-native horizontal carousel. It keeps the five-item
  Home snapshot as an immediate fallback, hydrates the row from the real membership directory and
  automatically requests the next opaque-cursor page when the user swipes near the end.
- Extended the bounded community worker read across every directory page so local WebP logo
  mappings are prepared for carousel items beyond the five summaries retained in the Home snapshot.
- Added explicit desktop mouse dragging to the Home carousel. Native touch/trackpad scrolling stays
  enabled, drag movement suppresses the following link click, and scroll snapping pauses while the
  pointer is held so the row follows the cursor directly.

## 2026-07-16 — CUP manual notification campaigns

- Replaced the CUP placeholder with an authenticated notification workspace at port `5174`:
  recipient phone preview, Web Push/Android/iOS capability cards, optional in-app delivery,
  message composition and accepted-campaign result.
- Added the dedicated `phub-admin` JWT audience. Admin API requires both role `admin`, permission
  `notifications.manage` and the CUP platform header; normal client tokens have administrative
  claims stripped.
- Added tenant-RLS access profiles and manual campaign/recipient/idempotency tables. Phone inputs
  are normalized for lookup but are not persisted; ambiguous duplicates fail closed.
- Added capability, recipient-resolution and idempotent campaign Admin API operations. Campaign,
  intents, inbox, push deliveries, audit and identifier-only outbox events commit in one
  transaction; APNs/FCM remain explicitly unavailable.
- Added a dry-run/apply/audited access-grant command and documented CUP enablement and rollback.
- Added a fail-closed local-only CUP OTP override so Docker can keep Viva sandbox projections while
  one explicitly configured, already-authorized operator signs in without a real SMS. Non-local
  configuration is rejected and normal web/mobile auth remains on Viva.
- Applied migration `0017` locally, granted the internal operator, started the Docker CUP and ran a
  live campaign: one inbox delivery reached `DELIVERED`, one Web Push reached `SENT`, and the same
  idempotency key replayed the original campaign.

## 2026-07-16 — iPhone-safe authentication entry

- Diagnosed the Viva OAuth failure before the PadlHub callback: iPhone attempts launched from
  Telegram reached Keycloak but lost its restart cookie during the external identity-provider
  round trip.
- Made phone OTP the default unauthenticated entry on iPhone and iPadOS while preserving explicit
  access to VK ID and Yandex OAuth.
- Added visible Safari guidance before external OAuth on iOS, kept the same preference after logout
  and covered iPhone, iPadOS desktop mode and non-iOS behavior with regression tests.

## 2026-07-16 — Web Push/VAPID notification vertical slice

- Added encrypted, per-installation Web Push subscription storage with durable registration and
  revocation idempotency, tenant RLS, user attribution and audit records that never contain the
  plaintext endpoint or subscription keys.
- Added protected User API/OpenAPI/SDK operations for capabilities, subscription registration and
  revocation, plus a browser notification screen, explicit permission flow and same-origin service
  worker for display and deep-link navigation.
- Extended notification projection to create PUSH deliveries only when both the tenant Web Push
  gate and an active matching provider account exist; in-app delivery remains independently
  available.
- Added the VAPID adapter with bounded payloads, timeout, retry/backoff, a provider-account circuit
  breaker, terminal subscription invalidation, delivery attempts and honest `PROVIDER_ACCEPTED`
  receipts.
- Added dry-run-by-default commands for the provider account and tenant gate. Global, tenant and
  provider gates remain disabled until sandbox credentials and the rollout smoke tests are approved.
- Added file-backed runtime secret loading and a local provisioner that creates protected VAPID and
  endpoint-encryption files outside Git, then mounts them through a Docker Compose secrets override.
- Applied migration 0016 to the local development database, recreated API/worker/web with the
  sandbox override, activated the `local-padel` Web provider account and tenant gate, and verified
  live capability plus encrypted register/replay/revoke behavior. Provider acceptance/display still
  requires a real user-granted browser subscription.
- Enabled the matching in-app gate after the live `/notifications` screen exposed a `404` inbox
  dependency, and made the Web screen tolerate independent inbox/config/browser-state failures
  instead of replacing all working controls with one generic error.

## 2026-07-16 — Repeat Viva OAuth delegation repair

- Diagnosed callback failure `23505` after a successful Viva token exchange: a legacy delegation
  still belonged to a duplicate PadlHub user while the canonical Viva profile resolved to the
  reconciled user.
- Made delegation persistence idempotent by serializing replacement per canonical user/issuer,
  removing an obsolete subject for that user, and transferring the issuer/subject-owned row to the
  canonical PadlHub user in the same transaction.
- Added a regression test covering the canonical-user transfer conflict path.
- Removed query strings from structured request logs so OAuth `code`/`state` values and other
  sensitive query parameters never enter application logs.
- Scoped profile-photo storage validation to the worker so enabling Home synchronization cannot
  crash API/realtime processes that never receive MinIO credentials.
- Wired the staging worker to the existing private Nano MinIO using Compose-time credential
  projection, kept the bucket private behind signed URLs, and added bounded multi-process readiness
  diagnostics before public smoke tests.
- Added explicit ESM package exports for `@phub/auth/viva-delegation` and a post-build runtime import
  gate after the ARM64 image exposed that dev-time TypeScript resolution had masked the missing
  production subpath contract.

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
