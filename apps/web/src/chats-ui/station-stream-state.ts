import type { StationStreamPage, StationStreamSummary } from '@phub/api-sdk';
export type AvailableStationStream = Extract<StationStreamSummary, { availability: 'AVAILABLE' }>;
export interface StationStreamView {
  readonly position: AvailableStationStream;
  readonly rows: readonly StationStreamPage['items'][number][];
  readonly archive: readonly StationStreamPage['items'][number][];
  readonly forward: string | null;
  readonly older: string | null;
  readonly archiveCursor: string | null;
  readonly allowed: boolean;
}
export function sameStationStream(
  a: { streamId: string; membershipEpoch: number },
  b: { streamId: string; membershipEpoch: number },
): boolean {
  return a.streamId === b.streamId && a.membershipEpoch === b.membershipEpoch;
}
/** Only displayed consecutive sequence rows prove a readable range. ACK overlays and archive do not. */
export function stationReadableThrough(view: StationStreamView): number {
  let through = view.position.readThroughSequence;
  for (const row of view.rows) {
    if (row.sequence === through + 1) through = row.sequence;
  }
  return through;
}
export function acceptStationStreamPage(
  view: StationStreamView,
  page: StationStreamPage,
  purpose: 'initial' | 'forward' | 'older' | 'archive',
): StationStreamView {
  if (
    !sameStationStream(view.position, page) ||
    page.baselineSequence !== view.position.baselineSequence ||
    page.publishedThroughSequence < view.position.publishedThroughSequence ||
    page.readThroughSequence < view.position.readThroughSequence
  )
    throw new Error('STATION_STREAM_CHANGED');
  const rows = [...view.rows],
    archive = [...view.archive];
  for (const row of page.items) {
    const previous = [...rows, ...archive].find(
      (item) => item.id === row.id || (row.sequence !== null && item.sequence === row.sequence),
    );
    if (previous) {
      if (JSON.stringify(previous) !== JSON.stringify(row))
        throw new Error('STATION_STREAM_CONFLICT');
      continue;
    }
    if (row.sequence === null) archive.push(row);
    else rows.push(row);
  }
  rows.sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
  archive.sort((a, b) => a.sentAt.localeCompare(b.sentAt) || a.id.localeCompare(b.id));
  return {
    position: {
      communityId: view.position.communityId,
      availability: 'AVAILABLE',
      streamId: page.streamId,
      membershipEpoch: page.membershipEpoch,
      baselineSequence: page.baselineSequence,
      readThroughSequence: page.readThroughSequence,
      publishedThroughSequence: page.publishedThroughSequence,
      unreadCount: page.unreadCount,
    },
    rows,
    archive,
    forward:
      purpose === 'initial' || purpose === 'forward'
        ? (page.nextCursor ?? page.catchUpCursor)
        : view.forward,
    older: purpose === 'initial' || purpose === 'older' ? page.olderCursor : view.older,
    archiveCursor:
      purpose === 'archive'
        ? page.nextCursor
        : purpose === 'initial' || purpose === 'older'
          ? (page.archiveCursor ?? view.archiveCursor)
          : view.archiveCursor,
    allowed: page.canRequestStationMessage,
  };
}
