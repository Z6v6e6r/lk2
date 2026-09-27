import { expect, it } from 'vitest';
import { resolveCabinetMedia } from './cabinet-media.js';

it('resolves nested API media without turning app navigation into an external link', () => {
  const dto = {
    route: '/games/test',
    imageUrl: '/public/api/v1/media/promotion',
    participants: [{ avatarUrl: '/public/api/v1/media/avatar' }],
    logoUrl: 'https://images.example.test/logo.png',
  };
  expect(resolveCabinetMedia(dto, 'https://lk2.padlhub.su')).toEqual({
    route: '/games/test',
    imageUrl: 'https://lk2.padlhub.su/public/api/v1/media/promotion',
    participants: [{ avatarUrl: 'https://lk2.padlhub.su/public/api/v1/media/avatar' }],
    logoUrl: 'https://images.example.test/logo.png',
  });
  expect(dto.participants[0]?.avatarUrl).toBe('/public/api/v1/media/avatar');
});
