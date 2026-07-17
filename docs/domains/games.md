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

## 2. Domain boundary and ownership

Games are `LOCAL_ONLY`: PostgreSQL is the source of truth for the game aggregate. Related domains
retain their own owners:

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

## 5. Server-owned card presentation

### 5.1 Why the card has a presentation contract

Web, mobile and Tilda must not reproduce precedence rules such as “payment required beats full
roster” or “finished without score beats completed”. The API/card projector returns a stable
`GameCardView` computed from one aggregate revision and the viewer relation.

### 5.2 Primary display states

| `displayState`          | User label            | Minimum condition                          | Typical action                      |
| ----------------------- | --------------------- | ------------------------------------------ | ----------------------------------- |
| `FINDING_PLAYERS`       | Ищем игроков          | scheduled, more than one open spot         | `JOIN` or `INVITE`                  |
| `ONE_SPOT_LEFT`         | Осталось 1 место      | scheduled, one open spot                   | `JOIN`                              |
| `ROSTER_READY`          | Состав набран         | scheduled, no open spots                   | `OPEN_DETAILS`                      |
| `SEAT_PAYMENT_REQUIRED` | Оплатите место        | viewer has an active unpaid reservation    | `PAY`                               |
| `STARTING_SOON`         | Скоро начало          | within server-configured window            | `OPEN_DETAILS`                      |
| `REGISTRATION_CLOSED`   | Регистрация закрыта   | join cut-off passed before game transition | `OPEN_DETAILS`                      |
| `IN_PROGRESS`           | Игра идёт             | lifecycle is in progress                   | `OPEN_CHAT`                         |
| `RESULT_REQUIRED`       | Внесите счёт          | finished, viewer may submit, no submission | `SUBMIT_RESULT`                     |
| `RESULT_PENDING`        | Счёт на подтверждении | result pending confirmation                | `CONFIRM_RESULT` or view            |
| `RESULT_DISPUTED`       | Результат оспорен     | dispute is open                            | `OPEN_DISPUTE`                      |
| `COMPLETED`             | Игра завершена        | confirmed or result not required by policy | `VIEW_RESULT`                       |
| `CANCELLED`             | Игра отменена         | lifecycle cancelled                        | refund/details action if applicable |

The primary display state is not the complete domain state. Secondary badges can show `Рейтинговая`,
`Закрытая`, `Лист ожидания`, `Возврат оформляется` or `Вы организатор` without changing the primary
state.

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
```

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

Commands carry only PadlHub UUIDs, expected revision and safe resource type. The service-only
Internal API accepts them with `Idempotency-Key`; it also exposes read-only event inspection for
correlation-based operations. It does not provide an HTTP event-ingestion route.

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
