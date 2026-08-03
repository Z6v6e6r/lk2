import type { Pool, PoolClient, QueryResultRow } from 'pg';

import { queryOne, withTenantTransaction } from './connection.js';

export interface MessagingRuntimeSettings {
  readonly httpEnabled: boolean;
  readonly directEnabled: boolean;
  readonly realtimeEnabled: boolean;
  readonly contextualEnabled: boolean;
}

export interface MessagingParticipant {
  readonly userId: string;
  readonly displayName: string;
}

export interface ConversationSummary {
  readonly id: string;
  readonly kind: 'DIRECT';
  readonly participant: MessagingParticipant;
  readonly unreadCount: number;
  readonly updatedAt: string;
  readonly lastMessage?: {
    readonly sequence: number;
    readonly body: string;
    readonly createdAt: string;
  };
}

export interface ConversationMessage {
  readonly id: string;
  readonly conversationId: string;
  readonly sequence: number;
  readonly sender: MessagingParticipant;
  readonly messageType: 'TEXT';
  readonly body: string;
  readonly createdAt: string;
}

export interface ConversationMessagePage {
  readonly messages: readonly ConversationMessage[];
  readonly nextAfterSequence?: number;
}

export type CreateDirectConversationResult =
  | { readonly outcome: 'target_not_found' }
  | { readonly outcome: 'idempotency_conflict' }
  | {
      readonly outcome: 'ok';
      readonly conversation: ConversationSummary;
      readonly created: boolean;
      readonly replayed: boolean;
    };

export type ListConversationMessagesResult =
  | { readonly outcome: 'not_found' }
  | {
      readonly outcome: 'ok';
      readonly page: ConversationMessagePage;
    };

export type SendConversationMessageResult =
  | { readonly outcome: 'not_found' }
  | { readonly outcome: 'idempotency_conflict' }
  | {
      readonly outcome: 'ok';
      readonly message: ConversationMessage;
      readonly replayed: boolean;
    };

export type MarkConversationReadResult =
  | { readonly outcome: 'not_found' }
  | { readonly outcome: 'sequence_invalid' }
  | { readonly outcome: 'idempotency_conflict' }
  | {
      readonly outcome: 'ok';
      readonly readThroughSequence: number;
      readonly changed: boolean;
      readonly replayed: boolean;
    };

export interface MessagingRepository {
  getRuntimeSettings(tenantId: string): Promise<MessagingRuntimeSettings>;
  listConversations(input: {
    readonly tenantId: string;
    readonly userId: string;
    readonly limit: number;
  }): Promise<readonly ConversationSummary[]>;
  createDirectConversation(input: {
    readonly tenantId: string;
    readonly actorUserId: string;
    readonly otherUserId: string;
    readonly idempotencyKey: string;
    readonly correlationId: string;
  }): Promise<CreateDirectConversationResult>;
  listMessages(input: {
    readonly tenantId: string;
    readonly userId: string;
    readonly conversationId: string;
    readonly afterSequence: number;
    readonly limit: number;
  }): Promise<ListConversationMessagesResult>;
  sendMessage(input: {
    readonly tenantId: string;
    readonly userId: string;
    readonly conversationId: string;
    readonly clientMessageId: string;
    readonly idempotencyKey: string;
    readonly body: string;
    readonly correlationId: string;
  }): Promise<SendConversationMessageResult>;
  markRead(input: {
    readonly tenantId: string;
    readonly userId: string;
    readonly conversationId: string;
    readonly throughSequence: number;
    readonly idempotencyKey: string;
    readonly correlationId: string;
  }): Promise<MarkConversationReadResult>;
}

interface RuntimeRow extends QueryResultRow {
  readonly http_enabled: boolean;
  readonly direct_enabled: boolean;
  readonly realtime_enabled: boolean;
  readonly contextual_enabled: boolean;
}

interface ConversationRow extends QueryResultRow {
  readonly id: string;
  readonly kind: 'DIRECT';
  readonly other_user_id: string;
  readonly other_display_name: string;
  readonly unread_count: number | string;
  readonly updated_at: Date | string;
  readonly last_sequence: number | string | null;
  readonly last_body: string | null;
  readonly last_created_at: Date | string | null;
}

interface MessageRow extends QueryResultRow {
  readonly id: string;
  readonly conversation_id: string;
  readonly sequence: number | string;
  readonly sender_user_id: string;
  readonly sender_display_name: string;
  readonly message_type: 'TEXT';
  readonly body: string;
  readonly created_at: Date | string;
  readonly client_message_id?: string;
  readonly idempotency_key?: string;
}

interface DirectCommandRow extends QueryResultRow {
  readonly other_user_id: string;
  readonly conversation_id: string;
}

interface MemberRow extends QueryResultRow {
  readonly member_id: string;
  readonly last_read_sequence: number | string;
  readonly last_sequence: number | string;
}

interface ReadCommandRow extends QueryResultRow {
  readonly through_sequence: number | string;
  readonly result_sequence: number | string;
  readonly changed: boolean;
}

function timestamp(value: Date | string): string {
  if (value instanceof Date) return value.toISOString();
  const normalized = value.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00');
  if (!Number.isFinite(Date.parse(normalized))) throw new Error('MESSAGING_TIMESTAMP_INVALID');
  return normalized;
}

function sequence(value: number | string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error('MESSAGING_SEQUENCE_INVALID');
  return parsed;
}

function mapConversation(row: ConversationRow): ConversationSummary {
  return {
    id: row.id,
    kind: row.kind,
    participant: {
      userId: row.other_user_id,
      displayName: row.other_display_name,
    },
    unreadCount: sequence(row.unread_count),
    updatedAt: timestamp(row.updated_at),
    ...(row.last_sequence !== null && row.last_body !== null && row.last_created_at !== null
      ? {
          lastMessage: {
            sequence: sequence(row.last_sequence),
            body: row.last_body,
            createdAt: timestamp(row.last_created_at),
          },
        }
      : {}),
  };
}

function mapMessage(row: MessageRow): ConversationMessage {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    sequence: sequence(row.sequence),
    sender: {
      userId: row.sender_user_id,
      displayName: row.sender_display_name,
    },
    messageType: row.message_type,
    body: row.body,
    createdAt: timestamp(row.created_at),
  };
}

const CONVERSATION_SELECT = `
  select conversation.id,
         conversation.kind,
         other_member.user_id as other_user_id,
         coalesce(other_summary.display_name, 'Участник') as other_display_name,
         greatest(
           (conversation.next_sequence - 1) - current_member.last_read_sequence,
           0
         ) as unread_count,
         conversation.updated_at::text as updated_at,
         last_message.sequence as last_sequence,
         last_message.body as last_body,
         last_message.created_at::text as last_created_at
    from messaging.conversations conversation
    join messaging.conversation_members current_member
      on current_member.tenant_id = conversation.tenant_id
     and current_member.conversation_id = conversation.id
     and current_member.user_id = $2
     and current_member.state = 'ACTIVE'
    join identity.users current_user
      on current_user.tenant_id = current_member.tenant_id
     and current_user.id = current_member.user_id
     and current_user.status = 'ACTIVE'
    join messaging.conversation_members other_member
      on other_member.tenant_id = conversation.tenant_id
     and other_member.conversation_id = conversation.id
     and other_member.user_id is not null
     and other_member.user_id <> $2
     and other_member.state = 'ACTIVE'
    left join profile.user_summaries other_summary
      on other_summary.tenant_id = other_member.tenant_id
     and other_summary.user_id = other_member.user_id
    left join lateral (
      select message.sequence, message.body, message.created_at
        from messaging.messages message
       where message.tenant_id = conversation.tenant_id
         and message.conversation_id = conversation.id
         and message.deleted_at is null
       order by message.sequence desc
       limit 1
    ) last_message on true
   where conversation.tenant_id = $1
     and conversation.kind = 'DIRECT'
     and conversation.state = 'OPEN'`;

async function getConversation(
  client: PoolClient,
  tenantId: string,
  userId: string,
  conversationId: string,
): Promise<ConversationSummary | undefined> {
  const row = await queryOne<ConversationRow>(
    client,
    `${CONVERSATION_SELECT}
       and conversation.id = $3`,
    [tenantId, userId, conversationId],
  );
  return row ? mapConversation(row) : undefined;
}

async function getMessage(
  client: PoolClient,
  tenantId: string,
  userId: string,
  conversationId: string,
  messageId: string,
): Promise<MessageRow | undefined> {
  return queryOne<MessageRow>(
    client,
    `select message.id, message.conversation_id, message.sequence,
            sender.user_id as sender_user_id,
            coalesce(summary.display_name, 'Участник') as sender_display_name,
            message.message_type, message.body, message.created_at::text as created_at,
            message.client_message_id, message.idempotency_key
       from messaging.messages message
       join messaging.conversation_members viewer
         on viewer.tenant_id = message.tenant_id
        and viewer.conversation_id = message.conversation_id
        and viewer.user_id = $2
        and viewer.state = 'ACTIVE'
       join identity.users viewer_user
         on viewer_user.tenant_id = viewer.tenant_id
        and viewer_user.id = viewer.user_id
        and viewer_user.status = 'ACTIVE'
       join messaging.conversation_members sender
         on sender.tenant_id = message.tenant_id
        and sender.conversation_id = message.conversation_id
        and sender.id = message.sender_member_id
       left join profile.user_summaries summary
         on summary.tenant_id = sender.tenant_id
        and summary.user_id = sender.user_id
      where message.tenant_id = $1
        and message.conversation_id = $3
        and message.id = $4
        and message.deleted_at is null`,
    [tenantId, userId, conversationId, messageId],
  );
}

export function createMessagingRepository(pool: Pool): MessagingRepository {
  return {
    getRuntimeSettings(tenantId) {
      return withTenantTransaction(pool, tenantId, async (client) => {
        const row = await queryOne<RuntimeRow>(
          client,
          `select http_enabled, direct_enabled, realtime_enabled, contextual_enabled
             from messaging.tenant_runtime_settings
            where tenant_id = $1`,
          [tenantId],
        );
        return {
          httpEnabled: row?.http_enabled ?? false,
          directEnabled: row?.direct_enabled ?? false,
          realtimeEnabled: row?.realtime_enabled ?? false,
          contextualEnabled: row?.contextual_enabled ?? false,
        };
      });
    },

    listConversations(input) {
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        const result = await client.query<ConversationRow>(
          `${CONVERSATION_SELECT}
            order by conversation.updated_at desc, conversation.id desc
            limit $3`,
          [input.tenantId, input.userId, input.limit],
        );
        return result.rows.map(mapConversation);
      });
    },

    createDirectConversation(input) {
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
          `${input.tenantId}:${input.actorUserId}:${input.idempotencyKey}`,
        ]);
        const previous = await queryOne<DirectCommandRow>(
          client,
          `select other_user_id, conversation_id
             from messaging.direct_conversation_commands
            where tenant_id = $1 and actor_user_id = $2 and idempotency_key = $3`,
          [input.tenantId, input.actorUserId, input.idempotencyKey],
        );
        if (previous) {
          if (previous.other_user_id !== input.otherUserId) {
            return { outcome: 'idempotency_conflict' };
          }
          const conversation = await getConversation(
            client,
            input.tenantId,
            input.actorUserId,
            previous.conversation_id,
          );
          if (!conversation) throw new Error('MESSAGING_REPLAY_CONVERSATION_MISSING');
          return { outcome: 'ok', conversation, created: false, replayed: true };
        }

        const activeUsers = await client.query<{ id: string; chat_policy: string }>(
          `select user_account.id,
                  coalesce(privacy.chat_policy, 'AUTHORIZED') as chat_policy
             from identity.users user_account
             left join profile.privacy_settings privacy
               on privacy.tenant_id = user_account.tenant_id
              and privacy.user_id = user_account.id
            where user_account.tenant_id = $1
              and user_account.id = any($2::uuid[])
              and user_account.status = 'ACTIVE'`,
          [input.tenantId, [input.actorUserId, input.otherUserId]],
        );
        if (activeUsers.rows.length !== 2) return { outcome: 'target_not_found' };
        const target = activeUsers.rows.find((user) => user.id === input.otherUserId);
        if (!target || target.chat_policy !== 'AUTHORIZED') {
          return { outcome: 'target_not_found' };
        }

        const [leftUserId, rightUserId] = [input.actorUserId, input.otherUserId].sort();
        await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
          `${input.tenantId}:${leftUserId}:${rightUserId}`,
        ]);
        const existing = await queryOne<{ conversation_id: string }>(
          client,
          `select conversation_id
             from messaging.direct_conversations
            where tenant_id = $1 and left_user_id = $2 and right_user_id = $3`,
          [input.tenantId, leftUserId, rightUserId],
        );
        let conversationId = existing?.conversation_id;
        const created = !conversationId;
        if (!conversationId) {
          const inserted = await queryOne<{ id: string }>(
            client,
            `insert into messaging.conversations (
               tenant_id, kind, created_by_user_id
             ) values ($1, 'DIRECT', $2)
             returning id`,
            [input.tenantId, input.actorUserId],
          );
          if (!inserted) throw new Error('MESSAGING_CONVERSATION_INSERT_FAILED');
          conversationId = inserted.id;
          await client.query(
            `insert into messaging.direct_conversations (
               tenant_id, conversation_id, left_user_id, right_user_id
             ) values ($1, $2, $3, $4)`,
            [input.tenantId, conversationId, leftUserId, rightUserId],
          );
          await client.query(
            `insert into messaging.conversation_members (
               tenant_id, conversation_id, member_type, user_id
             ) values ($1, $2, 'USER', $3), ($1, $2, 'USER', $4)`,
            [input.tenantId, conversationId, leftUserId, rightUserId],
          );
          await client.query(
            `insert into audit.outbox_events (
               tenant_id, event_type, aggregate_id, correlation_id, payload
             ) values ($1, 'messaging.conversation.created.v1', $2, $3, $4::jsonb)`,
            [
              input.tenantId,
              conversationId,
              input.correlationId,
              JSON.stringify({ conversationId, kind: 'DIRECT' }),
            ],
          );
          await client.query(
            `insert into audit.audit_log (
               tenant_id, actor_id, action, resource_type, resource_id,
               result, correlation_id, new_value
             ) values ($1, $2, 'DIRECT_CONVERSATION_CREATED', 'CONVERSATION', $3,
                       'SUCCESS', $4, $5::jsonb)`,
            [
              input.tenantId,
              input.actorUserId,
              conversationId,
              input.correlationId,
              JSON.stringify({ kind: 'DIRECT' }),
            ],
          );
        }
        await client.query(
          `insert into messaging.direct_conversation_commands (
             tenant_id, actor_user_id, idempotency_key, other_user_id, conversation_id
           ) values ($1, $2, $3, $4, $5)`,
          [
            input.tenantId,
            input.actorUserId,
            input.idempotencyKey,
            input.otherUserId,
            conversationId,
          ],
        );
        const conversation = await getConversation(
          client,
          input.tenantId,
          input.actorUserId,
          conversationId,
        );
        if (!conversation) throw new Error('MESSAGING_CONVERSATION_READBACK_FAILED');
        return { outcome: 'ok', conversation, created, replayed: false };
      });
    },

    listMessages(input) {
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        const member = await queryOne<{ id: string }>(
          client,
          `select member.id
             from messaging.conversation_members member
             join messaging.conversations conversation
              on conversation.tenant_id = member.tenant_id
              and conversation.id = member.conversation_id
             join identity.users viewer_user
               on viewer_user.tenant_id = member.tenant_id
              and viewer_user.id = member.user_id
              and viewer_user.status = 'ACTIVE'
            where member.tenant_id = $1
              and member.conversation_id = $2
              and member.user_id = $3
              and member.state = 'ACTIVE'
              and conversation.state = 'OPEN'
              and conversation.kind = 'DIRECT'`,
          [input.tenantId, input.conversationId, input.userId],
        );
        if (!member) return { outcome: 'not_found' };
        const result = await client.query<MessageRow>(
          `select message.id, message.conversation_id, message.sequence,
                  sender.user_id as sender_user_id,
                  coalesce(summary.display_name, 'Участник') as sender_display_name,
                  message.message_type, message.body, message.created_at::text as created_at
             from messaging.messages message
             join messaging.conversation_members sender
               on sender.tenant_id = message.tenant_id
              and sender.conversation_id = message.conversation_id
              and sender.id = message.sender_member_id
             left join profile.user_summaries summary
               on summary.tenant_id = sender.tenant_id
              and summary.user_id = sender.user_id
            where message.tenant_id = $1
              and message.conversation_id = $2
              and message.sequence > $3
              and message.deleted_at is null
            order by message.sequence asc
            limit $4`,
          [input.tenantId, input.conversationId, input.afterSequence, input.limit + 1],
        );
        const hasMore = result.rows.length > input.limit;
        const visible = hasMore ? result.rows.slice(0, input.limit) : result.rows;
        const last = visible.at(-1);
        return {
          outcome: 'ok',
          page: {
            messages: visible.map(mapMessage),
            ...(hasMore && last ? { nextAfterSequence: sequence(last.sequence) } : {}),
          },
        };
      });
    },

    sendMessage(input) {
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        const member = await queryOne<MemberRow>(
          client,
          `select member.id as member_id,
                  member.last_read_sequence,
                  conversation.next_sequence - 1 as last_sequence
             from messaging.conversation_members member
             join messaging.conversations conversation
              on conversation.tenant_id = member.tenant_id
              and conversation.id = member.conversation_id
             join identity.users current_user
               on current_user.tenant_id = member.tenant_id
              and current_user.id = member.user_id
              and current_user.status = 'ACTIVE'
            where member.tenant_id = $1
              and member.conversation_id = $2
              and member.user_id = $3
              and member.state = 'ACTIVE'
              and conversation.state = 'OPEN'
              and conversation.kind = 'DIRECT'`,
          [input.tenantId, input.conversationId, input.userId],
        );
        if (!member) return { outcome: 'not_found' };

        const locked = await queryOne<{ next_sequence: number | string }>(
          client,
          `select next_sequence
             from messaging.conversations
            where tenant_id = $1 and id = $2 and state = 'OPEN' and kind = 'DIRECT'
            for update`,
          [input.tenantId, input.conversationId],
        );
        if (!locked) return { outcome: 'not_found' };

        const previous = await queryOne<MessageRow>(
          client,
          `select message.id, message.conversation_id, message.sequence,
                  sender.user_id as sender_user_id,
                  coalesce(summary.display_name, 'Участник') as sender_display_name,
                  message.message_type, message.body, message.created_at::text as created_at,
                  message.client_message_id, message.idempotency_key
             from messaging.messages message
             join messaging.conversation_members sender
               on sender.tenant_id = message.tenant_id
              and sender.conversation_id = message.conversation_id
              and sender.id = message.sender_member_id
             left join profile.user_summaries summary
               on summary.tenant_id = sender.tenant_id
              and summary.user_id = sender.user_id
            where message.tenant_id = $1
              and message.conversation_id = $2
              and (message.idempotency_key = $3 or message.client_message_id = $4)`,
          [input.tenantId, input.conversationId, input.idempotencyKey, input.clientMessageId],
        );
        if (previous) {
          if (
            previous.sender_user_id !== input.userId ||
            previous.idempotency_key !== input.idempotencyKey ||
            previous.client_message_id !== input.clientMessageId ||
            previous.body !== input.body
          ) {
            return { outcome: 'idempotency_conflict' };
          }
          return { outcome: 'ok', message: mapMessage(previous), replayed: true };
        }

        const allocatedSequence = sequence(locked.next_sequence);
        const inserted = await queryOne<{ id: string }>(
          client,
          `insert into messaging.messages (
             tenant_id, conversation_id, sequence, sender_member_id,
             client_message_id, idempotency_key, message_type, body
           ) values ($1, $2, $3, $4, $5, $6, 'TEXT', $7)
           returning id`,
          [
            input.tenantId,
            input.conversationId,
            allocatedSequence,
            member.member_id,
            input.clientMessageId,
            input.idempotencyKey,
            input.body,
          ],
        );
        if (!inserted) throw new Error('MESSAGING_MESSAGE_INSERT_FAILED');
        await client.query(
          `update messaging.conversations
              set next_sequence = next_sequence + 1, updated_at = now()
            where tenant_id = $1 and id = $2`,
          [input.tenantId, input.conversationId],
        );
        await client.query(
          `update messaging.conversation_members
              set last_read_sequence = greatest(last_read_sequence, $4)
            where tenant_id = $1 and conversation_id = $2 and id = $3`,
          [input.tenantId, input.conversationId, member.member_id, allocatedSequence],
        );
        await client.query(
          `insert into audit.outbox_events (
             tenant_id, event_type, aggregate_id, correlation_id, payload
           ) values ($1, 'messaging.message.created.v1', $2, $3, $4::jsonb)`,
          [
            input.tenantId,
            input.conversationId,
            input.correlationId,
            JSON.stringify({
              conversationId: input.conversationId,
              messageId: inserted.id,
              sequence: allocatedSequence,
            }),
          ],
        );
        await client.query(
          `insert into audit.audit_log (
             tenant_id, actor_id, action, resource_type, resource_id,
             result, correlation_id, new_value
           ) values ($1, $2, 'MESSAGE_SENT', 'MESSAGE', $3,
                     'SUCCESS', $4, $5::jsonb)`,
          [
            input.tenantId,
            input.userId,
            inserted.id,
            input.correlationId,
            JSON.stringify({
              conversationId: input.conversationId,
              sequence: allocatedSequence,
              messageType: 'TEXT',
            }),
          ],
        );
        const message = await getMessage(
          client,
          input.tenantId,
          input.userId,
          input.conversationId,
          inserted.id,
        );
        if (!message) throw new Error('MESSAGING_MESSAGE_READBACK_FAILED');
        return { outcome: 'ok', message: mapMessage(message), replayed: false };
      });
    },

    markRead(input) {
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        const member = await queryOne<MemberRow>(
          client,
          `select member.id as member_id,
                  member.last_read_sequence,
                  conversation.next_sequence - 1 as last_sequence
             from messaging.conversation_members member
             join messaging.conversations conversation
              on conversation.tenant_id = member.tenant_id
              and conversation.id = member.conversation_id
             join identity.users current_user
               on current_user.tenant_id = member.tenant_id
              and current_user.id = member.user_id
              and current_user.status = 'ACTIVE'
            where member.tenant_id = $1
              and member.conversation_id = $2
              and member.user_id = $3
              and member.state = 'ACTIVE'
              and conversation.state = 'OPEN'
              and conversation.kind = 'DIRECT'
            for update of member`,
          [input.tenantId, input.conversationId, input.userId],
        );
        if (!member) return { outcome: 'not_found' };

        const previous = await queryOne<ReadCommandRow>(
          client,
          `select through_sequence, result_sequence, changed
             from messaging.read_cursor_commands
            where tenant_id = $1
              and user_id = $2
              and conversation_id = $3
              and idempotency_key = $4`,
          [input.tenantId, input.userId, input.conversationId, input.idempotencyKey],
        );
        if (previous) {
          if (sequence(previous.through_sequence) !== input.throughSequence) {
            return { outcome: 'idempotency_conflict' };
          }
          return {
            outcome: 'ok',
            readThroughSequence: sequence(previous.result_sequence),
            changed: previous.changed,
            replayed: true,
          };
        }

        const lastSequence = sequence(member.last_sequence);
        if (input.throughSequence > lastSequence) return { outcome: 'sequence_invalid' };
        const currentSequence = sequence(member.last_read_sequence);
        const resultSequence = Math.max(currentSequence, input.throughSequence);
        const changed = resultSequence > currentSequence;
        if (changed) {
          await client.query(
            `update messaging.conversation_members
                set last_read_sequence = $4
              where tenant_id = $1 and conversation_id = $2 and id = $3`,
            [input.tenantId, input.conversationId, member.member_id, resultSequence],
          );
          await client.query(
            `insert into audit.outbox_events (
               tenant_id, event_type, aggregate_id, correlation_id, payload
             ) values ($1, 'messaging.read-cursor.updated.v1', $2, $3, $4::jsonb)`,
            [
              input.tenantId,
              input.conversationId,
              input.correlationId,
              JSON.stringify({
                conversationId: input.conversationId,
                userId: input.userId,
                readThroughSequence: resultSequence,
              }),
            ],
          );
        }
        await client.query(
          `insert into messaging.read_cursor_commands (
             tenant_id, user_id, conversation_id, idempotency_key,
             through_sequence, result_sequence, changed
           ) values ($1, $2, $3, $4, $5, $6, $7)`,
          [
            input.tenantId,
            input.userId,
            input.conversationId,
            input.idempotencyKey,
            input.throughSequence,
            resultSequence,
            changed,
          ],
        );
        await client.query(
          `insert into audit.audit_log (
             tenant_id, actor_id, action, resource_type, resource_id,
             result, correlation_id, new_value
           ) values ($1, $2, 'CONVERSATION_READ_CURSOR_SET', 'CONVERSATION', $3,
                     'SUCCESS', $4, $5::jsonb)`,
          [
            input.tenantId,
            input.userId,
            input.conversationId,
            input.correlationId,
            JSON.stringify({ readThroughSequence: resultSequence, changed }),
          ],
        );
        return {
          outcome: 'ok',
          readThroughSequence: resultSequence,
          changed,
          replayed: false,
        };
      });
    },
  };
}
