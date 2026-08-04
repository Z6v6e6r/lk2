import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

import {
  MockCommunityMediaMalwareScanner,
  prepareCommunityMedia,
} from './community-media-processing.js';

describe('prepareCommunityMedia', () => {
  it('normalizes a safe image into bounded WebP variants', async () => {
    const source = await sharp({
      create: { width: 2_500, height: 1_250, channels: 3, background: '#00a0c6' },
    })
      .png()
      .toBuffer();
    const result = await prepareCommunityMedia({
      body: source,
      declaredContentType: 'image/png',
      scanner: new MockCommunityMediaMalwareScanner(),
    });
    await expect(sharp(result.thumbnail.body).metadata()).resolves.toMatchObject({
      format: 'webp',
      width: 640,
      height: 320,
    });
    await expect(sharp(result.feed.body).metadata()).resolves.toMatchObject({
      format: 'webp',
      width: 2_048,
      height: 1_024,
    });
    expect(result.sourceSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects content-type spoofing before producing variants', async () => {
    const source = await sharp({
      create: { width: 16, height: 16, channels: 3, background: '#fff' },
    })
      .png()
      .toBuffer();
    await expect(
      prepareCommunityMedia({
        body: source,
        declaredContentType: 'image/jpeg',
        scanner: new MockCommunityMediaMalwareScanner(),
      }),
    ).rejects.toThrow('COMMUNITY_MEDIA_CONTENT_TYPE_MISMATCH');
  });

  it('fails closed when malware scan rejects the payload', async () => {
    await expect(
      prepareCommunityMedia({
        body: Buffer.from('unsafe'),
        declaredContentType: 'image/png',
        scanner: { scan: () => Promise.resolve({ outcome: 'infected', signature: 'EICAR' }) },
      }),
    ).rejects.toThrow('COMMUNITY_MEDIA_MALWARE_DETECTED');
  });
});
