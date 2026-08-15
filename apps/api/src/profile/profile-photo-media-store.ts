import { PassThrough, Readable } from 'node:stream';

import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

export interface ProfilePhotoMediaObject {
  readonly body: Readable;
  readonly contentLength?: number;
  readonly etag?: string;
}

export interface ProfilePhotoMediaStore {
  read(key: string): Promise<ProfilePhotoMediaObject>;
  put?(input: {
    readonly key: string;
    readonly body: Buffer;
    readonly sha256: string;
  }): Promise<void>;
}

export class ProfilePhotoMediaNotFoundError extends Error {
  public constructor() {
    super('PROFILE_PHOTO_MEDIA_NOT_FOUND');
  }
}

export interface S3ProfilePhotoMediaStoreOptions {
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly accessKey: string;
  readonly secretKey: string;
  readonly forcePathStyle: boolean;
  readonly timeoutMs: number;
}

function status(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const metadata = '$metadata' in error ? error.$metadata : undefined;
  if (!metadata || typeof metadata !== 'object' || !('httpStatusCode' in metadata)) {
    return undefined;
  }
  return typeof metadata.httpStatusCode === 'number' ? metadata.httpStatusCode : undefined;
}

export class S3ProfilePhotoMediaStore implements ProfilePhotoMediaStore {
  private readonly client: S3Client;

  public constructor(private readonly options: S3ProfilePhotoMediaStoreOptions) {
    this.client = new S3Client({
      endpoint: options.endpoint,
      region: options.region,
      credentials: { accessKeyId: options.accessKey, secretAccessKey: options.secretKey },
      forcePathStyle: options.forcePathStyle,
      maxAttempts: 2,
    });
  }

  public async read(key: string): Promise<ProfilePhotoMediaObject> {
    const controller = new AbortController();
    let activeBody: Readable | undefined;
    const timeout = setTimeout(() => {
      controller.abort();
      activeBody?.destroy(new Error('PROFILE_PHOTO_MEDIA_TIMEOUT'));
    }, this.options.timeoutMs);
    try {
      const result = await this.client.send(
        new GetObjectCommand({ Bucket: this.options.bucket, Key: key }),
        { abortSignal: controller.signal },
      );
      if (!result.Body || !(result.Body instanceof Readable)) {
        throw new Error('PROFILE_PHOTO_MEDIA_BODY_INVALID');
      }
      const source = result.Body;
      activeBody = source;
      const boundedBody = new PassThrough();
      const stopTimeout = (): void => clearTimeout(timeout);
      source.once('error', (error: unknown) =>
        boundedBody.destroy(
          error instanceof Error ? error : new Error('PROFILE_PHOTO_MEDIA_STREAM_FAILED'),
        ),
      );
      boundedBody.once('close', () => {
        stopTimeout();
        if (!source.destroyed) source.destroy();
      });
      source.pipe(boundedBody);
      return {
        body: boundedBody,
        ...(result.ContentLength !== undefined ? { contentLength: result.ContentLength } : {}),
        ...(result.ETag ? { etag: result.ETag } : {}),
      };
    } catch (error) {
      clearTimeout(timeout);
      if (status(error) === 404) throw new ProfilePhotoMediaNotFoundError();
      throw error;
    }
  }

  public async put(input: {
    readonly key: string;
    readonly body: Buffer;
    readonly sha256: string;
  }): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs);
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.options.bucket,
          Key: input.key,
          Body: input.body,
          ContentType: 'image/webp',
          CacheControl: 'private, max-age=31536000, immutable',
          Metadata: { sha256: input.sha256 },
        }),
        { abortSignal: controller.signal },
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}
