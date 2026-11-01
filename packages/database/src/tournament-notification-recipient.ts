import type { Pool } from 'pg';
import { createHash } from 'node:crypto';
import { withTenantTransaction } from './connection.js';
import {
  decodeTournamentLocalAttempt,
  type TournamentLocalAttemptRow,
} from './tournament-local-repository.js';
export type TournamentNotificationWitness =
  | { kind: 'PARTICIPANT'; generation: string; actorHash: string }
  | { kind: 'ORGANIZER'; revision: number; selectedUserId: string };
export interface TournamentNotificationIdentity {
  userId: string;
  ownerTenantKey: string;
  providerClientId: string;
  providerMappingId: string;
  observedAt: number;
}
export interface TournamentNotificationScope {
  tenantId: string;
  tenantKey: string;
  ownerTenantKey: string;
}
const uuid = (v: unknown): v is string =>
  typeof v === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v);
const denied = () => new Error('TOURNAMENT_NOTIFICATION_IDENTITY_UNAVAILABLE');
/** No session fabrication. Current CUP REGISTERED witness remains necessary; this resolves only identity. */
export function createTournamentNotificationRecipientResolver(
  pool: Pool,
  scope: TournamentNotificationScope,
) {
  if (
    !uuid(scope.tenantId) ||
    !/^[a-z0-9][a-z0-9_-]{0,62}$/.test(scope.tenantKey) ||
    !/^[A-Za-z0-9_-]{1,200}$/.test(scope.ownerTenantKey)
  )
    throw denied();
  return (
    tournamentId: string,
    witness: TournamentNotificationWitness,
  ): Promise<TournamentNotificationIdentity> =>
    withTenantTransaction(pool, scope.tenantId, async (client) => {
      const observedAt = Date.now();
      if (!uuid(tournamentId)) throw denied();
      await client.query('set local statement_timeout = 2000');
      let userId: string;
      let original: Awaited<ReturnType<typeof decodeTournamentLocalAttempt>> | undefined;
      if (witness.kind === 'PARTICIPANT') {
        if (!uuid(witness.generation) || !/^[a-f0-9]{64}$/.test(witness.actorHash)) throw denied();
        const rows = await client.query<TournamentLocalAttemptRow>(
          'select * from booking.tournament_local_attempts where tenant_id=$1 and tournament_id=$2 and owner_operation_id=$3 limit 2',
          [scope.tenantId, tournamentId, witness.generation],
        );
        const row = rows.rows.length === 1 ? rows.rows[0] : undefined;
        if (!row || !uuid(row.actor_user_id)) throw denied();
        original = await decodeTournamentLocalAttempt(row);
        if (
          original.command.action !== 'JOIN' ||
          original.originalJoinId !== null ||
          original.ownerOperationId !== witness.generation ||
          !['DISPATCHED', 'COMPLETED'].includes(original.state) ||
          (original.state === 'COMPLETED' &&
            original.receipt?.operation.outcome !== 'REGISTERED') ||
          original.identity.providerTenantKey !== scope.ownerTenantKey
        )
          throw denied();
        const actorHash = createHash('sha256')
          .update(
            'tournament-local-actor:v1\0' +
              JSON.stringify([scope.ownerTenantKey, original.identity.providerClientId]),
          )
          .digest('hex');
        if (actorHash !== witness.actorHash) throw denied();
        userId = row.actor_user_id;
      } else {
        if (
          witness.kind !== 'ORGANIZER' ||
          !uuid(witness.selectedUserId) ||
          !Number.isSafeInteger(witness.revision) ||
          witness.revision < 1
        )
          throw denied();
        userId = witness.selectedUserId;
      }
      const rows = await client.query<{
        id: string;
        external_id: string;
        owner_tenant_key: string;
        forward_count: string;
        reverse_count: string;
      }>(
        `
      select m.id,m.external_id,b.provider_tenant_key owner_tenant_key,
        (select count(*) from integration.external_entity_map f where f.tenant_id=u.tenant_id and f.internal_id=u.id and f.external_system='VIVA' and f.entity_type='viva_profile') forward_count,
        (select count(*) from integration.external_entity_map r where r.tenant_id=m.tenant_id and r.external_id=m.external_id and r.external_system='VIVA' and r.entity_type='viva_profile') reverse_count
      from identity.users u join identity.tenants t on t.id=u.tenant_id and t.tenant_key=$3 and t.active=true
      join integration.identity_provider_bindings b on b.tenant_id=u.tenant_id and b.provider='VIVA' and b.provider_tenant_key=$4
      join integration.external_entity_map m on m.tenant_id=u.tenant_id and m.internal_id=u.id and m.external_system='VIVA' and m.entity_type='viva_profile'
      where u.tenant_id=$1 and u.id=$2 and u.status='ACTIVE' and m.sync_status='synced' and m.sync_error_code is null and m.last_synced_at is not null limit 2`,
        [scope.tenantId, userId, scope.tenantKey, scope.ownerTenantKey],
      );
      const m = rows.rows.length === 1 ? rows.rows[0] : undefined;
      if (
        !m ||
        !uuid(m.id) ||
        m.forward_count !== '1' ||
        m.reverse_count !== '1' ||
        m.owner_tenant_key !== scope.ownerTenantKey ||
        !/^[A-Za-z0-9._:-]{1,200}$/.test(m.external_id) ||
        (original &&
          (m.id !== original.identity.providerMappingId ||
            m.external_id !== original.identity.providerClientId)) ||
        Date.now() - observedAt >= 5000
      )
        throw denied();
      return {
        userId,
        ownerTenantKey: scope.ownerTenantKey,
        providerClientId: m.external_id,
        providerMappingId: m.id,
        observedAt,
      };
    });
}
