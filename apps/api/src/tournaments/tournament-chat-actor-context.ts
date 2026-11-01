import { withTenantTransaction } from '@phub/database';
import type { Pool } from 'pg';
import { TournamentChatError } from '@phub/domain';
export interface TournamentChatActor {
  readonly tenantId: string;
  readonly tenantKey: string;
  readonly userId: string;
  readonly sessionId: string;
  readonly correlationId: string;
}
export interface TournamentChatIdentity {
  readonly providerClientId: string;
  readonly ownerTenantKey: string;
}
export function createTournamentChatActorReader(
  pool: Pool,
): (actor: TournamentChatActor) => Promise<TournamentChatIdentity> {
  return (actor) =>
    withTenantTransaction(pool, actor.tenantId, async (client) => {
      await client.query('set local statement_timeout = 2000');
      const result = await client.query<{
        external_id: string;
        owner_tenant_key: string;
        forward_count: string;
        reverse_count: string;
      }>(
        `
      select m.external_id, b.provider_tenant_key owner_tenant_key,
        (select count(*) from integration.external_entity_map f where f.tenant_id=u.tenant_id and f.internal_id=u.id and f.external_system='VIVA' and f.entity_type='viva_profile') forward_count,
        (select count(*) from integration.external_entity_map r where r.tenant_id=m.tenant_id and r.external_id=m.external_id and r.external_system='VIVA' and r.entity_type='viva_profile') reverse_count
      from identity.refresh_sessions s
      join identity.users u on u.tenant_id=s.tenant_id and u.id=s.user_id and u.status='ACTIVE'
      join identity.tenants t on t.id=u.tenant_id and t.tenant_key=$4 and t.active=true
      join integration.identity_provider_bindings b on b.tenant_id=u.tenant_id and b.provider='VIVA'
      join integration.external_entity_map m on m.tenant_id=u.tenant_id and m.internal_id=u.id and m.external_system='VIVA' and m.entity_type='viva_profile'
      where s.tenant_id=$1 and s.user_id=$2 and s.id=$3 and s.revoked_at is null and s.rotated_at is null and s.expires_at>now()
        and m.sync_status='synced' and m.sync_error_code is null and m.last_synced_at is not null limit 2`,
        [actor.tenantId, actor.userId, actor.sessionId, actor.tenantKey],
      );
      const row = result.rows.length === 1 ? result.rows[0] : undefined;
      if (
        !row ||
        row.forward_count !== '1' ||
        row.reverse_count !== '1' ||
        !/^[A-Za-z0-9._:-]{1,200}$/.test(row.external_id) ||
        !/^[A-Za-z0-9_-]{1,200}$/.test(row.owner_tenant_key)
      )
        throw new TournamentChatError('TOURNAMENT_CHAT_FORBIDDEN', 403);
      return { providerClientId: row.external_id, ownerTenantKey: row.owner_tenant_key };
    });
}
