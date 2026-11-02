import type { components } from '@phub/api-contracts';
export type StationStreamPage = components['schemas']['StationStreamPage'];
export type StationStreamSummary = components['schemas']['StationStreamSummary'];
export type StationStreamSummaries = components['schemas']['StationStreamSummaries'];
export type StationReadRequest = components['schemas']['StationReadRequest'];
export type StationReadReceipt = components['schemas']['StationReadReceipt'];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const record = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const exact = (v: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(v).length === keys.length && keys.every((k) => Object.hasOwn(v, k));
const seq = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v < Number.MAX_SAFE_INTEGER;
const id = (v: unknown): v is string => typeof v === 'string' && uuid.test(v);
const cursor = (v: unknown) =>
  v === null ||
  (typeof v === 'string' && v.length >= 16 && v.length <= 1024 && /^[A-Za-z0-9_-]+$/.test(v));
const stateKeys = [
  'streamId',
  'membershipEpoch',
  'baselineSequence',
  'readThroughSequence',
  'publishedThroughSequence',
  'unreadCount',
] as const;
const state = (v: Record<string, unknown>) =>
  id(v.streamId) &&
  stateKeys.slice(1).every((k) => seq(v[k])) &&
  (v.baselineSequence as number) <= (v.readThroughSequence as number) &&
  (v.readThroughSequence as number) <= (v.publishedThroughSequence as number) &&
  (v.unreadCount as number) <=
    (v.publishedThroughSequence as number) - (v.readThroughSequence as number);
function fail(): never {
  throw new Error('STATION_STREAM_RESPONSE_INVALID');
}
export function validateStationReadRequest(value: unknown): StationReadRequest {
  if (
    !record(value) ||
    !exact(value, ['requestId', 'streamId', 'membershipEpoch', 'throughSequence']) ||
    !id(value.requestId) ||
    !id(value.streamId) ||
    !seq(value.membershipEpoch) ||
    !seq(value.throughSequence)
  )
    return fail();
  return value as StationReadRequest;
}
export function parseStationReadReceipt(
  value: unknown,
  requestId: string,
  original?: StationReadRequest,
): StationReadReceipt {
  if (
    !record(value) ||
    value.contractVersion !== 1 ||
    value.contract !== 'station-read' ||
    value.requestId !== requestId ||
    !id(requestId)
  )
    return fail();
  if (
    value.outcome === 'UNKNOWN' &&
    exact(value, ['contractVersion', 'contract', 'requestId', 'outcome', 'code']) &&
    typeof value.code === 'string' &&
    [
      'READ_REQUEST_INVALID',
      'READ_REQUEST_CONFLICT',
      'READ_ACCESS_DENIED',
      'READ_STREAM_UNAVAILABLE',
      'READ_RECEIPT_UNPROVEN',
    ].includes(value.code)
  )
    return value as StationReadReceipt;
  if (
    value.outcome !== 'CONFIRMED' ||
    !exact(value, [
      'contractVersion',
      'contract',
      'requestId',
      'outcome',
      'streamId',
      'membershipEpoch',
      'throughSequence',
      'readThroughSequence',
    ]) ||
    !id(value.streamId) ||
    !seq(value.membershipEpoch) ||
    !seq(value.throughSequence) ||
    !seq(value.readThroughSequence) ||
    value.readThroughSequence < value.throughSequence ||
    (original &&
      (value.streamId !== original.streamId ||
        value.membershipEpoch !== original.membershipEpoch ||
        value.throughSequence !== original.throughSequence))
  )
    return fail();
  return value as StationReadReceipt;
}
export function parseStationStreamSummaries(
  value: unknown,
  ids: readonly string[],
): StationStreamSummaries {
  if (
    ids.length < 1 ||
    ids.length > 50 ||
    ids.some((v) => !id(v)) ||
    new Set(ids).size !== ids.length ||
    !record(value) ||
    !exact(value, ['contractVersion', 'contract', 'items']) ||
    value.contractVersion !== 1 ||
    value.contract !== 'station-stream-summaries' ||
    !Array.isArray(value.items) ||
    value.items.length !== ids.length
  )
    return fail();
  const seen = new Set<string>();
  for (const item of value.items as unknown[]) {
    if (
      !record(item) ||
      !id(item.communityId) ||
      !ids.includes(item.communityId) ||
      seen.has(item.communityId)
    )
      return fail();
    seen.add(item.communityId);
    if (item.availability === 'AVAILABLE') {
      if (!exact(item, ['communityId', 'availability', ...stateKeys]) || !state(item))
        return fail();
    } else if (
      !['UNADOPTED', 'NOT_STATION'].includes(
        typeof item.availability === 'string' ? item.availability : '',
      ) ||
      !exact(item, ['communityId', 'availability'])
    )
      return fail();
  }
  return value as StationStreamSummaries;
}
export function parseStationStreamPage(
  value: unknown,
  limit = 50,
  initial = false,
): StationStreamPage {
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 50 ||
    !record(value) ||
    value.historyVersion !== 3 ||
    !state(value) ||
    !['STREAM', 'ARCHIVE'].includes(typeof value.mode === 'string' ? value.mode : '') ||
    typeof value.canRequestStationMessage !== 'boolean' ||
    !Array.isArray(value.items) ||
    value.items.length > limit
  )
    return fail();
  const range = value.mode === 'STREAM';
  if (
    !exact(value, [
      'historyVersion',
      'mode',
      ...stateKeys,
      'items',
      'nextCursor',
      'catchUpCursor',
      'olderCursor',
      'archiveCursor',
      'canRequestStationMessage',
      ...(range ? ['afterSequence', 'throughSequence'] : []),
    ]) ||
    !['nextCursor', 'catchUpCursor', 'olderCursor', 'archiveCursor'].every((k) => cursor(value[k]))
  )
    return fail();
  if (range) {
    if (
      !seq(value.afterSequence) ||
      !seq(value.throughSequence) ||
      value.afterSequence > value.throughSequence ||
      value.throughSequence > (value.publishedThroughSequence as number) ||
      value.items.length !== Math.min(limit, value.throughSequence - value.afterSequence) ||
      (initial &&
        (value.throughSequence !== value.publishedThroughSequence ||
          value.afterSequence !== Math.max(0, value.throughSequence - limit)))
    )
      return fail();
    const more = value.afterSequence + value.items.length < value.throughSequence;
    if (
      more
        ? value.nextCursor === null || value.catchUpCursor !== null
        : value.nextCursor !== null || value.catchUpCursor === null
    )
      return fail();
  } else if (
    initial ||
    value.catchUpCursor !== null ||
    value.olderCursor !== null ||
    value.archiveCursor !== null
  )
    return fail();
  const seen = new Set<string>();
  let previous: { time: number; id: string } | undefined;
  for (const [index, item] of (value.items as unknown[]).entries()) {
    if (
      !record(item) ||
      !exact(item, ['id', 'body', 'sentAt', 'author', 'isViewer', 'sequence']) ||
      !id(item.id) ||
      seen.has(item.id) ||
      typeof item.body !== 'string' ||
      !item.body.trim() ||
      item.body.length > 8000 ||
      typeof item.sentAt !== 'string' ||
      !Number.isFinite(Date.parse(item.sentAt)) ||
      new Date(item.sentAt).toISOString() !== item.sentAt ||
      !record(item.author) ||
      !exact(item.author, ['displayName']) ||
      typeof item.author.displayName !== 'string' ||
      !item.author.displayName.trim() ||
      item.author.displayName.length > 120 ||
      typeof item.isViewer !== 'boolean'
    )
      return fail();
    seen.add(item.id);
    if (range) {
      if (item.sequence !== (value.afterSequence as number) + index + 1) return fail();
    } else {
      const time = Date.parse(item.sentAt);
      if (
        item.sequence !== null ||
        (previous && !(time < previous.time || (time === previous.time && item.id < previous.id)))
      )
        return fail();
      previous = { time, id: item.id };
    }
  }
  return value as StationStreamPage;
}
