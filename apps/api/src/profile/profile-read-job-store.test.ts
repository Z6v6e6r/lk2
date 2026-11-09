import type Redis from 'ioredis';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  MemoryProfileProviderReadJobStore,
  PROFILE_PROVIDER_READ_JOB_TTL_SECONDS,
  PROFILE_PROVIDER_READ_RETENTION_GRACE_SECONDS,
  RedisProfileProviderReadJobStore,
  type ProfileProviderReadJob,
} from './profile-read-job-store.js';

const tenantId = '86afbe01-0318-4dd2-bc25-303b7bf0d430';
const userId = '49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca';
const jobId = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const commandId = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const createdAt = '2026-11-09T06:00:00.000Z';

function job(overrides: Partial<ProfileProviderReadJob> = {}): ProfileProviderReadJob {
  return {
    jobId,
    tenantId,
    userId,
    commandId,
    operation: 'profile.read',
    createdAt,
    expiresAt: new Date(
      Date.parse(createdAt) + PROFILE_PROVIDER_READ_JOB_TTL_SECONDS * 1_000,
    ).toISOString(),
    ...overrides,
  };
}

function result() {
  return {
    commandId,
    observedAt: '2026-11-09T06:00:30.000Z',
    acceptedAt: '2026-11-09T06:00:31.000Z',
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('memory profile provider read job store', () => {
  it('creates once and reads the job back', async () => {
    const store = new MemoryProfileProviderReadJobStore();
    await expect(store.create(job(), PROFILE_PROVIDER_READ_JOB_TTL_SECONDS)).resolves.toBe(true);
    await expect(store.create(job(), PROFILE_PROVIDER_READ_JOB_TTL_SECONDS)).resolves.toBe(false);
    await expect(store.get(jobId)).resolves.toEqual(job());
    await expect(store.get('2a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d')).resolves.toBeUndefined();
  });

  it('keeps an expired job addressable for the grace window so the route can answer 410', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(createdAt));
    const store = new MemoryProfileProviderReadJobStore();
    await store.create(job(), PROFILE_PROVIDER_READ_JOB_TTL_SECONDS);

    vi.setSystemTime(new Date(Date.parse(createdAt) + 121_000));
    await expect(store.get(jobId)).resolves.toEqual(job());

    vi.setSystemTime(
      new Date(
        Date.parse(createdAt) +
          (PROFILE_PROVIDER_READ_JOB_TTL_SECONDS + PROFILE_PROVIDER_READ_RETENTION_GRACE_SECONDS) *
            1_000 +
          1_000,
      ),
    );
    await expect(store.get(jobId)).resolves.toBeUndefined();
  });

  it('accepts one result per command and answers a replay', async () => {
    const store = new MemoryProfileProviderReadJobStore();
    await store.create(job(), PROFILE_PROVIDER_READ_JOB_TTL_SECONDS);

    await expect(store.putResult(jobId, result(), 60)).resolves.toBe('accepted');
    await expect(store.putResult(jobId, result(), 60)).resolves.toBe('replayed');
    await expect(store.getResult(jobId, commandId)).resolves.toEqual(result());
    await expect(
      store.getResult(jobId, '3a3b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d'),
    ).resolves.toBeUndefined();
  });

  it('consumes the job and its result so completion cannot replay forever', async () => {
    const store = new MemoryProfileProviderReadJobStore();
    await store.create(job(), PROFILE_PROVIDER_READ_JOB_TTL_SECONDS);
    await store.putResult(jobId, result(), 60);

    await store.consume(jobId, commandId);

    await expect(store.get(jobId)).resolves.toBeUndefined();
    await expect(store.getResult(jobId, commandId)).resolves.toBeUndefined();
  });

  it('expires results with the same retention window', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(createdAt));
    const store = new MemoryProfileProviderReadJobStore();
    await store.create(job(), PROFILE_PROVIDER_READ_JOB_TTL_SECONDS);
    await store.putResult(jobId, result(), 60);

    vi.setSystemTime(new Date(Date.parse(createdAt) + 181_000));
    await expect(store.getResult(jobId, commandId)).resolves.toBeUndefined();
  });
});

describe('redis profile provider read job store', () => {
  const redis = {
    set: vi.fn(),
    get: vi.fn(),
    del: vi.fn(),
  };

  function store() {
    return new RedisProfileProviderReadJobStore(redis as unknown as Redis);
  }

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('stores a job with NX and the retention window', async () => {
    redis.set.mockResolvedValue('OK');
    await expect(store().create(job(), PROFILE_PROVIDER_READ_JOB_TTL_SECONDS)).resolves.toBe(true);
    expect(redis.set).toHaveBeenCalledWith(
      'phub:profile-provider-read-job:' + jobId,
      JSON.stringify(job()),
      'EX',
      PROFILE_PROVIDER_READ_JOB_TTL_SECONDS + PROFILE_PROVIDER_READ_RETENTION_GRACE_SECONDS,
      'NX',
    );

    redis.set.mockResolvedValue(null);
    await expect(store().create(job(), PROFILE_PROVIDER_READ_JOB_TTL_SECONDS)).resolves.toBe(false);
  });

  it('reads a job and tolerates a missing or corrupt value', async () => {
    redis.get.mockResolvedValue(JSON.stringify(job()));
    await expect(store().get(jobId)).resolves.toEqual(job());

    redis.get.mockResolvedValue(null);
    await expect(store().get(jobId)).resolves.toBeUndefined();

    redis.get.mockResolvedValue('{not json');
    await expect(store().get(jobId)).resolves.toBeUndefined();
  });

  it('writes one result per command and reports the replay', async () => {
    redis.set.mockResolvedValueOnce('OK').mockResolvedValueOnce(null);
    await expect(store().putResult(jobId, result(), 50)).resolves.toBe('accepted');
    await expect(store().putResult(jobId, result(), 50)).resolves.toBe('replayed');
    expect(redis.set).toHaveBeenNthCalledWith(
      1,
      'phub:profile-provider-read-result:' + jobId + ':' + commandId,
      JSON.stringify(result()),
      'EX',
      50 + PROFILE_PROVIDER_READ_RETENTION_GRACE_SECONDS,
      'NX',
    );
  });

  it('reads a result and consumes the exact job/command pair', async () => {
    redis.get.mockResolvedValue(JSON.stringify(result()));
    await expect(store().getResult(jobId, commandId)).resolves.toEqual(result());

    redis.del.mockResolvedValue(2);
    await store().consume(jobId, commandId);
    expect(redis.del).toHaveBeenCalledWith(
      'phub:profile-provider-read-job:' + jobId,
      'phub:profile-provider-read-result:' + jobId + ':' + commandId,
    );
  });
});
