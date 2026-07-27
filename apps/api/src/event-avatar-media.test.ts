import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';

import { EventAvatarMediaProxy } from './event-avatar-media.js';

async function sourcePng(): Promise<Buffer> {
  return sharp({
    create: {
      width: 24,
      height: 24,
      channels: 4,
      background: { r: 120, g: 80, b: 220, alpha: 1 },
    },
  })
    .png()
    .toBuffer();
}

describe('event avatar media proxy', () => {
  it('validates the source, converts it to WebP and reuses a bounded cache', async () => {
    const png = await sourcePng();
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength) as ArrayBuffer,
        {
          headers: { 'Content-Type': 'image/png', 'Content-Length': String(png.byteLength) },
        },
      ),
    );
    const metrics: string[] = [];
    const proxy = new EventAvatarMediaProxy({
      allowedHosts: ['.selcdn.ru', '.selstorage.ru'],
      timeoutMs: 1_000,
      maxBytes: 1_024 * 1_024,
      maxDimension: 512,
      webpQuality: 82,
      fetchImplementation,
      onMetric: (metric) => metrics.push(metric.outcome),
    });

    const first = await proxy.read({
      cacheKey: 'coach-game:one',
      sourceUrl: 'https://562807.selcdn.ru/photos/trainer-one',
    });
    const second = await proxy.read({
      cacheKey: 'coach-game:one',
      sourceUrl: 'https://562807.selcdn.ru/photos/trainer-one',
    });

    expect(fetchImplementation).toHaveBeenCalledOnce();
    expect(second).toEqual(first);
    expect(await sharp(first.body).metadata()).toMatchObject({ format: 'webp' });
    expect(first.etag).toMatch(/^"[A-Za-z0-9_-]+"$/);
    expect(metrics).toEqual(['success', 'cache']);
  });

  it('rejects unapproved or credential-bearing sources without contacting them', async () => {
    const fetchImplementation = vi.fn<typeof fetch>();
    const proxy = new EventAvatarMediaProxy({
      allowedHosts: ['.selcdn.ru', '.selstorage.ru'],
      timeoutMs: 1_000,
      maxBytes: 1_024 * 1_024,
      maxDimension: 512,
      webpQuality: 82,
      fetchImplementation,
    });

    await expect(
      proxy.read({
        cacheKey: 'tournament:one',
        sourceUrl: 'https://user:password@562807.selcdn.ru/photo',
      }),
    ).rejects.toThrow('EVENT_AVATAR_SOURCE_NOT_ALLOWED');
    await expect(
      proxy.read({
        cacheKey: 'tournament:two',
        sourceUrl: 'https://attacker.example/photo',
      }),
    ).rejects.toThrow('EVENT_AVATAR_SOURCE_NOT_ALLOWED');
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it('opens its circuit after three bounded failed reads', async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error('source unavailable'));
    const proxy = new EventAvatarMediaProxy({
      allowedHosts: ['.selcdn.ru'],
      timeoutMs: 1_000,
      maxBytes: 1_024 * 1_024,
      maxDimension: 512,
      webpQuality: 82,
      fetchImplementation,
      circuitFailureThreshold: 3,
      circuitResetMs: 30_000,
    });
    const input = {
      cacheKey: 'coach-game:one',
      sourceUrl: 'https://562807.selcdn.ru/photo',
    };

    await expect(proxy.read(input)).rejects.toThrow('source unavailable');
    await expect(proxy.read(input)).rejects.toThrow('source unavailable');
    await expect(proxy.read(input)).rejects.toThrow('source unavailable');
    await expect(proxy.read(input)).rejects.toThrow('EVENT_AVATAR_MEDIA_CIRCUIT_OPEN');
    expect(fetchImplementation).toHaveBeenCalledTimes(6);
  });
});
