# Residency purchase and renewal (LK2 client contract)

Status: **client aligned, server surface pending.** The order owner is the LK1 residency
lifecycle, [Z6v6e6r/lk#443](https://github.com/Z6v6e6r/lk/pull/443) at
`bdbd9f57dd939202ea3e2efc822d0c598616b37a` (Draft, flag `LK_RESIDENCY_LIFECYCLE_ENABLED` off,
not deployed). This client is compatible with that head. LK2 browsers may not call it directly:
it lives on the LK1 origin and authenticates an LK1 Keycloak `widget` token, while LK2 clients
hold only a PadlHub JWT and call only PadlHub APIs. The LK2 API surface below must therefore be
implemented server-side as a consumer of the owner (see [Open questions](#open-questions)).
Until it is deployed, `GET …/residency/catalog` fails and the screen says purchase is
unavailable. The client contains no product, price, term, discount or benefit of its own.

## Success condition

The screen shows "Резидентство активно" only when **both** hold:

1. the order is `ACTIVE` (owner activation from CUP evidence, `residency.validUntil` present);
2. the independent LK2 read `GET /user/api/v1/{tenantKey}/residency` (ADR 0027) answers
   `ACTIVE` with a non-null `checkedAt`.

Returning from the payment page proves nothing. `PAID` is a receipt, not an entitlement.

## LK2 surface (to be served by the LK2 API, mirroring the owner 1:1)

Prefix `/user/api/v1/{tenantKey}`, PadlHub JWT; tenant and user only from route and claims;
`Cache-Control: no-store`. Errors use the standard PadlHub body `{ code, message, correlationId }`
with the owner's stable `RESIDENCY_*` codes and HTTP status passed through.

| Method | LK2 path                                | Owner path (`/lk/residency`)  | Idempotency-Key |
| ------ | --------------------------------------- | ----------------------------- | --------------- |
| GET    | `/residency`                            | — (LK2 ADR 0027 read)         | —               |
| GET    | `/residency/catalog`                    | `GET /catalog`                | —               |
| POST   | `/residency/orders` `{ mode }`          | `POST /orders`                | required        |
| GET    | `/residency/orders/{orderId}`           | `GET /orders/{id}`            | —               |
| GET    | `/residency/orders/{orderId}/payment`   | `GET /orders/{id}/payment`    | —               |
| POST   | `/residency/orders/{orderId}/reconcile` | `POST /orders/{id}/reconcile` | required        |
| POST   | `/residency/orders/{orderId}/cancel`    | `POST /orders/{id}/cancel`    | required        |

Shapes the client validates (extra fields are ignored):

```text
Catalog  = { schemaVersion: 1, product: { productId: uuid, title, termDays: int > 0,
             priceMinor: int > 0, currency: "RUB", benefits: string[] }, checkedAt: instant }
Envelope = { schemaVersion: 1, order: Order, idempotentReplay?, recoveryRequired?,
             retryable?, reviewRequired? }            -- create, reconcile, cancel
Order    = { schemaVersion: 1, orderId: uuid, mode: NEW | RENEWAL,
             state: PENDING_PAYMENT | PAYMENT_FAILED | EXPIRED | CANCELLED | PAID |
                    PAID_ACTIVATION_PENDING | ACTIVE | ACTIVATION_FAILED | PAID_REQUIRES_REVIEW,
             product: { title }, pricing: { totalMinor: int > 0, currency: "RUB" },
             payment: { status: NONE | PENDING | PAID | FAILED | UNKNOWN,
                        paymentUrl: https | null, expiresAt: instant | null },
             residency: null | { validUntil: instant } }   -- required when ACTIVE
Payment  = { schemaVersion: 1, orderId, state, paymentStatus, paymentUrl, expiresAt }
```

A payment link is opened only when it is `https`, has no credentials, and the order is
`PENDING_PAYMENT` with payment `PENDING`.

## Client flow

1. Read status and catalog. Purchase is offered only when the status read is trustworthy
   (`ACTIVE`, `NONE`, expired); `UNAVAILABLE` or a failed read is never treated as absence.
2. "Оформить"/"Продлить" re-reads the catalog and shows its price, term and `checkedAt`.
3. Confirm: `mode = RENEWAL` when the status read is `ACTIVE`, else `NEW` (the owner enforces
   `RESIDENCY_RENEWAL_REQUIRED` / `RESIDENCY_RENEWAL_NOT_ELIGIBLE`). The key `residency:<uuid>`
   and mode are saved in `localStorage` **before** the POST. The response's `orderId` is saved,
   and the server payment link is opened.
4. Return to `/residency` (or reload, or reopen): the saved `orderId` is read; while the order
   awaits payment or activation, the client calls `reconcile` up to 8 times, 4 s apart, and on
   return to the foreground, then re-reads the status.
5. Terminal states (`ACTIVE` with an `ACTIVE` read, `PAYMENT_FAILED`, `EXPIRED`, `CANCELLED`) are
   cleared only after a fresh server read confirms them.

| Order / read                                                                           | Screen                                 |
| -------------------------------------------------------------------------------------- | -------------------------------------- |
| key saved, no response                                                                 | "Заказ отправлен" + "Проверить заказ"  |
| `PENDING_PAYMENT`, payment `PENDING`/`NONE`                                            | "Ожидает оплаты", pay / check / cancel |
| payment `UNKNOWN`, `PAID`, `PAID_ACTIVATION_PENDING`, `ACTIVE` before read is `ACTIVE` | "Проверяем оплату"                     |
| `ACTIVE` + read `ACTIVE`                                                               | "Резидентство активно"                 |
| `ACTIVATION_FAILED`, `PAID_REQUIRES_REVIEW`                                            | "Нужна проверка клуба", no new payment |
| `PAYMENT_FAILED`, `EXPIRED`, `CANCELLED`                                               | failure, then "Оформить заново"        |

## Idempotency and duplicates

| Case                               | Client                                                                                                     | Owner (#443)                                                                                        |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| repeated tap                       | commands serialized (`navigator.locks` + in-flight guard)                                                  | —                                                                                                   |
| two tabs                           | saved key checked inside the lock; second create refused                                                   | one unresolved order per user (`RESIDENCY_ORDER_ALREADY_PENDING`)                                   |
| lost create response               | key kept, `orderId` null; explicit "Проверить заказ" repeats the **same** key; no automatic POST on reload | deterministic order id from (tenant, user, key); replay returns the same order, no second Viva POST |
| other device has a pending order   | message, no local record                                                                                   | `409 RESIDENCY_ORDER_ALREADY_PENDING` before any provider POST                                      |
| account switch                     | record keyed by tenant + user; results after a principal change discarded                                  | order reads scoped to tenant + user (`404` otherwise)                                               |
| definitive refusal before an order | local record removed (codes listed in `ResidencyPage.tsx`)                                                 | —                                                                                                   |

Only `{ version, tenantId, userId, key, mode, orderId }` is stored. No price, link or payment
details.

## Open questions

For the backend owner of #443 and the LK2 server consumer:

1. **LK2 server consumer (blocker).** Who implements the six LK2 routes above, and how does it
   authenticate to the owner? #443 needs an LK1 Keycloak `widget` bearer and uses it as the Viva
   actor token for the transaction. LK2 has a PadlHub JWT and a Viva profile mapping (#627). A
   delegation, like `subscription-runtime-actor-delegation-issuer` for the monthly purchase, or a
   service call with a verified actor is needed. This is a CRITICAL auth/payment boundary.
2. **Return URL (blocker).** `LK_RESIDENCY_LIFECYCLE_SUCCESS_URL` / `_FAIL_URL` are single fixed
   values for LK1. LK2 needs `https://lk2.padlhub.su/residency` (and the test-stand origin). Is
   it per caller, or a second configuration?
3. **Price consent.** `POST /orders` accepts only `mode`. Can it accept
   `expectedTotalMinor`, refusing with a stable code when the price changed after the catalog read?
4. **Benefits.** The catalog returns `benefits: []`, while the policy lists 30% / 50%. Will the
   catalog publish plain-text benefit lines from CUP? Until then the screen shows none.
5. **Renewal eligibility.** `renewalEligible` in the catalog is product-level, not per user. The
   client chooses `RENEWAL` from the LK2 status read. Is that the intended rule?
6. **Renewal window.** #443 states that a renewal is a new purchase starting at its payment date,
   and the current instance stays valid until its own end. Confirm, so the screen can state the
   new period. It now says the club defines the dates after payment.
7. **Pending order lookup.** There is no "my unresolved order" read. After
   `RESIDENCY_ORDER_ALREADY_PENDING` on a device without the key, the user can only wait for
   expiry (20 min). Add `GET /orders?state=unresolved`?
8. **Reconcile key.** Each client reconcile uses a fresh `residency-reconcile:<uuid>` key. Is
   reconcile without `eventId` safe to call up to 8 times per return?
9. **Status source.** The client uses the LK2 ADR 0027 read, not the owner's `/status`. Both read
   the same Viva product; `VIVA_RESIDENCY_PRODUCT_ID` must equal `LK_RESIDENCY_LIFECYCLE_PRODUCT_ID`
   (`4037a3a3-…`).

## Environment blockers

- `VIVA_RESIDENCY_PRODUCT_ID` is unset everywhere. The status read answers
  `UNAVAILABLE / PRODUCT_NOT_CONFIGURED`, and the screen offers no purchase.
- The test stand runs `VIVA_MODE=mock`, and beta/lk2 run `production`. No sandbox payment contour
  is available, so end-to-end payment is **BLOCKED**. No real charge may be used as a test.
- #443 is Draft: no custom-node install, Mongo indexes, flow import or flag.

Native shells (Android/iOS) do not expose this flow; they show that purchase is available in the
web cabinet.
