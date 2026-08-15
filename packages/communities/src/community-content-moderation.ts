import { z } from 'zod';

import {
  communityCommentSchema,
  communityPostSchema,
  type CommunityComment,
  type CommunityPost,
} from './community-content.js';

const uuid = z.string().uuid();
const reasonCode = z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/);

export const COMMUNITY_POST_MODERATION_APPROVED_EVENT =
  'community.post.moderation_approved.v1' as const;
export const COMMUNITY_POST_MODERATION_REJECTED_EVENT =
  'community.post.moderation_rejected.v1' as const;
export const COMMUNITY_POST_MODERATION_HIDDEN_EVENT =
  'community.post.moderation_hidden.v1' as const;
export const COMMUNITY_POST_MODERATION_RESTORED_EVENT =
  'community.post.moderation_restored.v1' as const;
export const COMMUNITY_COMMENT_MODERATION_HIDDEN_EVENT =
  'community.comment.moderation_hidden.v1' as const;
export const COMMUNITY_COMMENT_MODERATION_RESTORED_EVENT =
  'community.comment.moderation_restored.v1' as const;

export const communityPendingModerationItemSchema = z
  .object({
    post: communityPostSchema.extend({ status: z.literal('PENDING_MODERATION') }),
  })
  .strict();
export const communityPendingModerationPageSchema = z
  .object({
    items: z.array(communityPendingModerationItemSchema).max(50),
    nextCursor: z.string().min(16).max(1024).optional(),
  })
  .strict();

export type CommunityPendingModerationItem = z.infer<typeof communityPendingModerationItemSchema>;
export type CommunityPendingModerationPage = z.infer<typeof communityPendingModerationPageSchema>;

interface ModerationCommandBase {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly communityId: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly correlationId: string;
  readonly expectedRevision: number;
}

export interface CommunityModeratePostInput extends ModerationCommandBase {
  readonly postId: string;
}

export interface CommunityReasonedModeratePostInput extends CommunityModeratePostInput {
  readonly reasonCode: string;
}

export interface CommunityModerateCommentInput extends ModerationCommandBase {
  readonly postId: string;
  readonly commentId: string;
  readonly reasonCode: string;
}

export type CommunityContentModerationFailure =
  | { readonly outcome: 'idempotency_conflict' }
  | { readonly outcome: 'actor_not_active' | 'permission_denied' }
  | { readonly outcome: 'community_not_found' | 'post_not_found' | 'comment_not_found' }
  | { readonly outcome: 'invalid_state' }
  | { readonly outcome: 'revision_conflict'; readonly currentRevision: number };

export type CommunityModeratePostResult =
  | {
      readonly outcome: 'approved' | 'rejected' | 'hidden' | 'restored';
      readonly post: CommunityPost;
      readonly replayed: boolean;
    }
  | CommunityContentModerationFailure;

export type CommunityModerateCommentResult =
  | {
      readonly outcome: 'hidden' | 'restored';
      readonly comment: CommunityComment;
      readonly replayed: boolean;
    }
  | CommunityContentModerationFailure;

export type CommunityPendingModerationRepositoryResult =
  | {
      readonly outcome: 'found';
      readonly items: readonly CommunityPendingModerationItem[];
      readonly hasMore: boolean;
    }
  | { readonly outcome: 'actor_not_active' | 'permission_denied' | 'community_not_found' };

export interface CommunityContentModerationRepository {
  listPending(input: {
    readonly tenantId: string;
    readonly actorUserId: string;
    readonly communityId?: string;
    readonly limit: number;
    readonly after?: { readonly updatedAt: string; readonly id: string };
    readonly correlationId: string;
  }): Promise<CommunityPendingModerationRepositoryResult>;
  approvePost(input: CommunityModeratePostInput): Promise<CommunityModeratePostResult>;
  rejectPost(input: CommunityReasonedModeratePostInput): Promise<CommunityModeratePostResult>;
  hidePost(input: CommunityReasonedModeratePostInput): Promise<CommunityModeratePostResult>;
  restorePost(input: CommunityReasonedModeratePostInput): Promise<CommunityModeratePostResult>;
  hideComment(input: CommunityModerateCommentInput): Promise<CommunityModerateCommentResult>;
  restoreComment(input: CommunityModerateCommentInput): Promise<CommunityModerateCommentResult>;
}

export interface CommunityContentModerationService {
  listPending(input: {
    readonly tenantId: string;
    readonly actorUserId: string;
    readonly communityId?: string;
    readonly limit: number;
    readonly cursor?: string;
    readonly correlationId: string;
  }): Promise<
    | { readonly outcome: 'found'; readonly page: CommunityPendingModerationPage }
    | { readonly outcome: 'actor_not_active' | 'permission_denied' | 'community_not_found' }
  >;
  approvePost(input: CommunityModeratePostInput): Promise<CommunityModeratePostResult>;
  rejectPost(input: CommunityReasonedModeratePostInput): Promise<CommunityModeratePostResult>;
  hidePost(input: CommunityReasonedModeratePostInput): Promise<CommunityModeratePostResult>;
  restorePost(input: CommunityReasonedModeratePostInput): Promise<CommunityModeratePostResult>;
  hideComment(input: CommunityModerateCommentInput): Promise<CommunityModerateCommentResult>;
  restoreComment(input: CommunityModerateCommentInput): Promise<CommunityModerateCommentResult>;
}

const base = {
  tenantId: uuid,
  actorUserId: uuid,
  communityId: uuid,
  idempotencyKey: z.string().min(16).max(128),
  requestHash: z.string().regex(/^[0-9a-f]{64}$/),
  correlationId: z.string().min(1).max(128),
  expectedRevision: z.number().int().positive(),
};
const postCommandSchema = z.object({ ...base, postId: uuid }).strict();
const reasonedPostCommandSchema = postCommandSchema.extend({ reasonCode }).strict();
const commentCommandSchema = z
  .object({ ...base, postId: uuid, commentId: uuid, reasonCode })
  .strict();
const cursorSchema = z
  .object({
    v: z.literal(1),
    communityId: uuid.nullable(),
    updatedAt: z.string().datetime({ offset: true }),
    id: uuid,
  })
  .strict();
const listSchema = z
  .object({
    tenantId: uuid,
    actorUserId: uuid,
    communityId: uuid.optional(),
    limit: z.number().int().min(1).max(50),
    cursor: z.string().min(16).max(1024).optional(),
    correlationId: z.string().min(1).max(128),
  })
  .strict();

export class CommunityContentModerationError extends Error {
  constructor(
    public readonly code:
      | 'COMMUNITY_CONTENT_MODERATION_INPUT_INVALID'
      | 'COMMUNITY_CONTENT_MODERATION_CURSOR_INVALID'
      | 'COMMUNITY_CONTENT_MODERATION_STATE_INVALID',
  ) {
    super(code);
    this.name = 'CommunityContentModerationError';
  }
}

function decodeCursor(value: string, communityId?: string) {
  try {
    const parsed = cursorSchema.safeParse(
      JSON.parse(Buffer.from(value, 'base64url').toString('utf8')),
    );
    if (parsed.success && parsed.data.communityId === (communityId ?? null)) return parsed.data;
  } catch {
    // Malformed and cross-scope cursors share one stable error.
  }
  throw new CommunityContentModerationError('COMMUNITY_CONTENT_MODERATION_CURSOR_INVALID');
}

function checked<TInput, TResult>(
  schema: z.ZodType<TInput>,
  select: (result: TResult) => CommunityPost | CommunityComment | undefined,
  execute: (input: TInput) => Promise<TResult>,
) {
  return async (input: TInput) => {
    const parsed = schema.safeParse(input);
    if (!parsed.success)
      throw new CommunityContentModerationError('COMMUNITY_CONTENT_MODERATION_INPUT_INVALID');
    const result = await execute(parsed.data);
    const content = select(result);
    if (
      content &&
      !communityPostSchema.safeParse(content).success &&
      !communityCommentSchema.safeParse(content).success
    ) {
      throw new CommunityContentModerationError('COMMUNITY_CONTENT_MODERATION_STATE_INVALID');
    }
    return result;
  };
}

export function createCommunityContentModerationService(
  repository: CommunityContentModerationRepository,
): CommunityContentModerationService {
  return {
    async listPending(input) {
      const parsed = listSchema.safeParse(input);
      if (!parsed.success)
        throw new CommunityContentModerationError('COMMUNITY_CONTENT_MODERATION_INPUT_INVALID');
      const cursor = parsed.data.cursor
        ? decodeCursor(parsed.data.cursor, parsed.data.communityId)
        : undefined;
      const result = await repository.listPending({
        tenantId: parsed.data.tenantId,
        actorUserId: parsed.data.actorUserId,
        limit: parsed.data.limit,
        correlationId: parsed.data.correlationId,
        ...(parsed.data.communityId ? { communityId: parsed.data.communityId } : {}),
        ...(cursor ? { after: { updatedAt: cursor.updatedAt, id: cursor.id } } : {}),
      });
      if (result.outcome !== 'found') return result;
      const items = z
        .array(communityPendingModerationItemSchema)
        .max(parsed.data.limit)
        .parse(result.items);
      const last = items.at(-1)?.post;
      return {
        outcome: 'found',
        page: communityPendingModerationPageSchema.parse({
          items,
          ...(result.hasMore && last
            ? {
                nextCursor: Buffer.from(
                  JSON.stringify({
                    v: 1,
                    communityId: parsed.data.communityId ?? null,
                    updatedAt: last.updatedAt,
                    id: last.id,
                  }),
                  'utf8',
                ).toString('base64url'),
              }
            : {}),
        }),
      };
    },
    approvePost: checked(
      postCommandSchema,
      (result: CommunityModeratePostResult) => ('post' in result ? result.post : undefined),
      repository.approvePost.bind(repository),
    ),
    rejectPost: checked(
      reasonedPostCommandSchema,
      (result: CommunityModeratePostResult) => ('post' in result ? result.post : undefined),
      repository.rejectPost.bind(repository),
    ),
    hidePost: checked(
      reasonedPostCommandSchema,
      (result: CommunityModeratePostResult) => ('post' in result ? result.post : undefined),
      repository.hidePost.bind(repository),
    ),
    restorePost: checked(
      reasonedPostCommandSchema,
      (result: CommunityModeratePostResult) => ('post' in result ? result.post : undefined),
      repository.restorePost.bind(repository),
    ),
    hideComment: checked(
      commentCommandSchema,
      (result: CommunityModerateCommentResult) =>
        'comment' in result ? result.comment : undefined,
      repository.hideComment.bind(repository),
    ),
    restoreComment: checked(
      commentCommandSchema,
      (result: CommunityModerateCommentResult) =>
        'comment' in result ? result.comment : undefined,
      repository.restoreComment.bind(repository),
    ),
  };
}
