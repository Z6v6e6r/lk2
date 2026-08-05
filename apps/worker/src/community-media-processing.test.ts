import net from 'node:net';
import { EventEmitter } from 'node:events';

import sharp from 'sharp';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ClamAvCommunityMediaMalwareScanner,
  COMMUNITY_MEDIA_MAX_SOURCE_BYTES,
  MockCommunityMediaMalwareScanner,
  S3CommunityMediaWorkerObjectStore,
  prepareCommunityMedia,
} from './community-media-processing.js';

const objectStoreOptions = {
  endpoint: 'http://minio.test',
  region: 'us-east-1',
  bucket: 'community-media',
  accessKey: 'access',
  secretKey: 'secret',
  forcePathStyle: true,
} as const;

function mockObjectStoreSend(
  store: S3CommunityMediaWorkerObjectStore,
  implementation: (commandName: string) => unknown,
) {
  const send = vi.fn((command: object) =>
    Promise.resolve().then(() => implementation(command.constructor.name)),
  );
  Object.assign((store as unknown as { client: object }).client, { send });
  return send;
}

function objectBody(...chunks: readonly Buffer[]): AsyncIterable<Uint8Array> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) {
        await Promise.resolve();
        yield chunk;
      }
    },
  };
}

function storageStatusError(status: number): Error {
  return Object.assign(new Error(`storage status ${status}`), {
    $metadata: { httpStatusCode: status },
  });
}

class FakeClamAvSocket extends EventEmitter {
  public readonly write = vi.fn();
  public readonly end = vi.fn();
  public readonly destroy = vi.fn();
  public timeoutHandler: (() => void) | undefined;

  public setTimeout(_timeoutMs: number, handler: () => void): this {
    this.timeoutHandler = handler;
    return this;
  }
}

afterEach(() => vi.restoreAllMocks());

describe('prepareCommunityMedia', () => {
  it('normalizes a safe image into bounded WebP variants', async () => {
    const source = await sharp({
      create: { width: 2_500, height: 1_250, channels: 3, background: '#00a0c6' },
    })
      .png()
      .toBuffer();
    const result = await prepareCommunityMedia({
      body: source,
      declaredContentType: 'image/png',
      scanner: new MockCommunityMediaMalwareScanner(),
    });
    await expect(sharp(result.thumbnail.body).metadata()).resolves.toMatchObject({
      format: 'webp',
      width: 640,
      height: 320,
    });
    await expect(sharp(result.feed.body).metadata()).resolves.toMatchObject({
      format: 'webp',
      width: 2_048,
      height: 1_024,
    });
    expect(result.sourceSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects content-type spoofing before producing variants', async () => {
    const source = await sharp({
      create: { width: 16, height: 16, channels: 3, background: '#fff' },
    })
      .png()
      .toBuffer();
    await expect(
      prepareCommunityMedia({
        body: source,
        declaredContentType: 'image/jpeg',
        scanner: new MockCommunityMediaMalwareScanner(),
      }),
    ).rejects.toThrow('COMMUNITY_MEDIA_CONTENT_TYPE_MISMATCH');
  });

  it('fails closed when malware scan rejects the payload', async () => {
    await expect(
      prepareCommunityMedia({
        body: Buffer.from('unsafe'),
        declaredContentType: 'image/png',
        scanner: { scan: () => Promise.resolve({ outcome: 'infected', signature: 'EICAR' }) },
      }),
    ).rejects.toThrow('COMMUNITY_MEDIA_MALWARE_DETECTED');
  });

  it.each([
    [Buffer.alloc(0), 'COMMUNITY_MEDIA_SOURCE_TOO_LARGE'],
    [Buffer.alloc(COMMUNITY_MEDIA_MAX_SOURCE_BYTES + 1), 'COMMUNITY_MEDIA_SOURCE_TOO_LARGE'],
    [Buffer.from('not-an-image'), 'COMMUNITY_MEDIA_IMAGE_INVALID'],
  ])('rejects invalid source payloads before persistence', async (body, code) => {
    await expect(
      prepareCommunityMedia({
        body,
        declaredContentType: 'image/png',
        scanner: new MockCommunityMediaMalwareScanner(),
      }),
    ).rejects.toThrow(code);
  });

  it('rejects an otherwise parseable unsupported image format', async () => {
    const source = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>',
    );
    await expect(
      prepareCommunityMedia({
        body: source,
        declaredContentType: 'image/svg+xml',
        scanner: new MockCommunityMediaMalwareScanner(),
      }),
    ).rejects.toThrow('COMMUNITY_MEDIA_CONTENT_TYPE_MISMATCH');
  });
});

describe('S3 community media object store', () => {
  it('retries bucket readiness after a transient first failure', async () => {
    const store = new S3CommunityMediaWorkerObjectStore(objectStoreOptions);
    let attempts = 0;
    mockObjectStoreSend(store, (commandName) => {
      if (commandName !== 'GetBucketVersioningCommand') throw new Error('unexpected command');
      attempts += 1;
      if (attempts === 1) throw new Error('temporary storage outage');
      if (attempts === 3) throw new Error('later storage outage');
      return { Status: 'Enabled' };
    });

    await expect(store.checkReady()).rejects.toThrow('temporary storage outage');
    await expect(store.checkReady()).resolves.toBeUndefined();
    await expect(store.checkReady()).rejects.toThrow('later storage outage');
    expect(attempts).toBe(3);
  });

  it('reads bounded exact versions, reports absence and deletes an exact version', async () => {
    const store = new S3CommunityMediaWorkerObjectStore(objectStoreOptions);
    const send = mockObjectStoreSend(store, (commandName) => {
      if (commandName === 'GetBucketVersioningCommand') return { Status: 'Enabled' };
      if (commandName === 'GetObjectCommand') {
        return {
          Body: objectBody(Buffer.from('safe-'), Buffer.from('image')),
          ContentType: 'image/png',
        };
      }
      if (commandName === 'HeadObjectCommand') {
        throw storageStatusError(404);
      }
      if (commandName === 'DeleteObjectCommand') return {};
      throw new Error(`unexpected command ${commandName}`);
    });

    await expect(
      store.getExact({ objectKey: 'source', versionId: 'v1', etag: 'etag-1' }),
    ).resolves.toEqual({ body: Buffer.from('safe-image'), contentType: 'image/png' });
    await expect(store.currentVersion('missing')).resolves.toBeUndefined();
    await expect(
      store.deleteExact({ objectKey: 'source', versionId: 'v1' }),
    ).resolves.toBeUndefined();
    expect(
      send.mock.calls.filter(
        ([command]) => command.constructor.name === 'GetBucketVersioningCommand',
      ),
    ).toHaveLength(1);
  });

  it.each([
    [undefined, 'COMMUNITY_MEDIA_SOURCE_BODY_MISSING'],
    [objectBody(), 'COMMUNITY_MEDIA_SOURCE_BODY_MISSING'],
    [
      objectBody(Buffer.alloc(COMMUNITY_MEDIA_MAX_SOURCE_BYTES + 1)),
      'COMMUNITY_MEDIA_SOURCE_TOO_LARGE',
    ],
  ])('rejects missing or oversized object bodies', async (body, code) => {
    const store = new S3CommunityMediaWorkerObjectStore(objectStoreOptions);
    mockObjectStoreSend(store, (commandName) => {
      if (commandName === 'GetBucketVersioningCommand') return { Status: 'Enabled' };
      return { Body: body, ContentType: 'image/png' };
    });
    await expect(
      store.getExact({ objectKey: 'source', versionId: 'v1', etag: 'etag-1' }),
    ).rejects.toThrow(code);
  });

  it('fails closed for disabled versioning and missing object metadata', async () => {
    const disabled = new S3CommunityMediaWorkerObjectStore(objectStoreOptions);
    mockObjectStoreSend(disabled, () => ({ Status: 'Suspended' }));
    await expect(disabled.currentVersion('source')).rejects.toThrow(
      'COMMUNITY_MEDIA_BUCKET_VERSIONING_REQUIRED',
    );

    const missingContentType = new S3CommunityMediaWorkerObjectStore(objectStoreOptions);
    mockObjectStoreSend(missingContentType, (commandName) => {
      if (commandName === 'GetBucketVersioningCommand') return { Status: 'Enabled' };
      return { Body: objectBody(Buffer.from('image')) };
    });
    await expect(
      missingContentType.getExact({ objectKey: 'source', versionId: 'v1', etag: 'etag-1' }),
    ).rejects.toThrow('COMMUNITY_MEDIA_SOURCE_CONTENT_TYPE_MISSING');

    const missingVersion = new S3CommunityMediaWorkerObjectStore(objectStoreOptions);
    mockObjectStoreSend(missingVersion, (commandName) =>
      commandName === 'GetBucketVersioningCommand' ? { Status: 'Enabled' } : {},
    );
    await expect(missingVersion.currentVersion('source')).rejects.toThrow(
      'COMMUNITY_MEDIA_SOURCE_VERSION_MISSING',
    );
  });

  it('stores a new immutable variant and validates a retry collision', async () => {
    const body = await sharp({
      create: { width: 12, height: 8, channels: 3, background: '#334455' },
    })
      .webp()
      .toBuffer();
    const sha256 = 'a'.repeat(64);
    const fresh = new S3CommunityMediaWorkerObjectStore(objectStoreOptions);
    mockObjectStoreSend(fresh, (commandName) => {
      if (commandName === 'GetBucketVersioningCommand') return { Status: 'Enabled' };
      return { VersionId: 'variant-v1', ETag: 'variant-etag' };
    });
    await expect(
      fresh.putReady({ objectKey: 'ready/feed.webp', body, sha256 }),
    ).resolves.toMatchObject({
      versionId: 'variant-v1',
      etag: 'variant-etag',
      width: 12,
      height: 8,
      sizeBytes: body.byteLength,
    });

    const retry = new S3CommunityMediaWorkerObjectStore(objectStoreOptions);
    mockObjectStoreSend(retry, (commandName) => {
      if (commandName === 'GetBucketVersioningCommand') return { Status: 'Enabled' };
      if (commandName === 'PutObjectCommand') throw storageStatusError(412);
      return {
        ContentType: 'image/webp',
        ContentLength: body.byteLength,
        Metadata: { sha256, width: '12', height: '8' },
        VersionId: 'existing-v1',
        ETag: 'existing-etag',
      };
    });
    await expect(
      retry.putReady({ objectKey: 'ready/feed.webp', body, sha256 }),
    ).resolves.toMatchObject({
      versionId: 'existing-v1',
      etag: 'existing-etag',
    });
  });

  it('distinguishes a key collision from a transient storage failure', async () => {
    const body = await sharp({
      create: { width: 4, height: 4, channels: 3, background: '#fff' },
    })
      .webp()
      .toBuffer();
    const collision = new S3CommunityMediaWorkerObjectStore(objectStoreOptions);
    mockObjectStoreSend(collision, (commandName) => {
      if (commandName === 'GetBucketVersioningCommand') return { Status: 'Enabled' };
      if (commandName === 'PutObjectCommand') throw storageStatusError(412);
      return { ContentType: 'text/plain' };
    });
    await expect(
      collision.putReady({ objectKey: 'ready/feed.webp', body, sha256: 'b'.repeat(64) }),
    ).rejects.toThrow('COMMUNITY_MEDIA_VARIANT_KEY_COLLISION');

    const transient = new S3CommunityMediaWorkerObjectStore(objectStoreOptions);
    mockObjectStoreSend(transient, (commandName) => {
      if (commandName === 'GetBucketVersioningCommand') return { Status: 'Enabled' };
      throw new Error('storage unavailable');
    });
    await expect(
      transient.putReady({ objectKey: 'ready/feed.webp', body, sha256: 'c'.repeat(64) }),
    ).rejects.toThrow('storage unavailable');
  });
});

describe('ClamAV community media scanner', () => {
  it('uses the bounded PING command for dependency readiness', async () => {
    const socket = new FakeClamAvSocket();
    vi.spyOn(net, 'createConnection').mockReturnValue(socket as never);
    const scanner = new ClamAvCommunityMediaMalwareScanner({
      host: 'clamav',
      port: 3310,
      timeoutMs: 500,
    });
    const ready = scanner.checkReady();
    socket.emit('connect');
    socket.emit('data', Buffer.from('PONG\0'));
    await expect(ready).resolves.toBeUndefined();
    expect(socket.end).toHaveBeenCalledWith('zPING\0');
  });

  it.each([
    ['stream: OK\0', { outcome: 'clean' }],
    [
      'stream: Eicar-Test-Signature FOUND\n',
      { outcome: 'infected', signature: 'Eicar-Test-Signature' },
    ],
  ])('decodes terminal scanner response %s', async (response, expected) => {
    const socket = new FakeClamAvSocket();
    vi.spyOn(net, 'createConnection').mockReturnValue(socket as never);
    const scanner = new ClamAvCommunityMediaMalwareScanner({
      host: 'clamav',
      port: 3310,
      timeoutMs: 500,
    });
    const result = scanner.scan(Buffer.from('payload'));
    socket.emit('connect');
    socket.emit('data', Buffer.from(response));
    await expect(result).resolves.toEqual(expected);
    expect(socket.write).toHaveBeenCalledWith('zINSTREAM\0');
    expect(socket.destroy).toHaveBeenCalledOnce();
  });

  it('distinguishes timeout, unavailable and malformed scanner responses', async () => {
    const timeoutSocket = new FakeClamAvSocket();
    vi.spyOn(net, 'createConnection').mockReturnValueOnce(timeoutSocket as never);
    const scanner = new ClamAvCommunityMediaMalwareScanner({
      host: 'clamav',
      port: 3310,
      timeoutMs: 500,
    });
    const timeout = scanner.scan(Buffer.from('payload'));
    timeoutSocket.timeoutHandler?.();
    await expect(timeout).rejects.toThrow('COMMUNITY_MEDIA_SCAN_TIMEOUT');

    const errorSocket = new FakeClamAvSocket();
    vi.mocked(net.createConnection).mockReturnValueOnce(errorSocket as never);
    const unavailable = scanner.scan(Buffer.from('payload'));
    errorSocket.emit('error', new Error('refused'));
    await expect(unavailable).rejects.toThrow('COMMUNITY_MEDIA_SCAN_UNAVAILABLE');

    const invalidSocket = new FakeClamAvSocket();
    vi.mocked(net.createConnection).mockReturnValueOnce(invalidSocket as never);
    const invalid = scanner.scan(Buffer.from('payload'));
    invalidSocket.emit('data', Buffer.from('unexpected\n'));
    await expect(invalid).rejects.toThrow('COMMUNITY_MEDIA_SCAN_RESPONSE_INVALID');
  });
});
