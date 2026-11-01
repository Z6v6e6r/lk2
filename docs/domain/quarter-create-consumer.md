# Quarter CREATE consumer

Source-only Web/API slice. Existing `GAME_COMMERCIAL_CREATE_ENABLED` remains default off and prohibited in production; explicit `GAME_COMMERCIAL_CREATE_OWNER_TRANSPORT=QUARTER_OWNER` selects this owner only. ADVISORY/BOOKED_OPERATION and old POST /games are not aliases or fallbacks. Owner: R1 commercial release owner. Activation requires coherent reviewed LK owner/CUP quarter publication and instance adoption, migration0110 after0105–0109, fresh typed location bindings, exact existing signing/actor configuration, importer convergence and independent CI/runtime acceptance. Review/remove the selector only after that consumer supersedes its rollout purpose. No configuration, credential, signing or deployment changes are included.

The public form sends exactly stationId, courtId, startsAt and subscriptionId. Duration60, four places and one organizer quarter are fixed by the private owner. User titles, visibility/level/waitlist edits are not forwarded as applied facts. The existing whole court price capsule is immutable; this consumer neither reprices nor divides the entitlement again. Private raw preparation capsule matches the LK response, without a public wrapper or provider IDs. The frozen owner fixture SHA is `7d69645b0ce2aea081e723462b97d201560df19e4e2c2a120cd0801e49cb14b0`.

## Custody and recovery

0110 is expand-only. Tenant FKs and FORCE RLS protect the journal; no canonical game/roster row is inserted. The same existing raw-key advisory lock `game-command:<tenant>:user:<actor>:<key>` and `games.command_idempotency` fence (`game.quarter-create.v1`) serialize old and new writers. Older binaries reject this command type rather than dispatching an ordinary create. Draft UUID and operation UUID have distinct deterministic domains; the original public tuple/key remain immutable.

| Durable state                   | Explicit next action                                                                                            |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Absent on initial command       | Persist PREPARING before nonbinding owner preparation                                                           |
| Absent on restrictive reconcile | Persist exact REFUSED_NOT_DISPATCHED and old-writer fence; no context/provider lookup                           |
| PREPARING                       | Acquire bounded DB-clock lease; repeat only nonbinding prepare; stale ACK/refusal cannot install facts          |
| PREPARED                        | Exact original capsule expires to EXPIRED_NOT_DISPATCHED only in command transaction, or claim DISPATCH_STARTED |
| DISPATCH_STARTED                | Original admission with signed recovery_only; never reprepare, replace capsule or issue another provider CREATE |
| CONFIRMED / REJECTED            | Retain immutable owner receipt; read current observation independently                                          |

Only source-supported exact nonbinding preparation409 refusals or exact403 GAME_CREATE_PREPARATION_SUBSCRIPTION_MISMATCH may terminalize PREPARING under its current lease. Generic409/404, transport error, token loss, timeout or unknown admission never permit a new key. Refused/expired/rejected original keys remain readable permanently. A dispatched capsule that expires before owner creation can remain pending: there is no invented cancellation, release reason or refund. Reconciliation follows the original owner runbook, never a manual room/time adoption.

Browser custody is principal-scoped and saved before first HTTP under the same WebLock as ordinary CREATE. Reload is read-only. Manual reconcile keeps the original body/key; no automatic401/network mutation retry. Exact no-dispatch/rejection proof permits an explicit new choice. Confirmed+AVAILABLE permits explicit archive and a deliberately different target only; history writes precede clearing active custody. Storage/lock/account failures preserve custody. The gateway reuses the synchronous logout/session epoch: queued locks, capability and subscription reads, pre-dispatch checks and late ACKs require the original principal epoch, even while revocation is pending or fails. Disabled owner composition keeps local historical read available, with UNKNOWN current registration and no signing/provider request; all commands remain disabled.

## Canonical game projection

The existing legacy importer is the sole game/roster writer. Under its existing tenant import lock, the resolver requires BOTH synced original exercise mappings (`VIVA/exercise` and `LK_LEGACY_SNAPSHOT/game`), bounded coherent redirects, the original station/court/time/4places, exact actor profile and original organizer participation. A receipt alone never creates or schedules a game. A canonical cancelled game can remain linked; current registration is independently UNKNOWN unless freshly confirmed by the owner. Alias disappearance/drift fails closed, and GET does not update the stored projection.

Public operation CONFIRMED + projection PENDING is displayed explicitly. No fake JOIN receipt is produced. CREATE-driven station enrollment is a separate outstanding producer dependency. Android/iOS quarter CREATE transport is not widened by this slice.

Owner transport metrics contain only bounded operation/outcome labels and duration. Request bodies, actor tokens, proof claims, provider identifiers and operation IDs are never metric fields; observer failure cannot change command outcome.

## Rollback and evidence

Through a separately approved configuration operation, set the paired dormant values `GAME_COMMERCIAL_CREATE_ENABLED=false` and `GAME_COMMERCIAL_CREATE_OWNER_TRANSPORT=ADVISORY` (false with QUARTER_OWNER is intentionally invalid); retain0110, its old-writer fences and all receipts. Do not delete/rewrite unknown attempts, revert an applied migration destructively or run an old writer against a removed fence. Imported games and provider state are untouched. Physical PostgreSQL tests run only in the existing localhost GitHub CI fixture with unique owned tenants/role and independent pools; no local provisioning is authorized. SOURCE, LOCAL synthetic tests, CI, PROVIDER and PRODUCTION remain distinct. Runtime/provider acceptance and native support are not claimed by green source checks.
