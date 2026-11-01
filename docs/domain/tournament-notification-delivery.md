# Tournament notification delivery

Source-only R1 consumer of the [private CUP query contract](../contracts/tournament-chat-notifications.md).
No live enrollment, key installation, grants, migration execution or provider activation is included.

## Durable custody and recovery

Migration 0114 adds tenant-isolated immutable sources, publication facts and original
recipient contexts. One source is explicitly bound to a tournament, owner namespace,
incarnation, stream and replay floor. Publication pages pin a contiguous frontier;
staging `after_sequence` advances atomically with facts. `completed_sequence` means
**fanout durably queued**, not projection or provider delivery completed. It advances
only when every staged fact through that frontier has a completed recipient traversal.
Pending recipients remain independently claimable afterwards.

Each cycle reads at most one publication page, one recipient page and projects one
recipient. Empty advancing pages continue scanning. Snapshot failure restarts the
bounded scan while retaining original contexts; it cannot acknowledge a partial scan.
Leases use exact random tokens and bounded backoff. Duplicate facts must match their
original immutable tuple. Restarted recipient observations retain the first captured
read position and never change the original witness or baseline.

Canonical user identity is resolved from the original JOIN generation or explicitly
assigned organizer and the current unique VIVA mapping. Projection rechecks source,
active identity and mapping under local locks and uses the same mapping that produced
the owner proof. A short advisory transaction lock and unique message/user context
prevent duplicate projection across pages or concurrent workers. DENY does not reserve
a user key; a later eligible original context can win. A chosen context cannot rebind.
Intent, inbox, deliveries, audit and recipient completion commit together. Proof expiry
before transaction completion rolls all projection writes back.

## Delivery policy and ambiguity

IN_APP honors MESSAGING opt-out. PUSH also honors current runtime settings, quiet hours,
provider configuration, endpoint ownership and the FCM rollout gate. Payload previews
are generic and open `/notifications`; chat text and provider identity never enter them.
The sender verifies current owner eligibility for the retained original context and
passes its expiry check through the existing provider socket-submission gate.

Push uses `TOURNAMENT_PENDING` / `TOURNAMENT_SENDING`, claim generations and a durable
dispatch-start marker. Ordinary/station/scenario workers cannot consume those states;
SQL floors reject context stripping, rebinding and accidental generic projection.
Only errors proving non-submission or explicit rejection can retry. Ambiguous results,
including a lost ACK after provider acceptance, end with
`TOURNAMENT_PROVIDER_OUTCOME_UNKNOWN`; expired-lease recovery never sends a marked job
again. This favors avoiding duplicate side effects over guaranteed delivery. CUP can
change eligibility immediately after a query; no cross-database atomic delivery claim
is made. There is no manual retry/rebind escape hatch in this change.

## Activation and retained rollback

Owner: Engagement/R1. `TOURNAMENT_CHAT_NOTIFICATION_DELIVERY_ENABLED=false` is the
worker default; the separate `TOURNAMENT_CHAT_NOTIFICATION_ENABLED` query gate and
complete dedicated credential configuration are also required. Review or remove these
gates after the controlled rollout. `provisionTournamentSource` is an explicit helper
with dry-run by default at the caller boundary; it requires admin plus
`notifications.manage`, validates the owner namespace and provisions a disabled source
and inactive exact template/rule with an idempotent receipt. Workers never call it.

Before activation, separately approve an immutable source, migration 0114 apply target,
query credential scope/installation, least-privilege grants, exact source replay floor,
provider/device acceptance and rollout. None is supplied by green CI or this Draft PR.
Observe staging/completed gaps, recipient PENDING age, held dependency codes, delivery
state and unknown-outcome counts through the durable tables/audit. No private query
body, witness, provider ID or credential is logged.

Rollback disables the delivery/query gates and stops the new worker before source
changes. Retain 0114 tables, original witnesses, context columns and dispatch markers;
never convert new states into ordinary/station states or delete receipts. Old workers
leave these jobs untouched. Resume only with compatible source and explicit authority;
unknown outcomes remain terminal. Migration 0112 and the frozen release ledger remain
unchanged. A real schema apply and rollback are separate approved operations.

## Evidence limits

Unit tests use synthetic owner responses. Physical tests run only in the existing
strictly identified disposable PostgreSQL CI service and use no real provider. They
exercise cursor restart, >50 witness deduplication, independent claims, rollback,
expiry, immutable schema floors and ambiguous delivery recovery. LOCAL/CI results do
not establish STAGING, PROVIDER, device or PRODUCTION acceptance.
