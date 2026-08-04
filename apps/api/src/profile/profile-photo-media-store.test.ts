import { Readable } from 'node:stream';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const s3Mocks = vi.hoisted(() => ({
  send: vi.fn<(command: unknown, options: unknown) => Promise<unknown>>(),
}));

vi.mock('@aws-sdk/client-s3', () => ({
  GetObjectCommand: class GetObjectCommand {
    public constructor(public readonly input: unknown) {}
  },
  S3Client: class S3Client {
    public send(command: unknown, options: unknown): Promise<unknown> {
      return s3Mocks.send(command, options);
    }
  },
}));

import {
  ProfilePhotoMediaNotFoundError,
  S3ProfilePhotoMediaStore,
} from './profile-photo-media-store.js';

const options = {
  endpoint: 'https://s3.example.test',
  region: 'ru-central1',
  bucket: 'profile-media',
  accessKey: 'test-access',
  secretKey: 'test-secret',
  forcePathStyle: true,
  timeoutMs: 500,
};

describe('S3 profile photo media store', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns a readable body with optional object metadata', async () => {
    const body = Readable.from(Buffer.from('avatar'));
    s3Mocks.send.mockResolvedValue({ Body: body, ContentLength: 6, ETag: 'avatar-etag' });
    const store = new S3ProfilePhotoMediaStore(options);

    await expect(store.read('tenant/user/avatar.webp')).resolves.toEqual({
      body,
      contentLength: 6,
      etag: 'avatar-etag',
    });
    const call: readonly unknown[] | undefined = s3Mocks.send.mock.calls[0];
    expect(call?.[0]).toMatchObject({
      input: { Bucket: options.bucket, Key: 'tenant/user/avatar.webp' },
    });
    expect(
      (call?.[1] as { readonly abortSignal?: unknown } | undefined)?.abortSignal,
    ).toBeInstanceOf(AbortSignal);
  });

  it('omits unavailable metadata without changing the stream', async () => {
    const body = Readable.from(Buffer.from('avatar'));
    s3Mocks.send.mockResolvedValue({ Body: body });

    await expect(new S3ProfilePhotoMediaStore(options).read('avatar.webp')).resolves.toEqual({
      body,
    });
  });

  it('rejects provider responses without a Node readable body', async () => {
    s3Mocks.send.mockResolvedValue({ Body: new Uint8Array([1, 2, 3]) });

    await expect(new S3ProfilePhotoMediaStore(options).read('avatar.webp')).rejects.toThrow(
      'PROFILE_PHOTO_MEDIA_BODY_INVALID',
    );
  });

  it('maps an S3 404 to a stable domain error', async () => {
    s3Mocks.send.mockRejectedValue({ $metadata: { httpStatusCode: 404 } });

    await expect(new S3ProfilePhotoMediaStore(options).read('missing.webp')).rejects.toBeInstanceOf(
      ProfilePhotoMediaNotFoundError,
    );
  });

  it.each([
    new Error('network unavailable'),
    null,
    { $metadata: null },
    { $metadata: { httpStatusCode: '404' } },
  ])('preserves non-404 provider failures %#', async (error) => {
    s3Mocks.send.mockRejectedValue(error);

    await expect(new S3ProfilePhotoMediaStore(options).read('avatar.webp')).rejects.toBe(error);
  });
});
