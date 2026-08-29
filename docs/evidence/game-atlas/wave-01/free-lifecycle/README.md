# Free/local Game Lifecycle wave 01 evidence

## Objective

Close the source/integration contour for FREE / LOCAL / NO_PROVIDER Games without enabling provider, payment, entitlement, notification, chat, deployment, or live-data behavior.

## Identity and scope

- Audit source: `docs/audits/game-lifecycle-2026-08-28/process-matrix.csv` (historical frozen main `e6abb48e135f8f28730bab1c07abe408e8c94600`).
- Integrated origin/main: `be2e080d2a0c3c667a318f1dff73e0fc1d0d63ab`.
- Carry-forward merge head before this wave: `71ca7e19465bf913421091646dee917ac8daec14`.
- Final candidate head/tree: PENDING_FINAL_FREEZE.
- Branch: `codex/lk2-core-game-journey-closure-20260826`; Draft PR #135.
- Canonical audit matrix is unchanged. This directory is the current-source overlay.

## Scenario counts

- Reviewed: 296.
- BLOCKED_EXTERNAL: 15.
- BLOCKED_PRODUCT_DECISION: 6.
- CLOSED_LEGACY_OWNED: 28.
- CLOSED_MAIN: 183.
- CLOSED_UNSUPPORTED: 27.
- DEFERRED_P2_P3: 33.
- STILL_OPEN: 4.

## Closed in this wave

- Missing-dependency projector events can be redelivered with the same event ID; successful duplicates remain fenced.
- Same-game card projection locks the aggregate before projection writes, removing the shared-lock upgrade deadlock.
- Free waitlist promotion is claimed by the existing scheduled-command process manager and is process-idempotent across crash/replay.
- Paid automatic promotion and paid leave fail closed before roster/capacity mutation.
- Scheduled Games mutations require both read and command flags; invalid commands-only configuration is rejected.
- Create and roster mutations return aggregate revisions; Web readback waits for `readRevision >= aggregateRevision` and distinguishes updating/unavailable states.
- The real `?new=1` create intent is consumed once, so cross-tab lost-response reload converges to resolved G1 instead of minting K2.
- Tenant-scoped projection lag scan is available; recovery uses idempotent event replay, never arbitrary row updates.

## Unsupported and blocked

Paid/provider create, paid leave/cancel compensation, provider reconcile, refunds, entitlements, hard/soft delete, notification/chat changes and live runtime proof remain outside this wave. Reservation expiry is not claimed: the current model cannot prove current generation plus authoritative unpaid state, so releasing capacity would be unsafe.

## Tests and evidence

See `postgres-evidence.md`, `browser-evidence.md`, `follow-up-findings.md`, and `recovery-runbook.md`. A real local create/projection/cancel and two-tab lost-response recovery run passed. Exact-head automatic CI and the remaining second-user join/waitlist browser flow are pending final freeze.
