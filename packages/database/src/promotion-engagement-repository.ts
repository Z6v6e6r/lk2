import type { Pool, QueryResultRow } from 'pg';

import { queryOne, withTenantTransaction } from './connection.js';

export type PromotionEngagementPlacement =
  'cabinet_home' | 'cabinet_home_top' | 'cabinet_for_me_strip' | 'cabinet_for_me_card';

export interface PromotionEngagementContext {
  readonly placement: PromotionEngagementPlacement;
  readonly externalAdId: string;
  readonly phoneE164?: string;
}

export interface PromotionEngagementRepository {
  resolveContext(
    tenantId: string,
    userId: string,
    promotionId: string,
  ): Promise<PromotionEngagementContext | undefined>;
}

interface PromotionEngagementRow extends QueryResultRow {
  readonly external_id: string;
  readonly phone_e164: string | null;
}

function parseExternalId(value: string): Omit<PromotionEngagementContext, 'phoneE164'> | undefined {
  const prefixes: readonly [string, PromotionEngagementPlacement][] = [
    ['top:', 'cabinet_home_top'],
    ['strip:', 'cabinet_for_me_strip'],
    ['card:', 'cabinet_for_me_card'],
  ];
  const matched = prefixes.find(([prefix]) => value.startsWith(prefix));
  if (matched) {
    const externalAdId = value.slice(matched[0].length).trim();
    return externalAdId ? { placement: matched[1], externalAdId } : undefined;
  }
  const externalAdId = value.trim();
  return externalAdId ? { placement: 'cabinet_home', externalAdId } : undefined;
}

export function createPromotionEngagementRepository(pool: Pool): PromotionEngagementRepository {
  return {
    resolveContext(tenantId, userId, promotionId) {
      return withTenantTransaction(pool, tenantId, async (client) => {
        const row = await queryOne<PromotionEngagementRow>(
          client,
          `select mapping.external_id, profile.phone_e164
             from integration.external_entity_map mapping
             join identity.users users
               on users.tenant_id = mapping.tenant_id and users.id = $2 and users.status = 'ACTIVE'
             left join profile.user_summaries profile
               on profile.tenant_id = users.tenant_id and profile.user_id = users.id
            where mapping.tenant_id = $1
              and mapping.external_system = 'LK_LEGACY'
              and mapping.entity_type = 'cabinet_home_ad'
              and mapping.internal_id = $3
            limit 1`,
          [tenantId, userId, promotionId],
        );
        if (!row) return undefined;
        const parsed = parseExternalId(row.external_id);
        return parsed
          ? {
              ...parsed,
              ...(row.phone_e164 ? { phoneE164: row.phone_e164 } : {}),
            }
          : undefined;
      });
    },
  };
}
