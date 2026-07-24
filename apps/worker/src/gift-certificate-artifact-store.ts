import {
  CreateBucketCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

export interface GiftCertificateArtifactStore {
  putPdf(input: {
    readonly key: string;
    readonly body: Buffer;
    readonly sha256: string;
    readonly certificateNumber: string;
  }): Promise<void>;
  readPrivateObject(key: string, maxBytes: number): Promise<Buffer>;
}

export interface S3GiftCertificateArtifactStoreOptions {
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly accessKey: string;
  readonly secretKey: string;
  readonly forcePathStyle: boolean;
  readonly autoCreateBucket: boolean;
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

export class S3GiftCertificateArtifactStore implements GiftCertificateArtifactStore {
  private readonly client: S3Client;
  private ready: Promise<void> | undefined;

  public constructor(private readonly options: S3GiftCertificateArtifactStoreOptions) {
    this.client = new S3Client({
      endpoint: options.endpoint,
      region: options.region,
      credentials: { accessKeyId: options.accessKey, secretAccessKey: options.secretKey },
      forcePathStyle: options.forcePathStyle,
      maxAttempts: 2,
    });
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
          this.client.send(new HeadBucketCommand({ Bucket: this.options.bucket }), { abortSignal }),
        );
      } catch (error) {
        if (status(error) !== 404 || !this.options.autoCreateBucket) throw error;
        try {
          await this.sendWithTimeout((abortSignal) =>
            this.client.send(new CreateBucketCommand({ Bucket: this.options.bucket }), {
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

  public async putPdf(input: {
    readonly key: string;
    readonly body: Buffer;
    readonly sha256: string;
    readonly certificateNumber: string;
  }): Promise<void> {
    await this.ensureReady();
    await this.sendWithTimeout((abortSignal) =>
      this.client.send(
        new PutObjectCommand({
          Bucket: this.options.bucket,
          Key: input.key,
          Body: input.body,
          ContentType: 'application/pdf',
          ContentDisposition: `attachment; filename="${input.certificateNumber}.pdf"`,
          CacheControl: 'private, no-store',
          Metadata: { sha256: input.sha256 },
        }),
        { abortSignal },
      ),
    );
  }

  public async readPrivateObject(key: string, maxBytes: number): Promise<Buffer> {
    await this.ensureReady();
    const response = await this.sendWithTimeout((abortSignal) =>
      this.client.send(new GetObjectCommand({ Bucket: this.options.bucket, Key: key }), {
        abortSignal,
      }),
    );
    if (!response.Body) throw new Error('GIFT_CERTIFICATE_MEDIA_BODY_MISSING');
    const announced = response.ContentLength ?? 0;
    if (announced > maxBytes) throw new Error('GIFT_CERTIFICATE_MEDIA_TOO_LARGE');
    const body = Buffer.from(await response.Body.transformToByteArray());
    if (body.length === 0 || body.length > maxBytes) {
      throw new Error('GIFT_CERTIFICATE_MEDIA_TOO_LARGE');
    }
    return body;
  }
}
