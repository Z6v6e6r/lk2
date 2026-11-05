# ADR 0027: Server-owned client residency read

- Status: accepted (implementation slice; provider activation pending product creation)
- Date: 2026-11-05
- Related: [ADR 0002](0002-viva-boundary.md), [ADR 0019](0019-home-base-and-viva-egress-gate.md)

## Context

A player may hold a club residency product in Viva. The product does not exist yet; the operator
will create it and supply its exact Viva product ID later. The cabinet needs one server-owned answer
to a single question: does this verified user have a valid residency, and how fresh is that answer?

The answer must not be guessed from a subscription name, class category or the mere presence of any
subscription. It must not use synthetic data as a production fallback, and it must not create a
visit, booking, write-off or any other Viva change.

## Decision

Add one authenticated read: `GET /user/api/v1/{tenantKey}/residency`. Tenant and user identity come
only from the route and verified PadlHub JWT; the request accepts no user, tenant, provider or
product selector. A new module in `@phub/viva-adapter` reads the client's own subscriptions from the
existing server-side Viva Admin integration and classifies only the exact configured product.

The configured product ID is `VIVA_RESIDENCY_PRODUCT_ID`. Its default is empty, which keeps the
endpoint in an explicit `UNAVAILABLE` / `PRODUCT_NOT_CONFIGURED` state. A non-empty value must be a
UUID and requires `VIVA_MODE=sandbox|production` plus `VIVA_API_URL` and `VIVA_API_KEY`. Production
never substitutes mock or synthetic residency data.

The method returns a normalized state:

- `ACTIVE` — a complete provider read found a valid instance of the exact product;
- `NONE` — a complete provider read proved that no valid instance exists;
- `UNAVAILABLE` — no trustworthy conclusion was possible; the response names the reason and never
  reports absence.

`checkedAt` is set only by a complete provider read. A partial, ambiguous or failed read returns
`UNAVAILABLE` with `checkedAt: null`. Locally cached or synthetic timestamps never claim freshness.

The Viva client ID is resolved server-side from the unique synced `viva_profile` integration
mapping. The subscription list is read completely within a bounded page/item budget; an incomplete
list, inconsistent pagination, unknown product identity or a conflicting owner alias is
`UNAVAILABLE`, never `NONE`. The station scope is the authenticated tenant: this slice does not
invent a station-to-product map before the operator creates the product.

The holder name and avatar are the existing PadlHub profile summary and stable profile-photo
delivery URL. No Viva profile payload is merged into the response.

## Consequences

- The slice is read-only and safe to roll out behind configuration; no migration or provider write
  is involved.
- Activation requires the operator to create the Viva product and set its exact ID. Until then the
  method answers `UNAVAILABLE`, never a fabricated `NONE` or synthetic `ACTIVE`.
- Per-station residency products, persistence of prior observations and client UI are separate
  follow-ups; they need a concrete product decision and, for persistence, a migration.
- Provider rate limiting inherits the adapter timeout, bounded retry, circuit breaker and redacted
  metrics policy.
