# P2: open game with a confirmed court booking

Status: **BLOCKED** for commercial creation. Source increment implements honest beta UI and
recovery of an accepted operation. It does not book a court or debit a subscription.

Observed source: LK2 `origin/main` 34928e2f283ffe27d99643d046a10c0768bf0300 and read-only LK1
`origin/main` ed3ec14793f9cd779cf5022f7a3867a7a9e97487, refreshed on 2026-10-05.
No live/provider readback was performed. Source presence is not provider or deployment evidence.

## Current call graph and ownership

```text
LK2 /games/new (existing App route; P1 owns App.tsx)
  CreateGamePage -> auth-gateway.createGame -> PadlHubClient.createGame
  POST /user/api/v1/{tenantKey}/games [JWT tenant/sub, games.play, Idempotency-Key]
  registerGameRoutes -> GameRepository.create -> one PostgreSQL tenant transaction
  game + organizer participation + command receipt + audit + outbox
  NO_PAYMENT -> SCHEDULED; games.operations SUCCEEDED; booking_id stays null
  API managementOperationBody -> operation SUCCEEDED, game=null

Recovery: auth-gateway.getGameOperation -> SDK.getGameOperation
  GET /user/api/v1/{tenantKey}/game-operations/{operationId}
  GameRepository.getManagementOperation -> actor-scoped completed command receipt
```

The API rejects `SPLIT`, `SUBSCRIPTION`, `ORGANIZER_PAYS` with `GAME_PAYMENT_REQUIRED` before
persistence. A published location, test court grant or arbitrary future start/end is not a bookable
slot. The test-court path is explicitly private, friendly, NO_PAYMENT and grants no commercial proof.
The Games repository has provisioning placeholders for paid internal creation, but the worker
process manager handles only lifecycle start/finish and waitlist promotion. No completed commercial
create consumer or booking orchestration is wired by this increment.

Games owns its local aggregate. Bookings/Schedule owns court availability and provider booking,
initially VIVA_PRIMARY. Commerce/subscription owner owns settlement and debit. Integration alone
holds external references. Do not reuse the legacy Mongo create command as a second game writer.

LK1 has an existing commercial scenario, inspected at its refreshed main source:

```text
src/components/games/GamesPage.tsx
  revalidateSelectedSlotForPayment
  -> apiCreatePadelSplitGamePayment (src/utils/apiClient.ts)
  -> POST /lk/games/split/create
  -> fn_split_create_prepare.js -> fn_split_router.js (Node-RED owner L)
     authenticated profile / verified room / exact price / managed preflight
     -> Viva exercise creation -> booking -> subscription confirmation/readback
  -> confirmed split response
  -> browser apiCreatePadelGameRecord / apiCreatePadelGameDraft
     -> POST /lk/games or /lk/games/drafts -> legacy game persistence
```

Subscription split-create already uses a fixed `operationId`, managed reservation and bounded
same-operation pending polling. It distinguishes PENDING_CONFIRMATION and checks uncertain booking
creation by readback. One-time payment has a separate transaction/payment-required path and is
outside this increment. Split response contains private provider references and is not a PadlHub
User DTO. The browser still creates the legacy game record after booking/settlement; response loss
between those owners is not a durable LK2 game+booking operation. The repeated legacy POST is
explicitly not a read-only status endpoint: a missing operation can enter fresh admission.

The first proposed variant reuses the existing open friendly doubles game with the organizer's
subscription, subject to server-confirmed eligibility and returned debit count. This is a narrow
consumer target, not authority to enable it. No duration, subscription SKU, discount, tariff, daily
limit or operational court is selected or invented here. Singles, private/full-court payment,
invitations, cash/card fallback and all billing expansion are deferred.

## Owner status reported on 5 October

The leading chat confirms AU #349 source work complete/clean with no live writes; the existing
PadlHub user UUID remains authoritative. Verified contacts are not login bindings, no automatic
phone/email linking is permitted, reset does not issue a session and public recovery/sender is not
connected. P2 does not change or activate these paths.

L reports G1/G2 source acceptance still open for provider total units and cap parity, plus a
Patriots 50% intermediate live gap. These are additional prerequisites to connecting the proposed
subscription variant; this increment cannot treat those mechanisms as a safe finished booking
path. This owner status is supplied by the leading chat, not independently verified live by P2.

Follow-up finding: the connector review reports raw/hash JOIN duplication in roster comparison
and CONFLICT quarantine. P2 does not migrate/repair rosters, reset quarantine or infer that the
200-row read limit caused it. This remains a separate owner task.

## Exact contract request for owners L/C

The leading chat must forward this request; P2 sends no messages to other chats.

L (booking/subscription writer): expose or identify a reviewed server-to-server command over the
existing split-create machinery with these guarantees; do not ask a browser to relay private data:

1. Bind the authenticated PadlHub tenant/user and authorized caller to an exact verified provider
   actor. Never accept a phone, clientId, source, direction/type, amount or entitlement claim from
   the User API body. #347 session checks are prerequisites, not proof of a Viva actor link. #196
   remains default-off and is not opened here.
2. Return an actor-scoped, expiring server quote for one actually allowed slot, canonical station/
   court/slot UUIDs, exact start/end, quote revision, one permitted mode SUBSCRIPTION, an owned
   canonical subscription reference, server base amount/currency and debit count. Revalidate quote,
   eligibility and slot at admission. A schedule activity/recommendation is not this quote.
3. Accept only quote ID/revision plus server-verified principal and Idempotency-Key. Persist the
   operation before external writes, serialize slot admission and bind immutable request identity.
   Same key+payload recovers the same operation and resource IDs; changed payload returns
   IDEMPOTENCY_KEY_REUSED. Reserve neither a second slot nor a second debit on replay.
4. Provide a read-only operation read by PadlHub UUID with tenant+actor checks. After transport/5xx
   uncertainty retain PROCESSING/PENDING_CONFIRMATION, reconcile previous writes; never blindly
   resend provider POST. A missing status read, 404 or expired quote after acceptance does not
   authorize a new create. Confirmed booking and confirmed settlement must belong to the same
   operation, quote, slot and game; no success inferred from a redirect or absence of paymentUrl.
5. Return definitive SLOT_CONFLICT only when no ambiguous booking remains. Existing conflict
   exercise reuse needs an exact ownership/reconciliation proof before LK2 can attach to it.
   Do not attach another actor's exercise merely because time/court matches.
6. Keep provider references, private receipts, subscription identifiers, credentials and logs behind
   Integration. Public confirmed proof uses PadlHub booking and subscription-operation UUIDs,
   monotonic operation revision and confirmed timestamp. Choose explicit stable safe error codes.

C (legacy persistence/cutover owner): confirm the authoritative game writer for this route and the
exact import/association boundary. LK2 remains LOCAL_PRIMARY. Avoid browser-owned legacy record
creation after booking; provide a durable bridge/reconciliation guarantee that one confirmed
provider operation associates with one LK2 game and cannot create a second legacy/local aggregate.
If legacy persistence must remain owner, agree that cutover explicitly before implementation;
P2 cannot independently dual-write. Missing local game projection must remain recoverable by the
accepted operation, not by a fresh payment/booking request.

L/C must supply names and current callable contract for command/status/quote and precise actor
attestation, retention and conflict guarantees. P2 deliberately adds no guessed endpoint or runtime
role grant. Existing private LK1 bodies are not sent from native clients. Schema work, if needed,
requires separate migration ownership after AU #349; no migration is introduced here.

## Executable consumer proposal and acceptance

`packages/games/src/booked-game-consumer-contract.ts` contains strict quote/intent/operation schemas
for this single variant. It is not exported by the package, imported into production runtime or
advertised in OpenAPI/SDK. Names and safe errors are a proposal pending L/C agreement.
Its synthetic fixture demonstrates:

- intent excludes caller identity, price, provider and subscription selector;
- gameId alone, PENDING_CONFIRMATION, pending settlement and private provider IDs do not prove success;
- confirmed evidence must match exact operation, quote, slot and game;
- slot conflict cannot coexist with pending/confirmed booking;
- one explicitly expected failing characterization proves that the current beta API response
  cannot meet commercial acceptance. This expected failure is a blocker witness, not provider proof.

Actual User API tests characterize all paid modes rejected before persistence, JWT-derived actor
and absence of booking proof. Existing API/repository recovery suites exercise repeated keys,
changed intent, concurrent creates and replay after response loss. New UI/ledger tests exercise
accepted operation persistence/reopen, GET-only recovery, 404/network/unrelated operation and no
false success. The future slot-conflict fixture is not an implemented provider conflict test.

## Source increment behavior and rollback

The commercial panel says creation with booking is unavailable. The existing beta form remains
explicitly NO_PAYMENT. Only validated CREATE_GAME/SUCCEEDED with a canonical game ID, positive
aggregate revision and no payment next action resolves that beta attempt. It grants no booking.

ACCEPTED/PROCESSING/FAILED response IDs are persisted under the original tenant/user/key. Reopening
reads the same operation automatically. A manual check also uses GET only. A read failure keeps
UNKNOWN and the original attempt. Lost create responses without an operation ID reuse the existing
key/payload via the already implemented SDK retry and manual replay. No fresh key is minted to
recover an accepted operation.

Browser ledger v4 keeps the existing storage/lock key and reads v3 pending/resolved entries without
changing their key. Old tabs fail closed on v4. No secret or provider receipt is persisted. Source
rollback to a v3 client therefore fails closed on v4 until forward recovery; do not clear local
storage to bypass accepted-operation custody. Cross-device restoration without local state remains
blocked on an actor-scoped durable server operation lookup/retention contract.

## Native contract inventory for 6 October

| Current SDK / OpenAPI method                                                                 | Route                                | Allowed meaning                                                          |
| -------------------------------------------------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------ |
| `listLocations`                                                                              | existing User locations catalog      | presentation; no bookable slot or price                                  |
| `listGameTestCourts`                                                                         | GET `/games/test-courts`             | actor-granted private NO_PAYMENT test courts only                        |
| `createGame`                                                                                 | POST `/games`                        | beta local creation; caller must persist one Idempotency-Key before send |
| `getGameOperation`                                                                           | GET `/game-operations/{operationId}` | actor-scoped beta command receipt; recover accepted operation by GET     |
| `getGame`                                                                                    | GET `/games/{gameId}`                | viewer card; gameId/card is not booking confirmation                     |
| `getUpcomingBookings`                                                                        | GET `/bookings/upcoming`             | read projection; not commercial command or settlement authority          |
| `startBookingScreenReadJob`, `submitBookingScreenReadResult`, `completeBookingScreenReadJob` | existing booking-screen read jobs    | bounded read relay; not a bookable quote and not a write permission      |

Missing, not callable/adopted methods: **allowed-slot/quote**, **create booked open game**,
**authoritative booking+settlement operation read/reconciliation** and **operation discovery after
local state loss**. No speculative methods are added to SDK/OpenAPI. Native should implement only
the honest beta/recovery contract until these are agreed and tested. P1 needs no new App.tsx route;
`/games/new` already hosts the changed component.

LOCAL source/fixture/component evidence cannot complete commercial creation. Full closure still
requires an agreed owner adapter, synthetic staging concurrency/recovery proof, provider evidence,
and native device/build evidence, each separately reported. No merge, activation, deployment,
shared DB write, payment or provider call is authorized by this document.

## Implementation evidence

MODEL_ROUTE: parent — R3/CRITICAL recovery boundary; one read-only recovery specialist.

- LOCAL `npm ci` and `npm run contracts:generate` completed without lockfile changes.
- LOCAL focused initial suite: 74 passed plus one deliberately expected failing blocker witness.
  After custody/form fixes: 52 UI/ledger tests passed. Final identifier-guard/component suite: 5 passed.
- LOCAL final `NODE_OPTIONS=--no-experimental-webstorage npm run check`: format, lint, all workspace
  typechecks, OpenAPI lint, all workspace builds and runtime imports passed. Test phase was stopped
  after the leading chat reported ENOSPC and prohibited heavy runs until capacity recovered.
  An earlier full test attempt also could not complete under disk pressure. No full LOCAL pass is
  claimed. Node 26.8.2 requires the standard webstorage-disable flag for existing jsdom storage
  tests; no toolchain pin, source guard or assertion was weakened.
- LOCAL specialist source review approved after form recovery, malformed identifiers and cross-tab
  accepted-operation custody fixes. Diff whitespace check passed.
- Docker Desktop socket is absent; disposable DB/Compose preview and local Docker gitleaks are
  unavailable. Only task-generated sourcemaps were removed to recover space. No foreign cleanup.
- Browser fixture built from this source with synthetic gateway, but rendered QA remains unverified:
  Playwright CLI registry access failed, and Browser Use blocks file://. No alternate surface or
  server was used to work around that policy. Component tests are not rendered browser proof.
- CI belongs to the Draft PR exact-head run. STAGING, PROVIDER, PRODUCTION, native APK/device,
  physical PostgreSQL and provider slot-conflict evidence were not performed by P2.

All source fixtures are synthetic. No real booking, charge, provider request, live/shared mutation,
merge, schema migration, permission widening, image publication or deploy occurred.
