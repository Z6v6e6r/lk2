# Communities load-readiness evidence — 2026-08-04

## Outcome

**Local database/readiness gate: PASS. Staging release certification: NO-GO pending exact HTTP,
soak/fault and realtime gates.**

The deterministic load gate reproduced the accepted 100k DAU data shape on isolated local
PostgreSQL and found two real architectural issues before producing a passing result:

1. `/communities/mine` ordered by `greatest(community.updated_at, membership.updated_at)`, which
   prevented index-backed keyset pagination and breached p95 under concurrent load.
2. Two API nodes lazily opening 40 PostgreSQL connections caused a cold-pool readiness stampede.

Corrections:

- mine ordering is now membership-owned (`pinned`, membership `updated_at`, community UUID), with
  migration 0061 adding the matching partial keyset index;
- API startup supports bounded pool sizing and opens/verifies the configured warm connections before
  readiness;
- synthetic bulk data is vacuumed/analyzed before steady-state measurement; churn and cold-start are
  retained as separate staging fault profiles.

## Verified local evidence

Fixture: 10,000 communities, 50,000 active members in a hot community, 500 memberships for one
viewer, two API-equivalent pools of 20, concurrency 40, 1,000 mixed reads and 150 write actors.

| Journey      | Throughput |      p95 |      p99 | Gate |
| ------------ | ---------: | -------: | -------: | ---- |
| Mine         |  1,881 RPS | 53.04 ms | 65.24 ms | PASS |
| Directory    |  1,583 RPS | 42.83 ms | 44.67 ms | PASS |
| Search       |  1,383 RPS | 61.81 ms | 78.56 ms | PASS |
| Hot detail   |  1,828 RPS | 42.36 ms | 60.35 ms | PASS |
| Mixed reads  |  1,635 RPS | 53.14 ms | 71.77 ms | PASS |
| Join command |    904 RPS | 73.74 ms | 78.28 ms | PASS |

Post-conditions: 40 unique communities across two keyset pages; exactly 150 command records, 150
ACTIVE memberships, 150 audit records and 150 outbox events.

Outbox lease load: 10,000/10,000 published, 28,798 events/s, one attempt each, zero active claims,
10,000 unique broker message IDs.

## Remaining release blockers

- No staging URL or synthetic auth fixture was available, so the exact ingress/auth/API path was not
  executed.
- No 30-60 minute isolated RabbitMQ soak or kill/restart recovery was executed.
- Current realtime runtime has authentication only; community subscription authorization, sequence
  recovery, slow-client shedding and fan-out are not implemented, so 20,000 connections are not
  certifiable.
- Production-like resource saturation and actual OTel/Prometheus series still require staging
  evidence.

No production database, public traffic, feature flag, deployment, push or commit was changed.
