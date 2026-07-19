import { createHash } from 'node:crypto';

import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Pool } from 'pg';
import sharp from 'sharp';

import {
  loadProfilePhotoSyncRecord,
  type ProfilePhotoPersistence,
  type ProfilePhotoSyncRecord,
} from './viva-home-repository.js';

const IMAGE_CONTENT_TYPE = /^image\/(?:avif|heic|heif|jpeg|png|webp)(?:;|$)/i;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const PROFILE_PHOTO_FETCH_USER_AGENT = 'PadlHub Profile Photo Sync/1.0';

export interface ProfilePhotoObjectStore {
  put(input: {
    readonly key: string;
    readonly body: Buffer;
    readonly sha256: string;
  }): Promise<void>;
  createReadUrl(key: string): Promise<string>;
  delete(key: string): Promise<void>;
}

export interface ProfilePhotoSyncResult {
  readonly persistence: ProfilePhotoPersistence;
  readonly outcome: 'stored' | 'unchanged' | 'removed' | 'fallback';
  readonly errorCode?: string;
}

export interface S3ProfilePhotoObjectStoreOptions {
  readonly endpoint: string;
  readonly publicEndpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly accessKey: string;
  readonly secretKey: string;
  readonly forcePathStyle: boolean;
  readonly autoCreateBucket: boolean;
  readonly readUrlTtlSeconds: number;
}

function status(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const metadata = '$metadata' in error ? error.$metadata : undefined;
  if (!metadata || typeof metadata !== 'object' || !('httpStatusCode' in metadata))
    return undefined;
  return typeof metadata.httpStatusCode === 'number' ? metadata.httpStatusCode : undefined;
}

export class S3ProfilePhotoObjectStore implements ProfilePhotoObjectStore {
  private readonly internalClient: S3Client;
  private readonly deliveryClient: S3Client;
  private ready: Promise<void> | undefined;

  public constructor(private readonly options: S3ProfilePhotoObjectStoreOptions) {
    const shared = {
      region: options.region,
      credentials: { accessKeyId: options.accessKey, secretAccessKey: options.secretKey },
      forcePathStyle: options.forcePathStyle,
    };
    this.internalClient = new S3Client({ ...shared, endpoint: options.endpoint });
    this.deliveryClient = new S3Client({ ...shared, endpoint: options.publicEndpoint });
  }

  private ensureReady(): Promise<void> {
    this.ready ??= (async () => {
      try {
        await this.internalClient.send(new HeadBucketCommand({ Bucket: this.options.bucket }));
      } catch (error) {
        if (status(error) !== 404 || !this.options.autoCreateBucket) throw error;
        try {
          await this.internalClient.send(new CreateBucketCommand({ Bucket: this.options.bucket }));
        } catch (createError) {
          if (status(createError) !== 409) throw createError;
        }
      }
    })();
    return this.ready;
  }

  public async put(input: {
    readonly key: string;
    readonly body: Buffer;
    readonly sha256: string;
  }): Promise<void> {
    await this.ensureReady();
    await this.internalClient.send(
      new PutObjectCommand({
        Bucket: this.options.bucket,
        Key: input.key,
        Body: input.body,
        ContentType: 'image/webp',
        CacheControl: 'private, max-age=31536000, immutable',
        Metadata: { sha256: input.sha256 },
      }),
    );
  }

  public async createReadUrl(key: string): Promise<string> {
    await this.ensureReady();
    return getSignedUrl(
      this.deliveryClient,
      new GetObjectCommand({
        Bucket: this.options.bucket,
        Key: key,
        ResponseContentType: 'image/webp',
        ResponseCacheControl: 'private, max-age=300',
      }),
      { expiresIn: this.options.readUrlTtlSeconds },
    );
  }

  public async delete(key: string): Promise<void> {
    await this.ensureReady();
    await this.internalClient.send(
      new DeleteObjectCommand({ Bucket: this.options.bucket, Key: key }),
    );
  }
}

function allowedPhotoUrl(value: string, allowedHosts: readonly string[]): URL {
  const url = new URL(value);
  const hostname = url.hostname.toLowerCase();
  const allowed = allowedHosts.some((entry) => {
    const candidate = entry.trim().toLowerCase();
    return candidate.startsWith('.')
      ? hostname.endsWith(candidate) && hostname.length > candidate.length
      : hostname === candidate;
  });
  if (url.protocol !== 'https:' || !allowed || url.username || url.password) {
    throw new Error('PROFILE_PHOTO_SOURCE_NOT_ALLOWED');
  }
  return url;
}

async function readBoundedBody(response: Response, maxBytes: number): Promise<Buffer> {
  const announcedLength = Number(response.headers.get('content-length') ?? '0');
  if (Number.isFinite(announcedLength) && announcedLength > maxBytes) {
    throw new Error('PROFILE_PHOTO_TOO_LARGE');
  }
  if (!response.body) throw new Error('PROFILE_PHOTO_BODY_MISSING');
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > maxBytes) throw new Error('PROFILE_PHOTO_TOO_LARGE');
      chunks.push(Buffer.from(chunk.value));
    }
  } finally {
    reader.releaseLock();
  }
  if (total === 0) throw new Error('PROFILE_PHOTO_BODY_MISSING');
  return Buffer.concat(chunks, total);
}

async function fetchSourcePhoto(input: {
  readonly sourceUrl: string;
  readonly current: ProfilePhotoSyncRecord;
  readonly allowedHosts: readonly string[];
  readonly maxBytes: number;
  readonly timeoutMs: number;
  readonly fetchImplementation: typeof fetch;
}): Promise<
  | { readonly outcome: 'unchanged' }
  | {
      readonly outcome: 'downloaded';
      readonly body: Buffer;
      readonly etag?: string;
      readonly lastModified?: string;
    }
> {
  let url = allowedPhotoUrl(input.sourceUrl, input.allowedHosts);
  const headers = new Headers({
    Accept: 'image/avif,image/webp,image/png,image/jpeg',
    'User-Agent': PROFILE_PHOTO_FETCH_USER_AGENT,
  });
  if (input.current.sourceUrl === input.sourceUrl && input.current.objectKey) {
    if (input.current.sourceEtag) headers.set('If-None-Match', input.current.sourceEtag);
    if (input.current.sourceLastModified) {
      headers.set('If-Modified-Since', input.current.sourceLastModified);
    }
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs);
  try {
    for (let redirects = 0; redirects <= 2; redirects += 1) {
      const response = await input.fetchImplementation(url, {
        method: 'GET',
        redirect: 'manual',
        headers,
        signal: controller.signal,
      });
      if (response.status === 304 && input.current.objectKey && input.current.contentSha256) {
        return { outcome: 'unchanged' };
      }
      if (REDIRECT_STATUSES.has(response.status)) {
        const location = response.headers.get('location');
        if (!location || redirects === 2) throw new Error('PROFILE_PHOTO_REDIRECT_INVALID');
        url = allowedPhotoUrl(new URL(location, url).toString(), input.allowedHosts);
        continue;
      }
      if (!response.ok) throw new Error(`PROFILE_PHOTO_SOURCE_HTTP_${response.status}`);
      if (!IMAGE_CONTENT_TYPE.test(response.headers.get('content-type') ?? '')) {
        throw new Error('PROFILE_PHOTO_CONTENT_TYPE_INVALID');
      }
      const etag = response.headers.get('etag');
      const lastModified = response.headers.get('last-modified');
      return {
        outcome: 'downloaded',
        body: await readBoundedBody(response, input.maxBytes),
        ...(etag ? { etag } : {}),
        ...(lastModified ? { lastModified } : {}),
      };
    }
    throw new Error('PROFILE_PHOTO_REDIRECT_INVALID');
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('PROFILE_PHOTO_SOURCE_TIMEOUT', { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function errorCode(error: unknown): string {
  if (error instanceof Error && /^PROFILE_PHOTO_[A-Z0-9_]+$/.test(error.message)) {
    return error.message;
  }
  return 'PROFILE_PHOTO_SYNC_FAILED';
}

function persistenceFromCurrent(
  current: ProfilePhotoSyncRecord,
  avatarUrl: string | undefined,
  fallbackTime: string,
): ProfilePhotoPersistence {
  return {
    avatarUrl: avatarUrl ?? null,
    ...(current.sourceUrl ? { sourceUrl: current.sourceUrl } : {}),
    ...(current.sourceEtag ? { sourceEtag: current.sourceEtag } : {}),
    ...(current.sourceLastModified ? { sourceLastModified: current.sourceLastModified } : {}),
    ...(current.contentSha256 ? { contentSha256: current.contentSha256 } : {}),
    ...(current.objectKey ? { objectKey: current.objectKey } : {}),
    syncedAt: current.syncedAt ?? fallbackTime,
  };
}

function deletionFields(
  objectKey: string | undefined,
  fetchedAt: string,
  retentionSeconds: number,
): Pick<ProfilePhotoPersistence, 'supersededObjectKey' | 'deleteAfter'> {
  if (!objectKey) return {};
  return {
    supersededObjectKey: objectKey,
    deleteAfter: new Date(Date.parse(fetchedAt) + retentionSeconds * 1_000).toISOString(),
  };
}

export async function synchronizeVivaProfilePhoto(input: {
  readonly pool: Pool;
  readonly store: ProfilePhotoObjectStore;
  readonly tenantId: string;
  readonly userId: string;
  readonly sourceUrl?: string;
  readonly fetchedAt: string;
  readonly allowedHosts: readonly string[];
  readonly maxBytes: number;
  readonly maxDimension: number;
  readonly webpQuality: number;
  readonly previousObjectRetentionSeconds: number;
  readonly timeoutMs: number;
  readonly fetchImplementation?: typeof fetch;
}): Promise<ProfilePhotoSyncResult> {
  const current = await loadProfilePhotoSyncRecord({
    pool: input.pool,
    tenantId: input.tenantId,
    userId: input.userId,
  });
  if (!input.sourceUrl) {
    return {
      outcome: 'removed',
      persistence: {
        avatarUrl: null,
        syncedAt: input.fetchedAt,
        ...deletionFields(current.objectKey, input.fetchedAt, input.previousObjectRetentionSeconds),
      },
    };
  }

  try {
    const source = await fetchSourcePhoto({
      sourceUrl: input.sourceUrl,
      current,
      allowedHosts: input.allowedHosts,
      maxBytes: input.maxBytes,
      timeoutMs: input.timeoutMs,
      fetchImplementation: input.fetchImplementation ?? fetch,
    });
    if (source.outcome === 'unchanged' && current.objectKey && current.contentSha256) {
      const avatarUrl = await input.store.createReadUrl(current.objectKey);
      return {
        outcome: 'unchanged',
        persistence: {
          ...persistenceFromCurrent(current, avatarUrl, input.fetchedAt),
          syncedAt: input.fetchedAt,
        },
      };
    }

    if (source.outcome !== 'downloaded') throw new Error('PROFILE_PHOTO_SYNC_FAILED');
    const webp = await sharp(source.body, { failOn: 'error', limitInputPixels: 40_000_000 })
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
    const objectKey = `profile-photos/${input.tenantId}/${input.userId}/${contentSha256}.webp`;
    if (current.contentSha256 !== contentSha256 || current.objectKey !== objectKey) {
      await input.store.put({ key: objectKey, body: webp, sha256: contentSha256 });
    }
    const avatarUrl = await input.store.createReadUrl(objectKey);
    return {
      outcome:
        current.contentSha256 === contentSha256 && current.objectKey === objectKey
          ? 'unchanged'
          : 'stored',
      persistence: {
        avatarUrl,
        sourceUrl: input.sourceUrl,
        ...(source.etag ? { sourceEtag: source.etag } : {}),
        ...(source.lastModified ? { sourceLastModified: source.lastModified } : {}),
        contentSha256,
        objectKey,
        syncedAt: input.fetchedAt,
        ...(current.objectKey && current.objectKey !== objectKey
          ? deletionFields(current.objectKey, input.fetchedAt, input.previousObjectRetentionSeconds)
          : {}),
      },
    };
  } catch (error) {
    let avatarUrl = current.avatarUrl;
    if (current.objectKey) {
      avatarUrl = await input.store.createReadUrl(current.objectKey).catch(() => avatarUrl);
    }
    return {
      outcome: 'fallback',
      persistence: persistenceFromCurrent(current, avatarUrl, input.fetchedAt),
      errorCode: errorCode(error),
    };
  }
}
