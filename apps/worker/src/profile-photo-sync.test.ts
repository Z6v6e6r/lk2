import { describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';

import { synchronizeVivaProfilePhoto, type ProfilePhotoObjectStore } from './profile-photo-sync.js';

const tenantId = '86afbe01-0318-4dd2-bc25-303b7bf0d430';
const userId = '49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca';
const fetchedAt = '2026-07-16T08:00:00.000Z';
const sourceUrl = 'https://562807.selcdn.ru/smstretching/source-photo';

function poolWith(record: Record<string, unknown>) {
  const query = vi.fn((text: string) => {
    if (
      text === 'begin' ||
      text === 'commit' ||
      text === 'rollback' ||
      text.includes("set_config('app.tenant_id'")
    ) {
      return Promise.resolve({ rows: [], rowCount: 0 });
    }
    if (text.includes('from profile.user_summaries')) {
      return Promise.resolve({ rows: [record], rowCount: 1 });
    }
    throw new Error(`Unexpected query: ${text}`);
  });
  return {
    pool: { connect: vi.fn().mockResolvedValue({ query, release: vi.fn() }) } as never,
    query,
  };
}

function store() {
  return {
    put: vi.fn<ProfilePhotoObjectStore['put']>().mockResolvedValue(undefined),
    createReadUrl: vi
      .fn<ProfilePhotoObjectStore['createReadUrl']>()
      .mockImplementation((key) => Promise.resolve(`https://media.padlhub.test/${key}?signed=1`)),
    delete: vi.fn<ProfilePhotoObjectStore['delete']>().mockResolvedValue(undefined),
  };
}

const settings = {
  tenantId,
  userId,
  fetchedAt,
  allowedHosts: ['.selcdn.ru'],
  maxBytes: 1024 * 1024,
  maxDimension: 512,
  webpQuality: 82,
  previousObjectRetentionSeconds: 3_900,
  timeoutMs: 1_000,
} as const;

describe('Viva profile photo synchronization', () => {
  it('converts a new provider photo to WebP and stores a content-addressed object', async () => {
    const png = await sharp({
      create: { width: 2, height: 2, channels: 3, background: '#8a63ff' },
    })
      .png()
      .toBuffer();
    const database = poolWith({
      photo_url: null,
      source_url: null,
      source_etag: null,
      source_last_modified: null,
      content_sha256: null,
      object_key: null,
      synced_at: null,
    });
    const objectStore = store();
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(png, {
        status: 200,
        headers: { 'Content-Type': 'image/png', ETag: '"photo-v1"' },
      }),
    );

    const result = await synchronizeVivaProfilePhoto({
      ...settings,
      pool: database.pool,
      store: objectStore,
      sourceUrl,
      fetchImplementation,
    });

    expect(result.outcome).toBe('stored');
    expect(result.persistence).toMatchObject({
      sourceUrl,
      sourceEtag: '"photo-v1"',
      syncedAt: fetchedAt,
    });
    expect(result.persistence.objectKey).toMatch(
      new RegExp(`^profile-photos/${tenantId}/${userId}/[0-9a-f]{64}\\.webp$`),
    );
    expect(objectStore.put).toHaveBeenCalledOnce();
    const uploaded = objectStore.put.mock.calls[0]?.[0];
    expect(uploaded?.body.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(uploaded?.body.subarray(8, 12).toString('ascii')).toBe('WEBP');
    const requestHeaders = new Headers(fetchImplementation.mock.calls[0]?.[1]?.headers);
    expect(requestHeaders.get('User-Agent')).toBe('PadlHub Profile Photo Sync/1.0');
  });

  it('uses a conditional request and keeps the locally stored object on 304', async () => {
    const contentSha256 = 'a'.repeat(64);
    const objectKey = `profile-photos/${tenantId}/${userId}/${contentSha256}.webp`;
    const database = poolWith({
      photo_url: 'https://media.padlhub.test/old-signed-url',
      source_url: sourceUrl,
      source_etag: '"photo-v1"',
      source_last_modified: null,
      content_sha256: contentSha256,
      object_key: objectKey,
      synced_at: fetchedAt,
    });
    const objectStore = store();
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 304 }));

    const result = await synchronizeVivaProfilePhoto({
      ...settings,
      pool: database.pool,
      store: objectStore,
      sourceUrl,
      fetchImplementation,
    });

    expect(result.outcome).toBe('unchanged');
    expect(objectStore.put).not.toHaveBeenCalled();
    expect(objectStore.createReadUrl).toHaveBeenCalledWith(objectKey);
    const requestHeaders = new Headers(fetchImplementation.mock.calls[0]?.[1]?.headers);
    expect(requestHeaders.get('If-None-Match')).toBe('"photo-v1"');
  });

  it('clears the profile and schedules the previous object for deletion when Viva removes photo', async () => {
    const contentSha256 = 'b'.repeat(64);
    const objectKey = `profile-photos/${tenantId}/${userId}/${contentSha256}.webp`;
    const database = poolWith({
      photo_url: 'https://media.padlhub.test/old-signed-url',
      source_url: sourceUrl,
      source_etag: null,
      source_last_modified: null,
      content_sha256: contentSha256,
      object_key: objectKey,
      synced_at: fetchedAt,
    });

    await expect(
      synchronizeVivaProfilePhoto({
        ...settings,
        pool: database.pool,
        store: store(),
      }),
    ).resolves.toEqual({
      outcome: 'removed',
      persistence: {
        avatarUrl: null,
        syncedAt: fetchedAt,
        supersededObjectKey: objectKey,
        deleteAfter: '2026-07-16T09:05:00.000Z',
      },
    });
  });
});
