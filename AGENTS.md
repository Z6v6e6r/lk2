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

For ordinary drift that does not require branch synchronization: refresh -> run relevant affected
checks -> continue. If integration with a newer `main` is required, the task must first acquire
merge ownership under the rules below. The merge-owner uses merge-from-main by default; rebase is
allowed only when the task explicitly permits it.
Repeat a successful check only when relevant source, dependencies, command, environment, inputs or
acceptance target changed, or a new hypothesis requires it. Do not restart a full certification
cycle merely because the SHA/tree moved.

Continue independent in-scope work if one boundary is blocked. A failed post-deploy change returns
to a focused task/hotfix branch; never edit Nano directly.

## Concurrent development and exclusive merge ownership

This section is the repository-wide authority for parallel task coordination. The `merge-owner` is
an organizationally exclusive role, not a GitHub lock or other technical enforcement. Multiple
implementation tasks may run in parallel, but only one active task may own this repository's merge
contour at a time. The practical checklist is in
[the merge ownership runbook](docs/runbooks/merge-ownership.md).

### Parallel implementation is allowed

Parallel tasks may perform read-only research, work in separate clean worktrees, commit and push
their own feature branches, create or update their own Draft PRs, and run local or automatic PR
checks. Each implementation task must:

- start with a fresh fetch and record its starting `origin/main` SHA;
- use only its own branch and separate clean worktree;
- leave other tasks' branches unchanged and never use a dirty user checkout;
- revalidate an old baseline before treating it as current.

These actions do not grant merge ownership and do not authorize a Ready transition or merge.

### Only one task may be merge-owner

Only the active merge-owner may:

- merge fresh `main` into a PR branch or perform a task-authorized restack;
- change a PR base branch;
- move a PR from Draft to Ready or back;
- close or reopen a PR;
- perform a separately authorized controlled merge into `main`;
- coordinate the sequential merge of stacked PRs;
- confirm post-merge CI and the final `main` identity.

Merge ownership alone never authorizes workflow dispatch or rerun, deploy, publication,
reconciliation, migration apply, activation, provider or production mutation, force-push, rebase,
or branch deletion. Each such operation needs its own explicit authorization. Rebase remains
prohibited unless the task specifically permits it; ordinary merge-from-main is the default.

While a merge-owner is active, every other implementation task must not synchronize its branch
with a newer `main`, merge-from-main, rebase, change its own or another PR's base or lifecycle,
close a PR, move a PR to Ready, merge, update stacked bases, or trigger manual CI actions. It may
continue independent implementation and automatic PR checks as long as it does not enter the merge
contour or change `main`.

### Acquiring merge ownership

Before its first merge-related mutation, the prospective merge-owner must:

1. perform a fresh fetch;
2. inventory every open PR;
3. record the fresh `main` SHA and tree;
4. record the target PR head SHA;
5. verify mergeability, unresolved review threads, and CI;
6. confirm that no other active task owns the merge contour;
7. declare in its task report the repository, merge-owner task, frozen `main`, frozen PR head,
   allowed operations, and prohibited live operations.

Ownership is limited to that declared task. It does not transfer automatically to another task.

### Frozen merge window and drift

Immediately before a controlled merge, the merge-owner must freeze the pre-merge `main` SHA and
tree, PR head SHA and tree, merge-base, exact-head CI identity, PR state, and mergeability. Any
unknown change to `main`, PR head, PR base, required checks, review state, or an applicable workflow
definition stops the current merge procedure. Stale evidence must never authorize a merge.

Unknown drift stops only the current controlled merge, the affected PR, and any dependent stacked
merge sequence. It does not automatically stop read-only research, independent work in other
branches, local tests, or work in other repositories. A global writer freeze is allowed only for a
task that explicitly requires full queue cleanup or mass PR restructuring.

If an unknown PR appears after a frozen inventory during cleanup or mass merge work, do not close
or merge it automatically. Record its number, head SHA, and discovery time, and stop the bulk
operation as `EXTERNAL DRIFT`. Independent implementation may continue unless the task explicitly
established a global writer freeze.

### Stacked PRs

A dependent PR stack has one merge-owner for the entire stack. Merge from the bottom up. After each
merge, synchronize the next PR with the new `main`; its old CI is no longer valid after the base or
effective merge input changes. Every resulting exact head must receive its own CI. Parallel merges
of different levels in one stack are prohibited.

### Releasing merge ownership

In the normal successful path, the merge-owner releases the merge contour only after successful
post-merge CI, a final fresh fetch, confirmation of the final `main` SHA and tree, a new open-PR
inventory, a record of every performed mutation, and confirmation that no unknown drift remains.
It must explicitly announce the release; only then may another task acquire merge ownership.

If the task aborts before a merge, it may release ownership as `ABORTED` only after confirming that
no merge-related mutation is in flight, fresh-fetching current identity, inventorying open PRs, and
recording the drift and any mutations already performed. If a completed merge has failed or blocked
post-merge CI and the owner cannot continue, it must fresh-fetch, inventory current open PRs, and
record `BLOCKED_POST_MERGE`, the current `main` SHA/tree, target PR identity, failed checks, known
drift, all mutations, and the absence of in-flight actions before an explicit release or handoff.
It must not claim a successful release. Any successor acquires ownership from scratch and
revalidates every field; ownership is never transferred implicitly.

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

Use at most two concurrent spawned agents and never overlap write ownership. FAST normally needs
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
