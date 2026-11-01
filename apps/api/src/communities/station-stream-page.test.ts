import { describe, expect, it } from 'vitest';
import {
  stationStreamCursor,
  stationStreamPage,
  stationStreamQuery,
} from './station-stream-page.js';

const scope = {
  tenantId: '10000000-0000-4000-8000-000000000001',
  communityId: '20000000-0000-4000-8000-000000000001',
};
const streamId = '30000000-0000-4000-8000-000000000001';
const row = (sequence: number) => ({
  sequence,
  publicId: `40000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`,
  text: 'Synthetic message',
  authorName: 'Player',
  createdTs: 1000 + sequence,
  createdAt: new Date(1000 + sequence).toISOString(),
});
const page = (afterSequence = 0, throughSequence = 3, limit = 3) => ({
  historyVersion: 3,
  mode: 'STREAM',
  streamId,
  membershipEpoch: 2,
  baselineSequence: 0,
  readThroughSequence: 0,
  publishedThroughSequence: throughSequence,
  unreadCount: throughSequence,
  afterSequence,
  throughSequence,
  messages: Array.from({ length: Math.min(limit, throughSequence - afterSequence) }, (_, i) =>
    row(afterSequence + i + 1),
  ),
  nextAfterSequence: throughSequence - afterSequence > limit ? afterSequence + limit : null,
  hasMore: throughSequence - afterSequence > limit,
});
const cursor = (afterSequence: number, throughSequence?: number) => ({
  v: 3 as const,
  mode: 'STREAM' as const,
  ...scope,
  streamId,
  membershipEpoch: 2,
  afterSequence,
  ...(throughSequence === undefined ? {} : { throughSequence }),
});

describe('station stream bounded snapshots', () => {
  it('starts at the latest bounded window and separates older/forward/archive positions', () => {
    const parsed = stationStreamPage(page(7, 10), 3, scope);
    expect(stationStreamCursor(parsed.catchUpCursor!, scope)).toEqual(cursor(10));
    expect(stationStreamCursor(parsed.olderCursor!, scope)).toEqual(cursor(4, 7));
    expect(stationStreamCursor(parsed.archiveCursor!, scope)?.mode).toBe('ARCHIVE');
    expect(parsed.nextCursor).toBeNull();
  });
  it('catches up over multiple pages without following a moving frontier', () => {
    const first = stationStreamPage(page(3, 10), 3, scope, cursor(3));
    expect(first.catchUpCursor).toBeNull();
    const next = stationStreamCursor(first.nextCursor!, scope)!;
    expect(next).toEqual(cursor(6, 10));
    const second = stationStreamPage(
      { ...page(6, 10), publishedThroughSequence: 12, unreadCount: 12 },
      3,
      scope,
      next,
    );
    const last = stationStreamPage(
      { ...page(9, 10), publishedThroughSequence: 12, unreadCount: 12 },
      3,
      scope,
      stationStreamCursor(second.nextCursor!, scope),
    );
    expect(stationStreamCursor(last.catchUpCursor!, scope)).toEqual(cursor(10));
    expect(last.nextCursor).toBeNull();
  });
  it('allows an older range below current membership baseline/read position', () => {
    expect(
      stationStreamPage(
        {
          ...page(1, 4),
          baselineSequence: 7,
          readThroughSequence: 8,
          publishedThroughSequence: 10,
          unreadCount: 2,
        },
        3,
        scope,
        cursor(1, 4),
      ).page.messages,
    ).toHaveLength(3);
  });
  it('accepts an empty initial stream and exact exhausted catch-up', () => {
    expect(stationStreamPage(page(0, 0), 3, scope).page.messages).toEqual([]);
    expect(stationStreamPage(page(3, 3), 3, scope, cursor(3)).nextCursor).toBeNull();
  });
  it.each([
    ['hole', { messages: [row(1), row(3), row(4)] }],
    ['short page', { messages: [row(1)] }],
    ['duplicate UUID', { messages: [row(1), { ...row(2), publicId: row(1).publicId }, row(3)] }],
    ['incorrect next position', { nextAfterSequence: 3 }],
    ['incorrect more', { hasMore: true }],
    ['foreign epoch', { membershipEpoch: 3 }],
    ['foreign stream', { streamId: '30000000-0000-4000-8000-000000000002' }],
    ['shifted snapshot', { throughSequence: 4 }],
    ['read beyond frontier', { readThroughSequence: 4 }],
    ['baseline beyond read', { baselineSequence: 1 }],
    ['impossible unread', { unreadCount: 4 }],
    ['private unknown field', { token: 'synthetic' }],
  ])('rejects %s without a usable advancement', (_label, delta) => {
    expect(() => stationStreamPage({ ...page(), ...delta }, 3, scope, cursor(0, 3))).toThrow();
  });
  it('binds opaque cursors to canonical scope and rejects ambiguous encodings', () => {
    const encoded = stationStreamPage(page(), 3, scope).catchUpCursor!;
    expect(() => stationStreamCursor(encoded, { ...scope, communityId: streamId })).toThrow();
    expect(() => stationStreamCursor(`${encoded}=`, scope)).toThrow();
    expect(() => stationStreamCursor('x'.repeat(1025), scope)).toThrow();
    expect(stationStreamQuery(3, cursor(3, 10)).toString()).toContain('throughSequence=10');
    expect(() => stationStreamQuery(51)).toThrow();
  });
  it('keeps the unsequenced archive separate, strict and descending', () => {
    const head = stationStreamPage(page(), 3, scope);
    const archive = stationStreamCursor(head.archiveCursor!, scope)!;
    const old = {
      historyVersion: 3,
      mode: 'ARCHIVE',
      streamId,
      membershipEpoch: 2,
      baselineSequence: 0,
      readThroughSequence: 0,
      publishedThroughSequence: 3,
      unreadCount: 3,
      messages: [3, 2, 1].map((n) => ({ ...row(n), sequence: null })),
      hasMore: true,
      nextBefore: { createdTs: row(1).createdTs, publicId: row(1).publicId },
    };
    const result = stationStreamPage(old, 3, scope, archive);
    expect(result.catchUpCursor).toBeNull();
    expect(stationStreamCursor(result.nextCursor!, scope)?.mode).toBe('ARCHIVE');
    expect(() => stationStreamPage({ ...old, messages: [row(3)] }, 3, scope, archive)).toThrow();
    expect(() =>
      stationStreamPage({ ...old, messages: old.messages.toReversed() }, 3, scope, archive),
    ).toThrow();
  });
});
