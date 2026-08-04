# C-15: Rebuildable active-member count projection

- Status: accepted for local implementation
- Date: 2026-08-04
- Production status: `NO-GO` until backfill and shadow comparison pass

## Context

Directory and detail reads calculated `memberCount` with a correlated `count(*)` over canonical
memberships for every returned community. The membership index bounds each scan but does not make a
20-card page constant-cost. Missing projection data must not be interpreted as zero, and duplicate
or reordered broker delivery must not drift the total.

Content/reaction events v1 do not carry a complete previous/resulting contribution contract.
Therefore post, comment and reaction counters are deliberately outside this decision.

## Decision

1. Canonical `communities.memberships` remains the source of truth and the only authority for
   access. The counter is a disposable PostgreSQL read projection.
2. `communities.member_count_projections` stores the aggregate and explicit
   `BUILDING | READY | STALE` state. Only a `READY` row may serve `memberCount`.
3. `communities.member_count_contributions` stores the last canonical membership revision and
   whether that user contributes one. This makes duplicate and reordered events no-ops.
4. A durable quorum consumer handles only membership-changing v1 events. It claims the event in
   `audit.inbox_events`, locks one community, reads canonical membership, applies a newer
   contribution and aggregate delta, and marks the inbox event processed in one tenant
   transaction. Transport remains at-least-once; the effect is exactly once.
5. Reconciliation scans memberships by `(community_id, user_id)` in bounded batches with a durable
   UUID cursor. Completion removes orphan contributions, compares projection and canonical count,
   and marks `READY` only on zero drift. `STALE` restarts a clean pass.
6. During expand/backfill rollout, reads fall back to canonical count for a missing/non-ready row.
   The correlated fallback is removed only after staging proves 100% READY and zero shadow drift.
7. Redis is not involved. Counter state, reconciliation cursor and readiness survive worker loss in
   PostgreSQL.

## Operational proof

Before switching the read path permanently, require:

- all active communities `READY`, zero `STALE`, and bounded not-ready age;
- reverse-order and duplicate delivery tests;
- a 50k-250k-member hot community benchmark with concurrent join/leave projection;
- broker/worker restart soak with zero drift;
- shadow comparison against canonical counts on the immutable staging candidate.

If one aggregate row shows unacceptable lock wait at the accepted 75-150 write RPS burst, shard
the internal contribution aggregate by a stable user hash. The API contract does not change.
