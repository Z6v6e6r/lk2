import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  importSnapshots: vi.fn(),
  synchronizeParticipants: vi.fn(),
  synchronizeLegacyParticipantPhotos: vi.fn(),
}));

vi.mock('@phub/database', () => ({
  createLegacyGameImportRepository: () => ({
    importSnapshots: mocks.importSnapshots,
    synchronizeParticipants: mocks.synchronizeParticipants,
  }),
}));

vi.mock('./legacy-participant-photo-sync.js', () => ({
  synchronizeLegacyParticipantPhotos: mocks.synchronizeLegacyParticipantPhotos,
}));

import { runLegacyGamesRosterSyncCycle } from './legacy-games-roster-sync.js';

describe('legacy Games roster synchronization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('copies participant photos after the import creates local player mappings', async () => {
    const now = new Date('2026-07-25T09:00:00.000Z');
    const snapshots = [
      {
        externalId: 'legacy-game-1',
        participants: [
          {
            externalId: 'legacy-player-1',
            avatarSourceUrl: 'https://562807.selcdn.ru/smstretching/player-one',
          },
        ],
      },
    ];
    const historicalSnapshots = [
      {
        externalId: 'legacy-history-game-1',
        participants: [
          {
            externalId: 'legacy-history-player-1',
            avatarSourceUrl: 'https://562807.selcdn.ru/smstretching/history-player-one',
          },
        ],
      },
    ];
    mocks.importSnapshots.mockResolvedValue({
      tenantId: '86afbe01-0318-4dd2-bc25-303b7bf0d430',
      imported: ['legacy-game-1'],
    });
    mocks.synchronizeParticipants.mockResolvedValue({
      tenantId: '86afbe01-0318-4dd2-bc25-303b7bf0d430',
      synced: ['legacy-game-1'],
      bootstrapped: 1,
      unchanged: 0,
      conflicts: 0,
      skipped: 0,
    });
    mocks.synchronizeLegacyParticipantPhotos.mockResolvedValue({
      stored: 1,
      unchanged: 0,
      failed: 0,
    });
    const source = {
      read: vi.fn().mockResolvedValueOnce(snapshots).mockResolvedValueOnce(historicalSnapshots),
    };
    const logger = { info: vi.fn() };

    await expect(
      runLegacyGamesRosterSyncCycle({
        pool: {} as never,
        config: {
          LEGACY_GAMES_ROSTER_SYNC_ENABLED: true,
          LEGACY_GAMES_ROSTER_SYNC_LOOKBACK_DAYS: 1,
          LEGACY_GAMES_ROSTER_SYNC_LOOKAHEAD_DAYS: 42,
          LEGACY_GAMES_ROSTER_SYNC_LIMIT: 200,
          LEGACY_GAMES_PROFILE_PHOTO_SYNC_LOOKBACK_DAYS: 30,
          LEGACY_GAMES_ROSTER_SYNC_TENANT_KEY: 'local-padel',
        } as never,
        logger: logger as never,
        source,
        profilePhotoStore: {} as never,
        now,
      }),
    ).resolves.toMatchObject({
      attempted: 1,
      imported: 1,
      synced: 1,
      avatarsStored: 1,
      avatarsUnchanged: 0,
      avatarsFailed: 0,
    });

    expect(mocks.synchronizeParticipants).toHaveBeenCalledBefore(
      mocks.synchronizeLegacyParticipantPhotos,
    );
    expect(mocks.synchronizeLegacyParticipantPhotos).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: '86afbe01-0318-4dd2-bc25-303b7bf0d430',
        snapshots: [...historicalSnapshots, ...snapshots],
        fetchedAt: now.toISOString(),
      }),
    );
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ avatarsStored: 1 }),
      'legacy Games roster synchronization completed',
    );
  });

  it('does no source or storage work when the roster bridge is disabled', async () => {
    const source = { read: vi.fn() };

    await expect(
      runLegacyGamesRosterSyncCycle({
        pool: {} as never,
        config: { LEGACY_GAMES_ROSTER_SYNC_ENABLED: false } as never,
        logger: {} as never,
        source,
        profilePhotoStore: {} as never,
      }),
    ).resolves.toEqual({
      attempted: 0,
      imported: 0,
      synced: 0,
      bootstrapped: 0,
      unchanged: 0,
      conflicts: 0,
      skipped: 0,
      avatarsStored: 0,
      avatarsUnchanged: 0,
      avatarsFailed: 0,
    });

    expect(source.read).not.toHaveBeenCalled();
    expect(mocks.synchronizeLegacyParticipantPhotos).not.toHaveBeenCalled();
  });
});
