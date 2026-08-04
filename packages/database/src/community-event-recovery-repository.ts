import {
  communityRealtimeEventPageSchema,
  type CommunityEventRecoveryRepository,
} from '@phub/communities';
import type { Pool, QueryResultRow } from 'pg';

import { queryOne, withTenantTransaction } from './connection.js';

interface RecoveryRow extends QueryResultRow {
  readonly latest_sequence: number | string;
  readonly retained_from_sequence: number | string;
  readonly community_id: string | null;
  readonly sequence: number | string | null;
  readonly event_type: string | null;
  readonly target_type: 'POST' | 'COMMENT' | 'REACTION' | null;
  readonly target_id: string | null;
  readonly target_revision: number | string | null;
  readonly target_status: string | null;
  readonly occurred_at: Date | string | null;
}

export function createCommunityEventRecoveryRepository(
  pool: Pool,
): CommunityEventRecoveryRepository {
  return {
    listEvents(input) {
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        const actor = await queryOne<{ readonly active: boolean }>(
          client,
          `select true as active
             from identity.users
            where tenant_id = $1 and id = $2 and status = 'ACTIVE'`,
          [input.tenantId, input.viewerUserId],
        );
        if (!actor) return { outcome: 'actor_not_active' as const };

        // Authority, the durable lower bound and the page share one PostgreSQL statement snapshot.
        // A concurrent purge therefore yields either the complete pre-purge page or the new gap,
        // never a successful page with rows deleted between two reads.
        const result = await client.query<RecoveryRow>(
          `with authority as materialized (
             select community.tenant_id, community.id as community_id,
                    coalesce(head.last_sequence, 0) as latest_sequence,
                    coalesce(head.retained_from_sequence, 1) as retained_from_sequence
               from communities.communities community
               join communities.memberships membership
                 on membership.tenant_id = community.tenant_id
                and membership.community_id = community.id
                and membership.user_id = $2
                and membership.status = 'ACTIVE'
               left join community_content.event_heads head
                 on head.tenant_id = community.tenant_id
                and head.community_id = community.id
              where community.tenant_id = $1
                and community.id = $3
                and community.status = 'ACTIVE'
           )
           select authority.latest_sequence, authority.retained_from_sequence,
                  event.community_id, event.sequence, event.event_type, event.target_type,
                  event.target_id, event.target_revision, event.target_status, event.occurred_at
             from authority
             left join lateral (
               select stored.community_id, stored.sequence, stored.event_type,
                      stored.target_type, stored.target_id, stored.target_revision,
                      stored.target_status, stored.occurred_at
                 from community_content.events stored
                where stored.tenant_id = authority.tenant_id
                  and stored.community_id = authority.community_id
                  and stored.sequence > $4
                  and stored.sequence <= authority.latest_sequence
                  and $4 <= authority.latest_sequence
                  and $4 >= authority.retained_from_sequence - 1
                order by stored.sequence
                limit $5
             ) event on true`,
          [
            input.tenantId,
            input.viewerUserId,
            input.communityId,
            input.afterSequence,
            input.limit + 1,
          ],
        );
        const authority = result.rows[0];
        if (!authority) return { outcome: 'community_not_found' as const };

        const latestSequence = Number(authority.latest_sequence);
        const retainedFromSequence = Number(authority.retained_from_sequence);
        if (
          !Number.isSafeInteger(latestSequence) ||
          !Number.isSafeInteger(retainedFromSequence) ||
          latestSequence < 0 ||
          retainedFromSequence < 1
        ) {
          throw new Error('COMMUNITY_EVENT_HEAD_INVALID');
        }
        if (input.afterSequence > latestSequence) {
          return { outcome: 'cursor_ahead' as const, latestSequence };
        }
        if (latestSequence > 0 && input.afterSequence < retainedFromSequence - 1) {
          return {
            outcome: 'gap_expired' as const,
            latestSequence,
            retainedFromSequence,
          };
        }

        const eventRows = result.rows.filter(
          (
            row,
          ): row is RecoveryRow & {
            community_id: string;
            sequence: number | string;
            event_type: string;
            target_type: 'POST' | 'COMMENT' | 'REACTION';
            target_id: string;
            target_revision: number | string;
            occurred_at: Date | string;
          } => row.sequence !== null,
        );
        const hasMore = eventRows.length > input.limit;
        const items = eventRows.slice(0, input.limit).map((row) => ({
          communityId: row.community_id,
          sequence: Number(row.sequence),
          eventType: row.event_type,
          targetType: row.target_type,
          targetId: row.target_id,
          targetRevision: Number(row.target_revision),
          targetStatus: row.target_status,
          occurredAt: new Date(row.occurred_at).toISOString(),
        }));
        const last = items.at(-1);
        return {
          outcome: 'found' as const,
          page: communityRealtimeEventPageSchema.parse({
            items,
            afterSequence: input.afterSequence,
            latestSequence,
            retainedFromSequence,
            ...(last ? { nextAfterSequence: last.sequence } : {}),
            hasMore,
          }),
        };
      });
    },
  };
}
