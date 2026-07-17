import { createHash } from 'node:crypto';

import sharp from 'sharp';

import type { ProfilePhotoObjectStore } from './profile-photo-sync.js';

const IMAGE_CONTENT_TYPE = /^image\/(?:avif|gif|heic|heif|jpeg|png|webp)(?:;|$)/i;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export interface PromotionMediaCandidate {
  readonly promotionId: string;
  readonly sourceUrl: string;
}

export interface PromotionMediaSyncRecord {
  readonly promotionId: string;
  readonly sourceUrl: string;
  readonly sourceEtag?: string;
  readonly sourceLastModified?: string;
  readonly desktopSha256: string;
  readonly mobileSha256: string;
  readonly desktopObjectKey: string;
  readonly mobileObjectKey: string;
  readonly desktopDeliveryUrl: string;
  readonly mobileDeliveryUrl: string;
  readonly deliveryExpiresAt: string;
  readonly syncedAt: string;
}

export interface PromotionMediaPersistence extends PromotionMediaSyncRecord {
  readonly supersededObjectKeys?: readonly string[];
  readonly deleteAfter?: string;
}

export interface PromotionMediaSyncResult {
  readonly promotionId: string;
  readonly imageUrl: string;
  readonly mobileImageUrl: string;
  readonly persistence: PromotionMediaPersistence;
  readonly outcome: 'stored' | 'unchanged';
}

function allowedSourceUrl(value: string, allowedHosts: readonly string[]): URL {
  const url = new URL(value);
  const hostname = url.hostname.toLowerCase();
  const allowed = allowedHosts.some((entry) => {
    const candidate = entry.trim().toLowerCase();
    return candidate.startsWith('.')
      ? hostname.endsWith(candidate) && hostname.length > candidate.length
      : hostname === candidate;
  });
  if (url.protocol !== 'https:' || !allowed || url.username || url.password) {
    throw new Error('PROMOTION_MEDIA_SOURCE_NOT_ALLOWED');
  }
  return url;
}

async function readBoundedBody(response: Response, maxBytes: number): Promise<Buffer> {
  const announced = Number(response.headers.get('content-length') ?? '0');
  if (Number.isFinite(announced) && announced > maxBytes) {
    throw new Error('PROMOTION_MEDIA_TOO_LARGE');
  }
  if (!response.body) throw new Error('PROMOTION_MEDIA_BODY_MISSING');
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > maxBytes) throw new Error('PROMOTION_MEDIA_TOO_LARGE');
      chunks.push(Buffer.from(chunk.value));
    }
  } finally {
    reader.releaseLock();
  }
  if (total === 0) throw new Error('PROMOTION_MEDIA_BODY_MISSING');
  return Buffer.concat(chunks, total);
}

async function fetchSource(input: {
  readonly sourceUrl: string;
  readonly allowedHosts: readonly string[];
  readonly maxBytes: number;
  readonly timeoutMs: number;
  readonly fetchImplementation: typeof fetch;
}): Promise<{ readonly body: Buffer; readonly etag?: string; readonly lastModified?: string }> {
  let url = allowedSourceUrl(input.sourceUrl, input.allowedHosts);
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
        if (!location || redirects === 2) throw new Error('PROMOTION_MEDIA_REDIRECT_INVALID');
        url = allowedSourceUrl(new URL(location, url).toString(), input.allowedHosts);
        continue;
      }
      if (!response.ok) throw new Error(`PROMOTION_MEDIA_SOURCE_HTTP_${response.status}`);
      if (!IMAGE_CONTENT_TYPE.test(response.headers.get('content-type') ?? '')) {
        throw new Error('PROMOTION_MEDIA_CONTENT_TYPE_INVALID');
      }
      const etag = response.headers.get('etag');
      const lastModified = response.headers.get('last-modified');
      return {
        body: await readBoundedBody(response, input.maxBytes),
        ...(etag ? { etag } : {}),
        ...(lastModified ? { lastModified } : {}),
      };
    }
    throw new Error('PROMOTION_MEDIA_REDIRECT_INVALID');
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('PROMOTION_MEDIA_SOURCE_TIMEOUT', { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function refreshDeliveryUrls(input: {
  readonly current: PromotionMediaSyncRecord;
  readonly store: ProfilePhotoObjectStore;
  readonly fetchedAt: string;
  readonly readUrlTtlSeconds: number;
}): Promise<PromotionMediaSyncRecord> {
  const refreshSkewSeconds = Math.min(300, Math.floor(input.readUrlTtlSeconds / 2));
  if (
    Date.parse(input.current.deliveryExpiresAt) >
    Date.parse(input.fetchedAt) + refreshSkewSeconds * 1_000
  ) {
    return input.current;
  }
  const [desktopDeliveryUrl, mobileDeliveryUrl] = await Promise.all([
    input.store.createReadUrl(input.current.desktopObjectKey),
    input.store.createReadUrl(input.current.mobileObjectKey),
  ]);
  return {
    ...input.current,
    desktopDeliveryUrl,
    mobileDeliveryUrl,
    deliveryExpiresAt: new Date(
      Date.parse(input.fetchedAt) + input.readUrlTtlSeconds * 1_000,
    ).toISOString(),
  };
}

async function synchronizeOne(input: {
  readonly store: ProfilePhotoObjectStore;
  readonly tenantId: string;
  readonly candidate: PromotionMediaCandidate;
  readonly current?: PromotionMediaSyncRecord;
  readonly fetchedAt: string;
  readonly allowedHosts: readonly string[];
  readonly maxBytes: number;
  readonly desktopMaxWidth: number;
  readonly desktopMaxHeight: number;
  readonly mobileWidth: number;
  readonly mobileHeight: number;
  readonly webpQuality: number;
  readonly previousObjectRetentionSeconds: number;
  readonly readUrlTtlSeconds: number;
  readonly timeoutMs: number;
  readonly fetchImplementation: typeof fetch;
}): Promise<PromotionMediaSyncResult> {
  if (input.current?.sourceUrl === input.candidate.sourceUrl) {
    const current = await refreshDeliveryUrls({
      current: input.current,
      store: input.store,
      fetchedAt: input.fetchedAt,
      readUrlTtlSeconds: input.readUrlTtlSeconds,
    });
    return {
      promotionId: input.candidate.promotionId,
      imageUrl: current.desktopDeliveryUrl,
      mobileImageUrl: current.mobileDeliveryUrl,
      persistence: current,
      outcome: 'unchanged',
    };
  }

  const source = await fetchSource({
    sourceUrl: input.candidate.sourceUrl,
    allowedHosts: input.allowedHosts,
    maxBytes: input.maxBytes,
    timeoutMs: input.timeoutMs,
    fetchImplementation: input.fetchImplementation,
  });
  const pipeline = sharp(source.body, { failOn: 'error', limitInputPixels: 30_000_000 }).rotate();
  const [desktop, mobile] = await Promise.all([
    pipeline
      .clone()
      .resize({
        width: input.desktopMaxWidth,
        height: input.desktopMaxHeight,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .webp({ quality: input.webpQuality, effort: 4 })
      .toBuffer(),
    pipeline
      .clone()
      .resize({
        width: input.mobileWidth,
        height: input.mobileHeight,
        fit: 'cover',
        position: 'attention',
      })
      .webp({ quality: input.webpQuality, effort: 4 })
      .toBuffer(),
  ]);
  const desktopSha256 = createHash('sha256').update(desktop).digest('hex');
  const mobileSha256 = createHash('sha256').update(mobile).digest('hex');
  const prefix = `promotion-media/${input.tenantId}/${input.candidate.promotionId}`;
  const desktopObjectKey = `${prefix}/desktop/${desktopSha256}.webp`;
  const mobileObjectKey = `${prefix}/mobile/${mobileSha256}.webp`;
  await Promise.all([
    input.store.put({ key: desktopObjectKey, body: desktop, sha256: desktopSha256 }),
    input.store.put({ key: mobileObjectKey, body: mobile, sha256: mobileSha256 }),
  ]);
  const [desktopDeliveryUrl, mobileDeliveryUrl] = await Promise.all([
    input.store.createReadUrl(desktopObjectKey),
    input.store.createReadUrl(mobileObjectKey),
  ]);
  const deliveryExpiresAt = new Date(
    Date.parse(input.fetchedAt) + input.readUrlTtlSeconds * 1_000,
  ).toISOString();
  const supersededObjectKeys = input.current
    ? [input.current.desktopObjectKey, input.current.mobileObjectKey].filter(
        (key) => key !== desktopObjectKey && key !== mobileObjectKey,
      )
    : [];
  return {
    promotionId: input.candidate.promotionId,
    imageUrl: desktopDeliveryUrl,
    mobileImageUrl: mobileDeliveryUrl,
    outcome: 'stored',
    persistence: {
      promotionId: input.candidate.promotionId,
      sourceUrl: input.candidate.sourceUrl,
      ...(source.etag ? { sourceEtag: source.etag } : {}),
      ...(source.lastModified ? { sourceLastModified: source.lastModified } : {}),
      desktopSha256,
      mobileSha256,
      desktopObjectKey,
      mobileObjectKey,
      desktopDeliveryUrl,
      mobileDeliveryUrl,
      deliveryExpiresAt,
      syncedAt: input.fetchedAt,
      ...(supersededObjectKeys.length > 0
        ? {
            supersededObjectKeys,
            deleteAfter: new Date(
              Date.parse(input.fetchedAt) + input.previousObjectRetentionSeconds * 1_000,
            ).toISOString(),
          }
        : {}),
    },
  };
}

export async function synchronizePromotionMedia(input: {
  readonly store: ProfilePhotoObjectStore;
  readonly tenantId: string;
  readonly candidates: readonly PromotionMediaCandidate[];
  readonly current: ReadonlyMap<string, PromotionMediaSyncRecord>;
  readonly fetchedAt: string;
  readonly allowedHosts: readonly string[];
  readonly maxBytes: number;
  readonly desktopMaxWidth: number;
  readonly desktopMaxHeight: number;
  readonly mobileWidth: number;
  readonly mobileHeight: number;
  readonly webpQuality: number;
  readonly previousObjectRetentionSeconds: number;
  readonly readUrlTtlSeconds: number;
  readonly timeoutMs: number;
  readonly fetchImplementation?: typeof fetch;
}): Promise<readonly PromotionMediaSyncResult[]> {
  const { current: currentByPromotionId, fetchImplementation: providedFetch, ...options } = input;
  const fetchImplementation = providedFetch ?? ((request, init) => globalThis.fetch(request, init));
  const results: PromotionMediaSyncResult[] = [];
  for (const candidate of options.candidates) {
    const current = currentByPromotionId.get(candidate.promotionId);
    results.push(
      await synchronizeOne({
        ...options,
        candidate,
        ...(current ? { current } : {}),
        fetchImplementation,
      }),
    );
  }
  return results;
}
