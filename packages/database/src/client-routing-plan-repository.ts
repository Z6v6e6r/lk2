import type { ClientRoutingMode, DirectVivaReadOperation } from '@phub/domain';
import type { Pool, QueryResultRow } from 'pg';

import { withTenantTransaction } from './connection.js';

export interface StoredClientRoutingPlan {
  readonly mode: ClientRoutingMode;
  readonly revision: string;
  readonly validForSeconds: number;
  readonly directOperations: readonly DirectVivaReadOperation[];
  readonly providerTenantKey?: string;
  readonly delegationReady: boolean;
}

export interface ClientRoutingPlanRepository {
  get(tenantId: string, userId: string): Promise<StoredClientRoutingPlan>;
}

interface RoutingRow extends QueryResultRow {
  readonly mode: ClientRoutingMode;
  readonly revision: string;
  readonly valid_for_seconds: number;
  readonly direct_read_operations: DirectVivaReadOperation[];
  readonly provider_tenant_key: string | null;
  readonly delegation_ready: boolean;
}

export function createClientRoutingPlanRepository(pool: Pool): ClientRoutingPlanRepository {
  return {
    get(tenantId, userId) {
      return withTenantTransaction(pool, tenantId, async (client) => {
        const row = (
          await client.query<RoutingRow>(
            `select p.mode,
                    p.revision::text as revision,
                    p.valid_for_seconds,
                    p.direct_read_operations,
                    b.provider_tenant_key,
                    exists (
                      select 1
                        from integration.user_delegations d
                       where d.tenant_id = p.tenant_id
                         and d.user_id = $2
                         and d.provider = 'VIVA'
                         and d.revoked_at is null
                         and (d.refresh_expires_at is null or d.refresh_expires_at > now())
                    ) as delegation_ready
               from integration.client_routing_plans p
               left join integration.identity_provider_bindings b
                 on b.tenant_id = p.tenant_id and b.provider = 'VIVA'
              where p.tenant_id = $1`,
            [tenantId, userId],
          )
        ).rows[0];
        if (!row) {
          return {
            mode: 'PADLHUB_ONLY',
            revision: '0',
            validForSeconds: 30,
            directOperations: [],
            delegationReady: false,
          };
        }
        return {
          mode: row.mode,
          revision: row.revision,
          validForSeconds: row.valid_for_seconds,
          directOperations: [...new Set(row.direct_read_operations)],
          delegationReady: row.delegation_ready,
          ...(row.provider_tenant_key ? { providerTenantKey: row.provider_tenant_key } : {}),
        };
      });
    },
  };
}
