import { describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';

import {
  STATION_SUPPORT_MEDIA_DATA_URL_PREFIX_BYTES,
  STATION_SUPPORT_MEDIA_INLINE_URL_BUDGET_BYTES,
  STATION_SUPPORT_MEDIA_MAX_BYTES,
  STATION_SUPPORT_MEDIA_SOURCE_MAX_BYTES,
  convertStationSupportWebp,
  readStationSupportProviderImage,
  stationSupportAttachmentId,
  stationSupportAttachmentSha256,
  stationSupportMediaObjectKey,
} from './station-support-media.js';

const tenantId = '86afbe01-0318-4dd2-bc25-303b7bf0d430';
const userId = '49d4e88c-9a6b-4f2d-8d3c-1f0f5c3b9a11';

async function pngBytes(size = 24): Promise<Buffer> {
  return sharp({ create: { width: size, height: size, channels: 3, background: '#8766eb' } })
    .png()
    .toBuffer();
}

describe('station support media keys', () => {
  it('keeps the object under the tenant and the owning user', () => {
    const sha256 = 'a'.repeat(64);
    expect(stationSupportMediaObjectKey(tenantId, userId, sha256)).toBe(
      `station-support/${tenantId}/${userId}/${sha256}.webp`,
    );
  });

  it('refuses an owner or a digest that is not canonical', () => {
    expect(() => stationSupportMediaObjectKey('not-a-uuid', userId, 'a'.repeat(64))).toThrow(
      'STATION_SUPPORT_MEDIA_OWNER_INVALID',
    );
    expect(() => stationSupportMediaObjectKey(tenantId, userId, '../../etc/passwd')).toThrow(
      'STATION_SUPPORT_MEDIA_SHA256_INVALID',
    );
  });

  it('round-trips the public attachment id and refuses anything that is not one', () => {
    const sha256 = 'b'.repeat(64);
    const id = stationSupportAttachmentId(sha256);
    expect(id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(stationSupportAttachmentSha256(id)).toBe(sha256);

    expect(stationSupportAttachmentSha256('../secret')).toBeNull();
    expect(stationSupportAttachmentSha256('a'.repeat(42))).toBeNull();
    // A padded value is refused even though Node can decode it, so one digest has one id.
    expect(stationSupportAttachmentSha256(`${id}=`)).toBeNull();
  });

  it('bounds one inline data URL by the payload the CUP workspace itself sends', () => {
    expect(
      STATION_SUPPORT_MEDIA_DATA_URL_PREFIX_BYTES +
        4 * Math.ceil(STATION_SUPPORT_MEDIA_MAX_BYTES / 3),
    ).toBeLessThanOrEqual(STATION_SUPPORT_MEDIA_INLINE_URL_BUDGET_BYTES);
    // One more byte would break the budget, so the cap is the exact boundary and not a guess.
    expect(
      STATION_SUPPORT_MEDIA_DATA_URL_PREFIX_BYTES +
        4 * Math.ceil((STATION_SUPPORT_MEDIA_MAX_BYTES + 1) / 3),
    ).toBeGreaterThan(STATION_SUPPORT_MEDIA_INLINE_URL_BUDGET_BYTES);
  });
});

describe('station support source images', () => {
  it('decodes an inline provider picture and refuses an oversized one before decoding', async () => {
    const source = await pngBytes(8);
    await expect(
      readStationSupportProviderImage(`data:image/png;base64,${source.toString('base64')}`, {
        allowedHosts: [],
        timeoutMs: 1_000,
        maxBytes: STATION_SUPPORT_MEDIA_SOURCE_MAX_BYTES,
      }),
    ).resolves.toEqual(source);

    const oversized = 'A'.repeat(Math.ceil(STATION_SUPPORT_MEDIA_SOURCE_MAX_BYTES / 3) * 4 + 4);
    await expect(
      readStationSupportProviderImage(`data:image/png;base64,${oversized}`, {
        allowedHosts: [],
        timeoutMs: 1_000,
        maxBytes: STATION_SUPPORT_MEDIA_SOURCE_MAX_BYTES,
      }),
    ).rejects.toThrow('STATION_SUPPORT_MEDIA_SOURCE_TOO_LARGE');
  });

  it('downloads only from a host the deployment declared', async () => {
    const fetchImplementation = vi.fn<typeof fetch>();
    await expect(
      readStationSupportProviderImage('https://evil.example/photo.png', {
        allowedHosts: ['support.padlhub.test'],
        timeoutMs: 1_000,
        maxBytes: STATION_SUPPORT_MEDIA_SOURCE_MAX_BYTES,
        fetchImplementation,
      }),
    ).rejects.toThrow('STATION_SUPPORT_MEDIA_SOURCE_NOT_ALLOWED');
    expect(fetchImplementation).not.toHaveBeenCalled();

    await expect(
      readStationSupportProviderImage('https://evil.example/photo.png', {
        allowedHosts: [],
        timeoutMs: 1_000,
        maxBytes: STATION_SUPPORT_MEDIA_SOURCE_MAX_BYTES,
        fetchImplementation,
      }),
    ).rejects.toThrow('STATION_SUPPORT_MEDIA_SOURCE_NOT_ALLOWED');
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it('stops reading a chunked response whose running total passes the cap', async () => {
    const chunk = new Uint8Array(1_024);
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent += chunk.byteLength;
        if (sent > 8_192) {
          controller.close();
          return;
        }
        controller.enqueue(chunk);
      },
    });
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(body, { status: 200, headers: { 'content-type': 'image/png' } }),
      );

    await expect(
      readStationSupportProviderImage('https://support.padlhub.test/big.png', {
        allowedHosts: ['support.padlhub.test'],
        timeoutMs: 1_000,
        maxBytes: 4_096,
        fetchImplementation,
      }),
    ).rejects.toThrow('STATION_SUPPORT_MEDIA_SOURCE_TOO_LARGE');
  });

  it('refuses a provider response that is not a picture', async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } }),
      );
    await expect(
      readStationSupportProviderImage('https://support.padlhub.test/page', {
        allowedHosts: ['support.padlhub.test'],
        timeoutMs: 1_000,
        maxBytes: STATION_SUPPORT_MEDIA_SOURCE_MAX_BYTES,
        fetchImplementation,
      }),
    ).rejects.toThrow('STATION_SUPPORT_MEDIA_SOURCE_CONTENT_TYPE_INVALID');
  });
});

describe('station support webp conversion', () => {
  it('re-encodes a picture into a bounded WebP object', async () => {
    const converted = await convertStationSupportWebp(await pngBytes(64));
    expect(converted.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(converted.body.byteLength).toBeLessThanOrEqual(STATION_SUPPORT_MEDIA_MAX_BYTES);
    expect(converted.body.subarray(8, 12).toString('ascii')).toBe('WEBP');
    expect(await sharp(converted.body).metadata()).toMatchObject({ format: 'webp', width: 64 });
  });

  it('refuses bytes that are not a decodable picture', async () => {
    await expect(convertStationSupportWebp(Buffer.from('not an image'))).rejects.toThrow();
  });
});
