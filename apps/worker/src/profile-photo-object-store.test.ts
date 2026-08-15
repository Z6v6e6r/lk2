import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const s3Mocks = vi.hoisted(() => ({
  clients: [] as unknown[],
  send: vi.fn<(command: unknown, options?: { abortSignal?: AbortSignal }) => Promise<unknown>>(),
}));

vi.mock('@aws-sdk/client-s3', () => {
  class Command {
    public constructor(public readonly input: unknown) {}
  }
  return {
    CreateBucketCommand: Command,
    DeleteObjectCommand: Command,
    GetObjectCommand: Command,
    HeadBucketCommand: Command,
    PutObjectCommand: Command,
    S3Client: class S3Client {
      public constructor(options: unknown) {
        s3Mocks.clients.push(options);
      }
      public send(command: unknown, options?: { abortSignal?: AbortSignal }): Promise<unknown> {
        return s3Mocks.send(command, options);
      }
    },
  };
});

vi.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: vi.fn() }));

import { S3ProfilePhotoObjectStore } from './profile-photo-sync.js';

describe('S3 profile photo object store', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.useRealTimers());

  it('aborts a stalled GC delete within the configured timeout and bounds SDK attempts', async () => {
    vi.useFakeTimers();
    let deleteSignal: AbortSignal | undefined;
    s3Mocks.send.mockResolvedValueOnce({}).mockImplementationOnce((_command, options) => {
      deleteSignal = options?.abortSignal;
      return new Promise((_resolve, reject) => {
        options?.abortSignal?.addEventListener('abort', () => reject(new Error('S3_ABORTED')));
      });
    });
    const store = new S3ProfilePhotoObjectStore({
      endpoint: 'https://s3.internal.test',
      publicEndpoint: 'https://s3.public.test',
      region: 'ru-central1',
      bucket: 'profile-media',
      accessKey: 'test-access',
      secretKey: 'test-secret',
      forcePathStyle: true,
      autoCreateBucket: false,
      readUrlTtlSeconds: 600,
      timeoutMs: 50,
    });

    const deletion = store.delete('profile-photos/tenant/user/photo.webp');
    const rejection = expect(deletion).rejects.toThrow('S3_ABORTED');
    await vi.advanceTimersByTimeAsync(51);

    await rejection;
    expect(deleteSignal?.aborted).toBe(true);
    expect(s3Mocks.clients).toEqual([
      expect.objectContaining({ maxAttempts: 2 }),
      expect.objectContaining({ maxAttempts: 2 }),
    ]);
  });
});
