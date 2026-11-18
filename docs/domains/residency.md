# Client residency

## Boundary

Residency is a server-owned read of a Viva-primary subscription product. It exposes one normalized
answer to the authenticated user through `GET /user/api/v1/{tenantKey}/residency`. It owns no local
business row and performs no provider write: it creates no visit, booking, write-off, refund or
configuration change.

Identity and station context are taken only from the verified tenant route and PadlHub JWT. The
request accepts no user ID, tenant ID, provider ID, product ID or station selector. The holder name
and avatar reuse the existing PadlHub profile summary and stable profile-photo delivery URL.

## Definition of residency

Residency is `ACTIVE` only when all of the following hold:

1. the Viva client ID was resolved from the unique synced `(VIVA, viva_profile)` integration mapping
   for the verified PadlHub user;
2. a bounded, complete read of that client's own subscriptions succeeded;
3. at least one subscription instance has an exact product identity equal to
   `VIVA_RESIDENCY_PRODUCT_ID`;
4. that instance has `status=ACTIVE` and its validity window includes today in `Europe/Moscow`.

The adapter never matches by subscription name, class category, direction/type, tariff text or the
presence of any subscription. A same-named subscription of another product is not residency.

## States and freshness

| State         | Meaning                                                                                                             |
| ------------- | ------------------------------------------------------------------------------------------------------------------- |
| `ACTIVE`      | Complete read found a valid exact-product instance. `validFrom`/`validUntil` describe it.                           |
| `NONE`        | Complete read proved no valid exact-product instance. A most-recent expired instance may supply the validity dates. |
| `UNAVAILABLE` | No trustworthy conclusion. `unavailableReason` names the cause and `checkedAt` is `null`.                           |

`checkedAt` is the timestamp of the complete provider read that produced the state. It is never
backfilled from a cache, a synthetic value or an unsuccessful attempt. The response is
`Cache-Control: private, no-store`.

Unavailable reasons are stable codes: `PRODUCT_NOT_CONFIGURED`, `SOURCE_NOT_CONFIGURED`,
`SOURCE_DISABLED`, `IDENTITY_MAPPING_MISSING`, `IDENTITY_RESOLUTION_UNAVAILABLE`,
`SOURCE_UNAVAILABLE`, `SOURCE_TIMEOUT`, `SOURCE_RESPONSE_INVALID`, `SOURCE_PARTIAL`,
`PRODUCT_IDENTITY_MISSING`, `OWNERSHIP_CONFLICT` and `CIRCUIT_OPEN`.

## Configuration

| Variable                        | Meaning                                                                                     |
| ------------------------------- | ------------------------------------------------------------------------------------------- |
| `VIVA_RESIDENCY_PRODUCT_ID`     | Exact Viva subscription product ID. Empty by default; empty means `PRODUCT_NOT_CONFIGURED`. |
| `VIVA_API_URL` / `VIVA_API_KEY` | Existing server-side Viva Admin integration used for the read.                              |
| `VIVA_MODE`                     | Must be `sandbox` or `production` when a product ID is configured.                          |

A configured product ID requires the server URL and key. The endpoint has no mock or synthetic
fallback, and production forbids `VIVA_MODE=mock`. Tests use synthetic UUIDs and provider fixtures
only; they are never production configuration.

## Provider contract

The adapter calls the existing Viva Admin endpoint
`GET /api/v1/clients/{vivaClientId}/subscriptions?includeFinished=true&size=200&page=N` with the
server credential and a bounded retry/circuit policy. It reads all declared pages within ten pages
and 2,000 rows. Expected row evidence is `subscriptionId`, optional consistent
`clientSubscriptionId`, owner aliases (`clientId`/`client.id`), `status`, optional
`productId`/`product.id`, and optional `activationDate`/`purchaseDate`/`expirationDate`.

Any incomplete page set, contradicting pagination total, invalid date, unrecognized status value,
owner/product alias conflict or duplicated instance identity stops the read. If any row lacks product
identity and no active exact match exists, the answer is `UNAVAILABLE` (product identity cannot be
proven), not `NONE`. A frozen or held instance is not active residency even if its status says
`ACTIVE`.

## Activation checklist

1. Create the residency product in Viva and record its exact product ID.
2. Provision `VIVA_API_URL`, `VIVA_API_KEY` and `VIVA_RESIDENCY_PRODUCT_ID` in the target
   environment; keep `VIVA_MODE` at `sandbox` or `production`.
3. Verify the verified test user has a unique synced Viva profile mapping and at least one
   subscription instance of the product.
4. Rehearse the read-only endpoint in sandbox and confirm `ACTIVE`/`NONE` distinctions, the
   `UNAVAILABLE` reason codes and that no Viva write occurred.
5. Monitor the adapter metric `residency_subscriptions` and the service metric `client_residency`;
   a failed read must not be presented as absence.

## Purchase and renewal consumer (LK1 owner)

The cabinet buys and renews residency only through the LK1 owner
([Z6v6e6r/lk#443](https://github.com/Z6v6e6r/lk/pull/443), contract
`residency-lifecycle.v2`; see `docs/residency-lifecycle.md` in that repository). LK2 is a
consumer: it keeps no order row, no local **tariff** and no independent entitlement model. The
browser may keep the exact catalog total it confirmed for a specific operation
(`expectedTotalMinor`) so a retry replays the same request; that snapshot is not a local price
calculation and the owner still enforces exact equality.

| Method | LK2 path (`/user/api/v1/{tenantKey}`)   | Owner path                                      | Idempotency-Key |
| ------ | --------------------------------------- | ----------------------------------------------- | --------------- |
| GET    | `/residency/catalog`                    | `GET /lk/residency/catalog`                     | —               |
| GET    | `/residency/orders?state=unresolved`    | `GET /lk/residency/orders?state=unresolved`     | —               |
| POST   | `/residency/orders`                     | `POST /lk/residency/orders`                     | required        |
| GET    | `/residency/orders/{orderId}`           | `GET /lk/residency/orders/{orderId}`            | —               |
| GET    | `/residency/orders/{orderId}/payment`   | `GET /lk/residency/orders/{orderId}/payment`    | —               |
| POST   | `/residency/orders/{orderId}/reconcile` | `POST /lk/residency/orders/{orderId}/reconcile` | required        |
| POST   | `/residency/orders/{orderId}/cancel`    | `POST /lk/residency/orders/{orderId}/cancel`    | required        |

The existing `GET /residency` stays an independent status read (ADR 0027); it is not the
purchase state.

### Boundary

- Tenant, user and session come only from the verified tenant route and the PadlHub JWT;
  commands additionally require the `client` role. The body selects no user, tenant,
  provider id or product.
- The owner credential is a **server-held, session-bound Viva Keycloak access token** minted
  through `authService.issueVivaAccessToken(actor)` (the same mechanism as the monthly
  purchase). The PadlHub JWT is never forwarded to LK1, and the Viva token is never returned
  in a DTO, written to a log or persisted by the consumer. An expired or missing delegation
  is `409 RESIDENCY_REAUTH_REQUIRED`; it never falls back to another credential.
- The consumer forwards the client `Idempotency-Key` unchanged, so the owner derives the same
  order identity. A repeated key returns the same order; a different key cannot bypass an
  unresolved operation (`409 RESIDENCY_ORDER_ALREADY_PENDING`).
- The consumer sends `X-Residency-Return-Target: lk2` and forwards `X-Correlation-ID`. LK1 maps
  that key to its configured LK2 return URL; a browser-supplied redirect is never accepted.
- Every owner answer is checked against the configured `VIVA_RESIDENCY_PRODUCT_ID`; a mismatch
  is a closed `503 RESIDENCY_PRODUCT_CONFIG_MISMATCH`, so the independent status read and the
  owner cannot describe different products.
- Owner 4xx refusals are passed through with the stable `RESIDENCY_*` code, HTTP status,
  `correlationId` and, for structured refusals, `details`. Timeouts, transport errors, an
  unusable answer and unexpected 5xx become retryable `503 RESIDENCY_OWNER_UNAVAILABLE`; an
  owner refusal that describes its own configuration (`RESIDENCY_RETURN_TARGET_INVALID`,
  `RESIDENCY_STATUS_UNAVAILABLE`, term mismatch) becomes
  `503 RESIDENCY_OWNER_CONFIGURATION_INVALID` with `details.ownerCode`; the client keeps its
  key and may repeat the same operation.
- The one-shot client keeps a **shared** availability breaker (three consecutive owner
  availability failures open it for 30 s). Only transport errors, timeouts, 5xx and
  non-contract upstream answers feed it. A correct business refusal (stable 4xx) proves the
  owner answered, so it resets the counter instead of counting towards it, and a user-specific
  delegation failure counts neither way. Three refusals for one user therefore cannot stop a
  read or an allowed command for another user, and the cooldown restores traffic. The fix adds
  no retry: every command is still exactly one owner request, and a timed-out POST is never
  replayed automatically.
- The order DTO carries a durable `recovery` block (`NONE`, `AWAITING_PAYMENT`,
  `AWAITING_CONFIRMATION`, `UNKNOWN_OUTCOME`, `ACTIVATION_PENDING`, `REVIEW_REQUIRED`,
  `TERMINAL`). It is derived by the owner from stored fields, so it is identical after a
  restart, a lost mutation response or on another device. `GET /residency/orders?state=unresolved`
  is the authorized way to find the user's own unfinished order after losing local storage.
- `expectedTotalMinor` is mandatory and must equal the server-computed total exactly. A
  mode-only request from the previous client is 400 `RESIDENCY_PRICE_CONSENT_REQUIRED` before
  the owner's idempotency lookup; `schemaVersion: 1` does not make it compatible.
- An unknown financial outcome is not promised to disappear after the local payment window.
  The local TTL does not close an order: `PENDING` past the window is `overdue=true` with
  recovery `AWAITING_CONFIRMATION`; local `UNKNOWN` stays `UNKNOWN_OUTCOME` with
  `overdue=false`. Only the owner's confirmed terminal provider result closes an order.

### Configuration

| Variable                     | Meaning                                                                                                                                         |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `RESIDENCY_ORDER_ENABLED`    | Default off. Enabling requires the LK1 owner URL, Viva OAuth, tenant `iSkq6G`, `VIVA_MODE=sandbox\|production` and `VIVA_RESIDENCY_PRODUCT_ID`. |
| `RESIDENCY_OWNER_BASE_URL`   | LK1 origin. Production must be exactly `https://padlhub.su/`.                                                                                   |
| `RESIDENCY_OWNER_TIMEOUT_MS` | One-shot owner timeout, 100..10000 ms, default 8000.                                                                                            |
| `VIVA_RESIDENCY_PRODUCT_ID`  | The same exact product the owner is configured with.                                                                                            |

### Evidence status

The consumer, its tests and a composed chain test against the real LK1 owner modules are
LOCAL: `LK1_RESIDENCY_MODULES_ROOT=<lk@2f7c2d48> npx vitest run
apps/api/src/residency/client-residency-owner-chain.test.ts` (see
`docs/contracts/residency-orders-consumer.md#reproducible-composed-test-for-the-websdk-pr-682`).
The Viva/CUP transport in that test is synthetic; it is not PROVIDER evidence. The LK1 owner is
not installed, its Mongo indexes are not applied and the flag is off, so no STAGING or PRODUCTION
evidence exists for purchase. A provider stand is still required for an end-to-end card payment;
its absence does not block the source or the local integration.

## Out of scope

Per-station product maps, persisted last-known observations, background synchronization and client
presentation are follow-ups. They require a separate product decision and, where persistence is
needed, an expand/contract migration.
