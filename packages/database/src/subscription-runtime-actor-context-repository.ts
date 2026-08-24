import type { Pool } from 'pg';

import { queryOne, withTenantTransaction } from './connection.js';

export type SubscriptionRuntimeActorContext =
  | {
      readonly outcome: 'ok';
      readonly providerClientId: string;
      readonly providerMappingId: string;
    }
  | { readonly outcome: 'session_inactive' | 'provider_mapping_unavailable' };

interface ContextRow {
  readonly provider_client_id: string;
  readonly provider_mapping_id: string;
}

export interface SubscriptionRuntimeActorContextRepository {
  resolve(input: {
    readonly tenantId: string;
    readonly userId: string;
    readonly sessionId: string;
  }): Promise<SubscriptionRuntimeActorContext>;
}

export function createSubscriptionRuntimeActorContextRepository(
  pool: Pool,
): SubscriptionRuntimeActorContextRepository {
  return {
    resolve(input) {
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        const row = await queryOne<ContextRow>(
          client,
          `
          select mapping.external_id as provider_client_id, mapping.id as provider_mapping_id
            from identity.refresh_sessions presented
            join identity.users active_user
              on active_user.tenant_id = presented.tenant_id
             and active_user.id = presented.user_id
             and active_user.status = 'ACTIVE'
            join integration.external_entity_map mapping
              on mapping.tenant_id = presented.tenant_id
             and mapping.internal_id = presented.user_id
             and mapping.external_system = 'VIVA'
             and mapping.entity_type = 'viva_profile'
             and mapping.sync_status = 'synced'
             and mapping.last_synced_at is not null
           where presented.tenant_id = $1
             and presented.id = $2
             and presented.user_id = $3
             and presented.revoked_at is null
             and presented.rotated_at is null
             and presented.expires_at > now()
        `,
          [input.tenantId, input.sessionId, input.userId],
        );
        if (row)
          return {
            outcome: 'ok',
            providerClientId: row.provider_client_id,
            providerMappingId: row.provider_mapping_id,
          };
        const session = await queryOne<{ active: boolean }>(
          client,
          `
          select true as active from identity.refresh_sessions presented
          where presented.tenant_id = $1 and presented.id = $2 and presented.user_id = $3
            and presented.revoked_at is null and presented.rotated_at is null and presented.expires_at > now()
        `,
          [input.tenantId, input.sessionId, input.userId],
        );
        return session
          ? { outcome: 'provider_mapping_unavailable' }
          : { outcome: 'session_inactive' };
      });
    },
  };
}
