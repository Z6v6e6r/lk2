# ADR 0018: Bounded public tournament summary discovery

- Status: accepted
- Date: 2026-07-26
- Extends: [ADR 0002](0002-viva-boundary.md), [ADR 0010](0010-games-domain-and-card-state-model.md)
- Amended by: [ADR 0023](0023-browser-only-viva-end-user-transport.md)

## Context

The Games discovery page needs to show public Games, `COACH_GAME` events and tournaments in one
chronological surface. The legacy tournament schedule payload contains full participant arrays and
may contain phones. Loading a roster for every tournament card previously created request fan-out
and backend memory pressure; a large tournament must not make list cost proportional to its roster.

## Decision

The browser continues to read Games from the canonical Games card projection and reads tournaments
from `GET /public/api/v1/{tenantKey}/tournaments`. The tournament operation accepts a required,
exclusive date range of at most fifteen days and returns at most fifty summaries. Each summary
contains presentation fields, station name without court, an aggregate access-level range,
organizer display name and aggregate capacity counts only. It never contains a participant array,
participant identity, phone, provider identifier, payment data or tournament mechanics. Discovery
renders the organizer with a deterministic local avatar fallback; external trainer photo URLs and
trainer identifiers are not exposed to the browser.

Viva-primary `Игра+Тренер` entries are now read through the authenticated client-assisted Event
Catalog. The former public coach-game route returns a deprecated empty compatibility page and links
to the browser read-job contract; its avatar route returns `204`. No server coach adapter or
provider-media fallback remains.

The server-side legacy adapter performs at most one upstream schedule read per date at a time. It
uses a 60-second fresh cache, a 10-minute stale fallback, bounded response bytes, an eight-second
timeout and a circuit breaker. Date-range reads use concurrency two. The public response is cached
for 30 seconds with stale-while-revalidate.

A selected tournament is read through
`GET /public/api/v1/{tenantKey}/tournaments/{summaryId}` with the same bounded date range. The
server evaluates dates in batches of two and stops as soon as the PadlHub summary UUID is found,
instead of materializing the complete discovery range before selecting one aggregate. The response
is the same anonymous `PublicTournamentSummary`; provider identifiers remain integration-only.

Tournament detail and signup remain separate capabilities. A list card must never hydrate its
roster. If a later detail screen needs a public roster, it must request one selected tournament,
be abortable and no-retry on the client, and use its own backend concurrency, privacy and rate
limits.

Coach-game schedule bounds, normalization and media delivery are owned by the client-assisted Event
Catalog contract. Tournament discovery and its organizer-media cache remain server-owned and are
unaffected by this amendment.

## Consequences

- Tournament viewers share cached bounded legacy reads; Viva coach-game reads use each
  authenticated user's browser context.
- Tournament cards can display `registered/total`, open places and waitlist count without receiving
  participants.
- Existing locally owned `COACH_GAME` records remain Games aggregates and keep using the existing
  Games command and detail contracts; Viva schedule summaries do not acquire those semantics.
- Viva-primary `Игра+Тренер` summaries remain a separate source/version and are never presented as
  locally writable Games aggregates.
- Upstream failure can hide tournament summaries while Games remain usable; Viva failures remain
  isolated to the browser-assisted catalog and never trigger server fallback.
