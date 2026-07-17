# Games module rebuild plan

Status: working plan
Date: 2026-07-18
Architecture: [Games domain](../domains/games.md) and [ADR 0010](../adr/0010-games-domain-and-card-state-model.md)

## Implementation progress

The first Phase 1 slice started on 2026-07-17 after the implementation go-ahead.

| Slice                     | State       | Evidence                                                                 | Remaining before the gate                                               |
| ------------------------- | ----------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| Pure domain kernel        | Implemented | `@phub/games`; 83 domain and contract policy tests                       | product review of policies; result/cancellation authorization policy    |
| Public discovery contract | In progress | safe list/detail, bound cursor, PG/load and staging-mode HTTP evidence   | card UI, visual/accessibility QA and production runtime gate            |
| User API contract         | In progress | viewer list/detail plus four roster handlers and durable operation reads | create/publish/cancel/result handlers and Commerce next-action wiring   |
| Internal event contract   | Implemented | 19 events, 6 commands, 8 consumer routes and generated Internal types    | broker/outbox/inbox runtime integration and replay tests                |
| Database foundation       | In progress | forced RLS, atomic writes, clean PG projector and 10k-card load evidence | result command repository and backup/restore rehearsal                  |
| Roster command slice      | Implemented | join/reserve/waitlist/leave/expiry/promotion, User API and PG races      | Commerce confirmation adapter, card refresh and production runtime gate |
| Projector and scheduler   | In progress | atomic inbox projector, monotonic cards and clean PG replay evidence     | lifecycle command handlers and production runtime gate                  |

The persistence, roster and read foundations are runnable and verified on clean PostgreSQL. The
read load gate passed with 10,000 cards, 20 concurrent callers and a 200 ms local p95 target, and a
staging-mode HTTP process returned the safe public DTO. This is still not Gate P2/P3: Commerce
confirmation, remaining commands, card UI/visual QA, lifecycle handlers, backup/restore evidence
and an immutable staging image promotion remain.

## 1. Target outcome

We will preserve validated product behavior, not legacy implementation details. The result is a
PadlHub-owned module in which:

- discovery, create, join, leave, waitlist, payment and result flows use stable PadlHub APIs;
- PostgreSQL owns game state;
- external booking/payment work is durable and recoverable;
- one server-derived card contract renders consistently in web, mobile and Tilda;
- every visual state has a Figma variant, code story, API fixture and automated test;
- migration can be cut over by tenant/operation without independent dual-write.

## 2. Team

The minimum delivery team is seven active functions. One person may cover two functions, but every
responsibility must have an explicit owner.

| Function                         | Responsibility                                                       | Required decisions/deliverables            |
| -------------------------------- | -------------------------------------------------------------------- | ------------------------------------------ |
| Product owner                    | business rules, priorities, cancellation/payment/result policy       | signed lifecycle and acceptance matrix     |
| UX/UI and design-system owner    | card family, interaction states, tokens and Figma variants           | component set and state-node matrix        |
| Games tech lead/domain architect | aggregate, invariants, API/events and migration ownership            | ADR, domain contract and technical reviews |
| Backend/integration engineers    | API, PostgreSQL, process manager, Viva/Commerce/Rating ports         | tested vertical slices and reconciliation  |
| Frontend engineer                | shared components, SDK integration, web/mobile surfaces              | reusable cards and end-to-end flows        |
| QA automation                    | contract, domain, component, integration, E2E and migration evidence | traceable test plan and release verdict    |
| Platform/SRE                     | CI, migrations, observability, feature gates, staging and rollback   | dashboards, runbooks and rollout controls  |

For a smaller team, the tech lead may own backend architecture, Platform may own integration
operations and Product may partner directly with Design. QA independence at release gate is still
required.

## 3. Working rules

1. No feature coding begins before its state, command, error codes and acceptance examples are
   agreed.
2. OpenAPI and domain tests precede client integration.
3. One vertical slice is completed end to end before broad page construction.
4. No generic game PATCH, independent dual-write or browser-confirmed payment is accepted.
5. Every feature flag has an owner, expiry/removal task, metric and rollback behavior.
6. Every phase ends with a demonstrable artifact and a gate; “code mostly ready” is not a gate.
7. Legacy behavior is preserved only when product confirms it is intentional.

## 4. Delivery sequence

### Phase 0 — baseline and product contract

Goal: turn the working LK behavior and Figma into an explicit approved specification.

Tasks:

- inventory discovery, create, join, leave, split payment, waitlist, cancellation, result and chat
  flows from the current LK;
- capture happy paths, known incidents and intentional exceptions as executable examples;
- agree lifecycle, roster, viewer, payment and result axes;
- agree display-state precedence and primary CTA for every viewer role;
- obtain frame-specific Figma links and inspect-capable access;
- build the Figma node ↔ `displayState` ↔ fixture matrix;
- approve retention/migration scope for upcoming and historical games;
- set initial performance, freshness and rollout SLOs.

Outputs:

- approved state/transition table;
- approved card matrix;
- legacy behavior inventory with keep/change/drop decisions;
- migration population definition;
- test traceability skeleton.

Gate P0:

- Product, Design, Architecture and QA sign the same state vocabulary;
- there are no unnamed or “other” UI statuses;
- every critical current flow has at least one acceptance example.

### Phase 1 — contracts and domain kernel

Goal: make invalid game state unrepresentable before adding infrastructure.

Tasks:

- add canonical game schemas to User/Public/Internal OpenAPI;
- define stable errors, idempotency and operation resources;
- implement pure TypeScript state transitions and card policy in `@phub/games`;
- define command/event payloads and forbidden-field rules;
- generate SDK types and fixtures;
- add architecture and threat-model review.

Outputs:

- `@phub/games` package with no HTTP/database dependencies;
- linted OpenAPI and generated SDK;
- table-driven transition and card-state tests;
- reviewed event catalog.

Gate P1:

- 100% transition table coverage;
- illegal transitions return stable domain errors;
- public fixtures contain no private/provider fields;
- contract generation is deterministic.

### Phase 2 — persistence and command foundation

Goal: provide tenant-safe, concurrency-safe canonical storage.

Tasks:

- add expand-only `games` migrations, constraints and indexes;
- add forced RLS and tenant-aware foreign keys;
- implement repository with aggregate revision and row locking;
- implement shared idempotency/audit/outbox transaction boundary;
- add internal projector and scheduled transition job;
- add card projection query with keyset pagination.

Outputs:

- migration and rollback-compatible release notes;
- repositories and process-manager skeleton;
- queryable synthetic card projection.

Gate P2:

- RLS isolation tests pass for two tenants;
- duplicate command replay returns the original result;
- concurrency tests cannot exceed capacity or duplicate membership;
- migration check and backup/restore rehearsal pass.

### Phase 3 — first vertical slice: discovery and cards

Goal: deliver the reusable read surface before risky commands.

Tasks:

- implement safe public and authenticated list/detail reads;
- build `GameCard` primitives in `@phub/ui`;
- create Storybook/test harness stories for every display state and surface;
- implement Discover page using cursor pagination;
- implement loading, empty, error, unavailable and stale-projection states;
- map home quick action to the new route behind a read-only feature gate;
- run accessibility and visual comparison against Figma.

Outputs:

- read-only discover flow on synthetic/local data;
- reusable cards in web and mobile;
- visual regression baseline.

Gate P3:

- API and component use the same fixtures/state keys;
- web/mobile status, badges and actions match for each fixture;
- public forbidden-field security test passes;
- keyboard, screen-reader, contrast and touch-target checks pass;
- agreed list latency/load target passes.

### Phase 4 — create/provision/payment saga

Goal: create a valid game without client-side source selection or false payment success.

Tasks:

- implement create command and `PROVISIONING` operation;
- implement Bookings port and Viva adapter behavior using mock/sandbox first;
- implement organizer payment obligation through Commerce;
- implement provider webhook verification, replay protection and reconciliation;
- implement operation progress UI and retry-safe recovery;
- implement failure compensation and cancellation audit;
- project scheduled games into cards/Home/Messaging/Notifications.

Outputs:

- end-to-end create flow on staging sandbox;
- durable operation and provider journal;
- reconciliation dashboard and runbook.

Gate P4:

- browser return URL alone can never set `PAID`;
- duplicate/out-of-order webhooks produce one terminal result;
- booking timeout, payment failure and worker restart are recoverable;
- no orphan public game is produced after failed provisioning.

### Phase 5 — join, leave and waitlist

Goal: make participation atomic under concurrency and payment failure.

Tasks:

- implement join command and expiring seat reservation;
- implement verified split-payment conversion to participation;
- implement leave, waitlist join/leave and promotion policy;
- implement organizer/participant cancellation and refunds as separate policies;
- update Messaging membership and Notifications from events;
- implement server-provided allowed actions in clients.

Outputs:

- concurrency-safe roster lifecycle;
- visible waitlist/payment states on reusable cards;
- operator inspection tools in CUP/Internal API.

Gate P5:

- 100 simultaneous join attempts never exceed capacity;
- failed/expired payment releases exactly one seat;
- waitlist order and promotion are deterministic;
- forged identity and cross-tenant requests fail closed;
- cancellation, unpublish and player removal remain distinct commands.

### Phase 6 — play, result, rating and history

Goal: complete the lifecycle without holding the user on external calculations.

Tasks:

- implement scheduled start/finish transitions;
- implement durable result submission, confirmation and dispute;
- write confirmed result and rating outbox atomically;
- implement Rating, Home and Notification consumers;
- implement history/result card states;
- add repair/replay tooling with dry-run and apply gates.

Outputs:

- end-to-end result lifecycle;
- history cards for pending, disputed and confirmed results;
- reconciliation/repair runbook.

Gate P6:

- confirmed result survives Rating/Viva/notification outage;
- repeated submit/confirm produces no duplicate result or rating fact;
- disputed result cannot update canonical rating;
- projection replay restores history cards from canonical state.

### Phase 7 — migration and shadow comparison

Goal: move production behavior without dual-write or a big-bang switch.

Tasks:

- map legacy records to PadlHub UUIDs in integration storage;
- import the approved upcoming/history population through an idempotent migrator;
- shadow-compare public list, detail, viewer relation and card state;
- classify differences as mapping, freshness, intentional rule change or defect;
- switch read surfaces first;
- switch each command owner by tenant/operation only after its gate;
- seal matching legacy command routes at cutover;
- monitor, reconcile and remove temporary flags/adapters.

Outputs:

- migration report and unresolved-difference register;
- signed cutover/rollback checklist;
- production dashboards and post-cutover evidence.

Gate P7:

- migration is repeatable and checksum/idempotency safe;
- semantic shadow match meets the approved threshold;
- zero P0/P1 security/payment/capacity mismatch remains;
- rollback before write cutover is tested;
- after write cutover, the forward-recovery plan is tested and no legacy dual-write exists.

### Phase 8 — cleanup and ownership transfer

Goal: leave a maintainable product, not a permanent migration layer.

Tasks:

- delete dead card/game implementations and expired feature flags;
- remove legacy read bridges after retention/grace periods;
- finalize support/CUP procedures and SLO ownership;
- run game-day incident exercises;
- archive migration-only dashboards and documentation.

Gate P8:

- one active implementation per rule and one public contract per surface;
- on-call can diagnose create/join/payment/result incidents from correlation ID;
- Product, Support, QA and Engineering accept operational ownership.

## 5. Task backlog by workstream

| ID          | Owner                | Task                                           | Result                   | Primary verification            |
| ----------- | -------------------- | ---------------------------------------------- | ------------------------ | ------------------------------- |
| G-PROD-01   | Product              | approve state vocabulary and action precedence | signed state matrix      | example review                  |
| G-DES-01    | Design               | normalize Figma `GameCard` component set       | node-state matrix        | design QA                       |
| G-ARC-01    | Tech lead            | accept ADR 0010 and public API boundary        | architecture decision    | ADR review                      |
| G-DOM-01    | Backend              | create `@phub/games` kernel                    | pure domain rules        | unit/property tests             |
| G-API-01    | Backend              | add User/Public/Internal OpenAPI               | generated typed contract | Redocly + contract tests        |
| G-DB-01     | Backend/DB           | add schema, RLS, constraints and indexes       | canonical storage        | migration/RLS/concurrency tests |
| G-READ-01   | Backend              | implement card projector and cursor queries    | versioned card reads     | query/load tests                |
| G-UI-01     | Frontend             | build reusable card primitives                 | one card family          | stories, a11y, visual tests     |
| G-CREATE-01 | Backend/Integration  | build create process manager                   | durable provisioning     | sandbox failure matrix          |
| G-PAY-01    | Commerce/Integration | verify webhook/reconciliation                  | authoritative payments   | replay/order tests              |
| G-JOIN-01   | Backend              | atomic participation commands                  | no lost updates          | high-concurrency tests          |
| G-RESULT-01 | Backend/Rating       | durable result and outbox                      | repairable result flow   | outage/replay tests             |
| G-MIG-01    | Data                 | idempotent legacy import and mapping           | PadlHub UUID migration   | checksum/shadow tests           |
| G-OPS-01    | SRE                  | dashboards, alerts, runbooks and flags         | operable rollout         | staging game day                |
| G-QA-01     | QA                   | trace requirements to automated evidence       | release verdict          | test report                     |

## 6. Test strategy

### Domain unit and property tests

- every legal and illegal lifecycle transition;
- card display-state precedence across lifecycle/roster/viewer/payment/result axes;
- capacity, unique participation, seat expiry and deterministic waitlist order;
- cancellation and result authorization policies;
- idempotent command replay and revision conflicts;
- time boundaries in the tenant timezone.

### Database tests

- forced RLS and cross-tenant denial;
- tenant-aware foreign keys and unique partial indexes;
- concurrent join/leave/reservation transactions;
- outbox/audit atomicity;
- expand migration from the previous release and application rollback compatibility.

### Contract and security tests

- OpenAPI lint/generation and request/response validation;
- all critical commands require JWT, tenant, correlation and idempotency;
- forged phone/client/provider identifiers cannot select another user;
- public DTO forbidden-field snapshot;
- admin/internal JWT audience separation;
- invite-token expiry, replay, revocation and log redaction.

### Integration tests

- Viva booking success, timeout, retryable/non-retryable failure and circuit open;
- payment webhook signature, duplicate, out-of-order, failed, expired and refund paths;
- worker crash between every process-manager step;
- outbox redelivery and consumer inbox deduplication;
- Rating/Messaging/Notifications outage and later replay.

### UI tests

- one story per `surface × displayState` that is product-valid;
- zero through capacity participants and long names/stations;
- primary/secondary action priority;
- skeleton, empty, error, offline/stale and unavailable states;
- 360, 390, tablet and desktop layouts;
- keyboard navigation, screen-reader labels, focus order, contrast and touch targets;
- visual regression against approved Figma frames.

### End-to-end journeys

1. Discover → authenticate → join → pay → participant card.
2. Create → book → pay → publish → invite.
3. Last place race between two users.
4. Failed/expired split payment → seat release → waitlist promotion.
5. Participant leaves; organizer cancels; refund progresses.
6. Game finishes → submit → confirm → rating/history update.
7. Result dispute → no rating → resolution/replay.
8. Viva/provider outage with later recovery.

### Migration and operational tests

- repeat import produces the same UUIDs/checksums and no duplicate rows;
- shadow semantic comparison by state/card fields;
- backup, migration, sequential rollout, health/readiness and smoke;
- feature-gate rollback before command cutover;
- forward recovery after command cutover;
- alert and runbook game-day exercises.

## 7. Preliminary non-functional targets

These are starting targets to approve in Phase 0, not hidden implementation assumptions.

- public card list p95 ≤ 300 ms at the agreed production-like data volume;
- local command commit p95 ≤ 500 ms, excluding asynchronous provider completion;
- card projection normally visible within 5 seconds and alerting before 30 seconds;
- no capacity violation or lost update under the agreed concurrent-join load;
- zero PII/provider-ID findings in public responses and broker events;
- zero false `PAID` transitions in the payment fault matrix;
- 100% traceability from critical invariant to automated test and release evidence.

## 8. Release evidence checklist

Each release candidate must include:

- OpenAPI diff and generated SDK diff;
- migration compatibility report;
- domain/contract/security/concurrency test report;
- Figma visual comparison and accessibility report;
- provider sandbox matrix;
- shadow comparison report where applicable;
- image digest, staging smoke and correlation IDs;
- dashboard screenshots/links and alert status;
- backup verification, approval, rollout and rollback/forward-recovery record;
- confirmation that `npm run check` and relevant `docker compose config` checks pass.

## 9. Immediate next actions

1. Product reviews and accepts or edits the implemented state/action policy in `@phub/games` and
   `docs/domains/games.md`.
2. Backend adds the expand-only PostgreSQL/RLS foundation, repositories, idempotency, audit and
   outbox transaction boundary.
3. Backend implements the card projection tables and keyset reads after canonical writes are safe.
4. Design provides exact Figma frame links for every card state and grants inspect-capable access to
   the connected account (`s9104303190@gmail.com`), or exports the component specification.
5. QA maps the 80 current domain/contract tests to the legacy behavior/incident
   acceptance inventory.
6. Frontend starts card implementation only after the Figma node-state matrix and public fixtures
   are complete.
