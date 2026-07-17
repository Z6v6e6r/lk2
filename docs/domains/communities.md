# Communities domain

## Purpose and first slice

The communities contour owns PadlHub communities and user memberships. The first implemented slice
is deliberately narrow:

- a canonical `communities.communities` aggregate identified by a PadlHub UUID;
- tenant/user-scoped memberships that prevent duplicate active owners;
- a protected, cursor-paginated list of the authenticated user's active memberships;
- a five-item summary projection embedded in Home;
- a temporary server-side read adapter for the current LK community store.

Community creation, detail, join/invite commands, member moderation, feed, rating and chat history
remain later vertical slices. Community chat itself belongs to `messaging`; this domain stores no
messages and does not invent an independent unread source.

## Public read contracts

Home returns no more than five `CommunitySummary` items. Each item contains only:

```json
{
  "id": "PadlHub UUID",
  "title": "Padel Friends",
  "logoUrl": "https://media.padlhub.example/.../logo.webp?signed=...",
  "isVerified": true,
  "unreadChatCount": 2,
  "route": "/communities/{PadlHub UUID}"
}
```

Opening `/communities` calls:

```http
GET /user/api/v1/{tenantKey}/communities/mine?limit=20&cursor=opaque
Authorization: Bearer <PadlHub JWT>
X-Correlation-ID: <opaque id>
```

The response contains at most 50 items and an optional `nextCursor`. The cursor is a PadlHub-owned
keyset position, not a legacy offset or identifier. Ordering is pinned memberships first, then
latest known activity, then UUID for deterministic ties. The web gateway coalesces concurrent first
page reads and the API permits a short private cache. A continuation read never repeats identity
parameters from the browser.

## Canonical storage and invariants

`communities.communities` and `communities.memberships` are tenant-RLS tables. Every community and
membership key includes `tenant_id`. An active community may have only one active `OWNER`
membership. Owner membership cannot be pending or inactive. Archived community state carries an
`archived_at` timestamp. Logos are represented by a PadlHub object key, never a provider URL.

The unique index guarantees at most one active owner. The later create/transfer commands must also
guarantee that an active community is never left without an owner in the same transaction.

The domain is `LOCAL_ONLY`: there is no Viva community write owner. Creation and membership commands
will eventually commit canonical state, audit and outbox in one PostgreSQL transaction. Until those
commands ship, the new tables are an expand-only foundation and the legacy bridge remains read-only;
there is no dual-write.

## Temporary LK read bridge

`COMMUNITIES_READ_MODE=legacy` explicitly enables the bridge. The API resolves the authenticated
PadlHub user to server-only phone/Viva profile identity, calls the fixed
`/lk/communities?view=summary` source and treats the response as untrusted integration input. It
selects only rows whose single summary member matches that server-resolved identity. Open catalog
rows and other members are discarded.

Legacy community IDs are mapped to PadlHub UUIDs in `integration.external_entity_map` under
`LK_LEGACY/community`. The response drops members, phones, client IDs, connections, invite data and
all other legacy fields. `logoUrl`, `logoThumbUrl` and `logo` are accepted only as internal media
hints; they never enter the User API or Home event. `unreadChatCount` stays zero in the bridge until
the messaging read-cursor projection supplies it.

Older community rows expose relative `/lk/media/...` paths, while newer rows expose absolute URLs.
Relative paths are resolved only against the fixed `COMMUNITIES_LEGACY_BASE_URL`; the worker then
applies the same media-host allowlist to the resulting absolute URL.

The external GET has a fixed configured origin, response-size limit, timeout, at most two attempts,
circuit breaker, redacted metrics and a short in-process coalescing cache. Cache data is normalized
and contains no source identity. A missing identity, invalid payload, timeout or open circuit fails
closed with `COMMUNITY_DIRECTORY_UNAVAILABLE`; the API never substitutes mock or mixed-source data.

The same normalized repository feeds the Home projector in the background. The worker persists at
most five summaries in `integration.community_home_source_components` and emits a versioned
`home.projection.component.changed.v1` event in the same transaction. Revisions advance beyond any
previous seeded component, while unchanged payloads only refresh producer metadata. The Home read
therefore remains one locally consistent snapshot instead of calling the legacy source on demand.

For a missing local logo in `legacy` mode, the worker downloads the source image only from
`COMMUNITY_LOGO_ALLOWED_HOSTS`, with HTTPS, redirect, timeout, byte and pixel bounds. It strips
metadata, constrains the dimensions, encodes WebP and stores an immutable
`community-logos/{tenant}/{community}/{sha256}.webp` object in the private S3-compatible bucket.
`integration.community_logo_sync` keeps the integration-only source URL, content hash, object key
and expiring PadlHub delivery URL. Logo metadata and the Home community component commit in one
tenant transaction; the browser sees only the signed PadlHub URL.

The source URL contains a stable legacy asset token, so an unchanged URL reuses the stored WebP
without another download and only renews the signed URL near expiry. A changed source URL creates a
new immutable object. A temporary media/storage failure retains the last local logo and does not
fail the community component; a removed source logo clears the projection. Replaced objects enter
delayed garbage collection after signed URLs and stale Home snapshots can no longer reference them.
The paginated directory reads the same stored delivery URL from PostgreSQL, so it never serves the
legacy media origin directly.

## Runtime modes and cutover

- `mock`: deterministic local/CI memberships; forbidden in production.
- `legacy`: temporary current-LK read adapter; no canonical business-state writes.
- `local`: reads active memberships only from canonical PostgreSQL tables.

`mock` never publishes a community component into a projection. In local runtime the currently
selected `legacy` mode supplies both the paginated directory and the projected Home summaries.

Cutover to `local` requires an explicit migration/backfill that reuses the existing PadlHub mapping
UUIDs, reconciles memberships, proves counts per tenant/user and switches the server-owned mode.
Removing the bridge is a later contract release after all active clients use PadlHub IDs.
