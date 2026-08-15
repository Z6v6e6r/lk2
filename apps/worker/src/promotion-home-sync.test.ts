import { loadConfig } from '@phub/config';
import type { Logger } from 'pino';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { LegacyPromotionSourceSnapshot } from './legacy-promotion-source.js';
import { readPromotionSourceSnapshots, runPromotionHomeSyncCycle } from './promotion-home-sync.js';
import type { ProfilePhotoObjectStore } from './profile-photo-sync.js';

const repositoryMocks = vi.hoisted(() => ({
  completePromotionMediaObjectGc: vi.fn(),
  listDuePromotionHomeUsers: vi.fn(),
  listDuePromotionMediaObjects: vi.fn(),
  loadPromotionMediaSyncRecords: vi.fn(),
  persistPromotionHomeSource: vi.fn(),
  persistPromotionMedia: vi.fn(),
  recordPromotionMediaObjectGcFailure: vi.fn(),
  resolvePromotionIds: vi.fn(),
}));

const mediaMocks = vi.hoisted(() => ({
  synchronizePromotionMedia: vi.fn(),
}));

vi.mock('./promotion-home-repository.js', () => repositoryMocks);
vi.mock('./promotion-media-sync.js', () => mediaMocks);

const tenantId = '86afbe01-0318-4dd2-bc25-303b7bf0d430';
const userId = '49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca';

function config() {
  return loadConfig({
    APP_ENV: 'ci',
    DATABASE_URL: 'postgresql://phub:test@localhost:5432/phub',
    REDIS_URL: 'redis://localhost:6379',
    RABBITMQ_URL: 'amqp://phub:test@localhost:5672',
    JWT_ISSUER: 'phub-identity',
    JWT_AUDIENCE: 'phub-api',
    JWT_ACCESS_SECRET: 'test-access-secret-at-least-32-characters',
    JWT_REFRESH_SECRET: 'test-refresh-secret-at-least-32-characters',
    PROMOTION_IMAGE_ALLOWED_HOSTS: 'padlhub.su, cdn.padlhub.su',
    PROMOTION_IMAGE_PRIVATE_HTTP_HOSTS: 'legacy.internal',
  });
}

function snapshot(
  externalId: string,
  options: {
    readonly rotationEnabled?: boolean;
    readonly repeatEveryCards?: number;
    readonly cardImages?: boolean;
  } = {},
): LegacyPromotionSourceSnapshot {
  return {
    rotationEnabled: options.rotationEnabled ?? false,
    ...(options.repeatEveryCards ? { repeatEveryCards: options.repeatEveryCards } : {}),
    items: [
      {
        externalId,
        title: `Акция ${externalId}`,
        badgeText: 'Только сегодня',
        footerText: 'Количество мест ограничено',
        href: `/promo/${externalId}`,
        imageSourceUrl: `https://padlhub.su/${externalId}.webp`,
        ...(options.cardImages
          ? {
              squareImageSourceUrl: `https://padlhub.su/${externalId}-square.webp`,
              horizontalImageSourceUrl: `https://padlhub.su/${externalId}-wide.webp`,
            }
          : {}),
      },
    ],
    updatedAt: '2026-07-30T11:45:14.928Z',
  };
}

function mediaResult(promotionId: string) {
  return {
    promotionId,
    imageUrl: `https://media.padlhub.su/${promotionId}.webp`,
    mobileImageUrl: `https://media.padlhub.su/${promotionId}-mobile.webp`,
    outcome: 'stored' as const,
    persistence: {
      promotionId,
      sourceUrl: `https://padlhub.su/${promotionId}.webp`,
      desktopSha256: 'a'.repeat(64),
      mobileSha256: 'b'.repeat(64),
      desktopObjectKey: `promotion/${promotionId}.webp`,
      mobileObjectKey: `promotion/${promotionId}-mobile.webp`,
      desktopDeliveryUrl: `https://media.padlhub.su/${promotionId}.webp`,
      mobileDeliveryUrl: `https://media.padlhub.su/${promotionId}-mobile.webp`,
      deliveryExpiresAt: '2026-07-30T13:45:14.928Z',
      syncedAt: '2026-07-30T11:45:14.928Z',
    },
  };
}

const block2Snapshot: LegacyPromotionSourceSnapshot = {
  rotationEnabled: false,
  items: [],
  updatedAt: '2026-07-30T11:45:14.928Z',
};

describe('promotion Home source slots', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    repositoryMocks.completePromotionMediaObjectGc.mockResolvedValue(undefined);
    repositoryMocks.listDuePromotionHomeUsers.mockResolvedValue([]);
    repositoryMocks.listDuePromotionMediaObjects.mockResolvedValue([]);
    repositoryMocks.loadPromotionMediaSyncRecords.mockResolvedValue(new Map());
    repositoryMocks.persistPromotionHomeSource.mockResolvedValue({
      outcome: 'published',
      sourceRevision: 'promotion-revision-1',
    });
    repositoryMocks.persistPromotionMedia.mockResolvedValue(undefined);
    repositoryMocks.recordPromotionMediaObjectGcFailure.mockResolvedValue(undefined);
    repositoryMocks.resolvePromotionIds.mockResolvedValue(new Map());
    mediaMocks.synchronizePromotionMedia.mockResolvedValue([]);
  });

  it('reads CUP Block 2 once when it supplies both compatible Home slots', async () => {
    const getSnapshot = vi.fn().mockResolvedValue(block2Snapshot);
    const block2Source = { getSnapshot };

    await expect(
      readPromotionSourceSnapshots(
        { hero: block2Source, standard: block2Source },
        'promotion-block-2-test',
      ),
    ).resolves.toEqual({
      hero: block2Snapshot,
      standard: block2Snapshot,
      mirrorsStandard: true,
    });
    expect(getSnapshot).toHaveBeenCalledOnce();
    expect(getSnapshot).toHaveBeenCalledWith('promotion-block-2-test');
  });

  it('publishes all promotion slots and completes best-effort media garbage collection', async () => {
    const hero = snapshot('hero', { rotationEnabled: true });
    const standard = snapshot('standard');
    const strip = snapshot('strip', { repeatEveryCards: 3 });
    const card = snapshot('card', { cardImages: true });
    const promotionIds = new Map([
      ['top:hero', '11111111-1111-4111-8111-111111111111'],
      ['standard', '22222222-2222-4222-8222-222222222222'],
      ['strip:strip', '33333333-3333-4333-8333-333333333333'],
      ['card:card', '44444444-4444-4444-8444-444444444444'],
      ['card-square:card', '55555555-5555-4555-8555-555555555555'],
    ]);
    repositoryMocks.listDuePromotionHomeUsers.mockResolvedValue([userId]);
    repositoryMocks.resolvePromotionIds.mockResolvedValue(promotionIds);
    mediaMocks.synchronizePromotionMedia.mockResolvedValue(
      [...promotionIds.values()].map(mediaResult),
    );
    repositoryMocks.listDuePromotionMediaObjects.mockResolvedValue([
      'promotion/stale-ok.webp',
      'promotion/stale-failed.webp',
    ]);
    repositoryMocks.recordPromotionMediaObjectGcFailure.mockRejectedValue(
      new Error('gc ledger unavailable'),
    );

    const pool = {
      query: vi.fn().mockResolvedValue({ rows: [{ id: tenantId }], rowCount: 1 }),
    } as never;
    const logger = { info: vi.fn(), warn: vi.fn() } as unknown as Logger;
    const store: ProfilePhotoObjectStore = {
      put: vi.fn().mockResolvedValue(undefined),
      createReadUrl: vi.fn(),
      exists: vi.fn().mockResolvedValue(true),
      delete: vi.fn((key: string) =>
        key.endsWith('stale-failed.webp')
          ? Promise.reject(new Error('object storage unavailable'))
          : Promise.resolve(),
      ),
    };
    const source = {
      hero: { getSnapshot: vi.fn().mockResolvedValue(hero) },
      standard: { getSnapshot: vi.fn().mockResolvedValue(standard) },
      recommendationStrip: { getSnapshot: vi.fn().mockResolvedValue(strip) },
      recommendationCard: { getSnapshot: vi.fn().mockResolvedValue(card) },
    };

    await expect(
      runPromotionHomeSyncCycle({
        pool,
        config: config(),
        logger,
        source,
        store,
        now: new Date('2026-07-30T12:00:00.000Z'),
      }),
    ).resolves.toEqual({ attempted: 1, synced: 1, failed: 0 });
    const persisted: unknown = repositoryMocks.persistPromotionHomeSource.mock.calls[0]?.[0];
    expect(persisted).toMatchObject({
      tenantId,
      userId,
      promotions: {
        hero: { rotationEnabled: false },
        standard: {},
        recommendationStrip: { repeatEveryCards: 3 },
        recommendationCard: { repeatEveryCards: 6 },
      },
    });
    expect(repositoryMocks.completePromotionMediaObjectGc).toHaveBeenCalledOnce();
    expect(repositoryMocks.recordPromotionMediaObjectGcFailure).toHaveBeenCalledOnce();
    expect(logger.info).toHaveBeenCalledOnce();
  });

  it('defers every due user when a provider read fails with a stable code', async () => {
    repositoryMocks.listDuePromotionHomeUsers.mockResolvedValue([userId, userId]);
    repositoryMocks.listDuePromotionMediaObjects.mockRejectedValue(new Error('gc read failed'));
    const pool = {
      query: vi.fn().mockResolvedValue({ rows: [{ id: tenantId }], rowCount: 1 }),
    } as never;
    const logger = { info: vi.fn(), warn: vi.fn() } as unknown as Logger;
    const unavailable = Object.assign(new Error('provider unavailable'), {
      code: 'PROMOTION_LEGACY_TIMEOUT',
    });
    const source = {
      hero: { getSnapshot: vi.fn().mockRejectedValue(unavailable) },
      standard: { getSnapshot: vi.fn().mockResolvedValue(block2Snapshot) },
      recommendationStrip: { getSnapshot: vi.fn() },
      recommendationCard: { getSnapshot: vi.fn() },
    };
    const store: ProfilePhotoObjectStore = {
      put: vi.fn(),
      createReadUrl: vi.fn(),
      exists: vi.fn().mockResolvedValue(true),
      delete: vi.fn(),
    };

    await expect(
      runPromotionHomeSyncCycle({
        pool,
        config: config(),
        logger,
        source,
        store,
      }),
    ).resolves.toEqual({ attempted: 2, synced: 0, failed: 2 });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'PROMOTION_LEGACY_TIMEOUT', userCount: 2 }),
      'promotion Home source synchronization deferred',
    );
  });
});
