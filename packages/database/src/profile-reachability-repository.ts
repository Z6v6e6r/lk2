import type { Pool } from 'pg';

import { queryOne, withTenantTransaction } from './connection.js';

/**
 * A player account is reachable when its owner can actually sign in to PadlHub: the record holds a
 * login phone, the owner completed the client-assisted provider link, or the record already has a
 * refresh session. Player rows imported from the legacy cabinet have none of these, so a friend
 * request or a direct conversation addressed to them would silently disappear: whoever owns the
 * person's real login lands on a different account.
 *
 * The predicate is exposed both as SQL for command guards and as a repository for read models.
 */
export function profileReachableSql(input: {
  readonly tenantParam: string;
  readonly userParam: string;
}): string {
  return `(
    exists (
      select 1
        from profile.user_summaries reachable_summary
       where reachable_summary.tenant_id = ${input.tenantParam}
         and reachable_summary.user_id = ${input.userParam}
         and btrim(coalesce(reachable_summary.phone_e164, '')) <> ''
    )
    or exists (
      select 1
        from identity.refresh_sessions reachable_session
       where reachable_session.tenant_id = ${input.tenantParam}
         and reachable_session.user_id = ${input.userParam}
    )
    or exists (
      select 1
        from integration.external_entity_map reachable_binding
       where reachable_binding.tenant_id = ${input.tenantParam}
         and reachable_binding.internal_id = ${input.userParam}
         and reachable_binding.external_system = 'VIVA'
         and reachable_binding.entity_type = 'legacy_viewer_phone'
    )
  )`;
}

export interface ProfileReachabilityRepository {
  /** True when the account behind `userId` can open the cabinet and therefore receive invites. */
  isReachable(tenantId: string, userId: string): Promise<boolean>;
}

interface ReachableRow {
  readonly reachable: boolean;
}

export function createProfileReachabilityRepository(pool: Pool): ProfileReachabilityRepository {
  return {
    isReachable(tenantId, userId) {
      return withTenantTransaction(pool, tenantId, async (client) => {
        const row = await queryOne<ReachableRow & { readonly reachable: boolean }>(
          client,
          `select ${profileReachableSql({ tenantParam: '$1', userParam: '$2' })} as reachable`,
          [tenantId, userId],
        );
        return row?.reachable === true;
      });
    },
  };
}
