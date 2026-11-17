# ADR 0028: LK2 confirms results, LK1 keeps its own result record

- Status: proposed (flag `LK1_RESULT_BRIDGE_ENABLED`, disabled by default)
- Date: 2026-11-09
- Owners: platform

## Context

LK2 stores game results per set: `games.result_submissions` → `games.result_sets`, with its own
confirmation quorum and a `game.result.confirmed.v1` domain event. LK1 (Node-RED on the production
host, Mongo `games`) stores **one** score per game, identifies the submitter **by phone**, runs a
24-hour dispute window and recalculates the player rating when a result confirms
(`lk_game_results_nodes_import.json`: `POST /lk/games/:gameId/result/submit`,
`GET .../result/state`, `POST .../result/dispute`).

Games created in LK2 have no LK1 record at all. Games imported from LK1 keep a mapping in
`integration.external_entity_map` (`external_system = 'LK_LEGACY_SNAPSHOT'`, `entity_type = 'game'`).
The owner entered a score in LK2 and expects it in LK1 as well; until then the two cabinets disagree
about the same match, and LK1's rating never moves.

The reverse direction does not exist today. The only cross-system bridge is LK1 → LK2 for roster
commands (`/internal/api/v1/:tenantKey/legacy-games/:legacyGameId/roster-commands`, bearer
`LEGACY_GAME_COMMAND_BRIDGE_TOKEN`).

## Decision

LK2 publishes a confirmed result to LK1 and **LK1 stays the writer of its own store**:

1. LK2 keeps the result as the source for its own screens; `game.result.confirmed.v1` remains the
   single trigger (no second write path, no dual write).
2. A dedicated worker consumer (`phub.lk1-result-bridge.v1`) reads the handoff
   (`lk1-result-bridge-repository.ts`): LK1 game id from the mapping, the confirming participant's
   phone from `profile.user_summaries`, and the confirmed sets from
   `GameResultProjectionRepository.loadConfirmedResult`.
3. The consumer posts to a **new LK1 endpoint** `POST /lk-bridge/api/v1/game-results/import`
   (`Lk1ResultClient`), authenticated with `LK1_RESULT_BRIDGE_TOKEN`, with
   `Idempotency-Key: game-result:<resultId>:v<revision>`.
4. LK1 validates the token, resolves the game by its own id, checks that the phone belongs to a
   participant, upserts **one CONFIRMED result document** keyed by `externalResultId`, and runs its
   existing rating recalculation on the first insert only. Replays answer `409
LK1_RESULT_ALREADY_IMPORTED` with the stored document.

### Score mapping

LK1 has no sets. One LK2 set maps directly to `scoreA:scoreB`. Several sets map to **sets won**
(e.g. 6:4, 7:6 → 2:0), which is the match score LK1 displays and rates. Level sets fall back to the
summed points so the information is not lost (6:4, 3:6 → 9:10). Held in
`apps/worker/src/lk1-result-score.ts` with its own tests.

### Failure and recovery

| Case                                        | Behaviour                                                                    |
| ------------------------------------------- | ---------------------------------------------------------------------------- |
| Game exists only in LK2 (`lk1GameId` null)  | acknowledge, log `stays local` — nothing to update in LK1                    |
| Confirming participant has no phone         | acknowledge, log `submitter_phone_missing` for reconciliation, no retry      |
| No usable sets                              | acknowledge, log `score_missing`                                             |
| LK1 answers a documented 4xx rejection code | acknowledge, log `rejected` (data problem, retrying cannot fix it)           |
| Timeout / 5xx / transport error             | `nack(requeue)` — the same idempotency key replays safely (delivery limit 8) |
| Lost response after LK1 committed           | replay returns `409 LK1_RESULT_ALREADY_IMPORTED` → treated as delivered      |

Phones never enter logs, events or the LK2 database beyond the profile row that already stores them.

## Rollout

1. Deploy the LK1 flow (new endpoint + token) first; the endpoint is inert without the flag.
2. Deploy LK2 with the bridge disabled — no behaviour change.
3. Enable `LK1_RESULT_BRIDGE_ENABLED`, `LK1_RESULT_BRIDGE_URL`, `LK1_RESULT_BRIDGE_TOKEN` (or
   `..._TOKEN_FILE`) on the target environment; a missing URL/token fails config validation.
4. Compare a single imported game end-to-end (score + rating) before widening.

Rollback is `LK1_RESULT_BRIDGE_ENABLED=false`: LK2 stops publishing, the queue drains, and results
already written in LK1 stay valid. No migration and no data conversion are involved.

## Consequences

- One write owner per system: LK2 owns its result, LK1 owns its Mongo record; neither writes the
  other's store directly.
- LK1's own `submit` endpoint still exists for LK1-native flows. For an imported game both paths can
  create a result document; the LK1 import endpoint must therefore treat an existing CONFIRMED
  document for the same game as "already imported" instead of adding a second one.
- LK2-created games never appear in LK1. Closing that gap is a separate decision (which product owns
  new games), not part of this bridge.

## Not covered

Reopening or disputing a result already imported into LK1, backfilling historical results into LK1,
and rating writes into LK2. Each needs its own decision.
