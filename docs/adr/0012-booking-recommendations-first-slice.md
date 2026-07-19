# ADR 0012: Explainable booking recommendations first slice

- Status: accepted
- Date: 2026-07-18
- Extends: [ADR 0002](0002-viva-boundary.md)

## Context

Home previously rendered a truthful upcoming-bookings projection together with a static
`Мои записи / Абонементы` tab shell. The product now replaces the subscriptions tab with `Для
меня`, adds owner-managed station/time preferences and needs access to booking history.

The current complete discovery vertical is PadlHub Games. Training, tournament and provider-wide
history contracts are not complete enough to advertise as bookable recommendations. Public
location profiles are editorial objects and are not interchangeable with operational Games
station UUIDs.

## Decision

The first recommendation slice includes only public, scheduled and currently joinable PadlHub
Games. It is exposed by `GET /user/api/v1/{tenantKey}/recommendations/bookings` and is hidden behind
the same authenticated `games.play` boundary as viewer Games reads.

Explicit recommendation preferences form a separate `LOCAL_ONLY` aggregate:

- up to three PadlHub station UUIDs;
- up to fourteen weekday/time windows;
- a user-controlled switch for using eligible completed Games history;
- optimistic versioning, `Idempotency-Key`, audit and transactional outbox publication.

Subscriptions, provider identifiers and client-selected sources are absent from this aggregate.
The browser receives reason codes, never an internal numeric score.

The API reads candidate and history card projections through one tenant transaction and one SQL
statement. The result version hashes the exact preference version, player level and card projection
revisions. The first slice is bounded to twenty items and returns `nextCursor: null`; a future
materialized-feed phase may add keyset pagination without changing the recommendation item shape.

Level eligibility is a hard filter only when both a canonical PadlHub player level and a game level
range exist. Remaining candidates are ranked deterministically by level (45%), station (30%) and
time (25%). Explicit preferences override learned history. Only completed Games from the last 180
days influence learned station/time affinity; cancelled games, waitlists and active reservations do
not.

The full `/bookings` page may show current upcoming bookings and the Games history projection. It
must disclose that provider training history is not yet included. A unified provider-wide history
must not launch until its adapter contract, ID mapping, pagination and staging evidence are proven.

## Consequences

- Home can replace the subscriptions tab without connecting recommendation access to subscriptions.
- Recommendation results remain explainable, tenant-isolated and reproducible from local revisions.
- Public Games detail must allow an authenticated non-participant to open a public scheduled game;
  private games remain invisible.
- The profile level projection must persist the canonical `D` through `A` label used by Games.
- Favorite station management is currently limited to operational station UUIDs observed in Games;
  the future catalog-station/location link remains a separate expand/migrate task.
