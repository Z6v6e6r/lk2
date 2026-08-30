# Follow-up findings

## GL-FU-STATION-OWNERSHIP

- Severity: P1 integrity. Scenarios: B-015, B-016.
- Evidence: create validates UUID syntax, but schema has no tenant-qualified station/court FK and repository persists the supplied station ID.
- Impact: phantom or cross-tenant-opaque station association; no confirmed disclosure because projection joins are tenant-qualified.
- Why non-blocking here: the FREE contour does not promise booking or availability, and UI selects from tenant locations, but direct API integrity remains open.
- Next branch: `codex/games-station-ownership-validation`.
- Acceptance: nonexistent and other-tenant station/court references leave zero game, roster, operation, audit and outbox rows.

## GL-BLOCK-RESERVATION-EXPIRY

- Severity: BLOCKED_CRITICAL for the expiry scenario only. Scenarios: E-028, K-013.
- Evidence: the reservation model lacks a proven current-generation/authoritative-unpaid predicate.
- Impact: automatic release could race payment confirmation or release ambiguous paid capacity.
- Why non-blocking here: `game.reservation.expire.v1` is excluded from the process-manager claim list; FREE create/join/waitlist/cancel remains independent.
- Next branch: `codex/games-reservation-generation-expiry`.
- Acceptance: generation fence, authoritative unpaid evidence, expiry-vs-confirmation physical concurrency, one winner, audit/outbox, default-off rollout.

## GL-FU-LOCK-TIMEOUT

- Severity: P2 reliability. Scenarios: K-015, K-016.
- Evidence: core row-lock order is consistent and the card projector upgrade deadlock is fixed, but stable HTTP lock-timeout/deadlock mapping lacks physical end-to-end evidence.
- Impact: rare transient error may be less actionable; no durable corruption reproduced.
- Next branch: `codex/games-lock-timeout-contract`.
- Acceptance: bounded two-session swapped operations, no deadlock, stable retryable error mapping, metrics.

## GL-FU-CANCEL-COMMS

- Severity: product/security policy required. Scenarios: H-026..H-028, J-013.
- Evidence: cancellation does not implement notification or chat revocation in this wave.
- Impact: cancelled-game historical/read/write chat behavior remains policy-dependent.
- Why non-blocking: communications are explicitly owned by PR #137/#151 and were not changed.
- Next branch: GAME chat after PR #135.
- Acceptance: authoritative historical-read/send/realtime policy and physical cancel-vs-message tests.

## GL-P0-01 / GL-P0-02 / GL-P0-03

- Severity: P0 if activated. Scenarios: paid/provider create/join, paid leave, paid cancel/refund/entitlement.
- Evidence: no provider saga is available; this wave forces free create/cancel, fails paid leave/promotion closed, and keeps command flags default off.
- Impact: provider/money divergence if future code bypasses the gates.
- Next branch: separate R3/R4 Commerce/provider sagas after authoritative contracts.
- Acceptance: durable external-attempt identity, ambiguity/reconcile states, sandbox evidence, compensation exactly once, and independent payment-safety review.

## GL-BLOCK-RUNTIME / GL-FU-BROWSER-LINEUP

- Severity: evidence gap. Scenarios: K-026..K-031, U-001..U-003.
- Evidence: no staging/production flag, binding, provider or browser-local lineup was observed.
- Why non-blocking: source/integration readiness does not authorize or imply deployment/runtime truth.
- Acceptance: separately authorized exact-runtime readback and real-browser evidence.
