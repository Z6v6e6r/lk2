# ADR 0018: Bounded public tournament summary discovery

- Status: accepted
- Date: 2026-07-26
- Extends: [ADR 0002](0002-viva-boundary.md), [ADR 0010](0010-games-domain-and-card-state-model.md)

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

Viva-primary schedule entries whose normalized exercise type is `Игра+Тренер` are read separately
through `@phub/viva-adapter` and exposed by
`GET /public/api/v1/{tenantKey}/coach-games`. They are summary cards, not synthetic Games
aggregates: the operation does not invent revisions, commands or local ownership for a Viva
exercise. Provider exercise/studio/court/trainer identifiers and trainer photo URLs remain
server-side. The browser renders a deterministic local trainer avatar fallback and offers no
unimplemented signup command.

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

Coach-game schedule reads use the same fifteen-day and fifty-card public bounds, per-date
single-flight, fresh/stale cache, response-size limit, timeout, circuit breaker, range concurrency
of two and public HTTP cache policy as tournament discovery.

Trainer media uses a server-owned read-through cache shared by tournament, training and coach-game
routes. The adapter keeps the Viva trainer identity and source URL inside the integration boundary.
On media delivery the API resolves `(tenant, provider, provider trainer id)` in
`integration.trainer_avatar_sync`, reads the normalized WebP object from private storage first and
contacts the provider only when no local object exists. A successful provider read is normalized,
stored under `trainer-avatars/{tenantId}/{trainerId}/{sha256}.webp`, and linked to the
Viva-primary `catalog.trainers` projection. Provider-specific `4xx` responses are recorded for that
trainer but do not open the shared media circuit breaker. The public DTO and media URL never expose
the provider trainer id or provider URL.

## Consequences

- A thousand viewers of the same schedule share cached per-date reads instead of producing a
  thousand roster requests.
- Tournament cards can display `registered/total`, open places and waitlist count without receiving
  participants.
- Existing locally owned `COACH_GAME` records remain Games aggregates and keep using the existing
  Games command and detail contracts; Viva schedule summaries do not acquire those semantics.
- Viva-primary `Игра+Тренер` schedule summaries remain a separate source/version and are never
  presented as locally writable Games aggregates.
- Upstream failure can hide tournament summaries while Games remain usable; no client falls back to
  direct legacy or Viva traffic.
- A previously cached trainer avatar remains available when the provider URL expires or returns
  `403`; a trainer never cached successfully continues to use the deterministic UI fallback.
