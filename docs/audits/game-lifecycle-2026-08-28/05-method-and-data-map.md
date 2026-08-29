# Method and data map

Every chain starts at a public/admin/system action and ends at durable state plus readback. `—` means the layer does not exist in frozen main.

## Shared command boundary

`apps/api/src/app.ts` registers roster and result commands with:

1. `authenticate`: JWT signature/issuer/audience/session parsing.
2. `authorizeGamesPlayer`: requires permission `games.play`.
3. `resolveTenant`: tenant key, user membership and `request.tenantId`.
4. `requireIdempotencyKey`: syntactically valid key.

Repositories use `withTenantTransaction`: `BEGIN`, `set_config('app.tenant_id', tenantId, true)`, callback, `COMMIT` or `ROLLBACK`. Games tables force RLS. `request.id` is the correlation identity; the business replay identity is principal + Idempotency-Key + request hash.

## Action map

### Public list, public detail route and authenticated reads

```text
public GamesPage / Event Catalog / recommendations
→ PadlHubApiClient.listPublicGames
→ GET /public/api/v1/:tenantKey/games
→ resolvePublicTenant
→ listPublicCardProjections
→ SELECT games.card_projections; exclude integration.legacy_game_merge_redirects sources
→ public card page

public game detail route (no frozen public-detail SDK method)
→ GET /public/api/v1/:tenantKey/games/:gameId
→ resolvePublicTenant
→ getCardProjection
→ SELECT games.card_projections by tenant/game id
→ public-safe deriveGameCardView

authenticated upcoming/history/detail
→ PadlHubApiClient.listMyGames | getGame
→ GET /user/api/v1/:tenantKey/games[/:gameId]
→ authenticate + resolveTenant
→ listViewerCardProjections | getCardProjection
→ SELECT games.card_projections; derive viewer facts from base_payload JSON
→ separate profile enrichment → authenticated GameCard view
```

Public SQL includes only PUBLIC, SCHEDULED, future card projections and excludes alias redirect sources. Viewer upcoming includes SCHEDULED/IN_PROGRESS; history includes FINISHED/CANCELLED. User reads do not use `authorizeGamesPlayer`; source proves the difference but no authoritative permission contract proves this is a defect. Scenario A-007 is therefore UNKNOWN pending a product/security compatibility decision.

### Free join

```text
GameCard/GameDetail JOIN
→ AuthGateway.joinGame
→ PadlHubApiClient.joinGame (one key per invocation; one network retry with same key)
→ POST /user/api/v1/:tenantKey/games/:gameId/join
→ shared command preHandlers
→ game-routes parse UUID + expectedRevision? + invitationId?
→ GameRosterRepository.join
→ advisory game-command key
→ command_idempotency replay/hash check
→ games.games FOR UPDATE
→ active participation/reservation/waitlist facts
→ assertJoinAllowed
→ evaluate/persist eligibility decision
→ INSERT games.participations ACTIVE/NOT_REQUIRED
→ UPDATE games.games revision=revision+1
→ INSERT command_idempotency COMPLETED + audit_log + outbox events
→ COMMIT
→ 200 GameCommandResult, game=null, relation PARTICIPANT
→ operation polling (bounded) + card detail GET
→ game.# card projector → games.card_projections
```

Changed fields: participation role PLAYER, state ACTIVE, payment_state NOT_REQUIRED, joined_at default; aggregate revision/updated_at; immutable command result/audit/outbox. When capacity becomes full, `game.roster.completed.v1` is also emitted.

### Paid/subscription join

The UI/SDK/HTTP/guards are identical until the mutation branch.

```text
GameRosterRepository.join
→ INSERT eligibility.payment_snapshots from decision
→ INSERT games.seat_reservations ACTIVE
   SPLIT payment_state=REQUIRES_ACTION
   SUBSCRIPTION payment_state=PROCESSING
   expires_at=now+15m
→ INSERT scheduled command game.reservation.expire.v1
→ revision + command/audit/outbox
→ 202 PROCESSING, nextAction NONE, game=null
→ operation polling returns the stored reservation result
```

The chain stops. No public provider/payment/entitlement method is called. No worker claims expiry. A trusted local/staging legacy bridge can later call `confirmPayment`, but that is a separate integration path and not a public operation continuation.

### Trusted payment confirmation bridge

```text
Legacy Node-RED integration (caller deployment UNKNOWN)
→ POST /internal/api/v1/:tenantKey/legacy-games/:legacyGameId/roster-commands
→ constant-time integration token + forwarded bearer
→ CupLegacyLkIdentityVerifier
→ exact tenant/issuer/subject/phone and legacy-game mapping
→ command type CONFIRM_PAYMENT + expected local revision
→ GameRosterRepository.confirmPayment
→ idempotency advisory + game/reservation row locks
→ require eligibility snapshot, active/unexpired actor-owned reservation
→ provider evidence operation advisory + unique evidence lookup
→ validate evidence type matches payment mode
→ INSERT games.payment_confirmation_evidence APPLIED/REJECTED
→ INSERT/activate participation PAID; reservation CONFIRMED/PAID
→ aggregate revision + command/audit/outbox
```

Exact provider operation replay and reservation uniqueness are strong. Missing semantic bindings: provider exercise may be null, expected booking/exercise is not compared, and expected quotation amount/currency is absent. LK2 performs no Viva readback.

### Join/leave waitlist

```text
GamesPage command
→ SDK joinGameWaitlist | leaveGameWaitlist
→ POST|DELETE /games/:gameId/waitlist[/me]
→ shared command boundary
→ GameRosterRepository.joinWaitlist | leaveWaitlist
→ same idempotency/game lock order
→ assertWaitlistJoinAllowed | assertWaitlistLeaveAllowed
→ INSERT ACTIVE entry at max(position)+1 OR UPDATE state LEFT/left_at
→ revision + command/audit/outbox
→ operation/card readback
```

Join requires the game to be full and waitlist enabled. Leave waitlist has no cutoff guard. Promotion is not in this request chain.

### Reservation expiry and waitlist promotion

```text
scheduled_commands row exists
→ expected worker/executor — ABSENT
→ GameRosterRepository.expireReservation | promoteWaitlist exists
→ direct tests call method
```

If invoked, expiry locks game then reservation, marks EXPIRED/payment EXPIRED and emits expired/reopened. Promotion locks game, capacity and first waitlist row, re-evaluates eligibility, marks PROMOTED and creates ACTIVE participation or paid reservation. Because no runtime caller exists, repository capability is MAIN_PARTIAL rather than an automatic journey.

### Self leave

```text
LEAVE action
→ SDK leaveGame
→ DELETE /games/:gameId/participants/me
→ shared command boundary
→ GameRosterRepository.leave
→ idempotency → game row → facts
→ assert non-organizer, ACTIVE, SCHEDULED, before cutoff
→ UPDATE participations SET state=LEFT,left_at=now()
→ UPDATE game revision
→ if previously full INSERT waitlist.promote scheduled command
→ command/audit/outbox participation.left + roster.reopened
→ 200 + operation/card readback
→ HTTP Game chat authorization immediately fails on participation predicate
```

For PAID/SUBSCRIPTION rows, `payment_state` remains unchanged. No refund, provider cancellation, entitlement restore or reconciliation occurs. Promotion is scheduled but not executed.

### Admin participant removal

Frozen lk2 has no organizer/admin remove command. Concrete ph-admin path is legacy:

```text
ph-admin GamesController POST /games/:id/players/:playerId/removal-requests
→ games:write + allowed staff role + station visibility
→ GamesService finds exact active participant/payment
→ derives unique bookingId + clientId + stable membershipVersion
→ LkPadelHubClientService POST LK1 /lk/internal/staff/games/:gameId/player-leaves
→ bearer + Idempotency-Key + exact target + RETURN_VISIT|NO_RETURN
→ LK1 durable leave operation
→ Viva Admin cancellation/readback
→ daily claim release if exact tracked claim
→ Mongo roster CAS
→ ph-admin polls status endpoint
```

Source availability is LEGACY_ACTIVE. No live/provider evidence was collected.

### Free create/cancel

Frozen main:

```text
OpenAPI create/cancel
→ no frozen SDK method
→ no frozen route
→ GameRepository.create is uncalled; cancel method absent
```

PR #135 only:

```text
CreateGamePage → SDK createGame → POST /games
→ free-only validation → GameRepository.create
→ INSERT SCHEDULED game + organizer + SUCCEEDED operation
→ schedule start/finish + audit/idempotency/outbox created/scheduled[/published]
→ 202 SUCCEEDED game=null → navigate detail → bounded projection wait

Game detail CANCEL → SDK cancelGame → POST /games/:id/cancel
→ owner + PROVISIONING|SCHEDULED + NO_PAYMENT guards
→ UPDATE game CANCELLED/cancellation fields/revision
→ operation/idempotency/audit/outbox cancelled
→ participant rows remain ACTIVE
```

Publish remains contract-only. PR cancellation does not compensate bookings/payments, deactivate roster, revoke chat, create notifications or run reconciliation.

### Lifecycle start/finish

```text
games.scheduled_commands lifecycle.start|finish
→ GameLifecycleProcessManager periodic tick (only when GAMES_READ_ENABLED)
→ reset stale PROCESSING lease to FAILED; claim PENDING|FAILED row FOR UPDATE SKIP LOCKED
→ executeLifecycleScheduledCommand
→ lock command then game
→ verify due time, expected revision and source state
→ CAS lifecycle/revision/result state
→ audit + outbox started|finished
→ mark command COMPLETED or retry from FAILED, capped at 20 attempts
→ card projector/readback
```

No manual start/finish route exists. The result editor does implement per-submission pair formation/change and sends `teamAUserIds`/`teamBUserIds` with result submission. Separately, “Стартовый состав” on game detail is assign/remove/swap state in browser `localStorage`; it has three UI_ONLY rows and is not a shared aggregate mutation.

### Result submit/confirm/dispute/rating

```text
Result editor/review action
→ SDK submit|confirm|dispute
→ POST result route + shared command boundary
→ GameResultRepository method
→ idempotency advisory → game FOR UPDATE → roster/submission rows
→ state/actor/window/exact-four-player guards
→ INSERT submission/review/result/normalized sets+players
→ UPDATE game result_state/revision
→ command/audit/outbox
→ game.result.confirmed.v1
   → card projector
   → result projector inbox → player_set_facts + four history rows
   → optional CUP rating POST with key game-result:{resultId}:v{revision}
→ bounded card readback
```

No correction/revert/void endpoint exists. CUP retry relies on remote idempotency and broker delivery limit; there is no local rating delivery journal/read-reconcile worker.

### GAME chat HTTP and realtime

```text
Game detail OPEN_CHAT
→ SDK getOrCreateGameConversation
→ messaging route
→ runtime http/contextual gates + identity ACTIVE + games.play + ACTIVE participation
→ idempotent lazy conversation/member creation
→ /chats/:conversationId
→ every list/send/read call re-runs getAuthorizedMember against canonical participation
→ message transaction increments conversation sequence + outbox message.created.v1
```

Leaving/removal revokes HTTP access through the participation predicate even if member state is stale. Cancellation/finish do not revoke while participation remains ACTIVE.

Frozen realtime connection/subscription/recipient queries require DIRECT chat. GAME uses HTTP history plus polling. PR #137 adds contextual connection, conversation-specific authorization, GAME recipients, same-user message advisory locks, real PostgreSQL race tests and browser gap recovery.

### Notifications

```text
game event
→ packages/games declarative consumer list includes notifications-rules
→ no concrete game notification binding/template/rule
→ notification worker binds booking.confirmed/changed/cancelled/reminder only
→ no intent/inbox/delivery/push row for game event
```

The presence of a notification deep-link fixture does not prove a Game notification producer.

## Read model and freshness map

| Read surface       | Canonical data                               | Lag/cache                                 | Cancellation/removal behavior                                                  |
| ------------------ | -------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------ |
| Public Games       | `games.card_projections`                     | broker + projector; HTTP 15s + 30s SWR    | only PUBLIC/SCHEDULED/future; cancelled disappears after projection            |
| My upcoming        | card projections + viewer facts              | eventual                                  | SCHEDULED/IN_PROGRESS only                                                     |
| My history         | card projections                             | eventual                                  | FINISHED/CANCELLED when viewer relationship is represented                     |
| Detail             | card projection + authorization-derived view | eventual                                  | may remain stale if dependency event dedup defect occurs                       |
| Recommendations    | up to 100 public candidates + 50 history     | server ~5m, web first page ~60s           | cancelled history excluded from learning; candidates scheduled only            |
| Home upcoming      | Viva client-assisted booking projection      | provider/client cache                     | no demonstrated native free-Game source                                        |
| Activity history   | `booking.activity_history_projection`        | result projector or legacy/client refresh | native confirmed results insert rows; provider UNSYNCED can 503 in frozen main |
| Chat list/messages | live messaging tables + active participation | direct SQL; realtime/poll                 | leave revokes; cancel policy unresolved                                        |

## Mutations without complete readback

- Paid reservation: operation remains the originally stored PROCESSING result; no completion transition.
- Roster/result commands: UI polling is bounded and does not require projected revision >= operation aggregate revision.
- Frozen repository create: PENDING operation has no provisioning executor or public readback route.
- Notifications: no generated read model.
- Provider/payment/refund: no native operation/reconcile readback.
- Projector dependency failures: retry is neutralized by committed inbox dedup.
