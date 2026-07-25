import { describe, expect, it, vi } from 'vitest';

import { synchronizeLegacyParticipantPhotos } from './legacy-participant-photo-sync.js';

const tenantId = '86afbe01-0318-4dd2-bc25-303b7bf0d430';
const fetchedAt = '2026-07-25T09:00:00.000Z';

describe('legacy participant photo synchronization', () => {
  it('copies mapped source photos and retains a previously stored photo on source failure', async () => {
    const logger = { warn: vi.fn() };
    const resolveTargets = vi.fn().mockResolvedValue([
      {
        userId: '49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca',
        sourceUrl: 'https://562807.selcdn.ru/smstretching/player-one',
      },
      {
        userId: '59d4e88c-7d52-4c1c-8f80-2fc99b42f9ca',
        sourceUrl: 'https://562807.selcdn.ru/smstretching/player-two',
      },
    ]);
    const synchronizePhoto = vi
      .fn()
      .mockResolvedValueOnce({
        outcome: 'stored',
        persistence: {
          avatarUrl: '/public/api/v1/media/profile-photos/tenant/delivery-one',
          deliveryId: '69d4e88c-7d52-4c1c-8f80-2fc99b42f9ca',
          sourceUrl: 'https://562807.selcdn.ru/smstretching/player-one',
          contentSha256: 'a'.repeat(64),
          objectKey: 'profile-photos/tenant/player-one/a.webp',
          syncedAt: fetchedAt,
        },
      })
      .mockResolvedValueOnce({
        outcome: 'fallback',
        errorCode: 'PROFILE_PHOTO_SOURCE_HTTP_503',
        persistence: {
          avatarUrl: '/public/api/v1/media/profile-photos/tenant/delivery-two',
          deliveryId: '79d4e88c-7d52-4c1c-8f80-2fc99b42f9ca',
          sourceUrl: 'https://562807.selcdn.ru/smstretching/player-two',
          contentSha256: 'b'.repeat(64),
          objectKey: 'profile-photos/tenant/player-two/b.webp',
          syncedAt: fetchedAt,
        },
      });
    const persistPhoto = vi.fn().mockResolvedValue(undefined);

    await expect(
      synchronizeLegacyParticipantPhotos(
        {
          pool: {} as never,
          tenantId,
          snapshots: [{ participants: [] }] as never,
          participants: [
            {
              externalId: 'canonical-player-one',
              externalAliases: ['legacy-player-one'],
              avatarSourceUrl: 'https://562807.selcdn.ru/smstretching/player-one',
            },
          ],
          config: {
            PROFILE_PHOTO_ALLOWED_HOSTS: '.selcdn.ru',
            PROFILE_PHOTO_MAX_BYTES: 5_000_000,
            PROFILE_PHOTO_MAX_DIMENSION: 1_024,
            PROFILE_PHOTO_WEBP_QUALITY: 82,
            PROFILE_PHOTO_URL_TTL_SECONDS: 3_600,
            HOME_PROJECTION_MAX_STALE_SECONDS: 900,
            VIVA_TIMEOUT_MS: 8_000,
          } as never,
          store: {} as never,
          logger: logger as never,
          correlationId: 'legacy-games-roster-sync-test',
          fetchedAt,
        },
        {
          resolveTargets,
          synchronizePhoto,
          persistPhoto,
        },
      ),
    ).resolves.toEqual({ stored: 1, unchanged: 0, failed: 1 });

    expect(resolveTargets).toHaveBeenCalledWith({
      pool: {},
      tenantId,
      snapshots: [{ participants: [] }],
      participants: [
        {
          externalId: 'canonical-player-one',
          externalAliases: ['legacy-player-one'],
          avatarSourceUrl: 'https://562807.selcdn.ru/smstretching/player-one',
        },
      ],
    });
    expect(synchronizePhoto).toHaveBeenCalledTimes(2);
    expect(synchronizePhoto).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        sourceUrl: 'https://562807.selcdn.ru/smstretching/player-one',
        replaceExistingSource: false,
        allowedHosts: ['.selcdn.ru'],
      }),
    );
    expect(persistPhoto).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'PROFILE_PHOTO_SOURCE_HTTP_503' }),
      'legacy participant photo synchronization retained the local photo',
    );
  });

  it('isolates a single player failure so the remaining photos can continue', async () => {
    const logger = { warn: vi.fn() };
    const synchronizePhoto = vi
      .fn()
      .mockRejectedValueOnce(new Error('PROFILE_PHOTO_SOURCE_TIMEOUT'))
      .mockResolvedValueOnce({
        outcome: 'unchanged',
        persistence: {
          avatarUrl: '/public/api/v1/media/profile-photos/tenant/delivery',
          deliveryId: '89d4e88c-7d52-4c1c-8f80-2fc99b42f9ca',
          sourceUrl: 'https://562807.selcdn.ru/smstretching/player-two',
          contentSha256: 'c'.repeat(64),
          objectKey: 'profile-photos/tenant/player-two/c.webp',
          syncedAt: fetchedAt,
        },
      });
    const persistPhoto = vi.fn().mockResolvedValue(undefined);

    await expect(
      synchronizeLegacyParticipantPhotos(
        {
          pool: {} as never,
          tenantId,
          snapshots: [] as never,
          config: {
            PROFILE_PHOTO_ALLOWED_HOSTS: '.selcdn.ru',
            PROFILE_PHOTO_MAX_BYTES: 5_000_000,
            PROFILE_PHOTO_MAX_DIMENSION: 1_024,
            PROFILE_PHOTO_WEBP_QUALITY: 82,
            PROFILE_PHOTO_URL_TTL_SECONDS: 3_600,
            HOME_PROJECTION_MAX_STALE_SECONDS: 900,
            VIVA_TIMEOUT_MS: 8_000,
          } as never,
          store: {} as never,
          logger: logger as never,
          correlationId: 'legacy-games-roster-sync-test',
          fetchedAt,
        },
        {
          resolveTargets: vi.fn().mockResolvedValue([
            {
              userId: '49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca',
              sourceUrl: 'https://562807.selcdn.ru/smstretching/player-one',
            },
            {
              userId: '59d4e88c-7d52-4c1c-8f80-2fc99b42f9ca',
              sourceUrl: 'https://562807.selcdn.ru/smstretching/player-two',
            },
          ]),
          synchronizePhoto,
          persistPhoto,
        },
      ),
    ).resolves.toEqual({ stored: 0, unchanged: 1, failed: 1 });

    expect(synchronizePhoto).toHaveBeenCalledTimes(2);
    expect(persistPhoto).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'PROFILE_PHOTO_SOURCE_TIMEOUT' }),
      'legacy participant photo synchronization failed',
    );
  });
});
