import {
  COMMUNITY_COMMENT_ARCHIVED_EVENT,
  COMMUNITY_COMMENT_CREATED_EVENT,
  COMMUNITY_COMMENT_EDITED_EVENT,
  COMMUNITY_COMMENT_RESTORED_EVENT,
  COMMUNITY_POST_ARCHIVED_EVENT,
  COMMUNITY_POST_CREATED_EVENT,
  COMMUNITY_POST_EDITED_EVENT,
  COMMUNITY_POST_RESTORED_EVENT,
  COMMUNITY_REACTION_CHANGED_EVENT,
  communityCommentSchema,
  communityPostSchema,
  communityReactionStateSchema,
  type CommunityChangeCommentInput,
  type CommunityChangePostInput,
  type CommunityComment,
  type CommunityCommentCommandResult,
  type CommunityContentRepository,
  type CommunityFeedRepositoryResult,
  type CommunityPost,
  type CommunityPostMedia,
  type CommunityPostCommandResult,
  type CommunityReactionCommandResult,
  type CommunityReactionState,
  type CommunityRemoveReactionInput,
  type CommunitySetReactionInput,
} from '@phub/communities';
import type { Pool, PoolClient, QueryResultRow } from 'pg';

import {
  attachReadyMediaToPostRevisionWithClient,
  type CommunityMediaAttachResult,
} from './community-media-repository.js';
import { queryOne, withTenantTransaction } from './connection.js';

type CommandType =
  | 'POST_CREATE'
  | 'POST_EDIT'
  | 'POST_ARCHIVE'
  | 'POST_RESTORE'
  | 'COMMENT_CREATE'
  | 'COMMENT_EDIT'
  | 'COMMENT_ARCHIVE'
  | 'COMMENT_RESTORE'
  | 'POST_REACTION_SET'
  | 'POST_REACTION_REMOVE'
  | 'COMMENT_REACTION_SET'
  | 'COMMENT_REACTION_REMOVE';

type MembershipRole = 'OWNER' | 'ADMIN' | 'MODERATOR' | 'MEMBER';

interface CommandRow extends QueryResultRow {
  readonly command_type: CommandType;
  readonly request_hash: string;
  readonly result_payload: unknown;
}

interface ActorRow extends QueryResultRow {
  readonly status: string;
}

interface CommunityContextRow extends QueryResultRow {
  readonly publishing_preset: 'OPEN_COMMUNITY' | 'STAFF_FEED' | 'MODERATED_FEED';
  readonly visibility: 'PUBLIC' | 'LISTED_PRIVATE' | 'HIDDEN';
  readonly membership_status: string | null;
  readonly membership_role: MembershipRole | null;
}

interface PostRow extends QueryResultRow {
  readonly id: string;
  readonly community_id: string;
  readonly author_user_id: string;
  readonly status: CommunityPost['status'];
  readonly body: string | null;
  readonly revision: number | string;
  readonly created_at: Date | string;
  readonly published_at: Date | string | null;
  readonly updated_at: Date | string;
  readonly archived_at: Date | string | null;
  readonly restore_until: Date | string | null;
  readonly retention_until: Date | string | null;
}

interface CommentRow extends QueryResultRow {
  readonly id: string;
  readonly community_id: string;
  readonly post_id: string;
  readonly author_user_id: string;
  readonly status: CommunityComment['status'];
  readonly body: string | null;
  readonly revision: number | string;
  readonly created_at: Date | string;
  readonly published_at: Date | string;
  readonly updated_at: Date | string;
  readonly archived_at: Date | string | null;
  readonly restore_until: Date | string | null;
  readonly retention_until: Date | string | null;
}

interface ReactionRow extends QueryResultRow {
  readonly reaction_type: 'LIKE' | 'DISLIKE' | null;
  readonly status: 'ACTIVE' | 'REMOVED';
  readonly revision: number | string;
  readonly updated_at: Date | string;
}

interface TimestampRow extends QueryResultRow {
  readonly watermark: Date | string;
}

interface AppliedCommandRow extends QueryResultRow {
  readonly sequence: number | string;
  readonly command_count: number | string;
  readonly audit_count: number | string;
  readonly outbox_count: number | string;
}

interface PostMediaRow extends QueryResultRow {
  readonly post_id: string;
  readonly media_id: string;
  readonly position: number | string;
  readonly variant_name: 'THUMBNAIL' | 'FEED';
  readonly size_bytes: number | string;
  readonly width: number | string;
  readonly height: number | string;
  readonly tenant_key: string;
}

const postColumns = `id, community_id, author_user_id, status, body, revision,
  created_at, published_at, updated_at, archived_at, restore_until, retention_until`;
const commentColumns = `id, community_id, post_id, author_user_id, status, body, revision,
  created_at, published_at, updated_at, archived_at, restore_until, retention_until`;

function iso(value: Date | string): string {
  return new Date(value).toISOString();
}

function isoOrNull(value: Date | string | null): string | null {
  return value === null ? null : iso(value);
}

function postState(row: PostRow): CommunityPost {
  if (row.body === null) throw new Error('COMMUNITY_POST_BODY_PURGED');
  return communityPostSchema.parse({
    id: row.id,
    communityId: row.community_id,
    authorUserId: row.author_user_id,
    status: row.status,
    body: row.body,
    revision: Number(row.revision),
    createdAt: iso(row.created_at),
    publishedAt: isoOrNull(row.published_at),
    updatedAt: iso(row.updated_at),
    archivedAt: isoOrNull(row.archived_at),
    restoreUntil: isoOrNull(row.restore_until),
    retentionUntil: isoOrNull(row.retention_until),
  });
}

export async function currentCommunityPostMediaWithClient(
  client: PoolClient,
  tenantId: string,
  communityId: string,
  postIds: readonly string[],
): Promise<ReadonlyMap<string, readonly CommunityPostMedia[]>> {
  if (postIds.length === 0) return new Map();
  const result = await client.query<PostMediaRow>(
    `select attachment.post_id, attachment.media_id, attachment.position,
            variant.variant_name, variant.size_bytes, variant.width, variant.height,
            tenant.tenant_key
       from community_content.posts post
       join community_content.post_revision_media attachment
         on attachment.tenant_id = post.tenant_id and attachment.community_id = post.community_id
        and attachment.post_id = post.id and attachment.post_revision = post.revision
       join community_content.media_assets media
         on media.tenant_id = attachment.tenant_id and media.community_id = attachment.community_id
        and media.id = attachment.media_id
       join community_content.media_variants variant
         on variant.tenant_id = media.tenant_id and variant.media_id = media.id
        and variant.state = 'ACTIVE'
       join identity.tenants tenant on tenant.id = post.tenant_id
      where post.tenant_id = $1 and post.community_id = $2 and post.id = any($3::uuid[])
      order by attachment.post_id, attachment.position, variant.variant_name`,
    [tenantId, communityId, postIds],
  );
  const posts = new Map<string, Map<string, CommunityPostMedia>>();
  for (const row of result.rows) {
    let media = posts.get(row.post_id);
    if (!media) {
      media = new Map();
      posts.set(row.post_id, media);
    }
    const existing = media.get(row.media_id);
    const variant = {
      variant: row.variant_name,
      url: `/user/api/v1/${row.tenant_key}/communities/${communityId}/media/${row.media_id}/variants/${row.variant_name}`,
      contentType: 'image/webp' as const,
      width: Number(row.width),
      height: Number(row.height),
      byteSize: Number(row.size_bytes),
    };
    if (existing) {
      media.set(row.media_id, { ...existing, variants: [...existing.variants, variant] });
    } else {
      media.set(row.media_id, {
        id: row.media_id,
        mediaType: 'IMAGE',
        width: Number(row.width),
        height: Number(row.height),
        variants: [variant],
      });
    }
  }
  return new Map(
    [...posts].map(([postId, media]) => [
      postId,
      [...media.values()].map((item) => ({
        ...item,
        width: Math.max(...item.variants.map((variant) => variant.width)),
        height: Math.max(...item.variants.map((variant) => variant.height)),
      })),
    ]),
  );
}

async function postStateWithMedia(
  client: PoolClient,
  tenantId: string,
  row: PostRow,
): Promise<CommunityPost> {
  const post = postState(row);
  const media = (
    await currentCommunityPostMediaWithClient(client, tenantId, row.community_id, [row.id])
  ).get(row.id);
  return communityPostSchema.parse({ ...post, ...(media?.length ? { media } : {}) });
}

export async function copyCommunityPostRevisionMediaWithClient(
  client: PoolClient,
  input: {
    readonly tenantId: string;
    readonly communityId: string;
    readonly postId: string;
    readonly fromRevision: number;
    readonly toRevision: number;
  },
): Promise<void> {
  await client.query(
    `insert into community_content.post_revision_media (
       tenant_id, community_id, post_id, post_revision, media_id, position
     )
     select tenant_id, community_id, post_id, $5, media_id, position
       from community_content.post_revision_media
      where tenant_id = $1 and community_id = $2 and post_id = $3 and post_revision = $4`,
    [input.tenantId, input.communityId, input.postId, input.fromRevision, input.toRevision],
  );
}

type MediaAttachmentFailure = Exclude<CommunityMediaAttachResult, { readonly outcome: 'attached' }>;

class CommunityMediaAttachmentError extends Error {
  public constructor(public readonly failure: MediaAttachmentFailure) {
    super(failure.outcome);
  }
}

function contentMediaFailure(error: CommunityMediaAttachmentError) {
  switch (error.failure.outcome) {
    case 'post_revision_not_found':
    case 'revision_attachment_conflict':
      return { outcome: 'media_attachment_conflict' as const };
    case 'media_not_ready':
      return { outcome: 'media_not_ready' as const };
    case 'media_not_owned':
      return { outcome: 'media_not_owned' as const };
    case 'media_already_bound':
      return { outcome: 'media_already_bound' as const };
  }
}

async function attachPostMedia(
  client: PoolClient,
  input: {
    readonly tenantId: string;
    readonly actorUserId: string;
    readonly communityId: string;
    readonly postId: string;
    readonly postRevision: number;
    readonly mediaIds: readonly string[];
    readonly correlationId: string;
  },
): Promise<void> {
  const result = await attachReadyMediaToPostRevisionWithClient(client, input);
  if (result.outcome !== 'attached') throw new CommunityMediaAttachmentError(result);
}

function commentState(row: CommentRow): CommunityComment {
  if (row.body === null) throw new Error('COMMUNITY_COMMENT_BODY_PURGED');
  return communityCommentSchema.parse({
    id: row.id,
    communityId: row.community_id,
    postId: row.post_id,
    authorUserId: row.author_user_id,
    status: row.status,
    body: row.body,
    revision: Number(row.revision),
    createdAt: iso(row.created_at),
    publishedAt: iso(row.published_at),
    updatedAt: iso(row.updated_at),
    archivedAt: isoOrNull(row.archived_at),
    restoreUntil: isoOrNull(row.restore_until),
    retentionUntil: isoOrNull(row.retention_until),
  });
}

function reactionState(
  targetType: 'POST' | 'COMMENT',
  targetId: string,
  row: ReactionRow,
): CommunityReactionState {
  return communityReactionStateSchema.parse({
    targetType,
    targetId,
    reaction: row.reaction_type,
    active: row.status === 'ACTIVE',
    revision: Number(row.revision),
    updatedAt: iso(row.updated_at),
  });
}

async function lockAndReadCommand(
  client: PoolClient,
  input: {
    readonly tenantId: string;
    readonly actorUserId: string;
    readonly idempotencyKey: string;
  },
): Promise<CommandRow | undefined> {
  await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
    `community-content-command:${input.tenantId}:${input.actorUserId}:${input.idempotencyKey}`,
  ]);
  return queryOne<CommandRow>(
    client,
    `select command_type, request_hash, result_payload
       from community_content.commands
      where tenant_id = $1 and actor_user_id = $2 and idempotency_key = $3
      for update`,
    [input.tenantId, input.actorUserId, input.idempotencyKey],
  );
}

function replayConflict(
  command: CommandRow,
  commandType: CommandType,
  requestHash: string,
): boolean {
  return command.command_type !== commandType || command.request_hash !== requestHash;
}

async function activeActor(client: PoolClient, tenantId: string, userId: string): Promise<boolean> {
  const row = await queryOne<ActorRow>(
    client,
    `select status from identity.users
      where tenant_id = $1 and id = $2
      for share`,
    [tenantId, userId],
  );
  return row?.status === 'ACTIVE';
}

async function communityContext(
  client: PoolClient,
  tenantId: string,
  communityId: string,
  userId: string,
): Promise<CommunityContextRow | undefined> {
  return queryOne<CommunityContextRow>(
    client,
    `select c.publishing_preset, c.visibility,
            m.status as membership_status, m.role as membership_role
       from communities.communities c
       left join communities.memberships m
         on m.tenant_id = c.tenant_id and m.community_id = c.id and m.user_id = $3
      where c.tenant_id = $1 and c.id = $2 and c.status = 'ACTIVE'`,
    [tenantId, communityId, userId],
  );
}

function activeRole(context: CommunityContextRow): MembershipRole | undefined {
  return context.membership_status === 'ACTIVE' && context.membership_role
    ? context.membership_role
    : undefined;
}

function postPublicationStatus(
  context: CommunityContextRow,
  role: MembershipRole,
): 'PUBLISHED' | 'PENDING_MODERATION' | undefined {
  const staff = role !== 'MEMBER';
  if (context.publishing_preset === 'STAFF_FEED' && !staff) return undefined;
  if (context.publishing_preset === 'MODERATED_FEED' && !staff) return 'PENDING_MODERATION';
  return 'PUBLISHED';
}

async function recordAppliedCommand(
  client: PoolClient,
  input: {
    readonly tenantId: string;
    readonly actorUserId: string;
    readonly communityId: string;
    readonly idempotencyKey: string;
    readonly requestHash: string;
    readonly correlationId: string;
  },
  details: {
    readonly commandType: CommandType;
    readonly targetId: string;
    readonly action: string;
    readonly resourceType: 'COMMUNITY_POST' | 'COMMUNITY_COMMENT' | 'COMMUNITY_REACTION';
    readonly eventType: string;
    readonly result: CommunityPost | CommunityComment | CommunityReactionState;
  },
): Promise<void> {
  const targetType =
    details.resourceType === 'COMMUNITY_POST'
      ? ('POST' as const)
      : details.resourceType === 'COMMUNITY_COMMENT'
        ? ('COMMENT' as const)
        : ('REACTION' as const);
  const status = 'status' in details.result ? details.result.status : undefined;
  const revision = details.result.revision;
  const applied = await client.query<AppliedCommandRow>(
    `with allocated_event_sequence as (
       insert into community_content.event_heads (
         tenant_id, community_id, last_sequence, retained_from_sequence, retention_due_at
       ) values ($1, $3, 1, 1, transaction_timestamp() + interval '30 days')
       on conflict (tenant_id, community_id) do update
         set last_sequence = community_content.event_heads.last_sequence + 1,
             retention_due_at = case
               when community_content.event_heads.retained_from_sequence =
                    community_content.event_heads.last_sequence + 1
                 then transaction_timestamp() + interval '30 days'
               else community_content.event_heads.retention_due_at
             end,
             updated_at = now()
       returning last_sequence
     ), inserted_event as (
       insert into community_content.events (
         tenant_id, community_id, sequence, event_type, target_type,
         target_id, target_revision, target_status
       )
       select $1, $3, allocated.last_sequence, $9, $10, $5, $11, $12
         from allocated_event_sequence allocated
       returning sequence
     ), command_record as (
       insert into community_content.commands (
         tenant_id, actor_user_id, community_id, command_type, target_id,
         idempotency_key, request_hash, result_payload
       )
       select $1, $2, $3, $4, $5, $6, $7, $8::jsonb
         from inserted_event
       returning 1
     ), audit_record as (
       insert into audit.audit_log (
         tenant_id, actor_id, action, resource_type, resource_id,
         result, correlation_id, new_value
       )
       select $1, $2, $13, $14, $5, 'SUCCESS', $15,
              jsonb_strip_nulls(jsonb_build_object(
                'communityId', $3::uuid,
                'sequence', inserted_event.sequence,
                'targetType', $10::text,
                'revision', $11::bigint,
                'status', $12::text
              ))
         from inserted_event
       returning 1
     ), outbox_record as (
       insert into audit.outbox_events (
         tenant_id, event_type, aggregate_id, correlation_id, payload
       )
       select $1, $9, $5, $15,
              jsonb_strip_nulls(jsonb_build_object(
                'communityId', $3::uuid,
                'sequence', inserted_event.sequence,
                'targetId', $5::uuid,
                'targetType', $10::text,
                'revision', $11::bigint,
                'status', $12::text
              ))
         from inserted_event
       returning 1
     )
     select inserted_event.sequence,
            (select count(*)::integer from command_record) as command_count,
            (select count(*)::integer from audit_record) as audit_count,
            (select count(*)::integer from outbox_record) as outbox_count
       from inserted_event`,
    [
      input.tenantId,
      input.actorUserId,
      input.communityId,
      details.commandType,
      details.targetId,
      input.idempotencyKey,
      input.requestHash,
      JSON.stringify(details.result),
      details.eventType,
      targetType,
      revision,
      status ?? null,
      details.action,
      details.resourceType,
      input.correlationId,
    ],
  );
  const evidence = applied.rows[0];
  if (!evidence) throw new Error('COMMUNITY_EVENT_SEQUENCE_INVALID');
  const sequence = Number(evidence.sequence);
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new Error('COMMUNITY_EVENT_SEQUENCE_INVALID');
  }
  if (
    Number(evidence.command_count) !== 1 ||
    Number(evidence.audit_count) !== 1 ||
    Number(evidence.outbox_count) !== 1
  ) {
    throw new Error('COMMUNITY_CONTENT_COMMAND_EVIDENCE_INVALID');
  }
}

async function insertPostRevision(
  client: PoolClient,
  tenantId: string,
  actorUserId: string,
  post: CommunityPost,
): Promise<void> {
  await client.query(
    `insert into community_content.post_revisions (
       tenant_id, post_id, revision, body, lifecycle_status, changed_by_user_id
     ) values ($1, $2, $3, $4, $5, $6)`,
    [tenantId, post.id, post.revision, post.body, post.status, actorUserId],
  );
}

async function insertCommentRevision(
  client: PoolClient,
  tenantId: string,
  actorUserId: string,
  comment: CommunityComment,
): Promise<void> {
  await client.query(
    `insert into community_content.comment_revisions (
       tenant_id, comment_id, revision, body, lifecycle_status, changed_by_user_id
     ) values ($1, $2, $3, $4, $5, $6)`,
    [tenantId, comment.id, comment.revision, comment.body, comment.status, actorUserId],
  );
}

function replayedPost(
  command: CommandRow,
  outcome: 'created' | 'edited' | 'archived' | 'restored',
) {
  return {
    outcome,
    post: communityPostSchema.parse(command.result_payload),
    replayed: true,
  } as const;
}

function replayedComment(
  command: CommandRow,
  outcome: 'created' | 'edited' | 'archived' | 'restored',
) {
  return {
    outcome,
    comment: communityCommentSchema.parse(command.result_payload),
    replayed: true,
  } as const;
}

function replayedReaction(command: CommandRow) {
  return {
    outcome: 'changed' as const,
    reaction: communityReactionStateSchema.parse(command.result_payload),
    replayed: true,
  };
}

async function requireCommandContext(
  client: PoolClient,
  input: { readonly tenantId: string; readonly actorUserId: string; readonly communityId: string },
): Promise<
  | { readonly outcome: 'actor_not_active' | 'community_not_found' | 'membership_required' }
  | { readonly context: CommunityContextRow; readonly role: MembershipRole }
> {
  if (!(await activeActor(client, input.tenantId, input.actorUserId))) {
    return { outcome: 'actor_not_active' };
  }
  const context = await communityContext(
    client,
    input.tenantId,
    input.communityId,
    input.actorUserId,
  );
  if (!context) return { outcome: 'community_not_found' };
  const role = activeRole(context);
  if (!role) return { outcome: 'membership_required' };
  return { context, role };
}

export function createCommunityContentRepository(pool: Pool): CommunityContentRepository {
  return {
    createPost(input): Promise<CommunityPostCommandResult> {
      return withTenantTransaction(
        pool,
        input.tenantId,
        async (client): Promise<CommunityPostCommandResult> => {
          const command = await lockAndReadCommand(client, input);
          if (command) {
            return replayConflict(command, 'POST_CREATE', input.requestHash)
              ? { outcome: 'idempotency_conflict' }
              : replayedPost(command, 'created');
          }
          const authorized = await requireCommandContext(client, input);
          if ('outcome' in authorized) return authorized;
          const status = postPublicationStatus(authorized.context, authorized.role);
          if (!status) return { outcome: 'publishing_forbidden' };

          const row = await queryOne<PostRow>(
            client,
            `insert into community_content.posts (
             tenant_id, community_id, author_user_id, status, body, revision, published_at
           ) values ($1, $2, $3, $4, $5, 1,
                     case when $4 = 'PUBLISHED' then now() else null end)
           returning ${postColumns}`,
            [input.tenantId, input.communityId, input.actorUserId, status, input.body],
          );
          if (!row) throw new Error('COMMUNITY_POST_INSERT_FAILED');
          const initialPost = postState(row);
          await insertPostRevision(client, input.tenantId, input.actorUserId, initialPost);
          if (input.mediaIds?.length) {
            await attachPostMedia(client, {
              tenantId: input.tenantId,
              actorUserId: input.actorUserId,
              communityId: input.communityId,
              postId: initialPost.id,
              postRevision: initialPost.revision,
              mediaIds: input.mediaIds,
              correlationId: input.correlationId,
            });
          }
          const post = await postStateWithMedia(client, input.tenantId, row);
          await recordAppliedCommand(client, input, {
            commandType: 'POST_CREATE',
            targetId: post.id,
            action: 'COMMUNITY_POST_CREATED',
            resourceType: 'COMMUNITY_POST',
            eventType: COMMUNITY_POST_CREATED_EVENT,
            result: post,
          });
          return { outcome: 'created', post, replayed: false };
        },
      ).catch((error: unknown) => {
        if (error instanceof CommunityMediaAttachmentError) return contentMediaFailure(error);
        throw error;
      });
    },

    editPost(input): Promise<CommunityPostCommandResult> {
      return withTenantTransaction(
        pool,
        input.tenantId,
        async (client): Promise<CommunityPostCommandResult> => {
          const command = await lockAndReadCommand(client, input);
          if (command) {
            return replayConflict(command, 'POST_EDIT', input.requestHash)
              ? { outcome: 'idempotency_conflict' }
              : replayedPost(command, 'edited');
          }
          const authorized = await requireCommandContext(client, input);
          if ('outcome' in authorized) return authorized;
          const current = await queryOne<PostRow>(
            client,
            `select ${postColumns} from community_content.posts
            where tenant_id = $1 and community_id = $2 and id = $3
            for update`,
            [input.tenantId, input.communityId, input.postId],
          );
          if (!current) return { outcome: 'post_not_found' };
          if (current.author_user_id !== input.actorUserId) return { outcome: 'not_author' };
          if (!['PUBLISHED', 'PENDING_MODERATION', 'HIDDEN'].includes(current.status)) {
            return { outcome: 'content_not_editable' };
          }
          const revision = Number(current.revision);
          if (revision !== input.expectedRevision) {
            return { outcome: 'revision_conflict', currentRevision: revision };
          }
          const status =
            current.status === 'HIDDEN'
              ? 'PENDING_MODERATION'
              : postPublicationStatus(authorized.context, authorized.role);
          if (!status) return { outcome: 'publishing_forbidden' };
          const row = await queryOne<PostRow>(
            client,
            `update community_content.posts
              set body = $4, status = $5, revision = revision + 1, updated_at = now(),
                  published_at = case
                    when status = 'HIDDEN' then null
                    when $5 = 'PUBLISHED' then coalesce(published_at, now())
                    else published_at
                  end,
                  hidden_at = null
            where tenant_id = $1 and community_id = $2 and id = $3 and revision = $6
          returning ${postColumns}`,
            [
              input.tenantId,
              input.communityId,
              input.postId,
              input.body,
              status,
              input.expectedRevision,
            ],
          );
          if (!row) throw new Error('COMMUNITY_POST_EDIT_FAILED');
          const initialPost = postState(row);
          await insertPostRevision(client, input.tenantId, input.actorUserId, initialPost);
          if (input.mediaIds === undefined) {
            await copyCommunityPostRevisionMediaWithClient(client, {
              tenantId: input.tenantId,
              communityId: input.communityId,
              postId: initialPost.id,
              fromRevision: revision,
              toRevision: initialPost.revision,
            });
          } else if (input.mediaIds.length > 0) {
            await attachPostMedia(client, {
              tenantId: input.tenantId,
              actorUserId: input.actorUserId,
              communityId: input.communityId,
              postId: initialPost.id,
              postRevision: initialPost.revision,
              mediaIds: input.mediaIds,
              correlationId: input.correlationId,
            });
          }
          const post = await postStateWithMedia(client, input.tenantId, row);
          await recordAppliedCommand(client, input, {
            commandType: 'POST_EDIT',
            targetId: post.id,
            action: 'COMMUNITY_POST_EDITED',
            resourceType: 'COMMUNITY_POST',
            eventType: COMMUNITY_POST_EDITED_EVENT,
            result: post,
          });
          return { outcome: 'edited', post, replayed: false };
        },
      ).catch((error: unknown) => {
        if (error instanceof CommunityMediaAttachmentError) return contentMediaFailure(error);
        throw error;
      });
    },

    archivePost(input): Promise<CommunityPostCommandResult> {
      return changePostLifecycle(pool, input, 'ARCHIVE');
    },

    restorePost(input): Promise<CommunityPostCommandResult> {
      return changePostLifecycle(pool, input, 'RESTORE');
    },

    createComment(input): Promise<CommunityCommentCommandResult> {
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        const command = await lockAndReadCommand(client, input);
        if (command) {
          return replayConflict(command, 'COMMENT_CREATE', input.requestHash)
            ? { outcome: 'idempotency_conflict' }
            : replayedComment(command, 'created');
        }
        const authorized = await requireCommandContext(client, input);
        if ('outcome' in authorized) return authorized;
        const post = await queryOne<PostRow>(
          client,
          `select ${postColumns} from community_content.posts
            where tenant_id = $1 and community_id = $2 and id = $3 and status = 'PUBLISHED'
            for share`,
          [input.tenantId, input.communityId, input.postId],
        );
        if (!post) return { outcome: 'post_not_found' };
        const row = await queryOne<CommentRow>(
          client,
          `insert into community_content.comments (
             tenant_id, community_id, post_id, author_user_id, status, body, revision
           ) values ($1, $2, $3, $4, 'PUBLISHED', $5, 1)
           returning ${commentColumns}`,
          [input.tenantId, input.communityId, input.postId, input.actorUserId, input.body],
        );
        if (!row) throw new Error('COMMUNITY_COMMENT_INSERT_FAILED');
        const comment = commentState(row);
        await insertCommentRevision(client, input.tenantId, input.actorUserId, comment);
        await recordAppliedCommand(client, input, {
          commandType: 'COMMENT_CREATE',
          targetId: comment.id,
          action: 'COMMUNITY_COMMENT_CREATED',
          resourceType: 'COMMUNITY_COMMENT',
          eventType: COMMUNITY_COMMENT_CREATED_EVENT,
          result: comment,
        });
        return { outcome: 'created', comment, replayed: false };
      });
    },

    editComment(input): Promise<CommunityCommentCommandResult> {
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        const command = await lockAndReadCommand(client, input);
        if (command) {
          return replayConflict(command, 'COMMENT_EDIT', input.requestHash)
            ? { outcome: 'idempotency_conflict' }
            : replayedComment(command, 'edited');
        }
        const authorized = await requireCommandContext(client, input);
        if ('outcome' in authorized) return authorized;
        const current = await queryOne<CommentRow>(
          client,
          `select ${commentColumns} from community_content.comments
            where tenant_id = $1 and community_id = $2 and post_id = $3 and id = $4
            for update`,
          [input.tenantId, input.communityId, input.postId, input.commentId],
        );
        if (!current) return { outcome: 'comment_not_found' };
        if (current.author_user_id !== input.actorUserId) return { outcome: 'not_author' };
        if (current.status !== 'PUBLISHED') return { outcome: 'content_not_editable' };
        const revision = Number(current.revision);
        if (revision !== input.expectedRevision) {
          return { outcome: 'revision_conflict', currentRevision: revision };
        }
        const row = await queryOne<CommentRow>(
          client,
          `update community_content.comments
              set body = $5, revision = revision + 1, updated_at = now()
            where tenant_id = $1 and community_id = $2 and post_id = $3 and id = $4
              and revision = $6
          returning ${commentColumns}`,
          [
            input.tenantId,
            input.communityId,
            input.postId,
            input.commentId,
            input.body,
            input.expectedRevision,
          ],
        );
        if (!row) throw new Error('COMMUNITY_COMMENT_EDIT_FAILED');
        const comment = commentState(row);
        await insertCommentRevision(client, input.tenantId, input.actorUserId, comment);
        await recordAppliedCommand(client, input, {
          commandType: 'COMMENT_EDIT',
          targetId: comment.id,
          action: 'COMMUNITY_COMMENT_EDITED',
          resourceType: 'COMMUNITY_COMMENT',
          eventType: COMMUNITY_COMMENT_EDITED_EVENT,
          result: comment,
        });
        return { outcome: 'edited', comment, replayed: false };
      });
    },

    archiveComment(input): Promise<CommunityCommentCommandResult> {
      return changeCommentLifecycle(pool, input, 'ARCHIVE');
    },

    restoreComment(input): Promise<CommunityCommentCommandResult> {
      return changeCommentLifecycle(pool, input, 'RESTORE');
    },

    setReaction(input): Promise<CommunityReactionCommandResult> {
      return changeReaction(pool, input, 'SET');
    },

    removeReaction(input): Promise<CommunityReactionCommandResult> {
      return changeReaction(pool, input, 'REMOVE');
    },

    listFeed(input): Promise<CommunityFeedRepositoryResult> {
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        if (!(await activeActor(client, input.tenantId, input.viewerUserId))) {
          return { outcome: 'actor_not_active' };
        }
        const context = await communityContext(
          client,
          input.tenantId,
          input.communityId,
          input.viewerUserId,
        );
        if (!context || (context.visibility !== 'PUBLIC' && !activeRole(context))) {
          return { outcome: 'community_not_found' };
        }
        let watermark = input.watermark;
        if (!watermark) {
          const row = await queryOne<TimestampRow>(
            client,
            'select transaction_timestamp() as watermark',
          );
          if (!row) throw new Error('COMMUNITY_FEED_WATERMARK_FAILED');
          watermark = iso(row.watermark);
        }
        const result = await client.query<PostRow>(
          `select ${postColumns}
             from community_content.posts
            where tenant_id = $1 and community_id = $2 and status = 'PUBLISHED'
              and published_at <= $3::timestamptz
              and ($4::timestamptz is null or (published_at, id) < ($4::timestamptz, $5::uuid))
            order by published_at desc, id desc
            limit $6`,
          [
            input.tenantId,
            input.communityId,
            watermark,
            input.after?.publishedAt ?? null,
            input.after?.id ?? null,
            input.limit + 1,
          ],
        );
        const pageRows = result.rows.slice(0, input.limit);
        const mediaByPost = await currentCommunityPostMediaWithClient(
          client,
          input.tenantId,
          input.communityId,
          pageRows.map((row) => row.id),
        );
        return {
          outcome: 'found',
          items: pageRows.map((row) => {
            const media = mediaByPost.get(row.id);
            return communityPostSchema.parse({
              ...postState(row),
              ...(media?.length ? { media } : {}),
            });
          }),
          watermark,
          hasMore: result.rows.length > input.limit,
        };
      });
    },

    listComments(input) {
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        if (!(await activeActor(client, input.tenantId, input.viewerUserId))) {
          return { outcome: 'actor_not_active' as const };
        }
        const context = await communityContext(
          client,
          input.tenantId,
          input.communityId,
          input.viewerUserId,
        );
        if (!context || (context.visibility !== 'PUBLIC' && !activeRole(context))) {
          return { outcome: 'community_not_found' as const };
        }
        const post = await queryOne<PostRow>(
          client,
          `select ${postColumns} from community_content.posts
            where tenant_id = $1 and community_id = $2 and id = $3 and status = 'PUBLISHED'
            for share`,
          [input.tenantId, input.communityId, input.postId],
        );
        if (!post) return { outcome: 'post_not_found' as const };
        let watermark = input.watermark;
        if (!watermark) {
          const row = await queryOne<TimestampRow>(
            client,
            'select transaction_timestamp() as watermark',
          );
          if (!row) throw new Error('COMMUNITY_COMMENT_WATERMARK_FAILED');
          watermark = iso(row.watermark);
        }
        const result = await client.query<CommentRow>(
          `select ${commentColumns}
             from community_content.comments
            where tenant_id = $1 and community_id = $2 and post_id = $3
              and status = 'PUBLISHED' and published_at <= $4::timestamptz
              and ($5::timestamptz is null or (published_at, id) > ($5::timestamptz, $6::uuid))
            order by published_at, id
            limit $7`,
          [
            input.tenantId,
            input.communityId,
            input.postId,
            watermark,
            input.after?.publishedAt ?? null,
            input.after?.id ?? null,
            input.limit + 1,
          ],
        );
        return {
          outcome: 'found' as const,
          items: result.rows.slice(0, input.limit).map(commentState),
          watermark,
          hasMore: result.rows.length > input.limit,
        };
      });
    },
  };
}

async function changePostLifecycle(
  pool: Pool,
  input: CommunityChangePostInput,
  operation: 'ARCHIVE' | 'RESTORE',
): Promise<CommunityPostCommandResult> {
  return withTenantTransaction(pool, input.tenantId, async (client) => {
    const commandType: CommandType = operation === 'ARCHIVE' ? 'POST_ARCHIVE' : 'POST_RESTORE';
    const command = await lockAndReadCommand(client, input);
    if (command) {
      return replayConflict(command, commandType, input.requestHash)
        ? { outcome: 'idempotency_conflict' }
        : replayedPost(command, operation === 'ARCHIVE' ? 'archived' : 'restored');
    }
    const authorized = await requireCommandContext(client, input);
    if ('outcome' in authorized) return authorized;
    const current = await queryOne<PostRow>(
      client,
      `select ${postColumns} from community_content.posts
        where tenant_id = $1 and community_id = $2 and id = $3
        for update`,
      [input.tenantId, input.communityId, input.postId],
    );
    if (!current) return { outcome: 'post_not_found' };
    if (current.author_user_id !== input.actorUserId) return { outcome: 'not_author' };
    const revision = Number(current.revision);
    if (revision !== input.expectedRevision) {
      return { outcome: 'revision_conflict', currentRevision: revision };
    }

    let row: PostRow | undefined;
    if (operation === 'ARCHIVE') {
      if (!['PUBLISHED', 'PENDING_MODERATION'].includes(current.status)) {
        return { outcome: 'content_not_editable' };
      }
      row = await queryOne<PostRow>(
        client,
        `update community_content.posts
            set status = 'ARCHIVED', revision = revision + 1, updated_at = now(),
                archived_at = now(), restore_until = now() + interval '30 days',
                retention_until = now() + interval '5 years'
          where tenant_id = $1 and community_id = $2 and id = $3 and revision = $4
        returning ${postColumns}`,
        [input.tenantId, input.communityId, input.postId, input.expectedRevision],
      );
    } else {
      if (current.status !== 'ARCHIVED') return { outcome: 'content_not_archived' };
      const status = postPublicationStatus(authorized.context, authorized.role);
      if (!status) return { outcome: 'publishing_forbidden' };
      row = await queryOne<PostRow>(
        client,
        `update community_content.posts
            set status = $5, revision = revision + 1, updated_at = now(),
                published_at = case when $5 = 'PUBLISHED' then coalesce(published_at, now()) else published_at end,
                archived_at = null, restore_until = null, retention_until = null
          where tenant_id = $1 and community_id = $2 and id = $3 and revision = $4
            and restore_until >= now()
        returning ${postColumns}`,
        [input.tenantId, input.communityId, input.postId, input.expectedRevision, status],
      );
      if (!row) return { outcome: 'restore_expired' };
    }
    if (!row) throw new Error('COMMUNITY_POST_LIFECYCLE_UPDATE_FAILED');
    const initialPost = postState(row);
    await insertPostRevision(client, input.tenantId, input.actorUserId, initialPost);
    await copyCommunityPostRevisionMediaWithClient(client, {
      tenantId: input.tenantId,
      communityId: input.communityId,
      postId: initialPost.id,
      fromRevision: revision,
      toRevision: initialPost.revision,
    });
    await client.query(
      `update community_content.media_assets
          set retention_until = $4::timestamptz, updated_at = now()
        where tenant_id = $1 and community_id = $2 and bound_post_id = $3 and state = 'READY'`,
      [input.tenantId, input.communityId, input.postId, initialPost.retentionUntil],
    );
    const post = await postStateWithMedia(client, input.tenantId, row);
    const archived = operation === 'ARCHIVE';
    await recordAppliedCommand(client, input, {
      commandType,
      targetId: post.id,
      action: archived ? 'COMMUNITY_POST_ARCHIVED' : 'COMMUNITY_POST_RESTORED',
      resourceType: 'COMMUNITY_POST',
      eventType: archived ? COMMUNITY_POST_ARCHIVED_EVENT : COMMUNITY_POST_RESTORED_EVENT,
      result: post,
    });
    return { outcome: archived ? 'archived' : 'restored', post, replayed: false };
  });
}

async function changeCommentLifecycle(
  pool: Pool,
  input: CommunityChangeCommentInput,
  operation: 'ARCHIVE' | 'RESTORE',
): Promise<CommunityCommentCommandResult> {
  return withTenantTransaction(pool, input.tenantId, async (client) => {
    const commandType: CommandType =
      operation === 'ARCHIVE' ? 'COMMENT_ARCHIVE' : 'COMMENT_RESTORE';
    const command = await lockAndReadCommand(client, input);
    if (command) {
      return replayConflict(command, commandType, input.requestHash)
        ? { outcome: 'idempotency_conflict' }
        : replayedComment(command, operation === 'ARCHIVE' ? 'archived' : 'restored');
    }
    const authorized = await requireCommandContext(client, input);
    if ('outcome' in authorized) return authorized;
    const current = await queryOne<CommentRow>(
      client,
      `select ${commentColumns} from community_content.comments
        where tenant_id = $1 and community_id = $2 and post_id = $3 and id = $4
        for update`,
      [input.tenantId, input.communityId, input.postId, input.commentId],
    );
    if (!current) return { outcome: 'comment_not_found' };
    if (current.author_user_id !== input.actorUserId) return { outcome: 'not_author' };
    const revision = Number(current.revision);
    if (revision !== input.expectedRevision) {
      return { outcome: 'revision_conflict', currentRevision: revision };
    }

    let row: CommentRow | undefined;
    if (operation === 'ARCHIVE') {
      if (current.status !== 'PUBLISHED') return { outcome: 'content_not_editable' };
      row = await queryOne<CommentRow>(
        client,
        `update community_content.comments
            set status = 'ARCHIVED', revision = revision + 1, updated_at = now(),
                archived_at = now(), restore_until = now() + interval '30 days',
                retention_until = now() + interval '5 years'
          where tenant_id = $1 and community_id = $2 and post_id = $3 and id = $4
            and revision = $5
        returning ${commentColumns}`,
        [input.tenantId, input.communityId, input.postId, input.commentId, input.expectedRevision],
      );
    } else {
      if (current.status !== 'ARCHIVED') return { outcome: 'content_not_archived' };
      const parent = await queryOne<PostRow>(
        client,
        `select ${postColumns} from community_content.posts
          where tenant_id = $1 and community_id = $2 and id = $3 and status = 'PUBLISHED'
          for share`,
        [input.tenantId, input.communityId, input.postId],
      );
      if (!parent) return { outcome: 'post_not_found' };
      row = await queryOne<CommentRow>(
        client,
        `update community_content.comments
            set status = 'PUBLISHED', revision = revision + 1, updated_at = now(),
                archived_at = null, restore_until = null, retention_until = null
          where tenant_id = $1 and community_id = $2 and post_id = $3 and id = $4
            and revision = $5 and restore_until >= now()
        returning ${commentColumns}`,
        [input.tenantId, input.communityId, input.postId, input.commentId, input.expectedRevision],
      );
      if (!row) return { outcome: 'restore_expired' };
    }
    if (!row) throw new Error('COMMUNITY_COMMENT_LIFECYCLE_UPDATE_FAILED');
    const comment = commentState(row);
    await insertCommentRevision(client, input.tenantId, input.actorUserId, comment);
    const archived = operation === 'ARCHIVE';
    await recordAppliedCommand(client, input, {
      commandType,
      targetId: comment.id,
      action: archived ? 'COMMUNITY_COMMENT_ARCHIVED' : 'COMMUNITY_COMMENT_RESTORED',
      resourceType: 'COMMUNITY_COMMENT',
      eventType: archived ? COMMUNITY_COMMENT_ARCHIVED_EVENT : COMMUNITY_COMMENT_RESTORED_EVENT,
      result: comment,
    });
    return { outcome: archived ? 'archived' : 'restored', comment, replayed: false };
  });
}

async function changeReaction(
  pool: Pool,
  input: CommunitySetReactionInput | CommunityRemoveReactionInput,
  operation: 'SET' | 'REMOVE',
): Promise<CommunityReactionCommandResult> {
  return withTenantTransaction(pool, input.tenantId, async (client) => {
    const commandType =
      `${input.targetType}_${operation === 'SET' ? 'REACTION_SET' : 'REACTION_REMOVE'}` as CommandType;
    const command = await lockAndReadCommand(client, input);
    if (command) {
      return replayConflict(command, commandType, input.requestHash)
        ? { outcome: 'idempotency_conflict' }
        : replayedReaction(command);
    }
    const authorized = await requireCommandContext(client, input);
    if ('outcome' in authorized) return authorized;

    if (input.targetType === 'POST') {
      const target = await queryOne<PostRow>(
        client,
        `select ${postColumns} from community_content.posts
          where tenant_id = $1 and community_id = $2 and id = $3 and status = 'PUBLISHED'
          for share`,
        [input.tenantId, input.communityId, input.targetId],
      );
      if (!target) return { outcome: 'post_not_found' };
    } else {
      const target = await queryOne<QueryResultRow>(
        client,
        `select c.id
           from community_content.comments c
           join community_content.posts p
             on p.tenant_id = c.tenant_id
            and p.community_id = c.community_id
            and p.id = c.post_id
          where c.tenant_id = $1 and c.community_id = $2 and c.id = $3
            and c.status = 'PUBLISHED' and p.status = 'PUBLISHED'
          for share of c, p`,
        [input.tenantId, input.communityId, input.targetId],
      );
      if (!target) return { outcome: 'comment_not_found' };
    }

    const table = input.targetType === 'POST' ? 'post_reactions' : 'comment_reactions';
    const targetColumn = input.targetType === 'POST' ? 'post_id' : 'comment_id';
    const reaction = operation === 'SET' ? (input as CommunitySetReactionInput).reaction : null;
    const row = await queryOne<ReactionRow>(
      client,
      `insert into community_content.${table} (
         tenant_id, ${targetColumn}, user_id, reaction_type, status, revision, removed_at
       ) values ($1, $2, $3, $4, $5, 1, case when $5 = 'REMOVED' then now() else null end)
       on conflict (tenant_id, ${targetColumn}, user_id) do update
         set reaction_type = excluded.reaction_type,
             status = excluded.status,
             revision = community_content.${table}.revision + 1,
             updated_at = now(),
             removed_at = excluded.removed_at
       returning reaction_type, status, revision, updated_at`,
      [
        input.tenantId,
        input.targetId,
        input.actorUserId,
        reaction,
        operation === 'SET' ? 'ACTIVE' : 'REMOVED',
      ],
    );
    if (!row) throw new Error('COMMUNITY_REACTION_CHANGE_FAILED');
    const state = reactionState(input.targetType, input.targetId, row);
    await recordAppliedCommand(client, input, {
      commandType,
      targetId: input.targetId,
      action: operation === 'SET' ? 'COMMUNITY_REACTION_SET' : 'COMMUNITY_REACTION_REMOVED',
      resourceType: 'COMMUNITY_REACTION',
      eventType: COMMUNITY_REACTION_CHANGED_EVENT,
      result: state,
    });
    return { outcome: 'changed', reaction: state, replayed: false };
  });
}
