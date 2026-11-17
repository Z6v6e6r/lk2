import { createHash } from 'node:crypto';

import type { UserUpcomingBookings } from '@phub/api-sdk';
import type {
  UpcomingBookingsProjection,
  UpcomingBookingProjectionItem,
  StoredGameCardProjection,
} from '@phub/database';

import { retainFinishedGame } from '@phub/games';

import { getViewerGameCardBatch } from '../games/game-card-queries.js';

type ReadInput = Parameters<typeof getViewerGameCardBatch>[0];

export async function attachUpcomingRosters(
  projection: UpcomingBookingsProjection,
  input: Omit<ReadInput, 'tenantId' | 'viewerUserId' | 'gameIds'> & {
    readonly maxStaleSeconds?: number;
  },
): Promise<UserUpcomingBookings> {
  const held: StoredGameCardProjection[] = [];
  let after: { startsAt: string; gameId: string } | undefined;
  // Preserve keyset pagination: recent completed games must not be hidden behind future pages.
  for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
    const page = await input.repository.listViewerCardProjections({
      tenantId: projection.tenantId,
      viewerUserId: projection.userId,
      scope: 'UPCOMING',
      retainedResultsOnly: true,
      limit: 100,
      ...(after ? { after } : {}),
    });
    held.push(
      ...page.items.filter((item) =>
        retainFinishedGame({
          lifecycleState: item.lifecycleState,
          resultState: item.basePayload.result?.state ?? 'NOT_AVAILABLE',
          endsAt: item.endsAt,
          now: input.now,
        }),
      ),
    );
    if (!page.next) break;
    after = page.next;
    if (pageNumber === 99) throw new Error('UPCOMING_GAMES_LIMIT_EXCEEDED');
  }
  const candidates = [...projection.items];
  for (const value of held) {
    if (candidates.some((item) => item.gameId === value.gameId)) continue;
    candidates.push({
      id: value.gameId,
      gameId: value.gameId,
      kind: 'game',
      title: value.basePayload.title,
      startsAt: value.startsAt,
      endsAt: value.endsAt,
      venue: value.basePayload.station.name,
      status: 'confirmed',
      route: `/games/${value.gameId}`,
    });
  }
  const snapshots = new Map<
    string,
    Awaited<ReturnType<typeof getViewerGameCardBatch>> extends ReadonlyMap<string, infer V>
      ? V
      : never
  >();
  for (let index = 0; index < candidates.length; index += 50) {
    const batch = await getViewerGameCardBatch({
      ...input,
      tenantId: projection.tenantId,
      viewerUserId: projection.userId,
      gameIds: candidates
        .slice(index, index + 50)
        .flatMap((item) => (item.gameId ? [item.gameId] : [])),
    });
    for (const [id, snapshot] of batch) snapshots.set(id, snapshot);
  }
  const visible = candidates.filter((item) => {
    const snapshot = item.gameId ? snapshots.get(item.gameId) : undefined;
    if (!snapshot) return !item.endsAt || Date.parse(item.endsAt) > Date.parse(input.now);
    return (
      ['SCHEDULED', 'IN_PROGRESS'].includes(snapshot.lifecycleState) ||
      held.some((value) => value.gameId === item.gameId)
    );
  });
  const items: UserUpcomingBookings['items'] = visible.map(
    (item: UpcomingBookingProjectionItem) => {
      const snapshot = item.gameId ? snapshots.get(item.gameId) : undefined;
      if (
        !snapshot ||
        snapshot.card.viewerRelation === 'NONE' ||
        snapshot.card.viewerRelation === 'ANONYMOUS'
      )
        return { ...item, roster: { state: 'UNAVAILABLE' as const } };
      const { card, generatedAt } = snapshot;
      if (card.capacity.total !== 2 && card.capacity.total !== 4)
        return { ...item, roster: { state: 'UNAVAILABLE' as const } };
      if (generatedAt === null) return { ...item, roster: { state: 'UNAVAILABLE' as const } };
      const age = Date.parse(input.now) - Date.parse(generatedAt);
      const maxAge = 60_000 + (input.maxStaleSeconds ?? 300) * 1_000;
      // A verified final roster is immutable, as on game detail/history. Keep its real
      // timestamp and STALE label throughout the retained result window.
      const frozenRoster =
        snapshot.lifecycleState === 'FINISHED' &&
        held.some((value) => value.gameId === item.gameId);
      if (!Number.isFinite(age) || age < 0 || (age > maxAge && !frozenRoster))
        return { ...item, roster: { state: 'UNAVAILABLE' as const } };
      return {
        ...item,
        roster: {
          state:
            Number.isFinite(age) && age >= 0 && age <= 60_000
              ? ('READY' as const)
              : ('STALE' as const),
          revision: card.revision,
          generatedAt,
          capacity: card.capacity.total,
        },
        participants: card.participants.slice(0, 4).map((p) => ({
          profileId: p.userId,
          displayName: p.displayName,
          avatarUrl: p.avatarUrl,
          level: p.level,
        })),
        openSlots: Math.min(4, card.capacity.open),
      };
    },
  );
  return {
    state: 'READY',
    version: createHash('sha256')
      .update(JSON.stringify([projection.version, items]))
      .digest('hex'),
    generatedAt: projection.generatedAt,
    staleAt: projection.staleAt,
    items,
  };
}
