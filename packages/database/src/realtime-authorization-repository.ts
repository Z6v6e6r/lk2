import type { Pool } from 'pg';

import { queryOne, withTenantTransaction } from './connection.js';

export type CommunityRealtimeConnectionAuthorization =
  { readonly outcome: 'ok' } | { readonly outcome: 'revoked' };

export type CommunityRealtimeSubscriptionAuthorization =
  | {
      readonly outcome: 'ok';
      readonly communityRevision: number;
      readonly membershipRevision: number;
      readonly latestSequence: number;
    }
  | { readonly outcome: 'disabled' | 'not_found' };

export interface RealtimeAuthorizationRepository {
  authorizeConnection(input: {
    readonly tenantId: string;
    readonly userId: string;
    readonly sessionId: string;
  }): Promise<CommunityRealtimeConnectionAuthorization>;
  authorizeCommunitySubscription(input: {
    readonly tenantId: string;
    readonly userId: string;
    readonly communityId: string;
    readonly enabled: boolean;
  }): Promise<CommunityRealtimeSubscriptionAuthorization>;
  authorizeCommunityFanoutRecipients(input: {
    readonly tenantId: string;
    readonly communityId: string;
    readonly recipients: readonly {
      readonly userId: string;
      readonly sessionId: string;
    }[];
  }): Promise<ReadonlySet<string>>;
  recordTicketIssued(input: {
    readonly tenantId: string;
    readonly userId: string;
    readonly ticketId: string;
    readonly expiresAt: string;
    readonly correlationId: string;
  }): Promise<void>;
}

interface CommunityAuthorityRow {
  readonly community_revision: number | string;
  readonly membership_revision: number | string;
  readonly latest_sequence: number | string;
}

interface AuthorizedSessionRow {
  readonly session_id: string;
}

export function createRealtimeAuthorizationRepository(pool: Pool): RealtimeAuthorizationRepository {
  return {
    authorizeConnection(input) {
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        const authorized = await queryOne<{ authorized: boolean }>(
          client,
          `select true as authorized
             from identity.refresh_sessions presented
             join identity.users active_user
               on active_user.tenant_id = presented.tenant_id
              and active_user.id = presented.user_id
              and active_user.status = 'ACTIVE'
            where presented.tenant_id = $1
              and presented.id = $2
              and presented.user_id = $3
              and exists (
                select 1
                  from identity.refresh_sessions active_session
                 where active_session.tenant_id = presented.tenant_id
                   and active_session.family_id = presented.family_id
                   and active_session.revoked_at is null
                   and active_session.rotated_at is null
                   and active_session.expires_at > now()
              )`,
          [input.tenantId, input.sessionId, input.userId],
        );
        return authorized ? { outcome: 'ok' } : { outcome: 'revoked' };
      });
    },

    authorizeCommunitySubscription(input) {
      if (!input.enabled) return Promise.resolve({ outcome: 'disabled' });
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        const row = await queryOne<CommunityAuthorityRow>(
          client,
          `select community.revision as community_revision,
                  membership.revision as membership_revision,
                  coalesce(event_head.last_sequence, 0) as latest_sequence
             from communities.communities community
             join communities.memberships membership
               on membership.tenant_id = community.tenant_id
              and membership.community_id = community.id
              and membership.user_id = $2
              and membership.status = 'ACTIVE'
             join identity.users active_user
               on active_user.tenant_id = membership.tenant_id
              and active_user.id = membership.user_id
              and active_user.status = 'ACTIVE'
             left join community_content.event_heads event_head
               on event_head.tenant_id = community.tenant_id
              and event_head.community_id = community.id
            where community.tenant_id = $1
              and community.id = $3
              and community.status = 'ACTIVE'`,
          [input.tenantId, input.userId, input.communityId],
        );
        return row
          ? {
              outcome: 'ok',
              communityRevision: Number(row.community_revision),
              membershipRevision: Number(row.membership_revision),
              latestSequence: Number(row.latest_sequence),
            }
          : { outcome: 'not_found' };
      });
    },

    authorizeCommunityFanoutRecipients(input) {
      if (input.recipients.length === 0) return Promise.resolve(new Set<string>());
      const userIds = input.recipients.map((recipient) => recipient.userId);
      const sessionIds = input.recipients.map((recipient) => recipient.sessionId);
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        const result = await client.query<AuthorizedSessionRow>(
          `with requested as (
             select * from unnest($3::uuid[], $4::uuid[]) as item(user_id, session_id)
           )
           select requested.session_id
             from requested
             join communities.communities community
               on community.tenant_id = $1
              and community.id = $2
              and community.status = 'ACTIVE'
             join communities.memberships membership
               on membership.tenant_id = community.tenant_id
              and membership.community_id = community.id
              and membership.user_id = requested.user_id
              and membership.status = 'ACTIVE'
             join identity.users active_user
               on active_user.tenant_id = membership.tenant_id
              and active_user.id = membership.user_id
              and active_user.status = 'ACTIVE'
             join identity.refresh_sessions presented
               on presented.tenant_id = active_user.tenant_id
              and presented.user_id = active_user.id
              and presented.id = requested.session_id
            where exists (
              select 1
                from identity.refresh_sessions active_session
               where active_session.tenant_id = presented.tenant_id
                 and active_session.family_id = presented.family_id
                 and active_session.revoked_at is null
                 and active_session.rotated_at is null
                 and active_session.expires_at > now()
            )`,
          [input.tenantId, input.communityId, userIds, sessionIds],
        );
        return new Set(result.rows.map((row) => row.session_id));
      });
    },

    recordTicketIssued(input) {
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        await client.query(
          `insert into audit.audit_log (
             tenant_id, actor_id, action, resource_type, resource_id,
             result, correlation_id, new_value
           ) values ($1, $2, 'REALTIME_TICKET_ISSUED', 'REALTIME_TICKET', $3,
                     'SUCCESS', $4, $5::jsonb)`,
          [
            input.tenantId,
            input.userId,
            input.ticketId,
            input.correlationId,
            JSON.stringify({ expiresAt: input.expiresAt }),
          ],
        );
      });
    },
  };
}
