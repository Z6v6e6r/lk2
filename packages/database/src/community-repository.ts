import type {
  CommunityLegacyBridgeRepository,
  CommunityDirectoryRepository,
  CommunityDirectoryRepositoryPage,
} from '@phub/communities';
import type { Pool, QueryResultRow } from 'pg';

import { withTenantTransaction } from './connection.js';

export type {
  CommunityLegacyBridgeRepository,
  LegacyCommunityViewerIdentity,
} from '@phub/communities';

interface ViewerIdentityRow extends QueryResultRow {
  readonly phone_e164: string | null;
  readonly client_id: string | null;
}

interface CommunityMappingRow extends QueryResultRow {
  readonly external_id: string;
  readonly internal_id: string;
}

interface CommunityLogoRow extends QueryResultRow {
  readonly community_id: string;
  readonly delivery_url: string;
}

interface CommunityDirectoryRow extends QueryResultRow {
  readonly id: string;
  readonly title: string;
  readonly is_verified: boolean;
  readonly logo_url: string | null;
  readonly pinned: boolean;
  readonly sort_at: Date | string;
}

function timestamp(value: Date | string): string {
  return new Date(value).toISOString();
}

export function createCommunityLegacyBridgeRepository(pool: Pool): CommunityLegacyBridgeRepository {
  return {
    getViewerIdentity(tenantId, userId) {
      return withTenantTransaction(pool, tenantId, async (client) => {
        const row = (
          await client.query<ViewerIdentityRow>(
            `select p.phone_e164, legacy.client_id
               from identity.users u
               left join profile.user_summaries p
                 on p.tenant_id = u.tenant_id and p.user_id = u.id
               left join lateral (
                 select e.external_id as client_id
                   from integration.external_entity_map e
                  where e.tenant_id = u.tenant_id
                    and e.external_system = 'VIVA'
                    and e.entity_type = 'viva_profile'
                    and e.internal_id = u.id
                  order by e.last_synced_at desc nulls last, e.id
                  limit 1
               ) legacy on true
              where u.tenant_id = $1 and u.id = $2 and u.status = 'ACTIVE'`,
            [tenantId, userId],
          )
        ).rows[0];
        return {
          ...(row?.phone_e164 ? { phoneE164: row.phone_e164 } : {}),
          ...(row?.client_id ? { clientId: row.client_id } : {}),
        };
      });
    },

    resolveCommunityIds(tenantId, externalIds) {
      const uniqueExternalIds = [...new Set(externalIds.map((id) => id.trim()).filter(Boolean))];
      if (uniqueExternalIds.length === 0) return Promise.resolve(new Map());
      return withTenantTransaction(pool, tenantId, async (client) => {
        const result = await client.query<CommunityMappingRow>(
          `with source as (
             select distinct external_id
               from unnest($2::text[]) as source_ids(external_id)
           )
           insert into integration.external_entity_map (
             tenant_id, external_system, entity_type, internal_id, external_id,
             external_version, last_synced_at, sync_status, sync_error_code
           )
           select $1, 'LK_LEGACY', 'community', gen_random_uuid(), source.external_id,
                  'summary-v1', now(), 'synced', null
             from source
           on conflict (tenant_id, external_system, entity_type, external_id)
           do update set external_version = excluded.external_version,
                         last_synced_at = excluded.last_synced_at,
                         sync_status = 'synced',
                         sync_error_code = null
           returning external_id, internal_id`,
          [tenantId, uniqueExternalIds],
        );
        return new Map(result.rows.map((row) => [row.external_id, row.internal_id]));
      });
    },

    getCommunityLogoUrls(tenantId, communityIds) {
      const uniqueCommunityIds = [...new Set(communityIds)];
      if (uniqueCommunityIds.length === 0) return Promise.resolve(new Map());
      return withTenantTransaction(pool, tenantId, async (client) => {
        const result = await client.query<CommunityLogoRow>(
          `select community_id::text as community_id, delivery_url
             from integration.community_logo_sync
            where tenant_id = $1 and community_id = any($2::uuid[])`,
          [tenantId, uniqueCommunityIds],
        );
        return new Map(result.rows.map((row) => [row.community_id, row.delivery_url]));
      });
    },
  };
}

export function createLocalCommunityDirectoryRepository(pool: Pool): CommunityDirectoryRepository {
  return {
    listMemberships(input): Promise<CommunityDirectoryRepositoryPage> {
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        const result = await client.query<CommunityDirectoryRow>(
          `select c.id, c.title, c.is_verified, logo.delivery_url as logo_url,
                  (m.pinned_at is not null) as pinned,
                  greatest(c.updated_at, m.updated_at) as sort_at
             from communities.memberships m
             join communities.communities c
               on c.tenant_id = m.tenant_id and c.id = m.community_id
             left join integration.community_logo_sync logo
               on logo.tenant_id = c.tenant_id and logo.community_id = c.id
            where m.tenant_id = $1
              and m.user_id = $2
              and m.status = 'ACTIVE'
              and c.status = 'ACTIVE'
              and (
                $4::boolean is null
                or ($4 = true and m.pinned_at is null)
                or (
                  (m.pinned_at is not null) = $4
                  and (
                    greatest(c.updated_at, m.updated_at) < $5::timestamptz
                    or (
                      greatest(c.updated_at, m.updated_at) = $5::timestamptz
                      and c.id > $6::uuid
                    )
                  )
                )
              )
            order by (m.pinned_at is not null) desc,
                     greatest(c.updated_at, m.updated_at) desc,
                     c.id
            limit $3`,
          [
            input.tenantId,
            input.userId,
            input.limit + 1,
            input.after?.pinned ?? null,
            input.after?.sortAt ?? null,
            input.after?.id ?? null,
          ],
        );
        const items = result.rows.slice(0, input.limit).map((row) => ({
          id: row.id,
          title: row.title,
          logoUrl: row.logo_url,
          isVerified: row.is_verified,
          unreadChatCount: 0,
          pinned: row.pinned,
          sortAt: timestamp(row.sort_at),
        }));
        return { items, hasMore: result.rows.length > input.limit };
      });
    },
  };
}
