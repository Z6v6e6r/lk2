# ADR 0023: Browser-only Viva End User transport

- Status: accepted; rollout pending
- Date: 2026-08-22
- Amends: [ADR 0005](0005-viva-user-delegation-and-direct-transport.md),
  [ADR 0008](0008-server-owned-client-routing-plan.md), and
  [ADR 0019](0019-home-base-and-viva-egress-gate.md)

## Context

Viva accepts the same user-scoped calls from its first-party browser flow but can reject traffic
from shared PadlHub server egress. A successful OTP token exchange followed by a server-side
`/end-user/api/v1/{tenant}/profile` request therefore leaves the user unauthenticated even though
Viva has already verified the code. The same egress boundary affects profile, schedule, booking,
subscription and exercise reads.

PadlHub already has a client-assisted boundary: the server owns routing, delegation refresh,
normalization jobs and public DTOs, while the browser holds only an ephemeral Viva access token and
executes fixed, allowlisted reads. Retaining a server fallback would recreate the provider block,
amplify load and make behavior depend on the API node's address.

## Decision

All Viva **End User API** reads in sandbox and production execute in the authenticated user's
browser context, except the narrowly scoped Android `MY_BOOKINGS` transport below. PadlHub API and
worker processes do not call `/end-user/api/...`.

### Android My Bookings exception (2026-10-12)

The installed Android client could read an existing upcoming-bookings projection but could not
refresh it. Its `BOOKINGS_PROJECTION_STALE` response is not repaired by the HomeBase worker: the
browser-assisted `MY_BOOKINGS` completion is the sole writer of that projection. The product owner
approved one Android read-only exception for this concrete consumer.

The bundled, trusted Android page may invoke only a no-argument native
`refreshUpcomingBookings` capability. Native code validates the current server routing plan,
authenticated principal and fixed, expiring `MY_BOOKINGS` job, then executes the existing
`bookings.read -> bookings.details.read` chain from the user's device. Only bounded GET requests to
the exact approved Viva HTTPS origin and server-issued tenant are permitted. Detail IDs come only
from the immediately preceding active-booking list, with a maximum of 50 and 128 characters per detail ID. The existing global and
tenant routing/delegation gates remain authoritative; the capability does not add delegated scopes,
enable those gates, or promote bookings to general-purpose direct operations.

The delegated access token is an opaque credential supplied by the authenticated PadlHub endpoint;
native code bounds its size and Bearer header grammar without requiring a JWT format or claims.
Delegation remains server-owned and bound to the active user/tenant/session family; the fixed provider
tenant comes from the authenticated routing plan, not from client token parsing. Rejection diagnostics
use only a closed plan/job/delegation/list/details/result/completion stage vocabulary. Unresolved
job-stage rejection additionally exposes one of ten compile-time reasons: transport, media, JSON,
contract, command, ID, expiry format, Date, expired lifetime or excessive lifetime. These reasons
classify existing validators; they do not change the accepted response set or reveal response bytes,
field names/values, identifiers, timing or parser exceptions. Delegation-stage rejection also uses
nine fixed classes: transport, media, JSON, contract, token grammar/size, expiry format, Date,
expired credential or invalid timing arithmetic. Unknown reasons retain the generic fallback.

Plan, job and delegation expiry use the `Date` from their own authenticated HTTPS response and a
monotonic request timer. The calculation deducts the complete request/processing interval and the
HTTP date's one-second precision, while keeping the plan's one-hour and job's 120-second maximum
lifetimes. The delegation API does not specify a provider token maximum TTL. A valid longer-lived
credential is accepted, but its local token deadline is capped to the already validated plan/job
deadline before arithmetic addition; it never extends that deadline, including after provider 401.
An earlier credential expiry still stops provider reads. This prevents
ordinary phone clock skew from rejecting a fresh 120-second job or extending an expired one.
Malformed or duplicate dates fail closed; an absent date retains the original strict wall-clock
check. These response times remain native and cannot enter bridge diagnostics or telemetry.

The short-lived user token, provider IDs and raw provider responses remain in Java memory for this
invocation. They are never returned to JavaScript, persisted, logged or attached to exceptions.
Native code submits the bounded result to the existing PadlHub read job and completes it; PadlHub
validates and produces the projection. The bridge returns only `{ state: "refreshed" }`, and the UI
rereads ordinary `/bookings/upcoming`. Cancellation and logout retire the native lease before any
later submission or completion. Two memory-only, session-bound circuits use monotonic backoff after
provider failure and reset after successful reads. Closed operation/outcome/status-class/duration
metrics are scheduled after projection completion in a bounded background queue using the existing
authenticated PadlHub `routing-outcomes` route; metric failure or queue rejection is ignored,
never retried, and cannot alter the projection or credential store. Metrics contain no provider IDs,
URL, token or response body. The generic native request allowlist remains unchanged.

This exception permits no provider write, system key, arbitrary URL/method, server/worker End User
egress, expired-projection bypass or fabricated empty result. Provider denial or an unready server
gate fails closed. Native transport acceptance and the actual My Records/profile/reopen journey
require a physical-device check; source support or compilation is not that evidence.

This decision does not move the authentication protocol itself into application JavaScript:

- SMS challenge creation and OAuth/token exchange continue through Viva Keycloak from the PadlHub
  integration adapter;
- PadlHub verifies Viva access-token signature, issuer, `azp`, tenant key, expiry and subject
  server-side;
- after an OTP exchange, the signed token must contain `phone_number_verified=true`, and its
  normalized phone must exactly match the challenged E.164 phone;
- OTP may establish the `(tenant, issuer, subject)` identity from those verified claims without a
  profile request; it never accepts identity fields supplied by the browser;
- standard social OAuth resolves only an already-linked `(tenant, issuer, subject)` when the
  existing-subject bootstrap gate is enabled. Unknown subjects fail with
  `AUTH_IDENTITY_LINK_REQUIRED` instead of creating a second account;
- recovery OAuth remains subject-only and must resolve to the initiating PadlHub user.

The Viva refresh token remains encrypted server-side. The browser receives only the short-lived
access token already defined by ADR 0005. It cannot choose a provider URL or method: the server
routing plan and client adapter define the fixed read, bounds and normalizer. Commands still call
PadlHub APIs and retain authorization, idempotency and audit controls.

The former continuous `HOME_VIVA_SYNC_ENABLED` server reader is retired and rejected by
configuration. API startup no longer constructs the server-side Viva exercise/recommendation or
coach-summary sources. The old public coach-summary route returns an empty deprecated compatibility
page with a successor link; authenticated clients use the browser-assisted Event Catalog. Community
and PadlHub-platform projection producers are independently controlled by
`COMMUNITY_HOME_SYNC_ENABLED` and `PLATFORM_HOME_SYNC_ENABLED`, both default-off, and never inherit
the retired Viva flag.

## Failure behavior

- A missing, invalid, unverified or phone-mismatched token claim fails closed with the stable
  provider-unavailable authentication error and creates no PadlHub session.
- An unlinked social OAuth subject fails with `AUTH_IDENTITY_LINK_REQUIRED`.
- If a client-assisted read cannot run because delegation, CORS or Viva is unavailable, that
  operation is unavailable or uses an already-defined PadlHub projection. It never retries through
  PadlHub server egress.
- Disabling `VIVA_DIRECT_READ_ENABLED` prevents new delegated token issuance. It does not re-enable
  server-side End User traffic.

## Rollout and rollback

No database migration is required. Before rollout, staging must prove one fresh OTP login and each
enabled client-assisted read from the browser, then verify zero `/end-user/api/` requests from API
and worker containers. Rollback returns to the previous application release and keeps the browser
gate disabled; operators must not restore server End User egress as a fallback.

## Consequences

Shared server egress is removed from Viva user-data operations, matching the provider's working
first-party transport. Initial social OAuth for an unknown subject can no longer rely on a server
profile lookup; the account must first be linked by a verified phone flow or audited support
reconciliation. Browser CORS and client-assisted contracts become explicit rollout prerequisites.

## Amendment 2026-11-09: Android profile.read observation

- Status: accepted; rollout pending

### Context

The installed Android client rendered the self-profile header from PadlHub
`GET /{tenantKey}/profile` only. When the Home projection is absent the API serves an honest local
slice: identity, avatar and an assessed level when PadlHub stores one, but never provider money.
The browser fills the same header from the delegated `profile.read`, so one account showed `D+` and
a balance in the browser and `—` placeholders in the app. ADR 0023 intentionally bars native clients
from Viva End User traffic, so the app had no path to the provider-owned level and balance.

### Decision

The narrow native exception model already used for Android `MY_BOOKINGS` is extended to exactly one
additional operation, `profile.read`, for the Android application only. The device performs the
provider read; no API or worker process calls `/end-user/api/...`.

1. `POST /user/api/v1/{tenantKey}/profile/provider-read-jobs` issues one 120-second job with a single
   `profile.read` command. It requires an authenticated, authorized tenant session, the
   `X-App-Platform: android` header, `PROFILE_NATIVE_READ_ENABLED=true`, and a stored server routing
   plan for that user where `profile.read` is `DIRECT_VIVA`. Any other platform, plan or flag
   state fails closed with a stable `PROFILE_NATIVE_READ_DISABLED` / `DIRECT_VIVA_DISABLED` error.
   The job itself is issued from the stored plan; effective delegation readiness is enforced by the
   existing `POST /{tenantKey}/auth/viva/access` gate, which fails closed when the delegation is
   not ready.
2. The device validates the routing plan, obtains the fixed delegated access token through the
   existing `POST /{tenantKey}/auth/viva/access`, and performs exactly one bounded
   `GET {apiBaseUrl}/v1/{providerTenantKey}/profile` on the approved provider origin. Redirects,
   non-JSON, oversized bodies and unknown provider origins are rejected. No provider token, URL or
   identifier crosses the JavaScript bridge.
3. The device relays the bounded provider profile body to
   `POST /user/api/v1/{tenantKey}/profile/provider-read-jobs/{jobId}/results/{commandId}`. The API
   validates the job, principal, expiry and command, strictly parses the provider DTO and derives only
   the normalized assessed level (`label`, `value`) and the observed account balance
   (`balanceMinor`, `currency`) from the provider fields. It stores one
   `profile.provider_observations` row per `(tenant, user)` with `observed_at`, monotonic by time; an
   older or replayed submission never replaces a newer observation. The response contains no provider
   identifier, URL, token or raw payload.
4. `POST .../complete` consumes the job and confirms that the observation was accepted.
5. `GET /{tenantKey}/profile` merges the observation only on the local-slice fallback and only while
   `observed_at` is inside `PROFILE_OBSERVATION_MAX_AGE_SECONDS` (default 900). A complete Home
   projection always wins over the observation. The observation is never served to another user and
   never returned by `GET /{tenantKey}/profiles/{userId}`.

### Data ownership and limits

- Level and balance stay provider-owned (`VIVA_PRIMARY`) presentation values. The observation is a
  short-lived, read-bounded cache, not a ledger, entitlement, receipt or balance authority. The
  exception performs no provider write, creates no PadlHub business state such as a booking or
  payment, and does not change entitlements.
- Identity remains the authenticated PadlHub UUID. Provider profile names, phone numbers, identifiers
  and media URLs are not persisted or returned by this path.
- The migration is expand-only (`profile.provider_observations`); existing reads and the complete
  projection path are unchanged.
- Retention: one row per user, overwritten by newer observations and kept until the account is
  deleted. It is not an audit ledger; disabling the flag makes it unreadable to the merge path
  immediately, and an FK to `identity.users(tenant_id,id)` keeps account cleanup honest
  (`NO ACTION`). No destructive cleanup is needed for rollback.
- The relay body is untrusted client input, not a server observation. It transits the API only to be
  strictly parsed; it is never written to an API log, business row or error message, the request-log
  serializer keeps no body, and the device wipes its buffers. Only the normalized level and balance
  survive into `profile.provider_observations`.
- The provider payload is not signed: `X-App-Platform: android` and the payload are client assertions.
  The trust model is bounded by making the result self-only presentation data: only the
  authenticated owner's local-slice `/profile` fallback merges it, no eligibility, capacity,
  payment or other-viewer read consumes it, and neither the level nor the balance becomes an
  authority. A forged value can only mislead its own author's screen until the next real read or the
  read-bound expiry.
- Idempotency of this internal contract is the `(jobId, commandId)` pair, not the transport
  `Idempotency-Key` header: the result is accepted once per command, replayed from the stored result,
  and the job is consumed on completion. The device still sends a per-request correlation key for the
  API transport.
- One aggregate is read from one source: this amendment is an explicit, scoped exception for exactly
  two provider-owned presentation fields. The complete Home projection always takes precedence, the
  local slice merges only when the projection is absent, the window is bounded, and the fields do not
  overlap a different owner's values.
- Provider load is bounded: at most one device provider read per principal per 60 seconds, triggered
  only by a profile reload that still lacks a level or balance, with an in-flight guard. Accounts
  whose provider profile has no readable balance repeat that bounded attempt on reload; background
  polling is prohibited.

### Failure behavior

Missing flag, missing plan/delegation, a non-Android platform, provider denial, invalid payload or a
stored-observation write failure all leave the previous `/profile` response in place. The app keeps
rendering the documented `—` placeholder instead of failing the screen, and no retry loop is created.

### Rollback

Set `PROFILE_NATIVE_READ_ENABLED=false`: this is the read-path kill switch as well as the job gate, so
the merge stops immediately and the app falls back to the local slice without waiting for the
freshness window. Removing the routing-plan `profile.read` operation only stops new jobs; it does
not hide an already stored observation while the flag stays on. The observation row itself can stay:
it is unreadable while the flag is off, is never an authority, and expires by read bound once the
flag returns. The expand-only migration stays applied.

### Flag lifecycle

- Owner: the product owner of LK2 (first-version mode).
- Purpose: one Android-only provider observation for the profile header while PadlHub's own profile
  projection does not carry provider-owned level and balance.
- Activation criterion: a signed APK 1.14/code15 or later, a stored routing plan with
  `profile.read` = `DIRECT_VIVA`, and staging/device acceptance proving one provider 200, one accepted
  relay and a merged `/profile` reread, plus a provider readback that API/worker containers send no
  `/end-user/api/` traffic.
- Review/removal condition: remove the exception (or keep it only as a recovery path) once the
  native client can obtain provider-owned level and balance from a server-owned read; review no
  later than 2027-02-09.

### Production promotion precondition

This amendment is implemented and enabled on the disposable `lk2` beta lane only. Any future
production-lane promotion must first add a reviewed per-table runtime grant
(`SELECT`, `INSERT`, `UPDATE`, no `DELETE`) for `profile.provider_observations` to the production
privilege route and include it in that release's evidence; the disposable beta lane grant alone is
not production evidence.
