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

## Training registration consumer

The private v1 wire accepts TRAINING / TRAINING_REGISTRATION as an exact pair.
The source is the verified owner preparation capsule's providerStudioId. Generation
is the validated original training receiptId, independent of the outbox event ID.

Migration 0108 only adds nullable private station_membership to the 0107 journal.
Old NULL rows remain unadopted. A newly inserted operation may capture PENDING_ADMISSION
when the existing station lifetime flag is enabled. Before any station admission POST,
the preparation lease pins the complete canonical original authority as INTENT.
Recovery reuses it and rechecks original actor/provider mapping and signing identity;
it never refreshes studio, expiry or operation identity. Terminal owner response or
NO_ENROLLMENT and that same authority commit with the prepared outbox event atomically.
Timeout is terminal OWNER_UNAVAILABLE; disabling the flag yields DISABLED. Expired
capsules follow the original non-dispatched expiry path. A late ACK cannot upgrade a
terminal negative. Training booking can complete when station enrollment is unavailable.

The worker consumes only training.registration.confirmed.v1 and rereads its exact
persisted event, CONFIRMED journal, hashes, receipt and terminal admission. It sends
TRAINING_REGISTRATION with receiptId to the owner. Membership epochs protect LEFT,
removed and banned members; cancellation retains membership. No training-leave or
same-training rebooking contract is invented: 0107's actor/target fence remains.

Activation requires an authorized 0108 migration, compatible LK TRAINING owner,
existing signing readiness, coherent flag ownership, outbox retention and DLQ recovery
evidence. API startup runs no migration. Flag-off SQL does not name the new column on
0107; expanded rows can still be read. Rollback disables producer/consumer and retains
the column, markers, admissions and claims. Never backfill NULL rows or delete ledgers.
Old code may complete while the marker remains INTENT; the new worker never enrolls
that incomplete station fact. No automatic backfill or operator replay is authorized.

LOCAL checks use synthetic data; physical PostgreSQL and MongoDB cases use existing
CI disposable services. Flag-off compatibility includes SQL-column exclusion with a
0107-shaped response over CI PostgreSQL, not a separately provisioned old database.
Provider, staging, production and device acceptance remain outstanding. Flag default
remains off; this source packet does not activate the feature.

The additive CHECK may scan existing journal rows under ALTER lock. Lock/statement
timeouts bound failure; production lock-duration acceptance requires separate rehearsal
and migration approval. Rollback retains the column rather than dropping data.

## Quarter CREATE organizer producer

This source adds explicit `GAME_CREATE` admission and `GAME_CREATE_ORGANIZER`
confirmation. It does not relabel CREATE as JOIN. The reviewed LK receiver #280
must be installed before this producer; older receivers reject the new kinds.
The quarter CREATE journal remains separate from canonical game/roster projection:
the existing importer is the only writer of those rows. Enrollment does not wait
for projection and does not manufacture a game, participant or provider booking.

Migration 0111 adds only nullable private `station_membership` to 0110. NULL is
permanent pre-adoption: existing, completed and restrictive absent-row refusals
are never upgraded. New commands under the existing station lifetime flag begin
with `PENDING_ADMISSION`. The preparation lease pins the complete verified original
CREATE admission and its canonical hash as `INTENT` **before** station admission
POST. Subsequent retries reuse exactly that capsule, actor, request and operation;
no newer preparation timestamp or membership epoch is substituted. The existing
station signer supplies a fresh session-bound delegation. No bearer token, signing
material, provider response body or delegation is persisted in this marker.

Only an exact validated receiver response becomes `OWNER_ADMISSION`, atomically
with the same original CREATE capsule in PREPARED. The existing finite explicit
NO_ENROLLMENT reasons are preserved (including blocked membership); such a result
permits booking without enrollment. Disabled/unready receivers, missing transport,
malformed responses and timeouts hold the operation before any CREATE dispatch.
A handled failure releases only its own preparation lease; it never releases key
custody or refreshes the capsule. A crash retains the bounded lease. A command can
expire an original pinned capsule using the DB clock, recording
EXPIRED_NOT_DISPATCHED with that same capsule; reads never expire or dispatch.
Pending station admission is exposed as GAME_QUARTER_CREATE_STATION_ADMISSION_PENDING.
No claimDispatch/recoveryOnly marker is created merely to guard station admission.

Exact terminal combinations are PENDING_ADMISSION + pre-prepare refusal,
INTENT + pinned expiry, OWNER_ADMISSION + prepared expiry or owner REJECTED,
and CONFIRMED_FACT + confirmed original receipt. The additive CHECK rejects old
prepare/dispatch writes for incomplete adopted markers and old completion without
CONFIRMED_FACT. Canonical hashes and every capsule/actor/context/receipt binding are
verified again on reload; SQL constraints alone are not cryptographic verification.

Confirmation writes the immutable receipt, CONFIRMED_FACT, audit and (only for an
ADMITTED original receiver result) `game.quarter-create.organizer-confirmed.v1`
outbox event in one transaction. Its payload contains public operationId, draftId,
userId, generationId and status only. Generation is UUIDv8 of the canonical hash
under `station-quarter-create-generation:v1` over tenantId and original provider
client/exercise/booking IDs. Operation/key/timestamps are deliberately excluded:
replaying one original booking with a different key cannot create a new generation.
Provider IDs stay in private integration custody, never in this event/public DTO.

The worker reloads the exact persisted event, canonical command fence and confirmed
journal, recomputes receipt/capsule/generation hashes, and signs the explicit CREATE
fact. Missing or corrupt facts retry through the existing quorum delivery limit/DLQ;
no provider read, user impersonation, re-admission or new booking occurs. Receiver
claims are kind-namespaced: no cross-kind JOIN/CREATE deduplication is claimed.
Cancellation retains membership; same original CREATE generation cannot restore
LEFT; a genuinely new confirmed registration may restore LEFT only under its new
admission. REMOVED/BANNED remain blocked. Explicit NO_ENROLLMENT emits no enrollment
event; it is not an ambiguous worker skip.

Activation requires separately authorized 0111 migration, coherent API/worker and
receiver versions, draining old in-flight API writers, signer/queue readiness and
physical CI plus runtime acceptance. An old binary can still insert NULL; this
packet does not invent a writer-floor service. Defaults/credentials are unchanged.
Rollback stops producer/delivery via existing gates and retains all markers,
receipts, outbox and receiver claims. Adopted INTENT stays held while transport is
disabled, never downgraded to NO_ENROLLMENT. Do not drop the column or backfill NULL.
The CHECK may scan existing rows; bounded lock/statement timeouts are not production
lock-duration evidence. LOCAL synthetic tests and CI-only physical fixtures do not
prove provider, deployment, device or production acceptance.
