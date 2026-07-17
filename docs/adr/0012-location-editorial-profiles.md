# ADR 0012: Separate public location profiles from operational stations

## Status

Accepted — 2026-07-17.

## Context

The cabinet needs rich station cards and a Home carousel, while existing station, court and
availability data is owned by Viva. Treating the visual card as the same aggregate would either
expose provider identifiers to clients, require mixed-source assembly, or make editorial publishing
dependent on operational station writes.

## Decision

Create a tenant-scoped `LOCAL_ONLY` `location_profiles` aggregate identified by a PadlHub UUID. It
owns public editorial content and publication only. Operational stations, spaces, availability and
bookings remain separate `VIVA_PRIMARY` domains.

All CUP commands go through the dedicated PadlHub Admin API with version checks, idempotency, audit
and transactional outbox. User Location APIs return published profiles only. Home receives an
event-built, bounded locations component and keeps its one-snapshot consistency rule.

Favorites, ratings and reviews are not denormalized into the profile. They require viewer-aware or
community-owned aggregates and may later be projected into the read card.

## Consequences

- Editorial teams can publish a card without writing Viva station state.
- Clients see stable PadlHub UUIDs and never need provider credentials or source selection.
- An explicit future mapping may relate a public profile to operational entities inside integration
  storage, but it cannot become a client-visible primary identifier or dual-write mechanism.
- Home changes fan out per existing user. Large tenants may later replace direct fan-out with a
  shared tenant component plus snapshot composition, while preserving one version per response.
- The initial URL-based gallery is intentionally narrower than file upload and must be replaced by
  a storage-backed media command before accepting operator binaries.
