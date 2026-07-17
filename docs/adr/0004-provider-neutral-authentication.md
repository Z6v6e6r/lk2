# ADR 0004: Provider-neutral authentication and PadlHub sessions

- Status: accepted
- Date: 2026-07-11
- Extends: [ADR 0002](0002-viva-boundary.md)
- Partially extended by: [ADR 0005](0005-viva-user-delegation-and-direct-transport.md)

## Context

The first user vertical contains phone authentication and the authenticated home page. Viva is
the initial identity provider, but changing a tenant to PadlHub Identity must not require a client
release or expose Viva concepts in a public contract. Schedule, availability and booking are not
part of this vertical.

## Decision

Clients call only the PadlHub User API. They start and verify a `phone_otp` challenge, refresh a
PadlHub session, revoke it and read the authenticated PadlHub context. A client never selects
`VIVA` or `LOCAL`, never calls an identity provider directly and never receives its tokens,
tenant/system keys or identifiers.

The API resolves one authentication-provider binding for the verified tenant:

- `VIVA`: `@phub/viva-adapter` performs phone-code delivery, code exchange and normalized profile
  resolution;
- `LOCAL`: PadlHub Identity implements the same internal provider port;
- switching the binding changes backend routing only; the public API and client state machine stay
  unchanged.

Provider configuration and secrets remain server-side. Viva access and refresh tokens are scoped
to the adapter call and never enter a normal PadlHub response, session row, log, trace or metric.
The only narrowly defined exception is the feature-gated user delegation in ADR 0005: an
allowlisted, short-lived Viva access-token may be delivered to browser memory for approved
direct-Viva operations; a Viva refresh-token remains envelope-encrypted on the server.
When a verified Viva phone-code exchange returns a refresh-token, the adapter returns it only to
the authentication service, which stores the same encrypted delegation used by the Home worker.
If the deployment requires Viva Home synchronization but the exchange supplies no refresh-token,
authentication fails closed with `VIVA_REAUTH_REQUIRED` instead of creating a session whose Home
can never become ready.

## Identity mapping

An accepted provider identity is normalized to `issuer`, `subject` and approved profile fields. A
unique `(tenant_id, issuer, subject)` integration mapping finds or creates a stable PadlHub user
UUID. That UUID is the only user identifier in PadlHub JWTs and public APIs. A provider switch may
link a new provider subject to the existing PadlHub user only through an explicit, audited identity
link; it must not infer equivalence from an unverified phone number.

## Challenge and session lifecycle

- The phone challenge is ephemeral Redis state with a short TTL, attempt limit and provider binding
  captured when it is issued. Issuance has a per-tenant/phone cooldown, and verification acquires
  an atomic lease before calling a provider so one challenge can create only one session. Redis is
  not an identity or session source of truth.
- Challenge, verification, refresh and logout commands require a client idempotency key. Login and
  refresh credentials are derived server-side for safe replay of a lost response; a different
  concurrent refresh receives a short race response instead of revoking a healthy token family.
- Client phone verification requires both current legal acceptances. The API records versioned
  `PHONE_OTP` acceptance rows against the verified PadlHub UUID before creating the refresh
  session. CUP-admin authentication is a separate audience and does not create consumer legal
  acceptance rows.
- The browser keeps the short-lived PadlHub access JWT only in memory. Reload recovery calls the
  PadlHub refresh endpoint; browser storage never contains access, refresh or Viva tokens.
- Refresh credentials are random opaque values in an `HttpOnly` cookie. The credential rotates on
  refresh and only its cryptographic hash is stored with the PostgreSQL session row.
- Production refresh cookies are always `Secure`. Cookie scope and same-site policy are configured
  by the API, not client code.
- The access JWT binds the PadlHub user UUID and tenant and is verified server-side. It contains no
  Viva identifier or token.
- Logout revokes the refresh session and expires the cookie.
- Identity linking and session create/rotate/revoke operations write a correlated security audit in
  the same tenant transaction. Provider bindings and external subjects live only in the
  `integration` schema.
- API rate limits use shared Redis state. Production must explicitly trust only configured
  load-balancer proxy CIDRs; phone and challenge rate keys are keyed HMACs, never raw identifiers.

## Viva call policy

All Viva authentication calls use a three-second timeout and propagate `X-Correlation-ID` where the
upstream contract permits it.

- OTP send and token exchange have no automatic retry because they are not safely idempotent.
- The profile `GET` may retry once, and only for a transient transport error or retryable 5xx
  response. Authentication failures and other 4xx responses are not retried.
- Five qualifying failures open the circuit for 30 seconds. Circuit scope prevents one unhealthy
  provider operation from cascading through the API.
- Metrics cover provider operation count, duration, outcome and circuit state. Logs and telemetry
  redact phone numbers, one-time codes, cookies, access/refresh tokens and external subjects.

Failures are translated to stable PadlHub error codes. Provider response bodies and implementation
names do not cross the public boundary.

## Local development

`VIVA_MODE=mock` performs no Viva network call and accepts only the synthetic phone
`+79990000001` with code `0000`. Mock mode is forbidden in production. Production also refuses to
start without secure refresh cookies.

## Consequences

Viva can be replaced per tenant without a UI or public API migration, while PadlHub owns session
security from the first vertical. Identity mappings and provider readiness still require an
explicit migration and reconciliation before a production switch. The home page may consume only
the normalized authenticated context; schedule remains deliberately absent.
