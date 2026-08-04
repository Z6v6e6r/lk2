import type { Pool, PoolClient, QueryResultRow } from 'pg';

import { queryOne, withTenantTransaction } from './connection.js';

const CONSUMER_NAME = 'community-member-count-projector-v1';

export const COMMUNITY_MEMBER_COUNT_EVENT_TYPES = [
  'community.created.v1',
  'community.member.joined.v1',
  'community.member.left.v1',
  'community.join.approved.v1',
  'community.direct_invite.redeemed.v1',
] as const;

export type CommunityMemberCountEventType = (typeof COMMUNITY_MEMBER_COUNT_EVENT_TYPES)[number];

interface MembershipRow extends QueryResultRow {
  readonly status: 'PENDING' | 'ACTIVE' | 'LEFT' | 'REMOVED' | 'BANNED';
  readonly revision: number | string;
}

interface ContributionRow extends QueryResultRow {
  readonly membership_revision: number | string;
  readonly is_active: boolean;
}

interface ProjectionRow extends QueryResultRow {
  readonly state: 'BUILDING' | 'READY' | 'STALE';
  readonly reconciliation_cursor: string | null;
}

interface ReconciliationBatchRow extends QueryResultRow {
  readonly processed_count: number | string;
  readonly next_cursor: string | null;
  readonly active_delta: number | string;
}

export interface CommunityMemberCountProjectionEvent {
  readonly tenantId: string;
  readonly eventId: string;
  readonly eventType: CommunityMemberCountEventType;
  readonly communityId: string;
  readonly userId: string;
}

export type CommunityMemberCountProjectionResult =
  'applied' | 'duplicate' | 'stale' | 'source_missing';

export interface CommunityMemberCountReconciliationResult {
  readonly outcome: 'progressed' | 'ready' | 'stale' | 'community_not_found';
  readonly processed: number;
  readonly drift?: number;
}

export interface CommunityMemberCountProjectionRepository {
  projectEvent(
    input: CommunityMemberCountProjectionEvent,
  ): Promise<CommunityMemberCountProjectionResult>;
  listReconciliationCandidates(input: {
    readonly tenantId: string;
    readonly reconcileBefore: string;
    readonly limit: number;
  }): Promise<readonly string[]>;
  reconcileBatch(input: {
    readonly tenantId: string;
    readonly communityId: string;
    readonly batchSize: number;
  }): Promise<CommunityMemberCountReconciliationResult>;
}

function assertBatchSize(value: number, maximum: number): void {
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new Error('COMMUNITY_MEMBER_COUNT_RECONCILIATION_LIMIT_INVALID');
  }
}

async function lockCommunity(client: PoolClient, tenantId: string, communityId: string) {
  await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
    `community-member-count:${tenantId}:${communityId}`,
  ]);
}

async function ensureProjection(
  client: PoolClient,
  tenantId: string,
  communityId: string,
): Promise<boolean> {
  const row = await queryOne<{ readonly community_id: string } & QueryResultRow>(
    client,
    `insert into communities.member_count_projections (tenant_id, community_id)
     select $1, community.id
       from communities.communities community
      where community.tenant_id = $1 and community.id = $2
     on conflict (tenant_id, community_id) do update
       set updated_at = communities.member_count_projections.updated_at
     returning community_id`,
    [tenantId, communityId],
  );
  return Boolean(row);
}

async function finishInbox(client: PoolClient, eventId: string): Promise<void> {
  await client.query(
    `update audit.inbox_events
        set processed_at = now()
      where consumer_name = $1 and event_id = $2`,
    [CONSUMER_NAME, eventId],
  );
}

async function applyCanonicalMembership(
  client: PoolClient,
  input: CommunityMemberCountProjectionEvent,
): Promise<'applied' | 'stale' | 'source_missing'> {
  const current = await queryOne<MembershipRow>(
    client,
    `select status, revision
       from communities.memberships
      where tenant_id = $1 and community_id = $2 and user_id = $3`,
    [input.tenantId, input.communityId, input.userId],
  );
  if (!current) return 'source_missing';

  const previous = await queryOne<ContributionRow>(
    client,
    `select membership_revision, is_active
       from communities.member_count_contributions
      where tenant_id = $1 and community_id = $2 and user_id = $3
      for update`,
    [input.tenantId, input.communityId, input.userId],
  );
  if (previous && Number(previous.membership_revision) >= Number(current.revision)) return 'stale';

  const isActive = current.status === 'ACTIVE';
  const delta = Number(isActive) - Number(previous?.is_active ?? false);
  await client.query(
    `insert into communities.member_count_contributions (
       tenant_id, community_id, user_id, membership_revision, is_active
     ) values ($1, $2, $3, $4, $5)
     on conflict (tenant_id, community_id, user_id) do update
       set membership_revision = excluded.membership_revision,
           is_active = excluded.is_active,
           updated_at = now()
     where communities.member_count_contributions.membership_revision
           < excluded.membership_revision`,
    [input.tenantId, input.communityId, input.userId, current.revision, isActive],
  );
  await client.query(
    `update communities.member_count_projections
        set active_member_count = active_member_count + $3,
            projection_revision = projection_revision + 1,
            updated_at = now()
      where tenant_id = $1 and community_id = $2`,
    [input.tenantId, input.communityId, delta],
  );
  return 'applied';
}

export function createCommunityMemberCountProjectionRepository(
  pool: Pool,
): CommunityMemberCountProjectionRepository {
  return {
    projectEvent(input) {
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        const inbox = await client.query(
          `insert into audit.inbox_events (consumer_name, event_id, tenant_id)
           values ($1, $2, $3)
           on conflict (consumer_name, event_id) do nothing
           returning event_id`,
          [CONSUMER_NAME, input.eventId, input.tenantId],
        );
        if ((inbox.rowCount ?? 0) === 0) return 'duplicate';

        await lockCommunity(client, input.tenantId, input.communityId);
        if (!(await ensureProjection(client, input.tenantId, input.communityId))) {
          await finishInbox(client, input.eventId);
          return 'source_missing';
        }
        const result = await applyCanonicalMembership(client, input);
        await finishInbox(client, input.eventId);
        return result;
      });
    },

    listReconciliationCandidates(input) {
      assertBatchSize(input.limit, 100);
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        const result = await client.query<{ readonly id: string } & QueryResultRow>(
          `select community.id
             from communities.communities community
             left join communities.member_count_projections projection
               on projection.tenant_id = community.tenant_id
              and projection.community_id = community.id
            where community.tenant_id = $1
              and community.status = 'ACTIVE'
              and (
                projection.community_id is null
                or projection.state <> 'READY'
                or projection.reconciled_at < $2::timestamptz
              )
            order by
              case when projection.community_id is null then 0 else 1 end,
              projection.reconciled_at nulls first,
              community.id
            limit $3`,
          [input.tenantId, input.reconcileBefore, input.limit],
        );
        return result.rows.map((row) => row.id);
      });
    },

    reconcileBatch(input) {
      assertBatchSize(input.batchSize, 1_000);
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        await lockCommunity(client, input.tenantId, input.communityId);
        if (!(await ensureProjection(client, input.tenantId, input.communityId))) {
          return { outcome: 'community_not_found', processed: 0 };
        }
        let projection = await queryOne<ProjectionRow>(
          client,
          `select state, reconciliation_cursor
             from communities.member_count_projections
            where tenant_id = $1 and community_id = $2
            for update`,
          [input.tenantId, input.communityId],
        );
        if (!projection) throw new Error('COMMUNITY_MEMBER_COUNT_PROJECTION_MISSING');

        if (projection.state !== 'BUILDING') {
          await client.query(
            `update communities.member_count_projections
                set state = 'BUILDING', reconciliation_cursor = null,
                    reconciliation_started_at = now(), updated_at = now()
              where tenant_id = $1 and community_id = $2`,
            [input.tenantId, input.communityId],
          );
          projection = { state: 'BUILDING', reconciliation_cursor: null };
        }

        const batch = await queryOne<ReconciliationBatchRow>(
          client,
          `with source as materialized (
             select membership.user_id, membership.revision,
                    membership.status = 'ACTIVE' as is_active
               from communities.memberships membership
              where membership.tenant_id = $1
                and membership.community_id = $2
                and ($3::uuid is null or membership.user_id > $3::uuid)
              order by membership.user_id
              limit $4
           ),
           changes as materialized (
             select source.user_id, source.revision, source.is_active,
                    contribution.membership_revision as previous_revision,
                    coalesce(contribution.is_active, false) as was_active
               from source
               left join communities.member_count_contributions contribution
                 on contribution.tenant_id = $1
                and contribution.community_id = $2
                and contribution.user_id = source.user_id
           ),
           upserted as (
             insert into communities.member_count_contributions (
               tenant_id, community_id, user_id, membership_revision, is_active
             )
             select $1, $2, user_id, revision, is_active from changes
             on conflict (tenant_id, community_id, user_id) do update
               set membership_revision = excluded.membership_revision,
                   is_active = excluded.is_active,
                   updated_at = now()
             where communities.member_count_contributions.membership_revision
                   < excluded.membership_revision
             returning user_id
           )
           select (select count(*) from source)::integer as processed_count,
                  (select user_id::text from source order by user_id desc limit 1) as next_cursor,
                  coalesce((
                    select sum(changes.is_active::integer - changes.was_active::integer)
                      from changes
                      join upserted using (user_id)
                  ), 0)::integer as active_delta`,
          [input.tenantId, input.communityId, projection.reconciliation_cursor, input.batchSize],
        );
        if (!batch) throw new Error('COMMUNITY_MEMBER_COUNT_RECONCILIATION_BATCH_MISSING');
        const processed = Number(batch.processed_count);
        const delta = Number(batch.active_delta);

        if (processed > 0) {
          await client.query(
            `update communities.member_count_projections
                set active_member_count = active_member_count + $3,
                    projection_revision = projection_revision + 1,
                    reconciliation_cursor = $4::uuid,
                    reconciliation_started_at = coalesce(reconciliation_started_at, now()),
                    updated_at = now()
              where tenant_id = $1 and community_id = $2`,
            [input.tenantId, input.communityId, delta, batch.next_cursor],
          );
          return { outcome: 'progressed', processed };
        }

        const removed = await client.query<{ readonly is_active: boolean } & QueryResultRow>(
          `delete from communities.member_count_contributions contribution
            where contribution.tenant_id = $1
              and contribution.community_id = $2
              and not exists (
                select 1 from communities.memberships membership
                 where membership.tenant_id = contribution.tenant_id
                   and membership.community_id = contribution.community_id
                   and membership.user_id = contribution.user_id
              )
          returning is_active`,
          [input.tenantId, input.communityId],
        );
        const removedActive = removed.rows.filter((row) => row.is_active).length;
        if (removedActive > 0) {
          await client.query(
            `update communities.member_count_projections
                set active_member_count = active_member_count - $3,
                    projection_revision = projection_revision + 1,
                    updated_at = now()
              where tenant_id = $1 and community_id = $2`,
            [input.tenantId, input.communityId, removedActive],
          );
        }

        const counts = await queryOne<
          {
            readonly canonical_count: number | string;
            readonly projected_count: number | string;
          } & QueryResultRow
        >(
          client,
          `select
             (select count(*) from communities.memberships
               where tenant_id = $1 and community_id = $2 and status = 'ACTIVE')
               as canonical_count,
             (select active_member_count from communities.member_count_projections
               where tenant_id = $1 and community_id = $2)
               as projected_count`,
          [input.tenantId, input.communityId],
        );
        if (!counts) throw new Error('COMMUNITY_MEMBER_COUNT_RECONCILIATION_COUNTS_MISSING');
        const drift = Number(counts.projected_count) - Number(counts.canonical_count);
        const nextState = drift === 0 ? 'READY' : 'STALE';
        await client.query(
          `update communities.member_count_projections
              set state = $3, reconciliation_cursor = null,
                  reconciled_at = case when $3 = 'READY' then now() else reconciled_at end,
                  updated_at = now()
            where tenant_id = $1 and community_id = $2`,
          [input.tenantId, input.communityId, nextState],
        );
        return {
          outcome: drift === 0 ? 'ready' : 'stale',
          processed: 0,
          ...(drift === 0 ? {} : { drift }),
        };
      });
    },
  };
}
