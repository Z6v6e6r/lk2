import type { StoredGameCardProjection } from '@phub/database';
import type { GameCardProjectionInput, GamePlayerLevel } from '@phub/games';
import { describe, expect, it, vi } from 'vitest';

import { listBookingRecommendations } from './booking-recommendations.js';

const tenantId = '86afbe01-0318-4dd2-bc25-303b7bf0d430';
const userId = '49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca';
const organizerId = '55555555-5555-4555-8555-555555555555';
const favoriteStationId = 'bd35543d-c565-443a-bd3d-eea68eb2fbe6';
const otherStationId = 'cd35543d-c565-443a-bd3d-eea68eb2fbe6';

function projection(input: {
  readonly id: string;
  readonly startsAt: string;
  readonly stationId: string;
  readonly stationName: string;
  readonly lifecycleState?: StoredGameCardProjection['lifecycleState'];
  readonly levelFrom?: GamePlayerLevel;
  readonly levelTo?: GamePlayerLevel;
  readonly participant?: boolean;
}): StoredGameCardProjection {
  const lifecycleState = input.lifecycleState ?? 'SCHEDULED';
  const snapshot: GameCardProjectionInput = {
    id: input.id,
    tenantId,
    revision: 1,
    organizerUserId: organizerId,
    title: `Игра ${input.stationName}`,
    kind: 'FRIENDLY',
    visibility: 'PUBLIC',
    lifecycleState,
    startsAt: input.startsAt,
    endsAt: new Date(Date.parse(input.startsAt) + 90 * 60 * 1_000).toISOString(),
    timezone: 'Europe/Moscow',
    station: { id: input.stationId, name: input.stationName, shortAddress: null },
    levelRange: { from: input.levelFrom ?? 'D', to: input.levelTo ?? 'A' },
    capacity: 4,
    participants: [
      {
        userId: organizerId,
        displayName: 'Организатор',
        avatarUrl: null,
        level: 'C+',
        role: 'ORGANIZER',
        paymentState: 'NOT_REQUIRED',
      },
      ...(input.participant
        ? ([
            {
              userId,
              displayName: 'Анна Петрова',
              avatarUrl: null,
              level: 'C+',
              role: 'PLAYER',
              paymentState: 'NOT_REQUIRED',
            },
          ] as const)
        : []),
    ],
    seatReservations: [],
    waitlist: [],
    waitlistEnabled: true,
    joinCutoffAt: null,
    priceSummary: null,
    ...(lifecycleState === 'FINISHED'
      ? {
          result: {
            state: 'CONFIRMED' as const,
            submittedByUserId: organizerId,
            requiredConfirmationUserIds: [],
            confirmedByUserIds: [],
            sets: [{ teamA: 6, teamB: 4 }],
          },
        }
      : {}),
  };
  return {
    gameId: snapshot.id,
    aggregateRevision: 1,
    projectionRevision: 1,
    lifecycleState,
    visibility: 'PUBLIC',
    startsAt: snapshot.startsAt,
    endsAt: snapshot.endsAt,
    basePayload: snapshot,
    projectedAt: '2026-07-18T09:00:00.000Z',
  };
}

describe('booking recommendations', () => {
  it('hard-filters incompatible levels and ranks explicit station/time preferences', async () => {
    const repository = {
      listRecommendationCardProjections: vi.fn().mockResolvedValue({
        candidates: [
          projection({
            id: '10000000-0000-4000-8000-000000000001',
            startsAt: '2026-07-20T15:30:00.000Z',
            stationId: favoriteStationId,
            stationName: 'Селигерская',
            levelFrom: 'C',
            levelTo: 'B',
          }),
          projection({
            id: '10000000-0000-4000-8000-000000000002',
            startsAt: '2026-07-19T10:00:00.000Z',
            stationId: otherStationId,
            stationName: 'Другая',
            levelFrom: 'A',
            levelTo: 'A',
          }),
        ],
        history: [],
      }),
    };

    const page = await listBookingRecommendations({
      repository,
      tenantId,
      userId,
      preferences: {
        favoriteStationIds: [favoriteStationId],
        preferredTimeWindows: [{ weekday: 'MON', startsAt: '18:00', endsAt: '21:00' }],
        useHistory: true,
        version: 2,
        updatedAt: '2026-07-18T08:00:00.000Z',
      },
      playerLevel: 'C+',
      now: '2026-07-18T09:00:00.000Z',
      limit: 6,
    });

    expect(page.personalization).toBe('EXPLICIT');
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      game: { station: { id: favoriteStationId }, surface: 'DISCOVER' },
      reasons: ['LEVEL_MATCH', 'FAVORITE_STATION', 'PREFERRED_TIME'],
    });
    expect(page.version).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(page)).not.toContain('score');
  });

  it('uses only three or more completed recent games for learned personalization', async () => {
    const history = [0, 1, 2].map((index) =>
      projection({
        id: `20000000-0000-4000-8000-00000000000${index + 1}`,
        startsAt: `2026-07-${String(12 + index).padStart(2, '0')}T16:00:00.000Z`,
        stationId: favoriteStationId,
        stationName: 'Селигерская',
        lifecycleState: 'FINISHED',
        participant: true,
      }),
    );
    const repository = {
      listRecommendationCardProjections: vi.fn().mockResolvedValue({
        candidates: [
          projection({
            id: '30000000-0000-4000-8000-000000000001',
            startsAt: '2026-07-20T16:00:00.000Z',
            stationId: favoriteStationId,
            stationName: 'Селигерская',
          }),
        ],
        history,
      }),
    };

    const page = await listBookingRecommendations({
      repository,
      tenantId,
      userId,
      preferences: {
        favoriteStationIds: [],
        preferredTimeWindows: [],
        useHistory: true,
        version: 0,
        updatedAt: null,
      },
      playerLevel: null,
      now: '2026-07-18T09:00:00.000Z',
      limit: 6,
    });

    expect(page.personalization).toBe('LEARNED');
    expect(page.items[0]?.reasons).toContain('PLAYED_STATION');
  });
});
