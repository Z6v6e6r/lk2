# ADR 0017: Unified activity history projection

- Status: accepted
- Date: 2026-07-21
- Extends: [ADR 0002](0002-viva-boundary.md), [ADR 0012](0012-booking-recommendations-first-slice.md)

## Context

The first Bookings slice exposes the local Games history and deliberately does not claim provider
training or tournament coverage. The previous LK browser queried Viva and the legacy Games service
independently, then classified, merged and de-duplicated those responses in React. That behavior is
not compatible with the PadlHub API boundary or with one consistent source/version per operation.

Users need one lazy history surface containing completed and cancelled Games, trainings and
tournament participations. An empty result must be distinguishable from a range that has never been
synchronized.

## Decision

`GET /user/api/v1/{tenantKey}/bookings/history` reads one tenant-scoped PostgreSQL projection using
an opaque keyset cursor. The client can filter by activity kind and completion/cancellation status,
but it cannot choose Viva, a legacy service or a local source. Public DTOs contain PadlHub UUIDs
only.

The projection combines owner-specific facts before the read:

- Games contribute their local viewer card/history state;
- the Bookings provider port contributes normalized training and tournament booking participation;
- a mapped local Tournament may enrich a tournament item without changing Bookings ownership.

The sync state persists coverage independently from the item count. `COMPLETE` plus zero rows is a
successful empty history, not a cache miss. `PARTIAL` records the provider cursor/oldest covered
range. A first uncovered read may perform one bounded, single-flight server-side refresh through
`@phub/viva-adapter`, persist the result, and then re-read PostgreSQL. A stale covered page is served
immediately while refresh is scheduled. When no local coverage exists and the provider refresh
fails, the API returns stable `BOOKING_HISTORY_UNAVAILABLE` instead of inventing an empty history.

Provider identifiers remain in integration storage. Activity classification uses proven provider
type/direction identifiers first; tested name markers are a compatibility fallback inside the
adapter, never client logic.

## Consequences

- History UI is a lazy overlay and never calls Viva directly.
- All available history is reached through cursor pagination; the API does not request or return an
  unbounded `size=1000` page.
- Projection writes are idempotent and tenant isolated. They do not create a second business write
  owner.
- Rollout remains capability-gated until real Viva fixtures, full type coverage, authenticated
  staging browser evidence and stale/provider-outage behavior are verified.
- Rollback disables the new read/UI flag and preserves projection rows and sync coverage for later
  reconciliation; no down migration is required.
