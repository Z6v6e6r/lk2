import { z } from 'zod';

const uuid = z.string().uuid();
const dateTime = z.string().datetime({ offset: true });
const route = z.string().startsWith('/');

export const communitySummarySchema = z
  .object({
    id: uuid,
    title: z.string().min(1).max(120),
    logoUrl: z.string().url().nullable(),
    isVerified: z.boolean(),
    unreadChatCount: z.number().int().nonnegative(),
    route,
  })
  .strict();

export type CommunitySummary = z.infer<typeof communitySummarySchema>;

export const communityMembershipPageSchema = z
  .object({
    items: z.array(communitySummarySchema).max(50),
    nextCursor: z.string().min(16).max(512).optional(),
  })
  .strict();

export type CommunityMembershipPage = z.infer<typeof communityMembershipPageSchema>;

export const communityDirectoryItemSchema = communitySummarySchema
  .omit({ route: true })
  .extend({
    pinned: z.boolean(),
    sortAt: dateTime,
    // Integration-only source hint. The directory service deliberately omits it from
    // CommunityMembershipPage so a legacy media URL never crosses the API boundary.
    legacyLogoSourceUrl: z.string().url().optional(),
  })
  .strict();

export type CommunityDirectoryItem = z.infer<typeof communityDirectoryItemSchema>;

export interface CommunityDirectoryPosition {
  readonly pinned: boolean;
  readonly sortAt: string;
  readonly id: string;
}

export interface CommunityDirectoryRepositoryPage {
  readonly items: readonly CommunityDirectoryItem[];
  readonly hasMore: boolean;
}

export interface LegacyCommunityViewerIdentity {
  readonly phoneE164?: string;
  readonly clientId?: string;
}

export interface CommunityLegacyBridgeRepository {
  getViewerIdentity(tenantId: string, userId: string): Promise<LegacyCommunityViewerIdentity>;
  resolveCommunityIds(
    tenantId: string,
    externalIds: readonly string[],
  ): Promise<ReadonlyMap<string, string>>;
  getCommunityLogoUrls?(
    tenantId: string,
    communityIds: readonly string[],
  ): Promise<ReadonlyMap<string, string>>;
}

export interface CommunityDirectoryRepository {
  listMemberships(input: {
    readonly tenantId: string;
    readonly userId: string;
    readonly correlationId: string;
    readonly limit: number;
    readonly after?: CommunityDirectoryPosition;
  }): Promise<CommunityDirectoryRepositoryPage>;
}

export interface CommunityDirectoryService {
  listMemberships(input: {
    readonly tenantId: string;
    readonly userId: string;
    readonly correlationId: string;
    readonly limit: number;
    readonly cursor?: string;
  }): Promise<CommunityMembershipPage>;
}

export type CommunityDirectoryErrorCode =
  'COMMUNITY_CURSOR_INVALID' | 'COMMUNITY_DIRECTORY_INVALID';

export class CommunityDirectoryError extends Error {
  public constructor(public readonly code: CommunityDirectoryErrorCode) {
    super(code);
    this.name = 'CommunityDirectoryError';
  }
}

const cursorSchema = z
  .object({
    v: z.literal(1),
    pinned: z.boolean(),
    sortAt: dateTime,
    id: uuid,
  })
  .strict();

type CommunityCursor = z.infer<typeof cursorSchema>;

function encodeCursor(cursor: CommunityCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeCursor(value: string): CommunityCursor {
  try {
    const parsed = cursorSchema.safeParse(
      JSON.parse(Buffer.from(value, 'base64url').toString('utf8')),
    );
    if (parsed.success) return parsed.data;
  } catch {
    // A cursor is opaque to the caller; every malformed representation maps to one stable error.
  }
  throw new CommunityDirectoryError('COMMUNITY_CURSOR_INVALID');
}

function compareItems(left: CommunityDirectoryItem, right: CommunityDirectoryItem): number {
  if (left.pinned !== right.pinned) return left.pinned ? -1 : 1;
  if (left.sortAt !== right.sortAt) return right.sortAt.localeCompare(left.sortAt);
  return left.id.localeCompare(right.id);
}

function isAfterCursor(item: CommunityDirectoryItem, cursor: CommunityDirectoryPosition): boolean {
  if (item.pinned !== cursor.pinned) return cursor.pinned && !item.pinned;
  if (item.sortAt !== cursor.sortAt) return item.sortAt < cursor.sortAt;
  return item.id > cursor.id;
}

export function paginateCommunityDirectoryItems(
  items: readonly CommunityDirectoryItem[],
  limit: number,
  after?: CommunityDirectoryPosition,
): CommunityDirectoryRepositoryPage {
  const sorted = [...items].sort(compareItems);
  const remaining = after ? sorted.filter((item) => isAfterCursor(item, after)) : sorted;
  return {
    items: remaining.slice(0, limit),
    hasMore: remaining.length > limit,
  };
}

export function createCommunityDirectoryService(
  repository: CommunityDirectoryRepository,
): CommunityDirectoryService {
  return {
    async listMemberships(input) {
      if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 50) {
        throw new CommunityDirectoryError('COMMUNITY_DIRECTORY_INVALID');
      }
      const cursor = input.cursor ? decodeCursor(input.cursor) : undefined;
      const page = await repository.listMemberships({
        tenantId: input.tenantId,
        userId: input.userId,
        correlationId: input.correlationId,
        limit: input.limit,
        ...(cursor ? { after: cursor } : {}),
      });
      const parsed = z
        .object({
          items: z.array(communityDirectoryItemSchema).max(input.limit),
          hasMore: z.boolean(),
        })
        .strict()
        .safeParse(page);
      if (!parsed.success || (parsed.data.hasMore && parsed.data.items.length === 0)) {
        throw new CommunityDirectoryError('COMMUNITY_DIRECTORY_INVALID');
      }
      const visible = parsed.data.items;
      if (
        visible.some((item, index) =>
          index === 0
            ? Boolean(cursor && !isAfterCursor(item, cursor))
            : compareItems(visible[index - 1] as CommunityDirectoryItem, item) > 0,
        )
      ) {
        throw new CommunityDirectoryError('COMMUNITY_DIRECTORY_INVALID');
      }
      const last = visible.at(-1);

      return communityMembershipPageSchema.parse({
        items: visible.map((item) => ({
          id: item.id,
          title: item.title,
          logoUrl: item.logoUrl,
          isVerified: item.isVerified,
          unreadChatCount: item.unreadChatCount,
          route: `/communities/${item.id}`,
        })),
        ...(parsed.data.hasMore && last
          ? {
              nextCursor: encodeCursor({
                v: 1,
                pinned: last.pinned,
                sortAt: last.sortAt,
                id: last.id,
              }),
            }
          : {}),
      });
    },
  };
}

export * from './legacy-community-read-repository.js';
