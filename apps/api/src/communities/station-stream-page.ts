import { z } from 'zod';

const uuid = z
  .string()
  .uuid()
  .refine((value) => value === value.toLowerCase());
const sequence = z
  .number()
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER - 1);
const instant = z.number().int().positive().max(8_640_000_000_000_000);
const iso = z.string().refine((value) => {
  const time = Date.parse(value);
  return time > 0 && Number.isFinite(time) && new Date(time).toISOString() === value;
});
const scope = { tenantId: uuid, communityId: uuid };
const position = { streamId: uuid, membershipEpoch: sequence };
const state = {
  ...position,
  baselineSequence: sequence,
  readThroughSequence: sequence,
  publishedThroughSequence: sequence,
  unreadCount: sequence,
};
const row = {
  publicId: uuid,
  text: z.string().min(1).max(8000),
  createdAt: iso,
  createdTs: instant,
  authorName: z.string().min(1).max(120),
  authorId: z.string().optional(),
  authorPhone: z.string().optional(),
};
const before = z.object({ createdTs: instant, publicId: uuid }).strict();
const cursorSchema = z.discriminatedUnion('mode', [
  z
    .object({
      v: z.literal(3),
      mode: z.literal('STREAM'),
      ...scope,
      ...position,
      afterSequence: sequence,
      throughSequence: sequence.optional(),
    })
    .strict(),
  z
    .object({
      v: z.literal(3),
      mode: z.literal('ARCHIVE'),
      ...scope,
      ...position,
      before: before.optional(),
    })
    .strict(),
]);
const pageSchema = z.discriminatedUnion('mode', [
  z
    .object({
      historyVersion: z.literal(3),
      mode: z.literal('STREAM'),
      ...state,
      afterSequence: sequence,
      throughSequence: sequence,
      messages: z.array(z.object({ ...row, sequence: sequence.min(1) }).strict()).max(50),
      nextAfterSequence: sequence.nullable(),
      hasMore: z.boolean(),
    })
    .strict(),
  z
    .object({
      historyVersion: z.literal(3),
      mode: z.literal('ARCHIVE'),
      ...state,
      messages: z.array(z.object({ ...row, sequence: z.null() }).strict()).max(50),
      nextBefore: before.nullable(),
      hasMore: z.boolean(),
    })
    .strict(),
]);

export type StationStreamScope = z.infer<z.ZodObject<typeof scope>>;
export type StationStreamCursor = z.infer<typeof cursorSchema>;

function fail(): never {
  throw new Error('STATION_STREAM_INVALID');
}
function encode(value: StationStreamCursor): string {
  return Buffer.from(JSON.stringify(cursorSchema.parse(value)), 'utf8').toString('base64url');
}

/** Position only: the owner always verifies the authenticated actor and current membership epoch. */
export function stationStreamCursor(value: string | undefined, current: StationStreamScope) {
  if (value === undefined) return undefined;
  if (value.length < 16 || value.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(value)) return fail();
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.toString('base64url') !== value) return fail();
  const parsed = cursorSchema.parse(JSON.parse(bytes.toString('utf8')) as unknown);
  if (parsed.tenantId !== current.tenantId || parsed.communityId !== current.communityId)
    return fail();
  if (
    parsed.mode === 'STREAM' &&
    parsed.throughSequence !== undefined &&
    parsed.afterSequence > parsed.throughSequence
  )
    return fail();
  return parsed;
}

export function stationStreamQuery(limit: number, cursor?: StationStreamCursor): URLSearchParams {
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) return fail();
  const query = new URLSearchParams({ historyVersion: '3', limit: String(limit) });
  if (!cursor) return query;
  query.set('mode', cursor.mode);
  query.set('streamId', cursor.streamId);
  query.set('membershipEpoch', String(cursor.membershipEpoch));
  if (cursor.mode === 'STREAM') {
    query.set('afterSequence', String(cursor.afterSequence));
    if (cursor.throughSequence !== undefined)
      query.set('throughSequence', String(cursor.throughSequence));
  } else if (cursor.before) {
    query.set('beforeTs', String(cursor.before.createdTs));
    query.set('beforeId', cursor.before.publicId);
  }
  return query;
}

/** Validates a complete bounded range before a consumer may advance any cursor or read marker. */
export function stationStreamPage(
  payload: unknown,
  limit: number,
  current: StationStreamScope,
  cursor?: StationStreamCursor,
) {
  stationStreamQuery(limit, cursor);
  const page = pageSchema.parse(payload);
  if (
    page.baselineSequence > page.readThroughSequence ||
    page.readThroughSequence > page.publishedThroughSequence ||
    page.unreadCount > page.publishedThroughSequence - page.readThroughSequence ||
    (cursor &&
      (page.mode !== cursor.mode ||
        page.streamId !== cursor.streamId ||
        page.membershipEpoch !== cursor.membershipEpoch)) ||
    (!cursor && page.mode !== 'STREAM') ||
    page.messages.length > limit
  )
    return fail();
  const ids = new Set<string>();
  for (const message of page.messages) {
    if (Date.parse(message.createdAt) !== message.createdTs || ids.has(message.publicId))
      return fail();
    ids.add(message.publicId);
  }
  const shared = {
    v: 3 as const,
    tenantId: current.tenantId,
    communityId: current.communityId,
    streamId: page.streamId,
    membershipEpoch: page.membershipEpoch,
  };
  if (page.mode === 'STREAM') {
    if (
      page.afterSequence > page.throughSequence ||
      page.throughSequence > page.publishedThroughSequence ||
      (cursor?.mode === 'STREAM' &&
        (page.afterSequence !== cursor.afterSequence ||
          (cursor.throughSequence !== undefined &&
            page.throughSequence !== cursor.throughSequence))) ||
      (!cursor &&
        (page.throughSequence !== page.publishedThroughSequence ||
          page.afterSequence !== Math.max(0, page.throughSequence - limit))) ||
      (cursor?.mode === 'STREAM' &&
        cursor.throughSequence === undefined &&
        page.throughSequence !== page.publishedThroughSequence)
    )
      return fail();
    const count = Math.min(limit, page.throughSequence - page.afterSequence);
    if (page.messages.length !== count) return fail();
    page.messages.forEach((message, index) => {
      if (message.sequence !== page.afterSequence + index + 1) fail();
    });
    const last = page.afterSequence + count;
    const more = last < page.throughSequence;
    if (page.hasMore !== more || page.nextAfterSequence !== (more ? last : null)) return fail();
    return {
      page,
      nextCursor: more
        ? encode({
            ...shared,
            mode: 'STREAM',
            afterSequence: last,
            throughSequence: page.throughSequence,
          })
        : null,
      catchUpCursor: more
        ? null
        : encode({ ...shared, mode: 'STREAM', afterSequence: page.throughSequence }),
      olderCursor:
        page.afterSequence > 0
          ? encode({
              ...shared,
              mode: 'STREAM',
              afterSequence: Math.max(0, page.afterSequence - limit),
              throughSequence: page.afterSequence,
            })
          : null,
      archiveCursor: encode({ ...shared, mode: 'ARCHIVE' }),
    };
  }
  let edge = cursor?.mode === 'ARCHIVE' ? cursor.before : undefined;
  for (const message of page.messages) {
    if (
      edge &&
      !(
        message.createdTs < edge.createdTs ||
        (message.createdTs === edge.createdTs && message.publicId < edge.publicId)
      )
    )
      return fail();
    edge = message;
  }
  const last = page.messages.at(-1);
  if (
    page.hasMore
      ? page.messages.length !== limit ||
        !last ||
        !page.nextBefore ||
        page.nextBefore.createdTs !== last.createdTs ||
        page.nextBefore.publicId !== last.publicId
      : page.nextBefore !== null
  )
    return fail();
  return {
    page,
    nextCursor: page.nextBefore
      ? encode({ ...shared, mode: 'ARCHIVE', before: page.nextBefore })
      : null,
    catchUpCursor: null,
    olderCursor: null,
    archiveCursor: null,
  };
}
