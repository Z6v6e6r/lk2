# GAME_DEBT_BACKLOG

## GL-BLOCK-RESERVATION-EXPIRY

- ID: `GL-BLOCK-RESERVATION-EXPIRY`
- SEVERITY: `BLOCKED_CRITICAL` for Important expiry only
- SCENARIO: `E-028`, `K-013`, reservation expiry and worker recovery
- REPRO: an ACTIVE paid reservation can outlive its nominal expiry because the process manager deliberately does not claim `game.reservation.expire.v1`.
- EXPECTED: generation-fenced expiry competes safely with payment confirmation; exactly one transition wins and emits one audit/outbox result.
- ACTUAL: generation and authoritative unpaid predicates are not available, so automatic release remains disabled to avoid corrupting capacity.

## GL-FU-CANCEL-COMMS

- ID: `GL-FU-CANCEL-COMMS`
- SEVERITY: `P2 / PRODUCT_POLICY`
- SCENARIO: `F-017`, `H-026..H-028`, `J-013`, promotion/cancel notification, chat and realtime policy
- REPRO: perform a free promotion or cancel and inspect downstream notification/chat/realtime consumers.
- EXPECTED: an approved product policy drives a durable, idempotent notification/revocation trigger.
- ACTUAL: core outbox events exist, but no Game-owned notification consumer or complete cancellation communications policy is claimed by this branch.

## GL-FU-LOCK-TIMEOUT

- ID: `GL-FU-LOCK-TIMEOUT`
- SEVERITY: `P2`
- SCENARIO: `K-015`, `K-016`, lock timeout and deadlock retry mapping
- REPRO: hold conflicting locks in two sessions and issue a user command through the API.
- EXPECTED: bounded wait, stable retryable API result and observable metric without durable partial state.
- ACTUAL: lock order is consistent and corruption has not been reproduced; stable HTTP timeout/deadlock mapping lacks physical API evidence.

## GL-FU-CANCEL-JOIN-RACE

- ID: `GL-FU-CANCEL-JOIN-RACE`
- SEVERITY: `P1 / IMPORTANT`
- SCENARIO: `H-021`, cancel and join issued concurrently for the same scheduled free game
- REPRO: hold neither command lock, then issue owner cancel and player join at the same instant through two API sessions.
- EXPECTED: one serial order is durable; a join that loses to cancel returns a stable conflict, while a join that wins is included in the cancellation readback and no partial state remains.
- ACTUAL: join/join last-seat serialization and cancel-with-joined-players are physically proven, but the cancel/join race itself is classified Important and not claimed by this Critical wave.

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
