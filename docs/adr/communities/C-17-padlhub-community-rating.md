# C-17 — PadlHub-owned community rating

Status: proposed, 2026-09-29. Formula agreed with the product owner; the game-to-community
attribution below is the open decision that blocks the ledger implementation.

## Context

The viewer's place in a community rating was read from an external legacy rating snapshot. A
membership page enrichment requested up to eight of those snapshots per list read, each one a
ranking table for a whole community, and returned the page after 150 ms while the requests stayed in
flight. That multiplied every directory view by several heavy third-party calls and made the place
impossible to explain or recompute inside LK2. The enrichment was removed in PR #338; the place is
now expected from PadlHub's own data.

## Decision

- The rating is a function of PadlHub's confirmed result facts only. Version
  `phub-community-rating-v1`, implemented in `packages/communities/src/community-rating.ts`.
- Per rated set: `points = outcome × (1 + 0.5 × |scoreFor − scoreAgainst| / max(scoreFor, scoreAgainst)) × kindWeight`,
  with `kindWeight` `RATING = 1`, `FRIENDLY = 0.5`, `PRIVATE = 0`, `COACH_GAME = 0`. Stored points
  are time-independent.
- Recency is applied when a score is materialized: weight `0.5 ^ (ageDays / 60)`. A place is
  published only for members with at least three rated sets inside the last 90 days.
- Places are ordered by score, then set count, then member UUID, so replay and process order cannot
  change a place. `memberRank` stays optional; absence means "no published place".
- The ledger stores immutable facts keyed by `(source, sourceEventId, setNumber, userId)` and applies
  a fact at most once per `(sourceEventId, sourceRevision)`. Materializing
  `communities.memberships.ranking_position` happens in the same tenant transaction as the fact and
  the score update.
- Sources: `GAME_RESULT_CONFIRMED` (PadlHub's own confirmed result events) from the start, and
  `LEGACY_BACKFILL` so legacy history can be poured in later without changing the formula or the
  fact schema. There is no cold-start dependency on any legacy read.

## Open decision — game-to-community attribution

Nothing in the current schema binds a game to a community: `games.games` has no `community_id`
(only a `visibility` enum with a `COMMUNITY` value) and no games↔communities link table exists.
A community place therefore cannot be computed from results until attribution is decided:

- **(a)** add a nullable `games.games.community_id` and set it when a game is created in a community
  context. Cleanest grain, but it changes the create-game contract and its persistence.
- **(b)** attribute a game to every community in which all or a quorum of its participants are ACTIVE
  members. No schema or contract change, but a noisy rule that can score one game for several
  communities.
- **(c)** compute the rating only from community-owned competitions once LK2 owns tournaments. LK2
  currently has no tournament results; the legacy surface exposes a podium top-3 only.

Recommendation: (a). It keeps the ledger's input well defined, cannot double count, and the review
surface is one nullable column plus one create-context field.

## Consequences

- The read contract does not change: `memberRank` is already optional on the membership summary and
  the community detail view.
- The ledger is a durable rating mutation: it needs a migration, idempotent application, replay-safe
  materialization, negative tests and an independent review before activation.
- Legacy per-community rating reads stay in `legacy-community-experience-repository` until the
  PadlHub place is live in every read mode; they are removed then, not before.
