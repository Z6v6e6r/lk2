import type { Pool, QueryResultRow } from 'pg';

import { queryOne, withTenantTransaction } from './connection.js';

export interface PlayerProfileSummary {
  readonly userId: string;
  readonly displayName: string;
  readonly avatarUrl: string | null;
  readonly levelLabel: string | null;
  readonly levelValue: number | null;
}

export interface ProfileSummaryRepository {
  get(tenantId: string, userId: string): Promise<PlayerProfileSummary | undefined>;
  getPhotoObjectKey(tenantId: string, deliveryId: string): Promise<string | undefined>;
  getPhotoDeliveryIds(
    tenantId: string,
    userIds: readonly string[],
  ): Promise<ReadonlyMap<string, string>>;
  getDisplayNames(
    tenantId: string,
    userIds: readonly string[],
  ): Promise<ReadonlyMap<string, string>>;
  getLevelValues(
    tenantId: string,
    userIds: readonly string[],
  ): Promise<ReadonlyMap<string, number>>;
}

interface ProfileSummaryRow extends QueryResultRow {
  readonly user_id: string;
  readonly display_name: string;
  readonly photo_url: string | null;
  readonly level_label: string | null;
  readonly level_value: number | string | null;
}

function levelValue(value: number | string | null): number | null {
  if (value === null) return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 10 ? parsed : null;
}

export function createProfileSummaryRepository(pool: Pool): ProfileSummaryRepository {
  return {
    get(tenantId, userId) {
      return withTenantTransaction(pool, tenantId, async (client) => {
        const row = await queryOne<ProfileSummaryRow>(
          client,
          `select user_id, display_name, photo_url, level_label, level_value
             from profile.user_summaries
            where tenant_id = $1 and user_id = $2`,
          [tenantId, userId],
        );
        return row
          ? {
              userId: row.user_id,
              displayName: row.display_name,
              avatarUrl: row.photo_url,
              levelLabel: row.level_label,
              levelValue: levelValue(row.level_value),
            }
          : undefined;
      });
    },

    getPhotoObjectKey(tenantId, deliveryId) {
      return withTenantTransaction(pool, tenantId, async (client) => {
        const row = await queryOne<{ readonly object_key: string } & QueryResultRow>(
          client,
          `select s.object_key
             from integration.user_profile_photo_sync s
             join identity.tenants t on t.id = s.tenant_id and t.active = true
            where s.tenant_id = $1 and s.delivery_id = $2`,
          [tenantId, deliveryId],
        );
        return row?.object_key;
      });
    },

    getPhotoDeliveryIds(tenantId, userIds) {
      if (userIds.length === 0) return Promise.resolve(new Map());
      return withTenantTransaction(pool, tenantId, async (client) => {
        const rows = await client.query<
          { readonly user_id: string; readonly delivery_id: string } & QueryResultRow
        >(
          `select user_id, delivery_id
             from integration.user_profile_photo_sync
            where tenant_id = $1 and user_id = any($2::uuid[])`,
          [tenantId, [...new Set(userIds)]],
        );
        return new Map(rows.rows.map((row) => [row.user_id, row.delivery_id]));
      });
    },

    getDisplayNames(tenantId, userIds) {
      if (userIds.length === 0) return Promise.resolve(new Map());
      return withTenantTransaction(pool, tenantId, async (client) => {
        const rows = await client.query<
          { readonly user_id: string; readonly display_name: string } & QueryResultRow
        >(
          `select user_id, display_name
             from profile.user_summaries
            where tenant_id = $1 and user_id = any($2::uuid[])
              and nullif(btrim(display_name), '') is not null`,
          [tenantId, [...new Set(userIds)]],
        );
        return new Map(rows.rows.map((row) => [row.user_id, row.display_name.trim()]));
      });
    },

    getLevelValues(tenantId, userIds) {
      if (userIds.length === 0) return Promise.resolve(new Map());
      return withTenantTransaction(pool, tenantId, async (client) => {
        const rows = await client.query<
          { readonly user_id: string; readonly level_value: number | string } & QueryResultRow
        >(
          `select user_id, level_value
             from profile.user_summaries
            where tenant_id = $1 and user_id = any($2::uuid[]) and level_value is not null`,
          [tenantId, [...new Set(userIds)]],
        );
        return new Map(
          rows.rows.flatMap((row) => {
            const value = levelValue(row.level_value);
            return value === null ? [] : [[row.user_id, value] as const];
          }),
        );
      });
    },
  };
}
