import {
  CreateBucketCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export interface LocationMediaStore {
  putPreparedImage(input: {
    readonly key: string;
    readonly body: Buffer;
    readonly sha256: string;
  }): Promise<void>;
  createReadUrl(key: string): Promise<string>;
}

export interface S3LocationMediaStoreOptions {
  readonly endpoint: string;
  readonly publicEndpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly accessKey: string;
  readonly secretKey: string;
  readonly forcePathStyle: boolean;
  readonly autoCreateBucket: boolean;
  readonly readUrlTtlSeconds: number;
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

export class S3LocationMediaStore implements LocationMediaStore {
  private readonly internalClient: S3Client;
  private readonly deliveryClient: S3Client;
  private ready: Promise<void> | undefined;

  public constructor(private readonly options: S3LocationMediaStoreOptions) {
    const shared = {
      region: options.region,
      credentials: { accessKeyId: options.accessKey, secretAccessKey: options.secretKey },
      forcePathStyle: options.forcePathStyle,
      maxAttempts: 2,
    };
    this.internalClient = new S3Client({ ...shared, endpoint: options.endpoint });
    this.deliveryClient = new S3Client({ ...shared, endpoint: options.publicEndpoint });
  }

  private async sendWithTimeout<TResult>(operation: (signal: AbortSignal) => Promise<TResult>) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs);
    try {
      return await operation(controller.signal);
    } finally {
      clearTimeout(timeout);
    }
  }

  private ensureReady(): Promise<void> {
    this.ready ??= (async () => {
      try {
        await this.sendWithTimeout((abortSignal) =>
          this.internalClient.send(new HeadBucketCommand({ Bucket: this.options.bucket }), {
            abortSignal,
          }),
        );
      } catch (error) {
        if (status(error) !== 404 || !this.options.autoCreateBucket) throw error;
        try {
          await this.sendWithTimeout((abortSignal) =>
            this.internalClient.send(new CreateBucketCommand({ Bucket: this.options.bucket }), {
              abortSignal,
            }),
          );
        } catch (createError) {
          if (status(createError) !== 409) throw createError;
        }
      }
    })();
    return this.ready;
  }

  public async putPreparedImage(input: {
    readonly key: string;
    readonly body: Buffer;
    readonly sha256: string;
  }): Promise<void> {
    await this.ensureReady();
    await this.sendWithTimeout((abortSignal) =>
      this.internalClient.send(
        new PutObjectCommand({
          Bucket: this.options.bucket,
          Key: input.key,
          Body: input.body,
          ContentType: 'image/webp',
          CacheControl: 'public, max-age=31536000, immutable',
          Metadata: { sha256: input.sha256 },
        }),
        { abortSignal },
      ),
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
        ResponseCacheControl: 'public, max-age=300',
      }),
      { expiresIn: this.options.readUrlTtlSeconds },
    );
  }
}
