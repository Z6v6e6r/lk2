# Residency order consumer contract (LK2 server → LK1 owner)

Status: server consumer implemented behind `RESIDENCY_ORDER_ENABLED=false`. Source of truth for
the DTOs is the owner contract in [Z6v6e6r/lk#443](https://github.com/Z6v6e6r/lk/pull/443)
(`residency-lifecycle.v2`, `docs/residency-lifecycle.md`). The web client contract is
`docs/contracts/residency-purchase.md` (owned by the web/SDK task). This document only fixes
the server boundary and the exact request/response surface the cabinet may rely on.

## Routes and headers

Prefix `/user/api/v1/{tenantKey}`; PadlHub JWT; `Cache-Control: private, no-store`.

| Method | Path                                    | Body                                               | Idempotency-Key |
| ------ | --------------------------------------- | -------------------------------------------------- | --------------- |
| GET    | `/residency/catalog`                    | —                                                  | —               |
| GET    | `/residency/orders?state=unresolved`    | —                                                  | —               |
| POST   | `/residency/orders`                     | `{ mode, expectedTotalMinor, expectedProductId? }` | required        |
| GET    | `/residency/orders/{orderId}`           | —                                                  | —               |
| GET    | `/residency/orders/{orderId}/payment`   | —                                                  | —               |
| POST   | `/residency/orders/{orderId}/reconcile` | `{ eventId? }`                                     | required        |
| POST   | `/residency/orders/{orderId}/cancel`    | —                                                  | required        |

`Idempotency-Key`: 16..128 printable ASCII characters, no spaces. The value is forwarded to the
owner unchanged.

## Request additions over v1 (must be sent by the web client)

```json
POST /residency/orders
{
  "mode": "NEW",
  "expectedTotalMinor": 79000,
  "expectedProductId": "4037a3a3-e551-4f9a-a9db-1410e46b8635"
}
```

`expectedTotalMinor` is **mandatory** and is the **exact** total the user saw in the catalog. The
owner refuses a missing/non-positive value (400 `RESIDENCY_PRICE_CONSENT_REQUIRED`) and any
mismatch — lower **or higher** — or another product (409 `RESIDENCY_PRICE_CHANGED` with
`details`) before any durable order or provider POST. An exact match is required; "not more than
the confirmed amount" is not the contract. `expectedProductId` is optional and defaults to the
configured product. If CUP ever returns a quote-time discount that the catalog did not publish,
the create is refused rather than silently charging a different total; the catalog must expose the
same total/discount before that path can be purchased.

### Compatibility: this is a breaking create change for the previous client

`schemaVersion: 1` describes the response DTO and does not make the old request compatible. The
web/SDK head that sends only `{ "mode": "NEW" }` gets 400 `RESIDENCY_PRICE_CONSENT_REQUIRED` before
the owner's idempotency lookup; it creates nothing and cannot replay an existing order. The required
field must be added by the web/SDK PR (#682), which is a separate task; this consumer already
requires it.

Orders created by the previous owner head (`adc9c644`, no `consent`, old request hash) stay
durable and recoverable, but they are not replayable: mode-only is 400, and a new-format request
with the same key is 409 `RESIDENCY_IDEMPOTENCY_CONFLICT`. Use
`GET /residency/orders?state=unresolved`, then read/reconcile that order; do not mint a new key.

## Response additions

All v1 fields stay. The following fields are additive and are parsed by the cabinet:

- `order.recovery`: `{ state, required, reason, action, retryable, since }` with states
  `NONE | AWAITING_PAYMENT | AWAITING_CONFIRMATION | UNKNOWN_OUTCOME | ACTIVATION_PENDING |
REVIEW_REQUIRED | TERMINAL` and actions `NONE | PAY | RETRY_RECONCILE | CONTACT_SUPPORT |
START_NEW_ORDER`.
- `order.consent`: `{ expectedTotalMinor, productId, acceptedAt }` or `null`.
- `order.renewal`: `{ baseValidUntil, minimumValidUntil }` or `null` (mode `RENEWAL` only).
- `order.terminal`, `order.terminalReason`.
- `order.payment.overdue` and `order.payment.instruction`.
- `catalog.renewal`: `{ eligible, reason, eligibleAt, currentValidUntil, expected: { termDays,
startsAt: "PAYMENT_DATE", earliestValidUntil } }`; `catalog.renewalEligible` mirrors
  `renewal.eligible`.
- `payment` endpoint: same normalized `paymentStatus` vocabulary as the order plus `overdue`,
  `recovery`, `terminal`, `terminalReason`. `DISPATCHING` is never returned.
- Create/reconcile/cancel envelope: `{ schemaVersion, order, idempotentReplay, recovery,
recoveryRequired?, retryable?, reviewRequired? }`.

## Error codes (stable)

Owner codes pass through with their HTTP status: `RESIDENCY_PRICE_CONSENT_REQUIRED` (400),
`RESIDENCY_IDEMPOTENCY_KEY_REQUIRED` (400), `RESIDENCY_REQUEST_INVALID` (400),
`RESIDENCY_MODE_INVALID` (400), `RESIDENCY_PRICE_CHANGED` (409),
`RESIDENCY_RENEWAL_TOO_EARLY` (409), `RESIDENCY_RENEWAL_REQUIRED` (409),
`RESIDENCY_RENEWAL_NOT_ELIGIBLE` (409), `RESIDENCY_ORDER_ALREADY_PENDING` (409),
`RESIDENCY_IDEMPOTENCY_CONFLICT` (409), `RESIDENCY_ORDER_PAID` (409),
`RESIDENCY_ORDER_ACTIVE` (409), `RESIDENCY_ORDER_NOT_CANCELLABLE` (409),
`RESIDENCY_PAYMENT_STATUS_UNKNOWN` (409), `RESIDENCY_ORDER_NOT_FOUND` (404).

Consumer codes: `RESIDENCY_ORDERS_DISABLED` (503), `RESIDENCY_OWNER_UNAVAILABLE` (503),
`RESIDENCY_OWNER_CONFIGURATION_INVALID` (503, `details.ownerCode`; an owner-side
configuration refusal such as an unconfigured return target is an availability failure, not a
client error),
`RESIDENCY_OWNER_RESPONSE_INVALID` (503), `RESIDENCY_PRODUCT_NOT_CONFIGURED` (503),
`RESIDENCY_PRODUCT_CONFIG_MISMATCH` (503), `RESIDENCY_TENANT_NOT_SUPPORTED` (503),
`RESIDENCY_REAUTH_REQUIRED` (409), `RESIDENCY_REAUTH_UNAVAILABLE` (503),
`RESIDENCY_PERMISSION_REQUIRED` (403), `AUTH_REQUIRED` (401),
`AUTH_SESSION_REVOKED` (401).

Error body: `{ code, message, correlationId, details? }`.

## Create error table (order, key and recovery)

"Before lookup" means the owner checks the request before `findOrderByKey`; such an answer does
not prove that no earlier order exists for the key. "After lookup" means the key was looked up and
no order with that key existed at that moment; a concurrent request can still race. "After insert"
means the durable order exists before the provider POST.

| Result (HTTP)                                                                                                                                                                                                                                                                                                                      | Decided                                              | Order created by this request?              | Earlier operation can exist?                                                                         | Client key                 | Required recovery                                                                     |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------- |
| 400 `RESIDENCY_PRICE_CONSENT_REQUIRED`                                                                                                                                                                                                                                                                                             | consumer parse, then owner before lookup             | no                                          | **yes** — mode-only retry or an old-format order                                                     | keep                       | `GET /residency/orders?state=unresolved` if an earlier attempt may exist              |
| 409 `RESIDENCY_PRICE_CHANGED` (product)                                                                                                                                                                                                                                                                                            | owner before lookup                                  | no                                          | **yes**                                                                                              | keep                       | unresolved lookup / correct product                                                   |
| 400 `RESIDENCY_MODE_INVALID`, `RESIDENCY_REQUEST_INVALID`, `RESIDENCY_RETURN_TARGET_INVALID`, `RESIDENCY_IDEMPOTENCY_KEY_REQUIRED`                                                                                                                                                                                                 | consumer/owner before lookup                         | no                                          | **yes**                                                                                              | keep a valid key           | unresolved lookup if the key may have been used                                       |
| 401 `AUTH_REQUIRED` / 403 `RESIDENCY_PERMISSION_REQUIRED`                                                                                                                                                                                                                                                                          | consumer before the owner                            | no                                          | **yes**                                                                                              | keep                       | authenticate / grant the `client` role, repeat the same key                           |
| 409 `RESIDENCY_REAUTH_REQUIRED`, 503 `RESIDENCY_REAUTH_UNAVAILABLE`                                                                                                                                                                                                                                                                | consumer before the owner                            | no                                          | **yes**                                                                                              | keep                       | fresh Viva delegation, repeat the same key                                            |
| 409 `RESIDENCY_IDEMPOTENCY_CONFLICT`                                                                                                                                                                                                                                                                                               | owner after lookup; the key already maps to an order | no new order                                | **yes** — that key's order                                                                           | keep                       | replay the original body, or unresolved lookup                                        |
| 409 `RESIDENCY_ORDER_ALREADY_PENDING`                                                                                                                                                                                                                                                                                              | owner after lookup, before insert                    | no                                          | **yes** — another unresolved order                                                                   | discard this attempt's key | `GET /residency/orders?state=unresolved`; never mint a new key                        |
| 503 `RESIDENCY_OWNER_CONFIGURATION_INVALID` with `details.ownerCode` = `RESIDENCY_RETURN_TARGET_INVALID` (before lookup) or `RESIDENCY_STATUS_UNAVAILABLE`, `RESIDENCY_CATALOG_UNAVAILABLE`, `RESIDENCY_PRICING_UNAVAILABLE`, `RESIDENCY_PRODUCT_TERMS_MISMATCH`, `RESIDENCY_PRODUCT_NOT_CONFIGURED` (after lookup, before insert) | owner; consumer maps it                              | no                                          | **yes** for the pre-lookup return-target refusal; no for this key at lookup for the post-lookup ones | keep                       | retry after configuration/source recovers; unresolved lookup if the response was lost |
| 409 `RESIDENCY_RENEWAL_NOT_ELIGIBLE`, `RESIDENCY_RENEWAL_REQUIRED`, `RESIDENCY_RENEWAL_TOO_EARLY`                                                                                                                                                                                                                                  | owner after lookup, before insert                    | no                                          | no for this key at lookup                                                                            | may discard                | refresh status/catalog; show `details.eligibleAt`                                     |
| 503 `RESIDENCY_PRICING_INVALID`, `RESIDENCY_UPSTREAM_TIMEOUT`, `RESIDENCY_UPSTREAM_UNAVAILABLE`, `RESIDENCY_UPSTREAM_INVALID`                                                                                                                                                                                                      | owner after lookup, before insert                    | no                                          | no for this key at lookup                                                                            | may discard                | retry after the quote/upstream recovers                                               |
| 409 `RESIDENCY_PRICE_CHANGED` (total)                                                                                                                                                                                                                                                                                              | owner after lookup, after quote                      | no                                          | no for this key at lookup                                                                            | may keep; no order exists  | re-read catalog, show and confirm the exact new total, retry                          |
| 409 `RESIDENCY_ORDER_CONFLICT`                                                                                                                                                                                                                                                                                                     | owner insert race                                    | no by this request                          | **yes** — a concurrent order may exist                                                               | keep                       | unresolved lookup / same-key replay                                                   |
| 503 `RESIDENCY_OWNER_UNAVAILABLE`, `RESIDENCY_OWNER_RESPONSE_INVALID`                                                                                                                                                                                                                                                              | consumer transport/timeout/invalid answer            | **unknown** — the owner may have created it | **yes**                                                                                              | keep                       | same-key replay; unresolved lookup if key/orderId was lost                            |
| 503 `RESIDENCY_OWNER_CONFIGURATION_INVALID`                                                                                                                                                                                                                                                                                        | consumer mapping of an owner configuration refusal   | no for this request; see owner rows         | **yes**                                                                                              | keep                       | fix configuration, repeat; unresolved lookup                                          |
| 503 `RESIDENCY_ORDERS_DISABLED`, `RESIDENCY_PRODUCT_NOT_CONFIGURED`, `RESIDENCY_TENANT_NOT_SUPPORTED`                                                                                                                                                                                                                              | consumer before the owner                            | no                                          | **yes**                                                                                              | keep                       | fix configuration/tenant; unresolved lookup                                           |
| 200 `PAYMENT_FAILED`                                                                                                                                                                                                                                                                                                               | owner after insert; provider explicit 4xx            | **yes**, terminal                           | provider refused; no financial operation from that request                                           | new key for a retry        | read the terminal order                                                               |
| 200 `PENDING_PAYMENT` payment `PENDING`                                                                                                                                                                                                                                                                                            | owner after insert; provider accepted                | **yes**                                     | **yes** — provider operation exists                                                                  | keep                       | pay or reconcile                                                                      |
| 200 `PENDING_PAYMENT` payment `UNKNOWN`                                                                                                                                                                                                                                                                                            | owner after insert; ambiguous outcome                | **yes**                                     | **yes** — provider operation may exist                                                               | keep                       | reconcile/read; `UNKNOWN_OUTCOME`; never a new key                                    |
| 200 `PAID` / `ACTIVE`                                                                                                                                                                                                                                                                                                              | owner after insert                                   | **yes**                                     | provider payment exists                                                                              | terminal                   | read; activation/reconcile                                                            |

A response is definitive for the key only when it is raised **after** the owner's lookup and
before an order is inserted, or when it is `RESIDENCY_ORDER_ALREADY_PENDING` (another order
exists). Pre-lookup 400/409 answers, `RESIDENCY_OWNER_UNAVAILABLE` and an invalid answer are
**not** proof that no order exists; keep the key and recover through
`GET /residency/orders?state=unresolved`.

The HTTP layer can also refuse before the runtime: owner 400 `RESIDENCY_REQUEST_INVALID`
(malformed JSON), 413 `RESIDENCY_REQUEST_TOO_LARGE` and 415
`RESIDENCY_CONTENT_TYPE_INVALID`; the consumer route's Fastify body limit can answer 413 before
the runtime with a framework code. These create nothing, but the pre-lookup caveat still applies.

## Renewal rule (authoritative)

The rights owner (CUP) always computes a paid window as `paymentDate + 30 days` and never
carries remaining days. Therefore an early renewal burns days and is refused **before** the
transaction: `409 RESIDENCY_RENEWAL_TOO_EARLY` with `details: { reason:
"REMAINING_DAYS_NOT_TRANSFERABLE", eligibleAt, currentValidUntil, expected }`. The catalog
publishes the same reason before payment. The cabinet should show "продление доступно с
<eligibleAt>" and must not treat a post-payment `ACTIVATION_FAILED` as the guard.

## Client flow requirements

1. The client may store the Idempotency-Key, mode, orderId and the **confirmed catalog total**
   it sent as `expectedTotalMinor`. That total is an immutable operation snapshot required to
   replay the same create and to refuse a different total; it is **not** a locally computed
   tariff. Every amount still comes from the catalog/owner, and the owner enforces exact
   equality. Never store a payment link, token or provider id. (This corrects the earlier
   "no price" wording: storing the confirmed total is allowed and required for replay.)
2. Send the exact `expectedTotalMinor` from the catalog the user confirmed; never derive,
   round or cache it as a price.
3. Use `mode=NEW` when the status read is not ACTIVE, `RENEWAL` only when it is ACTIVE and
   `catalog.renewal.eligible` is true. With `eligible=false` offer no purchase and show
   `eligibleAt`.
4. On `UNKNOWN_OUTCOME`, `AWAITING_CONFIRMATION`, `ACTIVATION_PENDING` and
   `REVIEW_REQUIRED`, never start a new payment; poll `reconcile`/`read` and offer
   `GET /residency/orders?state=unresolved` on a new device.
5. `RESIDENCY_REAUTH_REQUIRED` means a fresh Viva sign-in is needed; the operation key is kept.

## Local TTL does not close PENDING or UNKNOWN

The owner's local pending-payment window (default 20 minutes) is a display/reconciliation hint,
not the provider's payment lifetime. Passing it must not be presented as expiry:

- `payment.status=PENDING` past `expiresAt`: the order stays `PENDING_PAYMENT`, the payment
  endpoint reports `overdue=true`, recovery is `AWAITING_CONFIRMATION` with action
  `RETRY_RECONCILE`; the link stays usable.
- `payment.status=UNKNOWN` (ambiguous dispatch): the order stays `PENDING_PAYMENT`, recovery is
  `UNKNOWN_OUTCOME` with action `RETRY_RECONCILE`, `overdue=false`; the TTL does not convert it
  to `AWAITING_CONFIRMATION`, `EXPIRED`, `CANCELLED` or a new purchase.
- Only a confirmed provider terminal result, or a confirmed PAID read, changes the order. A lost
  local TTL never releases the active slot; a new key is refused with
  `RESIDENCY_ORDER_ALREADY_PENDING`.

## Reproducible composed test for the web/SDK PR (#682)

This command runs the **real LK2 consumer** (owner client + runtime) against the **real LK1
owner** HTTP contract, engine and provider adapter. The Viva/CUP transport is a controlled
synthetic fixture, so this is **LOCAL contract composition, not PROVIDER/Viva evidence**. Do not
use it as a sandbox payment or Viva readback.

```bash
# Consumer checkout at this PR head; owner checkout at the compatible LK1 PR head.
LK2="${LK2:?path to the lk2 checkout at this PR head}"
LK1="${LK1:?path to the lk checkout at Z6v6e6r/lk#443}"
EXPECTED_OWNER_SHA=2f7c2d48251bc883cab9cf34a51492ba32be045e

# Use the canonical path: the LK1 HTTP layer recognises its own error class by identity, and
# a symlinked checkout (for example /tmp on macOS) can load the module twice and lose details.
LK1="$(cd "$LK1" && pwd -P)"
test "$(git -C "$LK1" rev-parse HEAD)" = "$EXPECTED_OWNER_SHA" || {
  echo "owner checkout is not the reviewed head"; exit 2; }

cd "$LK2"
LK1_RESIDENCY_MODULES_ROOT="$LK1" \
  npx vitest run apps/api/src/residency/client-residency-owner-chain.test.ts
```

Expected: `Test Files 1 passed (1)` and `Tests 7 passed (7)` — seven executed composed
scenarios, zero skipped. A missing `LK1_RESIDENCY_MODULES_ROOT` makes the file report
`7 skipped`, which is not acceptable evidence.

The seven scenarios: catalog/renewal, purchase + exact-total refusal + replay, unknown outcome,
paid create with a failed Admin read, overdue/TTL for PENDING and UNKNOWN, previous-format
recovery, reauth/owner-unavailable/product mismatch. The original reviewed pair was LK1
`4d04a05c05561047fb4293498812c6d8af38b88c` + LK2 `d92b978221f8800521583b5926402a3c2a593dd3`;
the previous handoff pinned LK1 `93692e64853df63bb2165ddc54145d86cf8a078a`. This handoff pins LK1
`2f7c2d48251bc883cab9cf34a51492ba32be045e` (late create evidence and unconfirmed-payment
projection) with the consumer commit on this branch; the test asserts behavior, not a stale tree.

The equivalent owner-side suites are run in the LK1 checkout:

```bash
cd "$LK1"
LK_TEST_MONGO_URI="mongodb://127.0.0.1:27017/lk_residency_local" \
  npm run -s test:residency-lifecycle
# 99 tests: 99 pass, 0 skipped against a disposable Mongo (9 real-server scenarios)
```

The mandatory LK1 CI job runs the same script against a disposable `mongo:8.0.5` service with
`LK_TEST_MONGO_REQUIRED=1`; there a missing database is a failure, never a skip.

Not PROVIDER evidence: no real Viva transaction, Admin read, CUP refresh, sandbox card payment or
Node-RED install is performed by either command.
