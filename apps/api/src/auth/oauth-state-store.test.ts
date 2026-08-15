import type Redis from 'ioredis';
import { describe, expect, it, vi } from 'vitest';

import {
  MemoryVivaOAuthStateStore,
  RedisVivaOAuthStateStore,
  type VivaOAuthStart,
} from './oauth-state-store.js';

function oauthStart(state: string, browserNonce = `nonce-${state}`): VivaOAuthStart {
  return {
    state: {
      state,
      tenantKey: 'local-padel',
      provider: 'yandex',
      codeVerifier: `verifier-${state}`,
      publicOfferAccepted: true,
      personalDataPolicyAccepted: true,
      publicOfferVersion: 'offer-v1',
      personalDataPolicyVersion: 'privacy-v1',
      browserNonceHash: 'a'.repeat(64),
      recoveryUserId: '49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca',
      recoverySessionFamilyId: '5509e0c3-ab9f-48b3-9bfa-0900726e1f63',
    },
    browserNonce,
  };
}

describe('Viva OAuth state stores', () => {
  it('expires memory reservations and their one-time state with Redis-equivalent TTL semantics', async () => {
    let now = 1_000;
    const store = new MemoryVivaOAuthStateStore(() => now);
    const first = oauthStart('state-first');
    const replacement = oauthStart('state-replacement');

    await expect(
      store.reserveStart({
        commandKey: 'command-key',
        requestHash: 'request-hash',
        start: first,
        ttlSeconds: 5,
      }),
    ).resolves.toEqual({ outcome: 'created', start: first });
    await expect(
      store.reserveStart({
        commandKey: 'command-key',
        requestHash: 'request-hash',
        start: replacement,
        ttlSeconds: 5,
      }),
    ).resolves.toEqual({ outcome: 'replay', start: first });
    await expect(
      store.reserveStart({
        commandKey: 'command-key',
        requestHash: 'different-request-hash',
        start: replacement,
        ttlSeconds: 5,
      }),
    ).resolves.toEqual({ outcome: 'conflict' });

    now += 5_000;
    await expect(store.take(first.state.state)).resolves.toBeUndefined();
    await expect(
      store.reserveStart({
        commandKey: 'command-key',
        requestHash: 'different-request-hash',
        start: replacement,
        ttlSeconds: 5,
      }),
    ).resolves.toEqual({ outcome: 'created', start: replacement });
    await expect(store.take(replacement.state.state)).resolves.toEqual(replacement.state);
    await expect(store.take(replacement.state.state)).resolves.toBeUndefined();
  });

  it('does not consume browser-bound state when the callback binding is wrong', async () => {
    const store = new MemoryVivaOAuthStateStore();
    const start = oauthStart('browser-bound-state');
    await store.put(start.state, 300);

    await expect(
      store.claimCallback({
        state: start.state.state,
        tenantKey: start.state.tenantKey,
        browserNonceHash: 'b'.repeat(64),
      }),
    ).resolves.toEqual({ outcome: 'mismatch' });
    await expect(
      store.claimCallback({
        state: start.state.state,
        tenantKey: start.state.tenantKey,
        browserNonceHash: start.state.browserNonceHash,
      }),
    ).resolves.toEqual({ outcome: 'claimed', state: start.state });
    await expect(
      store.claimCallback({
        state: start.state.state,
        tenantKey: start.state.tenantKey,
        browserNonceHash: start.state.browserNonceHash,
      }),
    ).resolves.toEqual({ outcome: 'missing' });
  });

  it('atomically replays a Redis reservation from the browser-bound v3 namespace', async () => {
    let reservedCommand: string | undefined;
    const stateKeys: string[] = [];
    const ttlArguments: string[] = [];
    const evalMock = vi.fn((...args: unknown[]): Promise<unknown> => {
      const stateKey = args[3];
      const proposedCommand = args[4];
      const ttl = args[6];
      if (
        typeof stateKey !== 'string' ||
        typeof proposedCommand !== 'string' ||
        typeof ttl !== 'string'
      ) {
        return Promise.reject(new Error('Unexpected Redis eval arguments'));
      }
      stateKeys.push(stateKey);
      ttlArguments.push(ttl);
      if (reservedCommand) return Promise.resolve(['replay', reservedCommand]);
      reservedCommand = proposedCommand;
      return Promise.resolve(['created', proposedCommand]);
    });
    const redis = { eval: evalMock } as unknown as Redis;
    const store = new RedisVivaOAuthStateStore(redis);
    const first = oauthStart('redis-state-first');

    await expect(
      store.reserveStart({
        commandKey: 'redis-command',
        requestHash: 'redis-request',
        start: first,
        ttlSeconds: 300,
      }),
    ).resolves.toEqual({ outcome: 'created', start: first });
    await expect(
      store.reserveStart({
        commandKey: 'redis-command',
        requestHash: 'redis-request',
        start: oauthStart('redis-state-ignored'),
        ttlSeconds: 300,
      }),
    ).resolves.toEqual({ outcome: 'replay', start: first });
    await expect(
      store.reserveStart({
        commandKey: 'redis-command',
        requestHash: 'different-redis-request',
        start: oauthStart('redis-state-conflict'),
        ttlSeconds: 300,
      }),
    ).resolves.toEqual({ outcome: 'conflict' });

    expect(stateKeys).toHaveLength(3);
    expect(stateKeys.every((key) => key.startsWith('phub:auth:v3:viva-oauth:'))).toBe(true);
    expect(stateKeys.every((key) => !key.startsWith('phub:auth:viva-oauth:'))).toBe(true);
    expect(ttlArguments).toEqual(['300', '300', '300']);
  });

  it('consumes a pre-release state only after the v3 and v2 lookups miss', async () => {
    const requestedKeys: string[] = [];
    const legacyState = {
      state: 'legacy-state',
      tenantKey: 'local-padel',
      provider: 'yandex',
      codeVerifier: 'legacy-verifier',
      publicOfferAccepted: true,
      personalDataPolicyAccepted: true,
      publicOfferVersion: 'offer-v1',
      personalDataPolicyVersion: 'privacy-v1',
      recoveryUserId: '49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca',
    };
    const getdelMock = vi.fn((key: string): Promise<string | null> => {
      requestedKeys.push(key);
      return Promise.resolve(requestedKeys.length < 3 ? null : JSON.stringify(legacyState));
    });
    const redis = { getdel: getdelMock } as unknown as Redis;
    const store = new RedisVivaOAuthStateStore(redis);

    await expect(store.take(legacyState.state)).resolves.toEqual(legacyState);
    expect(requestedKeys).toEqual([
      'phub:auth:v3:viva-oauth:legacy-state',
      'phub:auth:v2:viva-oauth:legacy-state',
      'phub:auth:viva-oauth:legacy-state',
    ]);
  });

  it('claims a matching callback atomically across the versioned state namespaces', async () => {
    const start = oauthStart('redis-callback-state');
    const evalMock = vi.fn(() => Promise.resolve(['claimed', JSON.stringify(start.state)]));
    const redis = { eval: evalMock } as unknown as Redis;
    const store = new RedisVivaOAuthStateStore(redis);

    await expect(
      store.claimCallback({
        state: start.state.state,
        tenantKey: start.state.tenantKey,
        browserNonceHash: start.state.browserNonceHash,
      }),
    ).resolves.toEqual({ outcome: 'claimed', state: start.state });
    expect(evalMock).toHaveBeenCalledWith(
      expect.stringContaining("return {'claimed', encoded}"),
      3,
      'phub:auth:v3:viva-oauth:redis-callback-state',
      'phub:auth:v2:viva-oauth:redis-callback-state',
      'phub:auth:viva-oauth:redis-callback-state',
      'redis-callback-state',
      'local-padel',
      'a'.repeat(64),
    );
  });
});
