# ADR 0018: Immutable game results, quorum confirmation and CUP rating ledger

- Status: Accepted for staging implementation
- Date: 2026-07-22

## Context

The legacy LK result flow mixes an editable browser session, Mongo document updates, review state
and rating changes. A retry can therefore leave a score accepted in one place and absent from a
card, player history or rating history. It also models pairings separately from the set even though
partners and opponents only need to be stable inside one set.

## Decision

1. `Game` remains the aggregate. A result submission is one immutable command snapshot containing
   one to nine ordered sets. Every set contains two PadlHub user UUIDs in pair A, two in pair B and
   both scores. The same four active game participants must occur in every set; partners may change
   between sets.
2. There is no server-side result-entry session or autosave. The client owns its local draft and
   sends the complete snapshot once with an `Idempotency-Key`.
3. The submission author cannot review their own proposal. Any one of the other active participants
   may confirm it; confirmation quorum is stored explicitly and starts at one. Any eligible reviewer
   may dispute it with a stable reason code. A disputed submission is immutable and becomes
   `SUPERSEDED` only when a participant sends a corrected snapshot.
4. Submit, confirm and dispute commands lock the game, enforce tenant and participant policy, and
   commit aggregate state, command idempotency, audit and outbox facts in one PostgreSQL transaction.
   Confirmation additionally creates the canonical `games.results` row and normalized set/player
   rows in that transaction.
5. `game.result.confirmed.v1` is the only downstream trigger. The card projector reads the accepted
   submission, while the result projector writes one analytical player-set fact and one activity
   history item for every participant. Both consumers are replay-safe through inbox or natural keys.
6. Rating remains owned by CUP. A worker consumer sends the normalized confirmed result to the CUP
   service boundary with idempotency key `game-result:{resultId}:v{resultRevision}`. CUP must apply
   all four rating state changes and append four immutable rating ledger events atomically. Games
   never writes CUP level state and never waits for CUP during the user confirmation request.
7. `GAMES_RESULTS_WRITE_MODE` has three explicit states. `disabled` keeps the new API read-only;
   `shadow_compare` is reserved for read-only comparison and still rejects new writes;
   `local_primary` enables only the canonical PadlHub result repository. No mode performs dual-write
   to legacy LK.

## Consequences

- A card or history projection can lag briefly after confirmation, but the command itself is durable
  and retries return the original result.
- CUP unavailability retries through its quorum queue and dead-letter policy without losing the
  confirmed game result or producing duplicate rating changes.
- Legacy confirmed cards without a submission UUID remain readable during migration. New result
  commands always use the stricter roster and quorum contract.
- Production activation remains blocked in configuration until the runbook gates and authenticated
  staging proof pass.
