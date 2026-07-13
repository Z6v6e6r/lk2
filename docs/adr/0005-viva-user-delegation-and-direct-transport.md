# ADR 0005: Viva user delegation and direct user transport

- Status: accepted, feature-gated
- Date: 2026-07-12
- Extends: [ADR 0004](0004-provider-neutral-authentication.md)

## Context

The first Viva-backed cabinet operations are profile, available schedule slots, booking purchase and
booking cancellation. Running all of these operations from a shared PadlHub egress can trigger Viva
rate or anti-abuse controls and does not preserve the practical "act as this customer" behavior of
the existing Viva cabinet.

PadlHub still needs its own authenticated session, authorization model, audit trail and an exit
path from Viva. A browser must not receive a Viva system key or a durable credential.

## Decision

Viva OAuth Authorization Code with PKCE is the primary cabinet sign-in. The user chooses `vkid` or
`yandex`; the browser starts a PadlHub endpoint, which owns the OAuth `state`, `nonce`, PKCE verifier,
return URL allowlist and legal-acceptance intent. The callback is handled by PadlHub, which verifies
the Viva response, resolves `(tenant_id, issuer, subject)`, and issues the normal PadlHub access JWT
and rotating `HttpOnly` refresh cookie.

The successful callback may also create or rotate a **Viva user delegation**. It is not a PadlHub
session and never changes the public PadlHub user UUID.

The OAuth start transaction immediately writes `legal.document_acceptance_intents` with the tenant,
provider, document versions, acceptance timestamp, correlation ID and a SHA-256 hash of OAuth state.
It stores no raw OAuth state or unauthenticated user identifier. After Viva establishes identity, the
callback atomically binds that intent to the PadlHub user UUID and inserts the two versioned rows in
`legal.document_acceptances`. Thus an interrupted external login preserves evidence of the click as
a pending intent, while only a verified identity receives final user-bound acceptances.

### Token locations

| Credential                 | Location                                                                 | Lifetime and use                                  |
| -------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------- |
| PadlHub access JWT         | browser memory                                                           | short-lived; authorizes PadlHub APIs only         |
| PadlHub refresh credential | `HttpOnly`, `Secure` browser cookie; hash in `identity.refresh_sessions` | rotating product session                          |
| Viva access-token          | browser memory only, supplied by the delegation endpoint                 | short-lived; only the approved direct-Viva routes |
| Viva refresh-token         | envelope-encrypted `integration.user_delegations` row                    | server-side only; obtains a new Viva access-token |

`integration.user_delegations` has `tenant_id`, PadlHub `user_id`, Viva issuer/subject, encrypted
refresh-token ciphertext and key version, granted scopes, expiry, last-refresh time, revocation and
failure metadata. It has tenant RLS and is never exposed through an API response, log, trace, audit
payload or analytics event. A rotation updates the delegation row atomically; concurrent refreshes
are single-flight/locked per delegation.

### Direct-Viva exception

While a tenant's operation policy is `VIVA_PRIMARY` and the corresponding feature flag is enabled,
the browser may call Viva directly with the short-lived user access-token for exactly these
operations:

1. profile read;
2. available-slot read;
3. purchase and cancellation commands.

The browser receives neither a Viva system key nor a Viva refresh-token. It does not select the
source: PadlHub returns a signed operation policy/capability for an approved route, tenant, user,
HTTP method and expiry. Any other Viva URL, scope or command is rejected by the client adapter.

For purchase and cancellation, the browser first creates a PadlHub command intent with an
`Idempotency-Key`; PadlHub authorizes it and records a security audit. The direct Viva result is
`PENDING_RECONCILIATION` until a Viva webhook, provider receipt verification, or scheduled
reconciliation proves the resulting Viva state. Client-supplied success is never sufficient to
authorize a booking, price, payment or right.

## Refresh, revocation and expiry

1. On a returning visit the PadlHub refresh cookie restores the PadlHub session.
2. On the initial callback PadlHub redirects with a two-minute, single-use `viva_handoff` code in
   the URL fragment (never query or Referer). The
   authenticated browser exchanges it for the already-issued Viva access-token, removes the code
   from the URL and keeps the token only in memory. A replay is rejected.
3. On later visits the authenticated browser requests a short-lived Viva access-token from PadlHub
   only when an approved direct operation needs it.
4. The adapter uses the encrypted Viva refresh-token, stores a rotated replacement before returning
   the new access-token, and emits redacted metrics. It must not retry an OAuth token exchange.
5. A Redis lease keyed by tenant/user serializes refresh across API nodes and browser tabs. A
   concurrent caller receives `VIVA_DELEGATION_BUSY` and retries with a new idempotency key.
6. If the Viva refresh-token is expired, revoked or lacks the required scope, PadlHub returns
   `VIVA_REAUTH_REQUIRED`. The PadlHub session may remain valid, but Viva-primary operations are
   blocked until the user signs in with Viva again.
7. Logout deletes/revokes the local delegation and the PadlHub refresh session. A security incident can
   revoke all delegations for one user or tenant without deleting identities or historical sessions.

"Long-lived" means the longest provider-approved refresh/offline session, never an artificial
extension by PadlHub. Exact Viva scopes, refresh lifetime, CORS origins, token audience, revoke URL
and callback URLs are production configuration verified before enabling the feature flag.
`VIVA_OAUTH_SCOPES` defaults to the MVP-compatible `openid`; `offline_access` is added only after
Viva confirms that scope for the production client.

## Fast source switch and rollback

The client calls the PadlHub operation contract and consumes PadlHub DTOs. It never embeds Viva IDs
as primary identifiers. A tenant/operation policy selects one of:

- `DIRECT_VIVA`: current Viva route is executed by the user agent using a short-lived delegation;
- `SERVER_VIVA`: a controlled emergency fallback where Viva accepts server traffic;
- `LOCAL`: the PadlHub implementation is the source and command owner;
- `UNAVAILABLE`: block the operation with a stable error rather than silently merge data.

The policy is evaluated server-side and feature-gated per tenant and operation. Replacing Viva is
therefore a configuration/rollout change after the PadlHub implementation reaches parity; the login
screen, PadlHub session and public DTOs do not change. Disabling `DIRECT_VIVA` immediately stops
issuance of browser Viva access-tokens. Existing tokens remain short-lived and cannot be renewed.

## Consequences

This is an explicit exception to the previous blanket prohibition on client-held Viva credentials:
the exception covers only ephemeral user access-tokens for an allowlisted transport. It does not
allow client-held refresh tokens, system keys, arbitrary Viva traffic, client source selection or
unverified command completion.

The feature remains disabled until a staging preflight proves Viva OAuth PKCE, the provider aliases,
CORS, token audience and permitted APIs. If any preflight condition fails, the UI must not expose a
working direct-Viva path; PadlHub remains on its current server-mediated or unavailable policy.
