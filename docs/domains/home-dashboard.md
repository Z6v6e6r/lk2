# Home dashboard read model

## Purpose

The authenticated Home page is a PadlHub-owned read surface. It presents a bounded summary of the
player's current context without making the web or mobile client orchestrate profile, bookings,
subscriptions, communities, promotion, chat or tournament sources.

The public operation is:

```http
GET /user/api/v1/{tenantKey}/home
Authorization: Bearer <PadlHub JWT>
X-Correlation-ID: <opaque id>
```

Its response is `HomeDashboard` in
`contracts/openapi/user/v1/openapi.yaml`. Every rendered initial block comes from this one response.

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

- `snapshot`: opaque version, generation/staleness timestamps and server-owned source marker.
- `profile`: display-ready identity, optional masked phone suffix, signed balance and player level.
- `counters`: unread chats, upcoming events and active subscriptions.
- `quickActions`: at most four server-approved application routes.
- `upcoming`: at most six game, training or tournament summaries.
- `subscriptions`: at most six normalized subscription summaries, including a distinct `paused`
  state for Viva `HOLD` records.
- `communities`: at most five current memberships with title, verification, chat unread count,
  route and nullable PadlHub-served logo URL; never roles, member totals, feed posts, rankings or
  external identifiers.
- `promotions`: up to twenty active CUP cards in operator order, with the CUP rotation flag,
  a bounded interval and separate desktop/mobile PadlHub WebP URLs. `promotion` temporarily mirrors
  the first card for older clients during expand/migrate rollout.
- `locations`: at most eight PadlHub locations with PadlHub UUIDs, court counts and optional
  display images. They come from published `LOCAL_ONLY` location profiles, not from a live Viva
  station lookup.
- `additionalLinks`: server-approved routes for promotions, gift certificates and offers.
- `capabilities`: precomputed feature/capability flags; the client never scans source data to infer
  them.

## Ownership and consistency

Home is a read model, not a new write owner. Commands continue to belong to their profile, booking,
subscription, community, messaging and tournament domains. A production Home projection must be
materialized server-side from committed domain events and served as one versioned snapshot. A
request must never assemble a single block from mixed local, cached and Viva responses.

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

The worker consumes from the durable quorum queue `phub.home-projector.v1`, records the event in
`audit.inbox_events`, rejects same-revision/different-payload conflicts, and serializes rebuilds by
user. A snapshot revision advances only after every required component is available. Unread,
upcoming and active-subscription counters are derived inside the builder rather than trusted as a
second source.

External identifiers stay inside integration storage. `HomeDashboard` exposes PadlHub UUIDs only.
Every query is scoped by the tenant resolved from the URL and verified PadlHub JWT claims.

## Loading policy

The web gateway coalesces concurrent Home reads, including React StrictMode startup. The response is
private-cacheable for 15 seconds and may be used stale for 45 seconds while the browser revalidates.
This cache is a delivery optimization; the source of truth remains the server-owned projection.

The first five community summaries are part of the snapshot because they are visible on Home. Home
does not carry a continuation cursor and does not make a second startup request. The explicit
`/communities` route loads active memberships in pages of 20 through
`GET /user/api/v1/{tenantKey}/communities/mine`; community detail, feed pages, rankings, member
management and chat history remain lazy. The same rule applies to booking history and item details.

When `COMMUNITIES_READ_MODE=legacy` or `local`, the worker reads the same server-owned community
directory in its own bounded synchronization cycle and publishes the first five summaries as the
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

When `PROMOTIONS_READ_MODE=legacy`, the worker reads the existing public CUP placement once per
tenant from `GET /api/advertising/cabinet-home`; the web client never calls that endpoint. The
bridge accepts only the active, ordered public items returned by CUP, maps source IDs through
`integration.external_entity_map`, and publishes the strict `promotion` component independently of
Viva. `rotationEnabled=false` fixes the first active item; `true` rotates only when at least two
items exist. A failed source or media refresh leaves the last valid Home component in place.

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

The controlled importer in `scripts/import-home-projection.ts` validates a full snapshot and is an
initial fill/recovery mechanism, not the continuous producer. It must receive a backend-produced
snapshot from one consistent source revision; a browser-composed set of legacy responses is not an
acceptable input.

`scripts/enqueue-home-component.ts` is a dry-run/apply backfill and smoke utility. Normal production
component events are emitted by their domain transaction, not by this script.

`HOME_VIVA_SYNC_ENABLED=true` activates the first real source producers in `apps/worker` with a
bounded batch, interval and failure backoff. It does not change `HOME_READ_MODE`. A user remains in
the projector's `waiting` state until every component is present. The same worker gate also enables
the canonical PadlHub platform producer: `messaging` is calculated from conversation read cursors,
`navigation` from server product configuration and `capabilities` from the tenant-scoped access
profile. It performs a one-time `locations` fan-out from the existing LOCAL_ONLY location projection
revision when a user has no location component; later location changes remain owned exclusively by
the location domain event producer. Duplicate PadlHub users resolving to one Viva profile are
rejected as `EXTERNAL_ID_MAPPING_CONFLICT`; the producer never silently reassigns the profile
mapping.

`PROMOTIONS_READ_MODE=legacy` independently activates the CUP advertising producer and requires
private object storage. Production forbids `PROMOTIONS_READ_MODE=mock`; operators continue to add,
order, activate and deactivate cards in the existing CUP advertising screen.
