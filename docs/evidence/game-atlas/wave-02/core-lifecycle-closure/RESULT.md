# Core Game Lifecycle closure result

## Exact candidate

- Scope: `FREE / LOCAL / NO_PAYMENT`; source plus disposable-local evidence only.
- Frozen base: `071f1dd22dcfdbfcaebe362f8778ad04228d368b`, tree `41475d56f79dd788a41bc2f310d197a8e623501b`.
- Monday checkpoint preserved at `99d521412531be15b9a15df949eaa121f6ae664f`, tree `fede6722e4de65bdb4de2d6b4a10707acda1e634`.
- Verified implementation candidate: `e13f242949cb50608bb16fd6779e7ec9ef51861c`, tree `a3c4b6a18b0161e61850e7e0556c22b1a657430e`.
- Atlas identity: audit `52e61ab444675b1f6c2ad0e950f914a2339a3320`, matrix blob `6ec45b4399ba5718ba9dd2d2c281882eaae3c57d`, `344 x 101`.

## Critical evidence

- Explicit traceability: all `58` Critical IDs map exactly once to an expected executable result; classification remains `58 Critical / 31 Important / 255 Edge`.
- Final focused run: `9 files passed + 1 opt-in file skipped`, `87 passed / 24 opt-in skipped`. The same opt-in assertions were then executed physically.
- Final guarded HTTP/PostgreSQL run: `17/17 passed` (`6` verifier guards + `11` physical lifecycle tests).
- Physical create recovery/RLS: `13/13 passed`; it includes concurrent same-key create, last seat, forced `NOSUPERUSER NOBYPASSRLS NOINHERIT` tenant isolation and rollback/readback.
- Canonical physical roster verifier: direct/SPLIT last-seat races, replay, operation readback, waitlist promotion/replay, reservation method, projection replay and winner-bound SPLIT snapshot all passed.
- Cancel cutoff uses one PostgreSQL `clock_timestamp()` inside the guarded update. Every rejected cancel writes one atomic `GAME_CANCEL_REJECTED` audit; physical readback proved `4 rejected / 1 successful cancel` and one successful leave audit.
- Cancelled aggregate projected at revision `5`, then read through the real public detail and authenticated history API as `CANCELLED`.
- Important Wave 1 proved join/cancel and promotion/cancel under both deterministic serialized orders plus concurrent contention; promotion replay was stable. Waitlist replay passed. Reservation-expiry ownership and timeout/deadlock mapping remain debt.

## Gates

- `format:check`, `lint`, `typecheck`: PASS.
- `contracts:lint`: PASS with six pre-existing warnings; no contract diff.
- `db:migrate:check`: PASS across 93 migrations; no migration diff or apply to shared state.
- Full build: PASS before final remediation; affected final `@phub/database` and `@phub/api` builds: PASS.
- Runtime imports: PASS.
- Full suite was run once: `445 files passed / 7 skipped / 4 failed`; `3567 tests passed / 131 skipped / 3 failed` plus one `beforeAll` failure. The four failures were isolated Docker-socket, loopback-listen and load-timeout effects. Their exact unchanged rerun passed `4 files / 70 tests` with one worker.
- The final physical run initially exposed two test-harness defects (undocumented waitlist response field and invalid `limit=100`); both were corrected without weakening assertions, and the third/final run passed `17/17`.

No browser journey, live runtime, provider/payment operation, deployment, migration apply, activation or shared mutation was performed. Paid paths remain fail-closed. See `GAME_DEBT_BACKLOG.md` for exact non-Critical debt.

```ini
CRITICAL_TOTAL=58
CRITICAL_PASS=58
CURRENT_MAIN_INTEGRATION=PASS
CREATE_CRITICAL=PASS
JOIN_CRITICAL=PASS
LEAVE_CRITICAL=PASS
CANCEL_CRITICAL=PASS
LAST_SLOT_CONCURRENCY=PASS
DUPLICATE_RETRY=PASS
PERMISSIONS=PASS
FINAL_READBACK=PASS
IMPORTANT_WAVE1=3/5
UNKNOWN_P0=0
MERGE_READY=YES
```

`MERGE_READY=YES` applies only to this bounded source integration candidate. It does not authorize merge, deploy, migration, activation, provider writes or live/shared mutation.
