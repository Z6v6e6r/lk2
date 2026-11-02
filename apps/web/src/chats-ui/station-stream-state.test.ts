import { describe, it, expect } from 'vitest';
import {
  acceptStationStreamPage,
  stationReadableThrough,
  type StationStreamView,
} from './station-stream-state.js';
import type { StationStreamPage } from '@phub/api-sdk';
const id = '11111111-1111-4111-8111-111111111111';
const position = {
  communityId: id,
  availability: 'AVAILABLE' as const,
  streamId: id,
  membershipEpoch: 1,
  baselineSequence: 0,
  readThroughSequence: 0,
  publishedThroughSequence: 120,
  unreadCount: 120,
};
const initial = (): StationStreamView => ({
  position,
  rows: [],
  archive: [],
  forward: null,
  older: null,
  archiveCursor: null,
  allowed: false,
});
function page(after: number, through: number, published = 120): StationStreamPage {
  return {
    historyVersion: 3,
    mode: 'STREAM',
    ...position,
    publishedThroughSequence: published,
    unreadCount: published,
    afterSequence: after,
    throughSequence: through,
    items: Array.from({ length: Math.min(50, through - after) }, (_, i) => ({
      id: `${String(after + i + 1).padStart(8, '0')}-1111-4111-8111-111111111111`,
      body: `row${after + i + 1}`,
      sentAt: '2026-11-01T10:00:00.000Z',
      author: { displayName: 'Player' },
      isViewer: false,
      sequence: after + i + 1,
    })),
    nextCursor: through - after > 50 ? 'next_fixed_cursor' : null,
    catchUpCursor: through - after > 50 ? null : 'catch_up_cursor_',
    olderCursor: after > 0 ? 'older_cursor____' : null,
    archiveCursor: after === 0 ? 'archive_cursor__' : null,
    canRequestStationMessage: true,
  };
}
describe('station stream displayed coverage', () => {
  it('latest window cannot mark unseen gap; exact older windows close it', () => {
    let view = acceptStationStreamPage(initial(), page(70, 120), 'initial');
    expect(stationReadableThrough(view)).toBe(0);
    view = acceptStationStreamPage(view, page(20, 70), 'older');
    expect(stationReadableThrough(view)).toBe(0);
    view = acceptStationStreamPage(view, page(0, 20), 'older');
    expect(stationReadableThrough(view)).toBe(120);
    expect(view.forward).toBe('catch_up_cursor_');
  });
  it('fixed backlog pages continue despite newer published frontier without jumping', () => {
    let view = acceptStationStreamPage(
      { ...initial(), position: { ...position, publishedThroughSequence: 0, unreadCount: 0 } },
      page(0, 120),
      'forward',
    );
    expect(stationReadableThrough(view)).toBe(50);
    expect(view.forward).toBe('next_fixed_cursor');
    view = acceptStationStreamPage(view, page(50, 120, 130), 'forward');
    expect(stationReadableThrough(view)).toBe(100);
    view = acceptStationStreamPage(view, page(100, 120, 140), 'forward');
    expect(stationReadableThrough(view)).toBe(120);
    expect(view.position.unreadCount).toBe(140);
  });
  it('rejects epoch, stream, sequence collision and regressed current frontier', () => {
    const view = acceptStationStreamPage(initial(), page(70, 120), 'initial');
    for (const patch of [
      { membershipEpoch: 2 },
      { streamId: '22222222-2222-4222-8222-222222222222' },
      { publishedThroughSequence: 119 },
    ])
      expect(() =>
        acceptStationStreamPage(view, { ...page(70, 120), ...patch }, 'forward'),
      ).toThrow();
    const changed = page(70, 120);
    changed.items[0]!.body = 'changed';
    expect(() => acceptStationStreamPage(view, changed, 'forward')).toThrow('CONFLICT');
  });
  it('sequence order wins over timestamps and duplicate pages do not advance coverage', () => {
    const data = page(70, 120);
    data.items[1]!.sentAt = '2026-10-01T10:00:00.000Z';
    const view = acceptStationStreamPage(initial(), data, 'initial');
    expect(view.rows.slice(0, 2).map((r) => r.sequence)).toEqual([71, 72]);
    expect(acceptStationStreamPage(view, data, 'older').rows).toHaveLength(50);
    expect(stationReadableThrough(view)).toBe(0);
  });
});
