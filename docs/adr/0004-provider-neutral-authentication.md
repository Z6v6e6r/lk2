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

## Native Android Yandex transport

Android uses the existing server-owned Viva/Yandex provider flow through a one-use browser launch.
An additional independent native S256 challenge binds the provider result to its initiating APK.
The browser callback issues only a metadata-backed 120-second code in a verified HTTPS App Link
fragment; it never discloses PadlHub/Viva credentials or sets the PadlHub refresh cookie in the browser.
Only the native HTTPS exchange, with the verifier/state and first idempotency key, receives the
existing session response. Same-key recovery requires the exact active, unrotated session on every
attempt. The encrypted native attempt journal is cleared only after atomic Keystore credential
custody (including the server-echoed attempt marker), cancellation before callback, terminal expiry,
or durable logout intent. Web OAuth and iOS OTP contracts are unchanged. Certificate association,
retention, negative tests and release prerequisites are in the
[Android runbook](../runbooks/android-development.md#yandex-login-13code-4).

## Native iOS client transport

The Capacitor iOS client uses the same OTP and cookie-backed session endpoints with
`X-App-Platform: ios`. Its first-party URLSession bridge retains `phub_refresh` exclusively
in namespaced, non-synchronizing Keychain storage (`WhenUnlockedThisDeviceOnly`); the access
JWT stays in JS memory. Refresh credentials and `Set-Cookie` never enter the WebView or a
shared cookie jar. This adds no refresh-token JSON contract or per-platform backend service.

The bridge permits only fixed HTTPS origins and named OTP/session/context operations, blocks
redirects and provider/OAuth operations, and serializes lifecycle requests. It durably journals
the predecessor/key before refresh, stores the successor before returning access, and completes
pending revocation before restoration after a relaunch. Network failures remain retryable;
they do not count as completed logout. See [iOS development](../../apps/mobile/README.md) for
configuration, simulator tests, integration ownership and the remaining app-return boundary.

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

## КЯ-04: additive email/password consumer login

The selected first independent LOCAL method is email plus password. `POST /auth/password/login`
is an explicit PadlHub method that coexists with the tenant-owned legacy phone provider. It does
not change `tenant_auth_config`, choose a provider from the browser, or run a phone code against
multiple providers. It authenticates only an already enrolled `identity.local_email_credentials`
binding to the existing PadlHub UUID. Contacts, profile email and imports never enroll an account.

The route is consumer-only, requires `Idempotency-Key`, `X-Session-Intent: password-login`, an
allowed browser origin and current legal acceptances. It uses the existing JWT and HttpOnly
refresh-cookie contract; `X-App-Platform: cup-admin` cannot select admin audience. The SDK stores
only the access token in its existing memory store and retries a lost response with one key.

The server checks raw ASCII email before case folding; the entire address is compared without
case sensitivity, without provider-specific dot/plus alias merging. Passwords preserve exact
Unicode/space bytes; enrollment policy is 15–128 code points and at most 512 UTF-8 bytes. Scrypt
uses only `phub-scrypt-v1`, N=131072/r=8/p=1, 16-byte random salt, 64-byte derived key and bounded
memory. Unknown/disabled/malformed credentials use the same KDF; credential rejection is uniform.
Independent shared Redis buckets allow at most 5 attempts/account/minute, 20/IP/tenant/minute,
and 120/service/minute. Two process slots cover the whole lookup/KDF/commit contour without a
queue; dependency/admission failure is fail-closed. The body is limited to 4 KiB. Credential
responses and errors have no-store headers; logs redact email/password/hash and requests carry
correlation. Success audit records only UUIDs/reason/correlation; HTTP status supplies failure
observability without an email label.

Password verification happens outside the transaction. The transaction locks the exact user
first, rechecks ACTIVE user/method, exact binding/id/hash/generation, then creates the root
refresh session, successful-login receipt and security audit on one client. Every future
credential writer must take this same user lock, increase generation, consume trusted proof and
revoke prior families in its own atomic transition. A verification snapshot from before reset
cannot create a session afterward. A login committed first is caught by the reset's revoke-all.
Refresh-session id/tenant/user are immutable; rotation/revocation/timestamp updates remain valid.

Receipt replay verifies the password again and requires the same credential generation, request
binding and exact unrotated, unrevoked, unexpired root session/token hash. The refresh token and
session UUID are reproduced with domain-separated PRFs over tenant/credential/generation/email/
command key; refresh hashing uses the existing canonical HMAC. Receipts store derivation version and stable SHA-256 command/request digests independent of rotating key material.
The request digest contains technical binding/versions and fixed client audience, never the password.
No derived key fingerprint or known-message JWT-secret verifier is persisted.
Changed refresh derivation keys deny old replay through the exact token/session check; no old family is revived or replaced. A
successful command key bound to another account/request returns conflict; the losing concurrent
transaction rolls back its session. Receipts are retained as tombstones for at least the original
session lifetime. This increment adds no pruning job or plaintext/encrypted password/token copy.

Migration 0097 is expand-only: empty credential and receipt tables, tenant FORCE RLS, bounded
5-second lock/30-second statement timeouts, and receipt/session ownership constraints. Binary
rollback leaves schema/ledger in place; use forward repair, never drop enrolled data. Runtime
login needs SELECT on credentials/profile/users/receipts, UPDATE on users for row locks,
SELECT/INSERT/UPDATE on refresh sessions and INSERT on receipts/audit. It must have no INSERT,
UPDATE or DELETE on credentials; trusted enrollment/reset ownership is a separate future boundary.
Actual target ACL/default privileges must be verified before activation; synthetic CI grants do
not establish live access. A failed/missing migration or dependency yields a redacted 503.

Production enrollment and activation are unavailable until trusted email proof/delivery, exact
account enrollment, reset/recovery, incident response, receipt-retention/key lifecycle and container
memory capacity are accepted and verified. There is no setup/register/recovery route, credential
write export, seeded credential, staff grant, contact backfill or email provider write. LOCAL tests
exercise only synthetic fixtures; production users cannot enroll through this increment.

## КЯ-04: internal enrolled-email recovery proof and reset

The next bounded increment implements `LocalPasswordResetService` and the separate internal
`@phub/database/password-reset` capability. It has no public route, SDK entry, UI, `main.ts`
wiring or production sender. It cannot enroll a credential, change an email, choose an account
from contacts/profile/imports or create a user. Initial enrollment still requires a fresh already
bound factor plus proof of the new email; a current consumer session alone is insufficient.

Issuance resolves only an ACTIVE, already verified dedicated login credential in the exact tenant.
Under the account lock it rechecks the binding/generation, reserves a command-specific challenge,
and enforces a one-minute cooldown and five issuances per account per hour. Independent Redis
account/IP/service admission and the existing two whole-operation/KDF slots bound the service.
This is an internal dependency contract; a future caller must provide the reviewed distributed
limiter namespace and trusted sender. Missing sender denies issuance before lookup. No mail service,
key, runtime grant or external delivery has been configured by this increment.

The sender receives only the stored binding address and a random 256-bit reset token, proof UUID,
technical idempotency key and ten-minute TTL. The technical key must accompany the token in the
future mail flow so another browser can complete the same command. Only a SHA256 token digest is
persisted, bound to tenant/user/credential/generation, `RESET_LOCAL_CREDENTIAL` and command key.
There is no six-digit code, raw token store, password HMAC or key fingerprint. Email delivery
acceptance does not itself prove ownership: only returning the token can authorize consumption.
PENDING becomes DELIVERED only after bounded sender acceptance (five-second deadline). Ambiguous
failure cancels an unconsumed PENDING/DELIVERED proof under the account lock and never retries its
email; a late message cannot authorize reset. Cancellation never undoes an already consumed reset.
Five wrong token attempts block an unconsumed challenge. TTL uses server/DB time and is not renewed.
Consumed challenges cannot be blocked by later guesses; all replay still requires the matching
high-entropy token, command and unexpired proof.

Reset locks the ACTIVE user first, rechecks exact credential/hash/generation and proof, consumes
once, writes a fixed scrypt hash with generation+1, invokes same-client revoke-all, revokes local
Viva delegation custody, inserts a technical receipt and writes a redacted audit in one transaction.
Failure anywhere rolls everything back. Provider SSO sessions are not remotely revoked. Prior
local delegation ciphertext remains revoked and is never restored by this recovery. The reset
issues no replacement family or access token: the user must log in again. This also prevents
recovery from issuing admin audience or restoring staff access. Requests already admitted before
revocation are not retrospectively cancelled.

Lost-response replay changes nothing. It requires the same token/key/proof, the current resulting
credential generation and the submitted new password verified against the canonical current
credential hash. The transaction rechecks that exact snapshot. A concurrent first commit gets one
bounded reinspection; a different submitted password, expired proof, disabled account/method or
later credential generation fails closed. No additional durable password verifier is introduced.
Internal persistence methods are trusted service capabilities, not browser inputs or attestation
booleans. Proof consumption cannot be authorized merely by passing `verified: true`.

0098 is an empty expand migration with plain CREATE, bounded lock/statement timeouts, FORCE tenant
RLS, exact composite proof/receipt ownership and command constraints, and an index only over the
new table. It does not grant rights or modify existing users/credentials/sessions/delegations.
Binary rollback leaves the ledger/schema in place; use forward repair, never drop proof or receipt
data. Cleanup must delete expired receipts before their proof rows; no cleanup job is enabled here.
Before activation, review retention/capacity, backup/ledger/locks, actual/default ACL and source
compatibility. The login role stays credential-read-only. A separate trusted reset owner may need
SELECT credentials and UPDATE only password_hash/generation/updated_at; proof INSERT and bounded
state-column UPDATE; receipt INSERT; session/delegation revocation-column UPDATE; user SELECT and
UPDATE(updated_at) only for row-lock capability; audit INSERT. It must have no credential
INSERT/DELETE, email/status update or account-status update. Test roles explicitly deny those writes.
Disposable test grants do not establish production permissions.

Public activation remains pending reviewed sender/delivery and notification policy, trusted initial
enrollment, uniform externally observable recovery errors/timing, abuse limits, secret lifecycle,
public Origin/intent/idempotency/body contracts, real resource/ACL checks and client UX. Internal
neutral issuance DTOs alone are not proof of a safe public enumeration contract. There is no
production enrollment, real email, migration, ACL mutation or background delivery in this increment.
