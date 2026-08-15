import { createHash } from 'node:crypto';

import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';

import type { CommunityDirectoryItem } from '@phub/communities';

import {
  CommunityLogoSourceResilience,
  type CommunityLogoSourceMetric,
  synchronizeLegacyCommunityLogos,
} from './community-logo-sync.js';
import type { ProfilePhotoObjectStore } from './profile-photo-sync.js';

const tenantId = '86afbe01-0318-4dd2-bc25-303b7bf0d430';
const communityId = '11111111-1111-4111-8111-111111111111';
const fetchedAt = '2026-07-17T12:00:00.000Z';

function item(legacyLogoSourceUrl?: string, id: string = communityId): CommunityDirectoryItem {
  return {
    id,
    title: 'Реальное сообщество',
    logoUrl: null,
    isVerified: true,
    unreadChatCount: 0,
    pinned: false,
    sortAt: '2026-07-17T10:00:00.000Z',
    ...(legacyLogoSourceUrl ? { legacyLogoSourceUrl } : {}),
  };
}

function poolWithLogoRows(rows: readonly Record<string, unknown>[]) {
  const query = vi.fn((text: string) => {
    if (
      text === 'begin' ||
      text === 'commit' ||
      text === 'rollback' ||
      text.includes("set_config('app.tenant_id'")
    ) {
      return Promise.resolve({ rows: [], rowCount: 0 });
    }
    if (text.includes('from integration.community_logo_sync')) {
      return Promise.resolve({ rows, rowCount: rows.length });
    }
    throw new Error(`Unexpected query: ${text}`);
  });
  return {
    pool: {
      connect: vi.fn().mockResolvedValue({ query, release: vi.fn() }),
    } as never,
    query,
  };
}

function objectStore() {
  const put = vi.fn<ProfilePhotoObjectStore['put']>().mockResolvedValue(undefined);
  const createReadUrl = vi
    .fn<ProfilePhotoObjectStore['createReadUrl']>()
    .mockImplementation((key) => Promise.resolve(`https://media.padlhub.test/${key}?sig=test`));
  const exists = vi.fn<ProfilePhotoObjectStore['exists']>().mockResolvedValue(true);
  const store: ProfilePhotoObjectStore = {
    put,
    createReadUrl,
    exists,
    delete: vi.fn().mockResolvedValue(undefined),
  };
  return { store, put, createReadUrl, exists };
}

const defaults = {
  tenantId,
  fetchedAt,
  allowedHosts: ['legacy.padlhub.test'],
  maxBytes: 5 * 1_024 * 1_024,
  maxDimension: 512,
  webpQuality: 82,
  previousObjectRetentionSeconds: 4_000,
  timeoutMs: 1_000,
} as const;

describe('legacy community logo synchronization', () => {
  it('converts a bounded legacy image to a PadlHub-owned WebP object', async () => {
    const png = await sharp({
      create: { width: 64, height: 32, channels: 4, background: '#7654d7' },
    })
      .png()
      .toBuffer();
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(png, {
        status: 200,
        headers: { 'content-type': 'image/png', etag: '"logo-v1"' },
      }),
    );
    const { pool } = poolWithLogoRows([]);
    const { store, put } = objectStore();

    const [result] = await synchronizeLegacyCommunityLogos({
      ...defaults,
      pool,
      store,
      items: [item('https://legacy.padlhub.test/lk/media/community-logo/source')],
      fetchImplementation,
    });

    expect(result).toMatchObject({
      communityId,
      outcome: 'stored',
      persistence: {
        sourceUrl: 'https://legacy.padlhub.test/lk/media/community-logo/source',
        sourceEtag: '"logo-v1"',
      },
    });
    expect(result?.logoUrl).toBe(`/public/api/v1/media/community-logos/${tenantId}/${communityId}`);
    expect(result?.logoUrl).not.toContain('legacy.padlhub.test');
    expect(put).toHaveBeenCalledOnce();
    const stored = put.mock.calls[0]?.[0];
    expect(stored?.key).toMatch(
      new RegExp(`^community-logos/${tenantId}/${communityId}/[0-9a-f]{64}\\.webp$`),
    );
    await expect(sharp(stored?.body).metadata()).resolves.toMatchObject({ format: 'webp' });
  });

  it('cancels a redirect body before following an allowlisted location', async () => {
    const png = await sharp({
      create: { width: 8, height: 8, channels: 4, background: '#7654d7' },
    })
      .png()
      .toBuffer();
    const cancel = vi.fn();
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(new ReadableStream<Uint8Array>({ cancel }), {
          status: 302,
          headers: { location: 'https://legacy.padlhub.test/logo/final' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(png, { status: 200, headers: { 'content-type': 'image/png' } }),
      );
    const { pool } = poolWithLogoRows([]);
    const { store } = objectStore();

    const [result] = await synchronizeLegacyCommunityLogos({
      ...defaults,
      pool,
      store,
      items: [item('https://legacy.padlhub.test/logo/redirect')],
      fetchImplementation,
    });

    expect(result?.outcome).toBe('stored');
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('reuses the local object without downloading the same legacy URL again', async () => {
    const objectKey = `community-logos/${tenantId}/${communityId}/${'a'.repeat(64)}.webp`;
    const { pool } = poolWithLogoRows([
      {
        community_id: communityId,
        source_url: 'https://legacy.padlhub.test/logo/current',
        source_etag: null,
        source_last_modified: null,
        content_sha256: 'a'.repeat(64),
        object_key: objectKey,
        synced_at: '2026-07-17T11:30:00.000Z',
      },
    ]);
    const { store, put, createReadUrl } = objectStore();
    const fetchImplementation = vi.fn<typeof fetch>();

    const [result] = await synchronizeLegacyCommunityLogos({
      ...defaults,
      pool,
      store,
      items: [item('https://legacy.padlhub.test/logo/current')],
      fetchImplementation,
    });

    expect(result).toMatchObject({
      outcome: 'unchanged',
      logoUrl: `/public/api/v1/media/community-logos/${tenantId}/${communityId}`,
    });
    expect(fetchImplementation).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
    expect(createReadUrl).not.toHaveBeenCalled();
  });

  it('conditionally revalidates a stale local object and advances its observation time on 304', async () => {
    const objectKey = `community-logos/${tenantId}/${communityId}/${'a'.repeat(64)}.webp`;
    const { pool } = poolWithLogoRows([
      {
        community_id: communityId,
        source_url: 'https://legacy.padlhub.test/logo/current',
        source_etag: '"logo-v1"',
        source_last_modified: 'Thu, 16 Jul 2026 12:00:00 GMT',
        content_sha256: 'a'.repeat(64),
        object_key: objectKey,
        synced_at: '2026-07-17T10:00:00.000Z',
      },
    ]);
    const { store, put } = objectStore();
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 304, headers: { etag: '"logo-v1"' } }));

    const [result] = await synchronizeLegacyCommunityLogos({
      ...defaults,
      pool,
      store,
      items: [item('https://legacy.padlhub.test/logo/current')],
      fetchImplementation,
    });

    const requestHeaders = new Headers(fetchImplementation.mock.calls[0]?.[1]?.headers);
    expect(requestHeaders.get('If-None-Match')).toBe('"logo-v1"');
    expect(requestHeaders.get('If-Modified-Since')).toBe('Thu, 16 Jul 2026 12:00:00 GMT');
    expect(result).toMatchObject({
      outcome: 'unchanged',
      fetchAttempted: true,
      persistence: { objectKey, syncedAt: fetchedAt },
    });
    expect(put).not.toHaveBeenCalled();
  });

  it('refetches without validators and restores a missing immutable object', async () => {
    const png = await sharp({
      create: { width: 32, height: 32, channels: 4, background: '#7654d7' },
    })
      .png()
      .toBuffer();
    const webp = await sharp(png, { failOn: 'error', limitInputPixels: 20_000_000 })
      .rotate()
      .resize({ width: 512, height: 512, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 82, effort: 4 })
      .toBuffer();
    const contentSha256 = createHash('sha256').update(webp).digest('hex');
    const objectKey = `community-logos/${tenantId}/${communityId}/${contentSha256}.webp`;
    const { pool } = poolWithLogoRows([
      {
        community_id: communityId,
        source_url: 'https://legacy.padlhub.test/logo/current',
        source_etag: '"logo-v1"',
        source_last_modified: 'Thu, 16 Jul 2026 12:00:00 GMT',
        content_sha256: contentSha256,
        object_key: objectKey,
        synced_at: '2026-07-17T10:00:00.000Z',
      },
    ]);
    const { store, put, exists } = objectStore();
    exists.mockResolvedValue(false);
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(png, {
        status: 200,
        headers: { 'content-type': 'image/png', etag: '"logo-v1"' },
      }),
    );

    const [result] = await synchronizeLegacyCommunityLogos({
      ...defaults,
      pool,
      store,
      items: [item('https://legacy.padlhub.test/logo/current')],
      fetchImplementation,
    });

    const requestHeaders = new Headers(fetchImplementation.mock.calls[0]?.[1]?.headers);
    expect(requestHeaders.get('If-None-Match')).toBeNull();
    expect(requestHeaders.get('If-Modified-Since')).toBeNull();
    expect(exists).toHaveBeenCalledWith(objectKey);
    expect(put).toHaveBeenCalledWith(expect.objectContaining({ key: objectKey }));
    expect(result).toMatchObject({ outcome: 'stored', persistence: { objectKey } });
  });

  it('rejects an unexpected 304 when the immutable object is missing', async () => {
    const objectKey = `community-logos/${tenantId}/${communityId}/${'a'.repeat(64)}.webp`;
    const syncedAt = '2026-07-17T10:00:00.000Z';
    const { pool } = poolWithLogoRows([
      {
        community_id: communityId,
        source_url: 'https://legacy.padlhub.test/logo/current',
        source_etag: '"logo-v1"',
        source_last_modified: null,
        content_sha256: 'a'.repeat(64),
        object_key: objectKey,
        synced_at: syncedAt,
      },
    ]);
    const { store, put, exists } = objectStore();
    exists.mockResolvedValue(false);
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 304 }));

    const [result] = await synchronizeLegacyCommunityLogos({
      ...defaults,
      pool,
      store,
      items: [item('https://legacy.padlhub.test/logo/current')],
      fetchImplementation,
    });

    expect(fetchImplementation).toHaveBeenCalledTimes(2);
    for (const [, request] of fetchImplementation.mock.calls) {
      const headers = new Headers(request?.headers);
      expect(headers.get('If-None-Match')).toBeNull();
      expect(headers.get('If-Modified-Since')).toBeNull();
    }
    expect(put).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      outcome: 'fallback',
      logoUrl: null,
      errorCode: 'COMMUNITY_LOGO_NOT_MODIFIED_WITHOUT_LOCAL_OBJECT',
      persistence: { objectKey, syncedAt },
    });
  });

  it('replaces changed bytes even when the legacy source URL is unchanged', async () => {
    const oldObjectKey = `community-logos/${tenantId}/${communityId}/${'a'.repeat(64)}.webp`;
    const png = await sharp({
      create: { width: 32, height: 32, channels: 4, background: '#e14b73' },
    })
      .png()
      .toBuffer();
    const { pool } = poolWithLogoRows([
      {
        community_id: communityId,
        source_url: 'https://legacy.padlhub.test/logo/current',
        source_etag: '"logo-v1"',
        source_last_modified: null,
        content_sha256: 'a'.repeat(64),
        object_key: oldObjectKey,
        synced_at: '2026-07-17T10:00:00.000Z',
      },
    ]);
    const { store, put } = objectStore();

    const [result] = await synchronizeLegacyCommunityLogos({
      ...defaults,
      pool,
      store,
      items: [item('https://legacy.padlhub.test/logo/current')],
      fetchImplementation: vi.fn<typeof fetch>().mockResolvedValue(
        new Response(png, {
          status: 200,
          headers: { 'content-type': 'image/png', etag: '"logo-v2"' },
        }),
      ),
    });

    expect(result).toMatchObject({
      outcome: 'stored',
      fetchAttempted: true,
      persistence: {
        sourceEtag: '"logo-v2"',
        supersededObjectKey: oldObjectKey,
        syncedAt: fetchedAt,
      },
    });
    expect(result?.persistence.objectKey).not.toBe(oldObjectKey);
    expect(put).toHaveBeenCalledOnce();
  });

  it('keeps legacy signed delivery until the stable-route cutover is enabled', async () => {
    const objectKey = `community-logos/${tenantId}/${communityId}/${'c'.repeat(64)}.webp`;
    const { pool } = poolWithLogoRows([
      {
        community_id: communityId,
        source_url: 'https://legacy.padlhub.test/logo/current',
        source_etag: null,
        source_last_modified: null,
        content_sha256: 'c'.repeat(64),
        object_key: objectKey,
        delivery_url: null,
        delivery_expires_at: null,
        synced_at: '2026-07-17T11:30:00.000Z',
      },
    ]);
    const { store, put, createReadUrl } = objectStore();

    const [result] = await synchronizeLegacyCommunityLogos({
      ...defaults,
      pool,
      store,
      items: [item('https://legacy.padlhub.test/logo/current')],
      stableDeliveryEnabled: false,
      readUrlTtlSeconds: 3_600,
      fetchImplementation: vi.fn<typeof fetch>(),
    });

    expect(result).toMatchObject({
      outcome: 'unchanged',
      logoUrl: `https://media.padlhub.test/${objectKey}?sig=test`,
      persistence: {
        deliveryUrl: `https://media.padlhub.test/${objectKey}?sig=test`,
        deliveryExpiresAt: '2026-07-17T13:00:00.000Z',
      },
    });
    expect(createReadUrl).toHaveBeenCalledWith(objectKey);
    expect(put).not.toHaveBeenCalled();
  });

  it('prepares changed bytes without upload until the community object is reserved', async () => {
    const png = await sharp({
      create: { width: 32, height: 32, channels: 4, background: '#7654d7' },
    })
      .png()
      .toBuffer();
    const { pool } = poolWithLogoRows([]);
    const { store, put } = objectStore();

    const [result] = await synchronizeLegacyCommunityLogos({
      ...defaults,
      pool,
      store,
      items: [item('https://legacy.padlhub.test/logo/new')],
      deferStorePut: true,
      fetchImplementation: vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(png, { headers: { 'content-type': 'image/png' } })),
    });

    expect(result?.outcome).toBe('stored');
    if (!result) throw new Error('Community logo result is missing');
    expect(result?.preparedObject).toMatchObject({
      key: result.persistence.objectKey,
      sha256: result.persistence.contentSha256,
    });
    expect(put).not.toHaveBeenCalled();
  });

  it('fails closed on a non-allowlisted source and keeps the current local logo', async () => {
    const objectKey = `community-logos/${tenantId}/${communityId}/${'b'.repeat(64)}.webp`;
    const { pool } = poolWithLogoRows([
      {
        community_id: communityId,
        source_url: 'https://legacy.padlhub.test/logo/old',
        source_etag: null,
        source_last_modified: null,
        content_sha256: 'b'.repeat(64),
        object_key: objectKey,
        synced_at: '2026-07-17T11:00:00.000Z',
      },
    ]);
    const { store } = objectStore();

    const [result] = await synchronizeLegacyCommunityLogos({
      ...defaults,
      pool,
      store,
      items: [item('https://attacker.example/logo.png')],
      fetchImplementation: vi.fn<typeof fetch>(),
    });

    expect(result).toMatchObject({
      outcome: 'fallback',
      errorCode: 'COMMUNITY_LOGO_SOURCE_NOT_ALLOWED',
    });
    expect(result?.logoUrl).toBe(`/public/api/v1/media/community-logos/${tenantId}/${communityId}`);
  });

  it('signs the current local object during rollback even when the provider fetch fails', async () => {
    const objectKey = `community-logos/${tenantId}/${communityId}/${'d'.repeat(64)}.webp`;
    const { pool } = poolWithLogoRows([
      {
        community_id: communityId,
        source_url: 'https://legacy.padlhub.test/logo/old',
        source_etag: null,
        source_last_modified: null,
        content_sha256: 'd'.repeat(64),
        object_key: objectKey,
        delivery_url: null,
        delivery_expires_at: null,
        synced_at: '2026-07-17T11:00:00.000Z',
      },
    ]);
    const { store, createReadUrl } = objectStore();

    const [result] = await synchronizeLegacyCommunityLogos({
      ...defaults,
      pool,
      store,
      items: [item('https://attacker.example/logo.png')],
      stableDeliveryEnabled: false,
      readUrlTtlSeconds: 3_600,
      fetchImplementation: vi.fn<typeof fetch>(),
    });

    expect(result).toMatchObject({
      outcome: 'fallback',
      errorCode: 'COMMUNITY_LOGO_SOURCE_NOT_ALLOWED',
      logoUrl: `https://media.padlhub.test/${objectKey}?sig=test`,
      persistence: {
        deliveryUrl: `https://media.padlhub.test/${objectKey}?sig=test`,
        deliveryExpiresAt: '2026-07-17T13:00:00.000Z',
      },
    });
    expect(createReadUrl).toHaveBeenCalledWith(objectKey);
  });

  it('preserves the current object and throttles same-URL retries after a provider failure', async () => {
    const objectKey = `community-logos/${tenantId}/${communityId}/${'e'.repeat(64)}.webp`;
    const { pool } = poolWithLogoRows([
      {
        community_id: communityId,
        source_url: 'https://legacy.padlhub.test/logo/current',
        source_etag: '"logo-v1"',
        source_last_modified: null,
        content_sha256: 'e'.repeat(64),
        object_key: objectKey,
        synced_at: '2026-07-17T10:00:00.000Z',
      },
    ]);
    const { store, put } = objectStore();

    const [result] = await synchronizeLegacyCommunityLogos({
      ...defaults,
      pool,
      store,
      items: [item('https://legacy.padlhub.test/logo/current')],
      fetchImplementation: vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(null, { status: 503 })),
    });

    expect(result).toMatchObject({
      outcome: 'fallback',
      fetchAttempted: true,
      errorCode: 'COMMUNITY_LOGO_SOURCE_HTTP_503',
      persistence: { objectKey, syncedAt: fetchedAt },
    });
    expect(result?.logoUrl).toBe(`/public/api/v1/media/community-logos/${tenantId}/${communityId}`);
    expect(put).not.toHaveBeenCalled();
  });

  it('caps a large batch at twenty fetches and four concurrent source requests', async () => {
    const png = await sharp({
      create: { width: 8, height: 8, channels: 4, background: '#7654d7' },
    })
      .png()
      .toBuffer();
    const items = Array.from({ length: 50 }, (_, index) => {
      const id = `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`;
      return item(`https://legacy.padlhub.test/logo/${index + 1}`, id);
    });
    let active = 0;
    let maximumActive = 0;
    const fetchImplementation = vi.fn<typeof fetch>().mockImplementation(async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return new Response(png, { headers: { 'content-type': 'image/png' } });
    });
    const { pool } = poolWithLogoRows([]);
    const { store, put } = objectStore();

    const results = await synchronizeLegacyCommunityLogos({
      ...defaults,
      pool,
      store,
      items,
      maxFetches: 20,
      maxConcurrency: 4,
      fetchImplementation,
    });

    expect(results).toHaveLength(50);
    expect(fetchImplementation).toHaveBeenCalledTimes(20);
    expect(maximumActive).toBeLessThanOrEqual(4);
    expect(put).toHaveBeenCalledTimes(20);
    expect(results.filter((result) => result.fetchAttempted)).toHaveLength(20);
  });

  it('honors a bounded Retry-After and emits redacted retry metrics', async () => {
    const png = await sharp({
      create: { width: 8, height: 8, channels: 4, background: '#7654d7' },
    })
      .png()
      .toBuffer();
    const cancel = vi.fn();
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(new ReadableStream<Uint8Array>({ cancel }), {
          status: 429,
          headers: { 'retry-after': '60' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(png, { status: 200, headers: { 'content-type': 'image/png' } }),
      );
    const sleep = vi.fn<(delayMs: number) => Promise<void>>().mockResolvedValue(undefined);
    const metrics: CommunityLogoSourceMetric[] = [];
    const sourceResilience = new CommunityLogoSourceResilience({
      fetchImplementation,
      sleep,
      onMetric: (metric) => metrics.push(metric),
    });
    const { pool } = poolWithLogoRows([]);
    const { store } = objectStore();

    const [result] = await synchronizeLegacyCommunityLogos({
      ...defaults,
      pool,
      store,
      items: [item('https://legacy.padlhub.test/logo/retry')],
      sourceResilience,
    });

    expect(result?.outcome).toBe('stored');
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
    expect(cancel).toHaveBeenCalledOnce();
    expect(sleep).toHaveBeenCalledWith(5_000);
    expect(metrics).toEqual([
      expect.objectContaining({ outcome: 'retry', attempt: 1, status: 429 }),
      expect.objectContaining({ outcome: 'success', attempt: 2, status: 200 }),
    ]);
    expect(JSON.stringify(metrics)).not.toContain('legacy.padlhub.test');
  });

  it('opens a host circuit after bounded failures and permits one probe after reset', async () => {
    let now = 1_000;
    const png = await sharp({
      create: { width: 8, height: 8, channels: 4, background: '#7654d7' },
    })
      .png()
      .toBuffer();
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(
        new Response(png, { status: 200, headers: { 'content-type': 'image/png' } }),
      );
    const metrics: CommunityLogoSourceMetric[] = [];
    const sourceResilience = new CommunityLogoSourceResilience({
      fetchImplementation,
      maxAttempts: 1,
      circuitFailureThreshold: 2,
      circuitResetMs: 1_000,
      now: () => now,
      onMetric: (metric) => metrics.push(metric),
    });
    const request = {
      sourceUrl: 'https://legacy.padlhub.test/logo/circuit',
      allowedHosts: ['legacy.padlhub.test'],
      maxBytes: defaults.maxBytes,
      timeoutMs: defaults.timeoutMs,
    };

    await expect(sourceResilience.fetch(request)).rejects.toThrow('COMMUNITY_LOGO_SOURCE_HTTP_503');
    await expect(sourceResilience.fetch(request)).rejects.toThrow('COMMUNITY_LOGO_SOURCE_HTTP_503');
    await expect(sourceResilience.fetch(request)).rejects.toThrow(
      'COMMUNITY_LOGO_SOURCE_CIRCUIT_OPEN',
    );
    expect(fetchImplementation).toHaveBeenCalledTimes(2);

    now += 1_001;
    await expect(sourceResilience.fetch(request)).resolves.toMatchObject({ status: 'modified' });
    expect(fetchImplementation).toHaveBeenCalledTimes(3);
    expect(metrics.map((metric) => metric.outcome)).toEqual([
      'failure',
      'failure',
      'circuit_open',
      'success',
    ]);
  });

  it('does not let an older success erase a newer open circuit', async () => {
    const png = await sharp({
      create: { width: 8, height: 8, channels: 4, background: '#7654d7' },
    })
      .png()
      .toBuffer();
    let resolveOlder: ((response: Response) => void) | undefined;
    const olderResponse = new Promise<Response>((resolve) => {
      resolveOlder = resolve;
    });
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(() => olderResponse)
      .mockResolvedValueOnce(new Response(null, { status: 503 }));
    const sourceResilience = new CommunityLogoSourceResilience({
      fetchImplementation,
      maxAttempts: 1,
      circuitFailureThreshold: 1,
    });
    const request = {
      sourceUrl: 'https://legacy.padlhub.test/logo/concurrent-success',
      allowedHosts: ['legacy.padlhub.test'],
      maxBytes: defaults.maxBytes,
      timeoutMs: defaults.timeoutMs,
    };

    const older = sourceResilience.fetch(request);
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
    await expect(sourceResilience.fetch(request)).rejects.toThrow('COMMUNITY_LOGO_SOURCE_HTTP_503');
    resolveOlder?.(new Response(png, { headers: { 'content-type': 'image/png' } }));
    await expect(older).resolves.toMatchObject({ status: 'modified' });

    await expect(sourceResilience.fetch(request)).rejects.toThrow(
      'COMMUNITY_LOGO_SOURCE_CIRCUIT_OPEN',
    );
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
  });

  it('accumulates concurrent host failures toward the circuit threshold', async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 503 }));
    const sourceResilience = new CommunityLogoSourceResilience({
      fetchImplementation,
      maxAttempts: 1,
      circuitFailureThreshold: 3,
    });
    const request = {
      sourceUrl: 'https://legacy.padlhub.test/logo/concurrent-failures',
      allowedHosts: ['legacy.padlhub.test'],
      maxBytes: defaults.maxBytes,
      timeoutMs: defaults.timeoutMs,
    };

    const failures = await Promise.allSettled([
      sourceResilience.fetch(request),
      sourceResilience.fetch(request),
      sourceResilience.fetch(request),
    ]);
    expect(failures.every((result) => result.status === 'rejected')).toBe(true);
    await expect(sourceResilience.fetch(request)).rejects.toThrow(
      'COMMUNITY_LOGO_SOURCE_CIRCUIT_OPEN',
    );
    expect(fetchImplementation).toHaveBeenCalledTimes(3);
  });

  it('lets a later success reset failures recorded before that request started', async () => {
    const png = await sharp({
      create: { width: 8, height: 8, channels: 4, background: '#7654d7' },
    })
      .png()
      .toBuffer();
    const ok = () => new Response(png, { headers: { 'content-type': 'image/png' } });
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(ok());
    const sourceResilience = new CommunityLogoSourceResilience({
      fetchImplementation,
      maxAttempts: 1,
      circuitFailureThreshold: 3,
    });
    const request = {
      sourceUrl: 'https://legacy.padlhub.test/logo/recovery',
      allowedHosts: ['legacy.padlhub.test'],
      maxBytes: defaults.maxBytes,
      timeoutMs: defaults.timeoutMs,
    };

    await expect(sourceResilience.fetch(request)).rejects.toThrow('COMMUNITY_LOGO_SOURCE_HTTP_503');
    await expect(sourceResilience.fetch(request)).resolves.toMatchObject({ status: 'modified' });
    await expect(sourceResilience.fetch(request)).rejects.toThrow('COMMUNITY_LOGO_SOURCE_HTTP_503');
    await expect(sourceResilience.fetch(request)).rejects.toThrow('COMMUNITY_LOGO_SOURCE_HTTP_503');
    await expect(sourceResilience.fetch(request)).resolves.toMatchObject({ status: 'modified' });
    expect(fetchImplementation).toHaveBeenCalledTimes(5);
  });

  it('allows only one half-open probe for a host', async () => {
    let now = 1_000;
    let resolveProbe: ((response: Response) => void) | undefined;
    const probeResponse = new Promise<Response>((resolve) => {
      resolveProbe = resolve;
    });
    const png = await sharp({
      create: { width: 8, height: 8, channels: 4, background: '#7654d7' },
    })
      .png()
      .toBuffer();
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockImplementationOnce(() => probeResponse);
    const sourceResilience = new CommunityLogoSourceResilience({
      fetchImplementation,
      maxAttempts: 1,
      circuitFailureThreshold: 1,
      circuitResetMs: 1_000,
      now: () => now,
    });
    const request = {
      sourceUrl: 'https://legacy.padlhub.test/logo/half-open',
      allowedHosts: ['legacy.padlhub.test'],
      maxBytes: defaults.maxBytes,
      timeoutMs: defaults.timeoutMs,
    };

    await expect(sourceResilience.fetch(request)).rejects.toThrow('COMMUNITY_LOGO_SOURCE_HTTP_503');
    now += 1_001;
    const probe = sourceResilience.fetch(request);
    await expect(sourceResilience.fetch(request)).rejects.toThrow(
      'COMMUNITY_LOGO_SOURCE_CIRCUIT_OPEN',
    );
    resolveProbe?.(new Response(png, { headers: { 'content-type': 'image/png' } }));
    await expect(probe).resolves.toMatchObject({ status: 'modified' });
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
  });
});
