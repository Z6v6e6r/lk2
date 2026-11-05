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

## Out of scope

Per-station product maps, persisted last-known observations, background synchronization and client
presentation are follow-ups. They require a separate product decision and, where persistence is
needed, an expand/contract migration.
