import { randomUUID } from 'node:crypto';

import Redis from 'ioredis';
import { afterAll, describe, expect, it, vi } from 'vitest';

import { RedisPasswordLoginLimiter } from './password-login-limiter.js';

describe('password admission wiring', () => {
  it('uses independent opaque account/IP/service keys', async () => {
    const evalFn = vi.fn().mockResolvedValue(1);
    const limiter = new RedisPasswordLoginLimiter({ eval: evalFn }, 'synthetic-limiter-secret');
    expect(await limiter.allow('synthetic-tenant', 'player@example.test', '192.0.2.1')).toBe(true);
    await limiter.allow('synthetic-tenant', 'player@example.test', '192.0.2.2');
    await limiter.allow('synthetic-tenant', 'other@example.test', '192.0.2.1');
    const calls = evalFn.mock.calls;
    expect(calls[0]![1]).toBe(3);
    expect(calls[0]![2]).toBe(calls[1]![2]);
    expect(calls[0]![3]).not.toBe(calls[1]![3]);
    expect(calls[0]![3]).toBe(calls[2]![3]);
    expect(calls[0]![2]).not.toBe(calls[2]![2]);
    expect(calls[0]![4]).toBe(calls[2]![4]);
    expect(JSON.stringify(calls)).not.toContain('player@example.test');
    expect(JSON.stringify(calls)).not.toContain('192.0.2.1');
  });
  it('propagates Redis failure and rejects unexpected script results', async () => {
    const evalFn = vi.fn().mockRejectedValue(new Error('synthetic redis failure'));
    const limiter = new RedisPasswordLoginLimiter({ eval: evalFn }, 'synthetic-limiter-secret');
    await expect(limiter.allow('tenant', 'player@example.test', 'ip')).rejects.toThrow();
    evalFn.mockResolvedValue('unexpected');
    await expect(limiter.allow('tenant', 'player@example.test', 'ip')).rejects.toThrow(
      'AUTH_PASSWORD_ADMISSION_UNAVAILABLE',
    );
  });
  it('bounds stalled Redis admission before any credential work', async () => {
    vi.useFakeTimers();
    try {
      const limiter = new RedisPasswordLoginLimiter(
        { eval: () => new Promise(() => {}) },
        'synthetic-limiter-secret',
      );
      const assertion = expect(
        limiter.allow('tenant', 'player@example.test', 'ip'),
      ).rejects.toThrow('AUTH_PASSWORD_ADMISSION_UNAVAILABLE');
      await vi.advanceTimersByTimeAsync(1500);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});

function ciRedis() {
  if (
    process.env.GITHUB_ACTIONS !== 'true' ||
    process.env.APP_ENV !== 'ci' ||
    !process.env.REDIS_URL
  )
    return undefined;
  const url = new URL(process.env.REDIS_URL);
  if (
    !['localhost', '127.0.0.1'].includes(url.hostname) ||
    url.port !== '6379' ||
    !['', '/', '/0'].includes(url.pathname)
  )
    throw new Error('PASSWORD_TEST_DISPOSABLE_REDIS_REQUIRED');
  return url.toString();
}
const url = ciRedis();
const suite = url ? describe : describe.skip;
suite('password admission on disposable CI Redis', () => {
  const redis = new Redis(url!, { lazyConnect: true, maxRetriesPerRequest: 1 });
  const ownedKeys = new Set<string>();
  const limiter = new RedisPasswordLoginLimiter(
    {
      eval: async (script: string, numberOfKeys: number, ...keys: string[]) => {
        for (const key of keys) ownedKeys.add(key);
        return redis.eval(script, numberOfKeys, ...keys);
      },
    },
    randomUUID(),
    `phub:auth:password:test-${randomUUID()}`,
  );
  afterAll(async () => {
    if (ownedKeys.size) await redis.del(...ownedKeys);
    redis.disconnect();
  });
  it('blocks one account across different addresses after five admissions', async () => {
    for (let i = 0; i < 5; i++)
      expect(await limiter.allow('tenant-account', 'player@example.test', `192.0.2.${i}`)).toBe(
        true,
      );
    expect(await limiter.allow('tenant-account', 'player@example.test', '192.0.2.99')).toBe(false);
  });
  it('blocks spraying accounts from one address after twenty admissions', async () => {
    for (let i = 0; i < 20; i++)
      expect(await limiter.allow('tenant-spray', `player${i}@example.test`, '192.0.2.1')).toBe(
        true,
      );
    expect(await limiter.allow('tenant-spray', 'next@example.test', '192.0.2.1')).toBe(false);
  });
  it('serializes concurrent attempts against one account atomically', async () => {
    const result = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        limiter.allow('tenant-race', 'player@example.test', `192.0.2.${i}`),
      ),
    );
    expect(result.filter(Boolean)).toHaveLength(5);
  });
  it('sets bounded expiration on every owned counter', async () => {
    for (const key of ownedKeys) expect(await redis.ttl(key)).toBeGreaterThan(0);
  });
  it('enforces a service-wide cap across different tenants and addresses', async () => {
    const key = [...ownedKeys].find((value) => value.endsWith(':global'))!;
    await redis.set(key, '120', 'EX', 60);
    expect(await limiter.allow('another-tenant', 'different@example.test', '192.0.2.199')).toBe(
      false,
    );
  });
});
