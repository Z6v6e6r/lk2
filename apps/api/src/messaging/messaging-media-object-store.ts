import {
  CreateBucketCommand,
  GetBucketVersioningCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutBucketVersioningCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { NodeHttpHandler } from '@smithy/node-http-handler';

export interface MessagingMediaUploadGrant {
  readonly url: string;
  readonly method: 'PUT';
  readonly requiredHeaders: Readonly<Record<string, string>>;
  readonly expiresAt: string;
}

export interface MessagingMediaUploadedObject {
  readonly byteSize: number;
  readonly contentType: string;
  readonly etag: string;
  readonly versionId: string;
  readonly checksumSha256: string | null;
}

export interface MessagingMediaDelivery {
  readonly objectKey: string;
  readonly objectVersion: string;
  readonly fileName: string;
  readonly contentType: string;
  readonly inline: boolean;
}

export interface MessagingMediaObjectStore {
  checkReady(): Promise<void>;
  createUploadGrant(input: {
    readonly objectKey: string;
    readonly contentType: string;
    readonly byteSize: number;
    readonly sha256: string;
    readonly mediaId: string;
    readonly expiresAt: string;
  }): Promise<MessagingMediaUploadGrant>;
  inspectCurrentVersion(objectKey: string): Promise<MessagingMediaUploadedObject | undefined>;
  /** Writes the quarantine source once. The caller owns neither its key nor storage headers. */
  putSourceObject(input: {
    readonly objectKey: string;
    readonly contentType: string;
    readonly body: Buffer;
    readonly sha256: string;
    readonly mediaId: string;
  }): Promise<MessagingMediaUploadedObject>;
  /** Reads one exact READY version for an authenticated API relay. */
  readDelivery(input: {
    readonly delivery: MessagingMediaDelivery;
    readonly maxBytes: number;
  }): Promise<Buffer>;
  createDeliveryUrl(input: {
    readonly delivery: MessagingMediaDelivery;
    readonly expiresInSeconds: number;
  }): Promise<string>;
}

export interface S3MessagingMediaObjectStoreOptions {
  readonly endpoint: string;
  readonly publicEndpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly accessKey: string;
  readonly secretKey: string;
  readonly forcePathStyle: boolean;
  readonly autoCreateBucket: boolean;
  readonly maxBytes: number;
}

function httpStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const metadata = '$metadata' in error ? error.$metadata : undefined;
  if (!metadata || typeof metadata !== 'object') return undefined;
  const value = 'httpStatusCode' in metadata ? metadata.httpStatusCode : undefined;
  return typeof value === 'number' ? value : undefined;
}

function requiredText(value: string | undefined, code: string): string {
  if (!value) throw new Error(code);
  return value;
}

function checksumBase64(sha256: string): string {
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error('MESSAGING_MEDIA_SHA256_INVALID');
  return Buffer.from(sha256, 'hex').toString('base64');
}

function checksumHex(
  value: string | undefined,
  signedMetadataValue: string | undefined,
): string | null {
  if (value) {
    const bytes = Buffer.from(value, 'base64');
    if (bytes.byteLength !== 32) throw new Error('MESSAGING_MEDIA_OBJECT_CHECKSUM_INVALID');
    return bytes.toString('hex');
  }
  if (signedMetadataValue && /^[0-9a-f]{64}$/.test(signedMetadataValue)) {
    return signedMetadataValue;
  }
  return null;
}

type BoundedObjectBody = AsyncIterable<Uint8Array> & {
  readonly destroy?: (error?: Error) => void;
  readonly cancel?: (reason?: unknown) => Promise<void>;
};

export async function readBoundedObjectBody(
  body: BoundedObjectBody,
  declaredBytes: number | undefined,
  maxBytes: number,
): Promise<Buffer> {
  if (
    declaredBytes === undefined ||
    !Number.isSafeInteger(declaredBytes) ||
    declaredBytes < 1 ||
    declaredBytes > maxBytes
  ) {
    throw new Error('MESSAGING_MEDIA_OBJECT_SIZE_INVALID');
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of body) {
    total += chunk.byteLength;
    if (total > maxBytes) {
      const error = new Error('MESSAGING_MEDIA_OBJECT_TOO_LARGE');
      body.destroy?.(error);
      void body.cancel?.(error);
      throw error;
    }
    chunks.push(Buffer.from(chunk));
  }
  // The declared length rejects malformed streams before allocation, while the running total
  // rejects a lying/chunked response before an unbounded body can reach Buffer.concat.
  if (total < 1 || total !== declaredBytes) throw new Error('MESSAGING_MEDIA_OBJECT_SIZE_INVALID');
  return Buffer.concat(chunks, total);
}

/** Strips control characters and quotes that could break out of the header value. */
function headerSafeName(fileName: string): string {
  return [...fileName]
    .map((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 0x20 || code === 0x7f || character === '"' || character === '\\'
        ? '_'
        : character;
    })
    .join('');
}

/** RFC 6266 keeps a non-ASCII file name intact for the browser download prompt. */
export function contentDispositionHeader(fileName: string, inline: boolean): string {
  const safe = headerSafeName(fileName);
  const ascii = [...safe]
    .map((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code >= 0x20 && code <= 0x7e ? character : '_';
    })
    .join('');
  return `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(safe)}`;
}

/**
 * Chat media storage. Community media and chat media are the two real consumers of this contour;
 * chat keeps the uploaded bytes untouched (no derived variants), so a delivery URL pins the exact
 * ready version and only the disposition differs between an image and a file.
 */
export class S3MessagingMediaObjectStore implements MessagingMediaObjectStore {
  private readonly internalClient: S3Client;
  private readonly deliveryClient: S3Client;
  private ready: Promise<void> | undefined;

  public constructor(private readonly options: S3MessagingMediaObjectStoreOptions) {
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

  private async probeReady(): Promise<void> {
    try {
      await this.internalClient.send(new HeadBucketCommand({ Bucket: this.options.bucket }));
    } catch (error) {
      if (httpStatus(error) !== 404 || !this.options.autoCreateBucket) throw error;
      try {
        await this.internalClient.send(new CreateBucketCommand({ Bucket: this.options.bucket }));
      } catch (createError) {
        if (httpStatus(createError) !== 409) throw createError;
      }
    }
    let versioning = await this.internalClient.send(
      new GetBucketVersioningCommand({ Bucket: this.options.bucket }),
    );
    if (versioning.Status !== 'Enabled' && this.options.autoCreateBucket) {
      await this.internalClient.send(
        new PutBucketVersioningCommand({
          Bucket: this.options.bucket,
          VersioningConfiguration: { Status: 'Enabled' },
        }),
      );
      versioning = await this.internalClient.send(
        new GetBucketVersioningCommand({ Bucket: this.options.bucket }),
      );
    }
    if (versioning.Status !== 'Enabled') {
      throw new Error('MESSAGING_MEDIA_BUCKET_VERSIONING_REQUIRED');
    }
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

  public async createUploadGrant(input: {
    readonly objectKey: string;
    readonly contentType: string;
    readonly byteSize: number;
    readonly sha256: string;
    readonly mediaId: string;
    readonly expiresAt: string;
  }): Promise<MessagingMediaUploadGrant> {
    await this.ensureReady();
    if (
      !Number.isSafeInteger(input.byteSize) ||
      input.byteSize < 1 ||
      input.byteSize > this.options.maxBytes
    ) {
      throw new Error('MESSAGING_MEDIA_OBJECT_SIZE_INVALID');
    }
    const remainingSeconds = Math.floor((Date.parse(input.expiresAt) - Date.now()) / 1_000);
    if (!Number.isFinite(remainingSeconds) || remainingSeconds < 1) {
      throw new Error('MESSAGING_MEDIA_UPLOAD_GRANT_EXPIRED');
    }
    const url = await getSignedUrl(
      this.deliveryClient,
      new PutObjectCommand({
        Bucket: this.options.bucket,
        Key: input.objectKey,
        ContentType: input.contentType,
        ContentLength: input.byteSize,
        CacheControl: 'private, no-store',
        IfNoneMatch: '*',
        Metadata: {
          'padlhub-media-id': input.mediaId,
          'padlhub-sha256': input.sha256,
        },
        ChecksumSHA256: checksumBase64(input.sha256),
      }),
      { expiresIn: Math.min(900, remainingSeconds) },
    );
    return {
      url,
      method: 'PUT',
      requiredHeaders: {
        'Content-Type': input.contentType,
        'Cache-Control': 'private, no-store',
        'If-None-Match': '*',
      },
      expiresAt: input.expiresAt,
    };
  }

  public async inspectCurrentVersion(
    objectKey: string,
  ): Promise<MessagingMediaUploadedObject | undefined> {
    await this.ensureReady();
    try {
      const result = await this.internalClient.send(
        new HeadObjectCommand({
          Bucket: this.options.bucket,
          Key: objectKey,
          ChecksumMode: 'ENABLED',
        }),
      );
      const byteSize = result.ContentLength;
      if (!Number.isSafeInteger(byteSize) || !byteSize || byteSize < 1) {
        throw new Error('MESSAGING_MEDIA_OBJECT_SIZE_INVALID');
      }
      if (byteSize > this.options.maxBytes) {
        throw new Error('MESSAGING_MEDIA_OBJECT_SIZE_INVALID');
      }
      return {
        byteSize,
        contentType: requiredText(
          result.ContentType,
          'MESSAGING_MEDIA_OBJECT_CONTENT_TYPE_MISSING',
        ),
        etag: requiredText(result.ETag, 'MESSAGING_MEDIA_OBJECT_ETAG_MISSING'),
        versionId: requiredText(result.VersionId, 'MESSAGING_MEDIA_OBJECT_VERSION_MISSING'),
        checksumSha256: checksumHex(result.ChecksumSHA256, result.Metadata?.['padlhub-sha256']),
      };
    } catch (error) {
      if (httpStatus(error) === 404) return undefined;
      throw error;
    }
  }

  public async putSourceObject(input: {
    readonly objectKey: string;
    readonly contentType: string;
    readonly body: Buffer;
    readonly sha256: string;
    readonly mediaId: string;
  }): Promise<MessagingMediaUploadedObject> {
    await this.ensureReady();
    if (input.body.byteLength < 1 || input.body.byteLength > this.options.maxBytes) {
      throw new Error('MESSAGING_MEDIA_OBJECT_SIZE_INVALID');
    }
    const result = await this.internalClient.send(
      new PutObjectCommand({
        Bucket: this.options.bucket,
        Key: input.objectKey,
        Body: input.body,
        ContentType: input.contentType,
        ContentLength: input.body.byteLength,
        CacheControl: 'private, no-store',
        IfNoneMatch: '*',
        Metadata: {
          'padlhub-media-id': input.mediaId,
          'padlhub-sha256': input.sha256,
        },
        ChecksumSHA256: checksumBase64(input.sha256),
      }),
    );
    return {
      byteSize: input.body.byteLength,
      contentType: input.contentType,
      etag: requiredText(result.ETag, 'MESSAGING_MEDIA_OBJECT_ETAG_MISSING'),
      versionId: requiredText(result.VersionId, 'MESSAGING_MEDIA_OBJECT_VERSION_MISSING'),
      checksumSha256: input.sha256,
    };
  }

  public async readDelivery(input: {
    readonly delivery: MessagingMediaDelivery;
    readonly maxBytes: number;
  }): Promise<Buffer> {
    await this.ensureReady();
    const result = await this.internalClient.send(
      new GetObjectCommand({
        Bucket: this.options.bucket,
        Key: input.delivery.objectKey,
        VersionId: input.delivery.objectVersion,
      }),
    );
    if (!result.Body) throw new Error('MESSAGING_MEDIA_OBJECT_MISSING');
    return readBoundedObjectBody(
      result.Body as BoundedObjectBody,
      result.ContentLength,
      input.maxBytes,
    );
  }

  public async createDeliveryUrl(input: {
    readonly delivery: MessagingMediaDelivery;
    readonly expiresInSeconds: number;
  }): Promise<string> {
    await this.ensureReady();
    return getSignedUrl(
      this.deliveryClient,
      new GetObjectCommand({
        Bucket: this.options.bucket,
        Key: input.delivery.objectKey,
        VersionId: input.delivery.objectVersion,
        ResponseContentType: input.delivery.contentType,
        ResponseContentDisposition: contentDispositionHeader(
          input.delivery.fileName,
          input.delivery.inline,
        ),
        ResponseCacheControl: 'private, max-age=300',
      }),
      { expiresIn: Math.max(60, Math.min(900, input.expiresInSeconds)) },
    );
  }
}
