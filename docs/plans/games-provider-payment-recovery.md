# Native Games provider/payment recovery plan

Status: source implementation, synthetic-only, every runtime gate default OFF  
Date: 2026-08-24  
Stacked base: `94264e8cecfd0dc5a13639fef1ef049e3fac23be` (Draft PR #116)

## Decision and boundary

Games roster remains `LOCAL_PRIMARY`; payment truth remains Commerce/provider-owned. This package
does not make Viva authoritative for roster and never reverses a native JOIN/PROMOTION from an
unverified external signal. A verified payment fact may atomically convert the existing reservation
to participation while retaining the original eligibility decision.

No real Viva submit, idempotency, callback authentication, read-back, payment amount, or negative
lookup contract is proven by source or fixtures. Therefore the only executable provider is
`SYNTHETIC/synthetic-v1`. The schema cannot represent `VIVA`, and staging/production activation is
rejected by configuration.

```text
eligibility + reservation + payment snapshot + command + intent (one transaction)
                                |
                                v
                         READY -> SUBMITTING
                                | provider I/O outside DB
                   +------------+------------+
                   v            v            v
                UNKNOWN      REJECTED      NOT_SENT
                   |            |            |
          callback/read-back  release     bounded retry
                   |
          +--------+--------+
          v        v        v
     CONFIRMED  REJECTED  MANUAL_REVIEW
          |
   local apply once
```

Synchronous acceptance is only an acknowledgement and always requires fact-checked read-back.
Expired `SUBMITTING` always becomes `UNKNOWN`, never `READY`. Only an adapter result that proves
`NOT_SENT` may retry submit. Terminal states are monotonic. `MANUAL_REVIEW` means automation is
exhausted; it does not assert payment failure.

## Transactions and concurrency

- T1: JOIN or PROMOTION locks Games state, evaluates eligibility, writes the immutable decision and
  payment snapshot, reservation, command result, audit/outbox, and intent atomically.
- T2: worker claims one due row with `FOR UPDATE SKIP LOCKED`, increments a bounded counter, commits
  a lease plus immutable `STARTED` attempt event, then performs provider I/O without an open
  transaction.
- T3: result transaction fences on lease token, appends attempt/observation, validates exact
  tenant/actor/game/reservation/payment facts, advances state, and applies confirmation once.
- Aggregate mutations use one lock order: game, provider operation, reservation. Expiry uses the
  same order. An uncertain or manual payment holds its seat; a proven pre-dispatch `READY` expiry
  is marked `NOT_SENT` before capacity is released. A provider rejection cancels the reservation,
  bumps the aggregate revision and schedules waitlist promotion atomically.
- Callback processing uses the same row lock, fact matcher and dedupe key. There is deliberately no
  public callback route until provider authentication is proven.
- Client retry reuses the same idempotency key. Web stores the logical JOIN before submit and resumes
  it after refresh; polling is bounded to eight attempts.

## Failure matrix

Legend: R = retry submit; RB = read-back; M = manual; UI `P` = PROCESSING.

|   # | Scenario                                   | Local/provider result               | R/RB/terminal          | Audit, metric, UI                              |
| --: | ------------------------------------------ | ----------------------------------- | ---------------------- | ---------------------------------------------- |
|   1 | accepted + response                        | UNKNOWN then CONFIRMED / accepted   | no/yes/eventual        | ack, read-back, matched success                |
|   2 | rejected + response                        | REJECTED + seat released / rejected | no/no/yes              | rejection, promotion scheduled, failed         |
|   3 | timeout before accept with proven NOT_SENT | READY / absent                      | bounded/no/no          | NOT_SENT attempt, retry, P                     |
|   4 | timeout after accept                       | UNKNOWN / accepted                  | no/yes/no              | ambiguous egress, timeout counter, P           |
|   5 | reset after accept                         | UNKNOWN / accepted                  | no/yes/no              | ambiguous egress, timeout counter, P           |
|   6 | callback normal                            | terminal / terminal                 | no/optional/yes        | callback observation, callback received        |
|   7 | callback lost                              | UNKNOWN then terminal / terminal    | no/yes/eventual        | read-back recovered, callback-loss inferred, P |
|   8 | callback duplicate                         | unchanged / terminal                | no/no/yes              | dedupe observation, callback duplicate         |
|   9 | callback delayed                           | nonterminal then terminal           | no/yes/eventual        | callback/read-back observation, P              |
|  10 | callback out of order                      | terminal monotonic                  | no/no/yes              | stale/conflict anomaly                         |
|  11 | wrong actor                                | UNKNOWN/MANUAL / any                | no/bounded/M           | ACTOR_MISMATCH, actor mismatch, P              |
|  12 | wrong tenant                               | no lookup or UNKNOWN                | no/bounded/M           | TENANT_MISMATCH, tenant mismatch, P            |
|  13 | wrong game                                 | UNKNOWN/MANUAL                      | no/bounded/M           | GAME_MISMATCH, mismatch, P                     |
|  14 | unknown external reference                 | UNKNOWN/MANUAL                      | no/bounded/M           | REFERENCE_MISMATCH, mismatch, P                |
|  15 | legitimate callback replay                 | unchanged                           | no/no/yes              | duplicate counter, same terminal UI            |
|  16 | retry successful operation                 | same CONFIRMED                      | no/no/yes              | stable provider idempotency key, success       |
|  17 | retry rejected operation                   | same REJECTED                       | no/no/yes              | terminal monotonic, failed                     |
|  18 | crash before request                       | expired SUBMITTING -> UNKNOWN       | no/yes/no              | durable STARTED event, lease expiry, P         |
|  19 | crash after accept                         | expired SUBMITTING -> UNKNOWN       | no/yes/no              | lease expiry then recovered, P                 |
|  20 | DB failure after accept                    | UNKNOWN after lease                 | no/yes/no              | rollback then read-back, P                     |
|  21 | local commit, response lost                | durable state                       | same client key/no/yes | replayed command, recovered UI                 |
|  22 | read-back unavailable                      | UNKNOWN                             | no/bounded/M           | READBACK_UNAVAILABLE, attempt counter, P       |
|  23 | ambiguous provider state                   | UNKNOWN                             | no/bounded/M           | AMBIGUOUS_READBACK, anomaly, P                 |
|  24 | entity mismatches expected facts           | UNKNOWN/MANUAL                      | no/bounded/M           | exact mismatch class, P                        |
|  25 | current level changed                      | original snapshot unchanged         | no/as needed/eventual  | new observation only, P/success                |
|  26 | promotion level changed                    | fresh promotion decision            | no/as needed/explicit  | promotion decision audit                       |
|  27 | payment accepted, join unknown             | UNKNOWN until exact apply           | no/yes/M               | payment divergence, P                          |
|  28 | join accepted, payment unknown             | reservation + UNKNOWN               | no/yes/M               | payment divergence, P                          |
|  29 | external duplicate                         | AMBIGUOUS/MANUAL                    | no/bounded/M           | ambiguous counter, P                           |
|  30 | stale callback after terminal              | terminal unchanged                  | no/no/yes              | stale/duplicate observation                    |

Each metric uses only bounded labels: operation action, provider (`SYNTHETIC`), phase, result class,
error class and transition class. Tenant, actor, game, phone, provider reference and free text are not
metric labels.

## Payment and promotion invariants

- No amount is invented. Native Games currently has no canonical expected amount/currency, so real
  SPLIT payment readiness remains false.
- Reconciliation checks the payment snapshot by original command/decision/player/game and never
  updates `eligibility.decisions` or `eligibility.payment_snapshots`.
- Read-back observations use provider-native synthetic references and an explicit terminal status;
  they are not the expected PadlHub fact object echoed back through the adapter.
- PROMOTION creates a new decision and intent only after its existing mandatory fresh evaluation.
- Refund/cancel/compensation is outside this package and no live action exists.

## Gates

All default false and synthetic-only: writer, read-back, callback reconciliation, payment
convergence, promotion recovery. Callback reconciliation is deliberately impossible to enable
until an authenticated callback consumer exists. Payment requires writer + read-back; promotion
requires payment. Eligibility SHADOW/WARN/BLOCK gates are independent and unchanged.

Code remains compatible before migration while all recovery gates are OFF: the operation-status
query omits integration tables entirely. Any future activation still requires expand-first schema
deployment, old-code/new-schema verification, then same-digest application promotion.

Real provider readiness requires official contract/fixtures proving idempotency, stable correlation,
callback authentication/replay, exact actor/game/booking/payment match, terminal/refund semantics,
complete read-back, consistency window, negative lookup, Retry-After policy, circuit breaker and
provider-native amount/currency. Until then provider read-back is NO-GO.

## Rollback

Disable submit first while leaving read-back/reconciliation available for nonterminal intents.
Application rollback is safe only with zero nonterminal intents or a compatible recovery worker.
Migration 0090 is forward-only and retained; it performs no activation or backfill.
