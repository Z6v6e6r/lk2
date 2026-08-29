# PadlHub Game Lifecycle source audit

Audit date: 2026-08-28. Evidence boundary: source and existing tests only. No result in this directory is runtime, provider, staging, production or deployment evidence.

## Executive verdict

The frozen `lk2` main does **not** contain a complete Game Lifecycle. It contains a carefully tenant-scoped, transactionally strong local foundation for reads, roster commands, result commands and card/history projections, but the default/runtime contract deliberately keeps Games disabled in production. The principal user contract has 13 operations while frozen main registers 10; create, publish and cancel are contract orphans. Four of six scheduled command types have no executor. Paid join can reserve a seat, but no public payment completion, expiry runner, entitlement consumption/refund or provider reconciliation closes that journey. Game notifications and Game aggregate realtime invalidation are declarative mappings without concrete consumers.

Two open Draft PRs are PENDING_DELTA only. PR #135 adds free create/cancel and associated UI on exact head `3a35c79d6652e5b3aa1ce7456e03ab18f296a67e`; it does not add publish or paid/provider compensation and its exact-head quality check is red. PR #137 adds GAME chat realtime/recovery/concurrency on exact head `6dc2281a25759aefc482950abceffbb1637156d4`; its exact-head required checks are red. Neither PR is part of frozen main.

The strongest implemented invariants are tenant RLS, user-command idempotency, aggregate row locking, last-seat serialization, revision checks and atomic local outbox/audit writes. The strongest gaps are orphan scheduled commands, provider/payment semantic binding, paid leave/cancel compensation, missing notifications/realtime consumers, and a projector recovery defect that can convert a retriable dependency failure into a permanently deduplicated event.

One redacted P0 security finding exists in the secondary legacy repository: fresh `origin/main` contains a tracked legacy flow artifact with a static credential pattern. The value is intentionally absent from this audit. Whether the credential is still active is UNKNOWN; revocation/rotation and history remediation require a separate security incident process.

## Frozen identity

| Item                        | Value                                                                                          |
| --------------------------- | ---------------------------------------------------------------------------------------------- |
| Canonical repository        | `Z6v6e6r/lk2`                                                                                  |
| Frozen `origin/main`        | `e6abb48e135f8f28730bab1c07abe408e8c94600`                                                     |
| Frozen tree                 | `04be9a04792b586d867ce6def129ad6bfb22a152`                                                     |
| Commit timestamp            | `2026-08-28T14:40:31+03:00`                                                                    |
| Freeze subject              | `Merge pull request #148 from Z6v6e6r/codex/fix-timeweb-buildkit-bootstrap-readiness-20260828` |
| Freeze worktree             | clean isolated worktree at `/private/tmp/lk2-game-lifecycle-audit-20260828`                    |
| Audit branch                | `codex/audit-game-lifecycle-process-matrix-20260828`                                           |
| Legacy `lk` source snapshot | fresh `origin/main` `6edbf010f729b45cf37dadc82bbeccb7233e1594`                                 |
| `ph-admin` source snapshot  | detached `origin/main` `d92e403a07bac7398c10d1023f79d6eba2725aae`                              |

The original `lk2` checkout was dirty and was not changed. PR refs were fetched into audit-only refs and were not merged, rebased or cherry-picked.

## Coverage

| Measure                                                      | Count / result                               |
| ------------------------------------------------------------ | -------------------------------------------- |
| Atomic scenario rows                                         | 344                                          |
| Required CSV columns                                         | 101                                          |
| Scenario groups                                              | 15                                           |
| Canonical user Game operations                               | 13                                           |
| Frozen-main registered canonical user operations             | 10                                           |
| Frozen-main user mutations                                   | 7 (4 roster + 3 result)                      |
| Additional user reads                                        | 4 (public/user list/detail)                  |
| Internal legacy roster/payment bridge                        | 1                                            |
| Domain Game events                                           | 19                                           |
| Internal scheduled command types                             | 6; executors for 2                           |
| Direct Games lifecycle tables                                | 16                                           |
| Additional eligibility/audit/history/messaging tables traced | 23                                           |
| Broad game-relevant frozen test files                        | 80                                           |
| Selected backend lifecycle tests inventoried                 | 140 cases across 25 files                    |
| Tests executed by this audit                                 | 0 product tests; docs/source validators only |

### Implementation status distribution

| Status             | Scenarios |
| ------------------ | --------: |
| MAIN_IMPLEMENTED   |        38 |
| MAIN_PARTIAL       |        40 |
| PENDING_PR         |        32 |
| CONTRACT_ONLY      |        14 |
| UI_ONLY            |         3 |
| TEST_ONLY          |         2 |
| LEGACY_ACTIVE      |        28 |
| PROVIDER_DEPENDENT |         2 |
| FEATURE_GATED      |        90 |
| NOT_IMPLEMENTED    |        84 |
| UNKNOWN            |        11 |

`FEATURE_GATED` means source exists but activation is not proven. It must not be interpreted as deployed functionality. The eleven UNKNOWN rows name the missing evidence and exact acquisition location. The three UI_ONLY rows cover assign/remove/swap actions in the browser-local lineup; they are not shared Game mutations.

## Finding summary

| Priority |                                                               Count | Interpretation                                                                               |
| -------- | ------------------------------------------------------------------: | -------------------------------------------------------------------------------------------- |
| P0       | 1 confirmed security exposure; 3 activation-blocker money/data gaps | No production incident is asserted. Default production config rejects native Games commands. |
| P1       |                                                                  10 | Core journeys/contract/runtime consumers/readback are incomplete.                            |
| P2       |                                                                  14 | Recovery, projection, quorum, observability and test evidence gaps.                          |
| P3       |                                                                   4 | Documentation/UX/test clarity.                                                               |

The detailed evidence and acceptance criteria are in [08-findings-and-backlog.md](./08-findings-and-backlog.md).

## Top broken or unproven journeys

1. Native free create/cancel are absent from frozen main; PR #135 is not merged and is red.
2. Publish remains contract-only even in PR #135.
3. Paid/provider-backed create is not implemented; no durable provider attempt/reconciliation exists.
4. Paid/subscription join stops at a local seat reservation; the public operation can remain PROCESSING.
5. Reservation expiry and waitlist promotion methods exist but no runtime executor invokes them.
6. Native paid leave can mark participation LEFT without provider cancel, refund or entitlement restoration.
7. Native paid cancel/refund/reversal/reconciliation is absent.
8. Game notifications are declared but the worker binds only booking notification routing keys.
9. Frozen-main GAME realtime subscription/fanout is absent; PR #137 is pending and red.
10. Card/result projector dependency failures can be committed to inbox before requeue, making the redelivery a harmless-looking duplicate and leaving read models stale.

## Evidence rules

- `MAIN` conclusions use only frozen SHA `e6abb48e...`.
- PR source is always labelled `PENDING_PR` and includes exact head SHA.
- Legacy and admin source prove source availability, not live deployment or provider truth.
- Existing test names prove only the exercised layer. Route mocks are not PostgreSQL evidence; source is not runtime evidence; fixtures are not provider evidence.
- No UNKNOWN is a guess: each UNKNOWN row names the missing runtime/provider/broker/database evidence and the read-only procedure needed to obtain it.

## Artifact map

- [01-source-inventory.md](./01-source-inventory.md) — repositories, routes, ownership, contracts, workers, PRs.
- [02-state-machines.md](./02-state-machines.md) — real state vocabularies, transitions and invalid paths.
- [03-scenario-catalog.md](./03-scenario-catalog.md) — hierarchy for all 344 scenario IDs.
- [04-process-matrix.md](./04-process-matrix.md) — readable decision/result spine.
- [process-matrix.csv](./process-matrix.csv) — complete 101-column machine-readable matrix.
- [05-method-and-data-map.md](./05-method-and-data-map.md) — UI/SDK/route/repository/table/event/readback chains.
- [06-concurrency-idempotency-recovery.md](./06-concurrency-idempotency-recovery.md) — locks, races, retries and ambiguous outcomes.
- [07-test-evidence-matrix.md](./07-test-evidence-matrix.md) — evidence and missing proof for every scenario.
- [08-findings-and-backlog.md](./08-findings-and-backlog.md) — prioritized gaps and separate-PR boundaries.
- [09-sequence-diagrams.md](./09-sequence-diagrams.md) — required end-to-end sequences.

## Explicit non-actions

No merge, deploy, workflow dispatch/rerun, provider write, payment/refund, live booking, migration apply, runtime restart, live/shared data mutation, PR Ready transition or production probe occurred.
