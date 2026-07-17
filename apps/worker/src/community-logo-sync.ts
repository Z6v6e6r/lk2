import { createHash } from 'node:crypto';

import type { CommunityDirectoryItem } from '@phub/communities';
import type { Pool } from 'pg';
import sharp from 'sharp';

import type { ProfilePhotoObjectStore } from './profile-photo-sync.js';
import { loadCommunityLogoSyncRecords } from './community-home-repository.js';

const IMAGE_CONTENT_TYPE = /^image\/(?:avif|gif|heic|heif|jpeg|png|webp)(?:;|$)/i;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export interface CommunityLogoSyncRecord {
  readonly communityId: string;
  readonly sourceUrl: string;
  readonly sourceEtag?: string;
  readonly sourceLastModified?: string;
  readonly contentSha256: string;
  readonly objectKey: string;
  readonly deliveryUrl: string;
  readonly deliveryExpiresAt: string;
  readonly syncedAt: string;
}

export interface CommunityLogoPersistence {
  readonly communityId: string;
  readonly deliveryUrl: string | null;
  readonly deliveryExpiresAt?: string;
  readonly sourceUrl?: string;
  readonly sourceEtag?: string;
  readonly sourceLastModified?: string;
  readonly contentSha256?: string;
  readonly objectKey?: string;
  readonly supersededObjectKey?: string;
  readonly deleteAfter?: string;
  readonly syncedAt: string;
}

export interface CommunityLogoSyncResult {
  readonly communityId: string;
  readonly logoUrl: string | null;
  readonly persistence: CommunityLogoPersistence;
  readonly outcome: 'stored' | 'unchanged' | 'removed' | 'fallback';
  readonly errorCode?: string;
}

function allowedLogoUrl(value: string, allowedHosts: readonly string[]): URL {
  const url = new URL(value);
  const hostname = url.hostname.toLowerCase();
  const allowed = allowedHosts.some((entry) => {
    const candidate = entry.trim().toLowerCase();
    return candidate.startsWith('.')
      ? hostname.endsWith(candidate) && hostname.length > candidate.length
      : hostname === candidate;
  });
  if (url.protocol !== 'https:' || !allowed || url.username || url.password) {
    throw new Error('COMMUNITY_LOGO_SOURCE_NOT_ALLOWED');
  }
  return url;
}

async function readBoundedBody(response: Response, maxBytes: number): Promise<Buffer> {
  const announcedLength = Number(response.headers.get('content-length') ?? '0');
  if (Number.isFinite(announcedLength) && announcedLength > maxBytes) {
    throw new Error('COMMUNITY_LOGO_TOO_LARGE');
  }
  if (!response.body) throw new Error('COMMUNITY_LOGO_BODY_MISSING');
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > maxBytes) throw new Error('COMMUNITY_LOGO_TOO_LARGE');
      chunks.push(Buffer.from(chunk.value));
    }
  } finally {
    reader.releaseLock();
  }
  if (total === 0) throw new Error('COMMUNITY_LOGO_BODY_MISSING');
  return Buffer.concat(chunks, total);
}

async function fetchSourceLogo(input: {
  readonly sourceUrl: string;
  readonly allowedHosts: readonly string[];
  readonly maxBytes: number;
  readonly timeoutMs: number;
  readonly fetchImplementation: typeof fetch;
}): Promise<{
  readonly body: Buffer;
  readonly etag?: string;
  readonly lastModified?: string;
}> {
  let url = allowedLogoUrl(input.sourceUrl, input.allowedHosts);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs);
  try {
    for (let redirects = 0; redirects <= 2; redirects += 1) {
      const response = await input.fetchImplementation(url, {
        method: 'GET',
        redirect: 'manual',
        headers: { Accept: 'image/avif,image/webp,image/png,image/jpeg' },
        signal: controller.signal,
      });
      if (REDIRECT_STATUSES.has(response.status)) {
        const location = response.headers.get('location');
        if (!location || redirects === 2) throw new Error('COMMUNITY_LOGO_REDIRECT_INVALID');
        url = allowedLogoUrl(new URL(location, url).toString(), input.allowedHosts);
        continue;
      }
      if (!response.ok) throw new Error(`COMMUNITY_LOGO_SOURCE_HTTP_${response.status}`);
      if (!IMAGE_CONTENT_TYPE.test(response.headers.get('content-type') ?? '')) {
        throw new Error('COMMUNITY_LOGO_CONTENT_TYPE_INVALID');
      }
      const etag = response.headers.get('etag');
      const lastModified = response.headers.get('last-modified');
      return {
        body: await readBoundedBody(response, input.maxBytes),
        ...(etag ? { etag } : {}),
        ...(lastModified ? { lastModified } : {}),
      };
    }
    throw new Error('COMMUNITY_LOGO_REDIRECT_INVALID');
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('COMMUNITY_LOGO_SOURCE_TIMEOUT', { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function errorCode(error: unknown): string {
  if (error instanceof Error && /^COMMUNITY_LOGO_[A-Z0-9_]+$/.test(error.message)) {
    return error.message;
  }
  return 'COMMUNITY_LOGO_SYNC_FAILED';
}

function deletionFields(
  objectKey: string | undefined,
  fetchedAt: string,
  retentionSeconds: number,
): Pick<CommunityLogoPersistence, 'supersededObjectKey' | 'deleteAfter'> {
  if (!objectKey) return {};
  return {
    supersededObjectKey: objectKey,
    deleteAfter: new Date(Date.parse(fetchedAt) + retentionSeconds * 1_000).toISOString(),
  };
}

function persistenceFromCurrent(
  current: CommunityLogoSyncRecord,
  delivery?: { readonly url: string; readonly expiresAt: string },
): CommunityLogoPersistence {
  return {
    communityId: current.communityId,
    deliveryUrl: delivery?.url ?? current.deliveryUrl,
    deliveryExpiresAt: delivery?.expiresAt ?? current.deliveryExpiresAt,
    sourceUrl: current.sourceUrl,
    ...(current.sourceEtag ? { sourceEtag: current.sourceEtag } : {}),
    ...(current.sourceLastModified ? { sourceLastModified: current.sourceLastModified } : {}),
    contentSha256: current.contentSha256,
    objectKey: current.objectKey,
    syncedAt: current.syncedAt,
  };
}

async function refreshDeliveryUrl(input: {
  readonly store: ProfilePhotoObjectStore;
  readonly current: CommunityLogoSyncRecord;
  readonly fetchedAt: string;
  readonly readUrlTtlSeconds: number;
}): Promise<{ readonly url: string; readonly expiresAt: string } | undefined> {
  const refreshSkewSeconds = Math.min(300, Math.floor(input.readUrlTtlSeconds / 2));
  if (
    Date.parse(input.current.deliveryExpiresAt) >
    Date.parse(input.fetchedAt) + refreshSkewSeconds * 1_000
  ) {
    return undefined;
  }
  return {
    url: await input.store.createReadUrl(input.current.objectKey),
    expiresAt: new Date(
      Date.parse(input.fetchedAt) + input.readUrlTtlSeconds * 1_000,
    ).toISOString(),
  };
}

async function synchronizeOne(input: {
  readonly store: ProfilePhotoObjectStore;
  readonly tenantId: string;
  readonly item: CommunityDirectoryItem;
  readonly current?: CommunityLogoSyncRecord;
  readonly fetchedAt: string;
  readonly allowedHosts: readonly string[];
  readonly maxBytes: number;
  readonly maxDimension: number;
  readonly webpQuality: number;
  readonly previousObjectRetentionSeconds: number;
  readonly readUrlTtlSeconds: number;
  readonly timeoutMs: number;
  readonly fetchImplementation: typeof fetch;
}): Promise<CommunityLogoSyncResult> {
  if (!input.item.legacyLogoSourceUrl) {
    return {
      communityId: input.item.id,
      logoUrl: null,
      outcome: 'removed',
      persistence: {
        communityId: input.item.id,
        deliveryUrl: null,
        syncedAt: input.fetchedAt,
        ...deletionFields(
          input.current?.objectKey,
          input.fetchedAt,
          input.previousObjectRetentionSeconds,
        ),
      },
    };
  }

  try {
    if (input.current?.sourceUrl === input.item.legacyLogoSourceUrl && input.current.objectKey) {
      const delivery = await refreshDeliveryUrl({
        store: input.store,
        current: input.current,
        fetchedAt: input.fetchedAt,
        readUrlTtlSeconds: input.readUrlTtlSeconds,
      });
      const persistence = persistenceFromCurrent(input.current, delivery);
      return {
        communityId: input.item.id,
        logoUrl: persistence.deliveryUrl,
        persistence,
        outcome: 'unchanged',
      };
    }

    const source = await fetchSourceLogo({
      sourceUrl: input.item.legacyLogoSourceUrl,
      allowedHosts: input.allowedHosts,
      maxBytes: input.maxBytes,
      timeoutMs: input.timeoutMs,
      fetchImplementation: input.fetchImplementation,
    });
    const webp = await sharp(source.body, { failOn: 'error', limitInputPixels: 20_000_000 })
      .rotate()
      .resize({
        width: input.maxDimension,
        height: input.maxDimension,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .webp({ quality: input.webpQuality, effort: 4 })
      .toBuffer();
    const contentSha256 = createHash('sha256').update(webp).digest('hex');
    const objectKey = `community-logos/${input.tenantId}/${input.item.id}/${contentSha256}.webp`;
    if (input.current?.contentSha256 !== contentSha256 || input.current.objectKey !== objectKey) {
      await input.store.put({ key: objectKey, body: webp, sha256: contentSha256 });
    }
    const deliveryUrl = await input.store.createReadUrl(objectKey);
    const deliveryExpiresAt = new Date(
      Date.parse(input.fetchedAt) + input.readUrlTtlSeconds * 1_000,
    ).toISOString();
    return {
      communityId: input.item.id,
      logoUrl: deliveryUrl,
      outcome:
        input.current?.contentSha256 === contentSha256 && input.current.objectKey === objectKey
          ? 'unchanged'
          : 'stored',
      persistence: {
        communityId: input.item.id,
        deliveryUrl,
        deliveryExpiresAt,
        sourceUrl: input.item.legacyLogoSourceUrl,
        ...(source.etag ? { sourceEtag: source.etag } : {}),
        ...(source.lastModified ? { sourceLastModified: source.lastModified } : {}),
        contentSha256,
        objectKey,
        syncedAt: input.fetchedAt,
        ...(input.current?.objectKey && input.current.objectKey !== objectKey
          ? deletionFields(
              input.current.objectKey,
              input.fetchedAt,
              input.previousObjectRetentionSeconds,
            )
          : {}),
      },
    };
  } catch (error) {
    if (!input.current) {
      return {
        communityId: input.item.id,
        logoUrl: null,
        persistence: {
          communityId: input.item.id,
          deliveryUrl: null,
          syncedAt: input.fetchedAt,
        },
        outcome: 'fallback',
        errorCode: errorCode(error),
      };
    }
    const delivery = await input.store
      .createReadUrl(input.current.objectKey)
      .then((url) => ({
        url,
        expiresAt: new Date(
          Date.parse(input.fetchedAt) + input.readUrlTtlSeconds * 1_000,
        ).toISOString(),
      }))
      .catch(() => undefined);
    const persistence = persistenceFromCurrent(input.current, delivery);
    return {
      communityId: input.item.id,
      logoUrl: persistence.deliveryUrl,
      persistence,
      outcome: 'fallback',
      errorCode: errorCode(error),
    };
  }
}

export async function synchronizeLegacyCommunityLogos(input: {
  readonly pool: Pool;
  readonly store: ProfilePhotoObjectStore;
  readonly tenantId: string;
  readonly items: readonly CommunityDirectoryItem[];
  readonly fetchedAt: string;
  readonly allowedHosts: readonly string[];
  readonly maxBytes: number;
  readonly maxDimension: number;
  readonly webpQuality: number;
  readonly previousObjectRetentionSeconds: number;
  readonly readUrlTtlSeconds: number;
  readonly timeoutMs: number;
  readonly fetchImplementation?: typeof fetch;
}): Promise<readonly CommunityLogoSyncResult[]> {
  const current = await loadCommunityLogoSyncRecords({
    pool: input.pool,
    tenantId: input.tenantId,
    communityIds: input.items.map((item) => item.id),
  });
  return Promise.all(
    input.items.map((item) => {
      const existing = current.get(item.id);
      return synchronizeOne({
        ...input,
        item,
        ...(existing ? { current: existing } : {}),
        fetchImplementation: input.fetchImplementation ?? fetch,
      });
    }),
  );
}
