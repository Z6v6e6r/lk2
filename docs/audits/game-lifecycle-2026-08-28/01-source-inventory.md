# Source inventory and ownership

## Repository boundary

| Repository         | Frozen source                              | Included only for                                                                               | Excluded                              |
| ------------------ | ------------------------------------------ | ----------------------------------------------------------------------------------------------- | ------------------------------------- |
| `Z6v6e6r/lk2`      | `e6abb48e135f8f28730bab1c07abe408e8c94600` | Canonical AS-IS: UI, SDK, contracts, API, domain, PostgreSQL, workers, realtime, tests          | No runtime/deploy/provider inspection |
| `Z6v6e6r/lk`       | `6edbf010f729b45cf37dadc82bbeccb7233e1594` | Concrete LK1 Games routes, provider/payment/subscription/leave functions used by adapters/admin | No broad LK1 audit; no live flow pull |
| `Z6v6e6r/ph-admin` | `d92e403a07bac7398c10d1023f79d6eba2725aae` | Concrete game list/publication/chat/player-removal administration                               | No unrelated admin domains            |

## Canonical ownership

| Process/data                                            | Ownership                      | Evidence                                                             | Qualification                                                        |
| ------------------------------------------------------- | ------------------------------ | -------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Native Game aggregate, roster, results, card projection | LOCAL_PRIMARY                  | `packages/database/migrations/0023_games_foundation.sql:1-3,435-448` | Source exists but production config rejects native Games activation. |
| Local imported legacy aggregate                         | LOCAL_ONLY compatibility clone | `legacy-game-import-repository.ts` and integration sync state        | Legacy source can change local clone only through gated import/sync. |
| Viva booking/payment/refund truth                       | VIVA_PRIMARY                   | bridge evidence and LK1 Node-RED provider methods                    | LK2 accepts evidence; it does not perform provider readback.         |
| Result `shadow_compare`                                 | NOT_IMPLEMENTED                | config enum only; `main.ts` injects only `local_primary`             | No comparator/executor found.                                        |
| CUP rating mutation                                     | external CUP owner             | `cup-rating-client.ts`                                               | Remote idempotency/reconciliation is UNKNOWN.                        |

## Runtime gates

| Gate                                 | Default/source guard                                                                     | Consequence                                                       |
| ------------------------------------ | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `GAMES_READ_ENABLED`                 | `.env.example=false`; production true rejected at `packages/config/src/index.ts:614-620` | No native Game repository injection or lifecycle scan when false. |
| `GAMES_COMMANDS_ENABLED`             | `.env.example=false`; production true rejected                                           | No roster repository injection.                                   |
| `GAMES_RESULTS_WRITE_MODE`           | `disabled`; production non-disabled rejected at `:679-685`                               | Result routes return unavailable without `local_primary`.         |
| `LEGACY_GAME_COMMAND_BRIDGE_ENABLED` | local/staging only and depends on reads/commands/tokens/verifier `:659-676`              | Payment confirmation bridge unavailable by default.               |
| `LEGACY_GAMES_ROSTER_SYNC_ENABLED`   | local/staging only `:772-803`                                                            | Legacy mirror is not a production-native proof.                   |
| Messaging HTTP/contextual/realtime   | per-tenant database runtime settings                                                     | GAME HTTP chat and realtime are separately gated.                 |
| `CUP_RATING_CONSUMER_ENABLED`        | false by default                                                                         | Confirmed result does not imply remote rating mutation.           |

## Apps and packages inspected

### Web and mobile

- `apps/web/src/GamesPage.tsx`: list/detail, join/leave/waitlist/result/chat, bounded polling.
- `apps/web/src/GameCard.tsx`, `GameDetailView.tsx`, `game-card-policy.ts`: allowed action rendering, payment-disabled fallbacks, result/chat controls.
- `apps/web/src/App.tsx`: route mapping; `/games/new` is a WIP shell in frozen main.
- `apps/web/src/auth-gateway.ts`: Event Catalog, recommendations, cache and SDK gateway.
- `apps/mobile/src/main.tsx`: auth only; no dedicated Game screen/action.
- `apps/cup-admin`: level-eligibility administration only; no native Game aggregate lifecycle UI.

### API

- `apps/api/src/games/game-read-routes.ts`, `game-routes.ts`, `game-result-routes.ts`.
- `apps/api/src/games/legacy-game-roster-bridge-routes.ts` and verifier/mapping repositories.
- `apps/api/src/bookings`: recommendation, activity-history, client-assisted event catalog and legacy backfill.
- `apps/api/src/eligibility/participation-command-routes.ts`: generic gated service boundary, not a Game aggregate writer.
- `apps/api/src/subscriptions/subscription-runtime-warn-routes.ts`: non-binding advisory quote only.
- `apps/api/src/messaging`, `notifications`, `tournaments`, `coach-games`, `communities` for concrete Game-linked reads/actions.

### Domain, SDK and adapters

- `packages/games/src/index.ts`: lifecycle, roster facts/policies, event/internal-command schemas, declarative consumer routing.
- `packages/api-sdk/src/index.ts`: 10 frozen-main user Game methods, same-key single network retry, auth refresh and error mapping.
- `packages/database/src/game-repository.ts`, `game-roster-repository.ts`, `game-result-repository.ts`, `game-result-projection-repository.ts`, `messaging-repository.ts`.
- `packages/subscription-runtime-adapter`: non-binding quote/recheck contract.
- Legacy/provider adapter references were followed only where a concrete Game route uses them.

### Workers and realtime

- `games-card-projector-consumer.ts`: binds `game.#`, quorum queue, delivery limit 5, DLX.
- `game-lifecycle-process-manager.ts`: scans only `game.lifecycle.start.v1` and `game.lifecycle.finish.v1`.
- `game-result-projector-consumer.ts`: confirmed-result facts/history.
- `cup-rating-consumer.ts`: optional external rating mutation.
- `notification-projector-consumer.ts`: booking routing keys only; explicitly no wildcard.
- `home-projector-consumer.ts`: home component event only, not `game.#`.
- `apps/realtime/src/app.ts` and message consumer: direct-chat realtime in frozen main; GAME additions only in PR #137.

## Endpoint inventory and reconciliation 1: OpenAPI → route → handler → repository

Canonical user contract: `contracts/openapi/user/v1/games.yaml`.

| Operation           | Contract |          Frozen route | Repository                                  | Status                                       |
| ------------------- | -------: | --------------------: | ------------------------------------------- | -------------------------------------------- |
| `listMyGames`       |      yes | `game-read-routes.ts` | card projections                            | FEATURE_GATED                                |
| `createGame`        |      yes |                    no | `GameRepository.create` exists but uncalled | CONTRACT_ONLY; PENDING_PR #135 route/UI      |
| `getGame`           |      yes |                   yes | `getCardProjection`                         | FEATURE_GATED                                |
| `publishGame`       |      yes |                    no | no command method                           | CONTRACT_ONLY                                |
| `joinGame`          |      yes |                   yes | `GameRosterRepository.join`                 | FEATURE_GATED                                |
| `leaveGame`         |      yes |                   yes | `leave`                                     | FEATURE_GATED                                |
| `joinGameWaitlist`  |      yes |                   yes | `joinWaitlist`                              | FEATURE_GATED                                |
| `leaveGameWaitlist` |      yes |                   yes | `leaveWaitlist`                             | FEATURE_GATED                                |
| `cancelGame`        |      yes |                    no | no frozen cancel; PR #135 adds it           | CONTRACT_ONLY/PENDING_PR                     |
| `submitGameResult`  |      yes |                   yes | `GameResultRepository.submit`               | FEATURE_GATED                                |
| `confirmGameResult` |      yes |                   yes | `confirm`                                   | FEATURE_GATED                                |
| `disputeGameResult` |      yes |                   yes | `dispute`                                   | FEATURE_GATED                                |
| `getGameOperation`  |      yes |                   yes | roster `getOperation` only                  | FEATURE_GATED; management operations PR #135 |

Additional mismatches:

- Internal OpenAPI advertises `POST /{tenantKey}/game-commands`; no registered route exists.
- Public API has list and detail routes, but the SDK exports public list only; public detail has no public SDK method.
- Root `openapi.yaml` is older/unversioned and is not the canonical registered `/user/api/v1` surface.
- Card policy can expose action vocabulary including `PAY`, `RETRY_PAYMENT`, `INVITE`, `EDIT` and `CANCEL`; frozen SDK/routes do not close those commands.

## Reconciliation 2: UI/SDK → contract → endpoint

| UI action                     | SDK                        | Contract                  | Frozen endpoint  | Result                                          |
| ----------------------------- | -------------------------- | ------------------------- | ---------------- | ----------------------------------------------- |
| Join/leave/waitlist           | present                    | present                   | present          | Source chain exists, feature-gated.             |
| Submit/confirm/dispute result | present                    | present                   | present          | Source chain exists, feature-gated.             |
| Create                        | CTA/WIP only               | absent SDK                | contract present | UI shell + contract orphan; PR #135 adds chain. |
| Publish                       | no UI/SDK                  | contract present          | absent           | CONTRACT_ONLY.                                  |
| Cancel                        | no durable frozen UI/SDK   | contract present          | absent           | PR #135 only.                                   |
| Pay/retry payment             | disabled/fallback UI state | no public payment command | absent           | UI/action vocabulary does not close journey.    |
| Game chat                     | present                    | messaging contract        | present HTTP     | Frozen GAME realtime absent.                    |
| “Стартовый состав”            | localStorage only          | no contract               | absent           | UI_ONLY illusion; not durable Game state.       |

## Reconciliation 3: repository → SQL/table/constraint → migration

| Repository method                            | Main tables                                                                                     | Lock/idempotency                             | Migration/constraint                                                           |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------ |
| `GameRepository.create`                      | games, participations, operations, scheduled_commands, command_idempotency, audit/outbox        | advisory idempotency; one tenant transaction | `0023`; active roster and command uniques                                      |
| `GameRosterRepository.join`                  | games, participations or seat_reservations, eligibility decisions/snapshots, scheduled commands | advisory key → game `FOR UPDATE` → facts     | `0023`, `0084`, `0085`; active partial uniques                                 |
| `confirmPayment`                             | reservation, evidence, participation, game, command/audit/outbox                                | provider evidence advisory + row locks       | `0085` provider operation and reservation unique; exercise nullable via `0086` |
| `joinWaitlist/leaveWaitlist/promoteWaitlist` | waitlist_entries, games, optional participation/reservation                                     | game row and first waitlist row              | `0023` unique active user/position                                             |
| `leave`                                      | participations, games, scheduled_commands                                                       | idempotency → game row                       | `0023`; no refund/entitlement state change                                     |
| `submit/confirm/dispute`                     | result submissions/reviews/results/sets/players, games                                          | idempotency → game row → result rows         | `0023`, `0040`; result/quorum constraints                                      |
| `projectCardEvent`                           | inbox, card_projections, aggregate dependencies                                                 | inbox dedup + revision fence                 | `0001`, `0023`                                                                 |
| `projectConfirmedResult`                     | inbox, player_set_facts, activity_history_projection                                            | inbox dedup                                  | `0001`, `0037`, `0040`                                                         |
| GAME messaging                               | conversations/members/messages/game_conversation_commands                                       | conversation row + idempotency               | `0007`, `0059`; RLS and unique command/member/message constraints              |

All Games foundation tables enable and force RLS in `0023_games_foundation.sql:372-433`. `withTenantTransaction` sets `app.tenant_id` before repository SQL.

## Reconciliation 4: domain/outbox event → concrete consumer

| Event family                        | Published by                          | Concrete consumer              | Gap                                                           |
| ----------------------------------- | ------------------------------------- | ------------------------------ | ------------------------------------------------------------- |
| all `game.#`                        | create/roster/lifecycle/result/import | games card projector           | Present, but dependency-missing retry defect.                 |
| `game.result.confirmed.v1`          | result confirm                        | result history/facts projector | Present; same inbox-before-retry defect on missing source.    |
| `game.result.confirmed.v1`          | result confirm                        | optional CUP rating consumer   | Present behind flag; remote reconcile absent.                 |
| lifecycle start/finish commands     | scheduled rows                        | lifecycle DB scanner           | Present for 2/6 internal command types.                       |
| provisioning advance                | create                                | none                           | Orphan.                                                       |
| reservation expire                  | paid join/promotion                   | none                           | Orphan.                                                       |
| waitlist promote                    | leave/expiry                          | none                           | Orphan.                                                       |
| integration reconcile               | schema                                | none                           | Orphan.                                                       |
| declarative `notifications-rules`   | event catalog                         | none for game events           | Worker binds booking events only.                             |
| declarative `messaging-membership`  | event catalog                         | none                           | Chat membership is lazy and access is SQL-rechecked.          |
| declarative `home-projector`        | event catalog                         | none for game events           | Home worker binds its own component event.                    |
| declarative `realtime-invalidation` | event catalog                         | none for Game aggregate        | PR #137 affects message realtime, not Game card invalidation. |

## Migrations and direct data set

Direct Games tables (16): `games`, `participations`, `seat_reservations`, `waitlist_entries`, `result_submissions`, `result_submission_reviews`, `results`, `invitations`, `operations`, `card_projections`, `command_idempotency`, `scheduled_commands`, `result_sets`, `result_set_players`, `player_set_facts`, `payment_confirmation_evidence`.

Additional traced tables include `eligibility.canonical_levels`, `player_sport_levels`, `level_policies`, `personal_invitations`, `decisions`, `payment_snapshots`, CUP level projections/events, generic participation commands, `audit.outbox_events`, `audit.inbox_events`, `audit.audit_log`, `booking.activity_history_projection`, messaging conversations/members/messages/game commands, and legacy sync/binding/redirect tables.

## Secondary repository paths

### LK1

Concrete route construction in `scripts/patch_nodered_games_flow.mjs` covers list/detail/create/draft/payment confirm/split create/join/leave/cleanup/composite routes. Source functions live under `scripts/nodered_games_nodes/`. Hardened staff leave is documented and sourced by `docs/LK_GAME_DURABLE_LEAVE_2026-08-11.md` and `fn_staff_player_leave_*`: exact target/client/booking/membership generation, service token, durable operation states, Viva readback, daily-claim release and local CAS.

Git source does not prove live Node-RED import identity. The audit did not read the live flow.

Security boundary: legacy `origin/main` contains a tracked flow artifact matching a static credential pattern at `node-red/ЛК03_03_26.with_games.json`, Node-RED function `Get or request Viva token` (`id=51b1a0d0ee534101`), field `func`, line 2745. This report records the location but never reproduces the value. See `GL-P0-05`.

### ph-admin

`src/games/games.controller.ts` exposes game list/detail/analytics/events, legacy Mongo game chat, publication mutations, metadata replacement and player-removal handoff. `src/games/games.service.ts` defaults to Mongo/LK modes, not lk2 PostgreSQL. Player removal calls LK1 staff endpoints through `LkPadelHubClientService`, with exact booking/client/membershipVersion and RETURN_VISIT/NO_RETURN. These are LEGACY_ACTIVE source paths, not native lk2 aggregate commands.

## Orphans, duplicate paths and unavailable proof

- Orphan contracts: create/publish/cancel; internal generic game command.
- Orphan UI/action vocabulary: frozen create shell, pay/retry/invite/edit/cancel action vocabulary; browser-local lineup.
- Orphan internal commands: provisioning, reservation expiry, waitlist promotion, integration reconcile.
- Event consumers declared but absent: notifications, home, messaging membership, Game invalidation.
- Duplicate ownership: ph-admin publication/metadata writes legacy Mongo while lk2 owns native PostgreSQL projections; there is no single native admin mutation surface.
- Runtime-only proof unavailable: feature flags, migration ledger/grants, broker bindings/backlog/DLQ, live legacy flow, provider persistence, CUP remote idempotency.

## Open PR inventory at freeze

| PR                                               | State      | Exact head/tree               | Merge-base used for feature diff | Feature delta        | Required checks                                                                                                                                                                                                                |
| ------------------------------------------------ | ---------- | ----------------------------- | -------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| #135 `feat(games): close free core game journey` | Draft/open | `3a35c79d...` / `9de053d8...` | `a522789d...`                    | 23 files, +2015/-76  | [`quality` failure](https://github.com/Z6v6e6r/lk2/actions/runs/32980772904/job/98216589878); dependency, secret and image checks green                                                                                        |
| #137 `Close GAME chat beta journey`              | Draft/open | `6dc2281a...` / `8456c7ee...` | `5a7d3c14...`                    | 19 files, +2024/-205 | [`quality` green](https://github.com/Z6v6e6r/lk2/actions/runs/33040598144/job/98413065384); [`pull-request-gate` failure](https://github.com/Z6v6e6r/lk2/actions/runs/33040598144/job/98414214180) and two provenance failures |

The direct frozen-main-to-head diff is not a feature delta because both PRs are based on older main. Only merge-base-to-head was used to classify PENDING_DELTA.
