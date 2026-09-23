/**
 * Photo support for the station-support bridge.
 *
 * Two different sources feed this module: a picture the CUP operator sent (delivered by the provider
 * as a base64 data URL or as a bounded HTTPS link) and a picture the LK2 viewer picked in the chat
 * composer. Both are normalized to one bounded WebP object in the shared PadlHub media bucket under
 * a content-addressed key scoped to the tenant and to the PadlHub user who owns the bytes, so the
 * legacy provider URL never reaches the browser and the same bucket serves every chat contour.
 */

import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { createHash } from 'node:crypto';
import sharp from 'sharp';

/**
 * The CUP workspace refuses a dialog photo whose inline data URL exceeds 4 MiB, which is the only
 * payload size this contour has been observed to carry. One stored WebP is therefore capped so that
 * its data URL (the 23-character prefix plus base64) still fits that budget.
 */
export const STATION_SUPPORT_MEDIA_INLINE_URL_BUDGET_BYTES = 4 * 1024 * 1024;
export const STATION_SUPPORT_MEDIA_DATA_URL_PREFIX_BYTES = 'data:image/webp;base64,'.length;
export const STATION_SUPPORT_MEDIA_MAX_BYTES = Math.floor(
  ((STATION_SUPPORT_MEDIA_INLINE_URL_BUDGET_BYTES - STATION_SUPPORT_MEDIA_DATA_URL_PREFIX_BYTES) *
    3) /
    4,
);
/** An upload or a provider image is accepted up to this size and is then re-encoded smaller. */
export const STATION_SUPPORT_MEDIA_SOURCE_MAX_BYTES = 8 * 1024 * 1024;
export const STATION_SUPPORT_MEDIA_MAX_DIMENSION = 1_600;
export const STATION_SUPPORT_MEDIA_WEBP_QUALITY = 82;
export const STATION_SUPPORT_MEDIA_MAX_ATTACHMENTS = 4;
export const STATION_SUPPORT_MEDIA_URL_TTL_SECONDS = 300;

const OBJECT_PREFIX = 'station-support';
const DATA_URL_PATTERN =
  /^data:image\/(?:png|jpe?g|webp|gif|avif|heic|heif);base64,([a-z0-9+/=\s]+)$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ATTACHMENT_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export interface StationSupportStoredObject {
  readonly byteSize: number;
  readonly fileName: string | null;
}

export interface StationSupportMediaStore {
  putWebp(input: {
    readonly objectKey: string;
    readonly body: Buffer;
    readonly sha256: string;
    readonly fileName: string | null;
  }): Promise<void>;
  stat(objectKey: string): Promise<StationSupportStoredObject | undefined>;
  read(objectKey: string, maxBytes: number): Promise<Buffer>;
  createDeliveryUrl(input: {
    readonly objectKey: string;
    readonly contentType: string;
    readonly expiresInSeconds: number;
  }): Promise<string>;
}

export interface S3StationSupportMediaStoreOptions {
  readonly endpoint: string;
  readonly publicEndpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly accessKey: string;
  readonly secretKey: string;
  readonly forcePathStyle: boolean;
  readonly maxBytes: number;
}

function httpStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const metadata = '$metadata' in error ? error.$metadata : undefined;
  if (!metadata || typeof metadata !== 'object') return undefined;
  const value = 'httpStatusCode' in metadata ? metadata.httpStatusCode : undefined;
  return typeof value === 'number' ? value : undefined;
}

/**
 * Object metadata travels as an HTTP header, so the original file name is stored base64url-encoded:
 * it is display data for the operator inbox only and is never part of the object key.
 */
function encodeFileName(fileName: string): string {
  return Buffer.from(fileName.slice(0, 200), 'utf8').toString('base64url');
}

function decodeFileName(value: string | undefined): string | null {
  const normalized = (value ?? '').trim();
  if (!normalized || !/^[A-Za-z0-9_-]{1,400}$/.test(normalized)) return null;
  const decoded = Buffer.from(normalized, 'base64url').toString('utf8').trim();
  return decoded.length > 0 ? decoded.slice(0, 200) : null;
}

/**
 * The tenant and the owning user are part of the key, and the key is always rebuilt from the
 * caller's own verified identity: a viewer can never address another viewer's chat photo, even by
 * knowing the content hash.
 */
export function stationSupportMediaObjectKey(
  tenantId: string,
  userId: string,
  sha256: string,
): string {
  if (!UUID_PATTERN.test(tenantId) || !UUID_PATTERN.test(userId)) {
    throw new Error('STATION_SUPPORT_MEDIA_OWNER_INVALID');
  }
  if (!SHA256_PATTERN.test(sha256)) throw new Error('STATION_SUPPORT_MEDIA_SHA256_INVALID');
  return `${OBJECT_PREFIX}/${tenantId}/${userId}/${sha256}.webp`;
}

/** The public attachment id is the opaque content digest; the object key stays server-side. */
export function stationSupportAttachmentId(sha256: string): string {
  if (!SHA256_PATTERN.test(sha256)) throw new Error('STATION_SUPPORT_MEDIA_SHA256_INVALID');
  return Buffer.from(sha256, 'hex').toString('base64url');
}

export function stationSupportAttachmentSha256(attachmentId: string): string | null {
  if (!ATTACHMENT_ID_PATTERN.test(attachmentId)) return null;
  const bytes = Buffer.from(attachmentId, 'base64url');
  if (bytes.byteLength !== 32 || bytes.toString('base64url') !== attachmentId) return null;
  return bytes.toString('hex');
}

export function isStationSupportImageContentType(contentType: string | undefined): boolean {
  const normalized = (contentType ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  return normalized === 'image/jpeg' || normalized === 'image/png' || normalized === 'image/webp';
}

/** A stored chat photo is always re-encoded: the original bytes are never served back. */
export async function convertStationSupportWebp(
  source: Buffer,
): Promise<{ readonly body: Buffer; readonly sha256: string }> {
  const body = await sharp(source, { failOn: 'error', limitInputPixels: 40_000_000 })
    .rotate()
    .resize({
      width: STATION_SUPPORT_MEDIA_MAX_DIMENSION,
      height: STATION_SUPPORT_MEDIA_MAX_DIMENSION,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .webp({ quality: STATION_SUPPORT_MEDIA_WEBP_QUALITY, effort: 4 })
    .toBuffer();
  if (body.byteLength === 0 || body.byteLength > STATION_SUPPORT_MEDIA_MAX_BYTES) {
    throw new Error('STATION_SUPPORT_MEDIA_OUTPUT_TOO_LARGE');
  }
  return { body, sha256: createHash('sha256').update(body).digest('hex') };
}

function decodeDataUrl(url: string, maxBytes: number): Buffer | null {
  const match = DATA_URL_PATTERN.exec(url);
  if (!match) return null;
  // The base64 length bound is checked before decoding so an oversized payload is never expanded.
  const encoded = (match[1] ?? '').replace(/\s+/g, '');
  if (encoded.length > Math.ceil(maxBytes / 3) * 4) {
    throw new Error('STATION_SUPPORT_MEDIA_SOURCE_TOO_LARGE');
  }
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.byteLength === 0 || bytes.byteLength > maxBytes) {
    throw new Error('STATION_SUPPORT_MEDIA_SOURCE_TOO_LARGE');
  }
  return bytes;
}

function hostAllowed(hostname: string, allowedHosts: readonly string[]): boolean {
  const host = hostname.toLocaleLowerCase('en-US');
  return allowedHosts.some((rawAllowed) => {
    const allowed = rawAllowed.trim().toLocaleLowerCase('en-US');
    if (!allowed) return false;
    return allowed.startsWith('.')
      ? host.endsWith(allowed) && host.length > allowed.length
      : host === allowed;
  });
}

/**
 * Only two provider forms are accepted: an inline base64 image (what the CUP workspace sends) and an
 * HTTPS link on a host the deployment declared. Anything else leaves the message without a picture
 * instead of turning the API into an open image fetcher.
 */
export async function readStationSupportProviderImage(
  url: string,
  options: {
    readonly allowedHosts: readonly string[];
    readonly timeoutMs: number;
    readonly maxBytes: number;
    readonly fetchImplementation?: typeof fetch;
  },
): Promise<Buffer> {
  const inline = decodeDataUrl(url, options.maxBytes);
  if (inline) return inline;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('STATION_SUPPORT_MEDIA_SOURCE_INVALID');
  }
  const localHost = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
  if (
    (parsed.protocol !== 'https:' && !(localHost && parsed.protocol === 'http:')) ||
    parsed.username ||
    parsed.password ||
    !hostAllowed(parsed.hostname, options.allowedHosts)
  ) {
    throw new Error('STATION_SUPPORT_MEDIA_SOURCE_NOT_ALLOWED');
  }
  const response = await (options.fetchImplementation ?? fetch)(parsed, {
    headers: { Accept: 'image/avif,image/webp,image/png,image/jpeg,image/*' },
    redirect: 'error',
    signal: AbortSignal.timeout(options.timeoutMs),
  });
  if (!response.ok) throw new Error(`STATION_SUPPORT_MEDIA_SOURCE_HTTP_${response.status}`);
  const contentType = response.headers.get('content-type')?.split(';')[0]?.trim() ?? '';
  if (!contentType.startsWith('image/')) {
    throw new Error('STATION_SUPPORT_MEDIA_SOURCE_CONTENT_TYPE_INVALID');
  }
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > options.maxBytes) {
    throw new Error('STATION_SUPPORT_MEDIA_SOURCE_TOO_LARGE');
  }
  // A declared length is a hint, not a bound: a chunked body is read with a running total so an
  // untruthful provider can never make the API buffer an unbounded image.
  return readBoundedBody(response, options.maxBytes);
}

async function readBoundedBody(response: Response, maxBytes: number): Promise<Buffer> {
  if (!response.body) throw new Error('STATION_SUPPORT_MEDIA_SOURCE_TOO_LARGE');
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel('STATION_SUPPORT_MEDIA_SOURCE_TOO_LARGE');
        throw new Error('STATION_SUPPORT_MEDIA_SOURCE_TOO_LARGE');
      }
      chunks.push(Buffer.from(chunk.value));
    }
  } finally {
    reader.releaseLock();
  }
  if (total === 0) throw new Error('STATION_SUPPORT_MEDIA_SOURCE_TOO_LARGE');
  return Buffer.concat(chunks, total);
}

/**
 * Chat media storage over the shared PadlHub bucket. Objects are content-addressed and immutable, so
 * a repeated materialization of the same provider picture is an idempotent overwrite of equal bytes.
 */
export class S3StationSupportMediaStore implements StationSupportMediaStore {
  private readonly internalClient: S3Client;
  private readonly deliveryClient: S3Client;

  public constructor(private readonly options: S3StationSupportMediaStoreOptions) {
    const shared = {
      region: options.region,
      credentials: { accessKeyId: options.accessKey, secretAccessKey: options.secretKey },
      forcePathStyle: options.forcePathStyle,
      maxAttempts: 2,
      requestHandler: new NodeHttpHandler({ requestTimeout: 10_000, connectionTimeout: 3_000 }),
    };
    this.internalClient = new S3Client({ ...shared, endpoint: options.endpoint });
    this.deliveryClient = new S3Client({ ...shared, endpoint: options.publicEndpoint });
  }

  public async putWebp(input: {
    readonly objectKey: string;
    readonly body: Buffer;
    readonly sha256: string;
    readonly fileName: string | null;
  }): Promise<void> {
    if (input.body.byteLength < 1 || input.body.byteLength > this.options.maxBytes) {
      throw new Error('STATION_SUPPORT_MEDIA_OUTPUT_TOO_LARGE');
    }
    if (!SHA256_PATTERN.test(input.sha256)) throw new Error('STATION_SUPPORT_MEDIA_SHA256_INVALID');
    await this.internalClient.send(
      new PutObjectCommand({
        Bucket: this.options.bucket,
        Key: input.objectKey,
        Body: input.body,
        ContentType: 'image/webp',
        CacheControl: 'private, max-age=300',
        Metadata: {
          'padlhub-sha256': input.sha256,
          ...(input.fileName ? { 'padlhub-file-name': encodeFileName(input.fileName) } : {}),
        },
        ChecksumSHA256: Buffer.from(input.sha256, 'hex').toString('base64'),
      }),
    );
  }

  public async stat(objectKey: string): Promise<StationSupportStoredObject | undefined> {
    try {
      const result = await this.internalClient.send(
        new HeadObjectCommand({ Bucket: this.options.bucket, Key: objectKey }),
      );
      return {
        byteSize: result.ContentLength ?? 0,
        fileName: decodeFileName(result.Metadata?.['padlhub-file-name']),
      };
    } catch (error) {
      if (httpStatus(error) === 404) return undefined;
      throw error;
    }
  }

  public async read(objectKey: string, maxBytes: number): Promise<Buffer> {
    const result = await this.internalClient.send(
      new GetObjectCommand({ Bucket: this.options.bucket, Key: objectKey }),
    );
    if (!result.Body || result.ContentType !== 'image/webp') {
      throw new Error('STATION_SUPPORT_MEDIA_OBJECT_INVALID');
    }
    if ((result.ContentLength ?? 0) > maxBytes) {
      throw new Error('STATION_SUPPORT_MEDIA_OBJECT_TOO_LARGE');
    }
    const body = Buffer.from(await result.Body.transformToByteArray());
    if (body.byteLength < 1 || body.byteLength > maxBytes) {
      throw new Error('STATION_SUPPORT_MEDIA_OBJECT_TOO_LARGE');
    }
    return body;
  }

  public async createDeliveryUrl(input: {
    readonly objectKey: string;
    readonly contentType: string;
    readonly expiresInSeconds: number;
  }): Promise<string> {
    return getSignedUrl(
      this.deliveryClient,
      new GetObjectCommand({
        Bucket: this.options.bucket,
        Key: input.objectKey,
        ResponseContentType: input.contentType,
        ResponseCacheControl: 'private, max-age=300',
      }),
      { expiresIn: Math.max(60, Math.min(900, input.expiresInSeconds)) },
    );
  }
}
