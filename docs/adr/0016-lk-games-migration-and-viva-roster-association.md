# ADR 0016: Migrate LK Games into the local aggregate with a server-only Viva roster association

- Status: Proposed
- Date: 2026-07-19

## Context

The legacy LK Game document is useful evidence of existing product behavior, but its public read
shape exposes fields that do not belong in a client response: participant phones, payment facts,
legacy identifiers and provider media URLs. It must not be copied into the new LK or CUP as a
second operational store.

A confirmed Viva booking identifies the exercise the viewer joined. A migrated legacy Game can
also contain that Viva exercise identifier and a confirmed canonical roster. This association lets
the Home projection render the same game participants without requesting or exposing the legacy
document to the browser.

## Decision

1. `games.*` remains `LOCAL_PRIMARY` for game lifecycle, participants, waitlist, card state and
   future LK/CUP commands. During the staged import only, an imported scheduled Game may be
   marked `MIRROR` in `integration.legacy_game_roster_sync_state`: the trusted worker can refresh
   its participant roster from legacy LK until a local aggregate revision diverges. A local
   command immediately quarantines the mirror as `CONFLICT`; it is never overwritten.
2. A trusted server-side importer stores the source Game-to-Viva-exercise association only in
   `integration.external_entity_map` as `VIVA/exercise -> PadlHub game UUID`. Neither external
   value is a Games primary key or a client DTO field.
3. The association is unique. An import that finds the same Viva exercise attached to another
   PadlHub Game fails with `VIVA_EXERCISE_GAME_ASSOCIATION_CONFLICT`; it never rewrites either
   game.
4. Viva Home synchronization reads the viewer booking from `@phub/viva-adapter`. Before it
   persists the Home component, a staging-only trusted bridge looks up only the matching current
   LK Games by the server-side Viva exercise association, imports/guards their canonical roster,
   and then resolves that roster in the tenant transaction. It emits only display name,
   PadlHub-served avatar URL, level and server-computed free slots. It emits no phone, payment,
   legacy identifier, Viva identifier or provider source URL. A bridge read failure leaves the
   last successful Home projection intact rather than publishing a partial roster.
5. The public legacy endpoint remains local-clone-only and anonymizes every retained integration
   key. A production backfill must use a separately approved, bounded server source; a browser
   may never call either source directly.
6. Game commands move operation-by-operation to the local aggregate. There is no independent
   dual-write to legacy Mongo/Node-RED. Compatibility updates, if required during cutover, are
   asynchronous adapter work driven by durable outbox facts and have a single declared owner.
7. The mirror is staging-only and requires an explicit `GAMES_READ_ENABLED` gate, scoped tenant,
   server-secret Mongo URI and bounded time window. It creates canonical outbox facts for changed
   rosters, so card/Home projections refresh through the normal consumers. It never writes back
   to legacy Mongo/Node-RED.

## Migration sequence

1. Inventory and backfill legacy Games into canonical aggregates; record source versions and
   Viva exercise associations, bootstrap the guarded roster mirror, then reconcile counts, roster
   occupancy and lifecycle state.
2. Switch new LK and CUP reads to the canonical API/card projections, initially behind a tenant
   gate and with a shadow comparison report.
3. Move join, leave, waitlist, cancellation, booking, payment and result commands one workflow at
   a time. Each needs a PadlHub identity, authorization, idempotency key, audit record, outbox
   event and a rollback/replay procedure.
4. After reconciliation and real browser/API verification, remove the legacy route from client
   navigation, retain a bounded read-only repair window, then decommission the source.

## Cutover gates

- No client bundle or API response contains legacy/Viva identifiers, phone numbers, payment URLs
  or source-media URLs.
- Every migrated Game has one tenant-scoped canonical aggregate and at most one Viva exercise
  association.
- Roster count, capacity and active participant identities reconcile against the approved source;
  any local revision divergence or unknown baseline is quarantined rather than guessed.
- New LK and CUP use PadlHub API DTOs only, and all command flows pass authorization,
  idempotency, concurrency, audit, outbox and recovery tests.
- A staged environment has an authenticated browser proof for the selected game, including its
  participant roster, plus rollback evidence before production approval.

## Consequences

The first safe user-visible slice is a Home card whose participants come from the canonical Game
after the association has been migrated. It is intentionally not a production backfill or a
cutover by itself: the trusted source, reconciliation job, command migration and CUP screens each
remain explicit release work.
