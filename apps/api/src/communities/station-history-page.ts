import { z } from 'zod';

const uuid = z
  .string()
  .uuid()
  .refine((value) => value === value.toLowerCase());
const instant = z.number().int().positive().max(8_640_000_000_000_000);
const iso = z.string().refine((value) => {
  const time = Date.parse(value);
  return Number.isFinite(time) && time > 0 && new Date(time).toISOString() === value;
});
const boundarySchema = z.object({ createdTs: instant, publicId: uuid }).strict();
const cursorSchema = z
  .object({
    v: z.literal(2),
    tenantId: z.string().min(1).max(128),
    communityId: uuid,
    beforeTs: iso,
    beforeId: uuid,
  })
  .strict();
const legacyCursorSchema = z.object({ v: z.literal(1), beforeTs: iso }).strict();
const rowSchema = z
  .object({
    publicId: uuid,
    text: z.string().min(1).max(8000),
    createdAt: iso,
    createdTs: instant,
    authorName: z.string().min(1).max(120),
    authorId: z.string().optional(),
    authorPhone: z.string().optional(),
  })
  .strict();
const pageSchema = z
  .object({
    historyVersion: z.literal(2),
    messages: z.array(rowSchema).max(50),
    nextBefore: boundarySchema.nullable(),
    hasMore: z.boolean(),
  })
  .strict();
export interface StationHistoryScope {
  readonly tenantId: string;
  readonly communityId: string;
}
export interface StationHistoryBoundary {
  readonly createdTs: number;
  readonly publicId?: string;
}

export function stationHistoryBoundary(
  value: string | undefined,
  scope: StationHistoryScope,
): StationHistoryBoundary | undefined {
  if (value === undefined) return undefined;
  if (value.length < 16 || value.length > 512 || !/^[A-Za-z0-9_-]+$/.test(value))
    throw new Error('STATION_HISTORY_CURSOR_INVALID');
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.toString('base64url') !== value) throw new Error('STATION_HISTORY_CURSOR_INVALID');
  const raw: unknown = JSON.parse(bytes.toString('utf8')) as unknown;
  const legacy = legacyCursorSchema.safeParse(raw);
  if (legacy.success) return { createdTs: Date.parse(legacy.data.beforeTs) };
  const current = cursorSchema.parse(raw);
  if (current.tenantId !== scope.tenantId || current.communityId !== scope.communityId)
    throw new Error('STATION_HISTORY_CURSOR_SCOPE');
  return { createdTs: Date.parse(current.beforeTs), publicId: current.beforeId };
}

function earlier(
  row: { createdTs: number; publicId: string },
  edge: StationHistoryBoundary,
): boolean {
  return (
    row.createdTs < edge.createdTs ||
    (row.createdTs === edge.createdTs &&
      edge.publicId !== undefined &&
      row.publicId < edge.publicId)
  );
}

/** A read position is not authority. The repository separately verifies current membership. */
export function stationHistoryPage(
  payload: unknown,
  limit: number,
  scope: StationHistoryScope,
  value?: string,
) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error('STATION_HISTORY_LIMIT');
  const boundary = stationHistoryBoundary(value, scope);
  const page = pageSchema.parse(payload);
  if (page.messages.length > limit) throw new Error('STATION_HISTORY_OVERSEND');
  const ids = new Set<string>();
  for (let index = 0; index < page.messages.length; index++) {
    const row = page.messages[index]!;
    if (
      Date.parse(row.createdAt) !== row.createdTs ||
      ids.has(row.publicId) ||
      (boundary && !earlier(row, boundary)) ||
      (index > 0 && !earlier(row, page.messages[index - 1]!))
    )
      throw new Error('STATION_HISTORY_ORDER');
    ids.add(row.publicId);
  }
  const last = page.messages.at(-1);
  if (page.hasMore) {
    if (
      page.messages.length !== limit ||
      !last ||
      !page.nextBefore ||
      page.nextBefore.createdTs !== last.createdTs ||
      page.nextBefore.publicId !== last.publicId
    )
      throw new Error('STATION_HISTORY_BOUNDARY');
  } else if (page.nextBefore !== null) throw new Error('STATION_HISTORY_BOUNDARY');
  return {
    rows: page.messages,
    ...(page.nextBefore
      ? {
          nextCursor: Buffer.from(
            JSON.stringify({
              v: 2,
              tenantId: scope.tenantId,
              communityId: scope.communityId,
              beforeTs: new Date(page.nextBefore.createdTs).toISOString(),
              beforeId: page.nextBefore.publicId,
            }),
            'utf8',
          ).toString('base64url'),
        }
      : {}),
  };
}
