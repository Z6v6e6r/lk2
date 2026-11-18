# Residency purchase (client contract, provisional v1)

Status: **provisional**. The LK2 client implements this contract; the server owner (LK2 API over
the LK1 subscription runtime) is not merged yet. Until it is deployed, `capability` fails (404) or
answers `available: false`, and the residency screen says that purchase is unavailable. The client
contains no offers, prices, discounts, durations or benefits of its own.

The status read is the merged `GET /user/api/v1/{tenantKey}/residency` (ADR 0027,
[residency domain](../domains/residency.md)). Success is shown only when the purchase operation is
`ACTIVATED` **and** that independent read answers `ACTIVE` with a complete `checkedAt`. Returning
from the payment page proves nothing by itself.

## Common rules

- Prefix: `/user/api/v1/{tenantKey}/residency-purchase-operations`. PadlHub JWT; tenant and user
  come only from the route and verified claims. `Cache-Control: no-store`.
- Every `POST` carries `Idempotency-Key: residency:<uuid v4>`; the client persists the key before
  the command and recovers a lost response by reading the same key, never by a new key.
- Responses are exact objects (no extra fields); the client rejects anything else.
- Money: `amountMinor` (positive integer, kopecks), `currency: "RUB"`. Dates: `YYYY-MM-DD`
  (Europe/Moscow business day). Instants: ISO-8601 UTC with milliseconds.
- Errors use the standard PadlHub error body (`code`, `message`, `correlationId`).

## Operations

| Method | Path                            | Body                                                   | Response     |
| ------ | ------------------------------- | ------------------------------------------------------ | ------------ |
| GET    | `/capability`                   | —                                                      | `Capability` |
| POST   | `/quote`                        | `{ offerId }`                                          | `Quote`      |
| POST   | `/` (purchase)                  | `{ offerId, expectedRevision, amountMinor, currency }` | `Result`     |
| GET    | `/by-key`                       | — (`Idempotency-Key` header selects the operation)     | `Result`     |
| POST   | `/{operationId}/reconcile`      | `{}`                                                   | `Result`     |
| POST   | `/{operationId}/payment-launch` | `{}`                                                   | `Launch`     |

```text
Capability = { contractVersion: 1, available: boolean, offers: Offer[] (<= 20) }
Offer      = { offerId: uuid, title: string, description: string | null,
               durationLabel: string, amountMinor: int > 0, currency: "RUB",
               benefits: string[] (<= 20) }
Quote      = { contractVersion: 1, operationId: uuid, offerId: uuid, title: string,
               revision: string, amountMinor: int > 0, currency: "RUB",
               validFrom: date, validUntil: date, expiresAt: instant }
Result     = { contractVersion: 1, operationId: uuid, offerId: uuid,
               status: QUOTED | PAYMENT_PENDING | CONFIRMING | ACTIVATED |
                       PAYMENT_FAILED | EXPIRED | UNKNOWN,
               amountMinor: int > 0 | null, currency: "RUB",
               canOpenPayment: boolean, paymentExpiresAt: instant | null,
               failureCode: UPPER_SNAKE | null }
Launch     = { contractVersion: 1, operationId: uuid, paymentUrl: https URL,
               expiresAt: instant (future) }
```

Server obligations the UI relies on:

- `available: true` requires at least one offer. Offer values come from the configured product
  (Viva product `VIVA_RESIDENCY_PRODUCT_ID` and its sale price), never from client input.
- The quote decides new purchase vs renewal: for an active residency `validFrom` is the day after
  the current `validUntil`. The client only displays these dates.
- The purchase rejects a stale `expectedRevision` or a different `amountMinor`; one key maps to one
  operation; repeated POSTs with the same key return the same operation.
- `canOpenPayment` is true only for `PAYMENT_PENDING` with a non-null `paymentExpiresAt`.
- `paymentUrl` is issued by the server per launch, is short-lived and returns the user to
  `/residency`. The client opens it as-is and stores nothing from it.
- `ACTIVATED` is reported only after the provider confirmed payment and the residency instance
  exists. `failureCode` values the UI names: `PAYMENT_DECLINED`, `PAYMENT_CANCELLED`,
  `PAYMENT_EXPIRED`, `QUOTE_EXPIRED`, `OFFER_UNAVAILABLE`; any other code shows a generic failure.

## Client behavior

| State                           | Source                                                                                        |
| ------------------------------- | --------------------------------------------------------------------------------------------- |
| Loading / API unavailable       | status read pending / failed or `UNAVAILABLE`                                                 |
| No residency / expired / active | status read `NONE` (no or past `validUntil`) / `ACTIVE`                                       |
| Purchase unavailable            | `capability` failed or `available: false`                                                     |
| Price confirmed                 | saved `Quote`, not submitted                                                                  |
| Awaiting payment                | `Result.status = PAYMENT_PENDING`                                                             |
| Awaiting confirmation           | submitted without result, `CONFIRMING`, `UNKNOWN`, or `ACTIVATED` before the read is `ACTIVE` |
| Payment failed                  | `PAYMENT_FAILED`, `EXPIRED`                                                                   |
| Activated                       | `ACTIVATED` and status read `ACTIVE`                                                          |

The browser keeps only `{ version, tenantId, userId, key, submitted, quote }` per account in
`localStorage` (no payment details). Reopening the app or returning from payment reads the saved
key; the screen re-reads up to 8 times, 4 s apart, and on returning to the foreground. Commands are
serialized; a repeated tap while one runs is ignored.

Native shells (Android/iOS) do not expose this flow yet: their session transports allow only
reviewed paths and have no residency payment handoff. They show that purchase is available in the
web cabinet.
