import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';

import type { CommunityDirectoryItem } from '@phub/communities';

import {
  CommunityLogoHostCircuit,
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
  const store: ProfilePhotoObjectStore = {
    put,
    createReadUrl,
    delete: vi.fn().mockResolvedValue(undefined),
  };
  return { store, put, createReadUrl };
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
        synced_at: '2026-07-17T11:00:00.000Z',
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
        synced_at: '2026-07-17T11:00:00.000Z',
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

  it('limits external logo downloads and image normalization to three concurrent items', async () => {
    const png = await sharp({
      create: { width: 16, height: 16, channels: 4, background: '#7654d7' },
    })
      .png()
      .toBuffer();
    let inFlight = 0;
    let maxInFlight = 0;
    const fetchImplementation = vi.fn<typeof fetch>().mockImplementation(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 10));
      inFlight -= 1;
      return new Response(png, { headers: { 'content-type': 'image/png' } });
    });
    const { pool } = poolWithLogoRows([]);
    const { store } = objectStore();
    const items = Array.from({ length: 8 }, (_, index) => {
      const suffix = String(index + 1).padStart(12, '0');
      const id = `00000000-0000-4000-8000-${suffix}`;
      return item(`https://legacy.padlhub.test/logo/${index + 1}`, id);
    });

    await synchronizeLegacyCommunityLogos({
      ...defaults,
      pool,
      store,
      items,
      fetchImplementation,
    });

    expect(fetchImplementation).toHaveBeenCalledTimes(items.length);
    expect(maxInFlight).toBe(3);
  });

  it('opens a per-host circuit, skips fetches during cooldown and records recovery', async () => {
    const png = await sharp({
      create: { width: 16, height: 16, channels: 4, background: '#7654d7' },
    })
      .png()
      .toBuffer();
    let now = Date.parse(fetchedAt);
    const onMetric = vi.fn();
    const circuit = new CommunityLogoHostCircuit({
      failureThreshold: 1,
      resetMs: 1_000,
      maxResetMs: 4_000,
      now: () => now,
      onMetric,
    });
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(png, { headers: { 'content-type': 'image/png' } }));
    const { pool } = poolWithLogoRows([]);
    const { store } = objectStore();
    const input = {
      ...defaults,
      pool,
      store,
      items: [item('https://legacy.padlhub.test/logo/recovering')],
      fetchImplementation,
      circuit,
    };

    const [failed] = await synchronizeLegacyCommunityLogos(input);
    const [open] = await synchronizeLegacyCommunityLogos(input);
    now += 1_000;
    const [recovered] = await synchronizeLegacyCommunityLogos(input);

    expect(failed).toMatchObject({
      outcome: 'fallback',
      errorCode: 'COMMUNITY_LOGO_SOURCE_HTTP_503',
    });
    expect(open).toMatchObject({
      outcome: 'fallback',
      errorCode: 'COMMUNITY_LOGO_SOURCE_CIRCUIT_OPEN',
    });
    expect(recovered).toMatchObject({ outcome: 'stored' });
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
    expect(onMetric).toHaveBeenNthCalledWith(1, {
      outcome: 'failure',
      errorCode: 'COMMUNITY_LOGO_SOURCE_HTTP_503',
    });
    expect(onMetric).toHaveBeenNthCalledWith(2, { outcome: 'circuit_open' });
    expect(onMetric).toHaveBeenNthCalledWith(3, { outcome: 'circuit_probe' });
    expect(onMetric).toHaveBeenNthCalledWith(4, { outcome: 'recovered' });
  });

  it('starts the full circuit cooldown when a failed request completes', async () => {
    let now = Date.parse(fetchedAt);
    const circuit = new CommunityLogoHostCircuit({
      failureThreshold: 1,
      resetMs: 1_000,
      now: () => now,
    });

    await expect(
      circuit.execute('legacy.padlhub.test', () => {
        now += 5_000;
        return Promise.reject(new Error('COMMUNITY_LOGO_SOURCE_HTTP_503'));
      }),
    ).rejects.toThrow('COMMUNITY_LOGO_SOURCE_HTTP_503');

    const blockedOperation = vi.fn().mockResolvedValue('blocked');
    await expect(circuit.execute('legacy.padlhub.test', blockedOperation)).rejects.toThrow(
      'COMMUNITY_LOGO_SOURCE_CIRCUIT_OPEN',
    );
    now += 999;
    await expect(circuit.execute('legacy.padlhub.test', blockedOperation)).rejects.toThrow(
      'COMMUNITY_LOGO_SOURCE_CIRCUIT_OPEN',
    );
    expect(blockedOperation).not.toHaveBeenCalled();

    now += 1;
    await expect(
      circuit.execute('legacy.padlhub.test', () => Promise.resolve('recovered')),
    ).resolves.toBe('recovered');
  });

  it('does not let a slower pre-open success erase a newer open circuit', async () => {
    const circuit = new CommunityLogoHostCircuit({ failureThreshold: 1, resetMs: 1_000 });
    let resolveSlow: ((value: string) => void) | undefined;
    const slowOperation = new Promise<string>((resolve) => {
      resolveSlow = resolve;
    });

    const slowResult = circuit.execute('legacy.padlhub.test', () => slowOperation);
    await expect(
      circuit.execute('legacy.padlhub.test', () =>
        Promise.reject(new Error('COMMUNITY_LOGO_SOURCE_HTTP_503')),
      ),
    ).rejects.toThrow('COMMUNITY_LOGO_SOURCE_HTTP_503');

    resolveSlow?.('late success');
    await expect(slowResult).resolves.toBe('late success');

    const blockedOperation = vi.fn().mockResolvedValue('should not run');
    await expect(circuit.execute('legacy.padlhub.test', blockedOperation)).rejects.toThrow(
      'COMMUNITY_LOGO_SOURCE_CIRCUIT_OPEN',
    );
    expect(blockedOperation).not.toHaveBeenCalled();
  });

  it('recovers the host circuit when a half-open probe returns an item-specific error', async () => {
    let now = Date.parse(fetchedAt);
    const circuit = new CommunityLogoHostCircuit({
      failureThreshold: 1,
      resetMs: 1_000,
      now: () => now,
    });

    await expect(
      circuit.execute('legacy.padlhub.test', () =>
        Promise.reject(new Error('COMMUNITY_LOGO_SOURCE_HTTP_503')),
      ),
    ).rejects.toThrow('COMMUNITY_LOGO_SOURCE_HTTP_503');

    now += 1_000;
    await expect(
      circuit.execute('legacy.padlhub.test', () =>
        Promise.reject(new Error('COMMUNITY_LOGO_SOURCE_HTTP_404')),
      ),
    ).rejects.toThrow('COMMUNITY_LOGO_SOURCE_HTTP_404');

    const nextOperation = vi.fn().mockResolvedValue('next item');
    await expect(circuit.execute('legacy.padlhub.test', nextOperation)).resolves.toBe('next item');
    expect(nextOperation).toHaveBeenCalledOnce();
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
});
