import type { Pool, QueryResultRow } from 'pg';

import { queryOne, withTenantTransaction } from './connection.js';

export type ContextProjectionResult = 'projected' | 'replayed' | 'not_ready' | 'dependency_missing';

export interface ContextualMessagingRepository {
  projectGameConversation(input: {
    readonly tenantId: string;
    readonly eventId: string;
    readonly gameId: string;
    readonly correlationId: string;
  }): Promise<ContextProjectionResult>;
}

interface GameContextRow extends QueryResultRow {
  readonly id: string;
  readonly organizer_user_id: string;
  readonly title: string;
  readonly lifecycle_state:
    'DRAFT' | 'PROVISIONING' | 'SCHEDULED' | 'IN_PROGRESS' | 'FINISHED' | 'CANCELLED';
}

interface ConversationIdRow extends QueryResultRow {
  readonly id: string;
}

export function createContextualMessagingRepository(pool: Pool): ContextualMessagingRepository {
  return {
    projectGameConversation(input) {
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
          `${input.tenantId}:GAME:${input.gameId}`,
        ]);

        const replay = await queryOne<{ conversation_id: string | null }>(
          client,
          `select conversation_id
             from messaging.context_projection_events
            where tenant_id = $1 and projector = 'GAME' and event_id = $2`,
          [input.tenantId, input.eventId],
        );
        if (replay) return 'replayed';

        const game = await queryOne<GameContextRow>(
          client,
          `select id, organizer_user_id, title, lifecycle_state
             from games.games
            where tenant_id = $1 and id = $2`,
          [input.tenantId, input.gameId],
        );
        if (!game) return 'dependency_missing';

        const existing = await queryOne<ConversationIdRow>(
          client,
          `select id
             from messaging.conversations
            where tenant_id = $1 and kind = 'GAME' and context_id = $2
            for update`,
          [input.tenantId, input.gameId],
        );

        if (
          !existing &&
          (game.lifecycle_state === 'DRAFT' || game.lifecycle_state === 'PROVISIONING')
        ) {
          await client.query(
            `insert into messaging.context_projection_events (
               tenant_id, projector, event_id, context_id
             ) values ($1, 'GAME', $2, $3)`,
            [input.tenantId, input.eventId, input.gameId],
          );
          return 'not_ready';
        }

        if (!existing && game.lifecycle_state === 'CANCELLED') {
          await client.query(
            `insert into messaging.context_projection_events (
               tenant_id, projector, event_id, context_id
             ) values ($1, 'GAME', $2, $3)`,
            [input.tenantId, input.eventId, input.gameId],
          );
          return 'not_ready';
        }

        let conversationId = existing?.id;
        if (!conversationId) {
          const inserted = await queryOne<ConversationIdRow>(
            client,
            `insert into messaging.conversations (
               tenant_id, kind, context_type, context_id, title, state, created_by_user_id
             ) values ($1, 'GAME', 'GAME', $2, $3, 'OPEN', $4)
             returning id`,
            [input.tenantId, input.gameId, game.title, game.organizer_user_id],
          );
          if (!inserted) throw new Error('GAME_CONVERSATION_INSERT_FAILED');
          conversationId = inserted.id;
        } else {
          await client.query(
            `update messaging.conversations
                set title = $3,
                    state = case when $4 = 'CANCELLED' then 'CLOSED' else 'OPEN' end,
                    updated_at = now()
              where tenant_id = $1 and id = $2`,
            [input.tenantId, conversationId, game.title, game.lifecycle_state],
          );
        }

        if (game.lifecycle_state !== 'CANCELLED') {
          await client.query(
            `insert into messaging.conversation_members (
               tenant_id, conversation_id, member_type, user_id, role
             )
             select $1, $2, 'USER', desired.user_id,
                    case when desired.user_id = $3 then 'OWNER' else 'MEMBER' end
               from (
                 select $3::uuid as user_id
                 union
                 select participation.user_id
                   from games.participations participation
                  where participation.tenant_id = $1
                    and participation.game_id = $4
                    and participation.state = 'ACTIVE'
               ) desired
             on conflict (tenant_id, conversation_id, user_id)
             where user_id is not null
             do update set
               role = excluded.role,
               state = 'ACTIVE',
               left_at = null`,
            [input.tenantId, conversationId, game.organizer_user_id, input.gameId],
          );
          await client.query(
            `update messaging.conversation_members member
                set state = 'REMOVED', left_at = coalesce(member.left_at, now())
              where member.tenant_id = $1
                and member.conversation_id = $2
                and member.member_type = 'USER'
                and member.state = 'ACTIVE'
                and member.user_id <> $3
                and not exists (
                  select 1
                    from games.participations participation
                   where participation.tenant_id = member.tenant_id
                     and participation.game_id = $4
                     and participation.user_id = member.user_id
                     and participation.state = 'ACTIVE'
                )`,
            [input.tenantId, conversationId, game.organizer_user_id, input.gameId],
          );
        } else {
          await client.query(
            `update messaging.conversation_members
                set state = 'REMOVED', left_at = coalesce(left_at, now())
              where tenant_id = $1 and conversation_id = $2 and state = 'ACTIVE'`,
            [input.tenantId, conversationId],
          );
        }

        await client.query(
          `insert into messaging.context_projection_events (
             tenant_id, projector, event_id, context_id, conversation_id
           ) values ($1, 'GAME', $2, $3, $4)`,
          [input.tenantId, input.eventId, input.gameId, conversationId],
        );
        await client.query(
          `insert into audit.outbox_events (
             tenant_id, event_type, aggregate_id, correlation_id, payload
           ) values ($1, 'messaging.context.projected.v1', $2, $3, $4::jsonb)`,
          [
            input.tenantId,
            conversationId,
            input.correlationId,
            JSON.stringify({
              conversationId,
              contextId: input.gameId,
              kind: 'GAME',
            }),
          ],
        );
        await client.query(
          `insert into audit.audit_log (
             tenant_id, action, resource_type, resource_id,
             result, correlation_id, new_value
           ) values ($1, 'GAME_CONVERSATION_PROJECTED', 'CONVERSATION', $2,
                     'SUCCESS', $3, $4::jsonb)`,
          [
            input.tenantId,
            conversationId,
            input.correlationId,
            JSON.stringify({
              contextId: input.gameId,
              kind: 'GAME',
              state: game.lifecycle_state === 'CANCELLED' ? 'CLOSED' : 'OPEN',
            }),
          ],
        );
        return 'projected';
      });
    },
  };
}
