import { createHash, randomUUID } from 'node:crypto';

import Redis from 'ioredis';
import { afterAll, describe, expect, it } from 'vitest';

import { RedisAuthChallengeStore } from './challenge-store.js';
import {
  RedisSubjectLinkChallengeStore,
  SUBJECT_LINK_PURPOSE,
  type SubjectLinkChallenge,
} from './subject-link-challenge-store.js';

function ciRedis(): string | undefined {
  if (
    process.env.GITHUB_ACTIONS !== 'true' ||
    process.env.APP_ENV !== 'ci' ||
    !process.env.REDIS_URL
  ) {
    return undefined;
  }
  const url = new URL(process.env.REDIS_URL);
  if (
    url.protocol !== 'redis:' ||
    !['localhost', '127.0.0.1'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.port !== '6379' ||
    !['', '/', '/0'].includes(url.pathname)
  ) {
    throw new Error('SUBJECT_LINK_TEST_DISPOSABLE_REDIS_REQUIRED');
  }
  return url.toString();
}

const url = ciRedis();
const suite = url ? describe : describe.skip;

suite('subject-link challenge store on disposable CI Redis', () => {
  const redis = new Redis(url!, { lazyConnect: true, maxRetriesPerRequest: 1 });
  const store = new RedisSubjectLinkChallengeStore(redis);
  const generic = new RedisAuthChallengeStore(redis);
  const ownedKeys = new Set<string>();

  function challenge(): SubjectLinkChallenge {
    const id = randomUUID();
    const tenantId = randomUUID();
    const actorUserId = randomUUID();
    const phoneHash = createHash('sha256').update(randomUUID()).digest('hex');
    ownedKeys.add(`phub:auth:subject-link:challenge:${id}`);
    ownedKeys.add(`phub:auth:subject-link:challenge:${id}:claim`);
    ownedKeys.add(
      `phub:auth:subject-link:challenge:cooldown:${tenantId}:${actorUserId}:${phoneHash}`,
    );
    return {
      id,
      purpose: SUBJECT_LINK_PURPOSE,
      tenantId,
      tenantKey: `tenant-${tenantId}`,
      actorUserId,
      sessionFamilyId: randomUUID(),
      audience: 'client',
      provider: 'VIVA',
      providerTenantKey: 'synthetic-provider-tenant',
      phoneHash,
      attempts: 0,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      resendAt: new Date(Date.now() + 30_000).toISOString(),
    };
  }

  afterAll(async () => {
    if (ownedKeys.size > 0) await redis.del(...ownedKeys);
    redis.disconnect();
  });

  it('keeps purpose and namespace isolated and stores no canonical phone field', async () => {
    const value = challenge();
    expect(await store.put(value, 60, 30)).toBe(true);
    expect(await generic.get(value.id)).toBeUndefined();
    expect(await store.get(value.id)).toEqual(value);
    const raw = await redis.hgetall(`phub:auth:subject-link:challenge:${value.id}`);
    expect(raw.purpose).toBe(SUBJECT_LINK_PURPOSE);
    expect(raw).not.toHaveProperty('phone');
    expect(raw).not.toHaveProperty('phoneE164');
    expect(JSON.stringify(raw)).not.toContain('+7');
    expect(await redis.ttl(`phub:auth:subject-link:challenge:${value.id}`)).toBeGreaterThan(0);
  });

  it('atomically claims, bounds attempts and removes challenge/cooldown on cleanup', async () => {
    const value = challenge();
    expect(await store.put(value, 60, 30)).toBe(true);
    expect(await store.claim(value.id, 'claim-one', 30)).toBe(true);
    expect(await store.claim(value.id, 'claim-two', 30)).toBe(false);
    await store.release(value.id, 'wrong-claim');
    expect(await store.claim(value.id, 'claim-two', 30)).toBe(false);
    await store.release(value.id, 'claim-one');
    expect(await store.claim(value.id, 'claim-two', 30)).toBe(true);
    expect(await store.incrementAttempts(value.id)).toBe(1);
    await store.delete(value.id);
    expect(await store.get(value.id)).toBeUndefined();
    expect(await store.incrementAttempts(value.id)).toBeUndefined();
    expect(await store.put(value, 60, 30)).toBe(true);
  });
});
