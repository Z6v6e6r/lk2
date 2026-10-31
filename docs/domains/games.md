# Games domain target design

Status: proposal for implementation planning
Date: 2026-07-17
Owner: PadlHub Games

## 1. Purpose

The Games module lets a player discover, create, join, pay for, play and finish a padel game. It
rebuilds the proven product flow of the current LK without copying its browser-side orchestration,
caller-supplied identity, whole-document updates or payment confirmation rules.

The target module must provide:

- one PadlHub-owned game aggregate and one command owner;
- deterministic lifecycle and card states shared by web, mobile, Tilda and CUP;
- public game discovery without exposing private or provider data;
- concurrency-safe participation and waitlist commands;
- server-confirmed booking and payment sagas;
- durable result submission, confirmation, dispute and rating projection;
- reusable card primitives whose Figma variants map to stable API state keys;
- an incremental migration path with no independent dual-write.

The module is implemented inside the existing modular monolith. It does not introduce a games
microservice.

### Discovery filtering and pagination

The current public Games keyset cursor remains the reference invariant: filters are applied before
the limit and the cursor is bound to the normalized query. ADR 0021 extends that invariant to the
mixed `/games` surface. Games, coach activities and tournaments must be normalized into one stable
snapshot and globally paginated; React must not merge independently bounded first pages.

Multiple stations use OR semantics in the server query. Tournament station filtering requires a
canonical PadlHub station UUID, not venue-name prefix matching. A local Game and a Viva activity are
deduplicated only through a verified integration mapping.

## 2. Domain boundary and ownership

Games are `LOCAL_PRIMARY`: PostgreSQL is the source of truth for the game aggregate. Business state
and the outbox event are committed in one transaction; external-domain projections are asynchronous
and must not become an independent dual-write path. Related domains retain their own owners:

| Concern                              | Owner                                       | Games stores                                          |
| ------------------------------------ | ------------------------------------------- | ----------------------------------------------------- |
| Game lifecycle, rules and visibility | Games                                       | canonical state                                       |
| Participants and waitlist            | Games                                       | canonical state                                       |
| Result workflow                      | Games                                       | canonical result and review state                     |
| Court availability and booking       | Bookings/Schedule, initially `VIVA_PRIMARY` | PadlHub booking UUID and confirmed snapshot           |
| Payment intent, capture and refund   | Commerce/provider                           | PadlHub payment UUID and obligation status projection |
| Rating calculation                   | Rating                                      | result reference and projection status                |
| Game chat                            | Messaging                                   | conversation UUID only                                |
| Notifications                        | Notifications                               | no delivery state inside the game                     |
| Viva identifiers and payloads        | Integration                                 | nothing in public/domain tables                       |

A game never stores a Viva identifier as a public or primary identifier. `integration` maps a
PadlHub booking/payment reference to provider identifiers. A game operation reads one consistent
game version; it never merges a local document with a live Viva response in the request handler.

## 3. Aggregate model

### 3.1 Game aggregate

`Game` is the consistency boundary for lifecycle, capacity and participation.

Core fields:

- `id`: PadlHub UUID;
- `tenant_id`: mandatory tenant owner;
- `revision`: optimistic concurrency version;
- `organizer_user_id`: verified PadlHub user UUID;
- `kind`: `FRIENDLY`, `RATING`, `PRIVATE`, `COACH_GAME`;
- `visibility`: `PUBLIC`, `PRIVATE`, `COMMUNITY`;
- `station_id`, optional `court_id`: PadlHub UUIDs;
- `starts_at`, `ends_at`, `timezone`;
- `capacity`: normally two or four, enforced by the server;
- `lifecycle_state`;
- `booking_id`: PadlHub Booking UUID after reservation;
- `payment_mode`: `ORGANIZER_PAYS`, `SPLIT`, `SUBSCRIPTION`, `NO_PAYMENT`;
- `created_at`, `updated_at`, cancellation and completion facts;
- `card_projection_revision`: last published card revision.

### 3.2 Child entities

| Entity             | Purpose                                    | Important invariant                                              |
| ------------------ | ------------------------------------------ | ---------------------------------------------------------------- |
| `Participation`    | organizer/player slot and its confirmation | one active participation per `(tenant, game, user)`              |
| `SeatReservation`  | temporary split-payment seat               | active reservations count against capacity and expire atomically |
| `WaitlistEntry`    | ordered waiting list                       | one active entry per user; order assigned by server sequence     |
| `GameResult`       | canonical confirmed result                 | at most one active result revision                               |
| `ResultSubmission` | proposed score and roster snapshot         | immutable submission payload; explicit review state              |
| `GameInvitation`   | private/community invitation               | hashed token, expiry, usage policy; no identity in URL           |

Payment attempts, booking provider data, chat messages and rating events are not child entities of
the game. They belong to their respective modules.

### 3.3 Database layout

The initial schema is expand-only:

- `games.games`;
- `games.participations`;
- `games.seat_reservations`;
- `games.waitlist_entries`;
- `games.result_submissions`;
- `games.result_submission_reviews`;
- `games.results`;
- `games.invitations`;
- `games.operations`;
- `games.card_projections`;
- `games.command_idempotency`;
- `games.scheduled_commands`;
- shared audit and outbox tables;
- `integration.external_entity_map` for Viva/provider references.
- `integration.legacy_game_merge_redirects` for lossless redirects created when historical raw and
  pseudonymous source IDs represented the same imported game.

Historical imports follow the same ownership boundary as upcoming roster imports. An authenticated
Viva history page supplies the bounded exercise set, CUP supplies the complete legacy snapshot, and
the Games importer atomically writes the aggregate, participants, integration associations, audit
fact and outbox event. A past imported game starts as `FINISHED / AWAITING_SUBMISSION`; the card
exposes submission only inside the result-policy window and otherwise renders `COMPLETED`. The card
is projected from the local aggregate before history is returned.

Legacy adapters use one deterministic pseudonymous namespace for game, player, station and court
association keys. Raw source values can exist only as integration aliases. Import locks the tenant,
resolves all aliases and maps them to one canonical aggregate. Historical duplicate aggregates are
not physically deleted: their visible projection and scheduled work are removed, external and
activity-history references move to the canonical aggregate, and the immutable source children are
retained behind a tenant-scoped redirect.

Every tenant-owned row contains `tenant_id`, has tenant-aware foreign keys and is protected by
forced RLS. API processes never run migrations.

Migration `0023_games_foundation.sql` is the expand release for this model. It declares Games as
`LOCAL_PRIMARY`, but does not activate a client write route or migrate legacy records. The initial
repository transaction creates a `PROVISIONING` aggregate, organizer participation, operation,
completed idempotency result, safe audit metadata, two validated outbox facts and a process-manager
command atomically. A repeated matching key returns the original identifiers; reuse with a different
request hash is a conflict.

Card projection writes are monotonic by projection revision and reject snapshots that do not match
the locked aggregate revision. Public discovery reads only `SCHEDULED`/`PUBLIC` projections using
the `(starts_at, game_id)` keyset. Scheduled work is claimed with `FOR UPDATE SKIP LOCKED`, a bounded
20-attempt policy and worker ownership checks.

The worker claims lifecycle commands separately from unfinished provisioning, payment and
integration commands. It claims one lifecycle command at a time per tenant so an overdue start is
committed before the corresponding finish. Command completion, aggregate revision, audit metadata
and the lifecycle outbox event share one transaction. A claim abandoned for 60 seconds becomes
eligible for retry; a changed canonical deadline or aggregate revision refreshes the same durable
command instead of applying stale timing.

## 4. State model

One overloaded status is forbidden. The state is represented by independent axes.

### 4.1 Canonical lifecycle

| State          | Meaning                                                      | Publicly discoverable                        |
| -------------- | ------------------------------------------------------------ | -------------------------------------------- |
| `DRAFT`        | local draft, not provisioned                                 | no                                           |
| `PROVISIONING` | booking/payment orchestration is running                     | no                                           |
| `SCHEDULED`    | booking is confirmed and game is upcoming                    | depends on visibility and publication policy |
| `IN_PROGRESS`  | start boundary passed or trusted operator transition applied | no new joins by default                      |
| `FINISHED`     | play has ended; result may still be absent or under review   | no                                           |
| `CANCELLED`    | terminal cancellation with reason and actor                  | no                                           |

Time-based transitions are server-owned scheduled commands. Clients may refresh a projection but
never decide that a game has started or finished.

### 4.2 Derived roster state

`rosterState` is calculated from active participations, seat reservations, capacity, waitlist
policy and command cut-off:

- `OPEN`;
- `LAST_SPOT`;
- `FULL`;
- `WAITLIST_ONLY`;
- `LOCKED`.

It is not independently editable.

### 4.3 Viewer relation

`viewerRelation` is derived from the verified JWT subject:

- `ANONYMOUS`;
- `NONE`;
- `ORGANIZER`;
- `SEAT_RESERVED`;
- `PARTICIPANT`;
- `WAITLISTED`;

Leaving is stored as an audited participation fact, not as a current card relation. A user who may
join again is therefore evaluated by command policy instead of receiving a sticky `LEFT` UI state.

Phone numbers and client IDs are never accepted as identity selectors for game commands.

### 4.4 Payment obligation state

Payment is tracked per obligation, not as one game-level boolean:

- `NOT_REQUIRED`;
- `REQUIRES_ACTION`;
- `PROCESSING`;
- `PAID`;
- `FAILED`;
- `EXPIRED`;
- `REFUND_PENDING`;
- `REFUNDED`.

Only a Commerce event produced after provider verification may transition an obligation to `PAID`,
`REFUND_PENDING` or `REFUNDED`.

### 4.5 Result state

- `NOT_AVAILABLE`: game has not finished;
- `AWAITING_SUBMISSION`: a result can be submitted;
- `PENDING_CONFIRMATION`: durable submission exists and awaits required confirmations;
- `CONFIRMED`: canonical result is accepted;
- `DISPUTED`: an explicit dispute is open;
- `VOID`: result was voided through an audited command.

The confirmed result and a rating outbox event are committed atomically. Rating calculation and
Viva projection run after the HTTP transaction.

The v2 submission payload is deliberately small: one ordered list of sets, and for each set two
player UUIDs in pair A, two in pair B and the two scores. All sets contain the same four active game
participants, while partners may change between sets. A complete local draft is submitted once;
there is no canonical autosave/session entity. One other participant confirms, or an eligible
participant disputes and a corrected immutable submission supersedes the disputed version.

Confirmation normalizes set rosters for card/history analytics and emits
`game.result.confirmed.v1`. Player history and CUP rating consume that fact asynchronously. CUP is
the only writer of current level and its rating ledger records source, player, old level, new level,
game and result UUIDs.

## 5. Server-owned card presentation

### 5.1 Why the card has a presentation contract

Web, mobile and Tilda must not reproduce precedence rules such as “payment required beats full
roster” or “finished without score beats completed”. The API/card projector returns a stable
`GameCardView` computed from one aggregate revision and the viewer relation.

### 5.2 Primary display states

| `displayState`          | User label            | Minimum condition                                | Typical action                                                             |
| ----------------------- | --------------------- | ------------------------------------------------ | -------------------------------------------------------------------------- |
| `FINDING_PLAYERS`       | Ищем игроков          | scheduled, more than one open spot               | `JOIN` or `INVITE`                                                         |
| `ONE_SPOT_LEFT`         | Осталось 1 место      | scheduled, one open spot                         | `JOIN`                                                                     |
| `ROSTER_READY`          | Состав набран         | scheduled, no open spots                         | `OPEN_DETAILS`                                                             |
| `SEAT_PAYMENT_REQUIRED` | Оплатите место        | viewer has an active unpaid reservation          | `PAY`                                                                      |
| `STARTING_SOON`         | Скоро начало          | within server-configured window                  | `OPEN_DETAILS`                                                             |
| `REGISTRATION_CLOSED`   | Регистрация закрыта   | join cut-off passed before game transition       | `OPEN_DETAILS`                                                             |
| `IN_PROGRESS`           | Игра идёт             | lifecycle is in progress                         | `OPEN_DETAILS`; `OPEN_CHAT` only with an authorized conversation reference |
| `RESULT_REQUIRED`       | Внесите счёт          | finished, viewer may submit, no submission       | `SUBMIT_RESULT`                                                            |
| `RESULT_PENDING`        | Счёт на подтверждении | result pending confirmation                      | `CONFIRM_RESULT` or view                                                   |
| `RESULT_DISPUTED`       | Результат оспорен     | dispute is open                                  | `OPEN_DISPUTE`                                                             |
| `COMPLETED`             | Игра завершена        | confirmed, void, or no submission after 48 hours | `VIEW_RESULT` when confirmed                                               |
| `CANCELLED`             | Игра отменена         | lifecycle cancelled                              | refund/details action if applicable                                        |

The primary display state is not the complete domain state. Secondary badges can show `Рейтинговая`,
`Закрытая`, `Лист ожидания`, `Возврат оформляется` or `Вы организатор` without changing the primary
state.

`OPEN_CHAT` is not inferred from game participation alone. The viewer DTO may expose it only
alongside a non-null PadlHub `conversationId` resolved by the messaging membership repository.
If the messaging route or repository is absent, the game remains usable but the chat action fails
closed.

The authenticated canonical game-detail surface may also issue the explicit idempotent
`POST /conversations/game` get-or-create command with the card's PadlHub `gameId`. This is never a
free-form identifier input: the messaging repository rechecks the active user, `games.play`, the
tenant messaging gates and current `ACTIVE` participation before returning a conversation. A
failed command leaves the game detail usable and does not synthesize an `OPEN_CHAT` capability.

### 5.2.1 End-to-end card state map

The API owns the transition from canonical lifecycle facts to a card state. Web, mobile, Tilda and
CUP render the returned key and never infer a game status from the current clock on the client.

| Phase                          | Canonical facts                                | External card `displayState` | Authenticated additions                                          | Primary transition                       |
| ------------------------------ | ---------------------------------------------- | ---------------------------- | ---------------------------------------------------------------- | ---------------------------------------- |
| Before publication             | `DRAFT` or `PROVISIONING`                      | not exposed                  | creation/provisioning operation only                             | confirmed booking/payment -> `SCHEDULED` |
| Before start, places available | `SCHEDULED` + `OPEN`                           | `FINDING_PLAYERS`            | join/invite/edit according to relation                           | one open place -> `ONE_SPOT_LEFT`        |
| Before start, last place       | `SCHEDULED` + `LAST_SPOT`                      | `ONE_SPOT_LEFT`              | join or invite                                                   | no open places -> `ROSTER_READY`         |
| Before start, roster full      | `SCHEDULED` + `FULL`/`WAITLIST_ONLY`           | `ROSTER_READY`               | waitlist actions when enabled                                    | cutoff -> `REGISTRATION_CLOSED`          |
| Shortly before start           | `SCHEDULED` inside the server window           | `STARTING_SOON`              | viewer payment may take precedence                               | scheduled start command -> `IN_PROGRESS` |
| During play                    | `IN_PROGRESS`                                  | `IN_PROGRESS`                | chat for participants                                            | finish command -> result workflow        |
| After play, result absent      | `FINISHED` + `AWAITING_SUBMISSION`             | `COMPLETED`                  | `RESULT_REQUIRED` for eligible players during the bounded window | submit or window expiry                  |
| After play, result review      | `FINISHED` + `PENDING_CONFIRMATION`/`DISPUTED` | `COMPLETED`                  | `RESULT_PENDING`/`RESULT_DISPUTED`                               | confirm, resolve or void                 |
| After play, terminal           | `FINISHED` + `CONFIRMED`/`VOID`                | `COMPLETED`                  | score/result action when authorized                              | terminal                                 |
| Cancelled at any point         | `CANCELLED` + cancellation facts               | `CANCELLED`                  | refund/details actions when authorized                           | terminal                                 |

Public cards deliberately collapse private result-workflow states to `COMPLETED`. They may expose
`IN_PROGRESS`, `COMPLETED` and `CANCELLED` on a direct public game card, while public discovery
continues to list only `PUBLIC + SCHEDULED` games.

### 5.2.2 Viva exercise to PadlHub game identity

Historical composition uses one exact server-side chain:

`Viva exercise UUID -> one-way integration association -> CUP game snapshot -> PadlHub game UUID`.

Viva proves that the exercise belongs to the authenticated user. CUP supplies the game roster and
legacy cancellation fact. The importer persists the canonical `games.games.lifecycle_state`, binds
the proven viewer through an integration-only player association, and projects one immutable game
revision. Date, title, station and court are reconciliation evidence only; they must never create a
game link because two different games may share the same time and station. A CUP miss remains a
provider-only activity record and must not receive a fabricated game UUID or game actions.

### 5.3 Precedence

The projector applies this high-level precedence:

1. terminal cancellation;
2. viewer-critical payment/refund action;
3. result dispute or confirmation action;
4. missing result action;
5. in-progress/starting-soon;
6. roster readiness;
7. open-place recruitment.

The exact precedence is a versioned domain policy with table-driven tests, not nested conditionals
inside a React component.

For a finished game with no submission, `SUBMIT_RESULT` remains available to participants for 48
hours after `endsAt`. At the deadline the server projector removes the action and returns
`COMPLETED`; clients do not calculate or extend this window. A confirmed result may be presented as
`Результат внесён`, while an expired game without a result is presented as `Игра завершена`.

### 5.4 `GameCardView` contract

The reusable contract contains only display-safe data:

```text
id, revision, surface, displayState, title, kind, visibility
startsAt, endsAt, timezone
station { id, name, shortAddress }
levelRange, capacity { total, occupied, reserved, open, waitlistCount }
participants[] { userId, displayName, avatarUrl, level, role }
priceSummary, viewerRelation, viewerPaymentState
resultSummary?, badges[], allowedActions[], deepLink
conversation { conversationId, unreadCount } | null
```

`conversation` is the game chat reference of the authenticated viewer, and it is the only chat data a
card carries: the thread body stays in the messaging aggregate. It is `null` (and `OPEN_CHAT` is
absent from `allowedActions`) whenever the viewer has no active game participation, the viewer
account or `games.play` access is inactive, the game is cancelled, or the tenant contextual-chat
runtime gate is off. The card never creates a conversation; the games interface opens or creates one
through the messaging command and then links to the returned thread.

The chat entry follows one decision shared by the card and the detail screen: an authorized
conversation is opened with the unread counter; a viewer who is on the roster of a non-cancelled game
gets a create-or-open entry even before anybody has opened the thread; everyone else, including a
cancelled game, gets no entry at all and therefore never learns an unauthorized conversation id.

It never contains phone, provider/Viva ID, provider payment URL, booking ID, raw metadata or audit
history. A public card may use a stricter `PublicGameCardView` and omit stable user IDs when product
policy does not require them.

### 5.5 UI component family

One component family is used on all surfaces:

- `GameCardShell` — layout, interaction and accessibility boundary;
- `GameStatusBadge` — `displayState` to token/label/icon mapping;
- `GameScheduleBlock`;
- `GameStationBlock`;
- `GameParticipantStack` / `GameSeatStrip`;
- `GamePriceSummary`;
- `GameResultSummary`;
- `GameCardActions` — renders only server-provided allowed actions;
- `GameChatAction` — renders the server-authorized `conversation` entry and its unread counter next
  to the primary action; absent whenever the card has no conversation;
- `GameCardSkeleton`, `GameCardError` and `GameCardUnavailable`.

Supported surfaces are `DISCOVER`, `MY_UPCOMING`, `HISTORY`, `INVITE` and `ADMIN_PREVIEW`. They are
layout contexts, not independent business implementations.

Figma should contain a component set named `GameCard` whose variant keys match `surface` and
`displayState`. Nested participant, badge and action components prevent a combinatorial variant
explosion. Code stories use the same state keys and payload fixtures.

## 6. API surface

This is the target contract map; the canonical OpenAPI change is a separate implementation task.

### 6.1 Read APIs

- `GET /public/api/v1/{tenantKey}/games` — public discovery, keyset cursor, safe DTO only;
- `GET /public/api/v1/{tenantKey}/games/{gameId}` — safe public/invite detail;
- `GET /user/api/v1/{tenantKey}/games?view=discover|upcoming|history`;
- `GET /user/api/v1/{tenantKey}/games/{gameId}` — viewer-aware detail and allowed actions;
- `GET /user/api/v1/{tenantKey}/games/{gameId}/result`;
- messaging APIs provide game chat history; the games endpoint returns only `conversationId` and
  unread summary when authorized.

Introducing `/public/api/v1` requires the API-boundary ADR to be accepted. The alternative is an
explicit optional-security public operation under User API, but it must still use a different DTO.

### 6.2 Commands

All critical commands require PadlHub JWT, tenant context, `Idempotency-Key`, correlation ID,
authorization, audit and stable error codes.

- `POST /user/api/v1/{tenantKey}/games`;
- `POST /user/api/v1/{tenantKey}/games/{gameId}/publish`;
- `POST /user/api/v1/{tenantKey}/games/{gameId}/join`;
- `DELETE /user/api/v1/{tenantKey}/games/{gameId}/participants/me`;
- `POST /user/api/v1/{tenantKey}/games/{gameId}/waitlist`;
- `DELETE /user/api/v1/{tenantKey}/games/{gameId}/waitlist/me`;
- `POST /user/api/v1/{tenantKey}/games/{gameId}/cancel`;
- `POST /user/api/v1/{tenantKey}/games/{gameId}/result-submissions`;
- `POST /user/api/v1/{tenantKey}/games/{gameId}/result-submissions/{submissionId}/confirm`;
- `POST /user/api/v1/{tenantKey}/games/{gameId}/result-submissions/{submissionId}/dispute`.

There is no public generic `PATCH /games/{id}` and no command that accepts complete participant or
waitlist arrays.

### 6.3 Command response

A command returns:

- stable operation/result UUID;
- committed aggregate revision;
- current `GameCardView` or a link to refresh it;
- optional `nextAction` such as provider redirect, but never a provider credential;
- stable conflict/error code;
- replayed responses for the same idempotency key.

## 7. Critical flows

### 7.1 Create game

1. API verifies user, tenant, capability, time and requested business parameters.
2. One transaction creates a `PROVISIONING` game, creation operation, audit and outbox event.
3. Worker/process manager requests the booking through the Bookings port and `@phub/viva-adapter`.
4. Booking success stores only the PadlHub booking UUID and confirmed schedule snapshot.
5. If organizer payment is required, Commerce creates a payment intent. The browser only follows
   `nextAction`; it cannot mark the payment successful.
6. Provider webhook/reconciliation confirms the payment.
7. The process manager transitions the game to `SCHEDULED`, creates the card projection and emits
   `game.published.v1` when visibility policy permits.
8. A permanent booking/payment failure cancels provisioning and releases acquired resources with
   an auditable reason.

HTTP may return `202 Accepted` with an operation resource while provisioning continues. Realtime or
bounded polling updates the client.

### 7.2 Join with split payment

1. API locks the game row and validates allowed action, cut-off, level policy and capacity.
2. It creates an expiring `SeatReservation`; the reserved seat counts against capacity.
3. Commerce creates a payment obligation/intent using stable idempotency keys.
4. A verified payment event atomically converts the reservation to confirmed participation.
5. Failed or expired payment releases the reservation and may promote the first eligible waitlist
   entry through a new server command.
6. Concurrent joins use row locking/version predicates and can never exceed capacity.

The roster User API derives tenant and actor only from the verified PadlHub JWT, requires the
server-issued `games.play` permission and rejects caller-supplied roster identity. Every mutation
requires `Idempotency-Key`; the canonical request hash includes the explicit command, PadlHub game
UUID and allowlisted payload only. Immediate participation, waitlist and leave commands return a
validated `200` operation result. A paid seat reservation returns `202 PROCESSING` and remains
queryable by its command UUID through the authenticated operation endpoint.

Until Commerce supplies a verified payment next action and confirmation consumer, the API never
invents a payment URL or marks the reservation paid. Production dependency injection for Games
remains off at this boundary; registered routes fail closed with `GAMES_RUNTIME_UNAVAILABLE`.

### 7.2.1 Card projection and reads

Every Games fact is delivered to the dedicated card projector through a durable bounded quorum
queue. The projector inserts its inbox record, locks the current Games aggregate for a consistent
read, assembles participants, active reservations, waitlist, local profile summaries and station
presentation, writes a monotonic `card_projections` snapshot and marks the inbox record processed
in one tenant transaction. Duplicate event UUIDs stop before aggregate loading; an older event may
project the latest aggregate revision but can never overwrite a newer projection.

Anonymous discovery reads only future `PUBLIC/SCHEDULED` projections. The domain mapper removes
PadlHub user UUIDs and result/private viewer fields before the response is built. Filters are
applied to the projected card policy, and the opaque keyset cursor is bound to the normalized
filter set so it cannot be reused with another query.

Authenticated `UPCOMING` and `HISTORY` lists select viewer ownership from the same versioned JSON
snapshot, including participant, active reservation and waitlist membership. Detail fails closed
for an outsider. Messaging remains a separate owner, so `conversation` is currently `null` rather
than inferred or joined from another source.

### 7.3 Leave and cancel

Leave affects only the verified viewer participation. Organizer cancellation is a distinct command
with policy, cut-off, refund orchestration and notification events. Community publication removal
is separate from cancelling the underlying game.

### 7.4 Finish and result

1. A scheduled server transition moves an elapsed game to `FINISHED` and `AWAITING_SUBMISSION`.
2. An authorized player saves one durable immutable submission with roster snapshot and idempotency
   key.
3. Required participants confirm or dispute it.
4. Confirmation writes canonical result, game/result revision, audit and rating outbox event in one
   transaction.
5. Worker projects rating, Home activity, notification and optional Viva compatibility state.
6. Projection failure never loses the canonical confirmed result and is repairable from outbox.

## 8. Events and consumers

Initial versioned facts:

- `game.created.v1`;
- `game.provisioning.requested.v1`;
- `game.scheduled.v1`;
- `game.published.v1`;
- `game.participation.reserved.v1`;
- `game.participation.confirmed.v1`;
- `game.participation.expired.v1`;
- `game.participation.left.v1`;
- `game.waitlist.joined.v1` / `game.waitlist.left.v1` / `game.waitlist.promoted.v1`;
- `game.roster.completed.v1` / `game.roster.reopened.v1`;
- `game.started.v1`;
- `game.finished.v1`;
- `game.result.submitted.v1`;
- `game.result.confirmed.v1`;
- `game.result.disputed.v1`;
- `game.cancelled.v1`.

Events contain PadlHub UUIDs, revision and safe reason/status codes. They do not contain phones,
tokens, provider IDs, payment URLs, message bodies or complete card payloads.

All Games events use the existing standard outbox envelope:

```text
id, type, aggregateId, tenantId, occurredAt, correlationId, payload
```

The strict payload always contains `gameId`, positive `aggregateRevision`, `causationId` and the
nullable PadlHub `actorUserId`. Keeping these facts inside the payload preserves compatibility with
the shared outbox publisher and existing notification/home consumers. Raw idempotency keys are
never copied to events; event UUID plus consumer inbox state provides delivery deduplication.

Internal scheduled/process-manager work uses six provider-neutral commands on the Games write-owner
boundary:

- `game.provisioning.advance.v1`;
- `game.reservation.expire.v1`;
- `game.waitlist.promote.v1`;
- `game.lifecycle.start.v1`;
- `game.lifecycle.finish.v1`;
- `game.integration.reconcile.v1`.

`game.reservation.expire.v1` remains a recovery/domain contract only. SPLIT and SUBSCRIPTION joins
fail closed with `GAME_PAYMENT_REQUIRED` before creating a reservation or scheduled command until
generation/payment-fenced expiry and ambiguous provider-result recovery are implemented and reviewed
as a separate R3 release change.

Commands carry only PadlHub UUIDs, expected revision and safe resource type. The service-only
Internal API accepts them with `Idempotency-Key`; it also exposes read-only event inspection for
correlation-based operations. It does not provide an HTTP event-ingestion route.

The CUP/legacy import bridge schedules both lifecycle deadlines whenever it creates or revisits a
future `SCHEDULED` aggregate. Repeated imports refresh pending deadlines without duplicating
commands; an exact snapshot that already proves `FINISHED` or `CANCELLED` completes superseded
pending lifecycle commands in the same tenant transaction.

During Activity History refresh, fresh Viva exercise references may select only their existing
integration associations. The Games write owner then advances those exact local aggregates from
their canonical start/end timestamps, emits the lifecycle outbox fact and rebuilds the card before
History is projected. This path neither exposes provider identifiers nor depends on CUP retaining
an old snapshot.

Consumers include card/Home projectors, Messaging conversation membership, Notifications, Rating,
realtime invalidation and integration compatibility workers. Every consumer is inbox-deduplicated.
Only `game.result.confirmed.v1`, never a submitted or disputed result, routes to Rating.

Roster mutation is serialized by locking the canonical game row. Capacity is derived inside that
transaction from active participants plus unexpired reservations: `NO_PAYMENT` and
`ORGANIZER_PAYS` create a participant immediately, while `SPLIT` and `SUBSCRIPTION` create a
time-bounded seat reservation and schedule its expiry. A full game may accept a server-positioned
waitlist entry. Leaving or expiring a seat reopens the roster and schedules promotion of the first
active waitlist entry; promotion locks and revalidates both capacity and queue head before writing.

Every user roster command stores its success or stable domain rejection in command idempotency and
audit state. Process-manager expiry and promotion use a service principal and their own idempotent
command identity. Raw idempotency keys never enter events or logs.

## 9. Security and privacy

- Identity comes only from verified PadlHub JWT claims and tenant route context.
- Organizer/player/moderator policies are evaluated server-side for every command.
- Public discovery uses an explicit allowlisted DTO and database projection.
- Invite tokens are random, hashed at rest, scoped, expiring and revocable.
- Critical commands are idempotent, audited and rate-limited.
- PostgreSQL RLS and tenant-aware keys enforce isolation in depth.
- Logs carry correlation, tenant, operation and stable error code but never phone, payment data,
  invite token, provider ID or raw result payload.
- Cleanup/reconciliation endpoints exist only under Internal/Admin APIs with separate JWT audience.

## 10. Reliability and observability

External booking/payment calls run through adapters with timeout, bounded retry, circuit breaker and
redacted telemetry. Unsafe POSTs are retried only with provider idempotency keys.

Required metrics:

- game creation operations by terminal state and duration;
- active/expired seat reservations;
- join conflicts and capacity-rejection counts;
- payment obligations stuck by state and age;
- card projection lag and revision mismatch;
- booking/Viva reconciliation drift;
- result submissions pending/disputed by age;
- outbox/inbox lag and DLQ count;
- public list latency, error rate and empty-result anomalies.

Reconciliation jobs repair projection/integration drift but never invent canonical game commands.

## 11. Figma and code contract

The supplied Figma link resolves to file `ЛК ПадлхАБ`, node `743:2039`. In the current connected
session that node selects a 20x20 bottom-navigation/profile icon rather than a game-card frame, and
the MCP account has view-only access that cannot return structured node context or screenshots.

Before card implementation, the design owner must provide frame-specific links for the `GameCard`
component set and grant the connected account inspect/edit-capable access, or provide exported
specifications. The design review must produce:

1. a state-to-Figma-node matrix using the exact `displayState` keys above;
2. mobile widths and wrapping rules;
3. participant count variants from zero through capacity;
4. CTA priority and disabled/loading/error states;
5. accessibility names, contrast and minimum touch targets;
6. tokens for status colors, typography, spacing and icons;
7. visual reference images used by component regression tests.

No CSS implementation starts from guessed dimensions or from the currently selected navigation
icon.

## 12. Definition of done

The target contour is accepted when:

- every game command has exactly one owner and one transactional commit boundary;
- all public IDs are PadlHub UUIDs and all public DTOs pass forbidden-field tests;
- concurrent join/leave/waitlist tests prove capacity and uniqueness invariants;
- failed, duplicated and out-of-order payment callbacks cannot produce a false paid state;
- every lifecycle/result transition is table-tested and illegal transitions have stable errors;
- all card states are represented in Figma, component stories and API fixtures by the same keys;
- web and mobile render the same fixture with the same primary status and allowed actions;
- result confirmation survives rating/Viva/notification outages without data loss;
- shadow comparison and migration reconciliation meet the agreed thresholds;
- OpenAPI, migrations, RLS, tests, `npm run check`, Compose validation and smoke checks are green;
- dashboards, alerts, runbooks, rollback and ownership documentation are complete.

### Managed FREE SELF LEAVE consumer (R1, default off)

`GAME_MANAGED_SELF_LEAVE_ENABLED=false` preserves existing NO_PAYMENT commands and blocks new
managed dispatch. Owner: R1 Core/Booking. Enable only after the compatible LK managed SELF owner
packet, canonical CUP compensation, authoritative profile/game mapping and provider acceptance
are separately approved. Review/remove this rollout flag when the bounded SELF return has accepted
production evidence; it is not a generic refund switch. Money, SPLIT, organizer CANCEL, late/NONE
returns and native allowlist activation remain outside this packet.

The bodyless DELETE `/games/:gameId/participants/me` may return 202/UNKNOWN. It freezes the exact
original participation → APPLIED evidence → confirmed reservation → eligibility snapshot and
managed FREE JOIN receipt, with actor/provider and legacy-game mapping provenance. Only that
backend-owned lineage can authorize the canonical owner SELF ingress. No provider IDs, usage
receipt or credentials enter the public response or browser storage. Owner requests use the frozen
`managed-self-leave-v1-contract.json`; an explicit actor delegation pins method/path, original
request/key digest, identity and mapping. Existing short-lived actor credentials are never persisted.

Migration0106 adds empty tenant-scoped `games.managed_self_leave_attempts` and concrete
`games.managed_self_leave_command_links`, both with tenant FKs and FORCE RLS. Integration order is
frozen CREATE0105 → SELF0106; this branch does not modify0105. The journal references the existing
legal IN_PROGRESS command envelope. Different keys observed for the same active participation
converge through FK-backed links; all linked actor/game/type commands complete atomically with the
original result. A new key without an active original participation is not evidence for a historical
return. Same-key and previously linked-key replay run before current membership lookup, so a later
rejoin cannot retarget the original operation. No parallel entitlement or money ledger is created.

A durable DISPATCH_STARTED fence precedes the first owner POST. Leases serialize foreground
attempts, but lease expiry never resets the fence. An explicit same-key DELETE first reads the
original owner operation, then may send only the original body with a fresh actor token and signed
`recovery_only:true`. Missing owner/canonical state remains UNKNOWN: a crash after the local fence
but before owner insertion has no automatic fresh-admission recovery. No background actor
impersonation, new quote, new reservation, refreshed entitlement proof or replacement key is allowed.
Revoked/changed current actor mapping denies further external action. Completed local receipts
remain readable by their original authenticated actor even after mapping drift or rejoin.

Only a strict matching owner receipt proving COMPENSATED/APPLIED/BOOKING_CANCELLED can finalize.
The transaction locks game → journal → original participation, validates every original binding
and receipt hash, changes exactly that ACTIVE PLAYER to LEFT, increments revision and writes the
existing audit/outbox/reopen/promotion effects. Any outbox or alias validation failure rolls back
all local changes. Historical paid JOIN evidence, CONFIRMED reservation, eligibility and snapshot
remain intact; CUP owns compensation. Replayed completion emits no events and does not touch the
new participation. A changed receipt is rejected even after completion.

GET `/game-operations/:operationId` checks this journal before ordinary operation lookup; GET
`/games/:gameId/leave-operation` resolves the original Idempotency-Key. Both are local read-only and
no-store: they never finalize or dispatch. A genuinely absent journal table (`to_regclass`) permits
old behavior during a default-off application rollout; database/authorization/corruption errors are
not treated as absence. Rollback disables new dispatch and retains both tables, links and receipts;
do not drop or rewrite unfinished attempts. Re-enable recovery only with the compatible owner.

Web keeps public account/game IDs and the original key under browser custody. UNKNOWN, offline and
404 readback never mean success or authorize a new key. Reload reads the saved key; manual retry
uses it; account replacement/unmount fences queued locks, pre-dispatch execution and response/storage updates. Stable-key SDK DELETE disables automatic transport/401 retry so it cannot reread a replacement account token; legacy callers without a supplied key retain their existing behavior. Existing native DELETE restrictions
remain unchanged. LOCAL fixtures and CI disposable PostgreSQL exercise these boundaries; neither
proves real provider cancellation/return, operational mapping freshness or production activation.

### SELF refusal recovery without a new cancellation

POST `/games/:gameId/leave-operation/reconcile` takes the original Idempotency-Key, no body or
query parameters. It never creates a managed attempt, selects a new membership for cancellation,
or calls the ordinary LEAVE writer. A separate route is required: older APIs ignore DELETE bodies;
an optional recovery marker on that route would permit an old process to dispatch a new leave.
An old API returns404 for the new route and Web retains custody. Existing direct/old-client DELETE
semantics remain unchanged; the restrictive retry guarantee applies to the updated Web/SDK path.
Native route support remains a separate companion dependency.

The existing command journal stores exact `GAME_SELF_LEAVE_NOT_DISPATCHED_V1` evidence in
FAILED.result_payload; no new migration is required. The same tenant/actor/key advisory lock and
game row lock serialize this proof against both managed begin and ordinary LEAVE. If recovery wins
before the first DELETE arrives, its FAILED command prevents that late request from dispatching.
If admission wins, recovery observes the original managed link/attempt and cannot manufacture a
refusal. PREPARED remains pending for its original caller; DISPATCH_STARTED may only use existing
owner read/recovery-only admission, never a new cancellation. Other unresolved attempts for the
actor/game also prevent certification. No provider/business call occurs for an absent command.

A historical generic FAILED is not proof. The only narrowly certifiable old case is exact
`game.leave.v1` / FAILED / GAME_PAYMENT_REQUIRED / NULL result / valid completed timestamp, with
exact tenant, actor, principal, game, key and request hash and no managed attempt or link in either
direction. All20 relevant source commits through59c1f0ee have only two distinct ordinary LEAVE
bodies: `71d1d86371f29d2537d124bb6984dc6d1e2ceff6e711857689dc5930e36582da` contains this refusal
before any participation write and no provider call; predecessor
`567d58e5ae970b770f742ea4b009c45ab3392bd77d95b0d617b9395860611d60` has no such refusal. The guard
was introduced at2c67620c. This certification preserves the original command ID, key/hash, code and
timestamps; it is not a generic legacy-state conversion. Unknown/corrupt scope, other refusal codes,
missing schema or ambiguous state remain unresolved. Direct edits/imports outside these canonical
writers do not gain authority from a matching error string.

Proof, audit and `audit.game_self_leave_not_dispatched.v1` outbox row commit atomically. The event
contains only command/user public IDs and uses the audit namespace: no roster, attendance or
notification fact is asserted. Current consumers use explicit bindings; in particular `game.#`
projection does not receive this control event. Proof replay emits no additional events and never
rebinds a later participation. Rollback retains the existing FAILED row: old writers replay its
original refusal, old clients conservatively keep their key, and no migration rollback is needed.

Read-by-key also recovers a canonical ordinary NO_PAYMENT success after lost response. A local
NO_PAYMENT lookup precedes external actor resolution; the ordinary writer rechecks mode under its
own lock. No Viva mapping is required to leave an ordinary local game. GET remains nonmutating.

Public NOT_DISPATCHED evidence contains only schemaVersion1, the fixed outcome and original key
SHA256, attached to a FAILED/LEAVE_GAME operation. It describes only this command, never current
attendance. Web persists custody before first HTTP, routes every existing-key retry to restrictive
reconciliation, and removes only matching custody after strict proof or original success. Generic
FAILED/404/409, offline, missing endpoint and malformed/foreign proof never clear it. A late response
cannot update a replaced account or key. Clearing a proven refusal refreshes the game and offers a
new explicit choice; it never automatically joins, leaves, chooses a replacement key or refreshes
and retries a mutation on401. A confirmed historical operation is not current membership evidence.

LOCAL tests and CI-only disposable PostgreSQL cover these transitions and rollback. No local DB
provisioning, provider calls or activation are part of this correction; provider/native/runtime
acceptance remains separate.
