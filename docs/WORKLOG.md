# Worklog

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
