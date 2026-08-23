# ADR 0005: Viva user delegation and direct user transport

- Status: accepted, direct-command portion superseded by ADR 0008
- Date: 2026-07-12
- Extends: [ADR 0004](0004-provider-neutral-authentication.md)
- Amended by: [ADR 0019](0019-home-base-and-viva-egress-gate.md)

## Context

The first Viva-backed cabinet operations are profile, available schedule slots and booking reads.
Running all of these read operations from a shared PadlHub egress can trigger Viva
rate or anti-abuse controls and does not preserve the practical "act as this customer" behavior of
the existing Viva cabinet.

PadlHub still needs its own authenticated session, authorization model, audit trail and an exit
path from Viva. A browser must not receive a Viva system key or a durable credential.

## Decision

Viva OAuth Authorization Code with PKCE is the primary cabinet sign-in. The user chooses `vkid` or
`yandex`; the browser starts a PadlHub endpoint, which owns the OAuth `state`, `nonce`, PKCE verifier,
return URL allowlist and legal-acceptance intent. The callback is handled by PadlHub, which verifies
the Viva response, verifies `(issuer, subject)`, reads the stable Viva client profile ID and resolves
that integration-only identifier to one PadlHub user UUID before issuing the normal PadlHub access
JWT and rotating `HttpOnly` refresh cookie. Different VK ID/Yandex subjects for the same Viva client
are identity links of that one user; phone and email are never account-linking keys. A conflicting
pre-existing mapping fails closed for audited reconciliation instead of creating or merging users.

When Viva accepts the OAuth token exchange but forbids the server-side End User profile read with
`403`, a tenant may use the direct-read gate for a narrower bootstrap. PadlHub still verifies the
access-token signature, issuer, audience/client and subject, then resolves only an already-existing
`(tenant_id, issuer, subject)` mapping. It does not create a user, infer identity from token profile
claims, or accept a Viva profile ID from the browser. An unknown subject fails with
`AUTH_IDENTITY_LINK_REQUIRED`; the normal canonical-profile flow or an audited support
reconciliation must establish the link first. The resulting short-lived access-token is handed to
the browser as described below, so the allowlisted profile read can run directly.

The successful callback may also create or rotate a **Viva user delegation**. It is not a PadlHub
session and never changes the public PadlHub user UUID.

The provider-neutral phone flow may create the same server-only delegation when Viva's verified
phone grant returns a refresh-token. This does not expose a provider token to the client and does
not add a second identity-link rule: the verified issuer/subject remains the canonical mapping.
Deployments that require the Viva-backed Home projection reject a phone login without that
refresh-token rather than issue a partially usable PadlHub session.

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
operations defined by the current server routing plan. ADR 0008 narrows the deployed vocabulary to
profile, booking-list, booking-detail, subscription and schedule reads.

The browser receives neither a Viva system key nor a Viva refresh-token. It does not select the
source: PadlHub returns a signed operation policy/capability for an approved route, tenant, user,
HTTP method and expiry. Any other Viva URL, scope or command is rejected by the client adapter.

Purchase, cancellation and every other command stay behind PadlHub APIs. Direct client command
transport is not enabled by this ADR.

The first-party web client routes the authenticated user's self-profile according to the
server-issued plan. `PADLHUB_API` returns the PadlHub projection; `DIRECT_VIVA` performs the fixed
browser read and keeps its normalized, provider-free result in memory only. The direct result is
never merged with locally stored media, relayed back for persistence, or used to fill or refresh a
Home projection. Another player's profile always stays behind the PadlHub API. The Home surface
composes the separately routed self-profile aggregate with the `HomeBase` partial recovery contract
defined by ADR 0019.

An active delegation is runtime credential state, not a routing-policy prerequisite. When the
tenant policy enables `profile.read`, the plan continues to advertise that fixed direct operation
even if the delegation is missing, expired or revoked. The browser then requests an access token;
`VIVA_REAUTH_REQUIRED` starts the server-bound recovery OAuth flow. Disabling the global gate,
tenant mixed mode, provider binding or operation allowlist still returns `PADLHUB_ONLY` and must not
start recovery.

The general-purpose direct exception remains limited to `DIRECT_VIVA_CONTRACT_READY_OPERATIONS`.
ADR 0020 defines a narrower server-directed exception for booking-screen read jobs: the browser may
relay a bounded list/details pair only when the authenticated PadlHub API issued the exact
short-lived command. The relayed payload is validated and converted to a provider-free screen
snapshot before storage; it is never written into a business projection or accepted as proof for a
command. Subscription reads remain outside that exception.

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

- `DIRECT_VIVA`: an allowlisted read route is executed by the user agent using a short-lived delegation;
- `SERVER_VIVA`: a controlled emergency fallback where Viva accepts server traffic;
- `LOCAL`: the PadlHub implementation is the source and command owner;
- `UNAVAILABLE`: block the operation with a stable error rather than silently merge data.

The policy is evaluated server-side and returned as the short-lived plan defined by ADR 0008. Replacing Viva is
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

## Browser phone OTP boundary

The `browser_phone_otp_v1` challenge capability is a narrow first-party web exception, not a
general Viva client. PadlHub selects its public configuration and binds completion to a
challenge-scoped HttpOnly cookie; the browser cannot select tenant, issuer or provider endpoints.
The only credential returned to PadlHub is a short-lived Viva access token for signature
verification. Any Viva refresh credential in the provider response is deliberately ignored. Token
id replay is atomically bound to one challenge, and metrics contain only the operation,
correlation-id, outcome and status. There is no refresh-token handoff, delegation persistence or
permission expansion in this flow.

Before this capability can be enabled in a staging canary, the release preflight must attest Viva
CORS for the exact cabinet Origin on both the SMS `GET` and token form `POST` endpoints. A failed,
missing or stale attestation is fail-closed; the web client must not advertise the capability and
the API must not fall back to a server-side Viva OTP request.
