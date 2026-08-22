# Home dashboard read model

## Purpose

The authenticated Home page is a PadlHub-owned read surface. It presents a bounded summary of the
player's current context without making the web or mobile client choose profile, booking,
subscription, community, promotion, chat or tournament sources.

The complete compatibility operation is:

```http
GET /user/api/v1/{tenantKey}/home
Authorization: Bearer <PadlHub JWT>
X-Correlation-ID: <opaque id>
```

Its response is `HomeDashboard` in
`contracts/openapi/user/v1/openapi.yaml`. Every rendered initial block comes from this one response.

ADR 0019 adds the recovery operation:

```http
GET /user/api/v1/{tenantKey}/home/base
Authorization: Bearer <PadlHub JWT>
X-Correlation-ID: <opaque id>
```

Its response is `HomeBase`. Alongside `snapshot` and the PadlHub `viewerUserId`, the first milestone
contains `quickActions`, independently versioned `communities` and `promotions` envelopes,
`locations`, `additionalLinks` and `capabilities`. It excludes the authenticated self profile,
balance, messaging, counters, upcoming bookings and subscriptions; the notification badge remains
a separate PadlHub API concern. The self profile is a separate `profile.read` aggregate whose
transport is selected by the short-lived server routing plan. This two-aggregate page composition
does not permit a client to merge one HomeBase section from multiple sources.

## Legacy request audit

The previous LK Home component performs orchestration in the browser:

| Home concern       | Previous initial behavior                                                                 | Problem                                    | New behavior                                               |
| ------------------ | ----------------------------------------------------------------------------------------- | ------------------------------------------ | ---------------------------------------------------------- |
| Profile            | one profile request                                                                       | separate snapshot and error state          | `profile` in `HomeDashboard`                               |
| Active bookings    | one booking request                                                                       | client merges bookings and games           | bounded `upcoming` projection                              |
| Subscriptions      | active and finished collections requested separately                                      | duplicate full subscription reads          | bounded, display-ready `subscriptions`                     |
| Subscription names | one extra lookup per unnamed subscription                                                 | N+1 hydration                              | normalized `title` in the projection                       |
| Games              | active and recent/result windows loaded in parallel                                       | two overlapping reads on startup           | only upcoming summaries in the projection                  |
| Tournament access  | mechanics request plus a date-by-date scan across roughly 22 days                         | up to 23 reads to calculate one capability | precomputed `capabilities.canManageTournaments`            |
| Communities        | summary loaded at startup; selected community can also warm detail, feed pages and rating | remote widget owns another request graph   | bounded membership summaries only; feed/rating remain lazy |
| Promotion          | independent advertising-settings request                                                  | another source and loading state           | active `promotions` deck in the snapshot                   |
| Chat counter       | initial request followed by 12-second polling                                             | permanent background traffic               | `counters.unreadChats`, later updated by realtime events   |
| History            | full history may be reloaded with bookings                                                | large non-critical payload                 | explicit navigation only                                   |

The old baseline is at least nine startup reads before referral hydration and tournament scanning.
For a user requiring the tournament capability scan, the first screen can exceed thirty reads; chat
polling then continues for the lifetime of the page. The new first screen performs one coalesced
Home request after session restoration.

## Response blocks

The following blocks describe the complete compatibility `HomeDashboard`. The smaller `HomeBase`
subset and its explicit omissions are defined above.

- `snapshot`: opaque version, generation/staleness timestamps and server-owned source marker.
- `profile`: display-ready identity, optional masked phone suffix, signed balance and player level.
- `counters`: unread chats, upcoming events and active subscriptions.
- `quickActions`: at most four server-approved application routes.
- `upcoming`: at most six game, training or tournament summaries.
- `subscriptions`: at most six normalized subscription summaries, including a distinct `paused`
  state for Viva `HOLD` records.
- `communities`: at most ten current memberships with title, verification, chat unread count,
  route and nullable PadlHub-served logo URL; never roles, member totals, feed posts, rankings or
  external identifiers.
- `promotions`: up to twenty active CUP cards in operator order, with the CUP rotation flag,
  a bounded interval and separate desktop/mobile PadlHub WebP URLs. `promotion` temporarily mirrors
  the first card for older clients during expand/migrate rollout.
- `promotionSlots.recommendationCard`: a card promotion owns two independent CUP image assets.
  The compact Home V3 grid uses the square `178 x 178` source and the vertical recommendation list
  uses the horizontal `335 x 164` source. The worker copies and publishes both as separate immutable
  PadlHub media objects; a browser never crops or fetches the CUP asset directly.
- `locations`: at most eight PadlHub locations with PadlHub UUIDs, court counts and optional
  display images. They come from published `LOCAL_ONLY` location profiles, not from a live Viva
  station lookup.
- `additionalLinks`: server-approved routes for promotions, gift certificates and offers.
- `capabilities`: precomputed feature/capability flags; the client never scans source data to infer
  them.

## HomeBase section availability

`HomeBase` is a partial recovery read model rather than a second write owner or a partially trusted
business aggregate. Its community and promotion envelopes can be rendered independently of the
self profile. Each such section has one source revision, its original freshness timestamps and one
state:

| State         | Meaning                                                                                      |
| ------------- | -------------------------------------------------------------------------------------------- |
| `READY`       | The exact local section version is contract-valid and has not passed `staleAt`.              |
| `STALE`       | The last contract-valid version is inside the bounded stale window and stays visibly stale.  |
| `UNAVAILABLE` | No safe local version exists or the maximum stale window passed; no synthetic value is sent. |

Only `READY` and `STALE` may carry a section value, and both require `revision`, `observedAt` and
`staleAt`. A stale value keeps those original fields; serving it does not advance freshness
metadata. `UNAVAILABLE` carries only its state. The top-level snapshot contains `version`,
`generatedAt`, `source=LOCAL_PROJECTION` and `completeness=PARTIAL`, but no global `staleAt`.
Freshness belongs only to the optional section envelopes. Required local fields do not clock-expire
the whole HomeBase response into a `503`.

The web may render the stable local quick actions, locations, additional links and capabilities
while a community or promotion section is stale or unavailable. It must show section-level
loading/stale/unavailable treatment and must not replace an unavailable section with mock, raw Viva
or a field copied from the old complete snapshot.

## Ownership and consistency

Home is a read model, not a new write owner. Commands continue to belong to their profile, booking,
subscription, community, messaging and tournament domains. A production Home projection must be
materialized server-side from committed domain events and served as one versioned snapshot. A
request must never assemble a single block from mixed local, cached and Viva responses.

For `HomeBase`, the same invariant is applied to each versioned community/promotion section: one
returned section is read from one local projection revision. The response may carry different
section revisions because it states their boundaries and freshness explicitly; it never combines
fields within a section. The separate self-profile read is not persisted into HomeBase.

The persisted projection key is `(tenant_id, user_id)`. It stores one complete JSON payload,
monotonic source revision, source-event UUID, checksum and freshness timestamps. Row-level security
is forced, and the payload itself must identify the same PadlHub user UUID. Replaying the same
revision with another payload is a conflict rather than an implicit overwrite.

## Projection input event

`home.projection.component.changed.v1` is a normalized internal event carried by `phub.events`.
Its envelope uses the standard outbox fields and its payload is:

```json
{
  "userId": "PadlHub UUID",
  "component": "profile | messaging | upcoming | subscriptions | communities | promotion | locations | navigation | capabilities",
  "componentRevision": "positive integer",
  "value": "component-specific contract"
}
```

`aggregateId` must equal `userId`; a profile component must carry the same user UUID. Component
schemas are strict and expose no external IDs. Domain adapters publish display-ready PadlHub UUIDs,
routes and normalized values. The event is a projection notification, so it must be inserted into
the domain command's outbox transaction rather than emitted as an independent dual-write.

For the current `VIVA_PRIMARY` profile, booking and subscription reads, the committed producer state
is `integration.viva_home_source_components`. The worker refreshes the encrypted delegation under
the same Redis lease used by the API, calls only Viva End User endpoints through
`@phub/viva-adapter`, resolves profile/booking/subscription IDs in
`integration.external_entity_map`, and atomically advances the component source revision plus an
outbox event. The browser never participates in this fan-out.

Both Viva OAuth and the provider-neutral phone grant may seed that encrypted delegation. A phone
login is rejected before session creation when Viva Home synchronization is required and the
provider does not return a refresh credential; this prevents a fresh authenticated user from being
left permanently at `HOME_PROJECTION_NOT_READY`.

The upstream read sequence is bounded: profile, active booking IDs, one enriched booking-list read
when IDs exist, and active subscriptions. Viva's live subscription response currently returns
`unitsLeft=null` for non-unit variants although its OpenAPI declares a number; the adapter accepts
only that nullability divergence and still validates every field used by Home. External photo URLs
are never passed to clients. The worker fetches `profile.photo` only from an HTTPS host on the
configured allowlist, enforces timeout and byte/pixel limits, strips metadata, converts the image to
WebP and uploads it under a content-addressed `profile-photos/{tenant}/{user}/{sha256}.webp` key.
`integration.user_profile_photo_sync` stores the provider URL and validators; `profile.user_summaries`
stores the current PadlHub delivery URL. That profile update, integration metadata and the profile
component outbox event commit in one tenant transaction. The snapshot contains only a short-lived
signed S3 URL.

When Viva returns the same ETag or Last-Modified value, the worker reuses the existing WebP and only
renews its signed delivery URL. If the source URL or bytes change, a new immutable object is stored,
the transaction points the profile to it and queues the previous object for deletion after both the
signed-URL lifetime and projection stale window have elapsed. A temporary
CDN/image-processing/storage failure preserves the last local photo and does not make the rest of
Home unavailable. When Viva removes `photo`, the local profile is cleared and the previous object
is queued for the same delayed garbage collection.

All three Viva components carry one `fetchedAt`. The projector treats them as a source batch and
does not rebuild while their component timestamps differ; the last event of the batch makes the
group eligible for a new snapshot.

The legacy complete `HomeDashboard` continues to use that three-component coherence rule during
expand/migrate. The initial HomeBase contract omits profile, upcoming bookings and subscriptions,
so it does not claim that batch is fresh. Those Viva-backed sections are not added to HomeBase until
the exact target worker can read bookings, booking details and subscriptions through trusted
user-delegated egress and all responses pass the strict adapter schemas.

The worker consumes from the durable quorum queue `phub.home-projector.v1`, records the event in
`audit.inbox_events`, rejects same-revision/different-payload conflicts, and serializes rebuilds by
user. A snapshot revision advances only after every required component is available. Unread,
upcoming and active-subscription counters are derived inside the builder rather than trusted as a
second source.

External identifiers stay inside integration storage. `HomeDashboard` exposes PadlHub UUIDs only.
Every query is scoped by the tenant resolved from the URL and verified PadlHub JWT claims.

## Promotion engagement boundary

An authenticated client records a card becoming at least 50 percent visible or a card navigation
through `POST /user/api/v1/{tenantKey}/promotions/{promotionId}/engagements`. The body contains only
`IMPRESSION` or `CLICK`; the command requires authorization, tenant resolution, a fresh
`Idempotency-Key` and the normal correlation ID. The public identifier is the PadlHub promotion UUID.

The API resolves the CUP placement and advertising record only from tenant-scoped integration
storage. For click attribution it also resolves the signed-in user's phone from the local profile
summary. The browser never sends a phone, CUP record ID or source selector. The API forwards the
event to CUP over the server-to-server advertising endpoint with a dedicated secret, timeout,
bounded retries, circuit breaking, metrics and redacted logs. CUP deduplicates by event ID and
shows aggregate impressions, clicks, click-through rate and protected phone-level click totals to
authorized operators. Impression events never store a phone. The advertising settings audit log
is written with each CUP settings change and contains operation metadata, not customer data.

## Loading policy

The web gateway coalesces concurrent Home reads, including React StrictMode startup. The response is
private-cacheable for 15 seconds and may be used stale for 45 seconds while the browser revalidates.
This cache is a delivery optimization; the source of truth remains the server-owned projection.

For HomeBase, revalidation does not erase the last contract-valid community or promotion section
when its producer is temporarily unavailable. The API recomputes `READY`, `STALE` or `UNAVAILABLE`
from persisted timestamps and the configured bounded stale window. Browser cache age never
upgrades a section state. A failed self-profile read affects only the profile hero and does not turn
HomeBase into a page-level network error.

The first ten community summaries are part of the snapshot and render immediately on Home. Home
does not carry a continuation cursor. The web client then replaces that fallback with the first
canonical directory page requested with `limit=10`, which supplies the opaque cursor; it never
merges fields from the snapshot and directory versions. Approaching the end of the horizontal rail
loads the next ten-item page. An `UNAVAILABLE` Home community component does not block this
canonical directory bootstrap; the unavailable state is shown only if that read also fails. The
explicit `/communities` route loads active memberships in pages of 20 through
`GET /user/api/v1/{tenantKey}/communities/mine`; community detail, feed pages, rankings, member
management and chat history remain lazy. The same rule applies to booking history and item details.

The personalized `Для меня` feed remains a separate, versioned read because it ranks current Games,
trainings and tournaments against the viewer's preferences. Games and tournament summaries come
from the PadlHub/CUP read boundary; Viva schedule input is accepted only for group trainings and
`Игра + тренер`. A Viva row classified as a tournament is discarded and can never become a
recommendation card. Home V3 requests the first 14 items, then requests 12 at a time as its
recommendation sheet approaches the scroll boundary. Every continuation uses the opaque
`nextCursor` from the server; the cursor is bound to the ranked feed version, so clients append
pages and never re-rank or slice a provider response locally.

Home V3 is the primary authenticated Home rendered at `/`. The former standard Home remains
available at `/home-v3` as an explicit comparison route; `/home-v2` continues to render the second
independent variant. This route mapping changes presentation only and does not change any HomeBase,
profile, upcoming-booking or recommendation data source.

Training hosts are normalized by `@phub/viva-adapter`; tournament organizers use the CUP tournament
summary contract. Provider identifiers and provider photo URLs remain integration-only. Host photos
are exposed only through the PadlHub-owned booking-activity and tournament organizer-avatar routes.
For group trainings and `Игра + тренер`, `levelRange` is derived only from level labels in the
event's textual name/type/direction. One label produces an equal minimum and maximum; no recognized
label produces `null`. Provider `accessLevels` and `ratings` do not override this display-name rule.
The optional training `category` contains a PadlHub UUID and a bounded display label derived at the
adapter boundary from the provider direction, with the exercise type as a fallback for generic
directions. Raw provider category identifiers are never returned. The `/trainings` page consumes
the same versioned client-assisted feed, keeps only group trainings, and filters them by this
normalized category; `Игра + тренер` remains on `/games`.
Both routes read bounded, short-lived integration-side source mappings, enforce the shared media
allowlist and image limits, and return normalized WebP without exposing an upstream URL. The API
may retain the assembled feed in a bounded five-minute in-process delivery cache so a continuation
page does not change when an optional upstream activity read is transiently unavailable; the cached
feed never becomes a write owner or extends the response's `staleAt`.

When `COMMUNITIES_READ_MODE=legacy` or `local`, the worker reads the same server-owned community
directory in its own bounded synchronization cycle and publishes the first ten summaries as the
`communities` component through the transactional outbox. The cycle selects active Home users
without calling or waiting for Viva, so a profile-provider outage cannot block community or logo
updates. The Home API never overlays a live legacy response onto a stored snapshot. A failed
community refresh leaves the last valid component in place and does not fail the independent Viva
profile/upcoming/subscription synchronization.

In legacy mode, a missing local community logo is copied by the worker before the component is
published. The source URL stays in integration storage; only an allowlisted, bounded image is
converted to WebP and stored under the PadlHub community UUID in private object storage. The logo
mapping and community outbox component commit together. Home therefore loads a short-lived signed
PadlHub URL from its existing snapshot and never calls the legacy media endpoint from the browser.
An unchanged legacy asset URL reuses the local object, while a failed refresh retains the previous
logo and a removed source schedules the superseded object for delayed deletion.

When `PROMOTIONS_READ_MODE=legacy`, the worker reads the configured CUP placements once per tenant.
`cabinet_home_top` and `cabinet_home` publish the independent hero and standard decks. Two additional
placements stay inside the same server-owned synchronization boundary:
`cabinet_for_me_strip` publishes a full-width narrow insert for the compact “Для меня” grid, while
`cabinet_for_me_card` publishes an advertising card that becomes full-width in the row
presentation. Each recommendation placement owns a bounded `repeatEveryCards` value from 1 to 20.
The card advertisement repeats by business-recommendation count. In the compact two-column grid,
the strip interval counts every visible one-column card, including the card advertisement, and
waits for a complete row before inserting the full-width strip; this prevents an empty grid cell.
The web client never calls the CUP endpoints. The bridge accepts only active,
ordered public items returned by CUP, maps source IDs through `integration.external_entity_map`,
and publishes the strict `promotion` component independently of Viva. `rotationEnabled=false`
fixes the first active hero/standard item; `true` rotates only when at least two items exist. A
failed source or media refresh leaves the last valid Home component in place.

Legacy advertising image URLs remain integration-only. For every active card the worker downloads
an HTTPS-allowlisted, byte/pixel-bounded source and creates metadata-free WebP derivatives: a
desktop image bounded to 1600×900 and an exact 750×480 mobile crop by default. Both objects are
content-addressed under `promotion-media/{tenant}/{promotion}/{variant}/{sha256}.webp`; Home carries
only short-lived PadlHub delivery URLs and the web uses `<picture>` to select the mobile derivative.
Replaced or deactivated assets enter delayed garbage collection after signed URLs and stale Home
snapshots can no longer reference them.

The web presentation follows the canonical Figma Home frame `743:2014` at 375 logical pixels wide.
The communities strip sits directly below the profile on the purple Hero surface and consumes the
existing `communities` projection; it must not introduce a second startup request.

Published location profile commands emit `locations.profile.changed.v1` in their business
transaction. The locations worker rebuilds the tenant's bounded, ordered Home component and fans a
strict component event to existing Home users. The web row is a touch-native, scroll-snapped
carousel and links to the separate Location User API detail; it does not fetch a second source to
hydrate Home cards.

## Current delivery stage

`HOME_READ_MODE=mock` serves a deterministic synthetic shape for local and CI development,
regardless of whether authentication uses mock or sandbox Viva. `HOME_READ_MODE=projection` reads
only `home.dashboard_snapshots`. A missing projection returns `HOME_PROJECTION_NOT_READY`; an
invalid contract returns `HOME_PROJECTION_INVALID`; a snapshot older than the configured grace
period returns `HOME_PROJECTION_STALE`. Production configuration requires projection mode.

The 2026-07-29 Gate 0 probe is a production-readiness `NO-GO` for the legacy complete Viva-backed
Home components and for adding Viva-backed sections to HomeBase: user-delegation token issuance
succeeded, while exact server/worker reads for profile, bookings and subscriptions returned `403`;
booking details were not attempted because no authorized booking-list identifier was available.
The redacted correlations and latency evidence are recorded in
[ADR 0019](../adr/0019-home-base-and-viva-egress-gate.md). Until trusted egress passes, those
sections remain outside the HomeBase contract.

The controlled importer in `scripts/import-home-projection.ts` validates a full snapshot and is an
initial fill/recovery mechanism, not the continuous producer. It must receive a backend-produced
snapshot from one consistent source revision; a browser-composed set of legacy responses is not an
acceptable input.

`scripts/enqueue-home-component.ts` is a dry-run/apply backfill and smoke utility. Normal production
component events are emitted by their domain transaction, not by this script.

`HOME_VIVA_SYNC_ENABLED` is retired and rejected. Viva-owned Home data is refreshed through
client-assisted browser jobs. PadlHub-owned producers have independent default-off worker gates:
`COMMUNITY_HOME_SYNC_ENABLED` for Community summaries and `PLATFORM_HOME_SYNC_ENABLED` for
messaging, navigation, capabilities and the one-time LOCAL_ONLY location fan-out. Each gate has its
own interval and batch size and does not change `HOME_READ_MODE`.

`PROMOTIONS_READ_MODE=legacy` independently activates the CUP advertising producer and requires
private object storage. Production forbids `PROMOTIONS_READ_MODE=mock`; operators continue to add,
order, activate and deactivate cards in CUP Block 2. On Nano, the worker reaches the showcase API
only through the private `phab-showcase_default` Docker network; the browser-facing Basic Auth
showcase is not used as a service endpoint.
