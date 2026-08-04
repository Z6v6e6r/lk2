import { randomUUID } from 'node:crypto';

import Redis from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { RedisBookingScreenReadJobStore } from './booking-screen-read-job-store.js';

const redisUrl = process.env.BOOKING_SCREEN_TEST_REDIS_URL;
const describeWithRedis = redisUrl ? describe : describe.skip;
const TEST_TTL_SECONDS = 5;

describeWithRedis('Redis booking screen result claims and egress budgets', () => {
  let redisA: Redis;
  let redisB: Redis;
  let storeA: RedisBookingScreenReadJobStore;
  let storeB: RedisBookingScreenReadJobStore;

  beforeAll(async () => {
    if (!redisUrl) throw new Error('BOOKING_SCREEN_TEST_REDIS_URL_REQUIRED');
    redisA = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1 });
    redisB = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1 });
    await Promise.all([redisA.connect(), redisB.connect()]);
    storeA = new RedisBookingScreenReadJobStore(redisA);
    storeB = new RedisBookingScreenReadJobStore(redisB);
  });

  afterAll(async () => {
    await Promise.all([redisA?.quit(), redisB?.quit()]);
  });

  it('atomically distinguishes same-payload replay from conflicting payloads', async () => {
    const jobId = randomUUID();
    const commandId = randomUUID();
    const payloadHash = 'a'.repeat(64);
    const conflictingHash = 'b'.repeat(64);

    await expect(
      storeA.claimResult(jobId, commandId, randomUUID(), payloadHash, TEST_TTL_SECONDS),
    ).resolves.toBe('claimed');
    await expect(
      storeB.claimResult(jobId, commandId, randomUUID(), payloadHash, TEST_TTL_SECONDS),
    ).resolves.toBe('in_progress');
    await expect(
      storeB.claimResult(jobId, commandId, randomUUID(), conflictingHash, TEST_TTL_SECONDS),
    ).resolves.toBe('conflict');

    const completingClaimId = randomUUID();
    const secondCommandId = randomUUID();
    await expect(
      storeA.claimResult(jobId, secondCommandId, completingClaimId, payloadHash, TEST_TTL_SECONDS),
    ).resolves.toBe('claimed');
    const result = {
      commandId: secondCommandId,
      kind: 'schedule' as const,
      acceptedAt: new Date().toISOString(),
      activities: [],
    };
    await expect(
      storeA.completeClaimedResult(jobId, completingClaimId, payloadHash, result, TEST_TTL_SECONDS),
    ).resolves.toBe(true);
    await expect(
      storeB.claimResult(jobId, secondCommandId, randomUUID(), payloadHash, TEST_TTL_SECONDS),
    ).resolves.toBe('replayed');
    await expect(
      storeB.claimResult(jobId, secondCommandId, randomUUID(), conflictingHash, TEST_TTL_SECONDS),
    ).resolves.toBe('conflict');
  });

  it('atomically enforces the principal budget across store instances', async () => {
    const input = {
      tenantId: randomUUID(),
      userId: randomUUID(),
      provider: 'VIVA' as const,
      units: 2,
      principalLimit: 3,
      providerLimit: 10,
      windowSeconds: TEST_TTL_SECONDS,
    };

    const outcomes = await Promise.all([
      storeA.consumeEgressBudget(input),
      storeB.consumeEgressBudget(input),
    ]);

    expect(outcomes.filter((outcome) => outcome.allowed)).toHaveLength(1);
    expect(outcomes.filter((outcome) => !outcome.allowed)).toHaveLength(1);
  });

  it('atomically enforces the provider budget across different principals and stores', async () => {
    const tenantId = randomUUID();
    const shared = {
      tenantId,
      provider: 'VIVA' as const,
      units: 2,
      principalLimit: 10,
      providerLimit: 3,
      windowSeconds: TEST_TTL_SECONDS,
    };

    const outcomes = await Promise.all([
      storeA.consumeEgressBudget({ ...shared, userId: randomUUID() }),
      storeB.consumeEgressBudget({ ...shared, userId: randomUUID() }),
    ]);

    expect(outcomes.filter((outcome) => outcome.allowed)).toHaveLength(1);
    expect(outcomes.filter((outcome) => !outcome.allowed)).toHaveLength(1);
  });
});
