# Station membership from the original managed JOIN

Status: source implementation, disabled by default. First consumer is managed GAME JOIN
with a verified subscription-booking receipt, including a subscription on a SPLIT game.
This does not implement TRAINING admission, LK1 legacy producers, deployment, or signer provisioning.

The owner remains LK. One official STATION community is selected by exact owner studio ID.
Cancellation retains membership. Voluntary leave advances the member epoch; only a later original
registration can return the member. Removal/ban blocks automatic return until an explicit owner
restore advances the epoch. No browser field determines actor, station, epoch, or generation.

## Original operation and delivery

1. Existing paid commands are recovered before station admission. Historical commands without a
   marker are never upgraded. Only the new managed JOIN path resolves verified location evidence.
2. The source is `integration.game_create_location_bindings` with exact game revision, target
   exercise mapping/version, imported game lineage, current binding, published station and provider
   tenant identity. Reverse legacy station aliases are not authoritative. The owner receives the
   verified `provider_studio_id`.
3. Before the first reservation/booking dispatch, the API requests a first-wins owner admission for
   the original operation. Missing mapping, disabled capability or ambiguous transport becomes an
   immutable negative marker. An owner admission orphan after a crash may only replay that same
   original binding; it cannot refresh the epoch.
4. `beginPaidJoin` rechecks the location evidence under the game lock. Binding drift/expiry/revoke
   becomes `NO_ENROLLMENT`; existing booking target conflicts retain their existing refusal.
   The marker, seat and original paid command are committed together in the existing payment
   snapshot. Concurrent/replayed callers cannot replace the winning marker.
5. `confirmPayment` already atomically writes the participation, APPLIED evidence, receipt and
   `game.participation.confirmed.v1` outbox event. The event contract is unchanged.
6. The worker uses event ID/tenant/game/user/participation to load the persisted outbox and exact
   original snapshot. The historical receipt/evidence/reservation/COMPLETED command must match.
   The event causation/confirmation-command ID is never substituted for the original JOIN ID.
   Delayed delivery does not select a current/rejoined participation or require the old one ACTIVE.
7. Delivery signs only the persisted confirmation, without session/Viva credentials or a provider
   lookup. LK owns the epoch, removal/ban, immutable generation claim and membership CAS/readback.
   Timeout/lost ACK redelivers the same fact through a quorum queue (limit five, dead letter after
   exhaustion). No failure rolls back or repeats booking. Dead letters require evidence-based
   recovery; automatic activation/backfill/replay is not authorized.

Private wire: `/lk/integrations/v1/station-memberships/operations/:operationId/{admission,confirmation}`,
`X-Station-Membership-Delegation`, RS256, dedicated audience and typ
`phub-station-membership-delegation+jwt`. Canonical body hashing and admission ID have independently
checked LK owner vectors. No private marker/provider IDs enter public DTOs or events/logs.

## Activation and rollback

`LK_STATION_MEMBERSHIP_LIFETIME_ENABLED` is default false across API/worker/LK/CUP. Owner: R1
integration. Activation requires all writers and both delivery ends to agree, unique official
STATION selection, validated #517 location-source provenance, physical PostgreSQL/Mongo tests,
queue/ACL/DLQ readiness, retained outbox availability until consumption, and worker signing
provision verified separately. Reuse only approved existing private-key material through
`SUBSCRIPTION_RUNTIME_DELEGATION_*`; required separate audience is
`LK2_STATION_MEMBERSHIP_DELEGATION_AUDIENCE`. No key or deployment config is created here.
API and worker use the configured commercial owner origin/timeout, bounded response, circuit,
and fixed private routes. Source default does not assert that any production endpoint exists.

Disabling the flag stops new producer adoption and worker delivery. Preserve pending queue facts,
immutable markers/admissions/claims and tombstones. LK/CUP must keep lifetime barriers for any
already-adopted community even with the flag off; old scan code must not revive old participants.
Never erase lifetime state, reset epochs, replay historical unmarked bookings, or rebook as recovery.
Review/remove the flag only after coherent migration/runtime acceptance.

LOCAL checks cover protocol/signature isolation, malformed/oversized/timeout responses, circuit,
new-operation timing, negative markers, old-command replay, original fact delivery and retry.
Physical suites run only on existing owned CI PostgreSQL/Mongo fixtures. Local skips are not physical
proof; CI is not device/provider/production acceptance. TRAINING, legacy LK1 adoption, real signer
provision and cross-repository runtime acceptance remain separate release dependencies.
