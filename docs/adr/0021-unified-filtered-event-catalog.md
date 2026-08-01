# ADR 0021: Unified filtered event catalog and snapshot pagination

- Status: Accepted (local implementation; production rollout pending parity gate)
- Date: 2026-08-01
- Owners: Games, Bookings, Web
- Supersedes for discovery filtering: the local-filtering part of ADR 0020

## Context

`/games` and `/trainings` currently do not filter the same logical data set that they display.

- `/games` joins a page of public Games, a bounded tournament list and coach-training rows extracted
  from the first 20 personalized recommendations. Only the public Games cursor is retained.
- `/trainings` reads at most 500 rows once and applies every filter in React.
- changing a date or another filter can therefore only narrow the rows that happened to be loaded;
  it cannot discover matching rows on a later source page;
- the multi-station Games path merges first pages and deliberately discards their cursors;
- a late load-more response can append rows from an obsolete filter generation;
- a `PARTIAL` client-assisted result is currently indistinguishable from a complete short or empty
  catalog after it passes through the web gateway.

The invariant required by both screens is: **normalize and filter the complete snapshot before
applying the page limit**. A cursor must describe the same immutable, filter-bound snapshot on every
page.

## Decision

Add an authenticated PadlHub `Event Catalog V2` read contract shared by `/games` and `/trainings`.
The existing `FOR_ME` recommendation contract remains unchanged because ranking and personalization
are different product semantics.

### Canonical query

The first-page request contains one normalized domain query:

```ts
interface EventCatalogQuery {
  surface: 'GAMES' | 'TRAININGS';
  localDates: readonly string[]; // YYYY-MM-DD, 1..15, tenant timezone
  kinds: readonly ('GAME' | 'COACH_GAME' | 'TOURNAMENT' | 'GROUP_TRAINING' | 'SPLIT')[];
  categoryIds?: readonly string[]; // PadlHub UUIDs, OR semantics
  stationIds?: readonly string[]; // PadlHub UUIDs, OR semantics
  availability: 'EXCLUDE_FULL' | 'INCLUDE_FULL';
  levelFrom?: 'D' | 'D+' | 'C' | 'C+' | 'B' | 'B+' | 'A';
  levelTo?: 'D' | 'D+' | 'C' | 'C+' | 'B' | 'B+' | 'A';
  startsAfterLocal?: string; // HH:mm in tenant timezone
  limit: number; // 1..50
}
```

The browser expresses business filters only. It cannot select Viva, a provider URL, an HTTP method
or an external identifier. The server converts `localDates` to fixed `schedule.read` commands.
The additive contract exposes both surfaces. Each surface accepts only its own kind set: Games use
`GAME`, `COACH_GAME`, `TOURNAMENT`; Trainings use `COACH_GAME`, `GROUP_TRAINING`, `SPLIT`.

Normalization rules are stable:

- empty arrays are omitted before hashing;
- UUID arrays and kinds are deduplicated and sorted;
- multiple stations and categories use OR within the field and AND across fields;
- level filtering uses interval overlap; an event without a level is included only when no level
  filter is active;
- `EXCLUDE_FULL` removes only events whose canonical `capacity.open` is exactly zero;
- time filtering uses the event's tenant-local date and time, never the browser timezone.

### Snapshot construction

The first request starts a server-directed client-assisted catalog job. The server issues only the
schedule dates required by the query. The browser relays bounded provider payloads through the
existing normalizer. The server then:

1. reads local public Games and tournament summaries for the requested dates;
2. resolves every station, category and event to PadlHub identifiers;
3. performs canonical duplicate resolution;
4. applies every query filter;
5. globally sorts by `(startsAt, kindOrder, padlHubId)`;
6. materializes a provider-free immutable snapshot in shared Redis;
7. slices the first page and returns an opaque continuation token.

Redis remains disposable cache state. It is not a write owner or source of truth. Raw Viva payloads
are not stored in the snapshot.

```ts
interface EventCatalogPage {
  state: 'READY' | 'PARTIAL';
  snapshotVersion: string;
  generatedAt: string;
  staleAt: string;
  items: readonly EventCatalogItem[];
  nextCursor: string | null;
  totalMatched: number | null;
  facets: EventCatalogFacets | null;
  sourceStatus: readonly EventCatalogSourceStatus[];
}
```

`EventCatalogItem` is a discriminated union of provider-free Game, training and tournament card
DTOs. Facets are calculated from the complete unpaginated normalized snapshot, never from the
current page.

### Cursor contract

Continuation uses `GET /user/api/v2/:tenantKey/event-catalog?cursor=...&limit=...`.
The token is a random server-stored handle bound to:

- tenant and authenticated user;
- normalized query hash;
- snapshot version;
- next offset and page-size policy;
- expiration time.

Continuation never repeats a Viva read and never re-reads mutable source rows. A missing or expired
snapshot returns stable `CATALOG_CURSOR_EXPIRED` (`410`); the client restarts from page one. A token
belonging to another tenant/user or query returns `CATALOG_CURSOR_INVALID` (`400`). Snapshot TTL is
ten minutes and is refreshed only while a valid page is being read.

### Completeness

Exact totals, facets and an empty state are valid only for `READY` snapshots.

If any required source/date fails, the server returns `PARTIAL`, `totalMatched: null`,
`facets: null` and explicit `sourceStatus`. The UI keeps successful rows, shows a retry notice and
must not claim that no matching events exist. A partial snapshot is not cached as a reusable first
page by the web gateway.

### Web state machine

Both screens use the same paginated-search reducer:

`IDLE -> FIRST_PAGE_LOADING -> READY | PARTIAL | EMPTY | ERROR -> NEXT_PAGE_LOADING`

- canonical filter state produces a stable `queryKey`;
- every filter/date change increments a request generation, clears items and cursor and requests a
  new snapshot;
- an old first-page or load-more response is ignored when its generation or query key differs;
- only one continuation request may run per generation;
- appends deduplicate by `(kind, id)` and preserve the server order;
- local filtering is permitted only as a development assertion, not as data selection;
- reset produces exactly one new first-page request;
- filter controls use server facets or canonical station/category catalogs, not loaded cards.

### Source-specific requirements

Before `GAMES` activation, two existing rollout gates become mandatory:

1. A tournament's private stable station identifier must resolve through the trusted integration
   map to a published PadlHub station UUID. Venue-name or prefix matching is not accepted; an
   unresolved station makes the tournament source partial and the row is omitted.
2. A local Game and a Viva schedule row may be merged only through a verified integration mapping.
   Local data wins for the Game aggregate; otherwise both rows remain distinct rather than being
   guessed as duplicates.

## Compatibility and rollout

This is an additive V2 contract. Existing public Games, tournament summary, `FOR_ME`,
`GROUP_TRAININGS` and Home contracts remain available during migration.

1. Add snapshot store, cursor validation and contract tests. **Implemented.**
2. Add `TRAININGS` catalog assembly and switch `/trainings`. **Implemented locally.**
3. Complete canonical tournament-station mapping and duplicate resolution. **Implemented:** only
   trusted mappings are accepted; unresolved tournament rows make the source partial.
4. Add `GAMES` mixed catalog assembly and switch `/games`. **Implemented locally.**
5. Compare old/new result counts and page identities in shadow mode. **Pending before production.**
6. Remove obsolete public discovery calls after parity and rollback-window proof. **Pending.**

The immutable image promotion and production rollout rules remain unchanged.

## Required verification

API and snapshot tests must prove:

- filters run before the page limit, including 20 non-matches before a match;
- 0, 1, 20, 21, 50, 51 and more than 500 matches paginate without gaps or duplicates;
- multiple stations/categories retain all pages;
- equal `startsAt` values have deterministic page boundaries;
- changing any filter invalidates the old cursor;
- a snapshot is stable when underlying capacity changes between pages;
- cursor expiration, tenant/user isolation and multi-replica Redis reads;
- missing dates/sources produce `PARTIAL`, never a false exact total or empty state;
- facets do not shrink to the current page;
- duplicate mappings and tournament station mappings follow the rules above.

Web tests must prove:

- changing date or any filter performs a new complete query and resets the cursor;
- stale first-page and load-more responses cannot mutate the new generation;
- retry preserves already loaded valid pages;
- the last page sets `nextCursor: null`;
- the empty state is shown only after a `READY` first page;
- both screens use the same reducer semantics.

Run `npm run check` for every implementation slice and perform an authenticated browser pass over
date changes, multi-station selection, reset, load-more and an injected partial-source failure.

## Consequences

- filtering becomes complete and independent of which rows were previously loaded;
- all event kinds share one stable order and one cursor on `/games`;
- continuation is horizontally safe because snapshots and cursor bindings live in shared Redis;
- the first page has a higher assembly cost, bounded by requested dates and concurrency;
- cursor expiry requires a visible restart path;
- the contract adds short-lived cache volume but no new business-state write owner;
- production activation remains blocked on shadow parity and rollback proof; canonical station and
  duplicate resolution now fail closed when mappings are absent.
