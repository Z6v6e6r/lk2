# ADR 0009: Establish the community directory with a temporary legacy read bridge

- Status: Accepted
- Date: 2026-07-17

## Context

The current LK community endpoint accepts browser-supplied phone/client identifiers, mixes open
catalog rows with memberships, computes graph connections and exposes legacy identifiers. It is too
slow and too broad to become the new public contract, but it contains the current membership data
needed while the canonical contour is assembled.

Home also has a strict one-snapshot invariant. Loading every community or calling the legacy source
from Home would recreate the startup fan-out that the Home projection removed.

## Decision

Create canonical tenant-RLS community and membership tables plus the shared `CommunitySummary`
contract. Home contains at most ten summaries. The web renders them immediately, then replaces the
fallback with the first ten-item page from `GET /user/api/v1/{tenantKey}/communities/mine` to
establish the server-owned opaque cursor. Approaching the end of the horizontal rail loads the next
page. An `UNAVAILABLE` Home component still starts this canonical directory read; the unavailable
message is retained only when the directory read also fails. The snapshot and directory versions
are never field-merged.

Canonical reads execute the cursor as a PostgreSQL keyset query with `limit + 1`. The temporary
legacy source cannot page memberships, so its bounded summary is fetched once into a short
identity-free normalized cache and continuation pages are cut from that cache.

During migration, `COMMUNITIES_READ_MODE=legacy` lets the API call the current LK summary endpoint.
The adapter derives identity only from verified PadlHub JWT/tenant context and server-side
integration mappings. It filters active memberships, maps source community IDs to PadlHub UUIDs and
drops all source identity, member, graph and invite fields. It does not write canonical community
business state. Legacy logo URLs remain an internal worker hint and are never returned to clients.

The bridge is protected by a fixed origin, timeout, bounded retry, circuit breaker, response-size
limit, redacted metrics and short normalized cache. `local`, `legacy` and `mock` are server modes;
the client never selects one. Production cannot use `mock`.

The worker uses that same server-owned repository in a bounded community synchronization cycle that
is independent of the Viva profile/bookings/subscriptions cycle. It stores a normalized ten-item
producer component and emits it through outbox/projector; the Home request itself reads only the
completed snapshot. Community refresh failure is isolated from Viva Home source failure and retains
the last valid community component.

When a legacy summary exposes a logo and no matching local asset exists, the worker downloads it
through an HTTPS host allowlist, applies byte/pixel/time bounds, strips metadata, converts it to WebP
and writes a content-addressed private object under the PadlHub community UUID. Integration metadata
and the Home component are committed together. During rollout clients receive a compatible signed
PadlHub object URL; after cutover they receive the stable PadlHub media route and the API resolves
the current object key under tenant RLS. Equal source URLs reuse the existing object between bounded
conditional revalidations; changed bytes import a new immutable object and queue the old one for
delayed deletion. A bounded S3 HEAD precedes stale conditional reads, so a missing immutable object
forces an unconditional refetch and re-upload. Provider calls have two attempts, capped
`Retry-After`, a host-level circuit breaker and identifier-free outcome metrics; storage canaries
participate in worker readiness and recover after bounded backoff.

## Consequences

- More than ten memberships do not enlarge the Home snapshot. One authenticated ten-item directory
  bootstrap read establishes pagination; continuation reads happen only near the rail boundary.
- The communities page can load the first 20 and continue without offset drift from newly inserted
  rows.
- Existing Home snapshots using the previous wider card shape are normalized on read and when the
  projector loads stored components; this compatibility path is removed only after backfill.
- Real Home summaries replace seeded mock rows with a higher component revision; unchanged reads do
  not create redundant outbox events.
- Browser requests contain no phone, Viva client ID or legacy community ID.
- A missing or temporarily unavailable source logo uses the generated fallback; an already copied
  local logo is retained on transient failures. Chat unread counts remain zero until the messaging
  projection is connected.
- A later reconciled backfill can insert canonical rows using the UUIDs already allocated in
  `integration.external_entity_map`, then switch reads to `local` without changing public IDs.
- Creation, join, invites, detail, feed, rating and moderation require later command/read slices;
  none are silently proxied through the insecure legacy write API.
