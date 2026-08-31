# Core Game Lifecycle closure

## Atlas identity

- Canonical 344-scenario Atlas: `docs/audits/game-lifecycle-2026-08-28/process-matrix.csv`.
- Canonical audit commit/blob: `52e61ab444675b1f6c2ad0e950f914a2339a3320` / `6ec45b4399ba5718ba9dd2d2c281882eaae3c57d`.
- Historical source frozen by that audit: `e6abb48e135f8f28730bab1c07abe408e8c94600`.
- Newest current-source overlay used instead of repeating the audit: `docs/evidence/game-atlas/wave-01/free-lifecycle/`, frozen by `c47e77bfb321ce03736bde48ae62700de783aae8` and followed by the station-ownership fix at `e590f21eac6d18c0cba91eeab5cf9be5d0d0c69d`.
- Monday source checkpoint: `99d521412531be15b9a15df949eaa121f6ae664f`, tree `fede6722e4de65bdb4de2d6b4a10707acda1e634`.
- Current-main closure base: `origin/main` at `071f1dd22dcfdbfcaebe362f8778ad04228d368b`, tree `41475d56f79dd788a41bc2f310d197a8e623501b`.

## Classification

The executable classification is in `scripts/game-lifecycle-critical-classification.test.ts`. It reads the unchanged canonical matrix, validates all 344 rows and 101 columns, requires unique scenario IDs, applies one non-overlapping class to every row and pins every Critical ID to one explicit expected executable result:

| Class       | Rows | Scope                                                                                                             |
| ----------- | ---: | ----------------------------------------------------------------------------------------------------------------- |
| `CRITICAL`  |   58 | Mandatory FREE / LOCAL create, join, leave, cancel, permissions, retry/concurrency and canonical readback         |
| `IMPORTANT` |   31 | reservation expiry, waitlist, promotion, notification trigger, cancel/join race and scheduled recovery            |
| `EDGE`      |  255 | all remaining provider/payment, legacy ownership, communications, result/rating, runtime and noncritical variants |

`EDGE` is an explicit default only after the complete CRITICAL and IMPORTANT ID sets are matched. Therefore no Atlas row remains unclassified.

The mapping test proves identity and traceability, not runtime execution. `CRITICAL_PASS=58` additionally requires the focused assertion files and the opt-in `HTTP_POSTGRES` / `POSTGRES_RLS` suites to pass against the guarded disposable database; the exact commands and counts are frozen in `RESULT.md`.

## Closure boundary

This wave closes source and disposable-local integration evidence only for `FREE / LOCAL / NO_PAYMENT`. It does not activate feature flags, deploy code, mutate shared/live data or claim provider/payment correctness.

Paid create/join/leave/cancel remains fail-closed. Reservation expiry remains intentionally unclaimed: the current data model cannot prove a current reservation generation plus authoritative unpaid state, so automatically releasing capacity could race a late payment confirmation. Free waitlist promotion is already wired and remains in the Important verification subset.

The composed regression suite `apps/api/src/games/game-lifecycle-http-postgres.test.ts` is the API-to-durable-state oracle for the Critical set. It is opt-in and refuses non-loopback or non-`*_verify` PostgreSQL targets.

Current main's notification projector consumes the strict Game confirmed, left and cancelled event contracts. The Game repositories remain the only lifecycle writers and commit the aggregate, audit and outbox event in one transaction. This closure does not change those notification payloads or let a downstream consumer write Game state. Chat membership convergence is recorded separately in `GAME_DEBT_BACKLOG.md` and is not represented as closed.

## Result contract

The final result must be derived from the final test output; a source, build, HTTP status, old audit or skipped PostgreSQL suite is not converted into PASS. See `GAME_DEBT_BACKLOG.md` for deliberately noncritical or blocked work.
