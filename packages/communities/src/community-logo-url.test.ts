import { describe, expect, it } from 'vitest';

import { communityLogoUrlSchema } from './community-logo-url.js';

const stablePath =
  '/public/api/v1/media/community-logos/86afbe01-0318-4dd2-bc25-303b7bf0d430/11111111-1111-4111-8111-111111111111';

describe('community logo URL schema', () => {
  it('accepts HTTP delivery URLs and the exact stable PadlHub path', () => {
    expect(communityLogoUrlSchema.parse('https://media.padlhub.test/logo.webp')).toBe(
      'https://media.padlhub.test/logo.webp',
    );
    expect(communityLogoUrlSchema.parse(stablePath)).toBe(stablePath);
  });

  it('rejects executable, data and unrelated relative URLs', () => {
    expect(communityLogoUrlSchema.safeParse('javascript:alert(1)').success).toBe(false);
    expect(communityLogoUrlSchema.safeParse('data:image/svg+xml,test').success).toBe(false);
    expect(communityLogoUrlSchema.safeParse('/media/community-logo.webp').success).toBe(false);
  });
});
