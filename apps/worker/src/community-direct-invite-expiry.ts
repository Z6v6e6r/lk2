import { randomUUID } from 'node:crypto';

import { withTenantTransaction } from '@phub/database';
import type { Logger } from 'pino';
import type { Pool, QueryResultRow } from 'pg';

interface ExpiredInviteRow extends QueryResultRow {
  readonly id: string;
  readonly community_id: string;
  readonly revision: number | string;
  readonly expires_at: Date | string;
  readonly updated_at: Date | string;
}

export async function expireCommunityDirectInviteBatch(input: {
  readonly pool: Pool;
  readonly logger: Logger;
  readonly tenantId: string;
  readonly batchSize: number;
}): Promise<number> {
  if (!Number.isInteger(input.batchSize) || input.batchSize < 1 || input.batchSize > 500) {
    throw new Error('COMMUNITY_DIRECT_INVITE_EXPIRY_BATCH_INVALID');
  }
  return withTenantTransaction(input.pool, input.tenantId, async (client) => {
    await client.query("set local lock_timeout = '2s'");
    await client.query("set local statement_timeout = '10s'");
    const result = await client.query<ExpiredInviteRow>(
      `with due as (
         select id
           from communities.direct_invites
          where tenant_id = $1 and state = 'ACTIVE' and expires_at <= now()
          order by expires_at, id
          limit $2
          for update skip locked
       )
       update communities.direct_invites invite
          set state = 'EXPIRED', revision = invite.revision + 1, updated_at = now()
         from due
        where invite.tenant_id = $1 and invite.id = due.id
       returning invite.id, invite.community_id, invite.revision,
                 invite.expires_at, invite.updated_at`,
      [input.tenantId, input.batchSize],
    );

    for (const invite of result.rows) {
      const correlationId = `community-invite-expiry:${randomUUID()}`;
      const expiresAt = new Date(invite.expires_at).toISOString();
      const expiredAt = new Date(invite.updated_at).toISOString();
      await client.query(
        `insert into audit.audit_log (
           tenant_id, actor_id, action, resource_type, resource_id,
           result, correlation_id, old_value, new_value
         ) values ($1, null, 'COMMUNITY_DIRECT_INVITE_EXPIRED',
                   'COMMUNITY_DIRECT_INVITE', $2, 'SUCCESS', $3,
                   jsonb_build_object('state', 'ACTIVE'),
                   jsonb_build_object('state', 'EXPIRED', 'revision', $4::bigint))`,
        [input.tenantId, invite.id, correlationId, invite.revision],
      );
      await client.query(
        `insert into audit.outbox_events (
           tenant_id, event_type, aggregate_id, correlation_id, payload
         ) values ($1, 'community.direct_invite.expired.v1', $2, $3, $4::jsonb)`,
        [
          input.tenantId,
          invite.community_id,
          correlationId,
          JSON.stringify({
            inviteId: invite.id,
            communityId: invite.community_id,
            inviteRevision: Number(invite.revision),
            expiresAt,
            expiredAt,
          }),
        ],
      );
    }

    if (result.rowCount) {
      input.logger.info(
        { tenantId: input.tenantId, count: result.rowCount },
        'community direct invites expired',
      );
    }
    return result.rowCount ?? 0;
  });
}
