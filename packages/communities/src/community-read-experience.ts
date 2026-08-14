import { z } from 'zod';

import { communityLogoUrlSchema } from './community-logo-url.js';

const uuid = z.string().uuid();
const dateTime = z.string().datetime({ offset: true });
const finite = z.number().finite();
const pageLimit = z.number().int().min(1).max(50);

export const communityReadExperienceDetailSchema = z
  .object({
    id: uuid,
    title: z.string().min(1).max(120),
    logoUrl: communityLogoUrlSchema.nullable(),
    isVerified: z.boolean(),
    description: z.string().max(2_000).nullable(),
    memberCount: z.number().int().nonnegative(),
    readOnly: z.literal(true),
  })
  .strict();
export type CommunityReadExperienceDetail = z.infer<typeof communityReadExperienceDetailSchema>;

const authorSchema = z.object({ displayName: z.string().min(1).max(120) }).strict();
export const communityReadExperienceFeedItemSchema = z
  .object({
    kind: z.enum(['PHOTO', 'GAME', 'TOURNAMENT', 'SYSTEM']),
    title: z.string().min(1).max(240).nullable(),
    body: z.string().max(8_000),
    publishedAt: dateTime,
    author: authorSchema,
    likesCount: z.number().int().nonnegative().optional(),
    commentsCount: z.number().int().nonnegative().optional(),
  })
  .strict();
export const communityReadExperienceChatMessageSchema = z
  .object({
    body: z.string().min(1).max(8_000),
    sentAt: dateTime,
    author: authorSchema,
    isViewer: z.boolean(),
  })
  .strict();
export const communityReadExperienceRatingRowSchema = z
  .object({
    place: z.number().int().positive(),
    displayName: z.string().min(1).max(120),
    currentLevel: finite,
    score: finite,
    delta: finite,
    games: finite,
    tournaments: finite,
  })
  .strict();
export const communityReadExperienceRatingSchema = z
  .object({
    period: z.enum(['all', '30d']),
    tab: z.enum(['overall', 'games', 'tournaments', 'dynamics']),
    calculationVersion: z.literal('community-rating-v1.3.0'),
    rows: z.array(communityReadExperienceRatingRowSchema).max(100),
  })
  .strict();
export type CommunityReadExperienceFeedPage = {
  readonly items: readonly z.infer<typeof communityReadExperienceFeedItemSchema>[];
  readonly nextCursor?: string | undefined;
};
export type CommunityReadExperienceChatPage = {
  readonly items: readonly z.infer<typeof communityReadExperienceChatMessageSchema>[];
  readonly nextCursor?: string | undefined;
};

export type CommunityReadExperienceErrorCode =
  'COMMUNITY_EXPERIENCE_INVALID' | 'COMMUNITY_EXPERIENCE_UNAVAILABLE';
export class CommunityReadExperienceError extends Error {
  public constructor(public readonly code: CommunityReadExperienceErrorCode) {
    super(code);
    this.name = 'CommunityReadExperienceError';
  }
}

export interface CommunityReadExperienceRepository {
  getDetail(input: {
    readonly tenantId: string;
    readonly viewerUserId: string;
    readonly communityId: string;
    readonly correlationId: string;
  }): Promise<unknown>;
  getFeed(input: {
    readonly tenantId: string;
    readonly viewerUserId: string;
    readonly communityId: string;
    readonly correlationId: string;
    readonly limit: number;
    readonly cursor?: string;
  }): Promise<unknown>;
  getChat(input: {
    readonly tenantId: string;
    readonly viewerUserId: string;
    readonly communityId: string;
    readonly correlationId: string;
    readonly limit: number;
    readonly cursor?: string;
  }): Promise<unknown>;
  getRating(input: {
    readonly tenantId: string;
    readonly viewerUserId: string;
    readonly communityId: string;
    readonly correlationId: string;
    readonly period: 'all' | '30d';
    readonly tab: 'overall' | 'games' | 'tournaments' | 'dynamics';
  }): Promise<unknown>;
}

function page<T extends z.ZodType>(
  item: T,
  value: unknown,
): { readonly items: readonly z.infer<T>[]; readonly nextCursor?: string | undefined } {
  const parsed = z
    .object({ items: z.array(item).max(50), nextCursor: z.string().min(16).max(512).optional() })
    .strict()
    .safeParse(value);
  if (!parsed.success) throw new CommunityReadExperienceError('COMMUNITY_EXPERIENCE_INVALID');
  return parsed.data;
}

export interface CommunityReadExperienceService {
  getDetail(
    input: Parameters<CommunityReadExperienceRepository['getDetail']>[0],
  ): Promise<CommunityReadExperienceDetail>;
  getFeed(
    input: Parameters<CommunityReadExperienceRepository['getFeed']>[0],
  ): Promise<CommunityReadExperienceFeedPage>;
  getChat(
    input: Parameters<CommunityReadExperienceRepository['getChat']>[0],
  ): Promise<CommunityReadExperienceChatPage>;
  getRating(
    input: Parameters<CommunityReadExperienceRepository['getRating']>[0],
  ): Promise<z.infer<typeof communityReadExperienceRatingSchema>>;
}
export function createCommunityReadExperienceService(
  repository: CommunityReadExperienceRepository,
): CommunityReadExperienceService {
  return {
    async getDetail(input) {
      const value = await repository.getDetail(input);
      const parsed = communityReadExperienceDetailSchema.safeParse(value);
      if (!parsed.success) throw new CommunityReadExperienceError('COMMUNITY_EXPERIENCE_INVALID');
      return parsed.data;
    },
    async getFeed(input) {
      if (!pageLimit.safeParse(input.limit).success)
        throw new CommunityReadExperienceError('COMMUNITY_EXPERIENCE_INVALID');
      return page(communityReadExperienceFeedItemSchema, await repository.getFeed(input));
    },
    async getChat(input) {
      if (!pageLimit.safeParse(input.limit).success)
        throw new CommunityReadExperienceError('COMMUNITY_EXPERIENCE_INVALID');
      return page(communityReadExperienceChatMessageSchema, await repository.getChat(input));
    },
    async getRating(input) {
      const parsed = communityReadExperienceRatingSchema.safeParse(
        await repository.getRating(input),
      );
      if (!parsed.success) throw new CommunityReadExperienceError('COMMUNITY_EXPERIENCE_INVALID');
      return parsed.data;
    },
  };
}
