import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';

import { EventAvatarMediaProxy, PersistentTrainerAvatarMedia } from './event-avatar-media.js';

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

  it('does not open the shared circuit for trainer-specific 4xx responses', async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('forbidden', { status: 403 }));
    const proxy = new EventAvatarMediaProxy({
      allowedHosts: ['.selcdn.ru'],
      timeoutMs: 1_000,
      maxBytes: 1_024 * 1_024,
      maxDimension: 512,
      webpQuality: 82,
      fetchImplementation,
      circuitFailureThreshold: 1,
    });
    const input = {
      cacheKey: 'coach-game:forbidden',
      sourceUrl: 'https://562807.selcdn.ru/photo',
    };

    await expect(proxy.read(input)).rejects.toThrow('EVENT_AVATAR_SOURCE_HTTP_403');
    await expect(proxy.read(input)).rejects.toThrow('EVENT_AVATAR_SOURCE_HTTP_403');
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
  });

  it('serves a stored trainer avatar before contacting the provider', async () => {
    const body = Buffer.from('stored-webp');
    const remoteRead = vi.fn();
    const media = new PersistentTrainerAvatarMedia({
      remote: { read: remoteRead },
      repository: {
        getByProviderIdentity: vi.fn().mockResolvedValue({
          trainerId: '20000000-0000-4000-8000-000000000001',
          displayName: 'Мария Орлова',
          sourceUrl: 'https://562807.selcdn.ru/photo',
          objectKey: 'trainer-avatars/local/stored.webp',
        }),
        save: vi.fn(),
      },
      store: {
        read: vi.fn().mockResolvedValue(body),
        put: vi.fn(),
      },
      maxBytes: 1_024,
    });

    await expect(
      media.read({
        cacheKey: 'training:one',
        sourceUrl: 'https://562807.selcdn.ru/photo',
        tenantId: '10000000-0000-4000-8000-000000000001',
        trainer: {
          provider: 'VIVA',
          providerTrainerId: 'viva-trainer-1',
          displayName: 'Мария Орлова',
        },
      }),
    ).resolves.toMatchObject({ body });
    expect(remoteRead).not.toHaveBeenCalled();
  });

  it('stores a successful provider image for subsequent local-first reads', async () => {
    const body = Buffer.from('normalized-webp');
    const save = vi
      .fn()
      .mockResolvedValueOnce({
        trainerId: '20000000-0000-4000-8000-000000000001',
        displayName: 'Мария Орлова',
      })
      .mockResolvedValueOnce({
        trainerId: '20000000-0000-4000-8000-000000000001',
        displayName: 'Мария Орлова',
      });
    const put = vi.fn().mockResolvedValue(undefined);
    const media = new PersistentTrainerAvatarMedia({
      remote: { read: vi.fn().mockResolvedValue({ body, etag: '"remote"' }) },
      repository: { getByProviderIdentity: vi.fn().mockResolvedValue(undefined), save },
      store: { read: vi.fn(), put },
      maxBytes: 1_024,
    });

    await media.read({
      cacheKey: 'training:one',
      sourceUrl: 'https://562807.selcdn.ru/photo',
      tenantId: '10000000-0000-4000-8000-000000000001',
      trainer: {
        provider: 'VIVA',
        providerTrainerId: 'viva-trainer-1',
        displayName: 'Мария Орлова',
      },
    });

    expect(put).toHaveBeenCalledOnce();
    const saved = (save.mock.calls as unknown as readonly [Record<string, unknown>][]).at(-1)?.[0];
    expect(saved?.objectKey).toEqual(expect.stringMatching(/^trainer-avatars\/.+\.webp$/));
    expect(saved?.contentSha256).toEqual(expect.stringMatching(/^[0-9a-f]{64}$/));
  });
});
