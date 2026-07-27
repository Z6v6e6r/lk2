# ADR 0016: Migrate LK Games into the local aggregate with a server-only Viva roster association

- Status: Accepted
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
   persists the Home component, a local/staging-only trusted bridge, independently gated by
   `HOME_VIVA_LEGACY_GAME_BRIDGE_ENABLED`, looks up only the matching current LK Games by the
   server-side Viva exercise association, imports/guards their canonical roster,
   copies allowlisted participant photos into metadata-free, content-addressed PadlHub WebP
   objects, and then resolves that roster in the tenant transaction. The legacy photo is
   fallback-only and cannot replace an existing profile-owned avatar. When the matching legacy
   participant omitted a level, the worker may fill that participant's profile presentation from
   the authenticated viewer's confirmed Viva profile after an exact server-side identity match;
   it does not mutate the Games aggregate or guess another participant's level. The normalized
   numeric rating is stored with the profile presentation so the client can render progress within
   the current level. It emits only real display name, short-lived PadlHub-served avatar URL, level,
   normalized rating and server-computed free slots. It emits no phone, payment, legacy identifier,
   Viva identifier or provider source URL. A bridge read or media failure retains the last local
   avatar/projection rather than publishing provider URLs or a partial roster. The public bridge
   shares one bounded available-Games page through a 60-second process cache and single-flight;
   stale-on-error and a circuit breaker prevent concurrent Home viewers from multiplying upstream
   reads. Once resolved, Home routes to `/games/{PadlHub UUID}`, never to a provider or legacy ID.
5. The public legacy endpoint anonymizes every retained integration key. It may feed a read-only
   local clone or staging mirror, but staging must keep Games commands and private/history backfill
   disabled. A production backfill must use a separately approved, bounded server source; a
   browser may never call either source directly.
6. Game commands move operation-by-operation to the local aggregate. There is no independent
   dual-write to legacy Mongo/Node-RED. Compatibility updates, if required during cutover, are
   asynchronous adapter work driven by durable outbox facts and have a single declared owner.
7. The mirror is staging-only and requires an explicit `GAMES_READ_ENABLED` gate, scoped tenant
   and bounded time window. The preferred source is the server-secret Mongo URI. A sanitized HTTPS
   public CUP source is permitted for read-only staging verification only when Games commands and
   private/history backfill remain disabled. Both modes create canonical outbox facts for changed
   rosters, so card/Home projections refresh through the normal consumers. Neither writes back to
   legacy Mongo/Node-RED.
8. Both the direct Mongo adapter and the sanitized HTTPS adapter derive game, player, station and
   court association keys with the same `phub-local-public-clone-v1` SHA-256 namespace. The
   trusted snapshot may carry the raw source value only as an integration-only alias. Import
   resolves the canonical key and every observed alias under the tenant advisory lock.
9. If an earlier release created both raw-ID and pseudonymous-ID Games, migration `0042` performs
   a lossless logical merge in one database transaction. The pseudonymous-ID aggregate is the
   canonical target; source and Viva mappings plus activity-history routes move to that target,
   the source card and scheduled work are disabled, and
   `integration.legacy_game_merge_redirects` preserves old PadlHub UUID links. The source aggregate
   row and its immutable participants, result submissions, results and audit facts are retained as
   a redirect tombstone; they are never deleted or rewritten speculatively.

## Migration sequence

1. Apply migration `0042`, reconcile its raw/hash alias pairs and prove that no source redirect has
   a card projection. Inventory and backfill legacy Games into canonical aggregates; record source versions and
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
- Every projected participant avatar resolves to a private PadlHub-owned `image/webp` object whose
  object key and content hash are recorded in integration storage.
- Every migrated source game has one tenant-scoped canonical target. Raw and pseudonymous source
  aliases may coexist only in `integration.external_entity_map` and must resolve to that target;
  a redirected source UUID has no card projection or pending lifecycle command.
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
remain explicit release work. A participant with a known rating renders a level ring filled to the
fractional progress of that normalized rating, not merely because a level label exists. When no
PadlHub-owned photo exists, the client renders the neutral supplied placeholder while retaining the
same level badge.
