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
browser context. PadlHub API and worker processes do not call `/end-user/api/...`.

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
