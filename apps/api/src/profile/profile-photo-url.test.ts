import { describe, expect, it } from 'vitest';

import { stabilizeGameCardProfilePhotos, stabilizeHomeProfilePhotos } from './profile-photo-url.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const userId = '22222222-2222-4222-8222-222222222222';
const deliveryId = '33333333-3333-4333-8333-333333333333';
const deliveryIds = new Map([[userId, deliveryId]]);
const stableUrl = `/public/api/v1/media/profile-photos/${tenantId}/${deliveryId}`;
const expiredUrl =
  `http://127.0.0.1:9000/phub-local/profile-photos/${tenantId}/${userId}/` +
  `${'a'.repeat(64)}.webp?X-Amz-Expires=3600`;

describe('profile photo URL normalization', () => {
  it('replaces an expired S3 URL embedded in a game projection', () => {
    expect(
      stabilizeGameCardProfilePhotos(
        { participants: [{ userId, displayName: 'Игрок', avatarUrl: expiredUrl }] },
        tenantId,
        deliveryIds,
      ),
    ).toEqual({ participants: [{ userId, displayName: 'Игрок', avatarUrl: stableUrl }] });
  });

  it('replaces profile and upcoming participant URLs in a stored Home snapshot', () => {
    expect(
      stabilizeHomeProfilePhotos(
        {
          profile: { userId, avatarUrl: expiredUrl },
          upcoming: [{ participants: [{ profileId: userId, avatarUrl: expiredUrl }] }],
        },
        tenantId,
        deliveryIds,
      ),
    ).toEqual({
      profile: { userId, avatarUrl: stableUrl },
      upcoming: [{ participants: [{ profileId: userId, avatarUrl: stableUrl }] }],
    });
  });

  it('does not rewrite an URL when no local object mapping exists', () => {
    const providerUrl = 'https://provider.test/avatar.webp';
    expect(
      stabilizeGameCardProfilePhotos(
        { participants: [{ userId, avatarUrl: providerUrl }] },
        tenantId,
        new Map(),
      ),
    ).toEqual({ participants: [{ userId, avatarUrl: providerUrl }] });
  });
});
