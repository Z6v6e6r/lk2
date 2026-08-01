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
  readonly friendUserId?: string;
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
    court: null,
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
      ...(input.friendUserId
        ? [
            {
              userId: input.friendUserId,
              displayName: 'Друг игрока',
              avatarUrl: null,
              level: 'C+' as const,
              role: 'PLAYER' as const,
              paymentState: 'NOT_REQUIRED' as const,
            },
          ]
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
        recommendFriends: true,
        recommendationDisplay: 'CARDS',
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
      kind: 'GAME',
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
        recommendFriends: true,
        recommendationDisplay: 'CARDS',
        version: 0,
        updatedAt: null,
      },
      playerLevel: null,
      now: '2026-07-18T09:00:00.000Z',
      limit: 1,
    });

    expect(page.personalization).toBe('LEARNED');
    expect(page.items[0]?.reasons).toContain('PLAYED_STATION');
  });

  it('boosts eligible games containing a friend when the preference is enabled', async () => {
    const friendUserId = '77777777-7777-4777-8777-777777777777';
    const friendGameId = '35000000-0000-4000-8000-000000000002';
    const repository = {
      listRecommendationCardProjections: vi.fn().mockResolvedValue({
        candidates: [
          projection({
            id: '35000000-0000-4000-8000-000000000001',
            startsAt: '2026-07-19T10:00:00.000Z',
            stationId: favoriteStationId,
            stationName: 'Селигерская',
          }),
          projection({
            id: friendGameId,
            startsAt: '2026-07-20T10:00:00.000Z',
            stationId: favoriteStationId,
            stationName: 'Селигерская',
            friendUserId,
          }),
        ],
        history: [],
      }),
    };

    const page = await listBookingRecommendations({
      repository,
      tenantId,
      userId,
      friendUserIds: [friendUserId],
      preferences: {
        favoriteStationIds: [],
        preferredTimeWindows: [{ weekday: 'ANY', startsAt: '09:00', endsAt: '22:00' }],
        useHistory: true,
        recommendFriends: true,
        recommendationDisplay: 'CARDS',
        version: 1,
        updatedAt: '2026-07-18T08:00:00.000Z',
      },
      playerLevel: null,
      now: '2026-07-18T09:00:00.000Z',
      limit: 1,
    });

    expect(page.items[0]).toMatchObject({
      kind: 'GAME',
      game: { id: friendGameId },
    });
    expect(page.items[0]?.reasons).toContain('FRIEND_PLAYING');
  });

  it('keeps the best training and tournament visible alongside higher-scoring games', async () => {
    const repository = {
      listRecommendationCardProjections: vi.fn().mockResolvedValue({
        candidates: [1, 2, 3, 4].map((index) =>
          projection({
            id: `40000000-0000-4000-8000-00000000000${index}`,
            startsAt: `2026-07-${String(19 + index).padStart(2, '0')}T15:30:00.000Z`,
            stationId: favoriteStationId,
            stationName: 'Селигерская',
            levelFrom: 'C',
            levelTo: 'B',
          }),
        ),
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
        recommendFriends: true,
        recommendationDisplay: 'CARDS',
        version: 2,
        updatedAt: '2026-07-18T08:00:00.000Z',
      },
      playerLevel: 'C+',
      activities: [
        {
          id: '50000000-0000-4000-8000-000000000001',
          kind: 'TRAINING',
          title: 'Групповая тренировка',
          startsAt: '2026-07-21T08:00:00.000Z',
          endsAt: '2026-07-21T09:30:00.000Z',
          timezone: 'Europe/Moscow',
          station: {
            id: otherStationId,
            name: 'Терехово',
            shortAddress: null,
          },
          levelRange: { from: 'C', to: 'B' },
          capacity: { total: 8, open: 3 },
          host: {
            displayName: 'Мария Орлова',
            avatarUrl: null,
            role: 'TRAINER',
          },
          route: '/trainings?event=50000000-0000-4000-8000-000000000001',
        },
        {
          id: '50000000-0000-4000-8000-000000000002',
          kind: 'TOURNAMENT',
          title: 'Турнир из Viva не должен попасть в рекомендации',
          startsAt: '2026-07-22T08:00:00.000Z',
          endsAt: '2026-07-22T10:00:00.000Z',
          timezone: 'Europe/Moscow',
          station: {
            id: otherStationId,
            name: 'Сколково',
            shortAddress: null,
          },
          levelRange: { from: 'C', to: 'B' },
          capacity: { total: 16, open: 1 },
          host: {
            displayName: 'Илья Соколов',
            avatarUrl: null,
            role: 'ORGANIZER',
          },
          route: '/tournaments?event=50000000-0000-4000-8000-000000000002',
        },
      ],
      tournaments: [
        {
          id: '70000000-0000-4000-8000-000000000001',
          title: 'Мини-турнир из ЦУП',
          format: 'Американо',
          startsAt: '2026-07-22T08:00:00.000Z',
          endsAt: '2026-07-22T10:00:00.000Z',
          venue: 'Сколково',
          trainerName: 'Илья Соколов',
          levelRange: { from: 'C', to: 'B' },
          organizer: {
            displayName: 'Илья Соколов',
            avatarUrl: null,
          },
          capacity: {
            total: 16,
            registered: 15,
            open: 1,
            waitlist: 0,
          },
          status: 'REGISTRATION',
          route: '/tournaments?event=70000000-0000-4000-8000-000000000001',
        },
      ],
      now: '2026-07-18T09:00:00.000Z',
      limit: 4,
    });

    expect(page.items).toHaveLength(4);
    expect(page.items.map((item) => item.kind)).toEqual(
      expect.arrayContaining(['GAME', 'TRAINING', 'TOURNAMENT']),
    );
    expect(page.items.find((item) => item.kind === 'TRAINING')).toMatchObject({
      activity: {
        title: 'Групповая тренировка',
        levelRange: { from: 'C', to: 'B' },
        host: { displayName: 'Мария Орлова', role: 'TRAINER' },
      },
    });
    expect(page.items.find((item) => item.kind === 'TOURNAMENT')).toMatchObject({
      activity: {
        id: '70000000-0000-4000-8000-000000000001',
        title: 'Мини-турнир из ЦУП',
        host: { displayName: 'Илья Соколов', role: 'ORGANIZER' },
      },
    });
    expect(JSON.stringify(page.items)).not.toContain('Турнир из Viva не должен попасть');
    const startsAt = page.items.map((item) =>
      item.kind === 'GAME' ? item.game.startsAt : item.activity.startsAt,
    );
    expect(startsAt).toEqual([...startsAt].sort((left, right) => left.localeCompare(right)));
  });

  it('returns a stable first page of 14 recommendations and subsequent pages of 12', async () => {
    const candidates = Array.from({ length: 30 }, (_, index) =>
      projection({
        id: `60000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
        startsAt: new Date(
          Date.parse('2026-07-20T09:00:00.000Z') + index * 60 * 60 * 1_000,
        ).toISOString(),
        stationId: favoriteStationId,
        stationName: 'Терехово',
      }),
    );
    const repository = {
      listRecommendationCardProjections: vi.fn().mockResolvedValue({
        candidates,
        history: [],
      }),
    };
    const baseInput = {
      repository,
      tenantId,
      userId,
      preferences: {
        favoriteStationIds: [],
        preferredTimeWindows: [],
        useHistory: false,
        recommendFriends: true,
        recommendationDisplay: 'CARDS',
        version: 0,
        updatedAt: null,
      },
      playerLevel: null,
      now: '2026-07-18T09:00:00.000Z',
    } as const;

    const firstPage = await listBookingRecommendations({ ...baseInput, limit: 14 });
    const secondPage = await listBookingRecommendations({
      ...baseInput,
      limit: 12,
      cursor: firstPage.nextCursor!,
    });
    const thirdPage = await listBookingRecommendations({
      ...baseInput,
      limit: 12,
      cursor: secondPage.nextCursor!,
    });

    expect(firstPage.items).toHaveLength(14);
    expect(secondPage.items).toHaveLength(12);
    expect(thirdPage.items).toHaveLength(4);
    expect(firstPage.nextCursor).toEqual(expect.any(String));
    expect(secondPage.nextCursor).toEqual(expect.any(String));
    expect(thirdPage.nextCursor).toBeNull();
    expect(repository.listRecommendationCardProjections).toHaveBeenCalledOnce();
    const distinctIds = new Set(
      [...firstPage.items, ...secondPage.items, ...thirdPage.items].map((item) =>
        item.kind === 'GAME' ? item.game.id : item.activity.id,
      ),
    );
    expect(distinctIds.size).toBe(30);
  });
});
