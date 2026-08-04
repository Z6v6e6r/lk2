# Communities load readiness and rollout gates

## Boundary

This runbook certifies one immutable staging candidate for the accepted 20k-100k DAU envelope. A
local repository or database benchmark is useful evidence, but it is not production certification.
Never run synthetic writes against a shared or production database. Database load tools refuse any
database whose name does not end in `_verify`; the HTTP tool is read-only and accepts credentials
only from an absolute file outside the repository.

No public traffic switch is permitted until every mandatory gate below is green for the same image
digest and configuration. Keep `COMMUNITY_INVITES_ENABLED=false` until the DIRECT-invite gates in
`community-direct-invites.md` are also complete.

## Accepted initial envelope

- 100,000 DAU, 300,000 sessions/day.
- Peak-hour reads: about 250 RPS average; design burst 750-1,000 RPS.
- Peak-hour writes: about 25 RPS average; design burst 75-150 RPS.
- 5,000-20,000 concurrent realtime connections.
- Initial topology: two stateless API nodes, each with a PostgreSQL pool of 20; separate worker and
  realtime processes; shared PostgreSQL, Redis, RabbitMQ and object storage.

Initial SLO gates:

| Journey                    |    p95 |    p99 |
| -------------------------- | -----: | -----: |
| Mine/directory/search      | 150 ms | 350 ms |
| Detail                     | 200 ms | 450 ms |
| Command commit             | 400 ms | 800 ms |
| Realtime hint after commit |    1 s |    3 s |

The mixed HTTP profile must sustain at least 750 RPS with no more than one error per thousand
requests. Unauthorized cross-tenant/capability success and duplicate command effect under retry
must remain zero.

## Gate 0: immutable and isolated staging target

Record before testing:

- image digest, Git revision and release manifest;
- staging API, worker and realtime replica counts;
- PostgreSQL instance/class, connection limit and current non-test connection usage;
- Redis/RabbitMQ topology and provider quotas;
- synthetic tenant ID and cleanup owner;
- backup/restore evidence and rollback image digest.

Use a dedicated synthetic tenant, database and broker vhost. Confirm that test emails, push, SMS,
Viva traffic and public webhooks are disabled or routed to approved sandboxes.

## Gate 1: schema and database readiness

1. Apply migrations with the migrator, never the API process. Require migration 0066 or later.
2. Confirm `community_memberships_mine_keyset_idx` is valid.
3. Run `VACUUM (ANALYZE)` after bulk synthetic seeding. Before the actual run, record autovacuum
   age, dead tuples, cache hit rate, connection use and lock waits.
4. Configure both API nodes with:

   ```text
   DATABASE_POOL_MAX=20
   DATABASE_POOL_WARM_CONNECTIONS=20
   ```

   Startup must open and verify every warm connection before the node becomes ready. Roll nodes
   sequentially so simultaneous pool warmup cannot stampede PostgreSQL.

Run the direct database gate only against an isolated database:

```bash
DATABASE_URL=postgresql://.../communities_target_verify npm run communities:load
```

Default target fixture:

- 10,000 communities;
- one 50,000-member hot community;
- 10,000 published posts, 10,000 comments on one hot post and 10,000 durable recovery events;
- one viewer with 500 memberships;
- two API pools, 20 connections each, concurrency 40;
- 300 calls per individual read journey;
- 1,000 mixed reads: 40% directory, 25% mine, 20% detail, 15% search;
- 150 unique join commands with command, audit and outbox post-conditions;
- exact member-count projection, concurrent comment/reaction commands and durable sequence checks.

The gate fails on p95/p99, mixed throughput, keyset duplication or missing command evidence. For a
larger staging dataset, override only the documented `COMMUNITIES_LOAD_*` values and retain the
same latency thresholds.

## Gate 2: exact HTTP path

Prepare a secret-mounted JSON file outside the checkout:

```json
{
  "tokens": ["staging-user-jwt-1", "staging-user-jwt-2"],
  "communityIds": ["00000000-0000-4000-8000-000000000001"],
  "contentTargets": [
    {
      "communityId": "00000000-0000-4000-8000-000000000001",
      "postId": "00000000-0000-4000-8000-000000000002"
    }
  ],
  "searchQuery": "padel"
}
```

Tokens must be synthetic user tokens for the load tenant. Do not paste them into commands, logs,
tickets or Git. Run through the real staging ingress/load balancer:

```bash
COMMUNITIES_HTTP_BASE_URL=https://staging.example \
COMMUNITIES_HTTP_TENANT_KEY=synthetic-tenant \
COMMUNITIES_HTTP_AUTH_FILE=/secure/runtime/communities-load-auth.json \
npm run communities:http:load
```

The tool performs read-only directory/mine/detail/search/feed/comments/recovery traffic, validates status and payload size,
redacts credentials from output and enforces 750 RPS plus journey latency budgets. Save its JSON
output with the candidate digest. HTTP success is not proof of command/outbox/realtime capacity;
those are separate gates.

Before enabling Community media, provision the bucket outside the application runtime and keep
`S3_AUTO_CREATE_BUCKET=false`. The read-only preflight fails unless versioning is enabled, anonymous
ACL/policy read is absent, CORS contains only the explicitly approved origins/methods/headers, and
no lifecycle rule can delete current or exact historical objects under `community-media/ready/`:

```bash
COMMUNITIES_MEDIA_ALLOWED_ORIGINS=https://lk-staging.example,https://cup-staging.example \
npm run communities:media:storage:preflight
```

Then run the mutating media journey only with a synthetic ACTIVE MEMBER in a `MODERATED_FEED`
community and a synthetic CUP principal. The harness requires an absolute secret fixture outside
the checkout plus the exact acknowledgement `I_ACKNOWLEDGE_SYNTHETIC_COMMUNITY_WRITES`; it covers
public signed PUT, worker `READY`, moderation preview/approval, feed visibility, archive denial,
five-year retention and restore/re-approval. Archive cleanup is part of the assertion. Never point
the harness at production.

## Gate 3: command, outbox and recovery

Run against the same isolated candidate database:

```bash
DATABASE_URL=postgresql://.../communities_target_verify npm run outbox:lease:load
```

For staging certification, also run `npm run outbox:lease:soak` for 30-60 minutes against an
isolated RabbitMQ vhost ending in `_verify`. Require:

- no acknowledged lost commands;
- no duplicate broker message IDs;
- no active expired claims after recovery;
- outbox oldest age at most 30 seconds normally and never above five minutes;
- DLQ remains empty;
- PostgreSQL lock wait, pool wait and CPU remain inside the approved resource envelope.

Inject one worker termination after a claim, one broker interruption and one API-node restart. The
candidate must recover without manual database changes.

## Gate 4: realtime

The local candidate implements one-time tickets, authorized subscriptions, bounded socket buffers,
heartbeat, identifier-only fan-out and HTTP sequence recovery. It has not yet passed the exact
staging topology/failure proof, so public realtime rollout remains **NO-GO**.

Prepare an external secret-mounted fixture as specified in
`community-realtime-readiness.md`. It must contain an exact expected event target, one unused ticket
per connection, at least 1,000 reconnect tickets, a foreign-tenant denied-subscription probe and a
slow-client probe. Then run:

```bash
COMMUNITIES_REALTIME_URL=wss://staging.example/realtime/v1/synthetic-tenant \
COMMUNITIES_REALTIME_AUTH_FILE=/secure/runtime/communities-realtime-load.json \
COMMUNITIES_REALTIME_CONNECTIONS=20000 \
npm run communities:realtime:load
```

While all sockets are subscribed, commit the exact approved synthetic event declared in the fixture
to the hot community. External certification defaults to a 30-minute hold and fails unless every
non-slow socket receives that exact event, the denied subscription stays denied, the slow client is
closed with 1013, and at least 1,000 reconnects complete at 1,000 connections/second. It also
enforces the accepted event p95/p99. Also verify:

- tenant and ACTIVE-membership authorization on every subscription;
- heartbeat, per-connection outbound queue budget and slow-client disconnect;
- identifier/version-only events and REST cursor recovery after gaps;
- 20,000 connections, reconnect storm, hot-community fan-out and Redis restart;
- p95/p99 commit-to-hint latency and zero cross-tenant delivery.

## Gate 5: GO / NO-GO

GO requires all of the following for one immutable digest:

- migrations and rollback/restore rehearsal passed;
- database and exact HTTP load gates passed;
- command/outbox load, soak and fault recovery passed;
- realtime gate passed for any realtime feature being enabled;
- no SLO breach, cross-tenant success, duplicate effect or missing audit/outbox evidence;
- dashboards and alerts observed real series during the run;
- Product, Engineering and SRE approvals recorded.

If a gate fails, keep the corresponding feature flag off, retain the evidence, correct the cause and
repeat the complete affected gate on a clean target. Never raise a latency threshold merely to make
a candidate pass.

## Product load-gate waiver, 2026-08-04

Product explicitly chose to skip the remaining exact-digest staging load, soak and failure-injection
runs and continue with the next implementation stage. Record Gates 1-4 as `WAIVED_BY_PRODUCT`, not
`PASSED`: the decision supplies no measured production-capacity evidence and must never be presented
as a successful 20,000-socket, 750-RPS or dependency-failure certification.

The waiver authorizes continued client implementation and ordinary functional verification only.
It does not itself authorize deployment, public traffic switching or removal of feature flags. At
release approval the accountable owner must either complete the omitted gates or explicitly accept
the remaining capacity and recovery risk for that release.

## Historical local reference result, 2026-08-04

The earlier partial gate after migration 0061 and pool warmup measured only
directory/mine/detail/join/outbox paths:

- mixed read: 1,635 RPS, p95 53.14 ms, p99 71.77 ms;
- mine: p95 53.04 ms, p99 65.24 ms;
- directory: p95 42.83 ms, p99 44.67 ms;
- search: p95 61.81 ms, p99 78.56 ms;
- 50,000-member detail: p95 42.36 ms, p99 60.35 ms;
- join command commit: 904 RPS, p95 73.74 ms, p99 78.28 ms;
- 150 commands produced exactly 150 memberships, audits and outbox events;
- outbox lease load: 10,000 events in 347 ms, 28,798 events/s, zero duplicate IDs and zero active
  claims.

This historical result does not cover migration 0066, feed/comments/recovery, counter projection or
realtime. Rerun the expanded gate; it does not replace exact-digest staging HTTP, soak, failure
recovery or realtime evidence.
