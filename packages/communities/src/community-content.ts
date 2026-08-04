import { z } from 'zod';

import { COMMUNITY_MEDIA_MAX_PER_POST, communityPostMediaSchema } from './community-media.js';

const uuid = z.string().uuid();
const dateTime = z.string().datetime({ offset: true });
const positiveRevision = z.number().int().positive();

export const COMMUNITY_REACTIONS = ['LIKE', 'DISLIKE'] as const;
export const COMMUNITY_POST_CREATED_EVENT = 'community.post.created.v1' as const;
export const COMMUNITY_POST_EDITED_EVENT = 'community.post.edited.v1' as const;
export const COMMUNITY_POST_ARCHIVED_EVENT = 'community.post.archived.v1' as const;
export const COMMUNITY_POST_RESTORED_EVENT = 'community.post.restored.v1' as const;
export const COMMUNITY_COMMENT_CREATED_EVENT = 'community.comment.created.v1' as const;
export const COMMUNITY_COMMENT_EDITED_EVENT = 'community.comment.edited.v1' as const;
export const COMMUNITY_COMMENT_ARCHIVED_EVENT = 'community.comment.archived.v1' as const;
export const COMMUNITY_COMMENT_RESTORED_EVENT = 'community.comment.restored.v1' as const;
export const COMMUNITY_REACTION_CHANGED_EVENT = 'community.reaction.changed.v1' as const;

export const communityPostSchema = z
  .object({
    id: uuid,
    communityId: uuid,
    authorUserId: uuid,
    status: z.enum(['PENDING_MODERATION', 'PUBLISHED', 'ARCHIVED', 'HIDDEN']),
    body: z.string().min(1).max(10_000),
    revision: positiveRevision,
    createdAt: dateTime,
    publishedAt: dateTime.nullable(),
    updatedAt: dateTime,
    archivedAt: dateTime.nullable(),
    restoreUntil: dateTime.nullable(),
    retentionUntil: dateTime.nullable(),
    media: z.array(communityPostMediaSchema).max(COMMUNITY_MEDIA_MAX_PER_POST).optional(),
  })
  .strict();

export const communityCommentSchema = z
  .object({
    id: uuid,
    communityId: uuid,
    postId: uuid,
    authorUserId: uuid,
    status: z.enum(['PUBLISHED', 'ARCHIVED', 'HIDDEN']),
    body: z.string().min(1).max(2_000),
    revision: positiveRevision,
    createdAt: dateTime,
    publishedAt: dateTime,
    updatedAt: dateTime,
    archivedAt: dateTime.nullable(),
    restoreUntil: dateTime.nullable(),
    retentionUntil: dateTime.nullable(),
  })
  .strict();

export const communityReactionStateSchema = z
  .object({
    targetType: z.enum(['POST', 'COMMENT']),
    targetId: uuid,
    reaction: z.enum(COMMUNITY_REACTIONS).nullable(),
    active: z.boolean(),
    revision: positiveRevision,
    updatedAt: dateTime,
  })
  .strict()
  .refine((value) => value.active === (value.reaction !== null), { path: ['reaction'] });

export type CommunityPost = z.infer<typeof communityPostSchema>;
export type CommunityComment = z.infer<typeof communityCommentSchema>;
export type CommunityReactionState = z.infer<typeof communityReactionStateSchema>;

export const communityFeedPageSchema = z
  .object({
    items: z.array(communityPostSchema.extend({ status: z.literal('PUBLISHED') })).max(50),
    watermark: dateTime,
    nextCursor: z.string().min(16).max(1_024).optional(),
  })
  .strict();

export type CommunityFeedPage = z.infer<typeof communityFeedPageSchema>;

export const communityCommentPageSchema = z
  .object({
    items: z.array(communityCommentSchema.extend({ status: z.literal('PUBLISHED') })).max(50),
    watermark: dateTime,
    nextCursor: z.string().min(16).max(1_024).optional(),
  })
  .strict();

export type CommunityCommentPage = z.infer<typeof communityCommentPageSchema>;

interface IdempotentCommandInput {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly communityId: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly correlationId: string;
}

export interface CommunityCreatePostInput extends IdempotentCommandInput {
  readonly body: string;
  readonly mediaIds?: string[] | undefined;
}

export interface CommunityChangePostInput extends IdempotentCommandInput {
  readonly postId: string;
  readonly expectedRevision: number;
}

export interface CommunityEditPostInput extends CommunityChangePostInput {
  readonly body: string;
  /** Omitted preserves the current ordered media snapshot; an empty array removes all media. */
  readonly mediaIds?: string[] | undefined;
}

export interface CommunityCreateCommentInput extends IdempotentCommandInput {
  readonly postId: string;
  readonly body: string;
}

export interface CommunityChangeCommentInput extends IdempotentCommandInput {
  readonly postId: string;
  readonly commentId: string;
  readonly expectedRevision: number;
}

export interface CommunityEditCommentInput extends CommunityChangeCommentInput {
  readonly body: string;
}

export interface CommunitySetReactionInput extends IdempotentCommandInput {
  readonly targetType: 'POST' | 'COMMENT';
  readonly targetId: string;
  readonly reaction: (typeof COMMUNITY_REACTIONS)[number];
}

export interface CommunityRemoveReactionInput extends IdempotentCommandInput {
  readonly targetType: 'POST' | 'COMMENT';
  readonly targetId: string;
}

export interface CommunityListFeedInput {
  readonly tenantId: string;
  readonly viewerUserId: string;
  readonly communityId: string;
  readonly limit: number;
  readonly cursor?: string;
  readonly correlationId: string;
}

export interface CommunityListCommentsInput extends CommunityListFeedInput {
  readonly postId: string;
}

export interface CommunityFeedPosition {
  readonly publishedAt: string;
  readonly id: string;
}

export type CommunityContentFailure =
  | { readonly outcome: 'idempotency_conflict' }
  | { readonly outcome: 'actor_not_active' }
  | { readonly outcome: 'community_not_found' }
  | { readonly outcome: 'membership_required' }
  | { readonly outcome: 'publishing_forbidden' }
  | { readonly outcome: 'post_not_found' }
  | { readonly outcome: 'comment_not_found' }
  | { readonly outcome: 'not_author' }
  | { readonly outcome: 'content_not_editable' }
  | { readonly outcome: 'content_not_archived' }
  | { readonly outcome: 'restore_expired' }
  | { readonly outcome: 'media_not_ready' }
  | { readonly outcome: 'media_not_owned' }
  | { readonly outcome: 'media_already_bound' }
  | { readonly outcome: 'media_attachment_conflict' }
  | { readonly outcome: 'revision_conflict'; readonly currentRevision: number };

export type CommunityPostCommandResult =
  | {
      readonly outcome: 'created' | 'edited' | 'archived' | 'restored';
      readonly post: CommunityPost;
      readonly replayed: boolean;
    }
  | CommunityContentFailure;

export type CommunityCommentCommandResult =
  | {
      readonly outcome: 'created' | 'edited' | 'archived' | 'restored';
      readonly comment: CommunityComment;
      readonly replayed: boolean;
    }
  | CommunityContentFailure;

export type CommunityReactionCommandResult =
  | {
      readonly outcome: 'changed';
      readonly reaction: CommunityReactionState;
      readonly replayed: boolean;
    }
  | CommunityContentFailure;

export type CommunityFeedRepositoryResult =
  | {
      readonly outcome: 'found';
      readonly items: readonly CommunityPost[];
      readonly watermark: string;
      readonly hasMore: boolean;
    }
  | { readonly outcome: 'community_not_found' }
  | { readonly outcome: 'actor_not_active' };

export type CommunityCommentPageRepositoryResult =
  | {
      readonly outcome: 'found';
      readonly items: readonly CommunityComment[];
      readonly watermark: string;
      readonly hasMore: boolean;
    }
  | { readonly outcome: 'community_not_found' }
  | { readonly outcome: 'post_not_found' }
  | { readonly outcome: 'actor_not_active' };

export interface CommunityContentRepository {
  createPost(input: CommunityCreatePostInput): Promise<CommunityPostCommandResult>;
  editPost(input: CommunityEditPostInput): Promise<CommunityPostCommandResult>;
  archivePost(input: CommunityChangePostInput): Promise<CommunityPostCommandResult>;
  restorePost(input: CommunityChangePostInput): Promise<CommunityPostCommandResult>;
  createComment(input: CommunityCreateCommentInput): Promise<CommunityCommentCommandResult>;
  editComment(input: CommunityEditCommentInput): Promise<CommunityCommentCommandResult>;
  archiveComment(input: CommunityChangeCommentInput): Promise<CommunityCommentCommandResult>;
  restoreComment(input: CommunityChangeCommentInput): Promise<CommunityCommentCommandResult>;
  setReaction(input: CommunitySetReactionInput): Promise<CommunityReactionCommandResult>;
  removeReaction(input: CommunityRemoveReactionInput): Promise<CommunityReactionCommandResult>;
  listFeed(input: {
    readonly tenantId: string;
    readonly viewerUserId: string;
    readonly communityId: string;
    readonly limit: number;
    readonly watermark?: string;
    readonly after?: CommunityFeedPosition;
    readonly correlationId: string;
  }): Promise<CommunityFeedRepositoryResult>;
  listComments(input: {
    readonly tenantId: string;
    readonly viewerUserId: string;
    readonly communityId: string;
    readonly postId: string;
    readonly limit: number;
    readonly watermark?: string;
    readonly after?: CommunityFeedPosition;
    readonly correlationId: string;
  }): Promise<CommunityCommentPageRepositoryResult>;
}

export interface CommunityContentService {
  createPost(input: CommunityCreatePostInput): Promise<CommunityPostCommandResult>;
  editPost(input: CommunityEditPostInput): Promise<CommunityPostCommandResult>;
  archivePost(input: CommunityChangePostInput): Promise<CommunityPostCommandResult>;
  restorePost(input: CommunityChangePostInput): Promise<CommunityPostCommandResult>;
  createComment(input: CommunityCreateCommentInput): Promise<CommunityCommentCommandResult>;
  editComment(input: CommunityEditCommentInput): Promise<CommunityCommentCommandResult>;
  archiveComment(input: CommunityChangeCommentInput): Promise<CommunityCommentCommandResult>;
  restoreComment(input: CommunityChangeCommentInput): Promise<CommunityCommentCommandResult>;
  setReaction(input: CommunitySetReactionInput): Promise<CommunityReactionCommandResult>;
  removeReaction(input: CommunityRemoveReactionInput): Promise<CommunityReactionCommandResult>;
  listFeed(
    input: CommunityListFeedInput,
  ): Promise<
    | { readonly outcome: 'found'; readonly page: CommunityFeedPage }
    | { readonly outcome: 'community_not_found' }
    | { readonly outcome: 'actor_not_active' }
  >;
  listComments(
    input: CommunityListCommentsInput,
  ): Promise<
    | { readonly outcome: 'found'; readonly page: CommunityCommentPage }
    | { readonly outcome: 'community_not_found' }
    | { readonly outcome: 'post_not_found' }
    | { readonly outcome: 'actor_not_active' }
  >;
}

const baseCommandFields = {
  tenantId: uuid,
  actorUserId: uuid,
  communityId: uuid,
  idempotencyKey: z.string().min(16).max(128),
  requestHash: z.string().regex(/^[0-9a-f]{64}$/),
  correlationId: z.string().min(1).max(128),
} as const;

const postBody = z
  .string()
  .min(1)
  .max(10_000)
  .refine((value) => value.trim().length > 0);
const commentBody = z
  .string()
  .min(1)
  .max(2_000)
  .refine((value) => value.trim().length > 0);
const mediaIds = z
  .array(uuid)
  .max(COMMUNITY_MEDIA_MAX_PER_POST)
  .refine((items) => new Set(items).size === items.length, 'Community media IDs must be unique.');
const createPostInputSchema = z
  .object({ ...baseCommandFields, body: postBody, mediaIds: mediaIds.optional() })
  .strict();
const changePostInputSchema = z
  .object({ ...baseCommandFields, postId: uuid, expectedRevision: positiveRevision })
  .strict();
const editPostInputSchema = changePostInputSchema
  .extend({ body: postBody, mediaIds: mediaIds.optional() })
  .strict();
const createCommentInputSchema = z
  .object({ ...baseCommandFields, postId: uuid, body: commentBody })
  .strict();
const changeCommentInputSchema = z
  .object({
    ...baseCommandFields,
    postId: uuid,
    commentId: uuid,
    expectedRevision: positiveRevision,
  })
  .strict();
const editCommentInputSchema = changeCommentInputSchema.extend({ body: commentBody }).strict();
const setReactionInputSchema = z
  .object({
    ...baseCommandFields,
    targetType: z.enum(['POST', 'COMMENT']),
    targetId: uuid,
    reaction: z.enum(COMMUNITY_REACTIONS),
  })
  .strict();
const removeReactionInputSchema = setReactionInputSchema.omit({ reaction: true }).strict();
const listFeedInputSchema = z
  .object({
    tenantId: uuid,
    viewerUserId: uuid,
    communityId: uuid,
    limit: z.number().int().min(1).max(50),
    cursor: z.string().min(16).max(1_024).optional(),
    correlationId: z.string().min(1).max(128),
  })
  .strict();
const listCommentsInputSchema = listFeedInputSchema.extend({ postId: uuid }).strict();

const feedCursorSchema = z
  .object({
    v: z.literal(1),
    communityId: uuid,
    watermark: dateTime,
    publishedAt: dateTime,
    id: uuid,
  })
  .strict();
const commentCursorSchema = feedCursorSchema.extend({ postId: uuid }).strict();

type FeedCursor = z.infer<typeof feedCursorSchema>;

function decodeFeedCursor(value: string, communityId: string): FeedCursor {
  try {
    const parsed = feedCursorSchema.safeParse(
      JSON.parse(Buffer.from(value, 'base64url').toString('utf8')),
    );
    if (parsed.success && parsed.data.communityId === communityId) return parsed.data;
  } catch {
    // Opaque malformed and cross-community cursors use one stable domain error.
  }
  throw new CommunityContentError('COMMUNITY_FEED_CURSOR_INVALID');
}

function encodeFeedCursor(value: FeedCursor): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

type CommentCursor = z.infer<typeof commentCursorSchema>;

function decodeCommentCursor(value: string, communityId: string, postId: string): CommentCursor {
  try {
    const parsed = commentCursorSchema.safeParse(
      JSON.parse(Buffer.from(value, 'base64url').toString('utf8')),
    );
    if (
      parsed.success &&
      parsed.data.communityId === communityId &&
      parsed.data.postId === postId
    ) {
      return parsed.data;
    }
  } catch {
    // Opaque malformed and cross-resource cursors use one stable domain error.
  }
  throw new CommunityContentError('COMMUNITY_COMMENT_CURSOR_INVALID');
}

function encodeCommentCursor(value: CommentCursor): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

export class CommunityContentError extends Error {
  public constructor(
    public readonly code:
      | 'COMMUNITY_CONTENT_COMMAND_INVALID'
      | 'COMMUNITY_CONTENT_STATE_INVALID'
      | 'COMMUNITY_FEED_QUERY_INVALID'
      | 'COMMUNITY_FEED_CURSOR_INVALID'
      | 'COMMUNITY_COMMENT_CURSOR_INVALID',
  ) {
    super(code);
    this.name = 'CommunityContentError';
  }
}

function checkedCommand<TInput, TResult>(
  schema: z.ZodType<TInput>,
  resultSchema: z.ZodType<CommunityPost | CommunityComment | CommunityReactionState>,
  select: (
    result: TResult,
  ) => CommunityPost | CommunityComment | CommunityReactionState | undefined,
  execute: (input: TInput) => Promise<TResult>,
): (input: TInput) => Promise<TResult> {
  return async (input) => {
    const parsed = schema.safeParse(input);
    if (!parsed.success) throw new CommunityContentError('COMMUNITY_CONTENT_COMMAND_INVALID');
    const result = await execute(parsed.data);
    const state = select(result);
    if (state && !resultSchema.safeParse(state).success) {
      throw new CommunityContentError('COMMUNITY_CONTENT_STATE_INVALID');
    }
    return result;
  };
}

export function createCommunityContentService(
  repository: CommunityContentRepository,
): CommunityContentService {
  return {
    createPost: checkedCommand(
      createPostInputSchema,
      communityPostSchema,
      (result: CommunityPostCommandResult) => ('post' in result ? result.post : undefined),
      (input) => repository.createPost(input),
    ),
    editPost: checkedCommand(
      editPostInputSchema,
      communityPostSchema,
      (result: CommunityPostCommandResult) => ('post' in result ? result.post : undefined),
      (input) => repository.editPost(input),
    ),
    archivePost: checkedCommand(
      changePostInputSchema,
      communityPostSchema,
      (result: CommunityPostCommandResult) => ('post' in result ? result.post : undefined),
      (input) => repository.archivePost(input),
    ),
    restorePost: checkedCommand(
      changePostInputSchema,
      communityPostSchema,
      (result: CommunityPostCommandResult) => ('post' in result ? result.post : undefined),
      (input) => repository.restorePost(input),
    ),
    createComment: checkedCommand(
      createCommentInputSchema,
      communityCommentSchema,
      (result: CommunityCommentCommandResult) => ('comment' in result ? result.comment : undefined),
      (input) => repository.createComment(input),
    ),
    editComment: checkedCommand(
      editCommentInputSchema,
      communityCommentSchema,
      (result: CommunityCommentCommandResult) => ('comment' in result ? result.comment : undefined),
      (input) => repository.editComment(input),
    ),
    archiveComment: checkedCommand(
      changeCommentInputSchema,
      communityCommentSchema,
      (result: CommunityCommentCommandResult) => ('comment' in result ? result.comment : undefined),
      (input) => repository.archiveComment(input),
    ),
    restoreComment: checkedCommand(
      changeCommentInputSchema,
      communityCommentSchema,
      (result: CommunityCommentCommandResult) => ('comment' in result ? result.comment : undefined),
      (input) => repository.restoreComment(input),
    ),
    setReaction: checkedCommand(
      setReactionInputSchema,
      communityReactionStateSchema,
      (result: CommunityReactionCommandResult) =>
        'reaction' in result ? result.reaction : undefined,
      (input) => repository.setReaction(input),
    ),
    removeReaction: checkedCommand(
      removeReactionInputSchema,
      communityReactionStateSchema,
      (result: CommunityReactionCommandResult) =>
        'reaction' in result ? result.reaction : undefined,
      (input) => repository.removeReaction(input),
    ),
    async listFeed(input) {
      const parsed = listFeedInputSchema.safeParse(input);
      if (!parsed.success) throw new CommunityContentError('COMMUNITY_FEED_QUERY_INVALID');
      const cursor = parsed.data.cursor
        ? decodeFeedCursor(parsed.data.cursor, parsed.data.communityId)
        : undefined;
      const result = await repository.listFeed({
        tenantId: parsed.data.tenantId,
        viewerUserId: parsed.data.viewerUserId,
        communityId: parsed.data.communityId,
        limit: parsed.data.limit,
        correlationId: parsed.data.correlationId,
        ...(cursor
          ? {
              watermark: cursor.watermark,
              after: { publishedAt: cursor.publishedAt, id: cursor.id },
            }
          : {}),
      });
      if (result.outcome !== 'found') return result;
      const parsedItems = z
        .array(communityPostSchema)
        .max(parsed.data.limit)
        .safeParse(result.items);
      if (!parsedItems.success || (result.hasMore && parsedItems.data.length === 0)) {
        throw new CommunityContentError('COMMUNITY_CONTENT_STATE_INVALID');
      }
      const last = parsedItems.data.at(-1);
      return {
        outcome: 'found',
        page: communityFeedPageSchema.parse({
          items: parsedItems.data,
          watermark: result.watermark,
          ...(result.hasMore && last?.publishedAt
            ? {
                nextCursor: encodeFeedCursor({
                  v: 1,
                  communityId: parsed.data.communityId,
                  watermark: result.watermark,
                  publishedAt: last.publishedAt,
                  id: last.id,
                }),
              }
            : {}),
        }),
      };
    },
    async listComments(input) {
      const parsed = listCommentsInputSchema.safeParse(input);
      if (!parsed.success) throw new CommunityContentError('COMMUNITY_FEED_QUERY_INVALID');
      const cursor = parsed.data.cursor
        ? decodeCommentCursor(parsed.data.cursor, parsed.data.communityId, parsed.data.postId)
        : undefined;
      const result = await repository.listComments({
        tenantId: parsed.data.tenantId,
        viewerUserId: parsed.data.viewerUserId,
        communityId: parsed.data.communityId,
        postId: parsed.data.postId,
        limit: parsed.data.limit,
        correlationId: parsed.data.correlationId,
        ...(cursor
          ? {
              watermark: cursor.watermark,
              after: { publishedAt: cursor.publishedAt, id: cursor.id },
            }
          : {}),
      });
      if (result.outcome !== 'found') return result;
      const items = z.array(communityCommentSchema).max(parsed.data.limit).safeParse(result.items);
      if (!items.success || (result.hasMore && items.data.length === 0)) {
        throw new CommunityContentError('COMMUNITY_CONTENT_STATE_INVALID');
      }
      const last = items.data.at(-1);
      return {
        outcome: 'found',
        page: communityCommentPageSchema.parse({
          items: items.data,
          watermark: result.watermark,
          ...(result.hasMore && last
            ? {
                nextCursor: encodeCommentCursor({
                  v: 1,
                  communityId: parsed.data.communityId,
                  postId: parsed.data.postId,
                  watermark: result.watermark,
                  publishedAt: last.publishedAt,
                  id: last.id,
                }),
              }
            : {}),
        }),
      };
    },
  };
}
