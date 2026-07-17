# ADR 0010: Own games locally and expose a server-derived card state model

- Status: Proposed
- Date: 2026-07-17

## Context

The current LK proves the business flow for discovery, create, split payment, join, waitlist, chat
and result handling, but implements important decisions in large browser components and Node-RED
functions. Participant arrays are replaced from browser snapshots, identity selectors are supplied
by callers, public reads expose overly broad records and payment return handling can promote local
state before authoritative provider verification.

The new PadlHub platform already defines Games as `LOCAL_ONLY`, PostgreSQL as the operational source
of truth, PadlHub APIs as the only client boundary and Viva traffic as an adapter-only concern.

The design also needs one reusable card family covering discovery, upcoming games, invitations and
history. A single game status cannot accurately represent roster, viewer relation, payment and
result review at the same time.

## Decision

1. Games remain a module in the PadlHub modular monolith and own their PostgreSQL aggregate.
2. Bookings, Commerce, Rating, Messaging and Notifications remain separate domains connected by
   commands/events and PadlHub UUIDs.
3. Game state is decomposed into lifecycle, derived roster state, viewer relation, payment
   obligation and result state. No generic mutable status field represents all concerns.
4. A card projector produces a versioned viewer-aware `GameCardView` with one `displayState`,
   secondary badges and server-computed `allowedActions`.
5. Public discovery uses a separate allowlisted DTO and API operation. Private fields and external
   identifiers cannot be selected into that DTO.
6. State-changing APIs are domain commands. Whole-game `PATCH` and caller-supplied participant
   arrays are forbidden.
7. Critical commands require verified PadlHub identity, tenant context, idempotency, audit and
   optimistic/locking protection.
8. Booking and payment are process-manager sagas. Only verified provider events can confirm them;
   browsers can request/retry but cannot declare success.
9. A confirmed result and its rating outbox fact are committed atomically. External projections are
   eventually consistent and repairable.
10. Figma variants, API fixtures and UI stories share the exact stable `displayState` keys.

## Alternatives rejected

### Copy the current LK document and UI logic

Rejected because it preserves insecure identity, lost-update and drift failure modes and creates a
second unmaintainable implementation.

### Keep one status enum with every UI state

Rejected because `FULL`, `PAYMENT_REQUIRED`, `RESULT_PENDING` and `CANCELLED` describe different
axes and require ambiguous precedence.

### Let each client derive the card state

Rejected because web/mobile/Tilda would drift and expose business rules through presentation code.

### Synchronously call every provider before committing a game

Rejected because external latency and partial failures would sit inside the user request and make
recovery non-durable.

### Dual-write legacy Mongo/Node-RED and PostgreSQL

Rejected because neither side can be made the authoritative result after a partial failure. The
migration switches one operation/tenant owner at a time and uses events/projections for
compatibility.

## Consequences

Positive:

- deterministic card behavior on every client;
- atomic capacity enforcement and safer payment/result flows;
- explicit public/private data boundary;
- incremental replacement of legacy flows;
- observable, replayable external integration.

Costs:

- new schema, projector and process manager;
- asynchronous provisioning UX and operation status handling;
- Figma component/state normalization before implementation;
- explicit migration and reconciliation work.

## Validation

Acceptance requires the tests and rollout gates in
`docs/plans/games-module-rebuild-plan.md` and the invariants in `docs/domains/games.md`.
