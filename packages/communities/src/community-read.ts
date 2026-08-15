import { z } from 'zod';

import {
  COMMUNITY_JOIN_POLICIES,
  COMMUNITY_PUBLISHING_PRESETS,
  COMMUNITY_VISIBILITIES,
} from './community-create.js';
import { communityLogoUrlSchema } from './community-logo-url.js';

const uuid = z.string().uuid();
const dateTime = z.string().datetime({ offset: true });

const roleSchema = z.enum(['OWNER', 'ADMIN', 'MODERATOR', 'MEMBER']);
type MembershipStatus = 'PENDING' | 'ACTIVE' | 'LEFT' | 'REMOVED' | 'BANNED';
export const communityJoinActionSchema = z.enum([
  'JOIN_NOW',
  'REQUEST_TO_JOIN',
  'REQUEST_REJOIN',
  'INVITE_REQUIRED',
  'MEMBERSHIP_PENDING',
  'OPEN_COMMUNITY',
  'UNAVAILABLE',
]);

const visibleBase = {
  id: uuid,
  title: z.string().min(1).max(120),
  logoUrl: communityLogoUrlSchema.nullable(),
  isVerified: z.boolean(),
  visibility: z.enum(COMMUNITY_VISIBILITIES),
  joinAction: communityJoinActionSchema,
} as const;

export const communityMinimalViewSchema = z
  .object({
    ...visibleBase,
    visibility: z.literal('LISTED_PRIVATE'),
  })
  .strict();

export const communityPublicViewSchema = z
  .object({
    ...visibleBase,
    visibility: z.literal('PUBLIC'),
    description: z.string().max(2_000).nullable(),
    memberCount: z.number().int().nonnegative(),
    joinPolicy: z.enum(COMMUNITY_JOIN_POLICIES),
    createdAt: dateTime,
  })
  .strict();

const viewerMembershipSchema = z
  .object({
    status: z.literal('ACTIVE'),
    role: roleSchema,
    revision: z.number().int().positive(),
    memberRank: z.number().int().positive().optional(),
  })
  .strict();

export const communityMemberViewSchema = z
  .object({
    ...visibleBase,
    description: z.string().max(2_000).nullable(),
    memberCount: z.number().int().nonnegative(),
    joinPolicy: z.enum(COMMUNITY_JOIN_POLICIES),
    publishingPreset: z.enum(COMMUNITY_PUBLISHING_PRESETS),
    revision: z.number().int().nonnegative(),
    createdAt: dateTime,
    updatedAt: dateTime,
    viewerMembership: viewerMembershipSchema,
  })
  .strict();

export const communityDiscoveryItemSchema = z.discriminatedUnion('visibility', [
  communityPublicViewSchema,
  communityMinimalViewSchema,
]);

export const communityDiscoveryPageSchema = z
  .object({
    items: z.array(communityDiscoveryItemSchema).max(50),
    nextCursor: z.string().min(16).max(1_024).optional(),
  })
  .strict();

export const communityDetailViewSchema = z.union([
  communityPublicViewSchema,
  communityMinimalViewSchema,
  communityMemberViewSchema,
]);

export type CommunityDiscoveryItem = z.infer<typeof communityDiscoveryItemSchema>;
export type CommunityDiscoveryPage = z.infer<typeof communityDiscoveryPageSchema>;
export type CommunityDetailView = z.infer<typeof communityDetailViewSchema>;
export type CommunityJoinAction = z.infer<typeof communityJoinActionSchema>;

export interface CommunityReadRecord {
  readonly id: string;
  readonly title: string;
  readonly description: string | null;
  readonly logoUrl: string | null;
  readonly isVerified: boolean;
  readonly visibility: (typeof COMMUNITY_VISIBILITIES)[number];
  readonly joinPolicy: (typeof COMMUNITY_JOIN_POLICIES)[number];
  readonly publishingPreset: (typeof COMMUNITY_PUBLISHING_PRESETS)[number];
  readonly revision: number;
  readonly memberCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Exact PostgreSQL ordering value; never round-tripped through JS Date for cursors. */
  readonly sortCreatedAt: string;
  readonly viewerMembership?: {
    readonly status: MembershipStatus;
    readonly role: z.infer<typeof roleSchema>;
    readonly revision: number;
    readonly memberRank?: number;
  };
}

export interface CommunityDiscoveryPosition {
  readonly createdAt: string;
  readonly id: string;
}

export interface CommunityReadRepository {
  listDiscoverable(input: {
    readonly tenantId: string;
    readonly viewerUserId: string;
    readonly query?: string;
    readonly limit: number;
    readonly after?: CommunityDiscoveryPosition;
  }): Promise<{ readonly items: readonly CommunityReadRecord[]; readonly hasMore: boolean }>;
  getDetail(input: {
    readonly tenantId: string;
    readonly viewerUserId: string;
    readonly communityId: string;
  }): Promise<CommunityReadRecord | undefined>;
}

export interface CommunityReadService {
  listDiscoverable(input: {
    readonly tenantId: string;
    readonly viewerUserId: string;
    readonly query?: string;
    readonly limit: number;
    readonly cursor?: string;
  }): Promise<CommunityDiscoveryPage>;
  getDetail(input: {
    readonly tenantId: string;
    readonly viewerUserId: string;
    readonly communityId: string;
  }): Promise<
    | { readonly outcome: 'found'; readonly detail: CommunityDetailView }
    | { readonly outcome: 'not_found' }
  >;
}

export class CommunityReadError extends Error {
  public constructor(
    public readonly code:
      | 'COMMUNITY_DISCOVERY_QUERY_INVALID'
      | 'COMMUNITY_DISCOVERY_CURSOR_INVALID'
      | 'COMMUNITY_READ_MODEL_INVALID',
  ) {
    super(code);
    this.name = 'CommunityReadError';
  }
}

const cursorSchema = z
  .object({
    v: z.literal(1),
    query: z.string().max(80).nullable(),
    createdAt: z.string().min(1).max(64),
    id: uuid,
  })
  .strict();

function normalizeQuery(query: string | undefined): string | undefined {
  const normalized = query?.trim().toLocaleLowerCase('ru-RU');
  return normalized ? normalized : undefined;
}

function encodeCursor(input: z.infer<typeof cursorSchema>): string {
  return Buffer.from(JSON.stringify(input), 'utf8').toString('base64url');
}

function decodeCursor(value: string, query: string | undefined): z.infer<typeof cursorSchema> {
  try {
    const parsed = cursorSchema.safeParse(
      JSON.parse(Buffer.from(value, 'base64url').toString('utf8')),
    );
    if (parsed.success && parsed.data.query === (query ?? null)) return parsed.data;
  } catch {
    // Opaque malformed or query-mismatched cursors map to one stable error.
  }
  throw new CommunityReadError('COMMUNITY_DISCOVERY_CURSOR_INVALID');
}

function joinAction(record: CommunityReadRecord): CommunityJoinAction {
  switch (record.viewerMembership?.status) {
    case 'ACTIVE':
      return 'OPEN_COMMUNITY';
    case 'PENDING':
      return 'MEMBERSHIP_PENDING';
    case 'REMOVED':
      return record.joinPolicy === 'INVITE_ONLY' ? 'INVITE_REQUIRED' : 'REQUEST_REJOIN';
    case 'BANNED':
      return 'UNAVAILABLE';
    case 'LEFT':
    case undefined:
      break;
  }
  switch (record.joinPolicy) {
    case 'INSTANT':
      return 'JOIN_NOW';
    case 'MODERATED':
      return 'REQUEST_TO_JOIN';
    case 'INVITE_ONLY':
      return 'INVITE_REQUIRED';
  }
}

function mapRecord(record: CommunityReadRecord): CommunityDetailView | undefined {
  const action = joinAction(record);
  if (record.viewerMembership?.status === 'ACTIVE') {
    return communityMemberViewSchema.parse({
      id: record.id,
      title: record.title,
      description: record.description,
      logoUrl: record.logoUrl,
      isVerified: record.isVerified,
      visibility: record.visibility,
      joinAction: action,
      memberCount: record.memberCount,
      joinPolicy: record.joinPolicy,
      publishingPreset: record.publishingPreset,
      revision: record.revision,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      viewerMembership: {
        status: 'ACTIVE',
        role: record.viewerMembership.role,
        revision: record.viewerMembership.revision,
        ...(record.viewerMembership.memberRank === undefined
          ? {}
          : { memberRank: record.viewerMembership.memberRank }),
      },
    });
  }
  if (record.visibility === 'HIDDEN') return undefined;
  if (record.visibility === 'LISTED_PRIVATE') {
    return communityMinimalViewSchema.parse({
      id: record.id,
      title: record.title,
      logoUrl: record.logoUrl,
      isVerified: record.isVerified,
      visibility: record.visibility,
      joinAction: action,
    });
  }
  return communityPublicViewSchema.parse({
    id: record.id,
    title: record.title,
    description: record.description,
    logoUrl: record.logoUrl,
    isVerified: record.isVerified,
    visibility: record.visibility,
    joinAction: action,
    memberCount: record.memberCount,
    joinPolicy: record.joinPolicy,
    createdAt: record.createdAt,
  });
}

function mapDiscoveryRecord(record: CommunityReadRecord): CommunityDiscoveryItem | undefined {
  if (record.visibility === 'HIDDEN') return undefined;
  const action = joinAction(record);
  if (record.visibility === 'LISTED_PRIVATE') {
    return communityMinimalViewSchema.parse({
      id: record.id,
      title: record.title,
      logoUrl: record.logoUrl,
      isVerified: record.isVerified,
      visibility: record.visibility,
      joinAction: action,
    });
  }
  return communityPublicViewSchema.parse({
    id: record.id,
    title: record.title,
    description: record.description,
    logoUrl: record.logoUrl,
    isVerified: record.isVerified,
    visibility: record.visibility,
    joinAction: action,
    memberCount: record.memberCount,
    joinPolicy: record.joinPolicy,
    createdAt: record.createdAt,
  });
}

export function createCommunityReadService(
  repository: CommunityReadRepository,
): CommunityReadService {
  return {
    async listDiscoverable(input) {
      const query = normalizeQuery(input.query);
      if (
        !uuid.safeParse(input.tenantId).success ||
        !uuid.safeParse(input.viewerUserId).success ||
        !Number.isInteger(input.limit) ||
        input.limit < 1 ||
        input.limit > 50 ||
        (query !== undefined && (query.length < 2 || query.length > 80))
      ) {
        throw new CommunityReadError('COMMUNITY_DISCOVERY_QUERY_INVALID');
      }
      const cursor = input.cursor ? decodeCursor(input.cursor, query) : undefined;
      const page = await repository.listDiscoverable({
        tenantId: input.tenantId,
        viewerUserId: input.viewerUserId,
        limit: input.limit,
        ...(query === undefined ? {} : { query }),
        ...(cursor === undefined ? {} : { after: { createdAt: cursor.createdAt, id: cursor.id } }),
      });
      const visible = page.items.map(mapDiscoveryRecord).filter((item) => item !== undefined);
      const last = page.items.at(-1);
      return communityDiscoveryPageSchema.parse({
        items: visible,
        ...(page.hasMore && last
          ? {
              nextCursor: encodeCursor({
                v: 1,
                query: query ?? null,
                createdAt: last.sortCreatedAt,
                id: last.id,
              }),
            }
          : {}),
      });
    },

    async getDetail(input) {
      if (
        !uuid.safeParse(input.tenantId).success ||
        !uuid.safeParse(input.viewerUserId).success ||
        !uuid.safeParse(input.communityId).success
      ) {
        throw new CommunityReadError('COMMUNITY_READ_MODEL_INVALID');
      }
      const record = await repository.getDetail(input);
      if (!record) return { outcome: 'not_found' };
      try {
        const detail = mapRecord(record);
        return detail ? { outcome: 'found', detail } : { outcome: 'not_found' };
      } catch {
        throw new CommunityReadError('COMMUNITY_READ_MODEL_INVALID');
      }
    },
  };
}
