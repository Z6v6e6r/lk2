import type { Pool } from 'pg';

import { withTenantTransaction } from './connection.js';

export interface ResidencyRepository {
  /**
   * Resolves the integration-only Viva client ID for one verified PadlHub user.
   * Only a unique, synced Viva profile mapping is accepted; an ambiguous or
   * missing mapping returns undefined instead of guessing.
   */
  resolveVivaClientId(input: {
    readonly tenantId: string;
    readonly userId: string;
  }): Promise<string | undefined>;
}

export function createResidencyRepository(pool: Pool): ResidencyRepository {
  return {
    resolveVivaClientId(input) {
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        const result = await client.query<{ readonly external_id: string }>(
          `select mapping.external_id
             from identity.users u
             join identity.tenants t on t.id = u.tenant_id and t.active = true
             join integration.external_entity_map mapping
               on mapping.tenant_id = u.tenant_id
              and mapping.internal_id = u.id
              and mapping.external_system = 'VIVA'
              and mapping.entity_type = 'viva_profile'
              and mapping.sync_status = 'synced'
              and mapping.sync_error_code is null
              and mapping.last_synced_at is not null
            where u.tenant_id = $1
              and u.id = $2
              and u.status = 'ACTIVE'
              and (select count(*)
                     from integration.external_entity_map forward
                    where forward.tenant_id = u.tenant_id
                      and forward.internal_id = u.id
                      and forward.external_system = 'VIVA'
                      and forward.entity_type = 'viva_profile') = 1
              and (select count(*)
                     from integration.external_entity_map reverse
                    where reverse.tenant_id = u.tenant_id
                      and reverse.external_id = mapping.external_id
                      and reverse.external_system = 'VIVA'
                      and reverse.entity_type = 'viva_profile') = 1
            limit 2`,
          [input.tenantId, input.userId],
        );
        return result.rows.length === 1 ? result.rows[0]?.external_id : undefined;
      });
    },
  };
}
