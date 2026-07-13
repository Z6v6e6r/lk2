# Worklog

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
  in-memory short-lived browser access-token, refresh/revocation behavior and the direct-Viva
  allowlist for profile, slots, purchase and cancellation.
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
