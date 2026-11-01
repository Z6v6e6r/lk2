// @vitest-environment jsdom
import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createBrowserAuthGateway } from './auth-gateway.js';
import {
  QuarterCreateAttempts,
  quarterStorageKey,
  quarterOperationId,
  quarterDraftId,
  type QuarterCustody,
} from './quarter-create-attempt.js';
import type { CreateGameAttemptLockManager } from './create-game-attempt.js';
const principal = {
  tenantId: '11111111-1111-4111-8111-000000000001',
  userId: '11111111-1111-4111-8111-000000000002',
};
const input = {
  stationId: '11111111-1111-4111-8111-000000000003',
  courtId: '11111111-1111-4111-8111-000000000004',
  startsAt: '2030-01-01T12:00:00.000Z',
  subscriptionId: '11111111-1111-4111-8111-000000000005',
};
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const locks: CreateGameAttemptLockManager = {
  request: async (_n, _o, fn) => {
    await Promise.resolve();
    return fn();
  },
};
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  vi.stubGlobal('crypto', webcrypto);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
async function setup(mode: 'queued' | 'capability' | 'ack') {
  const revoke = deferred<Response>(),
    capability = deferred<Response>(),
    ack = deferred<Response>();
  const calls: { url: string; method: string }[] = [];
  const gateway = createBrowserAuthGateway({
    baseUrl: 'https://api.padlhub.test/',
    tenantKey: 'padlhub',
    appVersion: 'test',
    fetchImplementation: async (raw, init) => {
      await Promise.resolve();
      const url = typeof raw === 'string' ? raw : raw instanceof URL ? raw.toString() : raw.url,
        method = init?.method ?? 'GET';
      calls.push({ url, method });
      if (url.endsWith('/auth/session/refresh'))
        return Response.json({
          accessToken: 'synthetic-padlhub-token',
          tokenType: 'Bearer',
          expiresAt: '2099-01-01T00:00:00.000Z',
          user: { id: principal.userId, displayName: 'Synthetic' },
          context: {
            ...principal,
            displayName: 'Synthetic',
            phoneLast4: '0000',
            roles: ['client'],
            permissions: ['games.play'],
          },
        });
      if (url.endsWith('/auth/session') && method === 'DELETE') return revoke.promise;
      if (url.endsWith('/game-create-operations/capability'))
        return mode === 'capability'
          ? capability.promise
          : Response.json({ contractVersion: 1, available: true });
      if (url.endsWith('/game-create-operations') && method === 'POST') return ack.promise;
      return new Response(null, { status: 404 });
    },
  });
  await gateway.restoreSession();
  expect(gateway.quarterCreatePrincipal?.()).toContain(
    `${principal.tenantId}:${principal.userId}:`,
  );
  return { gateway, calls, revoke, capability, ack };
}
it.each([204, 500])(
  'actual synchronous logout fences queued lock even while revocation status%s is unresolved/failed',
  async (status) => {
    const h = await setup('queued'),
      queue = deferred<void>();
    const queued: CreateGameAttemptLockManager = {
      request: async (_n, _o, fn) => {
        await queue.promise;
        return fn();
      },
    };
    const attempts = new QuarterCreateAttempts(
      principal,
      localStorage,
      queued,
      h.gateway,
      () => true,
    );
    const pending = attempts.submit(input);
    const assertion = expect(pending).rejects.toThrow('AUTH_PRINCIPAL_CHANGED');
    const logout = h.gateway.logout().catch(() => undefined);
    expect(h.gateway.quarterCreatePrincipal?.()).toBeNull();
    queue.resolve();
    await assertion;
    expect(localStorage.getItem(quarterStorageKey(principal))).toBeNull();
    expect(h.calls.filter((x) => x.url.includes('/game-create-operations'))).toEqual([]);
    h.revoke.resolve(new Response(null, { status }));
    await logout;
    await expect(h.gateway.createQuarterGame?.(input, 'synthetic-original-key')).rejects.toThrow(
      'AUTH_PRINCIPAL_CHANGED',
    );
    expect(h.calls.filter((x) => x.url.includes('/game-create-operations'))).toEqual([]);
  },
);
it('actual deferred capability cannot create custody or POST after logout begins', async () => {
  const h = await setup('capability'),
    attempts = new QuarterCreateAttempts(principal, localStorage, locks, h.gateway, () => true);
  const pending = attempts.submit(input);
  const assertion = expect(pending).rejects.toThrow('AUTH_PRINCIPAL_CHANGED');
  await vi.waitFor(() => expect(h.calls.some((x) => x.url.endsWith('/capability'))).toBe(true));
  const logout = h.gateway.logout().catch(() => undefined);
  h.capability.resolve(Response.json({ contractVersion: 1, available: true }));
  await assertion;
  expect(localStorage.getItem(quarterStorageKey(principal))).toBeNull();
  expect(
    h.calls.filter((x) => x.method === 'POST' && x.url.endsWith('/game-create-operations')),
  ).toHaveLength(0);
  h.revoke.resolve(new Response(null, { status: 204 }));
  await logout;
});
it('actual late CREATE ACK during pending logout retains byte-identical original custody and refuses recovery', async () => {
  const h = await setup('ack'),
    attempts = new QuarterCreateAttempts(principal, localStorage, locks, h.gateway, () => true);
  const pending = attempts.submit(input);
  const assertion = expect(pending).rejects.toThrow('AUTH_PRINCIPAL_CHANGED');
  await vi.waitFor(() =>
    expect(
      h.calls.some((x) => x.method === 'POST' && x.url.endsWith('/game-create-operations')),
    ).toBe(true),
  );
  const original = localStorage.getItem(quarterStorageKey(principal))!,
    c = JSON.parse(original) as QuarterCustody;
  const logout = h.gateway.logout().catch(() => undefined);
  const hash =
    'sha256:' +
    Array.from(
      new Uint8Array(await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(c.key))),
    )
      .map((x) => x.toString(16).padStart(2, '0'))
      .join('');
  h.ack.resolve(
    Response.json({
      contractVersion: 1,
      request: c.request,
      keySha256: hash,
      operation: {
        id: await quarterOperationId(c),
        draftId: await quarterDraftId(c),
        status: 'CONFIRMED',
      },
      gameProjection: { status: 'PENDING', gameId: null },
      registration: { status: 'UNKNOWN', asOf: null },
      reason: null,
    }),
  );
  await assertion;
  expect(localStorage.getItem(quarterStorageKey(principal))).toBe(original);
  await expect(attempts.recover()).rejects.toThrow('AUTH_PRINCIPAL_CHANGED');
  expect(h.calls.filter((x) => x.url.includes('/reconcile'))).toHaveLength(0);
  h.revoke.resolve(new Response(null, { status: 204 }));
  await logout;
});
