# ADR 0019: HomeBase recovery and Viva egress gate

- Status: Accepted
- Date: 2026-07-29
- Amends: [ADR 0005](0005-viva-user-delegation-and-direct-transport.md)
- Partially supersedes: [ADR 0007](0007-home-dashboard-read-model.md)

## Context

The authenticated Viva OAuth flow can exchange an authorization code and verify the resulting JWT
while Viva rejects End User reads made from PadlHub server or worker egress. The existing
`VivaHomeSourceAdapter` reads profile, bookings, booking details and subscriptions as one sequential
pull. A `403` on the first profile request therefore prevents every Viva-backed Home component from
advancing, the complete `HomeDashboard` snapshot becomes stale, and the API eventually returns
`HOME_PROJECTION_STALE`.

The authenticated user's own profile can use the already-approved browser-direct `profile.read`
through a short-lived user delegation. That exception does not make booking and subscription reads
safe for direct product use: their Viva payloads contain provider identifiers and currently cannot
be normalized into complete PadlHub DTOs with PadlHub UUIDs without a trusted server-side mapping
step.

Home also contains PadlHub-owned data such as quick actions, capabilities, locations, communities,
promotions and additional links. The initial recovery milestone can expose those fields without
waiting for an unrelated Viva profile request. Messaging and counters are not part of `HomeBase`;
the notification badge remains a separate PadlHub API concern.

## Gate 0 evidence

On 2026-07-29 a read-only diagnostic used the existing user-delegation refresh path and the exact
local server/worker egress. It logged only operation metadata; no token, provider identifier,
request payload or personal data was written to a file or log.

| Operation               | Correlation ID                         | Result        | Latency | Schema outcome  |
| ----------------------- | -------------------------------------- | ------------- | ------- | --------------- |
| delegation access-token | `3f9e14b1-30ac-4beb-93a5-c895e27011e1` | `200`         | 610 ms  | valid token DTO |
| `profile.read`          | `606f90e2-89fc-405d-ae62-e936f651ce55` | `403`         | 521 ms  | not validated   |
| `bookings.read`         | `489852a5-b4d3-4e7d-8527-376aee81a56f` | `403`         | 368 ms  | not validated   |
| `bookings.details.read` | `6b673038-74c3-4d8d-b5cf-bfb02c602a5c` | not attempted | n/a     | not attempted   |
| `subscriptions.read`    | `928ee24e-47bb-4b86-ad06-d558c1341a08` | `403`         | 133 ms  | not validated   |

Booking details were not called because the forbidden booking-list read did not produce a booking
identifier that the diagnostic was authorized to use. Authorization-only control requests, without
`X-Correlation-ID`, also returned `403` for profile, bookings and subscriptions. The correlation
header is therefore not the cause.

This is a `NO-GO` for treating profile separation alone as a complete Home synchronization repair.

## Decision

Adopt two complementary paths.

### A. Additive HomeBase recovery

Add the protected operation:

```http
GET /user/api/v1/{tenantKey}/home/base
```

Its public schema and SDK type are `HomeBase`. Alongside `snapshot` and the PadlHub
`viewerUserId`, the first milestone contains `quickActions`, `communities`, `promotions`,
`locations`, `additionalLinks` and `capabilities`. It deliberately excludes profile, balance,
messaging, counters, upcoming bookings and subscriptions. The authenticated self profile remains a
separate routed `profile.read` aggregate, and notification badges use their separate PadlHub API.

`communities` and `promotions` are independently versioned availability sections. Each uses one
explicit state:

- `READY`: the section is contract-valid and its `staleAt` has not passed;
- `STALE`: the section is the last contract-valid local version, its original `observedAt` and
  `staleAt` remain visible to the client, and it is still inside the bounded operator-approved
  stale-serving window;
- `UNAVAILABLE`: no contract-valid local version exists or the maximum stale-serving window has
  passed; the section has no synthetic or provider fallback value.

`READY` and `STALE` require `revision`, `observedAt`, `staleAt` and the value from that exact local
section revision. `UNAVAILABLE` contains only its state and must not include a fabricated value. The
top-level snapshot carries `version`, `generatedAt`, `source=LOCAL_PROJECTION` and
`completeness=PARTIAL`; it has no global `staleAt`. Its version describes only the HomeBase response
composition and is not presented as one shared business source revision. Freshness belongs only to
the optional section envelopes. Required local fields do not clock-expire the whole response into a
global `503`.

The web client may render the community and promotion sections independently. A `STALE` section
must have a visible stale treatment and must not be represented as fresh. An `UNAVAILABLE` section
gets a bounded section-level empty/error state rather than replacing the whole authenticated LK
with “Главная недоступна”. The client does not merge a HomeBase section with a live Viva response,
another cache or the old complete Home snapshot.

The current `GET /home` and `HomeDashboard` remain during expand/migrate compatibility. New clients
switch to `/home/base` only after its contract, local projection read path and browser failure
isolation have passed staging. Removing the old endpoint and profile component is a later contract
release.

### B. Restore trusted user-delegated Viva egress

Legacy complete-Home Viva components, and any future Viva-backed extension to `HomeBase`, become
fresh only after Viva permits the PadlHub worker to perform the required End User reads with the
user's short-lived delegation. The accepted production path is trusted server/worker egress with
the existing timeout, bounded retry, circuit breaker, redacted metrics, external-ID mapping and
transactional outbox behavior.

The B gate requires all of the following from the exact target worker runtime:

1. `bookings.read`, `bookings.details.read` and `subscriptions.read` return `2xx`;
2. every response passes its strict adapter schema;
3. the worker maps every external booking and subscription ID to a PadlHub UUID before publishing;
4. one source pull gives the related Viva-backed components one coherent `fetchedAt`;
5. no system key, refresh token, provider payload or provider identifier reaches the browser,
   projection payload, logs or analytics.

Until that gate passes, the existing complete Home remains stale/unavailable and no Viva-backed
section is added to HomeBase. Increasing a stale window requires an explicit incident decision and
does not make the data fresh.

## Rejected alternatives

### Browser relay into the projection

The browser must not fetch raw Viva bookings or subscriptions and post them back for persistence.
The browser is not a trusted projection producer, cannot authorize canonical external-ID mapping,
and would turn an ephemeral read exception into an unaudited write path.

### Enabling direct bookings or subscriptions immediately

Only `profile.read` is currently in `DIRECT_VIVA_CONTRACT_READY_OPERATIONS`. Booking-list,
booking-detail and subscription responses cannot be enabled until their normalizers emit complete
PadlHub DTOs with PadlHub UUIDs and a separate ADR accepts the resulting boundary.

### Refreshing the old Home snapshot with an old profile component

Advancing a complete `HomeDashboard` revision while retaining an older profile component would make
the snapshot timestamp misrepresent its contents and violate the one-source/version rule. HomeBase
instead exposes each section's actual version and freshness.

### Silent stale or mock fallback

Production must not label an expired local value or synthetic mock as current Viva-backed data.
Stale data is available only through the explicit `STALE` state and bounded window.

## Consequences

- A profile-provider outage no longer hides independent PadlHub-owned Home sections.
- The authenticated page performs a separate routed self-profile read and one PadlHub HomeBase read;
  this is explicit composition of different aggregates, not a field-level source merge.
- HomeBase clients require section-level loading, stale and unavailable presentation for the
  versioned community and promotion envelopes.
- The complete HomeDashboard projection and endpoint remain available only for compatibility during
  expand/migrate.
- A green HomeBase rollout does not imply that omitted Viva-backed bookings or subscriptions are
  fresh.
- The B gate must be repeated in staging and production whenever Viva egress policy, provider
  tenant, OAuth client, callback origin or network route changes.
- Commands, cancellations, purchases and other writes remain behind PadlHub APIs with authorization,
  idempotency and audit.
