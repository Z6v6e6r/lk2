import { createHash } from 'node:crypto';
import net from 'node:net';

import {
  DeleteObjectCommand,
  GetBucketVersioningCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import sharp from 'sharp';

export const COMMUNITY_MEDIA_MAX_SOURCE_BYTES = 15 * 1_024 * 1_024;
const COMMUNITY_MEDIA_MAX_INPUT_PIXELS = 40_000_000;

export interface CommunityMediaSourceObject {
  readonly body: Buffer;
  readonly contentType: string;
}

export interface CommunityMediaStoredVariant {
  readonly objectKey: string;
  readonly versionId: string;
  readonly etag: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly width: number;
  readonly height: number;
}

export interface CommunityMediaWorkerObjectStore {
  checkReady?(): Promise<void>;
  getExact(input: {
    readonly objectKey: string;
    readonly versionId: string;
    readonly etag: string;
  }): Promise<CommunityMediaSourceObject>;
  putReady(input: {
    readonly objectKey: string;
    readonly body: Buffer;
    readonly sha256: string;
  }): Promise<CommunityMediaStoredVariant>;
  currentVersion(objectKey: string): Promise<string | undefined>;
  deleteExact(input: { readonly objectKey: string; readonly versionId: string }): Promise<void>;
}

export interface S3CommunityMediaWorkerObjectStoreOptions {
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly accessKey: string;
  readonly secretKey: string;
  readonly forcePathStyle: boolean;
}

async function readBoundedBody(body: unknown, maxBytes: number): Promise<Buffer> {
  if (!body || typeof body !== 'object' || !(Symbol.asyncIterator in body)) {
    throw new Error('COMMUNITY_MEDIA_SOURCE_BODY_MISSING');
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of body as AsyncIterable<Uint8Array>) {
    size += chunk.byteLength;
    if (size > maxBytes) throw new Error('COMMUNITY_MEDIA_SOURCE_TOO_LARGE');
    chunks.push(Buffer.from(chunk));
  }
  if (size === 0) throw new Error('COMMUNITY_MEDIA_SOURCE_BODY_MISSING');
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

export class S3CommunityMediaWorkerObjectStore implements CommunityMediaWorkerObjectStore {
  private readonly client: S3Client;
  private ready: Promise<void> | undefined;

  public constructor(private readonly options: S3CommunityMediaWorkerObjectStoreOptions) {
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
          throw new Error('COMMUNITY_MEDIA_BUCKET_VERSIONING_REQUIRED');
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
  }): Promise<CommunityMediaSourceObject> {
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
      body: await readBoundedBody(result.Body, COMMUNITY_MEDIA_MAX_SOURCE_BYTES),
      contentType: requiredText(result.ContentType, 'COMMUNITY_MEDIA_SOURCE_CONTENT_TYPE_MISSING'),
    };
  }

  public async putReady(input: {
    readonly objectKey: string;
    readonly body: Buffer;
    readonly sha256: string;
  }): Promise<CommunityMediaStoredVariant> {
    await this.ensureReady();
    const metadata = await sharp(input.body).metadata();
    if (!metadata.width || !metadata.height) {
      throw new Error('COMMUNITY_MEDIA_VARIANT_DIMENSIONS_MISSING');
    }
    let versionId: string | undefined;
    let etag: string | undefined;
    try {
      const stored = await this.client.send(
        new PutObjectCommand({
          Bucket: this.options.bucket,
          Key: input.objectKey,
          Body: input.body,
          ContentType: 'image/webp',
          CacheControl: 'private, max-age=31536000, immutable',
          IfNoneMatch: '*',
          Metadata: {
            sha256: input.sha256,
            width: String(metadata.width),
            height: String(metadata.height),
          },
        }),
      );
      versionId = stored.VersionId;
      etag = stored.ETag;
    } catch (error) {
      if (httpStatus(error) !== 412) throw error;
      const existing = await this.client.send(
        new HeadObjectCommand({ Bucket: this.options.bucket, Key: input.objectKey }),
      );
      if (
        existing.ContentType !== 'image/webp' ||
        existing.ContentLength !== input.body.byteLength ||
        existing.Metadata?.sha256 !== input.sha256 ||
        existing.Metadata?.width !== String(metadata.width) ||
        existing.Metadata?.height !== String(metadata.height)
      ) {
        throw new Error('COMMUNITY_MEDIA_VARIANT_KEY_COLLISION', { cause: error });
      }
      versionId = existing.VersionId;
      etag = existing.ETag;
    }
    return {
      objectKey: input.objectKey,
      versionId: requiredText(versionId, 'COMMUNITY_MEDIA_VARIANT_VERSION_MISSING'),
      etag: requiredText(etag, 'COMMUNITY_MEDIA_VARIANT_ETAG_MISSING'),
      sha256: input.sha256,
      sizeBytes: input.body.byteLength,
      width: metadata.width,
      height: metadata.height,
    };
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
      return requiredText(result.VersionId, 'COMMUNITY_MEDIA_SOURCE_VERSION_MISSING');
    } catch (error) {
      if (httpStatus(error) === 404) return undefined;
      throw error;
    }
  }
}

export type CommunityMediaScanResult =
  { readonly outcome: 'clean' } | { readonly outcome: 'infected'; readonly signature: string };

export interface CommunityMediaMalwareScanner {
  checkReady?(): Promise<void>;
  scan(body: Buffer): Promise<CommunityMediaScanResult>;
}

export class MockCommunityMediaMalwareScanner implements CommunityMediaMalwareScanner {
  public checkReady(): Promise<void> {
    return Promise.resolve();
  }

  public scan(): Promise<CommunityMediaScanResult> {
    return Promise.resolve({ outcome: 'clean' });
  }
}

export class ClamAvCommunityMediaMalwareScanner implements CommunityMediaMalwareScanner {
  public constructor(
    private readonly options: {
      readonly host: string;
      readonly port: number;
      readonly timeoutMs: number;
    },
  ) {}

  public checkReady(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: this.options.host, port: this.options.port });
      let response = '';
      let settled = false;
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        socket.destroy();
        if (error) return reject(error);
        if (response === 'PONG\0' || response === 'PONG\n') return resolve();
        return reject(new Error('COMMUNITY_MEDIA_SCAN_HEALTH_INVALID'));
      };
      socket.setTimeout(this.options.timeoutMs, () =>
        finish(new Error('COMMUNITY_MEDIA_SCAN_TIMEOUT')),
      );
      socket.on('error', () => finish(new Error('COMMUNITY_MEDIA_SCAN_UNAVAILABLE')));
      socket.on('data', (chunk: Buffer) => {
        response += chunk.toString('utf8');
        if (response.length > 64) return finish(new Error('COMMUNITY_MEDIA_SCAN_HEALTH_INVALID'));
        if (response.includes('\0') || response.includes('\n')) finish();
      });
      socket.on('end', () => finish());
      socket.on('connect', () => socket.end('zPING\0'));
    });
  }

  public scan(body: Buffer): Promise<CommunityMediaScanResult> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: this.options.host, port: this.options.port });
      let response = '';
      let settled = false;
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        socket.destroy();
        if (error) return reject(error);
        if (response.endsWith(' OK\0') || response.endsWith(' OK\n')) {
          return resolve({ outcome: 'clean' });
        }
        const match = response.match(/: (.+) FOUND(?:\0|\n)$/);
        if (match?.[1]) return resolve({ outcome: 'infected', signature: match[1] });
        return reject(new Error('COMMUNITY_MEDIA_SCAN_RESPONSE_INVALID'));
      };
      socket.setTimeout(this.options.timeoutMs, () =>
        finish(new Error('COMMUNITY_MEDIA_SCAN_TIMEOUT')),
      );
      socket.on('error', () => finish(new Error('COMMUNITY_MEDIA_SCAN_UNAVAILABLE')));
      socket.on('data', (chunk: Buffer) => {
        response += chunk.toString('utf8');
        if (response.length > 4_096)
          return finish(new Error('COMMUNITY_MEDIA_SCAN_RESPONSE_INVALID'));
        if (response.includes('\0') || response.includes('\n')) finish();
      });
      socket.on('end', () => finish());
      socket.on('connect', () => {
        socket.write('zINSTREAM\0');
        for (let offset = 0; offset < body.byteLength; offset += 64 * 1_024) {
          const chunk = body.subarray(offset, offset + 64 * 1_024);
          const length = Buffer.allocUnsafe(4);
          length.writeUInt32BE(chunk.byteLength);
          socket.write(length);
          socket.write(chunk);
        }
        socket.end(Buffer.alloc(4));
      });
    });
  }
}

export interface PreparedCommunityMedia {
  readonly sourceSha256: string;
  readonly thumbnail: { readonly body: Buffer; readonly sha256: string };
  readonly feed: { readonly body: Buffer; readonly sha256: string };
}

function formatContentType(format: string | undefined): string | undefined {
  if (format === 'jpeg') return 'image/jpeg';
  if (format === 'png') return 'image/png';
  if (format === 'webp') return 'image/webp';
  return undefined;
}

async function renderWebp(source: Buffer, maxDimension: number): Promise<Buffer> {
  return sharp(source, { failOn: 'error', limitInputPixels: COMMUNITY_MEDIA_MAX_INPUT_PIXELS })
    .rotate()
    .resize({
      width: maxDimension,
      height: maxDimension,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .webp({ quality: 82, effort: 4 })
    .toBuffer();
}

export async function prepareCommunityMedia(input: {
  readonly body: Buffer;
  readonly declaredContentType: string;
  readonly scanner: CommunityMediaMalwareScanner;
}): Promise<PreparedCommunityMedia> {
  if (input.body.byteLength < 1 || input.body.byteLength > COMMUNITY_MEDIA_MAX_SOURCE_BYTES) {
    throw new Error('COMMUNITY_MEDIA_SOURCE_TOO_LARGE');
  }
  const scan = await input.scanner.scan(input.body);
  if (scan.outcome === 'infected') throw new Error('COMMUNITY_MEDIA_MALWARE_DETECTED');
  let metadata: { readonly format?: string; readonly width?: number; readonly height?: number };
  try {
    metadata = await sharp(input.body, {
      failOn: 'error',
      limitInputPixels: COMMUNITY_MEDIA_MAX_INPUT_PIXELS,
    }).metadata();
  } catch {
    throw new Error('COMMUNITY_MEDIA_IMAGE_INVALID');
  }
  const detectedContentType = formatContentType(metadata.format);
  if (!detectedContentType || detectedContentType !== input.declaredContentType) {
    throw new Error('COMMUNITY_MEDIA_CONTENT_TYPE_MISMATCH');
  }
  let thumbnailBody: Buffer;
  let feedBody: Buffer;
  try {
    [thumbnailBody, feedBody] = await Promise.all([
      renderWebp(input.body, 640),
      renderWebp(input.body, 2_048),
    ]);
  } catch {
    throw new Error('COMMUNITY_MEDIA_IMAGE_INVALID');
  }
  const digest = (body: Buffer): string => createHash('sha256').update(body).digest('hex');
  return {
    sourceSha256: digest(input.body),
    thumbnail: { body: thumbnailBody, sha256: digest(thumbnailBody) },
    feed: { body: feedBody, sha256: digest(feedBody) },
  };
}
