# GAME_DEBT_BACKLOG

## GL-BLOCK-RESERVATION-EXPIRY

- ID: `GL-BLOCK-RESERVATION-EXPIRY`
- STATUS: `GL-P1-03=CLOSED_BY_FAIL_CLOSED_PAID_JOIN`
- SEVERITY: `P2 / PRODUCT_DEBT`; automatically returns to `P1` if paid join is enabled without the complete expiry/recovery contour.
- SCENARIO: `E-028`, `K-013`, reservation expiry and worker recovery
- RELEASE BOUNDARY: `SPLIT` and `SUBSCRIPTION` joins are rejected with `GAME_PAYMENT_REQUIRED` at the authoritative repository boundary before eligibility, payment snapshot, reservation, scheduled command, outbox or invitation writes. Re-enabling either mode is an R3 release change.
- REPRO (historical): before `GL-P1-03` closure, an ACTIVE paid reservation could outlive its nominal expiry because the process manager deliberately did not claim `game.reservation.expire.v1`.
- EXPECTED: generation-fenced expiry competes safely with payment confirmation; exactly one transition wins and emits one audit/outbox result.
- ACTUAL: the expiry worker is not implemented and paid joins remain disabled. Before paid join can be enabled, implement generation/payment-fenced expiry, worker recovery, a physical expiry-vs-payment race and ambiguous provider-result reconciliation.

## GL-FU-CANCEL-COMMS

- ID: `GL-FU-CANCEL-COMMS`
- STATUS: `CLOSED`
- SEVERITY: `RESOLVED_P1 / PHYSICAL_MEMBERSHIP_CONVERGENCE`
- SCENARIO: `F-017`, `H-026..H-028`, `J-013`, promotion/cancel notification, chat and realtime policy
- REPRO (historical): perform a free promotion or cancel and inspect downstream notification/chat/realtime consumers.
- EXPECTED: strict Game events drive downstream notification and messaging membership convergence without any consumer writing Game state.
- ACTUAL: the worker registers the durable `phub.game-messaging-membership.v1` quorum consumer for the complete exact `messaging-membership` catalog route. Each event triggers reconciliation from the current locked GAME snapshot: confirmed/rejoined participants become ACTIVE, departed participants become LEFT, and cancellation closes the existing conversation and leaves every active USER member. The projector never creates a conversation, writes GAME state, deletes messages or reopens CLOSED/ARCHIVED conversations. Physical PostgreSQL evidence covers LEAVE/CANCEL, stale LEAVE after rejoin, both SEND race orders, message preservation and duplicate audit-free replay; physical RabbitMQ evidence covers exact routes, bounded retry, poison DLQ and crash redelivery.

## GL-FU-LOCK-TIMEOUT

- ID: `GL-FU-LOCK-TIMEOUT`
- SEVERITY: `P2`
- SCENARIO: `K-015`, `K-016`, lock timeout and deadlock retry mapping
- REPRO: hold conflicting locks in two sessions and issue a user command through the API.
- EXPECTED: bounded wait, stable retryable API result and observable metric without durable partial state.
- ACTUAL: lock order is consistent and corruption has not been reproduced; stable HTTP timeout/deadlock mapping lacks physical API evidence.

## GL-FU-CANCEL-WAITLIST-TERMINALIZATION

- ID: `GL-FU-CANCEL-WAITLIST-TERMINALIZATION`
- SEVERITY: `P2 / PRODUCT_POLICY`
- SCENARIO: promotion and cancel race when cancel wins the Game row lock
- REPRO: fill a free game, enqueue a waitlist promotion, then issue promotion and owner cancel concurrently.
- EXPECTED: promotion is serialized before cancel or becomes an idempotent no-op after cancel; product policy decides whether the historical waitlist row must also become terminal.
- ACTUAL: the physical race proves the promotion is either applied before cancel or stored as a replayable `no_op` after cancel. In the second order the cancelled aggregate can retain an ACTIVE waitlist row that cannot be promoted; explicit terminalization semantics are not defined by this Critical closure.

## GL-EDGE-CANCEL-ACTIVITY-HISTORY

- ID: `GL-EDGE-CANCEL-ACTIVITY-HISTORY`
- SEVERITY: `P2 / EDGE`
- SCENARIO: `H-030`, dedicated user-facing cancellation activity-history entry
- REPRO: cancel a free game and inspect the separate activity-history product surface.
- EXPECTED: one idempotent, user-visible history entry follows the durable cancellation event under an approved retention/presentation contract.
- ACTUAL: operation, aggregate, audit and outbox readbacks are proven; no distinct activity-history product contract is claimed.

## GL-P0-01

- ID: `GL-P0-01`
- SEVERITY: `P0_IF_ACTIVATED`
- SCENARIO: paid/provider create and join (`B-024..B-035`, `E-024..E-034`)
- REPRO: attempt a paid create through the public user command boundary.
- EXPECTED: a separately designed durable provider/payment saga with reconciliation and compensation.
- ACTUAL: paid create is rejected and provider/payment redesign is outside this FREE closure.

## GL-P0-02

- ID: `GL-P0-02`
- SEVERITY: `P0_IF_ACTIVATED`
- SCENARIO: paid/subscription leave (`G-008..G-015`)
- REPRO: attempt to leave a paid participation through the local roster writer.
- EXPECTED: authoritative refund/entitlement/provider compensation exactly once.
- ACTUAL: paid leave fails closed with `GAME_PAYMENT_REQUIRED`.

## GL-P0-03

- ID: `GL-P0-03`
- SEVERITY: `P0_IF_ACTIVATED`
- SCENARIO: paid cancel/refund/entitlement (`H-014..H-020`)
- REPRO: attempt to cancel a game whose payment mode is not `NO_PAYMENT`.
- EXPECTED: provider cancellation, refunds, entitlements and reconciliation are one durable saga.
- ACTUAL: paid cancellation fails closed with `GAME_PAYMENT_REQUIRED`.

## GL-FU-BROWSER-LINEUP

- ID: `GL-FU-BROWSER-LINEUP`
- SEVERITY: `P2_EVIDENCE`
- SCENARIO: second authenticated browser user joins/full/waitlist/promotes after the already captured create/cancel/lost-response journey
- REPRO: use two isolated synthetic browser principals against a disposable local stack.
- EXPECTED: UI converges to the same winner/full/leave/cancel state proven by the API and PostgreSQL suite.
- ACTUAL: the prior real-browser evidence covers create, cancel and lost-response recovery; the second-user lineup remains unobserved in a real browser.

## GL-BLOCK-RUNTIME

- ID: `GL-BLOCK-RUNTIME`
- SEVERITY: `EXTERNAL_EVIDENCE`
- SCENARIO: `K-026..K-031`, deployed flags, migrations/grants, Rabbit bindings and live provider truth
- REPRO: inspect an exact separately authorized deployed runtime.
- EXPECTED: exact-head runtime identity and direct readback at every layer.
- ACTUAL: this branch performs no deployment or live/shared mutation, so runtime activation is not inferred.
