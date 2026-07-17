import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';

import type { ProfilePhotoObjectStore } from './profile-photo-sync.js';
import { synchronizePromotionMedia } from './promotion-media-sync.js';

describe('promotion media synchronization', () => {
  it('stores metadata-free desktop and exact mobile WebP derivatives', async () => {
    const source = await sharp({
      create: { width: 1_600, height: 900, channels: 3, background: '#b9a1ff' },
    })
      .jpeg()
      .toBuffer();
    const objects = new Map<string, Buffer>();
    const store: ProfilePhotoObjectStore = {
      put: vi.fn<ProfilePhotoObjectStore['put']>((input) => {
        objects.set(input.key, input.body);
        return Promise.resolve();
      }),
      createReadUrl: vi.fn<ProfilePhotoObjectStore['createReadUrl']>((key) =>
        Promise.resolve(`https://media.padlhub.test/${key}`),
      ),
      delete: vi.fn<ProfilePhotoObjectStore['delete']>(() => Promise.resolve()),
    };

    const result = await synchronizePromotionMedia({
      store,
      tenantId: '86afbe01-0318-4dd2-bc25-303b7bf0d430',
      candidates: [
        {
          promotionId: '11111111-1111-4111-8111-111111111111',
          sourceUrl: 'https://padlhub.su/api/advertising/assets/asset-1',
        },
      ],
      current: new Map(),
      fetchedAt: '2026-07-17T12:00:00.000Z',
      allowedHosts: ['padlhub.su'],
      maxBytes: 10 * 1_024 * 1_024,
      desktopMaxWidth: 1_600,
      desktopMaxHeight: 900,
      mobileWidth: 750,
      mobileHeight: 480,
      webpQuality: 80,
      previousObjectRetentionSeconds: 4_000,
      readUrlTtlSeconds: 3_600,
      timeoutMs: 1_000,
      fetchImplementation: vi
        .fn()
        .mockResolvedValue(new Response(source, { headers: { 'content-type': 'image/jpeg' } })),
    });

    expect(result).toHaveLength(1);
    const stored = result[0];
    expect(stored?.imageUrl).toContain('/desktop/');
    expect(stored?.mobileImageUrl).toContain('/mobile/');
    const desktop = objects.get(stored?.persistence.desktopObjectKey ?? '');
    const mobile = objects.get(stored?.persistence.mobileObjectKey ?? '');
    expect(desktop).toBeDefined();
    expect(mobile).toBeDefined();
    const desktopMetadata = await sharp(desktop).metadata();
    expect(desktopMetadata).toMatchObject({
      format: 'webp',
      width: 1_600,
      height: 900,
    });
    expect(desktopMetadata.exif).toBeUndefined();
    const mobileMetadata = await sharp(mobile).metadata();
    expect(mobileMetadata).toMatchObject({
      format: 'webp',
      width: 750,
      height: 480,
    });
    expect(mobileMetadata.exif).toBeUndefined();
  });
});
