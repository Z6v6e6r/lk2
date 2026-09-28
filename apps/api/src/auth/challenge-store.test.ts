import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  MemoryAuthChallengeStore,
  RedisAuthChallengeStore,
  type AuthChallenge,
} from './challenge-store.js';

/**
 * A login challenge creates or switches the web session; a phone-confirmation challenge only proves a
 * phone for the account that is already authenticated. They share the same phone number, so the store
 * keeps them apart by purpose: separate cooldowns, an explicit stored purpose and a fail-closed read for
 * an unknown value. The Redis hash is the only shared state two API processes see, so the round trip is
 * exercised against a minimal in-memory Redis instead of the memory store, which never serializes.
 */
class FakeRedis {
  public readonly hashes = new Map<string, Record<string, string>>();
  public readonly values = new Map<string, string>();

  public set(key: string, value: string, ...args: unknown[]): Promise<'OK' | null> {
    const nx = args.includes('NX');
    if (nx && this.values.has(key)) return Promise.resolve(null);
    this.values.set(key, value);
    return Promise.resolve('OK');
  }

  public hgetall(key: string): Promise<Record<string, string>> {
    return Promise.resolve({ ...(this.hashes.get(key) ?? {}) });
  }

  public del(...keys: string[]): Promise<number> {
    let removed = 0;
    for (const key of keys) {
      if (this.hashes.delete(key) || this.values.delete(key)) removed += 1;
    }
    return Promise.resolve(removed);
  }

  public multi(): {
    hset: (key: string, value: Record<string, string>) => ReturnType<FakeRedis['multi']>;
    expire: (key: string, ttl: number) => ReturnType<FakeRedis['multi']>;
    exec: () => Promise<unknown[]>;
  } {
    const pending: (() => void)[] = [];
    const chain = {
      hset: (key: string, value: Record<string, string>) => {
        pending.push(() => this.hashes.set(key, { ...value }));
        return chain;
      },
      expire: (key: string, ttl: number) => {
        // The fake only needs to record that the TTL was applied to the same key.
        pending.push(() => void ttl);
        return chain;
      },
      exec: () => {
        for (const apply of pending) apply();
        return Promise.resolve([]);
      },
    };
    return chain;
  }
}

function challenge(overrides: Partial<AuthChallenge> = {}): AuthChallenge {
  return {
    id: 'challenge-1',
    purpose: 'LOGIN',
    tenantId: 'tenant-1',
    tenantKey: 'local-padel',
    provider: 'VIVA',
    providerTenantKey: 'viva-tenant',
    phoneE164: '+79990000001',
    attempts: 0,
    expiresAt: '2026-09-18T00:10:00.000Z',
    resendAt: '2026-09-18T00:00:30.000Z',
    ...overrides,
  };
}

describe('Redis auth challenge purpose', () => {
  it('round-trips the purpose and the owning user of a confirmation challenge', async () => {
    const store = new RedisAuthChallengeStore(new FakeRedis() as never);

    await store.put(
      challenge({ id: 'confirm-1', purpose: 'PHONE_CONFIRMATION', userId: 'user-1' }),
      600,
      30,
    );

    await expect(store.get('confirm-1')).resolves.toMatchObject({
      purpose: 'PHONE_CONFIRMATION',
      userId: 'user-1',
    });
  });

  it('reads a challenge written before the purpose existed as a login, so a deploy keeps them valid', async () => {
    const redis = new FakeRedis();
    const store = new RedisAuthChallengeStore(redis as never);
    await store.put(challenge({ id: 'legacy-1' }), 600, 30);
    const stored = redis.hashes.get('phub:auth:challenge:legacy-1');
    expect(stored).toBeDefined();
    delete stored?.purpose;
    delete stored?.userId;

    await expect(store.get('legacy-1')).resolves.toMatchObject({
      id: 'legacy-1',
      purpose: 'LOGIN',
    });
  });

  it('refuses a challenge whose stored purpose is unknown instead of guessing one', async () => {
    const redis = new FakeRedis();
    const store = new RedisAuthChallengeStore(redis as never);
    await store.put(challenge({ id: 'broken-1' }), 600, 30);
    redis.hashes.set('phub:auth:challenge:broken-1', {
      ...(redis.hashes.get('phub:auth:challenge:broken-1') ?? {}),
      purpose: 'SESSION_UPGRADE',
    });

    await expect(store.get('broken-1')).resolves.toBeUndefined();
  });

  it('keeps login and confirmation cooldowns separate for one phone', async () => {
    const store = new RedisAuthChallengeStore(new FakeRedis() as never);

    await expect(store.put(challenge({ id: 'login-1' }), 600, 30)).resolves.toBe(true);
    // A fresh login code must not block a confirmation request for the same phone...
    await expect(
      store.put(
        challenge({ id: 'confirm-1', purpose: 'PHONE_CONFIRMATION', userId: 'user-1' }),
        600,
        30,
      ),
    ).resolves.toBe(true);
    // ...while a second login challenge for that phone is still inside its cooldown.
    await expect(store.put(challenge({ id: 'login-2' }), 600, 30)).resolves.toBe(false);
    await expect(
      store.put(
        challenge({ id: 'confirm-2', purpose: 'PHONE_CONFIRMATION', userId: 'user-1' }),
        600,
        30,
      ),
    ).resolves.toBe(false);
  });

  it('clears the cooldown a pre-purpose process wrote under the old key shape', async () => {
    const redis = new FakeRedis();
    const store = new RedisAuthChallengeStore(redis as never);
    await store.put(challenge({ id: 'legacy-cooldown-1' }), 600, 30);
    const legacyKey = `phub:auth:challenge:cooldown:tenant-1:${createHash('sha256')
      .update('+79990000001')
      .digest('base64url')}`;
    redis.values.set(legacyKey, 'older-challenge');

    await store.delete('legacy-cooldown-1');

    expect(redis.values.has(legacyKey)).toBe(false);
    // A confirmation challenge must not touch the login cooldown shape.
    await store.put(
      challenge({ id: 'confirm-legacy-1', purpose: 'PHONE_CONFIRMATION', userId: 'user-1' }),
      600,
      30,
    );
    redis.values.set(legacyKey, 'older-challenge');
    await store.delete('confirm-legacy-1');
    expect(redis.values.has(legacyKey)).toBe(true);
  });

  it('releases only the cooldown of the deleted purpose', async () => {
    const store = new RedisAuthChallengeStore(new FakeRedis() as never);
    await store.put(challenge({ id: 'login-1' }), 600, 30);
    await store.put(
      challenge({ id: 'confirm-1', purpose: 'PHONE_CONFIRMATION', userId: 'user-1' }),
      600,
      30,
    );

    await store.delete('confirm-1');

    await expect(
      store.put(
        challenge({ id: 'confirm-2', purpose: 'PHONE_CONFIRMATION', userId: 'user-1' }),
        600,
        30,
      ),
    ).resolves.toBe(true);
    await expect(store.put(challenge({ id: 'login-2' }), 600, 30)).resolves.toBe(false);
  });
});

describe('memory auth challenge purpose', () => {
  it('separates the purposes and returns the stored challenge unchanged', async () => {
    const store = new MemoryAuthChallengeStore();
    await expect(store.put(challenge({ id: 'login-1' }), 600, 30)).resolves.toBe(true);
    await expect(
      store.put(
        challenge({ id: 'confirm-1', purpose: 'PHONE_CONFIRMATION', userId: 'user-1' }),
        600,
        30,
      ),
    ).resolves.toBe(true);
    await expect(store.put(challenge({ id: 'login-2' }), 600, 30)).resolves.toBe(false);

    await expect(store.get('confirm-1')).resolves.toMatchObject({
      purpose: 'PHONE_CONFIRMATION',
      userId: 'user-1',
    });
    await store.delete('confirm-1');
    await expect(store.get('confirm-1')).resolves.toBeUndefined();
    await expect(
      store.put(
        challenge({ id: 'confirm-2', purpose: 'PHONE_CONFIRMATION', userId: 'user-1' }),
        600,
        30,
      ),
    ).resolves.toBe(true);
  });
});
