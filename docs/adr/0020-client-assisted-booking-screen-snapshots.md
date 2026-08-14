# ADR 0020: Client-assisted booking screen snapshots

- Status: accepted for `FOR_ME`, `GROUP_TRAININGS`, `MY_BOOKINGS` and `ACTIVITY_HISTORY`; production rollout pending
- Date: 2026-07-30
- Extends: [ADR 0005](0005-viva-user-delegation-and-direct-transport.md)
- Extends: [ADR 0012](0012-booking-recommendations-first-slice.md)

## Context

PadlHub server and worker egress receives `403` from Viva End User schedule reads, while a
short-lived user delegation used by the browser can read the same
`/v1/{providerTenantKey}/exercises?date=...` route successfully with HTTP `200` and CORS.

The current mixed routing plan exposes only `profile.read`. `schedule.read`, `bookings.read` and
`bookings.details.read` are not contract-ready because a raw provider response must not enter React
state, product URLs, persistence, analytics or logs, and provider identifiers must not become
public identifiers.

Home currently loads both upcoming bookings and booking recommendations eagerly. The target product
has three independently activated screens:

- `Для меня`: a recommendation feed containing games, trainings and tournaments only when they
  satisfy the current user's recommendation policy;
- `Групповые тренировки`: the current schedule catalog, including full and level-incompatible
  activities, with the training-type taxonomy supplied by the current provider schedule;
- `Мои записи`: the complete booking timeline for the current user, without recommendation
  filtering.

## Decision

Introduce a server-directed, client-assisted read job. PadlHub chooses the operation, exact Viva
route vocabulary, date range, limits and expiry. The browser executes those read-only commands with
a short-lived user access token and immediately relays the bounded response to PadlHub for strict
validation, identifier mapping and screen-snapshot construction.

The browser is a transport participant, not the data owner:

1. it never receives a system key or refresh token;
2. it cannot supply an arbitrary Viva URL or HTTP method;
3. raw Viva payload is confined to `@phub/viva-client-adapter` and is not returned to application
   state;
4. commands remain PadlHub API operations;
5. the resulting screen DTO contains only PadlHub UUIDs and opaque cursors.

The implementation enables `schedule.read` inside authenticated, short-lived `FOR_ME` and
`GROUP_TRAININGS` jobs, the fixed `bookings.read -> bookings.details.read` chain inside
`MY_BOOKINGS`, and one bounded `bookings.history.read` page inside `ACTIVITY_HISTORY`. It does not
add any of those operations to the general-purpose `DIRECT_VIVA_CONTRACT_READY_OPERATIONS`
allowlist. History keeps its dedicated PadlHub activity-history projection; only provider-page
transport is client-assisted.

The browser cannot provide booking detail identifiers. `@phub/viva-client-adapter` extracts at most
50 active identifiers from the immediately preceding list response and uses only those identifiers
for the details read. PadlHub then:

1. validates that every accepted detail belongs to the active list;
2. resolves only integration mappings previously written by trusted worker/import paths;
3. prefers a known canonical Game route when an exercise mapping exists;
4. emits a stable, opaque PadlHub snapshot UUID for an as-yet-unmapped booking;
5. stores only the provider-free screen item in the short-lived job result.

## Screen contracts

### `Для меня`

Activation starts a `FOR_ME` read job with seven server-issued Moscow-date commands. Home executes
today plus the next two dates first and completes the job as an explicitly partial snapshot. Once
that slice is rendered, Home executes the remaining four commands only when fewer than six eligible
recommendations were found. The second completion uses all accepted results and replaces the
partial page, so separately ranked feeds are never merged in React. Direct Viva reads run with
concurrency three.

Tournament reads follow the same progressive boundary without entering the browser transport. The
first three-day Home completion does not wait for the legacy tournament adapter. After those cards
render, a sufficiently populated slice is recompleted with at most the first two tournament dates
and no additional Viva calls. A sparse slice instead executes the remaining four Viva commands and
recompletes with the full accepted tournament range. The adapter's fresh/stale cache and
single-flight behavior are retained. `GROUP_TRAININGS` continues to execute all seven schedule
commands immediately.

The job gathers:

- PadlHub public scheduled Games projections;
- CUP tournament summaries through the PadlHub tournament adapter;
- Viva schedule rows only for group trainings and `Игра + тренер`;
- the user's canonical level;
- explicit station and time-window preferences;
- bounded, aggregate history affinity when `useHistory=true`.

Each source row is normalized independently. Fields from local, CUP and Viva representations of the
same activity are never merged. Viva tournament rows are rejected at the schedule-result boundary;
tournaments have one recommendation source, the CUP adapter. Integration mappings may replace a
provider row with one canonical PadlHub activity; otherwise an accepted Viva training row remains a
read-only provider activity with an opaque PadlHub screen identifier.

The recommendation policy applies in this order:

1. reject past, cancelled, hidden or non-bookable activities;
2. reject full activities without a wait-list action;
3. reject known level mismatches;
4. reject activities already present in `Мои записи`;
5. calculate the versioned recommendation decision from level, station, preferred time and allowed
   history affinity;
6. keep only `recommended=true`;
7. diversify the remaining feed across game, training and tournament kinds without inserting an
   item below the recommendation threshold.

The UI never backfills the feed with irrelevant games merely to fill a page. When no activity
passes the policy it shows an honest empty state and a link to recommendation settings.

### `Групповые тренировки`

Activation starts a `GROUP_TRAININGS` read job for seven Moscow dates. It uses the same fixed
schedule commands as `FOR_ME`, but builds a dedicated provider-free catalog instead of passing the
rows through recommendation ranking.

Every normalized row in the current group-training product taxonomy is retained, including filled
activities and activities outside the current user's level. The allowlist matches the current
cabinet: three group levels (`С/С+`, `D`, `D+`), three `Игра+Тренер` levels (`C`, `D`, `D+`) and
`Сплит D` / `Сплит D+`. Trial, child, individual and internal schedule directions stay outside this
screen. The API de-duplicates by PadlHub activity UUID, sorts by start time and returns at most 500
rows. The type filter's stable UUID and display label come from the normalized Viva direction,
without exposing a Viva identifier.

The public title uses the same normalized type label shown in the filter. Cards keep the PadlHub
station, court, trainer-media proxy and availability fields; the provider address and provider
media URL are not exposed.

### `Мои записи`

Activation first reads the dedicated local `/bookings/upcoming` projection. A fresh projection is
rendered without contacting Viva. An absent or stale projection starts a `MY_BOOKINGS` read job;
the browser gathers the allowlisted Viva booking list/details required for the same user and
relays the fixed result to PadlHub.

The upcoming slice uses the direct Viva list/details pair as one consistent source operation. It
does not merge fields from the older Home projection. Existing PadlHub mappings contribute identity
and route resolution only, never provider business fields. A missing mapping does not hide a valid
booking. The normalized result replaces `booking.upcoming_booking_projection` atomically. The UI
then rereads `/bookings/upcoming`; a failed browser read leaves a still-servable stale projection
visible and never falls back to server Viva egress.

All canonical records are returned. Recommendation score, station preferences and preferred time
must never hide an existing booking. The screen supports:

- `Предстоящие` and `История`;
- filters `Все`, `Игры`, `Тренировки`, `Турниры`;
- confirmed, wait-list and payment-required states;
- an explicit partial-data notice when one source is unavailable.

History is loaded only when the `История` scope is activated.

### `ACTIVITY_HISTORY`

The browser first starts a history read job. PadlHub inspects the authenticated user's projection
state and returns either no command, page zero for an uncovered/stale projection, or the next fixed
provider page for partial coverage. The browser cannot choose a Viva URL, tenant, method or page.

The accepted response is strictly validated and normalized by `@phub/viva-adapter`, then the
existing history projector resolves canonical Game associations and persists the provider-free
page. `GET /bookings/history` continues to serve only the local projection. A failed browser read
leaves an existing stale projection readable and never falls back to server Viva egress.

## Proposed API

### Start a read job

`POST /user/api/v1/{tenantKey}/booking-screen-read-jobs`

Required headers:

- `Authorization: Bearer <PadlHub JWT>`;
- `X-Correlation-ID`;
- `X-App-Platform`.

Request:

```json
{
  "screen": "FOR_ME"
}
```

`screen` is `FOR_ME`, `GROUP_TRAININGS` or `MY_BOOKINGS`. A `MY_BOOKINGS` job returns exactly one
command with `operation=bookings.read`, `detailsOperation=bookings.details.read`, `page=0` and
`size=50`. `FOR_ME` and `GROUP_TRAININGS` return fixed `schedule.read` commands.

Response:

```json
{
  "jobId": "PadlHub UUID",
  "expiresAt": "RFC 3339",
  "commands": [
    {
      "commandId": "opaque",
      "operation": "schedule.read",
      "date": "2026-07-30"
    }
  ],
  "concurrency": 3
}
```

The API does not return an arbitrary URL. `@phub/viva-client-adapter` constructs the URL from the
signed operation vocabulary and the short-lived routing plan.

### Submit one command result

`POST /user/api/v1/{tenantKey}/booking-screen-read-jobs/{jobId}/results/{commandId}`

The result is bound to the authenticated tenant, user, job, operation, date, routing revision and
expiry. A schedule response is bounded to 5 MiB in the browser adapter; the JSON relay endpoint has
a 6 MiB HTTP body limit so transport framing cannot reject a response the domain boundary accepts.
The API validates content type, decompressed size, schema, item count and time range before any
mapping or projection work.

### Complete the job

`POST /user/api/v1/{tenantKey}/booking-screen-read-jobs/{jobId}/complete`

The response is discriminated by `screen`. `FOR_ME` wraps the immutable recommendation page:

```json
{
  "screen": "FOR_ME",
  "state": "READY",
  "completedCommands": 7,
  "totalCommands": 7,
  "page": {
    "version": "sha256",
    "generatedAt": "RFC 3339",
    "staleAt": "RFC 3339",
    "personalization": "EXPLICIT",
    "items": [],
    "nextCursor": null
  }
}
```

`MY_BOOKINGS` returns the provider-free `UserUpcomingBookings` snapshot in `bookings`; a partial
result has `staleAt == generatedAt`, so the existing UI shows an explicit stale-data notice instead
of presenting an empty provider response as fresh.

`GROUP_TRAININGS` returns the provider-free `TrainingSchedulePage` snapshot in `trainings`. The
first slice has no personalization field or cursor and filters its bounded seven-day payload
locally. ADR 0021 supersedes that local-filtering decision for discovery screens: the V2 catalog
must filter before pagination and continue an immutable, filter-bound snapshot.

The snapshot version covers preference version, player level revision, local projection revisions,
the validated direct-read result digests and recommendation-policy version.

## Activation and cache policy

Each screen has its own state machine:

`IDLE -> STARTING_JOB -> READING_VIVA -> NORMALIZING -> READY | PARTIAL | EMPTY | ERROR`

- mounting Home activates the default `Для меня` screen and loads only that screen;
- the inactive `Мои записи` screen does not load until its tab is activated;
- activating a screen loads it when no fresh snapshot exists;
- returning to a screen reuses its snapshot for 60 seconds;
- Home expands a sparse three-day `FOR_ME` snapshot on the same short-lived job instead of starting
  a second seven-day job;
- an explicit refresh always creates a new job;
- rapid tab switching aborts browser reads that have not been submitted;
- one Viva `401` permits one token refresh and one replay;
- `403`, `429`, timeout and schema mismatch do not fall back to server Viva egress;
- partial data is labelled and never presented as a complete snapshot.

## UI blueprint

### `Для меня`

1. Tabs: `Для меня` / `Мои записи`.
2. Optional kind filters: `Все`, `Игры`, `Тренировки`, `Турниры`, applied only to the already
   recommended snapshot.
3. Recommendation cards with activity kind, date/time, station, level, availability and at least
   one explainable reason in the full-screen view.
4. Footer actions: `Настроить рекомендации` and `Показать ещё`.
5. Empty state: no relevant activities in the current horizon, never a generic connection error.

### `Мои записи`

1. Tabs: `Для меня` / `Мои записи`.
2. Scope: `Предстоящие` / `История`.
3. Two-week calendar and kind filters.
4. Complete booking cards with status and canonical route.
5. Partial-data notice above the list; source-specific retry does not hide the other source.

## Security and trust boundary

- the Viva access token lives in browser memory only and is redacted from every error;
- the browser uses `credentials: omit` and only the `Authorization` request header for Viva;
- read jobs expire after at most 120 seconds and are single-use per command;
- result submission is rate-limited, idempotent and bound to the PadlHub session;
- raw provider payload is not persisted; only canonical integration mappings, digests, bounded
  audit metadata and the public screen DTO may survive completion;
- client-relayed payload is untrusted and can influence only read-only screen snapshots;
- booking, cancellation, payment and every other command re-read trusted canonical state and stay
  behind PadlHub authorization, audit and idempotency.

## Rollout gates

1. Prove exact Viva CORS behavior from production `padlhub.ru`, not only localhost. Confirmed on
   2026-07-30 for schedule, booking-list and booking-details preflights: HTTP `200`, exact
   `Access-Control-Allow-Origin: https://padlhub.ru`, and only the required `authorization` request
   header.
2. Freeze and test the Viva schemas for schedule, booking list and booking details. Completed
   locally; production response parity remains a rollout check.
3. Add strict client and server normalizers that emit no provider identifier. Completed for
   schedule and upcoming bookings.
4. Prove canonical duplicate resolution between Viva rows and local Games.
5. Prove recommendation parity for all three activity kinds and the no-backfill threshold rule.
6. Prove `Мои записи` never applies recommendation filtering. Covered by API/browser tests for the
   upcoming slice.
7. Add timeout, payload-size, rate-limit, replay and malformed-result tests.
8. Keep the existing global direct-read kill switch and add a dedicated tenant read-job allowlist
   before production rollout.
9. Run the mixed-mode browser smoke and confirm zero server Viva schedule/booking/history egress.
10. Update ADR 0005, ADR 0012 and the client-routing runbook before production rollout. The
    first-slice OpenAPI contract is already published in the repository.

### Nano staging activation

Nano staging treats this browser transport as independent from the server-owned Home projection.
`CLIENT_ASSISTED_VIVA` preserves `HOME_READ_MODE`, sets `HOME_VIVA_SYNC_ENABLED=false`, disables the
legacy Viva Home Game bridge and enables `VIVA_DIRECT_READ_ENABLED=true` only after an audited
target-tenant `MIXED_END_USER_READS` plan exists. Its verifier checks exact
`https://lk.nano.padlhub.su` CORS, active delegation and provider binding coverage, anonymous route
boundaries for recommendation, schedule, upcoming-booking and history jobs, and absence of an
out-of-scope mixed tenant. A failure restores the previous runtime override; the ordinary immutable
release rollback remains the outer safety boundary.

This staging profile does not waive the production rollout gates above and does not enable a Viva
write path.

## Consequences

- the user's network path can read Viva when PadlHub egress is blocked;
- recommendation logic remains server-owned, versioned and explainable;
- the two screens fail and refresh independently;
- upcoming `Мои записи` is projection-first and no longer depends on server Viva egress;
- booking history remains a separate lazy PadlHub projection whose provider pages use the same
  client-assisted trust boundary;
- the design introduces an untrusted relay boundary and therefore requires more validation than a
  normal direct-read adapter;
- no direct Viva write is enabled;
- until every rollout gate passes, the deployed operation vocabulary remains unchanged.
