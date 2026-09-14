import { createHash } from 'node:crypto';

import type { UserUpcomingBookings } from '@phub/api-sdk';
import type { UpcomingBookingsProjection } from '@phub/database';

import { getViewerGameCardBatch } from '../games/game-card-queries.js';

type ReadInput = Parameters<typeof getViewerGameCardBatch>[0];

export async function attachUpcomingRosters(
  projection: UpcomingBookingsProjection,
  input: Omit<ReadInput, 'tenantId' | 'viewerUserId' | 'gameIds'> & {
    readonly maxStaleSeconds?: number;
  },
): Promise<UserUpcomingBookings> {
  const snapshots = await getViewerGameCardBatch({
    ...input,
    tenantId: projection.tenantId,
    viewerUserId: projection.userId,
    gameIds: projection.items.flatMap((item) => (item.gameId ? [item.gameId] : [])),
  });
  const items: UserUpcomingBookings['items'] = projection.items.map((item) => {
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
    const age = Date.parse(input.now) - Date.parse(generatedAt);
    const maxAge = 60_000 + (input.maxStaleSeconds ?? 300) * 1_000;
    if (!Number.isFinite(age) || age < 0 || age > maxAge)
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
  });
  return {
    version: createHash('sha256')
      .update(JSON.stringify([projection.version, items]))
      .digest('hex'),
    generatedAt: projection.generatedAt,
    staleAt: projection.staleAt,
    items,
  };
}
