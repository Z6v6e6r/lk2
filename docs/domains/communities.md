# Communities domain

## Purpose and implemented slices

The communities contour owns PadlHub communities and user memberships. Implemented canonical
slices now include:

- a canonical `communities.communities` aggregate identified by a PadlHub UUID;
- tenant/user-scoped memberships that prevent duplicate active owners;
- a protected, cursor-paginated list of the authenticated user's active memberships;
- a ten-item summary projection embedded in Home;
- a temporary server-side read adapter for the current LK community store;
- create, discovery and privacy-filtered detail contracts in canonical `local` mode;
- the authenticated user's join/request/rejoin/cancel/leave lifecycle;
- a tenant-wide, bounded JOIN/REJOIN decision queue exposed to ЦУП through PadlHub Admin API;
- canonical posts, flat comments and `LIKE`/`DISLIKE` reactions behind canonical `local` mode;
- authenticated feed and comment reads with snapshot-stable keyset cursors;
- an audited CUP content queue with approve/reject/hide/restore commands;
- a durable per-community event sequence, authorized HTTP gap recovery and identifier-only realtime
  hints;
- a rebuildable ACTIVE-member count projection with revisioned per-user contributions and explicit
  readiness.
- an image-only media contract with staged upload, immutable source-version evidence, asynchronous
  scan/normalization and ordered post-revision snapshots, kept behind a default-off rollout gate.

REQUEST-mode invites, role/remove/ban commands, moderation appeal, public unauthenticated feed,
content/reaction counters, full rating tables and chat history remain later vertical slices. Normal ownership
transfer and reusable DIRECT invites are implemented; DIRECT invites remain behind a default-off
rollout gate. The membership summary may include only the
authenticated viewer's current positive `memberRank` when an existing ranking source publishes it.
Community chat itself belongs to `messaging`; this domain stores no messages and does not invent an
independent unread source.

## Realtime transport status

The staging-only transport uses a 30-second, one-time, session-bound ticket and checks canonical
PostgreSQL membership for every `community.subscribe`. Canonical content and moderation commands
allocate a monotonic per-community sequence in their state/audit/outbox transaction. Authorized
members recover identifier-only events through `GET .../communities/{communityId}/events` and use
the returned latest/retained sequence bounds to detect future or expired cursors. RabbitMQ fan-out
is an identifier-only hint; the subscription acknowledgement is
`DURABLE_SEQUENCE_HTTP_RECOVERY`.

Production remains disabled until exact staging proves reconnect, duplicate broker delivery,
membership revocation before fan-out, hot-community load, slow clients, process loss and broker
outage. RabbitMQ or Redis never carries canonical content or history. See
`docs/adr/communities/0004-realtime-authorized-transport-foundation.md`.

## Active-member count projection

Migration 0066 introduces a disposable PostgreSQL projection for `memberCount`. A per-user
contribution stores the last canonical membership revision, so duplicate and reordered broker
events cannot apply a second delta. The worker uses a durable quorum queue and an inbox record;
state, contribution, aggregate and inbox completion commit in one tenant transaction.

Projection state is explicit: `BUILDING`, `READY` or `STALE`. Directory/detail reads use only a
READY total and retain the canonical count fallback during expand/backfill. A bounded, resumable
reconciler advances by user UUID and declares READY only when the projection equals the canonical
ACTIVE count. See `docs/adr/communities/C-15-member-count-projection.md` and
`docs/runbooks/community-member-count-reconciliation.md`.

## Canonical content and feed foundation

Migration 0063 introduces tenant-RLS canonical posts, append-only post revisions, flat comments,
append-only comment revisions, current reactions and actor-scoped command results. The current
contract accepts post bodies from 1 to 10,000 Unicode characters and comment bodies from 1 to 2,000
characters. A user has at most one current reaction per object; setting `LIKE` or `DISLIKE` replaces
the previous value atomically, while removal keeps an audited tombstone.

All content commands derive tenant and actor from the verified JWT. They commit state, immutable
revision, idempotent result, audit and an identifier-only outbox event in one tenant transaction.
Outbox payloads never carry post or comment bodies. Author removal is an `ARCHIVED` transition, not
a delete: restore is available for 30 days and bodies/revisions remain for five years from
`archived_at`. The later retention worker may purge bodies only after that deadline while retaining
tombstones and audit evidence.

Authenticated User API feed reads use reverse-chronological `(published_at, id)` keyset pagination.
The opaque cursor also binds the community and first-page watermark, so concurrent newer posts do
not shift the continuation snapshot. Comment reads use the same watermark rule with chronological
`(published_at, id)` ordering and bind both community and post. Cross-resource cursor reuse fails
closed.

Publishing policy is enforced in the repository: `OPEN_COMMUNITY` publishes ACTIVE-member posts,
`STAFF_FEED` reserves posts for staff, and `MODERATED_FEED` places MEMBER posts and edits into
`PENDING_MODERATION`. ЦУП reads a bounded oldest-first queue and may approve or reject a pending
post, hide a published post/comment, or restore hidden content with optimistic revision checks and a
structured reason. Rejection changes `PENDING_MODERATION` to `HIDDEN` without deleting the body or
history. An author edit of any hidden post creates an immutable revision and always returns it to
`PENDING_MODERATION`, including in an otherwise open feed; it cannot become visible without a new
approval. Every decision stores immutable moderation evidence and commits content state, revision,
idempotent result, audit, durable sequence and outbox atomically. Public community visibility is
enforced for authenticated readers; an unauthenticated Public API remains separate work.

## Image media contract

Community media GA accepts only JPEG, PNG and WebP sources up to 15 MiB. A post body remains
mandatory and each post revision carries an ordered snapshot of at most ten distinct READY media
UUIDs. `mediaIds` is optional on create/edit for backward compatibility: absence on create means no
media; absence on edit preserves the current snapshot; an explicit empty array removes media from
the new revision. Comment requests remain strict and do not accept media.

PostgreSQL admits a new upload intent only after replay and authorization. Fixed-order tenant and
actor advisory locks enforce at most ten unexpired actor `UPLOADING` intents, 20 actor pipeline
reservations across unexpired `UPLOADING` plus all `SCANNING` rows, 100 actor issues and 150 MiB of
actor declared bytes in a rolling 24-hour window, and 100 tenant pipeline reservations. Every
issued row remains in both rolling daily totals through reject, expiry and purge; replay consumes
no additional quota. Issue replay revalidates the current actor and publishing permission, locks
the authoritative row and signs only an unexpired `UPLOADING` intent; terminal/expired media never
receive a replacement PUT target. Redis and the HTTP token limiter are defense in depth and never
the source of admission truth.
Exact source-version GC is scheduled no earlier than the original upload-intent expiry, so no
previously issued PUT grant remains valid after deletion makes the quarantine key absent.

Issue and finalize are separate idempotent commands. The database stores a provider-neutral intent;
the API signs a short-lived private quarantine target after commit. Finalize first resolves replay
or idempotency conflict, then observes exact object size, content type, checksum, ETag and immutable
storage version before committing `SCANNING`. A replay therefore does not depend on a quarantine
object that a worker may already have removed.

Workers validate and normalize the exact observed source version. Only `READY` media can be bound,
and one media UUID is permanently bound to one post so old revisions never change. DTOs return only
stable authenticated PadlHub variant URLs; the delivery endpoint authorizes the viewer and redirects
to a short-lived exact-version URL. Object keys, provider IDs and signed URLs are not canonical API
data.

Unattached READY media expires after 24 hours. Attached media follows the post lifecycle: archive
retains its body, revision snapshots and objects for five years. The storage preflight is a release
gate: versioning Enabled, private bucket and no public ACL, CORS limited to approved LK origins plus
PUT/HEAD/GET and signed headers, and lifecycle policies that cannot delete READY media before domain
retention. See `docs/adr/communities/C-07-media-lifecycle-and-safety.md`.

Durable community events are retained for 30 days. An older cursor causes a retained-gap conflict;
the client must reset it, reload canonical feed/comment/media state and resume from the latest
sequence rather than attempting to reconstruct state from realtime hints.

## Public read contracts

Home returns no more than ten `CommunitySummary` items. Each item contains only:

```json
{
  "id": "PadlHub UUID",
  "title": "Padel Friends",
  "logoUrl": "https://media.padlhub.example/.../logo.webp?signed=...",
  "isVerified": true,
  "unreadChatCount": 2,
  "memberRank": 12,
  "route": "/communities/{PadlHub UUID}"
}
```

`memberRank` is optional. Absence means the ranking source has no current position; the API and UI
omit the place rather than synthesize one.

Opening `/communities` calls:

```http
GET /user/api/v1/{tenantKey}/communities/mine?limit=20&cursor=opaque
Authorization: Bearer <PadlHub JWT>
X-Correlation-ID: <opaque id>
```

The canonical mine cursor is ordered by pin state, membership activity timestamp and community
UUID. Community title/content edits do not reorder every member's list or cause fan-out membership
writes. Migration 0061 provides the matching partial keyset index.

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
`communities.memberships.ranking_position` is nullable and positive when present.

The unique index guarantees at most one active owner. The later create/transfer commands must also
guarantee that an active community is never left without an owner in the same transaction.

The domain is `LOCAL_ONLY`: there is no Viva community write owner. Implemented creation and
membership commands commit canonical state, idempotency result, audit and outbox in one PostgreSQL
transaction. The legacy bridge remains read-only and command runtimes fail closed outside canonical
`local` mode; there is no dual-write.

## Temporary LK read bridge

`COMMUNITIES_READ_MODE=legacy` explicitly enables the bridge. The API resolves the authenticated
PadlHub user to server-only phone/Viva profile identity, calls the fixed
`/lk/communities?view=summary` source and treats the response as untrusted integration input. It
selects only rows whose single summary member matches that server-resolved identity. Open catalog
rows and other members are discarded.

When the summary member does not already contain a rank, the bridge enriches only the visible page
(at most eight communities) from the current
`/lk/communities/{communityId}/rating?tab=overall&period=30d` snapshot. The request carries the
server-resolved identity, uses the same fixed legacy origin and never exposes that identity to the
browser. A missing, stale or unavailable rating snapshot leaves `memberRank` absent without failing
the membership directory. Successful and negative enrichments use a short coalescing cache to keep
the fan-out bounded.

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
most ten summaries in `integration.community_home_source_components` and emits a versioned
`home.projection.component.changed.v1` event in the same transaction. Revisions advance beyond any
previous seeded component, while unchanged payloads only refresh producer metadata. The Home read
therefore remains one locally consistent snapshot instead of calling the legacy source on demand.

The web client renders those ten projected summaries immediately, then replaces that fallback with
one canonical directory page requested with `limit=10`. That first directory read establishes the
opaque continuation cursor without merging fields or versions. When the horizontal rail approaches
its end, the client requests the next ten-item page and appends it by PadlHub community UUID. If
the HomeBase community component is `UNAVAILABLE`, the same canonical first-page read hydrates the
rail instead of suppressing the directory request.

For a missing local logo in `legacy` mode, the worker downloads the source image only from
`COMMUNITY_LOGO_ALLOWED_HOSTS`, with HTTPS, redirect, timeout, byte and pixel bounds. It strips
metadata, constrains the dimensions, encodes WebP and stores an immutable
`community-logos/{tenant}/{community}/{sha256}.webp` object in the private S3-compatible bucket.
`integration.community_logo_sync` keeps the integration-only source URL, content hash, object key
and optional legacy delivery metadata used only during rolling compatibility. Logo metadata and the
Home community component commit in one tenant transaction; the browser sees only the stable
`/public/api/v1/media/community-logos/{tenantId}/{communityId}` PadlHub route. The API resolves the
current private object under tenant RLS and streams WebP bytes, so an expired object-store signature
cannot break a persisted Home or directory response.

The source URL contains a stable legacy asset token, so an unchanged URL reuses the stored WebP
without another download. A changed source URL creates a
new immutable object. A temporary media/storage failure retains the last local logo and does not
fail the community component; a removed source logo clears the projection. Replaced objects enter
delayed garbage collection after stale Home snapshots can no longer reference them.
The paginated directory derives the same stable delivery route from the stored object mapping, so it never serves the
legacy media origin directly.

## Runtime modes and cutover

Runtime capabilities report current server wiring only. Effective client behavior is the
intersection of runtime availability and canonical membership/role authorization; User API routes
remain the authoritative fail-closed enforcement boundary.

- `mock`: deterministic local/CI memberships; forbidden in production.
- `legacy`: temporary current-LK read adapter; no canonical business-state writes.
- `local`: reads and writes canonical Communities state only in PostgreSQL.

`mock` never publishes a community component into a projection. In local runtime the currently
selected `legacy` mode supplies both the paginated directory and the projected Home summaries.

Cutover to `local` requires an explicit migration/backfill that reuses the existing PadlHub mapping
UUIDs, reconciles memberships, proves counts per tenant/user and switches the server-owned mode.
Removing the bridge is a later contract release after all active clients use PadlHub IDs.

## First canonical command walking skeleton

The first write slice is intentionally limited to pinning the authenticated user's own active
membership:

```http
PUT /user/api/v1/{tenantKey}/communities/{communityId}/members/me/pin
Authorization: Bearer <PadlHub JWT>
Idempotency-Key: <opaque command key>
X-Correlation-ID: <opaque id>

{"pinned":true,"expectedRevision":3}
```

The actor is always the verified JWT subject. A client cannot submit a phone, external identity,
user ID, role or source-system selector. The command is enabled only in `local` mode and fails
closed in `legacy` and `mock`, so this slice cannot create an independent dual-write path.

One tenant transaction locks the active membership, compares `expectedRevision`, updates
`pinned_at` and the monotonic membership `revision`, stores the idempotent command result, appends
an audit record and emits `community.membership.pin_changed.v1` through the outbox when state
changes. Reusing the same key and request returns the stored result; reusing it with another
payload or submitting a stale revision returns a stable conflict code. A no-op is still audited and
stored for deterministic replay but emits no projection event because the aggregate did not
change.

This is the reference implementation for later critical community commands. Creation and the
non-invite membership lifecycle are now accepted canonical commands described below; invites,
role changes, remove/ban, publishing and chat still require their own accepted slice contracts.

## Approved product configuration

The product owner approved independent community axes:

- visibility: `PUBLIC / LISTED_PRIVATE / HIDDEN`;
- join: `INSTANT / MODERATED / INVITE_ONLY`;
- publishing: a per-community policy for posts, comments and chat;
- roles: fixed `OWNER → ADMIN → MODERATOR → MEMBER` hierarchy;
- invite: explicit `DIRECT / REQUEST` grant mode;
- chat GA: one general conversation with text, images, mentions and a pinned message;
- moderation: hybrid automation/community moderation/platform escalation operated from ЦУП.

Create requires an active authenticated principal with a server-issued `communities.create`
capability. Standard quota permits fewer than three ACTIVE owned communities and no successful
create in the preceding 24 hours. Only a separate authorized ЦУП/Admin path may issue a user-scoped
one-use grant; the User API never accepts an override or grant selector.

The create request explicitly selects one publishing preset, with no server default:

- `OPEN_COMMUNITY`: ACTIVE members post, comment and chat;
- `STAFF_FEED`: staff post, ACTIVE members comment and chat;
- `MODERATED_FEED`: member posts require approval, ACTIVE members comment and chat.

Title is required up to 120 characters; description is optional up to 2,000. City and logo are
optional later steps. Tags, minimum level and rules are later compatible extensions. Public routes
use the PadlHub UUID and do not create a slug.

The implemented create command is enabled only in canonical `local` mode. It serializes concurrent
quota checks per tenant/user and commits the community, its sole ACTIVE OWNER membership,
idempotency result, audit record and `community.created.v1` outbox event in one tenant transaction.
The public User API carries no override field. ЦУП may create one ACTIVE grant for a specific user
with the exact `communities.create.quota.override` capability, mandatory reason/ticket evidence and
one or both scopes: `DAILY_CREATE_LIMIT`, `ACTIVE_OWNER_LIMIT`. The grant expires after 24 hours and
is consumed only inside the successful create transaction when it covers every exceeded quota.
Ordinary in-quota creation does not consume it. Creation and ownership transfer share the same
target-user owner-quota advisory lock; transfer always rejects a target that already owns three
ACTIVE communities and never consumes a grant.

Before ACTIVE membership, `PUBLIC` exposes public detail/feed plus member count and public profile
summaries; `LISTED_PRIVATE` exposes only directory/minimal detail; `HIDDEN` is absent and returns
404, except that a valid invite can receive a minimal preview. Rating follows the same visibility
when implemented. Chat always requires ACTIVE membership. Search-engine indexing remains a
separate SEO decision.

For the implemented detail/discovery slice, LISTED_PRIVATE minimal means exactly PadlHub UUID,
title, copied logo URL, verification, visibility and server-derived join action. Description and
member count are structurally absent. HIDDEN invite preview remains closed until the signed invite
aggregate/transport is implemented; ordinary detail rejects legacy invite query parameters and
returns the same 404 for hidden and missing rows. Public member summaries are not part of this
slice.

Discovery uses a bounded query and keyset cursor over immutable creation order. PostgreSQL trigram
indexes cover discoverable titles and PUBLIC descriptions; private descriptions cannot influence
search results. Detail applies SQL redaction and strict domain DTO mapping, so frontend code never
chooses which privacy fields to hide.

A `REMOVED` member never returns through an instant join. A rejoin request is a separate durable
fact and an authorized moderator must approve it. A `DIRECT` invite issued by an active `OWNER` or
`ADMIN` with the required server-side capability is sufficient explicit permission and may restore
the membership atomically with redemption. A `BANNED` member cannot join or redeem an invite.
An author action archives content immediately rather than deleting it. Archived body and immutable
revision history remain for five years from archive time; user restore is available for 30 days.
Audit metadata and tombstones remain after body retention expires. Authors may edit published
content without a time limit; every edit creates a revision and a member edit in `MODERATED_FEED`
returns to moderation.

After a normal ownership transfer the former OWNER becomes ADMIN. Emergency transfer is available
only through PadlHub Admin API from ЦУП, requires two staff approvals, a mandatory reason and a
durable audit event. Unban changes membership to LEFT and never silently restores access.

ЦУП is the moderation control-plane UI, not the write owner. The existing CUP/ph-ab experience may
be visually reused, but its legacy Mongo mutations and client-local moderation state are not
canonical. ЦУП calls PadlHub Admin API with a `phub-admin` principal and granular permissions;
Moderation owns cases/actions/appeals while Communities alone applies membership/content state
through revision-checked commands with audit and outbox.

## Membership lifecycle and ЦУП queue

The authenticated User API exposes only the caller's canonical state and server-derived action:

- `GET .../communities/{communityId}/members/me`;
- `POST .../members/me/join` selects immediate `ACTIVE` or durable `PENDING` on the server;
- `POST .../join-requests/{requestId}/cancel` cancels only the caller's pending request;
- `POST .../members/me/leave` changes an ACTIVE non-owner membership to `LEFT`.

The body contains revisions only. Tenant, actor, subject, role, request kind and resulting status
are never client-selected. `BANNED` is fail-closed. `REMOVED` always creates a REJOIN request unless
the community is invite-only, where the signed DIRECT-invite flow remains the only future path.
HIDDEN with no canonical membership is indistinguishable from a missing community on both own-state
and ordinary join endpoints.

`communities.join_requests` is the durable request history. At most one PENDING request exists per
tenant/community/user. `communities.membership_lifecycle_commands` stores actor-scoped idempotent
results. Both tables use tenant composite keys, forced RLS and bounded keyset access.

ЦУП uses `phub-admin` JWTs and `x-app-platform: cup-admin` through:

- `communities.moderation.read` for the optional-community-filtered pending queue;
- `communities.join.decide` for revision-checked approve/reject.

The Admin body cannot select a community, user or role; the server resolves them from the canonical
request. Approval always restores `ACTIVE/MEMBER`. Rejection restores the request's preceding
`ABSENT`, `LEFT` or `REMOVED` membership state. Applied transitions emit the versioned
`community.member.joined.v1`, `community.join.requested.v1`, `community.join.cancelled.v1`,
`community.member.left.v1`, `community.join.approved.v1` or `community.join.rejected.v1` event in
the same transaction as state, audit and idempotency.

## Reusable DIRECT invites

The DIRECT invite vertical slice is implemented behind `COMMUNITY_INVITES_ENABLED=false` by
default. One opaque multi-user link is valid for exactly seven days. Preview is authenticated and
read-only; the browser must explicitly confirm redemption. Redemption activates or restores only
`MEMBER`, never downgrades an existing ACTIVE role, permits `REMOVED`, rejects `BANNED`, and becomes
invalid as soon as the issuer is no longer an ACTIVE OWNER or ADMIN.

The share route is `/community-invite#TOKEN`. The browser removes the fragment immediately and sends
the token only in `no-store` JSON bodies. The database stores only SHA-256 plus a non-secret key ID;
raw tokens are absent from audit, outbox and idempotency rows. Issue replay is deterministic through
a dedicated HMAC keyring. Creation, redemption and revocation use optimistic revisions,
actor-scoped idempotency, audit and outbox in the same tenant transaction. Active invite management
is bounded by keyset pagination and never returns token, hash or key ID.

PENDING fails closed without changing the existing request. Any current ACTIVE OWNER/ADMIN may
revoke a link. Standard issue allows at most five unexpired ACTIVE links and at most twenty
successful issues in the preceding rolling 24 hours per community, serialized under one
tenant/community database lock. Revocation does not refund rolling-window usage and idempotent
replay does not consume it twice.

The User API cannot request a bypass or select a grant. A separate CUP Admin-audience command may
create a community-scoped one-use grant only after the server verifies
`communities.invite.quota.override`; `reasonCode` and `ticketId` are mandatory, the grant expires in
24 hours, and at most one unexpired ACTIVE grant exists per community. CUP never becomes the invite
issuer and never receives the bearer token.

An issue inside ordinary limits leaves the grant available. The next over-quota issue by a current
ACTIVE OWNER/ADMIN consumes it in the same tenant transaction as invite, command, audit and outbox;
concurrent issuers cannot reuse it. Activation stays disabled until migrations, PostgreSQL race
coverage and staging smoke tests pass. See C-13.
