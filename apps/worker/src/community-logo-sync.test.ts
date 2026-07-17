import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';

import type { CommunityDirectoryItem } from '@phub/communities';

import { synchronizeLegacyCommunityLogos } from './community-logo-sync.js';
import type { ProfilePhotoObjectStore } from './profile-photo-sync.js';

const tenantId = '86afbe01-0318-4dd2-bc25-303b7bf0d430';
const communityId = '11111111-1111-4111-8111-111111111111';
const fetchedAt = '2026-07-17T12:00:00.000Z';

function item(legacyLogoSourceUrl?: string): CommunityDirectoryItem {
  return {
    id: communityId,
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
  readUrlTtlSeconds: 3_600,
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
    expect(result?.logoUrl).toContain('https://media.padlhub.test/community-logos/');
    expect(result?.logoUrl).not.toContain('legacy.padlhub.test');
    expect(put).toHaveBeenCalledOnce();
    const stored = put.mock.calls[0]?.[0];
    expect(stored?.key).toMatch(
      new RegExp(`^community-logos/${tenantId}/${communityId}/[0-9a-f]{64}\\.webp$`),
    );
    await expect(sharp(stored?.body).metadata()).resolves.toMatchObject({ format: 'webp' });
  });

  it('reuses an unexpired local object without downloading the same legacy URL again', async () => {
    const objectKey = `community-logos/${tenantId}/${communityId}/${'a'.repeat(64)}.webp`;
    const { pool } = poolWithLogoRows([
      {
        community_id: communityId,
        source_url: 'https://legacy.padlhub.test/logo/current',
        source_etag: null,
        source_last_modified: null,
        content_sha256: 'a'.repeat(64),
        object_key: objectKey,
        delivery_url: 'https://media.padlhub.test/current.webp?sig=still-valid',
        delivery_expires_at: '2026-07-17T12:30:00.000Z',
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
      logoUrl: 'https://media.padlhub.test/current.webp?sig=still-valid',
    });
    expect(fetchImplementation).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
    expect(createReadUrl).not.toHaveBeenCalled();
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
        delivery_url: 'https://media.padlhub.test/old.webp?sig=old',
        delivery_expires_at: '2026-07-17T11:59:00.000Z',
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
    expect(result?.logoUrl).toContain('https://media.padlhub.test/community-logos/');
  });
});
