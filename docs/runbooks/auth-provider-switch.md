# Runbook: authentication provider switch

Use this runbook to move one tenant between `VIVA` and `LOCAL`, roll that change back, or verify the
Viva mock locally. The client contract is provider-neutral; no web, mobile, Tilda or CUP release is
part of a provider switch.

See [ADR 0004](../adr/0004-provider-neutral-authentication.md) for the session and identity
invariants and [ADR 0005](../adr/0005-viva-user-delegation-and-direct-transport.md) for the
feature-gated OAuth delegation and direct-Viva transport.

## Non-negotiable guardrails

- Clients call only PadlHub product APIs and never receive a Viva system key, identifier as a primary
  identifier, or Viva refresh-token. The ADR 0005 exception permits only a short-lived Viva
  user access-token in browser memory for explicitly allowlisted direct routes.
- Change one tenant binding at a time. Do not introduce fallback merging or parallel verification
  across providers.
- Preserve the PadlHub user UUID. Never equate provider accounts by phone alone.
- Treat the binding change as a critical command: authorize it, use an idempotency key, record an
  audit event and retain the previous value.
- Do not delete users, integration mappings or session history during switch or rollback.
- This runbook covers authentication and the home context only. Do not include schedule data in its
  smoke tests or success criteria.

## Enable Viva OAuth delegation and direct transport

This is separate from a provider-binding switch. It is disabled by default and is switched through
the audited routing-plan procedure in
[the client routing runbook](client-routing-switch.md).

1. Obtain Viva's written confirmation for the exact PKCE redirect URI, `vkid` and `yandex` aliases,
   required scopes (including refresh/offline scope), access-token audience, refresh policy, revoke
   endpoint and permitted browser CORS origins.
2. In staging, verify that the OAuth callback creates a stable PadlHub UUID from Viva
   `(issuer, subject)`, writes the two document-version acceptances, creates a PadlHub session and
   stores the Viva refresh-token only in encrypted delegation storage.
   If the server-side Viva profile read is `403`, enable
   `VIVA_OAUTH_EXISTING_SUBJECT_BOOTSTRAP_ENABLED` only after the identity-link reconciliation is
   clean. Prove separately that the callback resolves an already-linked subject without an identity
   upsert. This flag does not enable browser direct reads and must not change
   `VIVA_DIRECT_READ_ENABLED`. An unknown subject must return `AUTH_IDENTITY_LINK_REQUIRED`, create
   neither user nor delegation, and never accept a browser-supplied Viva identifier.
3. Inspect browser storage, response bodies, logs, traces and metrics. The only permitted Viva
   credential in the browser is a current access-token held in memory. It must not appear in cookies,
   LocalStorage, SessionStorage, URLs, error reports or analytics.
4. Verify token rotation in two browser tabs: exactly one refresh reaches Viva, the replacement
   refresh-token is persisted atomically, and both tabs receive a usable short-lived access-token.
5. Validate all five read operations in staging. Confirm direct browser requests have the approved
   GET route/query only and the client adapter emits only PadlHub DTOs and UUIDs.
6. Confirm purchases, cancellations and every other command continue to call PadlHub APIs with the
   required authorization, idempotency and audit controls.
7. Record release, actor, tenant, routing revision and correlation IDs. Monitor OAuth callback errors,
   delegation refresh failures, direct-route errors and reconciliation lag throughout the soak window.

### Roll out browser-bound OAuth state

OAuth starts created by the browser-binding release use the versioned Redis namespace
`phub:auth:v3:viva-oauth:`. It does not share the v2 or legacy prefixes. This boundary is
deliberate: an older API node cannot consume new recovery state and therefore cannot apply the old
session-creation behavior or bypass the initiating-browser and active-session-family checks during
a sequential rollout.

1. Deploy the exact API and web image pair proven in staging. Do not deploy the API change without
   the SDK change that sends browser credentials on both OAuth-start requests.
2. Roll API nodes sequentially and verify readiness after each node. A flow started on the previous
   release may fail closed with `AUTH_OAUTH_BROWSER_MISMATCH`, `AUTH_SESSION_REVOKED` or
   `AUTH_CODE_EXPIRED` on a new callback node; ask the user to start authentication again. Never
   fall back to accepting state without its browser cookie and active PadlHub session family.
3. After the last old API node is drained, wait through the configured
   `AUTH_CHALLENGE_TTL_SECONDS` window (60-900 seconds) before declaring the old unbound state cohort
   expired. Monitor `AUTH_OAUTH_BROWSER_MISMATCH`, `AUTH_CODE_EXPIRED` and callback success rates.
4. In an authenticated browser, force `VIVA_REAUTH_REQUIRED`, verify that the recovery start sets a
   state-scoped `phub_oauth_browser_{digest}` cookie, the callback clears only that state's cookie, a
   new PadlHub refresh cookie is **not** issued, the existing session refreshes normally after the
   redirect, the one-time Viva handoff succeeds, and the original internal route is restored. Log
   out in another tab before completing one flow and prove the callback returns
   `AUTH_SESSION_REVOKED` without replacing the delegation. Start two flows in separate tabs and
   complete them in reverse order to prove neither binding is overwritten. Repeat from a different
   browser without the matching cookie, then complete from the original browser to prove the wrong
   browser did not consume its state.
5. A rollback to an older API cannot consume v3 states. Treat the resulting
   `AUTH_CODE_EXPIRED` as a bounded restart requirement; do not move or rewrite Redis state keys.

### Emergency disable / switch to PadlHub

1. Set the tenant plan to `PADLHUB_ONLY`; if a broader incident exists, disable
   `VIVA_DIRECT_READ_ENABLED`. New browser Viva
   access-tokens must stop being issued immediately; do not revoke unrelated PadlHub sessions.
2. Keep PadlHub-only operations on their configured local source. Use server-side Viva only when
   Viva explicitly approves that backend traffic.
3. Existing browser access-tokens are not renewable and expire naturally. Revoke all server-side
   delegations only for a credential compromise or explicit user-security event.
4. Run the protected routing-plan and operation smoke tests against the selected replacement source.

## Pre-switch checklist

1. Confirm the target provider adapter and tenant configuration are present in the exact immutable
   image already proven in staging.
2. Verify API health/readiness, PostgreSQL backup status and Redis health.
3. Export the tenant's current provider binding and identity-link reconciliation report. The report
   must have no ambiguous or duplicate `(tenant_id, issuer, subject)` mappings.
4. For `LOCAL`, verify enrollment/account-linking has created an audited mapping to the existing
   PadlHub UUID for every migrated account. A matching phone is evidence to review, not proof of
   identity.
5. Confirm dashboards expose challenge outcomes, provider latency/errors, session refresh failures
   and circuit state. Search logs by a test correlation ID and verify sensitive values are redacted.
6. Verify the target provider policy: three-second timeout; no retry for OTP send/token exchange;
   one retry for transient profile `GET` failure; circuit opens after five qualifying failures for
   30 seconds.

## Switch `VIVA` to `LOCAL`

1. Announce the bounded rollout and stop concurrent tenant authentication configuration changes.
2. Let current challenges expire, or remove only that tenant's ephemeral auth-challenge keys. Never
   flush Redis globally.
3. Change the tenant authentication binding from `VIVA` to `LOCAL` through the approved audited
   configuration path. Record release, actor, idempotency key and correlation ID.
4. Start a new phone challenge through the PadlHub API, verify it and confirm that the response
   contains only a PadlHub access JWT and PadlHub user UUID.
5. Confirm the returned PadlHub UUID matches the pre-switch user, the authenticated home context
   loads, refresh rotates the opaque cookie and logout revokes the session.
6. Confirm no Viva authentication call occurs after the binding change and no provider name or
   token appears in browser storage, responses, logs or telemetry.
7. Soak the single tenant while monitoring authentication success, latency, refresh failures and
   circuit state. Expand only after the agreed window passes.

Existing valid PadlHub sessions are provider-neutral and do not require blanket revocation. Revoke
them only when the switch is responding to credential compromise or an identity-linking error.

## Roll back `LOCAL` to `VIVA`

1. Stop further rollout and capture failing correlation IDs and affected PadlHub user UUIDs.
2. Let `LOCAL` challenges expire, or delete only the affected tenant's ephemeral challenge keys.
3. Restore the recorded tenant binding to `VIVA` through the same authorized, idempotent and audited
   path. Do not perform a database down migration.
4. Run a fresh PadlHub phone challenge and verify login, stable PadlHub UUID, home context, refresh
   rotation and logout.
5. Confirm Viva call latency/errors stay within policy and sensitive data remains redacted.
6. Reconcile identities created during the failed window. Preserve every row and repair links with
   an auditable forward change.

If rollback does not restore login, open the authentication circuit manually only after verifying
the provider is healthy; otherwise keep the failure controlled and follow the incident-severity
runbook.

## Local Viva mock

The mock is synthetic and makes no Viva network request.

1. Copy `.env.example` to `.env` and keep:

   ```dotenv
   APP_ENV=local
   VIVA_MODE=mock
   AUTH_COOKIE_SECURE=false
   TRUSTED_PROXY_CIDRS=
   AUTH_DEV_PHONE_E164=+79990000001
   AUTH_DEV_OTP_CODE=0000
   ```

2. Start dependencies, apply migrations, then start API and web:

   ```bash
   docker compose up -d postgres redis rabbitmq minio otel-collector
   npm run db:migrate
   npm run dev:api
   npm run dev:web
   ```

3. Open `http://localhost:5173`, sign in with `+79990000001` and code `0000`, then verify the home
   page, reload/session restoration and logout.
4. Run `npm run smoke:auth` to verify challenge, login, protected context, idempotent refresh replay,
   cookie rotation and logout through the same public contract. When web runs in Compose, its Vite
   server proxies `/user/api` to the API container so the browser stays on one local origin.
5. Inspect browser storage and network responses: only the in-memory PadlHub access JWT may be
   visible to JavaScript; the opaque refresh credential is an `HttpOnly` cookie and Viva tokens are
   absent.

`VIVA_MODE=mock` and `AUTH_COOKIE_SECURE=false` are local-only. Production must use the real provider
mode, approved distinct secrets, `AUTH_COOKIE_SECURE=true` and an explicit
`TRUSTED_PROXY_CIDRS` allowlist; startup validation must reject an unsafe combination.
