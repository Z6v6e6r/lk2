import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { stationHistoryBoundary, stationHistoryPage } from './station-history-page.js';

const scope = { tenantId: 'tenant-a', communityId: '11111111-1111-4111-8111-111111111111' };
const time = Date.parse('2026-11-01T00:00:00.000Z');
const id = (n: number) => `22222222-2222-8222-8222-${String(n).padStart(12, '0')}`;
const row = (n: number, createdTs = time) => ({
  publicId: id(n),
  text: 'same text',
  createdTs,
  createdAt: new Date(createdTs).toISOString(),
  authorName: 'Synthetic player',
  authorId: 'private-actor',
});
function wire(rows: ReturnType<typeof row>[], hasMore = false) {
  const last = rows.at(-1);
  return {
    historyVersion: 2,
    messages: rows,
    hasMore,
    nextBefore: hasMore && last ? { createdTs: last.createdTs, publicId: last.publicId } : null,
  };
}
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
describe('station history tuple contract', () => {
  it('walks three equal-time pages without losing or aliasing identical messages', () => {
    const first = stationHistoryPage(wire([row(6), row(5)], true), 2, scope);
    const second = stationHistoryPage(wire([row(4), row(3)], true), 2, scope, first.nextCursor);
    const third = stationHistoryPage(wire([row(2), row(1)]), 2, scope, second.nextCursor);
    expect([...first.rows, ...second.rows, ...third.rows].map((r) => r.publicId)).toEqual(
      [6, 5, 4, 3, 2, 1].map(id),
    );
    expect(third.nextCursor).toBeUndefined();
    expect(stationHistoryBoundary(first.nextCursor, scope)).toEqual({
      createdTs: time,
      publicId: id(5),
    });
    expect(Buffer.from(first.nextCursor!, 'base64url').toString()).not.toContain('private-actor');
  });
  it('keeps v1 time-only cursors strict and emits a scoped v2 continuation', () => {
    const old = encode({ v: 1, beforeTs: new Date(time).toISOString() });
    expect(() => stationHistoryPage(wire([row(1)]), 1, scope, old)).toThrow();
    const page = stationHistoryPage(wire([row(1, time - 1)], true), 1, scope, old);
    expect(stationHistoryBoundary(page.nextCursor, scope)).toEqual({
      createdTs: time - 1,
      publicId: id(1),
    });
  });
  it('does not require the boundary row to remain present', () => {
    const cursor = stationHistoryPage(wire([row(8)], true), 1, scope).nextCursor;
    expect(stationHistoryPage(wire([row(3), row(2)]), 2, scope, cursor).rows).toHaveLength(2);
  });
  it.each(['tenantId', 'communityId'] as const)('rejects a cursor from another %s', (key) => {
    const cursor = stationHistoryPage(wire([row(1)], true), 1, scope).nextCursor;
    expect(() => stationHistoryBoundary(cursor, { ...scope, [key]: 'other' })).toThrow();
  });
  it.each([
    { v: 3, beforeTs: new Date(time).toISOString() },
    { v: 1, beforeTs: new Date(time).toISOString(), extra: true },
    { v: 1, beforeTs: '2026-11-01' },
    { v: 2, ...scope, beforeTs: new Date(time).toISOString(), beforeId: 'raw-private-id' },
  ])('rejects malformed or ambiguous cursor %j', (value) => {
    expect(() => stationHistoryBoundary(encode(value), scope)).toThrow();
  });
  it.each([
    wire([row(1), row(2)]),
    wire([row(2), row(2)]),
    wire([row(2), { ...row(1), createdTs: time - 1 }]),
    { ...wire([row(2), row(1)], true), nextBefore: { createdTs: time, publicId: id(9) } },
    wire([row(1)], true),
    { ...wire([row(2)]), nextBefore: { createdTs: time, publicId: id(2) } },
    { messages: [row(2)], nextBeforeTs: time },
  ])('refuses invalid ordering/version/boundary without claiming end of history', (payload) => {
    expect(() => stationHistoryPage(payload, 2, scope)).toThrow();
  });
  it('rejects repeated and forward rows relative to the original cursor', () => {
    const cursor = stationHistoryPage(wire([row(4)], true), 1, scope).nextCursor;
    for (const n of [4, 5])
      expect(() => stationHistoryPage(wire([row(n)]), 1, scope, cursor)).toThrow();
  });
  it('bounds the provider page rather than silently truncating it', () => {
    expect(() => stationHistoryPage(wire([row(3), row(2), row(1)]), 2, scope)).toThrow();
  });
});

it('accepts the exact frozen mixed-history fixture produced by the actual LK helper', () => {
  const bytes = readFileSync(new URL('./fixtures/station-history-v2.json', import.meta.url));
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(
    '50e02af00ef28ad2163f6d7909bd748c3741bbac251da3c4f7581ddce4f0440a',
  );
  const payload: unknown = JSON.parse(bytes.toString('utf8')) as unknown;
  const page = stationHistoryPage(payload, 3, scope);
  expect(page.rows.map((r) => r.publicId)).toEqual([
    '70238666-9832-55d5-9680-162f8587367d',
    '305fc0fb-4184-5805-be1f-fdd89086b866',
    '00000000-0000-8000-8000-000000000003',
  ]);
  expect(stationHistoryBoundary(page.nextCursor, scope)).toEqual({
    createdTs: 1000,
    publicId: '00000000-0000-8000-8000-000000000003',
  });
});
