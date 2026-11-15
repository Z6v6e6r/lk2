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

## Beta (Timeweb staging) state

The beta contour runs `GAMES_RESULTS_WRITE_MODE=local_primary` while
`CUP_RATING_CONSUMER_ENABLED=false`, because the CUP apply boundary does not exist yet. In that state
PadlHub owns result entry: submit, confirm and dispute commit the canonical result, the set/player
facts, the audit row and the outbox event in one transaction, and confirmation never waits for CUP.
The `game.result.confirmed.v1` rating application stays queued in the outbox, so beta verifies result
entry, the card projector and the activity history, but **not** the CUP rating ledger. Enabling the
consumer needs `CUP_RATING_API_URL` and `CUP_RATING_SERVICE_TOKEN` plus the CUP endpoint check from
step 4 below, and it is the only switch that may write provider level state.

Because no mode dual-writes to legacy LK, the legacy result button must not be used for the same
games while beta owns them: a CUP-direct result would leave the local canonical result absent and the
rating ledger inconsistent with it. Return to `disabled` before any legacy writer resumes.

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

## Score window and notification acceptance (2026-11-15)

The single deadline is game end plus 12 hours, including a corrected score. A late submission does
not extend review. The existing `GAME_RESULT_AUTO_CONFIRM_WINDOW_HOURS` setting accepts only `12`;
keep `GAME_RESULT_AUTO_CONFIRM_ENABLED=true` in an explicitly activated contour. The schema and
public event payloads are unchanged. API and worker must run the same release before acceptance.

After separately approved deployment, the notification administrator must dry-run and explicitly
apply `scripts/provision-game-notifications.ts` from that release with a new idempotency key for
`game.ru-ru.v2` and the existing `APPLY_GAME_NOTIFICATION_RULESET` confirmation. This provisions the
`GAME_RESULT` category and the two `IN_APP`/`PUSH` rules; it leaves runtime gates and other category
preferences untouched. Read back both active rules and the dedicated durable
`phub.game-result-notification-intent-projector.v1` queue bindings before the test game ends.
Provisioning and real push delivery require their own live-target authority. Do not replay old game
outbox events or alter real game times to manufacture acceptance.

Use one LK1-created game with four reconciled active participants and native/browser push opt-in:

1. Before finish, all four see the canonical card and can open its participants and details in LK2.
2. At finish, all four receive the score-entry notification with the game link and absolute deadline.
   My Games and Home retain the card, and history excludes it.
3. One participant submits once. All four (including the author) receive the score-submitted notice
   naming the original deadline. Another participant can confirm or dispute; the author cannot
   review their own proposal. Category opt-out suppresses push independently of the in-app notice.
4. Early confirmation removes the card from My Games and makes it available in history. A dispute
   keeps it in My Games only until the same deadline and blocks automatic confirmation.
5. At game end +12h, entry/review are closed and the card is in history. A pending undisputed score
   is auto-confirmed by the worker; absent or disputed results never produce a rating event.
6. Broker/command replay must not duplicate notifications, canonical results or rating facts. A queued
   push is revalidated before provider dispatch and suppressed after expiry or supersession.

Source/fixture checks are LOCAL or CI evidence. Receipt of the native notification on a real device,
opening its link and natural deadline transitions remain separate live acceptance evidence.
Rollback must preserve canonical results and idempotency/audit/outbox rows; it cannot undo a delivered
push or rating event. Do not restore a submission-relative worker alongside the new API. Freeze new
score commands during an approved full-contour rollback and never reopen the legacy result writer.

### Android acceptance package

The installed 1.17/code18 client permits chat-only push routes and does not relay result commands.
Full Android acceptance requires a newly bundled 1.18/code19 APK with the existing reviewed Firebase
client configuration and the same release signing identity; backend deployment alone is insufficient.
The task's config-free debug APK proves compilation/JVM behavior only and must not replace a real
installation. Signing/publication/installation and real device acceptance remain separate operations.

The Android request policy allows only the existing submit/confirm/dispute POST routes with the
original bearer/key and bounded strict JSON. Result requests keep the original account/token across
any same-key network retry; local logout retires both dispatch and late response/error handling before
push cleanup. A different login cannot replay a previous participant's score body or key.
FCM data, native open custody and the bundled router preserve only exact local game/chat UUID links.
Android and iOS score banners contain static event copy plus the original deadline, without scores,
participant names, locations or dispute text. APNs checks current score eligibility after endpoint
lock waits and preserves its durable non-retryable dispatch fence.
