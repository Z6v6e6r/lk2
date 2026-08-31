# Core Game Lifecycle closure result

## Scope and identity

- Closure scope: `FREE / LOCAL / NO_PAYMENT`, source plus disposable-local integration evidence.
- Branch base: `origin/main` `3f07b88b2429c0c174f0a6b915562a10b95f7faf`, tree `d3730eff93679e290d0643b54e2c44359ec93a19`.
- Atlas: canonical audit commit `52e61ab444675b1f6c2ad0e950f914a2339a3320`, matrix blob `6ec45b4399ba5718ba9dd2d2c281882eaae3c57d`, 344 rows by 101 columns.
- Newest reused overlay: `docs/evidence/game-atlas/wave-01/free-lifecycle/`, frozen at `c47e77bfb321ce03736bde48ae62700de783aae8`, followed by station-ownership fix `e590f21eac6d18c0cba91eeab5cf9be5d0d0c69d`.

## Executable classification

`scripts/game-lifecycle-critical-classification.test.ts` parses the canonical CSV and proves exactly one classification for each unique scenario: 58 `CRITICAL`, 31 `IMPORTANT`, 255 `EDGE`.

The mandatory Critical journeys are backed by the composed HTTP/PostgreSQL suite and focused repository/web regressions. The composed suite verifies create failures and replay, join revision/permission/replay, a physical two-request last-seat race, leave/owner behavior, cancel authorization/replay/after-start/terminal guards, and direct aggregate/participants/reservations/operations/audit/outbox readback.

## Final evidence

- Physical API/PostgreSQL: `11 passed`, including one `200` plus one deterministic `409 GAME_FULL` for simultaneous last-seat joins, two distinct active users at capacity, zero active reservations, and no duplicate membership.
- Physical create recovery: `13 passed` in the combined focused run.
- Focused Critical regression run: `151 passed` before the constraint-valid terminal fixture was added; the final affected physical suite then passed `11/11`.
- Canonical physical roster verifier: direct and SPLIT last-seat races passed; replay, operation readback, waitlist promotion/replay, reservation expiry method, projection replay and final stored counts passed. The SPLIT snapshot readback matched the winning player, operation, game, decision and `paymentMode=SPLIT`.
- Full gate components: format, lint, typecheck, contract lint, complete build and runtime imports passed. Contract lint retained six pre-existing warnings.
- Full repository test attempt: 435 files and 3527 tests passed; 24 tests in 12 unrelated infrastructure/publication/restore suites failed under sandbox through Docker/loopback denial or parallel timeout. An unsandboxed rerun was refused by the safety gate because those entrypoints may reach live/shared infrastructure; no bypass was attempted.
- Independent lifecycle remediation review: `APPROVE WITH NOTES`, with no remaining blocker/high finding.

No new two-user browser smoke was run. The current-source overlay's existing browser evidence was reused, while the missing exact-head second-user browser lineup remains `GL-FU-BROWSER-LINEUP` (`P2_EVIDENCE`). Paid/provider activation and automatic reservation-expiry orchestration remain fail-closed and are not included in readiness.

```ini
CRITICAL_GAME_MATRIX=100% CLASSIFIED
CREATE_CRITICAL=PASS
JOIN_CRITICAL=PASS
LEAVE_CRITICAL=PASS
CANCEL_CRITICAL=PASS
LAST_SLOT_CONCURRENCY=PASS
DUPLICATE_RETRY=PASS
PERMISSIONS=PASS
FINAL_STATE_READBACK=PASS
UNKNOWN_P0=0
INTEGRATION_READY=YES
```

`INTEGRATION_READY=YES` means ready for source integration of this bounded FREE/local closure. It does not authorize merge, deployment, migration, activation, provider writes or live/shared mutation.
