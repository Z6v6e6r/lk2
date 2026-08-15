import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

import {
  createCommunityContentRepository,
  createCommunityEventRecoveryRepository,
  createCommunityMemberCountProjectionRepository,
  createCommunityMembershipLifecycleRepository,
  createCommunityReadRepository,
  createDatabasePool,
  createLocalCommunityDirectoryRepository,
  withTenantTransaction,
} from '@phub/database';

import {
  collectLoadBudgetBreaches,
  type LoadMeasurementSummary,
} from './communities-load-budget.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required');
const databaseName = new URL(connectionString).pathname.replace(/^\//, '');
if (!databaseName.endsWith('_verify')) {
  throw new Error('Communities load verification requires an isolated *_verify database');
}

function boundedInteger(name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = process.env[name];
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

const communityCount = boundedInteger('COMMUNITIES_LOAD_COMMUNITY_COUNT', 10_000, 2_000, 100_000);
const hotMemberCount = boundedInteger('COMMUNITIES_LOAD_HOT_MEMBER_COUNT', 50_000, 1_000, 250_000);
const viewerMembershipCount = boundedInteger(
  'COMMUNITIES_LOAD_VIEWER_MEMBERSHIP_COUNT',
  500,
  100,
  5_000,
);
const readIterations = boundedInteger('COMMUNITIES_LOAD_READ_ITERATIONS', 300, 20, 10_000);
const mixedReadIterations = boundedInteger(
  'COMMUNITIES_LOAD_MIXED_READ_ITERATIONS',
  1_000,
  100,
  50_000,
);
const writeIterations = boundedInteger('COMMUNITIES_LOAD_WRITE_ITERATIONS', 150, 20, 2_000);
const contentPostCount = boundedInteger(
  'COMMUNITIES_LOAD_CONTENT_POST_COUNT',
  10_000,
  1_000,
  100_000,
);
const hotPostCommentCount = boundedInteger(
  'COMMUNITIES_LOAD_HOT_POST_COMMENT_COUNT',
  10_000,
  1_000,
  100_000,
);
const concurrency = boundedInteger('COMMUNITIES_LOAD_CONCURRENCY', 40, 1, 100);
const apiNodes = boundedInteger('COMMUNITIES_LOAD_API_NODES', 2, 1, 4);
const databaseConnectionsPerNode = 20;
const minimumReadRps = boundedInteger('COMMUNITIES_LOAD_MIN_READ_RPS', 200, 1, 10_000);
const minimumMixedReadRps = boundedInteger('COMMUNITIES_LOAD_MIN_MIXED_READ_RPS', 750, 1, 10_000);
const mineP95TargetMs = boundedInteger('COMMUNITIES_LOAD_MINE_P95_TARGET_MS', 150, 10, 5_000);
const directoryP95TargetMs = boundedInteger(
  'COMMUNITIES_LOAD_DIRECTORY_P95_TARGET_MS',
  150,
  10,
  5_000,
);
const detailP95TargetMs = boundedInteger('COMMUNITIES_LOAD_DETAIL_P95_TARGET_MS', 200, 10, 5_000);
const commandP95TargetMs = boundedInteger(
  'COMMUNITIES_LOAD_COMMAND_P95_TARGET_MS',
  400,
  10,
  10_000,
);
const mineP99TargetMs = boundedInteger('COMMUNITIES_LOAD_MINE_P99_TARGET_MS', 350, 10, 10_000);
const directoryP99TargetMs = boundedInteger(
  'COMMUNITIES_LOAD_DIRECTORY_P99_TARGET_MS',
  350,
  10,
  10_000,
);
const detailP99TargetMs = boundedInteger('COMMUNITIES_LOAD_DETAIL_P99_TARGET_MS', 450, 10, 10_000);
const commandP99TargetMs = boundedInteger(
  'COMMUNITIES_LOAD_COMMAND_P99_TARGET_MS',
  800,
  10,
  10_000,
);
const projectorP95TargetMs = boundedInteger(
  'COMMUNITIES_LOAD_PROJECTOR_P95_TARGET_MS',
  400,
  10,
  10_000,
);
const projectorP99TargetMs = boundedInteger(
  'COMMUNITIES_LOAD_PROJECTOR_P99_TARGET_MS',
  800,
  10,
  10_000,
);
const contentReadP95TargetMs = boundedInteger(
  'COMMUNITIES_LOAD_CONTENT_READ_P95_TARGET_MS',
  200,
  10,
  5_000,
);
const contentReadP99TargetMs = boundedInteger(
  'COMMUNITIES_LOAD_CONTENT_READ_P99_TARGET_MS',
  450,
  10,
  10_000,
);
const contentCommandP95TargetMs = boundedInteger(
  'COMMUNITIES_LOAD_CONTENT_COMMAND_P95_TARGET_MS',
  400,
  10,
  10_000,
);
const contentCommandP99TargetMs = boundedInteger(
  'COMMUNITIES_LOAD_CONTENT_COMMAND_P99_TARGET_MS',
  800,
  10,
  10_000,
);

if (viewerMembershipCount >= communityCount) {
  throw new Error('COMMUNITIES_LOAD_VIEWER_MEMBERSHIP_COUNT must be less than community count');
}

function percentile(values: readonly number[], quantile: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1);
  return sorted[index] ?? 0;
}

function rounded(value: number): number {
  return Math.round(value * 100) / 100;
}

async function measureConcurrent(
  operations: number,
  operation: (index: number) => Promise<void>,
): Promise<LoadMeasurementSummary> {
  const measurements: number[] = [];
  let next = 0;
  const startedAll = performance.now();
  await Promise.all(
    Array.from({ length: Math.min(concurrency, operations) }, async () => {
      while (true) {
        const index = next;
        next += 1;
        if (index >= operations) return;
        const started = performance.now();
        await operation(index);
        measurements.push(performance.now() - started);
      }
    }),
  );
  const durationMs = performance.now() - startedAll;
  return {
    operations,
    durationMs: rounded(durationMs),
    throughputRps: rounded((operations * 1_000) / durationMs),
    p50Ms: rounded(percentile(measurements, 0.5)),
    p95Ms: rounded(percentile(measurements, 0.95)),
    p99Ms: rounded(percentile(measurements, 0.99)),
    maxMs: rounded(Math.max(...measurements)),
  };
}

function commandHash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

async function warmDatabasePools(): Promise<void> {
  await Promise.all(
    pools.map(async (currentPool) => {
      const clients = await Promise.all(
        Array.from({ length: databaseConnectionsPerNode }, () => currentPool.connect()),
      );
      try {
        await Promise.all(clients.map((client) => client.query('select 1')));
      } finally {
        clients.forEach((client) => client.release());
      }
    }),
  );
}

const pools = Array.from({ length: apiNodes }, () => createDatabasePool(connectionString));
const pool = pools[0];
if (!pool) throw new Error('Communities load verification requires at least one API pool');
const readRepositories = pools.map((currentPool) => createCommunityReadRepository(currentPool));
const mineRepositories = pools.map((currentPool) =>
  createLocalCommunityDirectoryRepository(currentPool),
);
const membershipRepositories = pools.map(createCommunityMembershipLifecycleRepository);
const memberCountRepositories = pools.map(createCommunityMemberCountProjectionRepository);
const contentRepositories = pools.map(createCommunityContentRepository);
const eventRecoveryRepositories = pools.map(createCommunityEventRecoveryRepository);
const readRepository = readRepositories[0];
const mineRepository = mineRepositories[0];
if (!readRepository || !mineRepository)
  throw new Error('Communities load repositories are missing');
const tenantId = randomUUID();
const ownerUserId = randomUUID();
const viewerUserId = randomUUID();
const communityIds = Array.from({ length: communityCount }, () => randomUUID());
const hotCommunityId = communityIds.at(-1);
const joinCommunityId = communityIds.at(-2);
if (!hotCommunityId || !joinCommunityId) throw new Error('Community load fixture is incomplete');
const hotMemberUserIds = Array.from({ length: hotMemberCount - 2 }, () => randomUUID());
const joinActorUserIds = Array.from({ length: writeIterations }, () => randomUUID());
const contentPostIds = Array.from({ length: contentPostCount }, () => randomUUID());
const hotPostId = contentPostIds[0];
const hotPostCommentIds = Array.from({ length: hotPostCommentCount }, () => randomUUID());
const joinCommunityPostId = randomUUID();
const allUserIds = [ownerUserId, viewerUserId, ...hotMemberUserIds, ...joinActorUserIds];
const viewerCommunityIds = communityIds.slice(-viewerMembershipCount);
if (!hotPostId) throw new Error('Community content load fixture is incomplete');

try {
  await pool.query(
    `insert into identity.tenants (id, tenant_key, display_name)
     values ($1, $2, 'Communities load verification')`,
    [tenantId, `communities-load-${tenantId.slice(0, 8)}`],
  );

  await withTenantTransaction(pool, tenantId, async (client) => {
    await client.query(
      `insert into identity.users (tenant_id, id, status)
       select $1, source.user_id, 'ACTIVE'
         from unnest($2::uuid[]) source(user_id)`,
      [tenantId, allUserIds],
    );
    await client.query(
      `insert into communities.communities (
         tenant_id, id, title, description, visibility, join_policy,
         status, created_by, created_at, updated_at, revision, publishing_preset
       )
       select $1,
              source.community_id,
              case
                when source.ordinality % 100 = 0
                  then 'Featured Alpha community ' || source.ordinality
                else 'Load community ' || source.ordinality
              end,
              'Synthetic load community ' || source.ordinality,
              'PUBLIC', 'INSTANT', 'ACTIVE', $3,
              clock_timestamp() - ($4 - source.ordinality) * interval '1 millisecond',
              clock_timestamp() - ($4 - source.ordinality) * interval '1 millisecond',
              1, 'OPEN_COMMUNITY'
         from unnest($2::uuid[]) with ordinality source(community_id, ordinality)`,
      [tenantId, communityIds, ownerUserId, communityCount],
    );
    await client.query(
      `insert into communities.memberships (
         tenant_id, community_id, user_id, role, status, joined_at, revision
       )
       select $1, source.community_id, $3, 'OWNER', 'ACTIVE', now(), 1
         from unnest($2::uuid[]) source(community_id)`,
      [tenantId, communityIds, ownerUserId],
    );
    await client.query(
      `insert into communities.memberships (
         tenant_id, community_id, user_id, role, status, joined_at, pinned_at, revision
       )
       select $1, source.community_id, $3, 'MEMBER', 'ACTIVE', now(),
              case when source.ordinality <= 10 then now() else null end,
              1
         from unnest($2::uuid[]) with ordinality source(community_id, ordinality)`,
      [tenantId, viewerCommunityIds, viewerUserId],
    );
    await client.query(
      `insert into communities.memberships (
         tenant_id, community_id, user_id, role, status, joined_at, revision
       )
       select $1, $2, source.user_id, 'MEMBER', 'ACTIVE', now(), 1
         from unnest($3::uuid[]) source(user_id)`,
      [tenantId, hotCommunityId, hotMemberUserIds],
    );
    await client.query(
      `insert into community_content.posts (
         tenant_id, community_id, id, author_user_id, status, body,
         revision, created_at, published_at, updated_at
       )
       select $1, $2, source.post_id, $3, 'PUBLISHED',
              'Synthetic content post ' || source.ordinality,
              1,
              clock_timestamp() - ($5 - source.ordinality) * interval '1 millisecond',
              clock_timestamp() - ($5 - source.ordinality) * interval '1 millisecond',
              clock_timestamp() - ($5 - source.ordinality) * interval '1 millisecond'
         from unnest($4::uuid[]) with ordinality source(post_id, ordinality)`,
      [tenantId, hotCommunityId, ownerUserId, contentPostIds, contentPostCount],
    );
    await client.query(
      `insert into community_content.comments (
         tenant_id, community_id, post_id, id, author_user_id,
         status, body, revision, created_at, published_at, updated_at
       )
       select $1, $2, $3, source.comment_id, $4, 'PUBLISHED',
              'Synthetic hot-post comment ' || source.ordinality,
              1,
              clock_timestamp() - ($6 - source.ordinality) * interval '1 millisecond',
              clock_timestamp() - ($6 - source.ordinality) * interval '1 millisecond',
              clock_timestamp() - ($6 - source.ordinality) * interval '1 millisecond'
         from unnest($5::uuid[]) with ordinality source(comment_id, ordinality)`,
      [tenantId, hotCommunityId, hotPostId, ownerUserId, hotPostCommentIds, hotPostCommentCount],
    );
    await client.query(
      `insert into community_content.posts (
         tenant_id, community_id, id, author_user_id, status, body,
         revision, created_at, published_at, updated_at
       ) values ($1, $2, $3, $4, 'PUBLISHED', 'Synthetic write hot post',
                 1, now(), now(), now())`,
      [tenantId, joinCommunityId, joinCommunityPostId, ownerUserId],
    );
    await client.query(
      `insert into community_content.events (
         tenant_id, community_id, sequence, event_type, target_type,
         target_id, target_revision, target_status, occurred_at
       )
       select $1, $2, source.ordinality, 'community.post.created.v1', 'POST',
              source.post_id, 1, 'PUBLISHED',
              clock_timestamp() - ($4 - source.ordinality) * interval '1 millisecond'
         from unnest($3::uuid[]) with ordinality source(post_id, ordinality)`,
      [tenantId, hotCommunityId, contentPostIds, contentPostCount],
    );
    await client.query(
      `insert into community_content.event_heads (
         tenant_id, community_id, last_sequence, retained_from_sequence, retention_due_at
       )
       select $1, $2, $3, 1, min(occurred_at) + interval '30 days'
         from community_content.events
        where tenant_id = $1 and community_id = $2`,
      [tenantId, hotCommunityId, contentPostCount],
    );
    await client.query(
      `insert into communities.member_count_contributions (
         tenant_id, community_id, user_id, membership_revision, is_active
       )
       select tenant_id, community_id, user_id, revision, status = 'ACTIVE'
         from communities.memberships
        where tenant_id = $1`,
      [tenantId],
    );
    await client.query(
      `insert into communities.member_count_projections (
         tenant_id, community_id, active_member_count, projection_revision,
         state, reconciled_at
       )
       select $1, community.id,
              count(membership.user_id) filter (where membership.status = 'ACTIVE'),
              1, 'READY', now()
         from communities.communities community
         left join communities.memberships membership
           on membership.tenant_id = community.tenant_id
          and membership.community_id = community.id
        where community.tenant_id = $1
        group by community.id`,
      [tenantId],
    );
  });

  await pool.query('vacuum (analyze) communities.communities');
  await pool.query('vacuum (analyze) communities.memberships');
  await pool.query('vacuum (analyze) communities.member_count_projections');
  await pool.query('vacuum (analyze) communities.member_count_contributions');
  await pool.query('vacuum (analyze) community_content.posts');
  await pool.query('vacuum (analyze) community_content.comments');
  await pool.query('vacuum (analyze) community_content.events');

  await warmDatabasePools();
  await Promise.all(
    readRepositories.map(async (repository, nodeIndex) => {
      const currentMineRepository = mineRepositories[nodeIndex];
      if (!currentMineRepository) throw new Error('Warmup mine repository is missing');
      for (let warmup = 0; warmup < 10; warmup += 1) {
        await repository.listDiscoverable({ tenantId, viewerUserId, limit: 20 });
        await repository.listDiscoverable({
          tenantId,
          viewerUserId,
          query: 'featured alpha',
          limit: 20,
        });
        await repository.getDetail({ tenantId, viewerUserId, communityId: hotCommunityId });
        await currentMineRepository.listMemberships({
          tenantId,
          userId: viewerUserId,
          correlationId: `communities-load-warmup-${nodeIndex}-${warmup}`,
          limit: 20,
        });
      }
    }),
  );

  const firstPage = await readRepository.listDiscoverable({
    tenantId,
    viewerUserId,
    limit: 20,
  });
  const firstPageLast = firstPage.items.at(-1);
  if (!firstPageLast || !firstPage.hasMore) {
    throw new Error('Community discovery first load page is incomplete');
  }
  const secondPage = await readRepository.listDiscoverable({
    tenantId,
    viewerUserId,
    limit: 20,
    after: { createdAt: firstPageLast.sortCreatedAt, id: firstPageLast.id },
  });
  const keysetIds = new Set([...firstPage.items, ...secondPage.items].map((item) => item.id));
  if (firstPage.items.length !== 20 || secondPage.items.length !== 20 || keysetIds.size !== 40) {
    throw new Error(
      'Community discovery keyset pagination returned duplicates or an incomplete page',
    );
  }

  const mine = await measureConcurrent(readIterations, async (index) => {
    const repository = mineRepositories[index % apiNodes];
    if (!repository) throw new Error('Mine repository pool is missing');
    const page = await repository.listMemberships({
      tenantId,
      userId: viewerUserId,
      correlationId: `communities-load-mine-${index}`,
      limit: 20,
    });
    if (page.items.length !== 20) throw new Error('Mine page is incomplete');
  });
  const directory = await measureConcurrent(readIterations, async (index) => {
    const repository = readRepositories[index % apiNodes];
    if (!repository) throw new Error('Directory repository pool is missing');
    const page = await repository.listDiscoverable({ tenantId, viewerUserId, limit: 20 });
    if (page.items.length !== 20) throw new Error('Directory page is incomplete');
  });
  const search = await measureConcurrent(readIterations, async (index) => {
    const repository = readRepositories[index % apiNodes];
    if (!repository) throw new Error('Search repository pool is missing');
    const page = await repository.listDiscoverable({
      tenantId,
      viewerUserId,
      query: 'featured alpha',
      limit: 20,
    });
    if (page.items.length !== 20) throw new Error('Search page is incomplete');
  });
  const detail = await measureConcurrent(readIterations, async (index) => {
    const repository = readRepositories[index % apiNodes];
    if (!repository) throw new Error('Detail repository pool is missing');
    const record = await repository.getDetail({
      tenantId,
      viewerUserId,
      communityId: hotCommunityId,
    });
    if (!record || record.memberCount !== hotMemberCount) {
      throw new Error(
        `Hot community member count mismatch: ${JSON.stringify({
          expected: hotMemberCount,
          actual: record?.memberCount ?? null,
        })}`,
      );
    }
  });
  const feed = await measureConcurrent(readIterations, async (index) => {
    const repository = contentRepositories[index % apiNodes];
    if (!repository) throw new Error('Content repository pool is missing');
    const result = await repository.listFeed({
      tenantId,
      viewerUserId,
      communityId: hotCommunityId,
      limit: 20,
      correlationId: `communities-load-feed-${index}`,
    });
    if (result.outcome !== 'found' || result.items.length !== 20 || !result.hasMore) {
      throw new Error('Community feed result is incomplete');
    }
  });
  const comments = await measureConcurrent(readIterations, async (index) => {
    const repository = contentRepositories[index % apiNodes];
    if (!repository) throw new Error('Content repository pool is missing');
    const result = await repository.listComments({
      tenantId,
      viewerUserId,
      communityId: hotCommunityId,
      postId: hotPostId,
      limit: 20,
      correlationId: `communities-load-comments-${index}`,
    });
    if (result.outcome !== 'found' || result.items.length !== 20 || !result.hasMore) {
      throw new Error('Community comments result is incomplete');
    }
  });
  const recovery = await measureConcurrent(readIterations, async (index) => {
    const repository = eventRecoveryRepositories[index % apiNodes];
    if (!repository) throw new Error('Event recovery repository pool is missing');
    const result = await repository.listEvents({
      tenantId,
      viewerUserId,
      communityId: hotCommunityId,
      afterSequence: Math.max(0, contentPostCount - 100),
      limit: 50,
      correlationId: `communities-load-recovery-${index}`,
    });
    if (
      result.outcome !== 'found' ||
      result.page.items.length !== 50 ||
      result.page.latestSequence !== contentPostCount
    ) {
      throw new Error('Community event recovery result is incomplete');
    }
  });
  const mixedRead = await measureConcurrent(mixedReadIterations, async (index) => {
    const read = readRepositories[index % apiNodes];
    const mineRead = mineRepositories[index % apiNodes];
    if (!read || !mineRead) throw new Error('Mixed repository pool is missing');
    const bucket = index % 100;
    if (bucket < 40) {
      const page = await read.listDiscoverable({ tenantId, viewerUserId, limit: 20 });
      if (page.items.length !== 20) throw new Error('Mixed directory page is incomplete');
      return;
    }
    if (bucket < 65) {
      const page = await mineRead.listMemberships({
        tenantId,
        userId: viewerUserId,
        correlationId: `communities-load-mixed-mine-${index}`,
        limit: 20,
      });
      if (page.items.length !== 20) throw new Error('Mixed mine page is incomplete');
      return;
    }
    if (bucket < 85) {
      const record = await read.getDetail({
        tenantId,
        viewerUserId,
        communityId: hotCommunityId,
      });
      if (!record || record.memberCount !== hotMemberCount) {
        throw new Error('Mixed hot detail result is invalid');
      }
      return;
    }
    const page = await read.listDiscoverable({
      tenantId,
      viewerUserId,
      query: 'featured alpha',
      limit: 20,
    });
    if (page.items.length !== 20) throw new Error('Mixed search page is incomplete');
  });
  const command = await measureConcurrent(writeIterations, async (index) => {
    const repository = membershipRepositories[index % apiNodes];
    if (!repository) throw new Error('Membership repository pool is missing');
    const actorUserId = joinActorUserIds[index];
    if (!actorUserId) throw new Error('Join actor fixture is missing');
    const idempotencyKey = `communities-load-join-${String(index).padStart(8, '0')}`;
    const result = await repository.selfJoin({
      tenantId,
      actorUserId,
      communityId: joinCommunityId,
      expectedMembershipRevision: 0,
      idempotencyKey,
      requestHash: commandHash(idempotencyKey),
      correlationId: `communities-load-command-${index}`,
    });
    if (result.outcome !== 'joined' || result.replayed) {
      throw new Error(`Community join command failed: ${JSON.stringify(result)}`);
    }
  });

  const commandEvidence = await withTenantTransaction(pool, tenantId, async (client) => {
    const result = await client.query<{
      commands: number;
      audits: number;
      outbox: number;
      joined_members: number;
    }>(
      `select
         (select count(*)::integer
            from communities.membership_lifecycle_commands
           where tenant_id = $1 and community_id = $2 and command_type = 'JOIN') as commands,
         (select count(*)::integer
            from audit.audit_log
           where tenant_id = $1 and action = 'COMMUNITY_MEMBER_JOINED') as audits,
         (select count(*)::integer
            from audit.outbox_events
           where tenant_id = $1 and event_type = 'community.member.joined.v1') as outbox,
         (select count(*)::integer
            from communities.memberships
           where tenant_id = $1 and community_id = $2
             and user_id = any($3::uuid[])
             and role = 'MEMBER' and status = 'ACTIVE') as joined_members`,
      [tenantId, joinCommunityId, joinActorUserIds],
    );
    return result.rows[0];
  });
  if (
    !commandEvidence ||
    commandEvidence.commands !== writeIterations ||
    commandEvidence.audits !== writeIterations ||
    commandEvidence.outbox !== writeIterations ||
    commandEvidence.joined_members !== writeIterations
  ) {
    throw new Error(`Community command evidence mismatch: ${JSON.stringify(commandEvidence)}`);
  }

  const projectionEvents = await withTenantTransaction(pool, tenantId, async (client) => {
    const result = await client.query<{
      readonly id: string;
      readonly community_id: string;
      readonly user_id: string;
    }>(
      `select id, payload->>'communityId' as community_id, payload->>'userId' as user_id
         from audit.outbox_events
        where tenant_id = $1
          and event_type = 'community.member.joined.v1'
          and aggregate_id = $2
        order by occurred_at, id`,
      [tenantId, joinCommunityId],
    );
    return result.rows;
  });
  if (projectionEvents.length !== writeIterations) {
    throw new Error('Community member-count projection event fixture is incomplete');
  }
  const projector = await measureConcurrent(projectionEvents.length, async (index) => {
    const event = projectionEvents[index];
    const repository = memberCountRepositories[index % apiNodes];
    if (!event || !repository) throw new Error('Member-count projector fixture is missing');
    const result = await repository.projectEvent({
      tenantId,
      eventId: event.id,
      eventType: 'community.member.joined.v1',
      communityId: event.community_id,
      userId: event.user_id,
    });
    if (result !== 'applied') {
      throw new Error(`Member-count projector returned ${result}`);
    }
  });

  const projectionEvidence = await withTenantTransaction(pool, tenantId, async (client) => {
    const result = await client.query<{
      readonly projected_count: number;
      readonly canonical_count: number;
      readonly projected_join_actors: number;
      readonly state: string;
    }>(
      `select projection.active_member_count::integer as projected_count,
              projection.state,
              (select count(*)::integer from communities.memberships
                where tenant_id = $1 and community_id = $2 and status = 'ACTIVE')
                as canonical_count,
              (select count(*)::integer from communities.member_count_contributions
                where tenant_id = $1 and community_id = $2
                  and user_id = any($3::uuid[]) and is_active)
                as projected_join_actors
         from communities.member_count_projections projection
        where projection.tenant_id = $1 and projection.community_id = $2`,
      [tenantId, joinCommunityId, joinActorUserIds],
    );
    return result.rows[0];
  });
  if (
    !projectionEvidence ||
    projectionEvidence.state !== 'READY' ||
    projectionEvidence.projected_count !== projectionEvidence.canonical_count ||
    projectionEvidence.projected_join_actors !== writeIterations
  ) {
    throw new Error(
      `Community member-count projection evidence mismatch: ${JSON.stringify(projectionEvidence)}`,
    );
  }

  const commentCommand = await measureConcurrent(writeIterations, async (index) => {
    const repository = contentRepositories[index % apiNodes];
    const actorUserId = joinActorUserIds[index];
    if (!repository || !actorUserId) throw new Error('Content command fixture is missing');
    const idempotencyKey = `communities-load-comment-${String(index).padStart(8, '0')}`;
    const result = await repository.createComment({
      tenantId,
      actorUserId,
      communityId: joinCommunityId,
      postId: joinCommunityPostId,
      body: `Synthetic concurrent comment ${index}`,
      idempotencyKey,
      requestHash: commandHash(idempotencyKey),
      correlationId: `communities-load-comment-${index}`,
    });
    if (result.outcome !== 'created' || result.replayed) {
      throw new Error(`Community comment command failed: ${JSON.stringify(result)}`);
    }
  });
  const reactionCommand = await measureConcurrent(writeIterations, async (index) => {
    const repository = contentRepositories[index % apiNodes];
    const actorUserId = joinActorUserIds[index];
    if (!repository || !actorUserId) throw new Error('Reaction command fixture is missing');
    const idempotencyKey = `communities-load-reaction-${String(index).padStart(8, '0')}`;
    const result = await repository.setReaction({
      tenantId,
      actorUserId,
      communityId: joinCommunityId,
      targetType: 'POST',
      targetId: joinCommunityPostId,
      reaction: index % 10 === 0 ? 'DISLIKE' : 'LIKE',
      idempotencyKey,
      requestHash: commandHash(idempotencyKey),
      correlationId: `communities-load-reaction-${index}`,
    });
    if (result.outcome !== 'changed' || result.replayed) {
      throw new Error(`Community reaction command failed: ${JSON.stringify(result)}`);
    }
  });
  const contentCommandEvidence = await withTenantTransaction(pool, tenantId, async (client) => {
    const result = await client.query<{
      readonly comments: number;
      readonly reactions: number;
      readonly durable_events: number;
      readonly outbox_events: number;
    }>(
      `select
         (select count(*)::integer from community_content.comments
           where tenant_id = $1 and community_id = $2 and post_id = $3) as comments,
         (select count(*)::integer from community_content.post_reactions
           where tenant_id = $1 and post_id = $3 and status = 'ACTIVE') as reactions,
         (select count(*)::integer from community_content.events
           where tenant_id = $1 and community_id = $2) as durable_events,
         (select count(*)::integer from audit.outbox_events
           where tenant_id = $1 and event_type in (
             'community.comment.created.v1', 'community.reaction.changed.v1'
           ) and payload->>'communityId' = $2::text) as outbox_events`,
      [tenantId, joinCommunityId, joinCommunityPostId],
    );
    return result.rows[0];
  });
  if (
    !contentCommandEvidence ||
    contentCommandEvidence.comments !== writeIterations ||
    contentCommandEvidence.reactions !== writeIterations ||
    contentCommandEvidence.durable_events !== writeIterations * 2 ||
    contentCommandEvidence.outbox_events !== writeIterations * 2
  ) {
    throw new Error(
      `Community content command evidence mismatch: ${JSON.stringify(contentCommandEvidence)}`,
    );
  }

  const budgetBreaches = collectLoadBudgetBreaches([
    {
      name: 'Mine',
      result: mine,
      p95TargetMs: mineP95TargetMs,
      p99TargetMs: mineP99TargetMs,
      minimumRps: minimumReadRps,
    },
    {
      name: 'Directory',
      result: directory,
      p95TargetMs: directoryP95TargetMs,
      p99TargetMs: directoryP99TargetMs,
      minimumRps: minimumReadRps,
    },
    {
      name: 'Search',
      result: search,
      p95TargetMs: directoryP95TargetMs,
      p99TargetMs: directoryP99TargetMs,
      minimumRps: minimumReadRps,
    },
    {
      name: 'Detail',
      result: detail,
      p95TargetMs: detailP95TargetMs,
      p99TargetMs: detailP99TargetMs,
      minimumRps: minimumReadRps,
    },
    {
      name: 'Feed',
      result: feed,
      p95TargetMs: contentReadP95TargetMs,
      p99TargetMs: contentReadP99TargetMs,
      minimumRps: minimumReadRps,
    },
    {
      name: 'Comments',
      result: comments,
      p95TargetMs: contentReadP95TargetMs,
      p99TargetMs: contentReadP99TargetMs,
      minimumRps: minimumReadRps,
    },
    {
      name: 'Event recovery',
      result: recovery,
      p95TargetMs: contentReadP95TargetMs,
      p99TargetMs: contentReadP99TargetMs,
    },
    {
      name: 'Mixed read',
      result: mixedRead,
      p95TargetMs: detailP95TargetMs,
      p99TargetMs: detailP99TargetMs,
      minimumRps: minimumMixedReadRps,
    },
    {
      name: 'Command',
      result: command,
      p95TargetMs: commandP95TargetMs,
      p99TargetMs: commandP99TargetMs,
    },
    {
      name: 'Member-count projector',
      result: projector,
      p95TargetMs: projectorP95TargetMs,
      p99TargetMs: projectorP99TargetMs,
    },
    {
      name: 'Comment command',
      result: commentCommand,
      p95TargetMs: contentCommandP95TargetMs,
      p99TargetMs: contentCommandP99TargetMs,
    },
    {
      name: 'Reaction command',
      result: reactionCommand,
      p95TargetMs: contentCommandP95TargetMs,
      p99TargetMs: contentCommandP99TargetMs,
    },
  ]);

  process.stdout.write(
    `${JSON.stringify({
      status: budgetBreaches.length === 0 ? 'passed' : 'failed',
      databaseName,
      fixture: {
        communityCount,
        hotMemberCount,
        viewerMembershipCount,
        writeActors: writeIterations,
        contentPostCount,
        hotPostCommentCount,
      },
      load: {
        readIterations,
        mixedReadIterations,
        writeIterations,
        concurrency,
        apiNodes,
        databaseConnectionsPerNode,
        minimumReadRps,
        minimumMixedReadRps,
        mixedReadShape: {
          directoryPercent: 40,
          minePercent: 25,
          detailPercent: 20,
          searchPercent: 15,
        },
      },
      targetsMs: {
        mine: { p95: mineP95TargetMs, p99: mineP99TargetMs },
        directory: { p95: directoryP95TargetMs, p99: directoryP99TargetMs },
        detail: { p95: detailP95TargetMs, p99: detailP99TargetMs },
        command: { p95: commandP95TargetMs, p99: commandP99TargetMs },
        projector: { p95: projectorP95TargetMs, p99: projectorP99TargetMs },
        contentRead: { p95: contentReadP95TargetMs, p99: contentReadP99TargetMs },
        contentCommand: { p95: contentCommandP95TargetMs, p99: contentCommandP99TargetMs },
      },
      results: {
        mine,
        directory,
        search,
        detail,
        feed,
        comments,
        recovery,
        mixedRead,
        command,
        projector,
        commentCommand,
        reactionCommand,
      },
      invariants: {
        keysetUniqueCommunities: keysetIds.size,
        commandEvidence,
        projectionEvidence,
        contentCommandEvidence,
      },
      budgetBreaches,
    })}\n`,
  );
  if (budgetBreaches.length > 0) process.exitCode = 1;
} finally {
  await Promise.all(pools.map((currentPool) => currentPool.end()));
}
