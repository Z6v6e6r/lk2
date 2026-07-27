import type { Pool, QueryResultRow } from 'pg';

import { withTenantTransaction } from './connection.js';

export interface ProfileLevelHistoryPoint {
  readonly changedAt: string;
  readonly levelLabel: string;
  readonly levelValue: number | null;
}

export interface ProfileLevelHistory {
  readonly userId: string;
  readonly items: readonly ProfileLevelHistoryPoint[];
}

export interface ProfileLevelHistoryRepository {
  list(tenantId: string, userId: string, limit: number): Promise<ProfileLevelHistory>;
}

interface ProfileLevelHistoryRow extends QueryResultRow {
  readonly changed_at: Date | string;
  readonly level_label: string;
  readonly level_value: number | string | null;
}

function levelValue(value: number | string | null): number | null {
  if (value === null) return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 10 ? parsed : null;
}

export function createProfileLevelHistoryRepository(pool: Pool): ProfileLevelHistoryRepository {
  return {
    list(tenantId, userId, limit) {
      return withTenantTransaction(pool, tenantId, async (client) => {
        const result = await client.query<ProfileLevelHistoryRow>(
          `select changed_at, level_label, level_value
             from (
               select id, changed_at, level_label, level_value
                 from profile.level_history
                where tenant_id = $1 and user_id = $2
                order by changed_at desc, id desc
                limit $3
             ) latest
            order by changed_at, id`,
          [tenantId, userId, limit],
        );
        return {
          userId,
          items: result.rows.map((row) => ({
            changedAt: new Date(row.changed_at).toISOString(),
            levelLabel: row.level_label,
            levelValue: levelValue(row.level_value),
          })),
        };
      });
    },
  };
}
