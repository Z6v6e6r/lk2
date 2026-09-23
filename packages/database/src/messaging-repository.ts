import { profilePhotoDeliveryUrl } from '@phub/domain';
import type { Pool, PoolClient, QueryResultRow } from 'pg';

import { queryOne, withTenantTransaction } from './connection.js';
import {
  attachReadyMediaToMessageWithClient,
  listAttachmentsForMessagesWithClient,
  type MessagingMediaType,
} from './messaging-media-repository.js';
import { profileReachableSql } from './profile-reachability-repository.js';

export interface MessagingRuntimeSettings {
  readonly httpEnabled: boolean;
  readonly directEnabled: boolean;
  readonly realtimeEnabled: boolean;
  readonly contextualEnabled: boolean;
}

export interface MessagingParticipant {
  readonly userId: string;
  readonly displayName: string;
  /**
   * PadlHub-owned stable photo delivery URL. Absent when the participant has no synced local
   * photo; the client then falls back to its generated initials avatar.
   */
  readonly avatarUrl?: string;
}

export interface ConversationNotificationPolicy {
  readonly level: 'ALL' | 'MENTIONS' | 'NONE';
  /** Server-computed: the level is not ALL, or the mute window is still open. */
  readonly muted: boolean;
  readonly mutedUntil?: string;
}

export interface ConversationSummary {
  readonly id: string;
  readonly kind: 'DIRECT';
  readonly participant: MessagingParticipant;
  readonly unreadCount: number;
  readonly updatedAt: string;
  readonly notificationPolicy: ConversationNotificationPolicy;
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
  readonly notificationPolicy: ConversationNotificationPolicy;
  readonly lastMessage?: {
    readonly sequence: number;
    readonly body: string;
    readonly createdAt: string;
  };
}

export type MessagingConversationSummary = ConversationSummary | GameConversationSummary;

/** A message is text, an image set or a file set; attachments decide the stored type. */
export type MessageType = 'TEXT' | 'IMAGE' | 'FILE';

export interface ConversationMessageAttachment {
  readonly mediaId: string;
  readonly position: number;
  readonly mediaType: MessagingMediaType;
  readonly fileName: string;
  readonly contentType: string;
  readonly byteSize: number;
}

export interface ConversationMessage {
  readonly id: string;
  readonly conversationId: string;
  readonly sequence: number;
  readonly clientMessageId?: string;
  readonly sender: MessagingParticipant;
  readonly messageType: MessageType;
  readonly body: string;
  readonly attachments: readonly ConversationMessageAttachment[];
  readonly createdAt: string;
}

export interface ConversationMessagePage {
  readonly messages: readonly ConversationMessage[];
  readonly nextAfterSequence?: number;
}

export type CreateDirectConversationResult =
  | { readonly outcome: 'target_not_found' }
  | { readonly outcome: 'target_unreachable' }
  | { readonly outcome: 'target_chat_access_required' }
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

export type SendConversationMessageAttachmentFailure =
  'NOT_FOUND' | 'NOT_READY' | 'FORBIDDEN' | 'ALREADY_BOUND' | 'DUPLICATE' | 'LIMIT';

export type SendConversationMessageResult =
  | { readonly outcome: 'not_found' }
  | { readonly outcome: 'target_unreachable' }
  | { readonly outcome: 'idempotency_conflict' }
  | {
      readonly outcome: 'attachment_invalid';
      readonly reason: SendConversationMessageAttachmentFailure;
    }
  | {
      readonly outcome: 'ok';
      readonly message: ConversationMessage;
      readonly replayed: boolean;
    };

/**
 * Facts the API needs to hand a reader a short-lived signed URL. The repository resolves the
 * conversation authority, the message visibility and the attachment in one place, so a signed URL can
 * never outlive the permission that produced it.
 */
export interface MessageMediaReadResult {
  readonly mediaId: string;
  readonly messageId: string;
  readonly conversationId: string;
  readonly mediaType: MessagingMediaType;
  readonly fileName: string;
  readonly contentType: string;
  readonly byteSize: number;
  readonly objectKey: string;
  readonly objectVersion: string;
  readonly sha256: string;
}

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

export type UpdateConversationNotificationPolicyResult =
  | { readonly outcome: 'not_found' }
  | {
      readonly outcome: 'ok';
      readonly policy: ConversationNotificationPolicy;
      readonly changed: boolean;
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

export type GameMessagingMembershipSourceEventType =
  | 'game.scheduled.v1'
  | 'game.participation.confirmed.v1'
  | 'game.participation.left.v1'
  | 'game.cancelled.v1';

export type ReconcileGameConversationMembershipResult =
  | { readonly outcome: 'no_op' }
  | { readonly outcome: 'revision_conflict' }
  | {
      readonly outcome: 'applied';
      readonly conversationClosed: boolean;
      readonly activatedUserIds: readonly string[];
      readonly leftUserIds: readonly string[];
    };

export interface MessagingRepository {
  getRuntimeSettings(tenantId: string): Promise<MessagingRuntimeSettings>;
  listConversations(input: {
    readonly tenantId: string;
    readonly userId: string;
    readonly limit: number;
  }): Promise<readonly MessagingConversationSummary[]>;
  /**
   * Opens or reads back the canonical DIRECT pair. Creating a new conversation additionally requires
   * the peer to hold the stored `chat.direct.create` grant, because a peer without it can never open
   * the thread; an already existing pair is returned unchanged so an accepted membership is never
   * taken away by that guard.
   */
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
  reconcileGameConversationMembership(input: {
    readonly tenantId: string;
    readonly gameId: string;
    readonly sourceEventId: string;
    readonly sourceEventType: GameMessagingMembershipSourceEventType;
    readonly sourceAggregateRevision: string;
    readonly correlationId: string;
    readonly occurredAt: string;
  }): Promise<ReconcileGameConversationMembershipResult>;
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
    readonly attachmentMediaIds?: readonly string[];
    readonly correlationId: string;
  }): Promise<SendConversationMessageResult>;
  /** Resolves one attachment for a reader who may see the message that carries it. */
  getMessageMediaForViewer(input: {
    readonly tenantId: string;
    readonly userId: string;
    readonly mediaId: string;
  }): Promise<
    | { readonly outcome: 'ok'; readonly media: MessageMediaReadResult }
    | { readonly outcome: 'not_found' }
  >;
  markRead(input: {
    readonly tenantId: string;
    readonly userId: string;
    readonly conversationId: string;
    readonly throughSequence: number;
    readonly idempotencyKey: string;
    readonly correlationId: string;
  }): Promise<MarkConversationReadResult>;
  /**
   * Sets the caller's own notification policy for one conversation. The command is idempotent by
   * content — an unchanged request writes nothing, so a retried PUT neither duplicates the audit
   * entry nor bumps the row.
   */
  updateConversationNotificationPolicy(input: {
    readonly tenantId: string;
    readonly userId: string;
    readonly conversationId: string;
    readonly level: ConversationNotificationPolicy['level'];
    readonly mutedUntil: string | null;
    readonly idempotencyKey: string;
    readonly correlationId: string;
  }): Promise<UpdateConversationNotificationPolicyResult>;
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
  readonly other_photo_delivery_id: string | null;
  readonly other_level_label: string | null;
  readonly other_level_value: number | string | null;
  readonly unread_count: number | string;
  readonly updated_at: Date | string;
  readonly last_sequence: number | string | null;
  readonly last_body: string | null;
  readonly last_created_at: Date | string | null;
  readonly notification_level: 'ALL' | 'MENTIONS' | 'NONE';
  readonly muted_until: string | null;
  readonly notifications_muted: boolean;
}

interface MessageRow extends QueryResultRow {
  readonly id: string;
  readonly conversation_id: string;
  readonly sequence: number | string;
  readonly sender_user_id: string;
  readonly sender_display_name: string;
  readonly sender_photo_delivery_id: string | null;
  readonly sender_level_label: string | null;
  readonly sender_level_value: number | string | null;
  readonly message_type: MessageType;
  readonly body: string | null;
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
  readonly notification_level: 'ALL' | 'MENTIONS' | 'NONE';
  readonly muted_until: string | null;
  readonly notifications_muted: boolean;
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

interface NotificationPolicyRow extends QueryResultRow {
  readonly notification_level: 'ALL' | 'MENTIONS' | 'NONE';
  readonly muted_until: string | null;
  readonly notifications_muted: boolean;
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

function mapNotificationPolicy(row: {
  readonly notification_level: 'ALL' | 'MENTIONS' | 'NONE';
  readonly muted_until: string | null;
  readonly notifications_muted: boolean;
}): ConversationNotificationPolicy {
  return {
    level: row.notification_level,
    muted: row.notifications_muted,
    ...(row.muted_until ? { mutedUntil: timestamp(row.muted_until) } : {}),
  };
}

function mapConversation(row: ConversationRow, tenantId: string): ConversationSummary {
  const numericLevelValue =
    row.other_level_value === null
      ? null
      : typeof row.other_level_value === 'number'
        ? row.other_level_value
        : Number(row.other_level_value);
  const levelValue =
    numericLevelValue !== null &&
    Number.isFinite(numericLevelValue) &&
    numericLevelValue >= 0 &&
    numericLevelValue <= 10
      ? numericLevelValue
      : null;

  return {
    id: row.id,
    kind: row.kind,
    participant: {
      userId: row.other_user_id,
      displayName: row.other_display_name,
      // Only the PadlHub-owned delivery URL crosses the client boundary; a provider source URL
      // stays inside integration storage.
      ...(row.other_photo_delivery_id
        ? { avatarUrl: profilePhotoDeliveryUrl(tenantId, row.other_photo_delivery_id) }
        : {}),
      ...(row.other_level_label ? { level: row.other_level_label } : {}),
      ...(levelValue === null ? {} : { levelValue }),
    },
    unreadCount: sequence(row.unread_count),
    updatedAt: timestamp(row.updated_at),
    notificationPolicy: mapNotificationPolicy(row),
    // A body-less last message (an image or a file) still previews: the client shows the
    // attachment instead of an empty line.
    ...(row.last_sequence !== null && row.last_created_at !== null
      ? {
          lastMessage: {
            sequence: sequence(row.last_sequence),
            body: row.last_body ?? '',
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
    notificationPolicy: mapNotificationPolicy(row),
    ...(row.last_sequence != null && row.last_created_at != null
      ? {
          lastMessage: {
            sequence: sequence(row.last_sequence),
            body: row.last_body ?? '',
            createdAt: timestamp(row.last_created_at),
          },
        }
      : {}),
  };
}

function mapMessage(
  row: MessageRow,
  tenantId: string,
  attachments: readonly ConversationMessageAttachment[] = [],
): ConversationMessage {
  const numericLevelValue =
    row.sender_level_value === null
      ? null
      : typeof row.sender_level_value === 'number'
        ? row.sender_level_value
        : Number(row.sender_level_value);
  const levelValue =
    numericLevelValue !== null &&
    Number.isFinite(numericLevelValue) &&
    numericLevelValue >= 0 &&
    numericLevelValue <= 10
      ? numericLevelValue
      : null;

  return {
    id: row.id,
    conversationId: row.conversation_id,
    sequence: sequence(row.sequence),
    ...(row.client_message_id ? { clientMessageId: row.client_message_id } : {}),
    sender: {
      userId: row.sender_user_id,
      displayName: row.sender_display_name,
      ...(row.sender_photo_delivery_id
        ? { avatarUrl: profilePhotoDeliveryUrl(tenantId, row.sender_photo_delivery_id) }
        : {}),
      ...(row.sender_level_label ? { level: row.sender_level_label } : {}),
      ...(levelValue === null ? {} : { levelValue }),
    },
    messageType: row.message_type,
    // An image-only or file-only message carries no text at all.
    body: row.body ?? '',
    attachments,
    createdAt: timestamp(row.created_at),
  };
}

/**
 * Raised inside the send transaction so the route can answer a stable failure code; the transaction
 * rolls back and no message row survives.
 */
export class MessagingAttachmentError extends Error {
  public constructor(public readonly reason: SendConversationMessageAttachmentFailure) {
    super(`MESSAGING_ATTACHMENT_${reason}`);
    this.name = 'MessagingAttachmentError';
  }
}

/** One batched read for the attachments of a message page; never one query per message. */
async function attachmentsForMessages(
  client: PoolClient,
  input: {
    readonly tenantId: string;
    readonly conversationId: string;
    readonly messageIds: readonly string[];
  },
): Promise<ReadonlyMap<string, readonly ConversationMessageAttachment[]>> {
  if (input.messageIds.length === 0) return new Map();
  const rows = await listAttachmentsForMessagesWithClient(client, input);
  const grouped = new Map<string, ConversationMessageAttachment[]>();
  for (const row of rows) {
    const existing = grouped.get(row.messageId) ?? [];
    existing.push({
      mediaId: row.mediaId,
      position: row.position,
      mediaType: row.mediaType,
      fileName: row.fileName,
      contentType: row.contentType,
      byteSize: row.byteSize,
    });
    grouped.set(row.messageId, existing);
  }
  return grouped;
}

const CONVERSATION_SELECT = `
  select conversation.id,
         conversation.kind,
         other_member.user_id as other_user_id,
         coalesce(other_summary.display_name, 'Участник') as other_display_name,
         case when other_privacy.user_id is null
                    or (other_privacy.visibility_mode <> 'PRIVATE'
                        and other_privacy.section_visibility->>'avatar' = 'true')
              then other_photo.delivery_id end as other_photo_delivery_id,
         case when other_privacy.user_id is null
                    or (other_privacy.visibility_mode <> 'PRIVATE'
                        and other_privacy.section_visibility->>'levelAndRating' = 'true')
              then other_summary.level_label end as other_level_label,
         case when other_privacy.user_id is null
                    or (other_privacy.visibility_mode <> 'PRIVATE'
                        and other_privacy.section_visibility->>'levelAndRating' = 'true')
              then other_summary.level_value end as other_level_value,
         greatest(
           (conversation.next_sequence - 1) - current_member.last_read_sequence,
           0
         ) as unread_count,
         conversation.updated_at::text as updated_at,
         last_message.sequence as last_sequence,
         last_message.body as last_body,
         last_message.created_at::text as last_created_at,
         current_member.notification_level as notification_level,
         current_member.muted_until::text as muted_until,
         (
           current_member.notification_level <> 'ALL'
           or (current_member.muted_until is not null and current_member.muted_until > now())
         ) as notifications_muted
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
    left join integration.user_profile_photo_sync other_photo
      on other_photo.tenant_id = other_member.tenant_id
     and other_photo.user_id = other_member.user_id
    left join profile.privacy_settings other_privacy
      on other_privacy.tenant_id = other_member.tenant_id
     and other_privacy.user_id = other_member.user_id
    left join lateral (
      select message.sequence, message.body, message.created_at
        from messaging.messages message
       where message.tenant_id = conversation.tenant_id
         and message.conversation_id = conversation.id
         and message.deleted_at is null
         and message.hidden_at is null
       order by message.sequence desc
       limit 1
    ) last_message on true
   where conversation.tenant_id = $1
     and conversation.kind = 'DIRECT'
     and conversation.state = 'OPEN'
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
         last_message.created_at::text as last_created_at,
         member.notification_level as notification_level,
         member.muted_until::text as muted_until,
         (
           member.notification_level <> 'ALL'
           or (member.muted_until is not null and member.muted_until > now())
         ) as notifications_muted
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
     and game.lifecycle_state <> 'CANCELLED'
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
         and message.hidden_at is null
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
  return row ? mapConversation(row, tenantId) : undefined;
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
        and game.lifecycle_state <> 'CANCELLED'
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
               where other_member.tenant_id = member.tenant_id
                 and other_member.conversation_id = member.conversation_id
                 and other_member.user_id <> member.user_id
                 and other_member.state = 'ACTIVE'
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
                from games.games game
               where game.tenant_id = conversation.tenant_id
                 and game.id = conversation.context_id
                 and game.lifecycle_state <> 'CANCELLED'
            )
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
            case when sender_privacy.user_id is null
                       or (sender_privacy.visibility_mode <> 'PRIVATE'
                           and sender_privacy.section_visibility->>'avatar' = 'true')
                 then photo.delivery_id end as sender_photo_delivery_id,
            case when sender_privacy.user_id is null
                       or (sender_privacy.visibility_mode <> 'PRIVATE'
                           and sender_privacy.section_visibility->>'levelAndRating' = 'true')
                 then summary.level_label end as sender_level_label,
            case when sender_privacy.user_id is null
                       or (sender_privacy.visibility_mode <> 'PRIVATE'
                           and sender_privacy.section_visibility->>'levelAndRating' = 'true')
                 then summary.level_value end as sender_level_value,
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
       left join integration.user_profile_photo_sync photo
         on photo.tenant_id = sender.tenant_id
        and photo.user_id = sender.user_id
       left join profile.privacy_settings sender_privacy
         on sender_privacy.tenant_id = sender.tenant_id
        and sender_privacy.user_id = sender.user_id
      where message.tenant_id = $1
        and message.conversation_id = $3
        and message.id = $4
        and message.deleted_at is null
        and message.hidden_at is null`,
    [tenantId, userId, conversationId, messageId],
  );
}

/**
 * Active user members that may receive a conversation event. Realtime additionally requires its
 * own tenant gate; in-app notification projection reuses the same membership, permission and block
 * gates without requiring realtime to be enabled.
 */
function recipientUserIdsSql(options: {
  readonly requireRealtime: boolean;
  /**
   * Notification fan-out honours the recipient's own per-conversation policy; realtime delivery does
   * not, because a muted chat must still open live for someone who is looking at it. A message has no
   * mentions yet, so only `ALL` receives a notification.
   */
  readonly respectNotificationPolicy: boolean;
}): string {
  return `select member.user_id
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
              and message.hidden_at is null
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
              ${options.requireRealtime ? 'and settings.realtime_enabled = true\n' : ''}              and (
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
                     where other_member.tenant_id = conversation.tenant_id
                       and other_member.conversation_id = conversation.id
                       and other_member.member_type = 'USER'
                       and other_member.user_id is not null
                       and other_member.user_id <> member.user_id
                       and other_member.state = 'ACTIVE'
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
                      from games.games game
                     where game.tenant_id = conversation.tenant_id
                       and game.id = conversation.context_id
                       and game.lifecycle_state <> 'CANCELLED'
                  )
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
              ${
                options.respectNotificationPolicy
                  ? "and member.notification_level = 'ALL'\n              and (member.muted_until is null or member.muted_until <= now())\n"
                  : ''
              }`;
}

/**
 * An outbox payload is identifier-only, so the notification rule resolves its recipients from
 * `recipientUserIds`. The cap matches `MAX_NOTIFICATION_EVENT_RECIPIENTS` in `@phub/notifications`:
 * a longer list is rejected by the audience selector and the rule is skipped instead of notifying
 * a partially addressed conversation.
 */
const MAX_NOTIFICATION_RECIPIENT_USER_IDS = 50;

/**
 * Recipients of an in-app notification about a conversation event. Uses the same membership,
 * permission and block gates as realtime without requiring the realtime tenant gate, and never
 * notifies the actor that produced the event.
 */
async function listNotificationRecipientUserIds(
  client: PoolClient,
  input: {
    readonly tenantId: string;
    readonly conversationId: string;
    readonly messageId: string;
    readonly sequence: number;
    readonly actorUserId: string;
  },
): Promise<string[]> {
  const result = await client.query<{ user_id: string }>(
    recipientUserIdsSql({ requireRealtime: false, respectNotificationPolicy: true }),
    [input.tenantId, input.conversationId, input.messageId, input.sequence],
  );
  return result.rows
    .map((row) => row.user_id)
    .filter((userId) => userId !== input.actorUserId)
    .slice(0, MAX_NOTIFICATION_RECIPIENT_USER_IDS);
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
        return [
          ...direct.rows.map((row) => mapConversation(row, input.tenantId)),
          ...games.rows.map(mapGameConversation),
        ]
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
        const activeUsers = await client.query<{
          id: string;
          chat_policy: string;
          reachable: boolean;
          can_direct_chat: boolean;
        }>(
          `select user_account.id,
                  coalesce(privacy.chat_policy, 'AUTHORIZED') as chat_policy,
                  ${profileReachableSql({ tenantParam: '$1', userParam: 'user_account.id' })} as reachable,
                  exists (
                    select 1
                      from identity.user_access_profiles direct_access
                     where direct_access.tenant_id = user_account.tenant_id
                       and direct_access.user_id = user_account.id
                       and 'chat.direct.create' = any(direct_access.permissions)
                  ) as can_direct_chat
             from identity.users user_account
             left join profile.privacy_settings privacy
               on privacy.tenant_id = user_account.tenant_id
              and privacy.user_id = user_account.id
            where user_account.tenant_id = $1
              and user_account.id = any($2::uuid[])
              and user_account.status = 'ACTIVE'`,
          [input.tenantId, [input.actorUserId, input.otherUserId]],
        );
        const actor = activeUsers.rows.find((user) => user.id === input.actorUserId);
        const target = activeUsers.rows.find((user) => user.id === input.otherUserId);
        // An actor without the stored direct-chat grant keeps the existing non-enumerating refusal.
        if (activeUsers.rows.length !== 2 || actor?.can_direct_chat !== true) {
          return { outcome: 'target_not_found' };
        }
        if (!target || target.chat_policy !== 'AUTHORIZED') {
          return { outcome: 'target_not_found' };
        }
        // An imported record with no login path can never open the cabinet, so a new conversation
        // would stay invisible for its owner.
        if (target.reachable !== true) return { outcome: 'target_unreachable' };
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
          // A peer without the stored direct-chat grant can never open a new conversation: the
          // thread and its "new chat" notification would be dead on arrival for its owner. Refuse
          // the command instead of writing that thread. Only creation is gated here — the canonical
          // pair above stays returnable, so an already accepted membership is never taken away.
          if (target.can_direct_chat !== true) return { outcome: 'target_chat_access_required' };
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
              JSON.stringify({
                conversationId,
                kind: 'DIRECT',
                // The creation gate above proves this peer held the stored direct-chat grant when the
                // thread was opened, so this event is never published for a peer who could not open
                // it then. A grant revoked before the projection is not re-checked here: the
                // notification projector revalidates only the recipient's account status.
                recipientUserIds: [input.otherUserId],
              }),
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
            where game.tenant_id = $1
              and game.id = $3
              and game.lifecycle_state <> 'CANCELLED'`,
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
          const rosterRecipients = await client.query<{ user_id: string }>(
            `select member.user_id
               from messaging.conversation_members member
               join identity.users roster_user
                 on roster_user.tenant_id = member.tenant_id
                and roster_user.id = member.user_id
                and roster_user.status = 'ACTIVE'
              where member.tenant_id = $1
                and member.conversation_id = $2
                and member.member_type = 'USER'
                and member.user_id is not null
                and member.user_id <> $3
              order by member.user_id
              limit $4`,
            [
              input.tenantId,
              conversationId,
              input.actorUserId,
              MAX_NOTIFICATION_RECIPIENT_USER_IDS,
            ],
          );
          await client.query(
            `insert into audit.outbox_events (
               tenant_id, event_type, aggregate_id, correlation_id, payload
             ) values ($1, 'messaging.conversation.created.v1', $2, $3, $4::jsonb)`,
            [
              input.tenantId,
              conversationId,
              input.correlationId,
              JSON.stringify({
                conversationId,
                kind: 'GAME',
                contextId: input.gameId,
                recipientUserIds: rosterRecipients.rows.map((row) => row.user_id),
              }),
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

    reconcileGameConversationMembership(input) {
      if (!/^[1-9]\d*$/.test(input.sourceAggregateRevision)) {
        throw new Error('GAME_MESSAGING_MEMBERSHIP_REVISION_INVALID');
      }
      const sourceRevision = BigInt(input.sourceAggregateRevision);
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        const conversation = await queryOne<{ id: string; state: 'OPEN' | 'CLOSED' | 'ARCHIVED' }>(
          client,
          `select id, state
             from messaging.conversations
            where tenant_id = $1
              and kind = 'GAME'
              and context_type = 'GAME'
              and context_id = $2
            for update`,
          [input.tenantId, input.gameId],
        );
        if (!conversation) return { outcome: 'no_op' };

        const game = await queryOne<{ revision: string; lifecycle_state: string }>(
          client,
          `select revision::text as revision, lifecycle_state
             from games.games
            where tenant_id = $1
              and id = $2
            for share`,
          [input.tenantId, input.gameId],
        );
        if (!game) return { outcome: 'no_op' };
        if (sourceRevision > BigInt(game.revision)) return { outcome: 'revision_conflict' };

        await client.query(
          `select user_id, role
             from games.participations
            where tenant_id = $1
              and game_id = $2
              and state = 'ACTIVE'
            order by user_id
            for share`,
          [input.tenantId, input.gameId],
        );

        let conversationClosed = false;
        let activatedUserIds: readonly string[] = [];
        let leftUserIds: readonly string[] = [];
        if (game.lifecycle_state === 'CANCELLED') {
          const closed = await client.query<{ id: string }>(
            `update messaging.conversations
                set state = 'CLOSED', updated_at = now()
              where tenant_id = $1
                and id = $2
                and state = 'OPEN'
              returning id`,
            [input.tenantId, conversation.id],
          );
          conversationClosed = (closed.rowCount ?? 0) > 0;
          const left = await client.query<{ user_id: string }>(
            `update messaging.conversation_members
                set state = 'LEFT', left_at = now()
              where tenant_id = $1
                and conversation_id = $2
                and member_type = 'USER'
                and state = 'ACTIVE'
              returning user_id`,
            [input.tenantId, conversation.id],
          );
          leftUserIds = left.rows.flatMap((row) => (row.user_id ? [row.user_id] : []));
        } else if (conversation.state === 'OPEN') {
          const activated = await client.query<{ user_id: string }>(
            `insert into messaging.conversation_members (
               tenant_id, conversation_id, member_type, user_id, role, state, left_at
             )
             select $1, $2, 'USER', participation.user_id,
                    case when participation.role = 'ORGANIZER' then 'OWNER' else 'MEMBER' end,
                    'ACTIVE', null
               from games.participations participation
              where participation.tenant_id = $1
                and participation.game_id = $3
                and participation.state = 'ACTIVE'
             on conflict (tenant_id, conversation_id, user_id) where user_id is not null
             do update set
               role = excluded.role,
               state = 'ACTIVE',
               left_at = null
             where messaging.conversation_members.role <> excluded.role
                or messaging.conversation_members.state <> 'ACTIVE'
                or messaging.conversation_members.left_at is not null
             returning user_id`,
            [input.tenantId, conversation.id, input.gameId],
          );
          activatedUserIds = activated.rows.flatMap((row) => (row.user_id ? [row.user_id] : []));
          const left = await client.query<{ user_id: string }>(
            `update messaging.conversation_members member
                set state = 'LEFT', left_at = now()
              where member.tenant_id = $1
                and member.conversation_id = $2
                and member.member_type = 'USER'
                and member.state = 'ACTIVE'
                and not exists (
                  select 1
                    from games.participations participation
                   where participation.tenant_id = member.tenant_id
                     and participation.game_id = $3
                     and participation.user_id = member.user_id
                     and participation.state = 'ACTIVE'
                )
              returning member.user_id`,
            [input.tenantId, conversation.id, input.gameId],
          );
          leftUserIds = left.rows.flatMap((row) => (row.user_id ? [row.user_id] : []));
        }

        if (!conversationClosed && activatedUserIds.length === 0 && leftUserIds.length === 0) {
          return { outcome: 'no_op' };
        }
        await client.query(
          `insert into audit.audit_log (
             tenant_id, actor_id, action, resource_type, resource_id,
             result, correlation_id, new_value
           ) values ($1, null, 'GAME_CONVERSATION_MEMBERSHIP_RECONCILED', 'CONVERSATION', $2,
                     'SUCCESS', $3, $4::jsonb)`,
          [
            input.tenantId,
            conversation.id,
            input.correlationId,
            JSON.stringify({
              contextId: input.gameId,
              sourceEventId: input.sourceEventId,
              sourceEventType: input.sourceEventType,
              sourceAggregateRevision: input.sourceAggregateRevision,
              currentAggregateRevision: game.revision,
              occurredAt: input.occurredAt,
              conversationClosed,
              activatedUserIds,
              leftUserIds,
            }),
          ],
        );
        return {
          outcome: 'applied',
          conversationClosed,
          activatedUserIds,
          leftUserIds,
        };
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
                  case when sender_privacy.user_id is null
                             or (sender_privacy.visibility_mode <> 'PRIVATE'
                                 and sender_privacy.section_visibility->>'avatar' = 'true')
                       then photo.delivery_id end as sender_photo_delivery_id,
                  case when sender_privacy.user_id is null
                             or (sender_privacy.visibility_mode <> 'PRIVATE'
                                 and sender_privacy.section_visibility->>'levelAndRating' = 'true')
                       then summary.level_label end as sender_level_label,
                  case when sender_privacy.user_id is null
                             or (sender_privacy.visibility_mode <> 'PRIVATE'
                                 and sender_privacy.section_visibility->>'levelAndRating' = 'true')
                       then summary.level_value end as sender_level_value,
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
             left join integration.user_profile_photo_sync photo
               on photo.tenant_id = sender.tenant_id
              and photo.user_id = sender.user_id
             left join profile.privacy_settings sender_privacy
               on sender_privacy.tenant_id = sender.tenant_id
              and sender_privacy.user_id = sender.user_id
            where message.tenant_id = $1
              and message.conversation_id = $2
              and message.sequence > $3
              and message.deleted_at is null
              and message.hidden_at is null
            order by message.sequence asc
            limit $4`,
          [input.tenantId, input.conversationId, input.afterSequence, input.limit + 1],
        );
        const hasMore = result.rows.length > input.limit;
        const visible = hasMore ? result.rows.slice(0, input.limit) : result.rows;
        const last = visible.at(-1);
        const attachments = await attachmentsForMessages(client, {
          tenantId: input.tenantId,
          conversationId: input.conversationId,
          messageIds: visible.map((row) => row.id),
        });
        return {
          outcome: 'ok',
          page: {
            messages: visible.map((row) =>
              mapMessage(row, input.tenantId, attachments.get(row.id) ?? []),
            ),
            ...(hasMore && last ? { nextAfterSequence: sequence(last.sequence) } : {}),
          },
        };
      });
    },

    sendMessage(input) {
      return withTenantTransaction(
        pool,
        input.tenantId,
        async (client): Promise<SendConversationMessageResult> => {
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
          let directPeerUserId: string | null = null;
          if (locked.kind === 'DIRECT') {
            const pair = await queryOne<{ left_user_id: string; right_user_id: string }>(
              client,
              `select left_user_id, right_user_id
               from messaging.direct_conversations
              where tenant_id = $1 and conversation_id = $2`,
              [input.tenantId, input.conversationId],
            );
            if (!pair) return { outcome: 'not_found' };
            directPeerUserId =
              pair.left_user_id === input.userId ? pair.right_user_id : pair.left_user_id;
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
              where tenant_id = $1
                and id = $2
                and lifecycle_state <> 'CANCELLED'
              for share`,
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
                  case when sender_privacy.user_id is null
                             or (sender_privacy.visibility_mode <> 'PRIVATE'
                                 and sender_privacy.section_visibility->>'avatar' = 'true')
                       then photo.delivery_id end as sender_photo_delivery_id,
                  case when sender_privacy.user_id is null
                             or (sender_privacy.visibility_mode <> 'PRIVATE'
                                 and sender_privacy.section_visibility->>'levelAndRating' = 'true')
                       then summary.level_label end as sender_level_label,
                  case when sender_privacy.user_id is null
                             or (sender_privacy.visibility_mode <> 'PRIVATE'
                                 and sender_privacy.section_visibility->>'levelAndRating' = 'true')
                       then summary.level_value end as sender_level_value,
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
             left join integration.user_profile_photo_sync photo
               on photo.tenant_id = sender.tenant_id
              and photo.user_id = sender.user_id
             left join profile.privacy_settings sender_privacy
               on sender_privacy.tenant_id = sender.tenant_id
              and sender_privacy.user_id = sender.user_id
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
              // An attachment-only message stores no body at all, so the stored null and the empty
              // request body describe the same command.
              (previous.body ?? '') !== input.body
            ) {
              return { outcome: 'idempotency_conflict' };
            }
            const replayedAttachments = await attachmentsForMessages(client, {
              tenantId: input.tenantId,
              conversationId: input.conversationId,
              messageIds: [previous.id],
            });
            return {
              outcome: 'ok',
              message: mapMessage(
                previous,
                input.tenantId,
                replayedAttachments.get(previous.id) ?? [],
              ),
              replayed: true,
            };
          }

          // A direct conversation stays readable, but a message addressed to a peer who never signed in
          // is undeliverable: the notification and the realtime event land on an account nobody opens.
          // Replays above stay honoured so an already committed send is never rewritten by this guard.
          if (directPeerUserId) {
            const peer = await queryOne<{ reachable: boolean }>(
              client,
              `select ${profileReachableSql({ tenantParam: '$1', userParam: '$2' })} as reachable`,
              [input.tenantId, directPeerUserId],
            );
            if (peer?.reachable !== true) return { outcome: 'target_unreachable' };
          }

          const allocatedSequence = sequence(locked.next_sequence);
          const attachmentMediaIds = [...new Set(input.attachmentMediaIds ?? [])];
          const attachmentMedia = attachmentMediaIds.length
            ? await client.query<{ readonly media_type: MessagingMediaType }>(
                `select media_type
                 from messaging.media_assets
                where tenant_id = $1 and id = any($2::uuid[])
                order by id`,
                [input.tenantId, attachmentMediaIds],
              )
            : undefined;
          const messageType: MessageType =
            attachmentMediaIds.length === 0
              ? 'TEXT'
              : (attachmentMedia?.rows.length ?? 0) === attachmentMediaIds.length &&
                  attachmentMedia?.rows.every((row) => row.media_type === 'IMAGE')
                ? 'IMAGE'
                : 'FILE';
          const inserted = await queryOne<{ id: string }>(
            client,
            `insert into messaging.messages (
             tenant_id, conversation_id, sequence, sender_member_id,
             client_message_id, idempotency_key, message_type, body
           ) values ($1, $2, $3, $4, $5, $6, $7, $8)
           returning id`,
            [
              input.tenantId,
              input.conversationId,
              allocatedSequence,
              member.member_id,
              input.clientMessageId,
              input.idempotencyKey,
              messageType,
              input.body.length > 0 ? input.body : null,
            ],
          );
          if (!inserted) throw new Error('MESSAGING_MESSAGE_INSERT_FAILED');
          let attached: readonly ConversationMessageAttachment[] = [];
          if (attachmentMediaIds.length > 0) {
            try {
              attached = await attachReadyMediaToMessageWithClient(client, {
                tenantId: input.tenantId,
                conversationId: input.conversationId,
                messageId: inserted.id,
                senderUserId: input.userId,
                mediaIds: attachmentMediaIds,
              });
            } catch (error) {
              const code = error instanceof Error ? error.message : '';
              const reason: SendConversationMessageAttachmentFailure =
                code === 'MESSAGING_ATTACHMENT_NOT_READY'
                  ? 'NOT_READY'
                  : code === 'MESSAGING_ATTACHMENT_FORBIDDEN'
                    ? 'FORBIDDEN'
                    : code === 'MESSAGING_ATTACHMENT_ALREADY_BOUND'
                      ? 'ALREADY_BOUND'
                      : code === 'MESSAGING_ATTACHMENT_DUPLICATE'
                        ? 'DUPLICATE'
                        : code === 'MESSAGING_ATTACHMENT_LIMIT_EXCEEDED'
                          ? 'LIMIT'
                          : 'NOT_FOUND';
              // The whole send rolls back, so a rejected attachment never leaves a message behind.
              throw new MessagingAttachmentError(reason);
            }
          }
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
          const recipients = await listNotificationRecipientUserIds(client, {
            tenantId: input.tenantId,
            conversationId: input.conversationId,
            messageId: inserted.id,
            sequence: allocatedSequence,
            actorUserId: input.userId,
          });
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
                recipientUserIds: recipients,
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
                messageType,
                attachmentCount: attached.length,
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
          const readbackAttachments = await attachmentsForMessages(client, {
            tenantId: input.tenantId,
            conversationId: input.conversationId,
            messageIds: [message.id],
          });
          return {
            outcome: 'ok',
            message: mapMessage(message, input.tenantId, readbackAttachments.get(message.id) ?? []),
            replayed: false,
          };
        },
      ).catch((error: unknown) => {
        // The attachment guard aborts and rolls back the send transaction, so the caller gets a
        // stable refusal instead of a half-written message.
        if (error instanceof MessagingAttachmentError) {
          return { outcome: 'attachment_invalid', reason: error.reason } as const;
        }
        throw error;
      });
    },

    getMessageMediaForViewer(input) {
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        const row = await queryOne<
          {
            readonly media_id: string;
            readonly message_id: string;
            readonly conversation_id: string;
            readonly media_type: MessagingMediaType;
            readonly file_name: string;
            readonly content_type: string;
            readonly size_bytes: string | number;
            readonly object_key: string;
            readonly object_version: string | null;
            readonly sha256: string;
          } & QueryResultRow
        >(
          client,
          `select attachment.media_id, attachment.message_id, attachment.conversation_id,
                  media.media_type, attachment.file_name, attachment.content_type,
                  attachment.size_bytes, attachment.object_key,
                  media.ready_object_version as object_version, attachment.sha256
             from messaging.message_attachments attachment
             join messaging.media_assets media
               on media.tenant_id = attachment.tenant_id and media.id = attachment.media_id
             join messaging.messages message
               on message.tenant_id = attachment.tenant_id
              and message.conversation_id = attachment.conversation_id
              and message.id = attachment.message_id
            where attachment.tenant_id = $1
              and attachment.media_id = $2
              and media.state = 'READY'
              and message.deleted_at is null
              and message.hidden_at is null
              and not exists (
                select 1
                  from messaging.conversations conversation
                  join messaging.direct_conversations pair
                    on pair.tenant_id = conversation.tenant_id
                   and pair.conversation_id = conversation.id
                 where conversation.tenant_id = $1
                   and conversation.id = attachment.conversation_id
                   and exists (
                     select 1
                       from messaging.user_blocks block
                      where block.tenant_id = conversation.tenant_id
                        and (
                          (block.blocker_user_id = $3 and block.blocked_user_id in (pair.left_user_id, pair.right_user_id))
                          or (block.blocked_user_id = $3 and block.blocker_user_id in (pair.left_user_id, pair.right_user_id))
                        )
                   )
              )`,
          [input.tenantId, input.mediaId, input.userId],
        );
        // A READY asset always carries its ready object version; a missing one cannot be served
        // safely by exact version and stays invisible.
        if (!row || row.object_version === null) return { outcome: 'not_found' } as const;
        // The attachment is readable exactly while the message is: the same membership, tenant gate,
        // permission and GAME participation predicate that guards message history.
        const member = await getAuthorizedMember(
          client,
          input.tenantId,
          input.userId,
          row.conversation_id,
        );
        if (!member) return { outcome: 'not_found' } as const;
        return {
          outcome: 'ok',
          media: {
            mediaId: row.media_id,
            messageId: row.message_id,
            conversationId: row.conversation_id,
            mediaType: row.media_type,
            fileName: row.file_name,
            contentType: row.content_type,
            byteSize: Number(row.size_bytes),
            objectKey: row.object_key,
            objectVersion: row.object_version,
            sha256: row.sha256,
          },
        } as const;
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

    updateConversationNotificationPolicy(input) {
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        const member = await getAuthorizedMember(
          client,
          input.tenantId,
          input.userId,
          input.conversationId,
          true,
        );
        if (!member) return { outcome: 'not_found' };

        const readPolicy = (): Promise<NotificationPolicyRow | undefined> =>
          queryOne<NotificationPolicyRow>(
            client,
            `select notification_level,
                    muted_until::text as muted_until,
                    (
                      notification_level <> 'ALL'
                      or (muted_until is not null and muted_until > now())
                    ) as notifications_muted
               from messaging.conversation_members
              where tenant_id = $1 and conversation_id = $2 and id = $3`,
            [input.tenantId, input.conversationId, member.member_id],
          );

        const current = await readPolicy();
        if (!current) return { outcome: 'not_found' };
        const currentMutedUntil = current.muted_until ? timestamp(current.muted_until) : undefined;
        const requestedMutedUntil = input.mutedUntil ? timestamp(input.mutedUntil) : undefined;
        const changed =
          current.notification_level !== input.level ||
          (currentMutedUntil === undefined) !== (requestedMutedUntil === undefined) ||
          (currentMutedUntil !== undefined &&
            requestedMutedUntil !== undefined &&
            Date.parse(currentMutedUntil) !== Date.parse(requestedMutedUntil));

        if (changed) {
          await client.query(
            `update messaging.conversation_members
                set notification_level = $4,
                    muted_until = $5::timestamptz
              where tenant_id = $1 and conversation_id = $2 and id = $3`,
            [input.tenantId, input.conversationId, member.member_id, input.level, input.mutedUntil],
          );
          await client.query(
            `insert into audit.audit_log (
               tenant_id, actor_id, action, resource_type, resource_id,
               result, correlation_id, new_value
             ) values ($1, $2, 'CONVERSATION_NOTIFICATION_POLICY_SET', 'CONVERSATION', $3,
                       'SUCCESS', $4, $5::jsonb)`,
            [
              input.tenantId,
              input.userId,
              input.conversationId,
              input.correlationId,
              JSON.stringify({ level: input.level, mutedUntil: input.mutedUntil }),
            ],
          );
          await client.query(
            `insert into audit.outbox_events (
               tenant_id, event_type, aggregate_id, correlation_id, payload
             ) values ($1, 'messaging.notification-policy.updated.v1', $2, $3, $4::jsonb)`,
            [
              input.tenantId,
              input.conversationId,
              input.correlationId,
              JSON.stringify({
                conversationId: input.conversationId,
                userId: input.userId,
                level: input.level,
                mutedUntil: input.mutedUntil,
              }),
            ],
          );
        }

        const stored = changed ? await readPolicy() : current;
        if (!stored) throw new Error('MESSAGING_NOTIFICATION_POLICY_READ_LOST');
        return { outcome: 'ok', policy: mapNotificationPolicy(stored), changed };
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
                      join games.games game
                        on game.tenant_id = participation.tenant_id
                       and game.id = participation.game_id
                       and game.lifecycle_state <> 'CANCELLED'
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
          recipientUserIdsSql({ requireRealtime: true, respectNotificationPolicy: false }),
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
