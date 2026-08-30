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

export interface GameConversationSummary {
  readonly id: string;
  readonly kind: 'GAME';
  readonly contextId: string;
  readonly title: string;
  readonly unreadCount: number;
  readonly updatedAt: string;
  readonly lastMessage?: {
    readonly sequence: number;
    readonly body: string;
    readonly createdAt: string;
  };
}

export type MessagingConversationSummary = ConversationSummary | GameConversationSummary;

export interface ConversationMessage {
  readonly id: string;
  readonly conversationId: string;
  readonly sequence: number;
  readonly clientMessageId?: string;
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

export type GetOrCreateGameConversationResult =
  | { readonly outcome: 'not_found' }
  | { readonly outcome: 'idempotency_conflict' }
  | {
      readonly outcome: 'ok';
      readonly conversation: GameConversationSummary;
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

export type SetUserBlockResult =
  | { readonly outcome: 'forbidden' }
  | { readonly outcome: 'target_not_found' }
  | { readonly outcome: 'idempotency_conflict' }
  | { readonly outcome: 'ok'; readonly changed: boolean; readonly replayed: boolean };

export type RealtimeConnectionAuthorization =
  { readonly outcome: 'disabled' | 'revoked' } | { readonly outcome: 'ok' };

export type RealtimeSubscriptionResult =
  | { readonly outcome: 'disabled' }
  | { readonly outcome: 'not_found' }
  | { readonly outcome: 'ok'; readonly latestSequence: number };

export interface MessagingRepository {
  getRuntimeSettings(tenantId: string): Promise<MessagingRuntimeSettings>;
  listConversations(input: {
    readonly tenantId: string;
    readonly userId: string;
    readonly limit: number;
  }): Promise<readonly MessagingConversationSummary[]>;
  createDirectConversation(input: {
    readonly tenantId: string;
    readonly actorUserId: string;
    readonly otherUserId: string;
    readonly idempotencyKey: string;
    readonly correlationId: string;
  }): Promise<CreateDirectConversationResult>;
  getOrCreateGameConversation(input: {
    readonly tenantId: string;
    readonly actorUserId: string;
    readonly gameId: string;
    readonly idempotencyKey: string;
    readonly correlationId: string;
  }): Promise<GetOrCreateGameConversationResult>;
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
  setUserBlock(input: {
    readonly tenantId: string;
    readonly actorUserId: string;
    readonly otherUserId: string;
    readonly action: 'BLOCK' | 'UNBLOCK';
    readonly idempotencyKey: string;
    readonly correlationId: string;
  }): Promise<SetUserBlockResult>;
  authorizeRealtimeConnection(input: {
    readonly tenantId: string;
    readonly userId: string;
    readonly sessionId: string;
  }): Promise<RealtimeConnectionAuthorization>;
  authorizeRealtimeSubscription(input: {
    readonly tenantId: string;
    readonly userId: string;
    readonly conversationId: string;
  }): Promise<RealtimeSubscriptionResult>;
  listRealtimeRecipientUserIds(input: {
    readonly tenantId: string;
    readonly conversationId: string;
    readonly messageId: string;
    readonly sequence: number;
  }): Promise<readonly string[]>;
  recordRealtimeTicketIssued(input: {
    readonly tenantId: string;
    readonly userId: string;
    readonly ticketId: string;
    readonly expiresAt: string;
    readonly correlationId: string;
  }): Promise<void>;
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

interface GameCommandRow extends QueryResultRow {
  readonly game_id: string;
  readonly conversation_id: string;
}

interface GameConversationRow extends QueryResultRow {
  readonly id: string;
  readonly context_id: string;
  readonly title: string;
  readonly unread_count: number | string;
  readonly updated_at: Date | string;
  readonly last_sequence?: number | string | null;
  readonly last_body?: string | null;
  readonly last_created_at?: Date | string | null;
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

interface UserBlockCommandRow extends QueryResultRow {
  readonly other_user_id: string;
  readonly action: 'BLOCK' | 'UNBLOCK';
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

function mapGameConversation(row: GameConversationRow): GameConversationSummary {
  return {
    id: row.id,
    kind: 'GAME',
    contextId: row.context_id,
    title: row.title,
    unreadCount: sequence(row.unread_count),
    updatedAt: timestamp(row.updated_at),
    ...(row.last_sequence != null && row.last_body != null && row.last_created_at != null
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
    ...(row.client_message_id ? { clientMessageId: row.client_message_id } : {}),
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
    join messaging.tenant_runtime_settings runtime
      on runtime.tenant_id = conversation.tenant_id
     and runtime.http_enabled
     and runtime.direct_enabled
    join identity.users viewer_user
      on viewer_user.tenant_id = current_member.tenant_id
     and viewer_user.id = current_member.user_id
     and viewer_user.status = 'ACTIVE'
    join identity.user_access_profiles current_access
      on current_access.tenant_id = viewer_user.tenant_id
     and current_access.user_id = viewer_user.id
     and 'chat.direct.create' = any(current_access.permissions)
    join messaging.conversation_members other_member
      on other_member.tenant_id = conversation.tenant_id
     and other_member.conversation_id = conversation.id
     and other_member.user_id is not null
     and other_member.user_id <> $2
     and other_member.state = 'ACTIVE'
    join identity.users other_user
      on other_user.tenant_id = other_member.tenant_id
     and other_user.id = other_member.user_id
     and other_user.status = 'ACTIVE'
    left join profile.user_summaries other_summary
      on other_summary.tenant_id = other_member.tenant_id
     and other_summary.user_id = other_member.user_id
    left join profile.privacy_settings target_privacy
      on target_privacy.tenant_id = other_user.tenant_id
     and target_privacy.user_id = other_user.id
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
     and conversation.state = 'OPEN'
     and coalesce(target_privacy.chat_policy, 'AUTHORIZED') = 'AUTHORIZED'
     and not exists (
       select 1
         from messaging.user_blocks block
        where block.tenant_id = conversation.tenant_id
          and ((block.blocker_user_id = current_member.user_id and block.blocked_user_id = other_member.user_id)
            or (block.blocker_user_id = other_member.user_id and block.blocked_user_id = current_member.user_id))
     )`;

const GAME_CONVERSATION_SELECT = `
  select conversation.id,
         conversation.context_id,
         game.title,
         greatest((conversation.next_sequence - 1) - member.last_read_sequence, 0)
           as unread_count,
         conversation.updated_at::text as updated_at,
         last_message.sequence as last_sequence,
         last_message.body as last_body,
         last_message.created_at::text as last_created_at
    from messaging.conversations conversation
    join messaging.conversation_members member
      on member.tenant_id = conversation.tenant_id
     and member.conversation_id = conversation.id
     and member.user_id = $2
     and member.state = 'ACTIVE'
    join identity.users viewer_user
      on viewer_user.tenant_id = member.tenant_id
     and viewer_user.id = member.user_id
     and viewer_user.status = 'ACTIVE'
    join identity.user_access_profiles current_access
      on current_access.tenant_id = viewer_user.tenant_id
     and current_access.user_id = viewer_user.id
     and 'games.play' = any(current_access.permissions)
    join games.games game
      on game.tenant_id = conversation.tenant_id
     and game.id = conversation.context_id
    join games.participations participation
      on participation.tenant_id = game.tenant_id
     and participation.game_id = game.id
     and participation.user_id = viewer_user.id
     and participation.state = 'ACTIVE'
    join messaging.tenant_runtime_settings runtime
      on runtime.tenant_id = conversation.tenant_id
     and runtime.http_enabled
     and runtime.contextual_enabled
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
     and conversation.kind = 'GAME'
     and conversation.context_type = 'GAME'
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

async function getGameConversation(
  client: PoolClient,
  tenantId: string,
  userId: string,
  conversationId: string,
): Promise<GameConversationSummary | undefined> {
  const row = await queryOne<GameConversationRow>(
    client,
    `select conversation.id,
            conversation.context_id,
            game.title,
            greatest((conversation.next_sequence - 1) - member.last_read_sequence, 0)
              as unread_count,
            conversation.updated_at::text as updated_at
       from messaging.conversations conversation
       join messaging.conversation_members member
         on member.tenant_id = conversation.tenant_id
        and member.conversation_id = conversation.id
        and member.user_id = $2
        and member.state = 'ACTIVE'
       join identity.users viewer_user
         on viewer_user.tenant_id = member.tenant_id
        and viewer_user.id = member.user_id
        and viewer_user.status = 'ACTIVE'
       join identity.user_access_profiles current_access
         on current_access.tenant_id = viewer_user.tenant_id
        and current_access.user_id = viewer_user.id
        and 'games.play' = any(current_access.permissions)
       join games.games game
         on game.tenant_id = conversation.tenant_id
        and game.id = conversation.context_id
       join games.participations participation
         on participation.tenant_id = game.tenant_id
        and participation.game_id = game.id
        and participation.user_id = viewer_user.id
        and participation.state = 'ACTIVE'
       join messaging.tenant_runtime_settings runtime
         on runtime.tenant_id = conversation.tenant_id
        and runtime.http_enabled
        and runtime.contextual_enabled
      where conversation.tenant_id = $1
        and conversation.id = $3
        and conversation.kind = 'GAME'
        and conversation.context_type = 'GAME'
        and conversation.state = 'OPEN'`,
    [tenantId, userId, conversationId],
  );
  return row ? mapGameConversation(row) : undefined;
}

async function getAuthorizedMember(
  client: PoolClient,
  tenantId: string,
  userId: string,
  conversationId: string,
  lockMember = false,
): Promise<MemberRow | undefined> {
  return queryOne<MemberRow>(
    client,
    `select member.id as member_id,
            member.last_read_sequence,
            conversation.next_sequence - 1 as last_sequence
       from messaging.conversation_members member
       join messaging.conversations conversation
         on conversation.tenant_id = member.tenant_id
        and conversation.id = member.conversation_id
       join identity.users viewer_user
         on viewer_user.tenant_id = member.tenant_id
        and viewer_user.id = member.user_id
        and viewer_user.status = 'ACTIVE'
       join identity.user_access_profiles current_access
         on current_access.tenant_id = viewer_user.tenant_id
        and current_access.user_id = viewer_user.id
       join messaging.tenant_runtime_settings runtime
         on runtime.tenant_id = conversation.tenant_id
        and runtime.http_enabled
      where member.tenant_id = $1
        and member.conversation_id = $2
        and member.user_id = $3
        and member.state = 'ACTIVE'
        and conversation.state = 'OPEN'
        and (
          (
            conversation.kind = 'DIRECT'
            and runtime.direct_enabled
            and 'chat.direct.create' = any(current_access.permissions)
            and exists (
              select 1
                from messaging.conversation_members other_member
                join identity.users other_user
                  on other_user.tenant_id = other_member.tenant_id
                 and other_user.id = other_member.user_id
                 and other_user.status = 'ACTIVE'
                left join profile.privacy_settings target_privacy
                  on target_privacy.tenant_id = other_user.tenant_id
                 and target_privacy.user_id = other_user.id
               where other_member.tenant_id = member.tenant_id
                 and other_member.conversation_id = member.conversation_id
                 and other_member.user_id <> member.user_id
                 and other_member.state = 'ACTIVE'
                 and coalesce(target_privacy.chat_policy, 'AUTHORIZED') = 'AUTHORIZED'
                 and not exists (
                   select 1
                     from messaging.user_blocks block
                    where block.tenant_id = member.tenant_id
                      and ((block.blocker_user_id = member.user_id and block.blocked_user_id = other_member.user_id)
                        or (block.blocker_user_id = other_member.user_id and block.blocked_user_id = member.user_id))
                 )
            )
          )
          or
          (
            conversation.kind = 'GAME'
            and conversation.context_type = 'GAME'
            and runtime.contextual_enabled
            and 'games.play' = any(current_access.permissions)
            and exists (
              select 1
                from games.participations participation
               where participation.tenant_id = conversation.tenant_id
                 and participation.game_id = conversation.context_id
                 and participation.user_id = member.user_id
                 and participation.state = 'ACTIVE'
            )
          )
        )
      ${lockMember ? 'for update of member' : ''}`,
    [tenantId, conversationId, userId],
  );
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
        const direct = await client.query<ConversationRow>(
          `${CONVERSATION_SELECT}
            order by conversation.updated_at desc, conversation.id desc
            limit $3`,
          [input.tenantId, input.userId, input.limit],
        );
        const games = await client.query<GameConversationRow>(
          `${GAME_CONVERSATION_SELECT}
            order by conversation.updated_at desc, conversation.id desc
            limit $3`,
          [input.tenantId, input.userId, input.limit],
        );
        return [...direct.rows.map(mapConversation), ...games.rows.map(mapGameConversation)]
          .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
          .slice(0, input.limit);
      });
    },

    createDirectConversation(input) {
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
          `${input.tenantId}:${input.actorUserId}:${input.idempotencyKey}`,
        ]);
        const [leftUserId, rightUserId] = [input.actorUserId, input.otherUserId].sort();
        await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
          `${input.tenantId}:${leftUserId}:${rightUserId}`,
        ]);
        const activeUsers = await client.query<{ id: string; chat_policy: string }>(
          `select user_account.id,
                  coalesce(privacy.chat_policy, 'AUTHORIZED') as chat_policy
             from identity.users user_account
             join identity.user_access_profiles current_access
               on current_access.tenant_id = user_account.tenant_id
              and current_access.user_id = $3
              and 'chat.direct.create' = any(current_access.permissions)
             left join profile.privacy_settings privacy
               on privacy.tenant_id = user_account.tenant_id
              and privacy.user_id = user_account.id
            where user_account.tenant_id = $1
              and user_account.id = any($2::uuid[])
              and user_account.status = 'ACTIVE'`,
          [input.tenantId, [input.actorUserId, input.otherUserId], input.actorUserId],
        );
        if (activeUsers.rows.length !== 2) return { outcome: 'target_not_found' };
        const target = activeUsers.rows.find((user) => user.id === input.otherUserId);
        if (!target || target.chat_policy !== 'AUTHORIZED') {
          return { outcome: 'target_not_found' };
        }
        const blocked = await queryOne<{ blocked: boolean }>(
          client,
          `select true as blocked
             from messaging.user_blocks
            where tenant_id = $1
              and ((blocker_user_id = $2 and blocked_user_id = $3)
                or (blocker_user_id = $3 and blocked_user_id = $2))`,
          [input.tenantId, input.actorUserId, input.otherUserId],
        );
        if (blocked) return { outcome: 'target_not_found' };

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

    getOrCreateGameConversation(input) {
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
          `${input.tenantId}:${input.actorUserId}:${input.idempotencyKey}`,
        ]);
        const game = await queryOne<{ id: string; title: string; role: 'ORGANIZER' | 'PLAYER' }>(
          client,
          `select game.id, game.title, participation.role
             from games.games game
             join games.participations participation
               on participation.tenant_id = game.tenant_id
              and participation.game_id = game.id
              and participation.user_id = $2
              and participation.state = 'ACTIVE'
             join identity.users viewer_user
               on viewer_user.tenant_id = participation.tenant_id
              and viewer_user.id = participation.user_id
              and viewer_user.status = 'ACTIVE'
             join identity.user_access_profiles current_access
               on current_access.tenant_id = viewer_user.tenant_id
              and current_access.user_id = viewer_user.id
              and 'games.play' = any(current_access.permissions)
             join messaging.tenant_runtime_settings runtime
               on runtime.tenant_id = game.tenant_id
              and runtime.http_enabled
              and runtime.contextual_enabled
            where game.tenant_id = $1 and game.id = $3`,
          [input.tenantId, input.actorUserId, input.gameId],
        );
        if (!game) return { outcome: 'not_found' };

        const previous = await queryOne<GameCommandRow>(
          client,
          `select game_id, conversation_id
             from messaging.game_conversation_commands
            where tenant_id = $1 and actor_user_id = $2 and idempotency_key = $3`,
          [input.tenantId, input.actorUserId, input.idempotencyKey],
        );
        if (previous) {
          if (previous.game_id !== input.gameId) return { outcome: 'idempotency_conflict' };
          const conversation = await getGameConversation(
            client,
            input.tenantId,
            input.actorUserId,
            previous.conversation_id,
          );
          if (!conversation) throw new Error('MESSAGING_GAME_REPLAY_CONVERSATION_MISSING');
          return { outcome: 'ok', conversation, created: false, replayed: true };
        }

        await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
          `${input.tenantId}:GAME:${input.gameId}`,
        ]);
        const existing = await queryOne<{ id: string }>(
          client,
          `select id
             from messaging.conversations
            where tenant_id = $1
              and kind = 'GAME'
              and context_type = 'GAME'
              and context_id = $2`,
          [input.tenantId, input.gameId],
        );
        let conversationId = existing?.id;
        const created = !conversationId;
        if (!conversationId) {
          const inserted = await queryOne<{ id: string }>(
            client,
            `insert into messaging.conversations (
               tenant_id, kind, context_type, context_id, title, created_by_user_id
             ) values ($1, 'GAME', 'GAME', $2, $3, $4)
             returning id`,
            [input.tenantId, input.gameId, game.title, input.actorUserId],
          );
          if (!inserted) throw new Error('MESSAGING_GAME_CONVERSATION_INSERT_FAILED');
          conversationId = inserted.id;
          await client.query(
            `insert into messaging.conversation_members (
               tenant_id, conversation_id, member_type, user_id, role
             )
             select participation.tenant_id,
                    $2,
                    'USER',
                    participation.user_id,
                    case when participation.role = 'ORGANIZER' then 'OWNER' else 'MEMBER' end
               from games.participations participation
               join identity.users roster_user
                 on roster_user.tenant_id = participation.tenant_id
                and roster_user.id = participation.user_id
                and roster_user.status = 'ACTIVE'
              where participation.tenant_id = $1
                and participation.game_id = $3
                and participation.state = 'ACTIVE'`,
            [input.tenantId, conversationId, input.gameId],
          );
          await client.query(
            `insert into audit.outbox_events (
               tenant_id, event_type, aggregate_id, correlation_id, payload
             ) values ($1, 'messaging.conversation.created.v1', $2, $3, $4::jsonb)`,
            [
              input.tenantId,
              conversationId,
              input.correlationId,
              JSON.stringify({ conversationId, kind: 'GAME', contextId: input.gameId }),
            ],
          );
          await client.query(
            `insert into audit.audit_log (
               tenant_id, actor_id, action, resource_type, resource_id,
               result, correlation_id, new_value
             ) values ($1, $2, 'GAME_CONVERSATION_CREATED', 'CONVERSATION', $3,
                       'SUCCESS', $4, $5::jsonb)`,
            [
              input.tenantId,
              input.actorUserId,
              conversationId,
              input.correlationId,
              JSON.stringify({ kind: 'GAME', contextId: input.gameId }),
            ],
          );
        } else {
          const membership = await queryOne<{ id: string }>(
            client,
            `insert into messaging.conversation_members (
               tenant_id, conversation_id, member_type, user_id, role
             ) values ($1, $2, 'USER', $3, $4)
             on conflict (tenant_id, conversation_id, user_id) where user_id is not null
             do update set state = 'ACTIVE', left_at = null
               where messaging.conversation_members.state <> 'ACTIVE'
             returning id`,
            [
              input.tenantId,
              conversationId,
              input.actorUserId,
              game.role === 'ORGANIZER' ? 'OWNER' : 'MEMBER',
            ],
          );
          if (membership) {
            await client.query(
              `insert into audit.outbox_events (
                 tenant_id, event_type, aggregate_id, correlation_id, payload
               ) values ($1, 'messaging.member.changed.v1', $2, $3, $4::jsonb)`,
              [
                input.tenantId,
                conversationId,
                input.correlationId,
                JSON.stringify({
                  conversationId,
                  userId: input.actorUserId,
                  state: 'ACTIVE',
                }),
              ],
            );
            await client.query(
              `insert into audit.audit_log (
                 tenant_id, actor_id, action, resource_type, resource_id,
                 result, correlation_id, new_value
               ) values ($1, $2, 'GAME_CONVERSATION_MEMBERSHIP_SYNCED', 'CONVERSATION', $3,
                         'SUCCESS', $4, $5::jsonb)`,
              [
                input.tenantId,
                input.actorUserId,
                conversationId,
                input.correlationId,
                JSON.stringify({ contextId: input.gameId, state: 'ACTIVE' }),
              ],
            );
          }
        }
        await client.query(
          `insert into messaging.game_conversation_commands (
             tenant_id, actor_user_id, idempotency_key, game_id, conversation_id
           ) values ($1, $2, $3, $4, $5)`,
          [input.tenantId, input.actorUserId, input.idempotencyKey, input.gameId, conversationId],
        );
        const conversation = await getGameConversation(
          client,
          input.tenantId,
          input.actorUserId,
          conversationId,
        );
        if (!conversation) throw new Error('MESSAGING_GAME_CONVERSATION_READBACK_FAILED');
        return { outcome: 'ok', conversation, created, replayed: false };
      });
    },

    listMessages(input) {
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        const member = await getAuthorizedMember(
          client,
          input.tenantId,
          input.userId,
          input.conversationId,
        );
        if (!member) return { outcome: 'not_found' };
        const result = await client.query<MessageRow>(
          `select message.id, message.conversation_id, message.sequence,
                  sender.user_id as sender_user_id,
                  coalesce(summary.display_name, 'Участник') as sender_display_name,
                  message.client_message_id, message.message_type, message.body,
                  message.created_at::text as created_at
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
        const locked = await queryOne<{
          next_sequence: number | string;
          kind: 'DIRECT' | 'GAME';
          context_id: string | null;
        }>(
          client,
          `select next_sequence, kind, context_id
             from messaging.conversations
            where tenant_id = $1
              and id = $2
              and state = 'OPEN'
              and kind in ('DIRECT', 'GAME')
            for update`,
          [input.tenantId, input.conversationId],
        );
        if (!locked) return { outcome: 'not_found' };
        if (locked.kind === 'DIRECT') {
          const pair = await queryOne<{ left_user_id: string; right_user_id: string }>(
            client,
            `select left_user_id, right_user_id
               from messaging.direct_conversations
              where tenant_id = $1 and conversation_id = $2`,
            [input.tenantId, input.conversationId],
          );
          if (!pair) return { outcome: 'not_found' };
          await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
            `${input.tenantId}:${pair.left_user_id}:${pair.right_user_id}`,
          ]);
        }

        if (locked.kind === 'GAME') {
          if (!locked.context_id) return { outcome: 'not_found' };
          const game = await queryOne<{ id: string }>(
            client,
            `select id
               from games.games
              where tenant_id = $1 and id = $2
              for key share`,
            [input.tenantId, locked.context_id],
          );
          if (!game) return { outcome: 'not_found' };
          const participation = await queryOne<{ id: string }>(
            client,
            `select id
               from games.participations
              where tenant_id = $1
                and game_id = $2
                and user_id = $3
                and state = 'ACTIVE'
              for share`,
            [input.tenantId, locked.context_id, input.userId],
          );
          if (!participation) return { outcome: 'not_found' };
        }

        // Re-evaluate the authoritative access source after serializing on the conversation.
        // GAME access is never inferred from the possibly stale messaging member row.
        const member = await getAuthorizedMember(
          client,
          input.tenantId,
          input.userId,
          input.conversationId,
        );
        if (!member) return { outcome: 'not_found' };

        await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
          `${input.tenantId}:MESSAGE_COMMAND:${input.userId}:${input.idempotencyKey}`,
        ]);
        await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
          `${input.tenantId}:MESSAGE_CLIENT:${input.userId}:${input.clientMessageId}`,
        ]);
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
              and sender.user_id = $2
              and (message.idempotency_key = $3 or message.client_message_id = $4)`,
          [input.tenantId, input.userId, input.idempotencyKey, input.clientMessageId],
        );
        if (previous) {
          if (
            previous.conversation_id !== input.conversationId ||
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
        const member = await getAuthorizedMember(
          client,
          input.tenantId,
          input.userId,
          input.conversationId,
          true,
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

    setUserBlock(input) {
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
          `${input.tenantId}:${input.actorUserId}:${input.idempotencyKey}`,
        ]);
        const [leftUserId, rightUserId] = [input.actorUserId, input.otherUserId].sort();
        await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
          `${input.tenantId}:${leftUserId}:${rightUserId}`,
        ]);
        const actor = await queryOne<{ id: string }>(
          client,
          `select user_account.id
             from identity.users user_account
             join identity.user_access_profiles current_access
               on current_access.tenant_id = user_account.tenant_id
              and current_access.user_id = user_account.id
              and 'chat.direct.create' = any(current_access.permissions)
            where user_account.tenant_id = $1
              and user_account.id = $2
              and user_account.status = 'ACTIVE'`,
          [input.tenantId, input.actorUserId],
        );
        if (!actor) return { outcome: 'forbidden' };
        const previous = await queryOne<UserBlockCommandRow>(
          client,
          `select other_user_id, action, changed
             from messaging.user_block_commands
            where tenant_id = $1 and actor_user_id = $2 and idempotency_key = $3`,
          [input.tenantId, input.actorUserId, input.idempotencyKey],
        );
        if (previous) {
          if (previous.other_user_id !== input.otherUserId || previous.action !== input.action) {
            return { outcome: 'idempotency_conflict' };
          }
          return { outcome: 'ok', changed: previous.changed, replayed: true };
        }
        const target = await queryOne<{ id: string }>(
          client,
          `select id from identity.users
            where tenant_id = $1 and id = $2 and status = 'ACTIVE'`,
          [input.tenantId, input.otherUserId],
        );
        if (!target) return { outcome: 'target_not_found' };
        const mutation =
          input.action === 'BLOCK'
            ? await client.query(
                `insert into messaging.user_blocks (tenant_id, blocker_user_id, blocked_user_id)
                 values ($1, $2, $3) on conflict do nothing`,
                [input.tenantId, input.actorUserId, input.otherUserId],
              )
            : await client.query(
                `delete from messaging.user_blocks
                  where tenant_id = $1 and blocker_user_id = $2 and blocked_user_id = $3`,
                [input.tenantId, input.actorUserId, input.otherUserId],
              );
        const changed = (mutation.rowCount ?? 0) > 0;
        await client.query(
          `insert into messaging.user_block_commands (
             tenant_id, actor_user_id, idempotency_key, other_user_id, action, changed
           ) values ($1, $2, $3, $4, $5, $6)`,
          [
            input.tenantId,
            input.actorUserId,
            input.idempotencyKey,
            input.otherUserId,
            input.action,
            changed,
          ],
        );
        await client.query(
          `insert into audit.outbox_events (
             tenant_id, event_type, aggregate_id, correlation_id, payload
           ) values ($1, 'messaging.user-block.changed.v1', $2, $3, $4::jsonb)`,
          [
            input.tenantId,
            input.actorUserId,
            input.correlationId,
            JSON.stringify({ otherUserId: input.otherUserId, action: input.action, changed }),
          ],
        );
        await client.query(
          `insert into audit.audit_log (
             tenant_id, actor_id, action, resource_type, resource_id,
             result, correlation_id, new_value
           ) values ($1, $2, $3, 'USER_BLOCK', $4, 'SUCCESS', $5, $6::jsonb)`,
          [
            input.tenantId,
            input.actorUserId,
            `USER_${input.action}ED`,
            input.otherUserId,
            input.correlationId,
            JSON.stringify({ action: input.action, changed }),
          ],
        );
        return { outcome: 'ok', changed, replayed: false };
      });
    },

    authorizeRealtimeConnection(input) {
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        const settings = await queryOne<RuntimeRow>(
          client,
          `select http_enabled, direct_enabled, realtime_enabled, contextual_enabled
             from messaging.tenant_runtime_settings
            where tenant_id = $1`,
          [input.tenantId],
        );
        if (
          !settings?.http_enabled ||
          !settings.realtime_enabled ||
          (!settings.direct_enabled && !settings.contextual_enabled)
        ) {
          return { outcome: 'disabled' };
        }
        const authorized = await queryOne<{ authorized: boolean }>(
          client,
          `select true as authorized
             from identity.refresh_sessions presented
             join identity.users viewer_user
               on viewer_user.tenant_id = presented.tenant_id
              and viewer_user.id = presented.user_id
              and viewer_user.status = 'ACTIVE'
             join identity.user_access_profiles current_access
               on current_access.tenant_id = viewer_user.tenant_id
              and current_access.user_id = viewer_user.id
              and (
                ($4::boolean and 'chat.direct.create' = any(current_access.permissions))
                or (
                  $5::boolean
                  and 'games.play' = any(current_access.permissions)
                  and exists (
                    select 1
                      from games.participations participation
                     where participation.tenant_id = viewer_user.tenant_id
                       and participation.user_id = viewer_user.id
                       and participation.state = 'ACTIVE'
                  )
                )
              )
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
          [
            input.tenantId,
            input.sessionId,
            input.userId,
            settings.direct_enabled,
            settings.contextual_enabled,
          ],
        );
        return authorized ? { outcome: 'ok' } : { outcome: 'revoked' };
      });
    },

    authorizeRealtimeSubscription(input) {
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        const settings = await queryOne<RuntimeRow>(
          client,
          `select http_enabled, direct_enabled, realtime_enabled, contextual_enabled
             from messaging.tenant_runtime_settings
            where tenant_id = $1`,
          [input.tenantId],
        );
        if (
          !settings?.http_enabled ||
          !settings.realtime_enabled ||
          (!settings.direct_enabled && !settings.contextual_enabled)
        ) {
          return { outcome: 'disabled' };
        }
        const member = await getAuthorizedMember(
          client,
          input.tenantId,
          input.userId,
          input.conversationId,
        );
        return member
          ? { outcome: 'ok', latestSequence: sequence(member.last_sequence) }
          : { outcome: 'not_found' };
      });
    },

    listRealtimeRecipientUserIds(input) {
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        const result = await client.query<{ user_id: string }>(
          `select member.user_id
             from messaging.tenant_runtime_settings settings
             join messaging.conversations conversation
               on conversation.tenant_id = settings.tenant_id
              and conversation.id = $2
              and conversation.kind in ('DIRECT', 'GAME')
              and conversation.state = 'OPEN'
             join messaging.messages message
               on message.tenant_id = conversation.tenant_id
              and message.conversation_id = conversation.id
              and message.id = $3
              and message.sequence = $4
              and message.deleted_at is null
             join messaging.conversation_members member
               on member.tenant_id = conversation.tenant_id
              and member.conversation_id = conversation.id
              and member.member_type = 'USER'
              and member.user_id is not null
              and member.state = 'ACTIVE'
             join identity.users viewer_user
               on viewer_user.tenant_id = member.tenant_id
              and viewer_user.id = member.user_id
              and viewer_user.status = 'ACTIVE'
             join identity.user_access_profiles current_access
               on current_access.tenant_id = viewer_user.tenant_id
              and current_access.user_id = viewer_user.id
            where settings.tenant_id = $1
              and settings.http_enabled = true
              and settings.realtime_enabled = true
              and (
                (
                  conversation.kind = 'DIRECT'
                  and settings.direct_enabled = true
                  and 'chat.direct.create' = any(current_access.permissions)
                  and exists (
                    select 1
                      from messaging.conversation_members other_member
                      join identity.users other_user
                        on other_user.tenant_id = other_member.tenant_id
                       and other_user.id = other_member.user_id
                       and other_user.status = 'ACTIVE'
                      left join profile.privacy_settings target_privacy
                        on target_privacy.tenant_id = other_user.tenant_id
                       and target_privacy.user_id = other_user.id
                     where other_member.tenant_id = conversation.tenant_id
                       and other_member.conversation_id = conversation.id
                       and other_member.member_type = 'USER'
                       and other_member.user_id is not null
                       and other_member.user_id <> member.user_id
                       and other_member.state = 'ACTIVE'
                       and coalesce(target_privacy.chat_policy, 'AUTHORIZED') = 'AUTHORIZED'
                  )
                  and not exists (
                    select 1
                      from messaging.direct_conversations pair
                      join messaging.user_blocks block
                        on block.tenant_id = pair.tenant_id
                       and pair.conversation_id = conversation.id
                       and ((block.blocker_user_id = pair.left_user_id and block.blocked_user_id = pair.right_user_id)
                         or (block.blocker_user_id = pair.right_user_id and block.blocked_user_id = pair.left_user_id))
                  )
                )
                or
                (
                  conversation.kind = 'GAME'
                  and conversation.context_type = 'GAME'
                  and settings.contextual_enabled = true
                  and 'games.play' = any(current_access.permissions)
                  and exists (
                    select 1
                      from games.participations participation
                     where participation.tenant_id = conversation.tenant_id
                       and participation.game_id = conversation.context_id
                       and participation.user_id = member.user_id
                       and participation.state = 'ACTIVE'
                  )
                )
              )`,
          [input.tenantId, input.conversationId, input.messageId, input.sequence],
        );
        return result.rows.map((row) => row.user_id);
      });
    },

    recordRealtimeTicketIssued(input) {
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
