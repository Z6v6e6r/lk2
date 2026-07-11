# PadlHub engineering rules

These rules are mandatory for every change in this repository.

## System boundary

- Web, mobile, Tilda bundles, and CUP clients call only PadlHub APIs.
- Clients never receive a Viva system key, never use Viva identifiers as primary identifiers, and never choose a data source.
- All Viva traffic goes through `@phub/viva-adapter`. Optional direct reads require a short-lived, user-scoped delegation issued by the backend and remain disabled until Viva supports that contract.
- One aggregate is read from one consistent source/version per operation. Do not merge fields from local, cached, and Viva responses.

## Data ownership

- Every tenant-owned business row includes `tenant_id`; tenant isolation is enforced in application code and database constraints.
- Each domain has exactly one write owner: `VIVA_PRIMARY`, `SHADOW_COMPARE`, `LOCAL_PRIMARY`, or `LOCAL_ONLY`.
- Never implement independent dual-write. Local-primary changes write business state and an outbox event in one PostgreSQL transaction.
- Redis is cache/locks/rate-limit state, never the source of truth.
- Database changes use backward-compatible expand/migrate/contract releases. API processes never run migrations on startup.

## API and security

- Public identifiers are PadlHub UUIDs. External identifiers stay inside integration storage.
- Every request carries or receives `X-Correlation-ID`; tenant context and PadlHub JWT claims are verified server-side.
- Critical commands require an `Idempotency-Key`, authorization, audit event, and stable error code.
- External calls always have a timeout, bounded retry policy, circuit-breaker behavior, metrics, and redacted logs.
- Secrets never enter Git, images, web/mobile bundles, logs, or shared environment files.

## Runtime and delivery

- `apps/api`, `apps/worker`, and `apps/realtime` are separate processes over shared domain packages; this is a modular monolith, not a microservice fleet.
- Local development uses Docker Compose with synthetic data and `VIVA_MODE=mock` or `sandbox`.
- CI tests, typechecks, lints, validates OpenAPI and migrations, scans for secrets/dependency risk, and builds images.
- Build an immutable image once and promote the same digest through staging and production. Never deploy `latest` and never build on a production server.
- Production rollouts require health/readiness checks, smoke tests, approval, a verified backup, sequential nodes, and a tested rollback path.

## Required verification

Run `npm run check` for code changes. Run `docker compose config` for Compose changes. Update the relevant ADR/runbook/domain documentation whenever an invariant or operational procedure changes.
