import type {
  ActivityHistoryRepository,
  ActivityHistorySyncState,
  PersistActivityHistoryItemInput,
} from '@phub/database';
import type { VivaBookingHistoryPage } from '@phub/viva-adapter';
import { describe, expect, it, vi } from 'vitest';

import { ActivityHistoryRefreshCoordinator } from './activity-history-refresh.js';

const tenantId = '86afbe01-0318-4dd2-bc25-303b7bf0d430';
const userId = '49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca';

function unsynced(): ActivityHistorySyncState {
  return {
    userId,
    coverageStatus: 'UNSYNCED',
    freshness: 'UNSYNCED',
    lastSuccessAt: null,
    staleAt: null,
    oldestSyncedAt: null,
    nextProviderCursor: null,
    sourceRevision: null,
    lastErrorCode: null,
    updatedAt: null,
  };
}

function page(records: VivaBookingHistoryPage['records'] = []): VivaBookingHistoryPage {
  return {
    records,
    page: 0,
    size: 20,
    totalElements: records.length,
    isLastPage: true,
    nextPage: null,
  };
}

function repository() {
  let persistedItems: readonly PersistActivityHistoryItemInput[] = [];
  const persistPage = vi.fn((input: Parameters<ActivityHistoryRepository['persistPage']>[0]) => {
    persistedItems = input.items;
    return Promise.resolve({ ...unsynced(), coverageStatus: 'COMPLETE' as const });
  });
  const value: ActivityHistoryRepository = {
    resolveVivaExerciseGameAssociations: () => Promise.resolve([]),
    getSyncState: () => Promise.resolve(unsynced()),
    resolveSourceMapping: () =>
      Promise.resolve({
        mappingId: '22222222-2222-4222-8222-222222222222',
        internalId: '11111111-1111-4111-8111-111111111111',
      }),
    list: () => Promise.resolve({ items: [] }),
    persistPage,
    recordSyncFailure: () => Promise.resolve(unsynced()),
  };
  return { value, persistPage, items: () => persistedItems };
}

describe('ActivityHistoryRefreshCoordinator', () => {
  it('persists a provider-neutral normalized page and complete empty coverage', async () => {
    const repo = repository();
    const sourcePage = page([
      {
        sourceRef: { bookingRef: 'provider-booking-secret' },
        kind: 'TRAINING',
        status: 'COMPLETED',
        title: 'Групповая тренировка',
        startsAt: '2026-07-20T09:00:00.000Z',
        venue: { name: 'Терехово', room: 'Корт 1' },
        routeHint: 'NONE',
      },
    ]);
    const coordinator = new ActivityHistoryRefreshCoordinator({
      repository: repo.value,
      source: { readPage: () => Promise.resolve(sourcePage) },
      getAccessToken: () => Promise.resolve('server-only-viva-token'),
      pageSize: 20,
      freshSeconds: 300,
      now: () => new Date('2026-07-21T10:00:00.000Z'),
    });

    await coordinator.refresh({
      tenantId,
      userId,
      correlationId: 'correlation-1',
      reason: 'UNCOVERED',
    });

    expect(repo.items()).toMatchObject([
      {
        id: '11111111-1111-4111-8111-111111111111',
        kind: 'TRAINING',
        details: { subtitle: 'Корт 1' },
      },
    ]);
    expect(JSON.stringify(repo.items())).not.toContain('provider-booking-secret');
    expect(repo.persistPage.mock.calls[0]?.[0].sync).toMatchObject({
      coverageStatus: 'COMPLETE',
      staleAt: '2026-07-21T10:05:00.000Z',
    });
  });

  it('coalesces concurrent refreshes for one tenant user', async () => {
    const repo = repository();
    const readPage = vi.fn(() => Promise.resolve(page()));
    const coordinator = new ActivityHistoryRefreshCoordinator({
      repository: repo.value,
      source: { readPage },
      getAccessToken: () => Promise.resolve('server-only-viva-token'),
      pageSize: 20,
      freshSeconds: 300,
    });
    const input = {
      tenantId,
      userId,
      correlationId: 'correlation-1',
      reason: 'UNCOVERED' as const,
    };

    await Promise.all([coordinator.refresh(input), coordinator.refresh(input)]);

    expect(readPage).toHaveBeenCalledTimes(1);
  });

  it('projects canonical local Games into the same persisted history page', async () => {
    const repo = repository();
    const coordinator = new ActivityHistoryRefreshCoordinator({
      repository: repo.value,
      source: { readPage: () => Promise.resolve(page()) },
      getAccessToken: () => Promise.resolve('server-only-viva-token'),
      pageSize: 20,
      freshSeconds: 300,
      readLocalGames: () =>
        Promise.resolve([
          {
            id: '33333333-3333-4333-8333-333333333333',
            revision: 7,
            displayState: 'COMPLETED',
            title: 'Игра на рейтинг',
            startsAt: '2026-07-19T12:00:00.000Z',
            endsAt: '2026-07-19T13:30:00.000Z',
            station: { name: 'Нагатинская' },
            deepLink: '/games/33333333-3333-4333-8333-333333333333',
          },
        ]),
    });

    await coordinator.refresh({
      tenantId,
      userId,
      correlationId: 'correlation-1',
      reason: 'UNCOVERED',
    });

    expect(repo.items()).toMatchObject([
      {
        id: '33333333-3333-4333-8333-333333333333',
        gameId: '33333333-3333-4333-8333-333333333333',
        kind: 'GAME',
        details: { game: { revision: 7 } },
      },
    ]);
  });

  it('projects confirmed tournament standings only after exact viewer identity mapping', async () => {
    const repo = repository();
    const exerciseRef = '21111111-1111-4111-8111-111111111111';
    const tournamentPage = page([
      {
        sourceRef: { bookingRef: 'provider-booking-secret', exerciseRef },
        kind: 'TOURNAMENT',
        status: 'COMPLETED',
        title: 'Время на друзей',
        startsAt: '2026-08-04T05:30:00.000Z',
        endsAt: '2026-08-04T07:00:00.000Z',
        venue: { name: 'Терехово' },
        routeHint: 'NONE',
      },
    ]);
    const coordinator = new ActivityHistoryRefreshCoordinator({
      repository: repo.value,
      source: { readPage: () => Promise.resolve(tournamentPage) },
      getAccessToken: () => Promise.resolve('server-only-viva-token'),
      pageSize: 20,
      freshSeconds: 300,
      tournamentResultSource: {
        read: () =>
          Promise.resolve({
            id: '33333333-3333-4333-8333-333333333333',
            status: 'CONFIRMED',
            podium: [
              { externalParticipantId: 'viva-player-1', displayName: 'Иван', place: 1 },
              { externalParticipantId: 'viva-player-2', displayName: 'Артём', place: 2 },
              { externalParticipantId: 'viva-player-3', displayName: 'Максим', place: 3 },
            ],
            standings: [
              { externalParticipantId: 'viva-player-1', displayName: 'Иван', place: 1 },
              { externalParticipantId: 'viva-player-2', displayName: 'Артём', place: 2 },
              { externalParticipantId: 'viva-player-3', displayName: 'Максим', place: 3 },
              { externalParticipantId: 'viva-viewer', displayName: 'Алексей', place: 5 },
            ],
            sourceUpdatedAt: '2026-08-04T07:05:00.000Z',
          }),
      },
      resolveTournamentProfileIds: ({ externalClientIds }) => {
        expect(externalClientIds).toEqual([
          'viva-player-1',
          'viva-player-2',
          'viva-player-3',
          'viva-viewer',
        ]);
        return Promise.resolve(
          new Map([
            ['viva-player-1', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],
            ['viva-player-2', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'],
            ['viva-viewer', userId],
          ]),
        );
      },
    });

    await coordinator.refresh({
      tenantId,
      userId,
      correlationId: 'correlation-1',
      reason: 'UNCOVERED',
    });

    expect(repo.items()).toMatchObject([
      {
        kind: 'TOURNAMENT',
        tournamentId: '33333333-3333-4333-8333-333333333333',
        details: {
          tournamentResult: {
            status: 'CONFIRMED',
            podium: [
              { profileId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', place: 1 },
              { profileId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', place: 2 },
              { profileId: null, place: 3 },
            ],
            viewer: { profileId: userId, displayName: 'Алексей', place: 5 },
          },
        },
      },
    ]);
    expect(JSON.stringify(repo.items())).not.toMatch(
      /provider-booking-secret|viva-player|exerciseRef/,
    );
  });

  it('keeps the compact tournament summary when result identity cannot be proven', async () => {
    const repo = repository();
    const tournamentPage = page([
      {
        sourceRef: {
          bookingRef: 'provider-booking-secret',
          exerciseRef: '21111111-1111-4111-8111-111111111111',
        },
        kind: 'TOURNAMENT',
        status: 'COMPLETED',
        title: 'Время на друзей',
        startsAt: '2026-08-04T05:30:00.000Z',
        venue: { name: 'Терехово' },
        routeHint: 'NONE',
      },
    ]);
    const coordinator = new ActivityHistoryRefreshCoordinator({
      repository: repo.value,
      source: { readPage: () => Promise.resolve(tournamentPage) },
      getAccessToken: () => Promise.resolve('server-only-viva-token'),
      pageSize: 20,
      freshSeconds: 300,
      tournamentResultSource: { read: () => Promise.reject(new Error('source down')) },
      resolveTournamentProfileIds: () => Promise.resolve(new Map()),
    });

    await coordinator.refresh({
      tenantId,
      userId,
      correlationId: 'correlation-1',
      reason: 'UNCOVERED',
    });

    expect(repo.items()).toMatchObject([
      { kind: 'TOURNAMENT', title: 'Время на друзей', details: {} },
    ]);
  });

  it('replaces the Viva row by its exact opaque exercise association', async () => {
    const repo = repository();
    const gameId = '33333333-3333-4333-8333-333333333333';
    let backfillCompleted = false;
    const backfillGames = vi.fn(() => {
      backfillCompleted = true;
      return Promise.resolve();
    });
    repo.value.resolveVivaExerciseGameAssociations = ({ associationIds }) =>
      Promise.resolve([{ associationId: associationIds[0] as string, gameId }]);
    const coordinator = new ActivityHistoryRefreshCoordinator({
      repository: repo.value,
      source: {
        readPage: () =>
          Promise.resolve(
            page([
              {
                sourceRef: {
                  bookingRef: 'provider-booking-secret',
                  exerciseRef: '21111111-1111-4111-8111-111111111111',
                },
                kind: 'GAME',
                status: 'COMPLETED',
                title: 'Открытая игра',
                startsAt: '2026-07-20T09:00:00.000Z',
                endsAt: '2026-07-20T10:00:00.000Z',
                venue: { name: 'Название Viva не совпадает' },
                routeHint: 'GAME_DETAILS',
              },
            ]),
          ),
      },
      getAccessToken: () => Promise.resolve('server-only-viva-token'),
      pageSize: 20,
      freshSeconds: 300,
      backfillGames,
      readLocalGames: () => {
        expect(backfillCompleted).toBe(true);
        return Promise.resolve([
          {
            id: gameId,
            revision: 7,
            displayState: 'RESULT_REQUIRED',
            title: 'Открытая игра',
            startsAt: '2026-07-20T09:00:00.000Z',
            endsAt: '2026-07-20T10:00:00.000Z',
            station: { name: 'ПаделхАБ Терехово' },
            deepLink: `/games/${gameId}`,
          },
        ]);
      },
    });

    await coordinator.refresh({
      tenantId,
      userId,
      correlationId: 'correlation-1',
      reason: 'UNCOVERED',
    });

    expect(repo.items()).toHaveLength(1);
    expect(backfillGames).toHaveBeenCalledWith(
      expect.objectContaining({
        exerciseOccurrences: [
          {
            exerciseExternalId: '21111111-1111-4111-8111-111111111111',
            startsAt: '2026-07-20T09:00:00.000Z',
          },
        ],
      }),
    );
    expect(repo.items()[0]).toMatchObject({
      id: gameId,
      gameId,
      details: { game: { displayState: 'RESULT_REQUIRED' } },
    });
    expect(repo.persistPage.mock.calls[0]?.[0].supersededItemIds).toEqual([
      '11111111-1111-4111-8111-111111111111',
    ]);
    expect(JSON.stringify(repo.items())).not.toContain('provider-booking-secret');
  });

  it('records a stable failure without turning it into empty complete coverage', async () => {
    const repo = repository();
    const recordSyncFailure = vi.fn(() => Promise.resolve(unsynced()));
    repo.value.recordSyncFailure = recordSyncFailure;
    const coordinator = new ActivityHistoryRefreshCoordinator({
      repository: repo.value,
      source: {
        readPage: () =>
          Promise.reject(Object.assign(new Error('down'), { code: 'EXTERNAL_SOURCE_UNAVAILABLE' })),
      },
      getAccessToken: () => Promise.resolve('server-only-viva-token'),
      pageSize: 20,
      freshSeconds: 300,
    });

    await expect(
      coordinator.refresh({
        tenantId,
        userId,
        correlationId: 'correlation-1',
        reason: 'UNCOVERED',
      }),
    ).rejects.toThrow('down');
    expect(recordSyncFailure).toHaveBeenCalledWith({
      tenantId,
      userId,
      errorCode: 'EXTERNAL_SOURCE_UNAVAILABLE',
    });
    expect(repo.persistPage).not.toHaveBeenCalled();
  });
});
