# Bookings and recommendations

## Scope

This contour owns the authenticated user's booking timeline presentation and explainable discovery
preferences. It does not own Games, Viva bookings, subscriptions, payments or operational station
inventory.

## Ownership

| Aggregate or projection            | Owner                     | Mode                                 |
| ---------------------------------- | ------------------------- | ------------------------------------ |
| Viva booking state                 | Bookings provider port    | `VIVA_PRIMARY`                       |
| PadlHub Games state and cards      | Games                     | `LOCAL_PRIMARY` / `LOCAL_ONLY` reads |
| Booking recommendation preferences | Profile                   | `LOCAL_ONLY`                         |
| First-slice recommendation result  | User API query projection | derived local read                   |

External identifiers remain in `integration.external_entity_map`. Public preference and
recommendation DTOs contain PadlHub UUIDs only.

## Preference aggregate

`profile.booking_preferences` is keyed by `(tenant_id, user_id)` and stores favorite operational
station UUIDs, weekday/time windows, the history switch, an optimistic version and the actor. The
matching command table provides idempotent replay. Each successful change commits settings, audit
and `profile.booking_preferences.changed.v1` in one transaction.

Missing rows resolve to version zero with no explicit stations/windows and history enabled. The
owner can disable behavioral history without deleting the visible booking history.

## Recommendation policy v1

Eligibility is evaluated before ranking:

1. public and scheduled Games card;
2. future start and open join window;
3. server-computed `JOIN` or `JOIN_WAITLIST` action;
4. viewer is not already an organizer, participant, reservation holder or waitlisted user;
5. known player level is inside the required game range.

Eligible cards are ranked with a versioned deterministic policy:

- level fit: 45%;
- favorite or historically played station: 30%;
- explicit or historically usual time: 25%.

Explicit values take precedence over history. History uses completed Games from the last 180 days
with a 45-day half-life and becomes a learned-personalization claim only after three eligible
records. The API returns `LEVEL_MATCH`, `FAVORITE_STATION`, `PLAYED_STATION`, `PREFERRED_TIME`,
`USUAL_TIME` or `AVAILABLE_SOON`; it never returns the score.

## Read behavior and failures

- Upcoming bookings continue to use the existing versioned `/bookings/upcoming` projection.
- Games history uses `/games?scope=HISTORY` with an opaque keyset cursor.
- Unified visible history uses `/bookings/history` and reads one local activity-history projection.
  Its persisted coverage marker distinguishes a successfully synchronized empty history from an
  uncovered provider range. The server, never the client, performs a bounded provider refresh for
  an uncovered range and persists it before returning the projection.
- A provider game is replaced by its canonical Games card only when the authenticated viewer can
  read that game and the server can correlate both sources. The primary correlation is the
  one-way Viva exercise association in integration storage; start time plus normalized station is
  a compatibility fallback. Provider-only records never receive result actions because their
  participant roster and command authorization cannot be proven locally.
- When a synchronized Viva page contains a game that is absent locally, the server performs a
  bounded historical backfill before persisting the page: Viva proves the viewer's exercise UUIDs,
  the server paginates that viewer's CUP history and filters it to the full Viva page, and Games
  imports each aggregate idempotently. The authenticated Viva profile is bound to the matching CUP
  participant, raw provider identifiers remain in integration storage, and the new card projection
  is built before history is reread.
- Recommendations use `/recommendations/bookings` and return `private, no-store`.
- Unconfigured or failed recommendation dependencies return
  `BOOKING_RECOMMENDATIONS_UNAVAILABLE`; Home keeps the upcoming tab usable.
- Opening a recommendation performs a fresh viewer-aware Games detail read. Join commands still
  revalidate capacity, cutoff, level and authorization and require an idempotency key.

## Deferred gates

- production rollout of provider-wide booking/training history until real Viva pagination and
  authenticated staging evidence pass the ADR 0017 gate;
- canonical catalog station linked to editorial location profiles;
- materialized recommendation feed and cursor pagination;
- training and tournament candidate adapters;
- remote staging browser proof and real post-join recommendation refresh.
