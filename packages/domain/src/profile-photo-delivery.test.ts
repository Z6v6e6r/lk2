import { describe, expect, it } from 'vitest';

import { PROFILE_PHOTO_DELIVERY_PATH_PATTERN, profilePhotoDeliveryUrl } from './index.js';

describe('profile photo delivery URL', () => {
  it('builds a stable PadlHub API path from public UUIDs', () => {
    const url = profilePhotoDeliveryUrl(
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
    );

    expect(url).toBe(
      '/public/api/v1/media/profile-photos/11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222',
    );
    expect(PROFILE_PHOTO_DELIVERY_PATH_PATTERN.test(url)).toBe(true);
  });

  it('rejects identifiers outside the PadlHub UUID contract', () => {
    expect(() => profilePhotoDeliveryUrl('local-padel', 'not-a-user')).toThrow(
      'PROFILE_PHOTO_DELIVERY_ID_INVALID',
    );
  });
});
