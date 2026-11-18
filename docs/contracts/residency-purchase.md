# Residency purchase and renewal (LK2 client contract)

Status: **client aligned, server surface pending.** The order owner is the LK1 residency
lifecycle, [Z6v6e6r/lk#443](https://github.com/Z6v6e6r/lk/pull/443) at
`adc9c64464ff25c679459b66bfff9cd00b82e1b2` (Draft, flag `LK_RESIDENCY_LIFECYCLE_ENABLED` off,
not deployed). This client is compatible with that head. LK2 browsers may not call it directly:
it lives on the LK1 origin and authenticates an LK1 Keycloak `widget` token, while LK2 clients
hold only a PadlHub JWT and call only PadlHub APIs. The LK2 API surface below must therefore be
implemented server-side as a consumer of the owner (see [Open questions](#open-questions)).
Until it is deployed, `GET …/residency/catalog` fails and the screen says purchase is
unavailable. The client contains no product, price, term, discount or benefit of its own.

## Success condition

The screen shows "Резидентство активно" / "Резидентство продлено" only when **both** hold:

1. the order is `ACTIVE` (owner activation from CUP evidence, `residency.validUntil` present);
2. the independent LK2 read `GET /user/api/v1/{tenantKey}/residency` (ADR 0027) answers
   `ACTIVE` with a non-null `checkedAt` **and** a `validUntil` not earlier than the order's end
   (Moscow day). An old `ACTIVE` read before a renewal lands is not confirmation.

The success text shows the order's own end date, never the previous one.

Returning from the payment page proves nothing. `PAID` is a receipt, not an entitlement.

## Agreed sources

| Side                  | Repository / PR             | Commit                                     |
| --------------------- | --------------------------- | ------------------------------------------ |
| Client (web, SDK)     | Z6v6e6r/lk2#682             | head of `agent/residency-ui-lk2-20261118`  |
| Owner (LK1 lifecycle) | Z6v6e6r/lk#443              | `adc9c64464ff25c679459b66bfff9cd00b82e1b2` |
| LK2 consumer, OpenAPI | DeepSeek, PR not opened yet | — (**dependency**)                         |

The owner files are imported byte-identical in
`contracts/imported/lk1-residency-lifecycle/adc9c644/`. `apps/web/src/ResidencyPage.test.tsx`
drives that real state machine and HTTP contract through a synthetic LK2 consumer transport and
the real `PadlHubApiClient`. When the consumer PR exists, its routes must answer exactly as that
transport does: the owner body 1:1, and errors as `{ code, message, correlationId }` with the
owner HTTP status.

## LK2 surface (to be served by the LK2 API, mirroring the owner 1:1)

Prefix `/user/api/v1/{tenantKey}`, PadlHub JWT; tenant and user only from route and claims;
`Cache-Control: no-store`. Errors use the standard PadlHub body `{ code, message, correlationId }`
with the owner's stable `RESIDENCY_*` codes and HTTP status passed through.

| Method | LK2 path                                | Owner path (`/lk/residency`)   | Idempotency-Key |
| ------ | --------------------------------------- | ------------------------------ | --------------- |
| GET    | `/residency`                            | — (LK2 ADR 0027 read)          | —               |
| GET    | `/residency/catalog`                    | `GET /catalog`                 | —               |
| POST   | `/residency/orders` `{ mode }`          | `POST /orders`                 | required        |
| GET    | `/residency/orders/{orderId}`           | `GET /orders/{id}`             | —               |
| GET    | `/residency/orders/{orderId}/payment`   | `GET /orders/{id}/payment`     | —               |
| POST   | `/residency/orders/{orderId}/reconcile` | `POST /orders/{id}/reconcile`  | required        |
| POST   | `/residency/orders/{orderId}/cancel`    | `POST /orders/{id}/cancel`     | required        |
| GET    | own unresolved order (not agreed yet)   | — (**dependency**, question 7) | —               |

SDK methods: `getClientResidency`, `getResidencyCatalog`, `createResidencyOrder(mode, key)`,
`getResidencyOrder(id)`, `getResidencyOrderPayment(id)`, `reconcileResidencyOrder(id, key)`,
`cancelResidencyOrder(id, key)`. None of them retries on a transport failure. A GET retried by
the user is safe, and every command keeps its caller key.

Errors the client distinguishes:

| Status / code                                                                                                                                                                   | Meaning for the client                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| 409 `ALREADY_PENDING`, `RENEWAL_REQUIRED`, `RENEWAL_NOT_ELIGIBLE`; 503 `STATUS_UNAVAILABLE`, `CATALOG_UNAVAILABLE`, `PRICING_*`; 400 `MODE_INVALID`, `IDEMPOTENCY_KEY_REQUIRED` | definitive for the key (the owner looked it up first): this attempt is removed |
| 409 `IDEMPOTENCY_CONFLICT`, `ORDER_CONFLICT`; 429; 401; 403; consumer 404/503; network; non-JSON                                                                                | uncertain: the attempt and its key are kept                                    |
| 409 `PAYMENT_STATUS_UNKNOWN`, `ORDER_PAID`, `ORDER_NOT_CANCELLABLE` (cancel)                                                                                                    | the order is not cancelled; a message is shown                                 |
| catalog 404 / 503 / 403 / 401 / HTML                                                                                                                                            | "Оформление резидентства пока недоступно"                                      |
| status non-JSON or malformed                                                                                                                                                    | "Не удалось проверить статус", never absence                                   |
| Shapes the client validates (extra fields are ignored):                                                                                                                         |

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
             activation: { lastErrorCode: string | null },
             residency: null | { validUntil: instant } }   -- required when ACTIVE
Payment  = { schemaVersion: 1, orderId, state, paymentStatus, paymentUrl, expiresAt }
```

A payment link is opened only when it is `https`, has no credentials, and the order is
`PENDING_PAYMENT` with payment `PENDING`.

## Client flow

1. Read status and catalog. Purchase is offered only when the status read is trustworthy
   (`ACTIVE`, `NONE`, expired); `UNAVAILABLE` or a failed read is never treated as absence.
2. "Оформить"/"Продлить" re-reads the catalog and shows its price, term and `checkedAt`.
3. Confirm shows the type (new or renewal), the price, the term and the catalog time; for a
   renewal it shows the current end and says the club confirms the new period after payment (no
   client-side date rule). `mode = RENEWAL` when the status read is `ACTIVE`, else `NEW` (the
   owner enforces `RESIDENCY_RENEWAL_REQUIRED` / `RESIDENCY_RENEWAL_NOT_ELIGIBLE`). The attempt
   `{key, mode, confirmedPriceMinor}` is saved **before** the POST in its own entry. The
   response's `orderId` is saved, and the server payment link opens only if the order total
   equals the confirmed price.
4. Return to `/residency` (or reload, or reopen): the saved `orderId` is read; while the order
   awaits payment or activation, the client calls `reconcile` up to 8 times, 4 s apart, and on
   return to the foreground, then re-reads the status.
5. Terminal states (`ACTIVE` with an `ACTIVE` read, `PAYMENT_FAILED`, `EXPIRED`, `CANCELLED`) are
   cleared only after a fresh server read confirms them.

| Order / read                                                                           | Screen                                            |
| -------------------------------------------------------------------------------------- | ------------------------------------------------- |
| key saved, no response                                                                 | "Заказ отправлен" + "Проверить заказ"             |
| `PENDING_PAYMENT`, payment `PENDING`/`NONE`                                            | "Ожидает оплаты", pay / check                     |
| payment `UNKNOWN`, `PAID`, `PAID_ACTIVATION_PENDING`, `ACTIVE` before read is `ACTIVE` | "Проверяем оплату"                                |
| `ACTIVE` + read `ACTIVE` covering the order end                                        | "Резидентство активно / продлено"                 |
| terminal state with payment `UNKNOWN` or `DISPATCH_*` / `TRANSACTION_ID_MISSING`       | "Результат оплаты не подтверждён", no new payment |
| `ACTIVATION_FAILED`, `PAID_REQUIRES_REVIEW`                                            | "Нужна проверка клуба", no new payment            |
| `PAYMENT_FAILED`, `EXPIRED`, `CANCELLED` with a known payment status                   | failure, then "Оформить заново"                   |

There is no cancel button: the owner refuses to cancel while the bank still reports the payment
`PENDING` (`409 RESIDENCY_PAYMENT_STATUS_UNKNOWN`), and an unpaid order closes at its expiry.

## Idempotency and duplicates

| Case                               | Client                                                                                                                                        | Owner (#443)                                                                                        |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| repeated tap                       | in-flight guard per tab                                                                                                                       | —                                                                                                   |
| two tabs                           | Web Locks where available; without them each attempt has its own entry and a refusal removes only its own key                                 | one unresolved order per user (`RESIDENCY_ORDER_ALREADY_PENDING`, unique active slot)               |
| lost create response or refusal    | key kept, `orderId` null; explicit "Проверить заказ" repeats the **same** key and settles it like the first send; no automatic POST on reload | deterministic order id from (tenant, user, key); replay returns the same order, no second Viva POST |
| other device has a pending order   | message, no local record                                                                                                                      | `409 RESIDENCY_ORDER_ALREADY_PENDING` before any provider POST                                      |
| account switch                     | record keyed by tenant + user; results after a principal change discarded                                                                     | order reads scoped to tenant + user (`404` otherwise)                                               |
| definitive refusal before an order | that attempt removed (`isDefinitiveCreateRefusal`)                                                                                            | refusal raised after the key lookup found no order                                                  |

Only `{ version, tenantId, userId, key, mode, orderId, confirmedPriceMinor, createdAt }` is stored
per attempt, under `phub.residency-order.v3:{tenant}:{user}:{key}`. No link or payment details.

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
6. **Renewal window.** Since `adc9c644` the owner requires the new instance to start no later
   than the current `validUntil` and to end at least `validUntil + term`. Otherwise it refuses
   with `RENEWAL_WINDOW_NOT_EXTENDED`. Can the catalog or order expose the expected new
   `validUntil`, so the screen can show it before payment? It now says the club defines the dates
   after payment.
7. **Pending order lookup.** There is no "my unresolved order" read. After
   `RESIDENCY_ORDER_ALREADY_PENDING` on a device without the key, the user can only wait for
   expiry (20 min). Add `GET /orders?state=unresolved`?
8. **Reconcile key.** Each client reconcile uses a fresh `residency-reconcile:<uuid>` key. Is
   reconcile without `eventId` safe to call up to 8 times per return?
9. **Uncertain create outcome.** A lost provider create ends as `CANCELLED` with payment
   `UNKNOWN` and `DISPATCH_OUTCOME_UNKNOWN`, and the active slot is released. The client shows
   "not confirmed" and offers no new payment from that device, but the owner would accept a new
   order from another device. Should such an order stay unresolved until it is reconciled?
10. **Cancel while pending.** Since `adc9c644` cancel is refused while the bank reports
    `PENDING`, so an unpaid order cannot be abandoned before expiry. Is a provider void planned?
11. **DISPATCHING.** The client accepts only the public statuses; `DISPATCHING` must stay
    normalized to `UNKNOWN` in every DTO, including `GET /orders/{id}/payment`.
12. **Status source.** The client uses the LK2 ADR 0027 read, not the owner's `/status`. Both read
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
