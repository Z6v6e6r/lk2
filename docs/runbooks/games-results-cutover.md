# Games result cutover runbook

Owner: Games / CUP rating
Scope: local and staging until separate production approval

## Runtime modes

| Mode             | New result writes                                 | Legacy result writes | Purpose                                         |
| ---------------- | ------------------------------------------------- | -------------------- | ----------------------------------------------- |
| `disabled`       | rejected with `GAMES_RESULTS_RUNTIME_UNAVAILABLE` | unchanged            | safe deploy default                             |
| `shadow_compare` | rejected                                          | unchanged            | compare imported cards and result coverage only |
| `local_primary`  | PadlHub API only                                  | must be disabled     | staged cutover                                  |

`local_primary` requires `GAMES_COMMANDS_ENABLED=true`. Configuration rejects every non-disabled
mode in production. The CUP consumer is independent and requires its URL and worker-only service
token when enabled.

## CUP apply contract

The worker calls:

`POST /internal/api/v1/game-results/{resultId}/apply-rating`

Required headers are a service bearer token, `X-Correlation-ID` and
`Idempotency-Key: game-result:{resultId}:v{resultRevision}`. The body contains PadlHub tenant, game,
result and participant UUIDs, the game kind and end time, and normalized sets with per-set pairings.

CUP must:

1. authenticate the PadlHub worker and validate the tenant scope;
2. reject a reused idempotency key with different content;
3. load current levels from canonical CUP state;
4. calculate all four changes from the same pre-game snapshot;
5. update all four player states and insert one immutable event per player in one transaction;
6. store `source=GAME_RESULT_CONFIRMED`, `gameId`, `resultId`, old level and new level;
7. return `200`/`202` for the first application and `409` with
   `code=CUP_RATING_ALREADY_APPLIED` for an identical replay. A different payload under the same key
   returns another stable conflict code and is never acknowledged as success.

Partial player updates, browser tokens, phone selectors and Viva identifiers are forbidden.

## Staging sequence

1. Back up PostgreSQL and apply migration `0040_game_results_v2.sql` through the migrator process.
2. Deploy API and worker with `GAMES_RESULTS_WRITE_MODE=disabled` and
   `CUP_RATING_CONSUMER_ENABLED=false`; verify readiness and existing Games reads.
3. Reconcile each candidate game's four active participants to PadlHub user UUIDs. Quarantine every
   game with fewer/more than four participants or an unresolved identity.
4. Deploy and verify the CUP apply endpoint against synthetic results. Confirm identical replay is a
   no-op and an altered payload with the same key is rejected.
5. Enable `GAMES_RESULTS_WRITE_MODE=local_primary` for the staging tenant. Enable the CUP consumer
   only after its endpoint check passes.
6. Switch the legacy LK result button to the PadlHub API flow. Remove or hard-disable legacy
   `/result/submit`, `/result/confirm` and direct rating writes; do not proxy both writers.
7. Complete one authenticated four-player game:
   - participant A selects pairs and scores for every set and submits once;
   - participant A cannot confirm;
   - participant B confirms;
   - the card reaches `CONFIRMED` with the same set snapshot;
   - all four history records contain the game and sets;
   - player-set facts contain four rows per set;
   - CUP contains exactly four rating ledger events linked to the same result UUID.
8. Replay submit and confirmation requests with the same keys and verify no duplicate result,
   history fact or rating event appears. Exercise dispute, corrected resubmission and worker retry.

## Rollback

Before client cutover, return to `disabled` and keep legacy as the sole writer. After any canonical
result has been accepted, do not switch legacy writes back on: freeze new result entry, drain and
repair the canonical outbox/consumer path, then resume. Never copy a CUP rating state back into
Games or overwrite a confirmed result directly.
