# Commercial operation receipt read (B1)

Implemented routes:

- PadlHub: `GET /user/api/v1/{tenantKey}/booked-operations/{operationId}`.
- LK1 owner handler: `GET /lk/integrations/v1/booked-operations/{operationId}`.
- SDK consumer: `PadlHubApiClient.getBookedOperation(operationId)`.

The PadlHub route is registered, but the production entry point does not inject its
dedicated owner boundary. It returns `503 BOOKED_OPERATION_READ_DISABLED` until that
boundary is explicitly configured. This change activates no runtime, key, provider
write, migration or membership pilot.

## Authority

PadlHub authenticates the user JWT, checks `games.play` and tenant membership, and
resolves the exact active, unrotated session through the existing subscription actor
context repository. Only its synced `VIVA/viva_profile` mapping supplies the provider
actor. Body/query actor identifiers, phone associations and shared service tokens cannot
authorize this read.

The dedicated RS256 delegation uses the existing issuer implementation with a separate
scope `subscription-runtime.booked-operation.read`. It binds issuer, audience, caller
`lk2-api`, canonical subject, tenant UUID/key, session, provider mapping UUID/actor,
operation UUID, GET method, exact owner path and correlation ID. Its validity is 10–60
seconds. The owner uses explicitly supplied public keys and tenant bindings; it performs
no key discovery, provider request or nonce write. Repeated GET is allowed during that
short validity window. A quote delegation cannot authorize a read.

## Durable ownership and current blocker

The only owner collection read is `lk_subscription_daily_booking_ops`. The reader uses
exact tenant key + operation UUID + provider actor, majority read concern, a one-second
server limit and at most two rows. Zero/duplicate rows are indistinguishable 404s.
There is no existing unique operation UUID index; the reader never picks the first row.

Existing receipts prove a Viva actor but have caller-selected operation IDs. A UUID-shaped
legacy ID alone is insufficient. The reader additionally requires a durable owner-written
`padlHubOperation` association matching:

```text
contractVersion = 1
operationId, tenantId, userId, providerMappingId = canonical PadlHub UUIDs
issuer = trusted delegating issuer
caller = lk2-api
```

This association is a read admission requirement, not an existing populated field or a
migration delivered by B1. Synthetic positive fixtures include it explicitly. Current
legacy receipts without it remain default-deny; the reader never adds or backfills it.
Thus B1 is not accepted for current commercial traffic. B owns the canonical attempt
admission/association contract with the LK1 commercial receipt writer; L supplies the
coupled owner-writer handoff. A scoped lookup index and bounded receipt retention must be
reviewed by those owners before activation. No inference by phone, name, membership,
slot time or local game existence is allowed.

## Status and recovery

The strict response contains only `contractVersion`, canonical `operationId`, `status`,
`asOf` and `reason`. `asOf` comes from valid durable `updatedAt`, never the read clock;
there is no fabricated monotonic revision. Provider IDs and raw receipts stay internal.

- `PENDING / OWNER_PENDING`: owner preparation/confirmation is pending.
- `CONFIRMED / OWNER_BOOKING_CONFIRMED`: a durable booking confirmation with stable
  internal booking ID and confirmation timestamp exists, activation is complete or not
  required, and any managed entitlement operation is confirmed.
- `UNKNOWN / RECONCILIATION_REQUIRED`: partial, malformed, released, failed or otherwise
  uncertain state. An invalid durable timestamp gives `asOf: null`.

CONFIRMED is booking receipt evidence; it does not certify paid settlement or create a
game. Source PRECREATE states are treated conservatively, without claiming that they are
installed in the live owner flow. Absence of a local game, 404, timeout or DB failure must
preserve the caller's accepted attempt custody. None permits another create/purchase.
The SDK only issues GET and propagates failures; it has no creation fallback. The read
client has a timeout, no retries/redirects, bounded response size and a circuit breaker.

## Remaining B2/B3

B2 must establish a canonical actor-bound quote for the selected allowed slot with
expiry/revision. B3 must provide owner admission, durable canonical association, booking
and settlement recovery, and one LK2 Games writer for the resulting game. Those writes
and their activation are separate from this read. This change edits no shared legacy
POST router and performs no provider or live/shared data mutation.

## Checks

Owner regression: `node --test scripts/tests/bookedOperationRead.test.mjs` in LK1.
Consumer regression: the B1 route, adapter and SDK tests in LK2. Real loopback HTTP
tests use synthetic actor/receipt fixtures. Physical Mongo evidence is reported separately;
an in-memory collection or a synthetic binding is not proof of production identity.

## Server-owned admission

`POST /user/api/v1/{tenantKey}/booked-operation-admissions` is an additive, default-disabled
command requiring an active session, tenant membership, `games.play` and `Idempotency-Key`.
Its strict body contains only `JOIN_GAME`, target UUID/expected revision and `USE_SUBSCRIPTION`.
Actor and game provider mappings come from tenant-scoped PostgreSQL. The key is hashed and
scoped to the canonical tenant/user; the owner stores the immutable binding before returning
`202 PENDING`. A repeated key/body recovers the original receipt across session rotation and
mutable game lifecycle/revision drift; mapping ownership changes and conflicting bodies deny.
Initial target eligibility remains server-owned and is checked before any provider read/insert.

The LK1 delegation uses the separate `subscription-runtime.booked-operation.admit` scope and
binds method/path, request hash, target mapping/version, actor, tenant and correlation. The
SDK makes one writer attempt; a lost response is recovered only through the same key. A valid
receipt remains readable through B1 without any owner write attempt. A 503 or lost response
is not evidence that admission was rejected: the owner may already have saved PREPARED.
The SDK reports admission-only UNKNOWN recovery with an immutable copy of the same request
and idempotency key and `canStartNewPurchase=false`; it performs no automatic retry.
A caller retains that attempt and can explicitly recover with its original key/body under
the same authenticated principal. Neither an uncertain response nor admission-only PENDING
authorizes a fresh purchase, commercial JOIN or CREATE_GAME. Production `main.ts`
does not supply these optional dependencies, so the route stays disabled.

Admission means only an owner `PREPARED` operation with canonical association. Quote, booking,
settlement, entitlement and game projection are later boundaries and are excluded. No mobile
artifact or production activation is claimed. The isolated physical rehearsal additionally
covers real AuthService refresh/session, NOBYPASSRLS PG mappings, blocked-query timeout,
majority owner Mongo write/read, HTTP/SDK replay, lost ACK/response and exact no-write GET
snapshots. It is distinct from ordinary CI route/adapter/repository tests and live evidence.

## Paid JOIN receipt reconciliation

The internal LK2 commercial owner read negotiates `receipt_version: 1` in its signed read delegation.
Legacy reads retain exactly five response fields. Only the negotiated internal response may add a
strict receipt containing the original operation, tenant/user/game/reservation, provider actor,
provider subscription/exercise, actor/target mapping IDs, target version, admission request/key hashes,
stable booking ID and canonical verification time. Tokens, phone and raw provider bodies are forbidden.
The public operation response continues to expose only its safe commercial view.

Before reserving a seat, LK2 resolves and freezes the provider binding in the existing payment snapshot
JSON. The game owner locks the game and rechecks its exact mapping/version before the reservation;
its own revision bump cannot invalidate that original binding. LK1 delegates execution once, behind
the durable ATTEMPTING marker, to the canonical local `/lk/subscription-bookings` owner. That owner
retains user authentication, subscription ownership, exercise/category/date/daily limits, atomic
claims, managed policy/entitlement rechecks and the separate Admin service credential.

The negotiated read uses a second bounded Mongo FIND of the same owner collection, never a gateway
POST. Exactly one matching canonical CONFIRMED row must have a booking ID, confirmation timestamp,
completed/not-required activation and any managed entitlement confirmed. This recovers a gateway
commit followed by an outer timeout/crash without repeating a booking. Missing, duplicate, cancelled,
partial or mismatched evidence stays UNKNOWN and preserves attempt custody.

`POST /user/api/v1/{tenantKey}/game-operations/{operationId}/reconcile` requires the ordinary authenticated
tenant/session boundary and `Idempotency-Key: join-reconcile:{operationId}`. No receipt/actor/body fields
are accepted from the client. It loads the original actor-owned attempt, checks every receipt binding,
and invokes the existing CONFIRM_PAYMENT writer. That transaction rechecks the stored binding, exercise,
original command and reservation, derives the actor phone from `profile.user_summaries`, then atomically
stores evidence, confirms participation and completes the original paid command. Duplicate commands
replay; ambiguous evidence never releases a seat or invokes owner execution. GET remains read-only.
Paid SDK/Web recovery explicitly invokes this receipt command after recovering the original operation.

Activation still requires matching LK1/LK2 signing custody, fresh source/CI, immutable deployment,
no-write staging checks and a separate decision for any real booking/debit.
