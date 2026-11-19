# CUP player-level projection ingress

This ingress projects the CUP-owned rating ledger into PadlHub's canonical participation-level
model. It is a server-only boundary and is disabled by default.

## Contract and ownership

- Endpoint: `POST /internal/api/v1/{tenantKey}/player-level-projections`.
- Authentication: `X-Cup-Player-Level-Token`; the value must never reach a browser and is bound to
  one exact configured tenant key.
- `Idempotency-Key` must exactly equal `sourceEventId`.
- CUP sends only the opaque Viva client ID, CUP revision/event metadata, normalized PADEL level
  code and numeric value. Phone, name, PadlHub UUID, rank, level ID and bypass flags are rejected.
- PadlHub resolves the active user through `integration.external_entity_map` and resolves the level
  against the active canonical scale. Unknown identities and levels fail closed without mutation.
- After the first CUP projection, self-declared and onboarding writes cannot replace that
  authoritative level.
- CUP event provenance is preserved as `MIGRATED`, `VIVA` or `MANUAL`; arbitrary event types are
  rejected instead of being relabeled as calculated.

The repository applies profile summary, `eligibility.player_sport_levels`, the CUP revision fence,
an append-only event-id ledger and audit row in one tenant transaction. Snapshots are full state,
so a newer revision may safely skip coalesced intermediate revisions. An event ID can never be
reused after a later revision replaces the current snapshot. Identical replay and older stale
delivery are safe; a conflicting event or revision returns `409`.

## Safe configuration

```text
CUP_PLAYER_LEVEL_PROJECTION_ENABLED=false
# CUP_PLAYER_LEVEL_PROJECTION_TOKEN is injected through a runtime secret or *_FILE.
# CUP_PLAYER_LEVEL_PROJECTION_TENANT_KEY=local-padel
```

Apply migration `0087_cup_player_level_projection.sql` before enabling the ingress. Migration and
deployment do not authorize activation. Keep all participation policies `OFF` until anonymized
parity and join/waitlist/payment recovery gates have passed.

Before any shared staging migration, run the separately approved exact `33_V1` clone-only rehearsal
described in `docs/runbooks/communities-chain-integration.md`. Its success proves the ordered
`16+5+8+3+1` migration path, exact ACL v2 catalog boundary and real apply/replay/cross-tenant RLS
behavior only inside a disposable restored database. That evidence does not authorize a shared
migration, deploy, sender/ingress activation, roster flag or payment action. A shared staging
migration remains a separate release job and approval gate.

## Staging checks

1. With the flag off, assert `503 CUP_PLAYER_LEVEL_PROJECTION_DISABLED`.
2. With the flag on, assert wrong token `403`, wrong tenant `403`, strict-payload rejection `400`,
   unknown identity `409`, valid apply `200`, identical replay `200`, stale revision `200`,
   coalesced revision jump `200`, and conflicting revision `409`.
3. Compare anonymized counts by projection status and level code between CUP and PadlHub.
4. Verify that local self-declared/onboarding writes return
   `409 PROFILE_LEVEL_CUP_AUTHORITATIVE` after projection.
5. Run native join, waitlist, promotion and paid-flow tests with policy still `OFF`, then repeat in
   `SHADOW` only after a separate activation approval.

Rollback is non-destructive: disable the CUP sender, then disable ingress. Existing projections
remain readable and no CUP ledger event is removed.

This stage does not define a deletion or invalid-rating tombstone. Keep the
`player_projection_ready` gate false and do not publish `BLOCK` while CUP reports invalid states or
until an explicit clear-level contract exists; otherwise the last accepted PadlHub level remains in
force.

## CUP-only PADEL consumer candidate

The dashboard and both profile routes take the PADEL level from the tenant's accepted CUP
projection. A Viva observation can still update the displayed balance. The old Home snapshot
and the old profile summary cannot supply a PADEL level before projection. Active game cards,
community current-level columns, player lists, booking recommendations and native game or
training eligibility use the CUP projection fence. Community scores, deltas and ranking order
still come from the requested community snapshot. An unknown row level is returned as null.

The authenticated `GET /profile/level` response uses `projectionStatus: PENDING` when no
snapshot has arrived, and `PROJECTED` when an accepted snapshot is readable. A projection
conflict returns `409 PROFILE_LEVEL_PROJECTION_CONFLICT` and a read error returns
`503 PROFILE_LEVEL_UNAVAILABLE`. Pending projection establishes no statement about whether
CUP has assigned a level. A cached CUP snapshot can remain visible during delivery delay.
Tournament eligibility itself is checked by the CUP owner on new attempts. Existing attempts
retain their own receipt and recovery path.

PADEL self-declaration and assessment writes return `PROFILE_LEVEL_CUP_AUTHORITATIVE`.
The authenticated player can complete the existing canonical onboarding in LK1, or an authorized
staff member can assign a level in CUP. Any new signup requires an explicit user action.
Legacy profile and match/booking history remains available as history. The level-history screen
does not label an old history point as the current level.

Migration `0119_cup_calculated_player_levels.sql` widens the existing provenance check.
For a populated Timeweb database, use the [separate 0119 admission and private pilot plan](timeweb-cup-level-pilot.md).
The receiver records calculated game and tournament event types exactly and uses the existing
`CALCULATED` classification in its projection. Sender and receiver need the paired calculated
event allowlist. Existing first-assignment deliveries retain their `RATING_MANUALLY_CHANGED`
wire representation and idempotency hash. Disable delivery to pause ingestion while retaining
CUP-only reads, accepted snapshots and the event ledger.

## Local cross-service fixture

Use a new dedicated loopback PostgreSQL 16 database. The fixture requires the exact database
name, port, migration ledger entry and a synthetic token before it seeds the synthetic player.
It serves the production projection ingress and uses a disposable runtime role with forced
tenant RLS. It also exposes test-only `GET /rehearsal` with the exact accepted level, projection
status, event revisions and the synthetic request log for deliberate replay. No provider network
traffic is needed.

```sh
docker run --rm -d --name phub-cup-level-probe \
  --publish 127.0.0.1:25478:5432 \
  --env POSTGRES_HOST_AUTH_METHOD=trust \
  --env POSTGRES_DB=phub_cup_level_probe postgres:16-alpine
docker exec phub-cup-level-probe pg_isready -U postgres -d phub_cup_level_probe
CHAT_PUSH_FOUNDATION_MAINTENANCE_ACK=CHAT_PUSH_FOUNDATION_EMPTY_DATABASE_V1 \
  DATABASE_URL=postgres://postgres@127.0.0.1:25478/phub_cup_level_probe \
  node --import tsx scripts/migrate.ts
LK2_CUP_PROJECTION_TEST_DB=postgres://postgres@127.0.0.1:25478/phub_cup_level_probe \
  LK2_CUP_PROJECTION_TEST_TOKEN=synthetic-shared-projection-test-token \
  node --import tsx scripts/rehearse-cup-player-level-projection.ts
```

Use Node 22. The sender's base URL is `http://127.0.0.1:18078`, its target tenant is
`local-padel`, and its player ID is `synthetic-shared-player`. The initial read must show
`PENDING`, even though the legacy compatibility rows contain a different level. Subsequent
reads identify which CUP revisions arrived and the value visible through each LK2 repository.
