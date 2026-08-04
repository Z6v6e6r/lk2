import type { CommunityReadRecord, CommunityReadRepository } from '@phub/communities';
import type { Pool, QueryResultRow } from 'pg';

import { withTenantTransaction } from './connection.js';

interface CommunityReadRow extends QueryResultRow {
  readonly id: string;
  readonly title: string;
  readonly description: string | null;
  readonly logo_url: string | null;
  readonly is_verified: boolean;
  readonly visibility: CommunityReadRecord['visibility'];
  readonly join_policy: CommunityReadRecord['joinPolicy'];
  readonly publishing_preset: CommunityReadRecord['publishingPreset'] | null;
  readonly revision: number | string;
  readonly member_count: number | string;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
  readonly sort_created_at: string;
  readonly membership_status: NonNullable<CommunityReadRecord['viewerMembership']>['status'] | null;
  readonly membership_role: NonNullable<CommunityReadRecord['viewerMembership']>['role'] | null;
  readonly membership_revision: number | string | null;
  readonly ranking_position: number | string | null;
}

function timestamp(value: Date | string): string {
  return new Date(value).toISOString();
}

function mapRow(row: CommunityReadRow): CommunityReadRecord {
  if (!row.publishing_preset) throw new Error('COMMUNITY_CANONICAL_POLICY_MISSING');
  const viewerMembership =
    row.membership_status && row.membership_role && row.membership_revision !== null
      ? {
          status: row.membership_status,
          role: row.membership_role,
          revision: Number(row.membership_revision),
          ...(row.ranking_position === null ? {} : { memberRank: Number(row.ranking_position) }),
        }
      : undefined;
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    logoUrl: row.logo_url,
    isVerified: row.is_verified,
    visibility: row.visibility,
    joinPolicy: row.join_policy,
    publishingPreset: row.publishing_preset,
    revision: Number(row.revision),
    memberCount: Number(row.member_count),
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
    sortCreatedAt: row.sort_created_at,
    ...(viewerMembership ? { viewerMembership } : {}),
  };
}

const READ_COLUMNS = `
  c.id,
  c.title,
  case
    when c.visibility = 'PUBLIC' or viewer.status = 'ACTIVE' then c.description
    else null
  end as description,
  logo.delivery_url as logo_url,
  c.is_verified,
  c.visibility,
  c.join_policy,
  c.publishing_preset,
  c.revision,
  case
    when c.visibility = 'PUBLIC' or viewer.status = 'ACTIVE' then
      case
        when counters.state = 'READY' then counters.active_member_count
        else (
          select count(*)::integer
            from communities.memberships active_member
           where active_member.tenant_id = c.tenant_id
             and active_member.community_id = c.id
             and active_member.status = 'ACTIVE'
        )
      end
    else 0
  end as member_count,
  c.created_at,
  c.updated_at,
  c.created_at::text as sort_created_at,
  viewer.status as membership_status,
  viewer.role as membership_role,
  viewer.revision as membership_revision,
  viewer.ranking_position
`;

export function createCommunityReadRepository(pool: Pool): CommunityReadRepository {
  return {
    listDiscoverable(input) {
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        const result = await client.query<CommunityReadRow>(
          `select ${READ_COLUMNS}
             from communities.communities c
             left join communities.memberships viewer
               on viewer.tenant_id = c.tenant_id
              and viewer.community_id = c.id
              and viewer.user_id = $2
             left join integration.community_logo_sync logo
               on logo.tenant_id = c.tenant_id and logo.community_id = c.id
             left join communities.member_count_projections counters
               on counters.tenant_id = c.tenant_id and counters.community_id = c.id
            where c.tenant_id = $1
              and c.status = 'ACTIVE'
              and c.visibility in ('PUBLIC', 'LISTED_PRIVATE')
              and (
                $3::text is null
                or lower(c.title) like '%' || $3 || '%'
                or (
                  c.visibility = 'PUBLIC'
                  and lower(coalesce(c.description, '')) like '%' || $3 || '%'
                )
              )
              and (
                $4::timestamptz is null
                or c.created_at < $4::timestamptz
                or (c.created_at = $4::timestamptz and c.id < $5::uuid)
              )
            order by c.created_at desc, c.id desc
            limit $6`,
          [
            input.tenantId,
            input.viewerUserId,
            input.query ?? null,
            input.after?.createdAt ?? null,
            input.after?.id ?? null,
            input.limit + 1,
          ],
        );
        return {
          items: result.rows.slice(0, input.limit).map(mapRow),
          hasMore: result.rows.length > input.limit,
        };
      });
    },

    getDetail(input) {
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        const result = await client.query<CommunityReadRow>(
          `select ${READ_COLUMNS}
             from communities.communities c
             left join communities.memberships viewer
               on viewer.tenant_id = c.tenant_id
              and viewer.community_id = c.id
              and viewer.user_id = $2
             left join integration.community_logo_sync logo
               on logo.tenant_id = c.tenant_id and logo.community_id = c.id
             left join communities.member_count_projections counters
               on counters.tenant_id = c.tenant_id and counters.community_id = c.id
            where c.tenant_id = $1
              and c.id = $3
              and c.status = 'ACTIVE'
            limit 1`,
          [input.tenantId, input.viewerUserId, input.communityId],
        );
        const row = result.rows[0];
        return row ? mapRow(row) : undefined;
      });
    },
  };
}
