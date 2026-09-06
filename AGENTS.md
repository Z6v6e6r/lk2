# PadlHub engineering rules

These rules are mandatory for every change in this repository.

## Authoritative instruction hierarchy

- This file is the common PadlHub engineering policy for repository work.
- A closer `AGENTS.md` may add commands or raise risk only for a named concrete boundary. It must
  not reintroduce universal release gates or approval stops for reversible development work.
- ADRs, domain documents and runbooks become mandatory when the changed or executed boundary is in
  their scope. Historical plans, audits, worklogs and release evidence are context, not default
  gates for a new task.
- CI, staging and production runbooks govern those evidence levels. They do not turn an ordinary
  local implementation into a release operation.

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

## Local product loop

Product development defaults to a task branch/worktree -> local implementation -> current-task
preview -> boundary-based checks -> Draft PR and CI. Use [lk2-dev](.agents/skills/lk2-dev/SKILL.md)
and the [local runbook](docs/runbooks/local-development.md). The FAST/SAFE/CRITICAL policy below
selects checks by the touched boundary; ordinary UI work needs no full release audit.
Development readiness grants no merge, image publication or deploy authority. LOCAL, CI, STAGING,
PROVIDER and PRODUCTION remain distinct evidence levels. Explicit
[lk2-release](.agents/skills/lk2-release/SKILL.md) and
[lk2-deploy](.agents/skills/lk2-deploy/SKILL.md) requests default to preparation; their invocation
is not authorization for publication or live writes. Detailed procedures stay in those skills and
the existing delivery/Timeweb runbooks.

## Parallel development and delivery ownership

Up to four independent task branches may be active in this repository at once. This repository
portfolio limit is separate from the limit of two read-only subagents inside one complex task. Each
task owner owns only its branch, clean worktree and Draft PR. Task owners may fetch, safely update
their own branch and resolve their own conflicts, but they do not own another task branch,
integration batch, release publication or deploy.

Only one active platform/release task may change `.github/workflows/**`, `deploy/**`, the root
dependency graph or release scripts at a time. Parallel task owners must not independently change
the same public contract, migration chain, auth boundary or release workflow. Overlapping UI entry
points are allowed when the PRs declare an integration order and defer cross-PR conflict resolution
to one integration batch.

Ordinary `main` drift does not require every task branch to synchronize or repeat certification.
Synchronize when relevant source or dependencies overlap, a real conflict appears, an input or
environment changes, or immediately before common integration. Repeat a successful check only when
its code, dependencies, command, environment, inputs, acceptance target or tested hypothesis
changed. Draft to Ready is a lifecycle transition, not a security boundary; automated gates and
explicit live boundaries carry the security contract.

The delivery roles are distinct:

- A task owner produces one focused task head and proportionate evidence.
- An integration owner appears only for a batch of two to four ready task heads, owns one temporary
  `integration/**` branch and resolves cross-PR conflicts there once. The integration owner runs the
  full integration contour but does not publish or deploy.
- A release owner freezes one green integration source and, only with separate authority, publishes
  one immutable set of images and one canonical manifest. Publication is never a PR Docker build.
- A deploy owner accepts only the immutable manifest, pulls by digest and separately executes
  backup, readiness, smoke and rollback gates. Timeweb never rebuilds release images.

Exclusive ownership applies to the temporary integration branch, release publication and live
boundary being executed. It does not make one merge owner responsible for synchronizing every task
branch. See [temporary integration batches](docs/runbooks/delivery-batches.md).

## Risk-based delivery policy

### Separate product risk from execution route

Classify each changed command, write path and trust boundary as `FAST`, `SAFE` or `CRITICAL`.
`FAST` is the default. Escalation requires either a concrete failure mode tied to the intended
change or one of the automatic CRITICAL boundaries below.

The product risk tier selects evidence and review. The global Fast, Spark, Main or Critical lane
selects who executes work of a given size and ambiguity. They are separate axes: a multi-file
read-only UI may use the Main execution lane while retaining FAST gates. R0/R1 normally map to
FAST, R2 maps to SAFE unless it is presentation/read-only work, and R3/R4 map to CRITICAL.

Strictness follows the actual boundary, not the page, module, PR or repository containing it. A
mixed diff reports and validates each boundary separately. The presence of one CRITICAL button
does not make unrelated rendering CRITICAL; changes to that button's command path still are.
The highest PR tier and minimum execution route follow the highest-risk touched boundary, so any
CRITICAL boundary uses the Critical lane. Lower-risk files keep their scoped checks rather than
inheriting unrelated release evidence.

### FAST — default

FAST applies when failure is easy to reverse and cannot move money, violate authorization or
security, destroy durable data, create an external side effect or require a destructive migration.
Typical FAST work includes copy, layout, styling, presentation, read-only UI, filters, discovery,
matchmaking UX, tournament/community presentation, analytics UI, empty states, navigation and
recoverable client behavior.

Workflow: implement -> focused tests -> affected lint/typecheck/build when relevant -> diff review
-> PR. FAST does not require a preliminary architecture audit, full monorepo certification, release
manifest proof, Docker matrix, production-readiness package, staging evidence or repeated SHA/tree
certification. A user-visible change receives a focused visual/accessibility check when practical;
that does not turn it into release certification.

### SAFE

SAFE applies to recoverable business state whose failure cannot lose money, cross a security
boundary, create irreversible corruption or escape recovery from canonical data. Examples include
server-owned preference or eligibility decisions that do not charge, book, change identity or call
an external write API.

SAFE requires relevant server-side validation, the affected dependency closure, focused positive
and negative tests, and a reversible implementation. It does not require staging, production or
release certification. Use compatibility/contract checks only when the affected closure includes
that contract.

### CRITICAL

The following boundaries are automatically CRITICAL:

- payment, refund, discount charging or subscription purchase/write-off;
- Viva or another provider `POST`, `PATCH` or `DELETE`;
- booking, capacity, roster or tournament-signup mutation;
- authentication, session, OAuth, authorization, RBAC, ACL, RLS, tenant isolation, PII or identity;
- durable rating/result mutation or destructive data operation;
- public API/event compatibility, database schema/migration, secrets, deploy/release/routing;
- any irreversible external side effect.

CRITICAL keeps the existing strict gates for idempotency, ambiguous-write recovery, provider
identity, authorization, privacy, capacity/roster integrity, migration/backup, immutable artifacts,
rollback and secret protection. It requires relevant negative/compatibility/partial-failure tests,
the full applicable dependency closure, recovery/observability evidence and an independent
specialist review. Live or external actions remain separate approval boundaries.

### Mixed-change examples

- Tournament page rendering is FAST; tournament signup is CRITICAL.
- Profile presentation is FAST; identity mutation is CRITICAL, while a non-sensitive recoverable
  preference may be SAFE.
- Booking discovery is FAST; booking creation/cancellation is CRITICAL.

## Scope, abstraction and maintenance discipline

- If FAST/SAFE work reveals an unrelated CRITICAL issue, stop only when the current change can
  activate or worsen it. Otherwise record `Follow-up finding: ...` and continue.
- Record an unrelated non-critical issue as `Follow-up finding: ...`; do not expand scope.
- Do not turn a product task into architecture cleanup, a generic framework, a repository-wide
  refactor, a CI project or a documentation project.
- A generic abstraction is allowed only when at least two real current consumers exist, or when it
  is required by a concrete security/provider boundary. Prefer reuse, then a local implementation,
  then abstraction; a hypothetical future consumer is not evidence.
- Large LK1/CUP modules use on-touch extraction only: add a characterization test, extract the
  exact flow only when it lowers feature risk, then implement. Do not start a clean-architecture
  rewrite.
- A new feature flag requires an owner/purpose, activation criterion and removal or review
  condition. A flag is a rollout/recovery tool, not the default architecture pattern.

### 90-day architecture freeze

From 2026-08-25 through 2026-11-23, do not delete, rewrite, improve or extend the generic
participation foundation, Event Catalog V2, speculative Communities production scaling or new
generic provider abstractions unless a real consumer/adoption signal appears or a CRITICAL boundary
requires the change. Existing code may remain; the freeze is not authorization to remove it.

## Evidence and stopping

Use the exact evidence labels `LOCAL`, `CI`, `STAGING`, `PROVIDER` and `PRODUCTION`; never present
one as another. Missing STAGING/PRODUCTION evidence does not block completion of FAST or SAFE
implementation.

For FAST/SAFE, stop only when continuing may damage money/security/irreversible data, a material
product decision is missing, the requested outcome is already complete, the requested
implementation contradicts current state, or the requested outcome is technically impossible.
Main drift, an unrelated PR, imperfect neighboring architecture, absent production evidence,
technical debt or a potentially better architecture are not independent stop reasons.

For relevant drift: refresh -> integrate/rebase safely -> run relevant affected checks -> continue.
Repeat a successful check only when relevant source, dependencies, command, environment, inputs or
acceptance target changed, or a new hypothesis requires it. Do not restart a full certification
cycle merely because the SHA/tree moved.

Continue independent in-scope work if one boundary is blocked. A failed post-deploy change returns
to a focused task/hotfix branch; never edit Nano directly.

## Repository autonomy and human boundaries

A scoped development request authorizes one continuous reversible task-branch loop: identify
`origin/main`, create a focused worktree and `codex/*` or `agent/*` branch, implement the requested
outcome, run proportionate checks, create focused commits, push only that task branch, open or update
a Draft PR, read CI, and fix in-scope CI failures. Do not pause merely because one reversible step
completed.

Human approval remains mandatory before merge, direct push to `main` or another protected branch,
force push, deploy, migration/backfill execution, live/shared data mutation, credential or
signing-material changes, permissions/RLS/ACL changes on a real target, DNS/ingress/routing,
payment/refund, external messages or destructive rollback. A Draft PR, green CI, local PostgreSQL
rehearsal or staging artifact never authorizes those actions.

Use at most two read-only subagents inside one complex task and never overlap write ownership. This
does not reduce the repository portfolio limit of four independent task branches. FAST normally needs
self-review only. SAFE uses at most one reviewer when the affected boundary or diff warrants it.
CRITICAL uses one specialist per actual risk; R4 uses two genuinely independent perspectives.

## Required verification and policy scenarios

Use focused checks for FAST and SAFE. Expand to `npm run check` for CRITICAL work and when the
affected dependency closure includes public contracts, schema/migrations, runtime root/shared
configuration, dependencies/lockfiles, deployment files, multiple workspaces or unknown scope. Run
`docker compose config` only for Compose changes. Update the relevant ADR/runbook/domain document
when an invariant or operational procedure changes. Report checks not run and why.

The scenarios below assume that no additional higher-risk boundary is touched. If one is, apply
that boundary's tier and gates.

| Scenario                 | Tier                                                                                                   | Minimum gates                                                                         |
| ------------------------ | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| Button text              | FAST                                                                                                   | focused render/snapshot if present, affected lint/typecheck, diff                     |
| Matchmaking filter       | FAST                                                                                                   | focused positive/empty-state test, affected lint/typecheck                            |
| Tournament-card redesign | FAST                                                                                                   | component/visual/accessibility check, affected build                                  |
| New read-only CUP report | FAST only over an existing authorized, non-PII read contract                                           | query/format test, permission-safe read check, affected build                         |
| Subscription eligibility | SAFE only when it cannot affect price, discount, entitlement, authorization, payment or provider state | server validation, positive/negative tests, affected closure                          |
| Tournament signup        | CRITICAL                                                                                               | capacity/concurrency/idempotency, negative/recovery tests, specialist review          |
| Viva payment POST        | CRITICAL                                                                                               | durable attempt, deduplication, ambiguous recovery, reconciliation, specialist review |
| Auth/session change      | CRITICAL                                                                                               | default-deny, expiry/revocation/negative tests, security review                       |
| Database migration       | CRITICAL                                                                                               | expand/contract, disposable apply/reapply, compatibility/rollback review              |
| Production deploy        | CRITICAL                                                                                               | R4 immutable digest, backup, readiness/smoke, rollback, exact live approval           |
