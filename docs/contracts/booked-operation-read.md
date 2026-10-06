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
