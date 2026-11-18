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

`expectedTotalMinor` is required: it is the total the user saw in the catalog. The owner refuses
a missing value (400 `RESIDENCY_PRICE_CONSENT_REQUIRED`), a higher server price or another product
(409 `RESIDENCY_PRICE_CHANGED` with `details`) before any durable order or provider POST.
`expectedProductId` is optional and defaults to the configured product.

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
`RESIDENCY_OWNER_RESPONSE_INVALID` (503), `RESIDENCY_PRODUCT_NOT_CONFIGURED` (503),
`RESIDENCY_PRODUCT_CONFIG_MISMATCH` (503), `RESIDENCY_TENANT_NOT_SUPPORTED` (503),
`RESIDENCY_REAUTH_REQUIRED` (409), `RESIDENCY_REAUTH_UNAVAILABLE` (503),
`RESIDENCY_PERMISSION_REQUIRED` (403), `AUTH_REQUIRED` (401),
`AUTH_SESSION_REVOKED` (401).

Error body: `{ code, message, correlationId, details? }`.

## Renewal rule (authoritative)

The rights owner (CUP) always computes a paid window as `paymentDate + 30 days` and never
carries remaining days. Therefore an early renewal burns days and is refused **before** the
transaction: `409 RESIDENCY_RENEWAL_TOO_EARLY` with `details: { reason:
"REMAINING_DAYS_NOT_TRANSFERABLE", eligibleAt, currentValidUntil, expected }`. The catalog
publishes the same reason before payment. The cabinet should show "продление доступно с
<eligibleAt>" and must not treat a post-payment `ACTIVATION_FAILED` as the guard.

## Client flow requirements

1. Store only the Idempotency-Key, mode and orderId locally (already specified by the web
   contract); never a price, link or token.
2. Send `expectedTotalMinor` from the catalog the user confirmed.
3. Use `mode=NEW` when the status read is not ACTIVE, `RENEWAL` only when it is ACTIVE and
   `catalog.renewal.eligible` is true. With `eligible=false` offer no purchase and show
   `eligibleAt`.
4. On `UNKNOWN_OUTCOME`, `AWAITING_CONFIRMATION`, `ACTIVATION_PENDING` and
   `REVIEW_REQUIRED`, never start a new payment; poll `reconcile`/`read` and offer
   `GET /residency/orders?state=unresolved` on a new device.
5. `RESIDENCY_REAUTH_REQUIRED` means a fresh Viva sign-in is needed; the operation key is kept.
