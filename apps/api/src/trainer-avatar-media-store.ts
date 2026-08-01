import { Readable } from 'node:stream';

import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

export interface TrainerAvatarMediaStore {
  read(key: string, maxBytes: number): Promise<Buffer>;
  put(input: {
    readonly key: string;
    readonly body: Buffer;
    readonly sha256: string;
  }): Promise<void>;
}

export interface S3TrainerAvatarMediaStoreOptions {
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly accessKey: string;
  readonly secretKey: string;
  readonly forcePathStyle: boolean;
  readonly timeoutMs: number;
}

async function boundedBuffer(body: Readable, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of body) {
    const buffer = Buffer.from(chunk as Uint8Array);
    total += buffer.byteLength;
    if (total > maxBytes) throw new Error('TRAINER_AVATAR_OBJECT_TOO_LARGE');
    chunks.push(buffer);
  }
  if (total === 0) throw new Error('TRAINER_AVATAR_OBJECT_EMPTY');
  return Buffer.concat(chunks, total);
}

export class S3TrainerAvatarMediaStore implements TrainerAvatarMediaStore {
  private readonly client: S3Client;

  public constructor(private readonly options: S3TrainerAvatarMediaStoreOptions) {
    this.client = new S3Client({
      endpoint: options.endpoint,
      region: options.region,
      credentials: { accessKeyId: options.accessKey, secretAccessKey: options.secretKey },
      forcePathStyle: options.forcePathStyle,
      maxAttempts: 2,
    });
  }

  public async read(key: string, maxBytes: number): Promise<Buffer> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs);
    try {
      const result = await this.client.send(
        new GetObjectCommand({ Bucket: this.options.bucket, Key: key }),
        { abortSignal: controller.signal },
      );
      if (!result.Body || !(result.Body instanceof Readable)) {
        throw new Error('TRAINER_AVATAR_OBJECT_BODY_INVALID');
      }
      if (result.ContentLength !== undefined && result.ContentLength > maxBytes) {
        throw new Error('TRAINER_AVATAR_OBJECT_TOO_LARGE');
      }
      return boundedBuffer(result.Body, maxBytes);
    } finally {
      clearTimeout(timeout);
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
