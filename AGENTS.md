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

## Risk-based delivery workflow

Classify the highest-risk intended change as R0-R4 and use the global Fast, Spark, Main,
or Critical lane. A scoped development request authorizes one continuous reversible
task-branch loop: identify `origin/main`, create a focused worktree and `codex/*` or
`agent/*` branch, implement the requested outcome, run proportionate checks, create
focused commits, push only that task branch, open or update a Draft PR, read CI, and fix
in-scope CI failures. Do not pause merely because one reversible step completed.

Human approval remains mandatory before merge, direct push to `main` or another protected
branch, force push, deploy, migration/backfill execution, live/shared data mutation,
secret/key changes, permissions/RLS/ACL changes on a real target, DNS/ingress/routing,
payment/refund, external messages, or destructive rollback. A Draft PR, green CI, local
PostgreSQL rehearsal, or staging artifact never authorizes those actions.

Use focused checks for R0-R2 and expand to `npm run check` for auth, public contracts,
schema/migrations, shared/root configuration, dependencies/lockfiles, deployment files,
multi-workspace impact, R3/R4, or unclassifiable scope. Do not repeat an identical passing
command without changed source, inputs, environment, acceptance target, or a new
hypothesis. R0 needs no independent reviewer; R1 normally uses self-review; R2 uses at
most one reviewer unless two distinct triggers apply; R3 uses one specialist per actual
risk; R4 uses two genuinely independent perspectives. Use at most two concurrent spawned
agents and never overlap write ownership.

Continue independent in-scope work if one lane is blocked. Stop for missing material
product authority, suspected credential/PII exposure, scope expansion, an inseparable
broken baseline, unavailable required access, or a prohibited next action. A failed
post-deploy change returns to a focused task/hotfix branch; never edit Nano directly.

## Required verification

Run the nearest affected tests, typecheck, lint, and build for ordinary scoped R1/R2 code
changes; run `npm run check` on the expansion triggers above. Run `docker compose config`
for Compose changes. Update the relevant ADR/runbook/domain documentation whenever an
invariant or operational procedure changes. Report checks not run and why.
