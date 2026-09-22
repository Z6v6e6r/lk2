import { createHash } from 'node:crypto';

import {
  DeleteObjectCommand,
  GetBucketVersioningCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { MESSAGING_MEDIA_IMAGE_CONTENT_TYPES, MESSAGING_MEDIA_MAX_BYTES } from '@phub/database';
import { NodeHttpHandler } from '@smithy/node-http-handler';

/** Source and ready objects carry the same cache directive: private and pinned to one version. */
const MESSAGING_MEDIA_READY_CACHE_CONTROL = 'private, max-age=31536000, immutable';

/**
 * Codes a chat media cycle may treat as permanently invalid source bytes. Anything outside this set
 * is retried with bounded backoff, so a transient S3 or ClamAV outage never rejects an attachment.
 */
const MESSAGING_MEDIA_PERMANENT_SOURCE_FAILURES: ReadonlySet<string> = new Set([
  'MESSAGING_MEDIA_CONTENT_TYPE_MISMATCH',
  'MESSAGING_MEDIA_SOURCE_CHECKSUM_MISMATCH',
  'MESSAGING_MEDIA_SOURCE_SIZE_MISMATCH',
  'MESSAGING_MEDIA_SOURCE_BODY_MISSING',
  'MESSAGING_MEDIA_SOURCE_TOO_LARGE',
]);

export function isPermanentMessagingMediaSourceFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return MESSAGING_MEDIA_PERMANENT_SOURCE_FAILURES.has(error.message);
}

export interface MessagingMediaWorkerSourceObject {
  readonly body: Buffer;
  readonly contentType: string;
}

export interface MessagingMediaWorkerStoredObject {
  readonly objectKey: string;
  readonly versionId: string;
  readonly etag: string;
}

export interface MessagingMediaWorkerObjectStore {
  checkReady(): Promise<void>;
  getExact(input: {
    readonly objectKey: string;
    readonly versionId: string;
    readonly etag: string;
  }): Promise<MessagingMediaWorkerSourceObject>;
  putReady(input: {
    readonly objectKey: string;
    readonly body: Buffer;
    readonly contentType: string;
    readonly sha256: string;
  }): Promise<MessagingMediaWorkerStoredObject>;
  deleteExact(input: { readonly objectKey: string; readonly versionId: string }): Promise<void>;
  currentVersion(objectKey: string): Promise<string | undefined>;
}

export interface S3MessagingMediaWorkerObjectStoreOptions {
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly accessKey: string;
  readonly secretKey: string;
  readonly forcePathStyle: boolean;
}

async function readBoundedBody(body: unknown, maxBytes: number): Promise<Buffer> {
  if (!body || typeof body !== 'object' || !(Symbol.asyncIterator in body)) {
    throw new Error('MESSAGING_MEDIA_SOURCE_BODY_MISSING');
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of body as AsyncIterable<Uint8Array>) {
    size += chunk.byteLength;
    // Fail closed: a version that grew past the accepted limit is never buffered into memory.
    if (size > maxBytes) throw new Error('MESSAGING_MEDIA_SOURCE_TOO_LARGE');
    chunks.push(Buffer.from(chunk));
  }
  if (size === 0) throw new Error('MESSAGING_MEDIA_SOURCE_BODY_MISSING');
  return Buffer.concat(chunks, size);
}

function requiredText(value: string | undefined, code: string): string {
  if (!value) throw new Error(code);
  return value;
}

function httpStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const metadata = '$metadata' in error ? error.$metadata : undefined;
  if (!metadata || typeof metadata !== 'object') return undefined;
  const value = 'httpStatusCode' in metadata ? metadata.httpStatusCode : undefined;
  return typeof value === 'number' ? value : undefined;
}

export class S3MessagingMediaWorkerObjectStore implements MessagingMediaWorkerObjectStore {
  private readonly client: S3Client;
  private ready: Promise<void> | undefined;

  public constructor(private readonly options: S3MessagingMediaWorkerObjectStoreOptions) {
    this.client = new S3Client({
      region: options.region,
      endpoint: options.endpoint,
      credentials: { accessKeyId: options.accessKey, secretAccessKey: options.secretKey },
      forcePathStyle: options.forcePathStyle,
      maxAttempts: 2,
      requestHandler: new NodeHttpHandler({ requestTimeout: 15_000, connectionTimeout: 3_000 }),
    });
  }

  private probeReady(): Promise<void> {
    return this.client
      .send(new GetBucketVersioningCommand({ Bucket: this.options.bucket }))
      .then((result) => {
        if (result.Status !== 'Enabled') {
          throw new Error('MESSAGING_MEDIA_BUCKET_VERSIONING_REQUIRED');
        }
      });
  }

  private ensureReady(): Promise<void> {
    if (this.ready) return this.ready;
    const attempt = this.probeReady();
    this.ready = attempt;
    void attempt.catch(() => {
      if (this.ready === attempt) this.ready = undefined;
    });
    return attempt;
  }

  public checkReady(): Promise<void> {
    return this.probeReady();
  }

  public async getExact(input: {
    readonly objectKey: string;
    readonly versionId: string;
    readonly etag: string;
  }): Promise<MessagingMediaWorkerSourceObject> {
    await this.ensureReady();
    const result = await this.client.send(
      new GetObjectCommand({
        Bucket: this.options.bucket,
        Key: input.objectKey,
        VersionId: input.versionId,
        IfMatch: input.etag,
      }),
    );
    return {
      body: await readBoundedBody(result.Body, MESSAGING_MEDIA_MAX_BYTES),
      contentType: requiredText(result.ContentType, 'MESSAGING_MEDIA_SOURCE_CONTENT_TYPE_MISSING'),
    };
  }

  public async putReady(input: {
    readonly objectKey: string;
    readonly body: Buffer;
    readonly contentType: string;
    readonly sha256: string;
  }): Promise<MessagingMediaWorkerStoredObject> {
    await this.ensureReady();
    let versionId: string | undefined;
    let etag: string | undefined;
    try {
      const stored = await this.client.send(
        new PutObjectCommand({
          Bucket: this.options.bucket,
          Key: input.objectKey,
          Body: input.body,
          ContentType: input.contentType,
          CacheControl: MESSAGING_MEDIA_READY_CACHE_CONTROL,
          IfNoneMatch: '*',
          Metadata: { sha256: input.sha256 },
        }),
      );
      versionId = stored.VersionId;
      etag = stored.ETag;
    } catch (error) {
      if (httpStatus(error) !== 412) throw error;
      // The ready key is deterministic, so 412 means an earlier identical cycle already stored this
      // exact object. Anything else under that key is a collision and must never be adopted.
      const existing = await this.client.send(
        new HeadObjectCommand({ Bucket: this.options.bucket, Key: input.objectKey }),
      );
      if (
        existing.ContentType !== input.contentType ||
        existing.ContentLength !== input.body.byteLength ||
        existing.Metadata?.sha256 !== input.sha256
      ) {
        throw new Error('MESSAGING_MEDIA_READY_KEY_COLLISION', { cause: error });
      }
      versionId = existing.VersionId;
      etag = existing.ETag;
    }
    if (!versionId) throw new Error('MESSAGING_MEDIA_READY_VERSION_MISSING');
    if (!etag) throw new Error('MESSAGING_MEDIA_READY_ETAG_MISSING');
    return { objectKey: input.objectKey, versionId, etag };
  }

  public async deleteExact(input: {
    readonly objectKey: string;
    readonly versionId: string;
  }): Promise<void> {
    await this.ensureReady();
    await this.client.send(
      new DeleteObjectCommand({
        Bucket: this.options.bucket,
        Key: input.objectKey,
        VersionId: input.versionId,
      }),
    );
  }

  public async currentVersion(objectKey: string): Promise<string | undefined> {
    await this.ensureReady();
    try {
      const result = await this.client.send(
        new HeadObjectCommand({ Bucket: this.options.bucket, Key: objectKey }),
      );
      return requiredText(result.VersionId, 'MESSAGING_MEDIA_SOURCE_VERSION_MISSING');
    } catch (error) {
      if (httpStatus(error) === 404) return undefined;
      throw error;
    }
  }
}

function sha256Hex(body: Buffer): string {
  return createHash('sha256').update(body).digest('hex');
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function startsWith(body: Buffer, prefix: Buffer, offset = 0): boolean {
  if (body.byteLength < offset + prefix.byteLength) return false;
  return body.subarray(offset, offset + prefix.byteLength).equals(prefix);
}

function isJpeg(body: Buffer): boolean {
  return (
    body.byteLength >= 3 &&
    body[0] === 0xff &&
    body[1] === 0xd8 &&
    // The third marker byte always completes a `0xFFxx` marker prefix.
    body[2] === 0xff
  );
}

function isPng(body: Buffer): boolean {
  return startsWith(body, PNG_MAGIC);
}

/**
 * RIFF container check: `RIFF`, a 4-byte little-endian chunk size and the `WEBP` fourcc. An
 * animated or extended WebP keeps the same container signature.
 */
function isWebp(body: Buffer): boolean {
  return startsWith(body, Buffer.from('RIFF', 'ascii')) && startsWith(body, Buffer.from('WEBP'), 8);
}

function detectedImageContentType(body: Buffer): string | undefined {
  if (isJpeg(body)) return 'image/jpeg';
  if (isPng(body)) return 'image/png';
  if (isWebp(body)) return 'image/webp';
  return undefined;
}

/**
 * Validates the exact quarantined source version before it is scanned or promoted. The declared
 * metadata is the upload contract, so a body that does not match it, or an image whose magic bytes
 * disagree with the declared image content type, is rejected without ever reaching READY. Only the
 * three accepted image content types are sniffed; a file attachment may legitimately be any bytes.
 */
export function inspectMessagingMediaSource(input: {
  readonly body: Buffer;
  readonly declaredContentType: string;
  readonly declaredByteSize: number;
  readonly expectedSha256: string;
}): string {
  if (input.body.byteLength < 1 || input.body.byteLength > MESSAGING_MEDIA_MAX_BYTES) {
    throw new Error('MESSAGING_MEDIA_SOURCE_SIZE_MISMATCH');
  }
  const sha256 = sha256Hex(input.body);
  if (sha256 !== input.expectedSha256.toLowerCase()) {
    throw new Error('MESSAGING_MEDIA_SOURCE_CHECKSUM_MISMATCH');
  }
  if (
    (MESSAGING_MEDIA_IMAGE_CONTENT_TYPES as readonly string[]).includes(input.declaredContentType)
  ) {
    const detected = detectedImageContentType(input.body);
    if (detected !== input.declaredContentType) {
      throw new Error('MESSAGING_MEDIA_CONTENT_TYPE_MISMATCH');
    }
  }
  if (input.body.byteLength !== input.declaredByteSize) {
    throw new Error('MESSAGING_MEDIA_SOURCE_SIZE_MISMATCH');
  }
  return sha256;
}
