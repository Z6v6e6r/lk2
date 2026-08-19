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
