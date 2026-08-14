# C-12: Membership lifecycle and ЦУП decisions

- Status: accepted
- Date: 2026-08-03
- Accountable: Backend Lead + Product Owner

## Context

The new LK needs join, moderated request, rejoin, cancel and leave without copying legacy commands
that trusted browser-supplied actors, roles or member objects. The existing moderation control plane
is ЦУП, while Communities remains the only write owner.

## Decision

Use a strong PostgreSQL membership aggregate plus separate durable join request history.
User commands derive tenant, actor and subject from the PadlHub session and accept only expected
revisions. The server chooses immediate activation versus JOIN/REJOIN request. `REMOVED` requires
explicit permission; `BANNED` is fail-closed. Owners cannot leave through the member command.

ЦУП reads a bounded tenant-wide pending queue with optional community UUID filter and applies
approve/reject through PadlHub Admin API. The request ID resolves the canonical community and subject;
the body cannot select them or a target role/status. Approval produces `ACTIVE/MEMBER`; rejection
restores the request origin. Read and decide permissions are separate.

Every applied command stores an actor-scoped idempotency result and commits membership/request,
audit and outbox atomically. Tenant composite keys and forced RLS apply to the new tables. HIDDEN
without an existing membership remains indistinguishable from missing.

## Consequences

- User and ЦУП clients cannot forge actor, subject, role, request kind or resulting state.
- Replay and concurrent decisions are deterministic through idempotency keys and expected revisions.
- Projections and notifications consume versioned events and never become membership authority.
- DIRECT invites are a separate aggregate/slice. No expiry, audience, reusability or redemption UX
  default is inferred by this ADR.

## Verification

- migration/RLS/index checks for join requests and lifecycle commands;
- domain transition and repository transaction tests, including revision zero and replay;
- User/Admin route contract tests with forged-field absence;
- ЦУП client/workspace tests and browser QA;
- repository-wide `npm run check` before handoff.
