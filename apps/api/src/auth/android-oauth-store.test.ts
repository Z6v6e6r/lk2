import { randomBytes, randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import { expect, it } from 'vitest';
import {
  MemoryAndroidOAuthStore,
  RedisAndroidOAuthStore,
  type AndroidOAuthStore,
} from './android-oauth-store.js';

async function atomicContract(store: AndroidOAuthStore) {
  const opaque = () => randomBytes(32).toString('base64url');
  const launch = {
    client: 'ANDROID_NATIVE' as const,
    code: opaque(),
    tenantKey: 'synthetic-tenant',
    codeChallenge: opaque(),
    clientState: opaque(),
  };
  const start = { commandKey: randomUUID(), requestHash: opaque(), launch };
  const starts = await Promise.all(
    Array.from({ length: 6 }, () =>
      store.reserveStart({ ...start, launch: { ...launch, code: opaque() } }),
    ),
  );
  expect(starts.every((value) => JSON.stringify(value) === JSON.stringify(starts[0]))).toBe(true);
  const first = starts[0];
  if (!first || 'conflict' in first) throw new Error('Missing launch');
  expect(await store.reserveStart({ ...start, requestHash: opaque() })).toEqual({ conflict: true });
  expect(await store.takeLaunch(first.launch.code, 'other-tenant')).toBeUndefined();
  const taken = await Promise.all([
    store.takeLaunch(first.launch.code, launch.tenantKey),
    store.takeLaunch(first.launch.code, launch.tenantKey),
  ]);
  expect(taken.filter(Boolean)).toHaveLength(1);
  const code = opaque();
  const handoff = {
    client: launch.client,
    codeChallenge: launch.codeChallenge,
    clientState: launch.clientState,
    tenantKey: launch.tenantKey,
    tenantId: randomUUID(),
    userId: randomUUID(),
    sessionId: randomUUID(),
  };
  await store.putHandoff(code, handoff);
  const claim = {
    code,
    codeChallenge: handoff.codeChallenge,
    clientState: handoff.clientState,
    tenantKey: handoff.tenantKey,
    idempotencyKey: randomUUID(),
  };
  expect(await store.claimHandoff({ ...claim, codeChallenge: opaque() })).toEqual({
    rejected: 'missing',
  });
  const keys = Array.from({ length: 12 }, () => randomUUID());
  const race = await Promise.all(
    keys.map((idempotencyKey) => store.claimHandoff({ ...claim, idempotencyKey })),
  );
  const winner = race.findIndex((value) => 'handoff' in value);
  expect(race.filter((value) => 'handoff' in value)).toHaveLength(1);
  const idempotencyKey = keys[winner];
  if (!idempotencyKey) throw new Error('Missing winner');
  expect(await store.claimHandoff({ ...claim, idempotencyKey })).toEqual({ handoff });
}

it('atomically reserves/consumes launches and claims exactly one exchange key', async () => {
  await atomicContract(new MemoryAndroidOAuthStore());
});

it('expires launch reservations without extending their original lifetime', async () => {
  let now = 1000;
  const store = new MemoryAndroidOAuthStore(() => now);
  const launch = {
    client: 'ANDROID_NATIVE' as const,
    code: 'code',
    tenantKey: 'test',
    codeChallenge: 'challenge',
    clientState: 'state',
  };
  const input = { commandKey: 'key', requestHash: 'hash', launch };
  await store.reserveStart(input);
  now += 299_000;
  await store.reserveStart(input);
  now += 1_001;
  expect(await store.takeLaunch(launch.code, launch.tenantKey)).toBeUndefined();
});

// The PR test job supplies a disposable Redis service. Never connect to a shared/live target.
const redisUrl =
  process.env.CI === 'true' ? process.env.REDIS_URL : process.env.ANDROID_OAUTH_TEST_REDIS_URL;
it.skipIf(!redisUrl)('executes the concurrency contract against real Redis Lua', async () => {
  if (!redisUrl || !['localhost', '127.0.0.1', '[::1]'].includes(new URL(redisUrl).hostname))
    throw new Error('Disposable loopback Redis required');
  const redis = new Redis(redisUrl, { maxRetriesPerRequest: 0, connectTimeout: 2000 });
  try {
    await atomicContract(new RedisAndroidOAuthStore(redis));
  } finally {
    redis.disconnect();
  }
});
