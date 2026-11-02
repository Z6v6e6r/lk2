import { expect, it, vi } from 'vitest';
import { PadlHubApiClient, type AuthenticatedSession } from './index.js';
const a: AuthenticatedSession = {
  accessToken: 'synthetic-a',
  tokenType: 'Bearer',
  expiresAt: '2099-01-01T00:00:00.000Z',
  user: { id: '11111111-1111-4111-8111-111111111111', displayName: 'Synthetic A' },
  context: {
    userId: '11111111-1111-4111-8111-111111111111',
    tenantId: '22222222-2222-4222-8222-222222222222',
    displayName: 'Synthetic A',
    phoneLast4: '0001',
    roles: [],
    permissions: [],
  },
};
const b: AuthenticatedSession = {
  ...a,
  accessToken: 'synthetic-b',
  user: { ...a.user, id: '33333333-3333-4333-8333-333333333333' },
  context: { ...a.context, userId: '33333333-3333-4333-8333-333333333333' },
};
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function client(fetchImplementation: typeof fetch) {
  return new PadlHubApiClient({
    baseUrl: 'https://api.invalid',
    tenantKey: 'synthetic',
    platform: 'web',
    appVersion: 'test',
    fetchImplementation,
  });
}
const urlOf = (raw: Parameters<typeof fetch>[0]) =>
  raw instanceof Request ? raw.url : raw.toString();
const observe = (promise: Promise<unknown>) =>
  promise.then(
    (value) => ({ value }),
    (error) => ({ error: error as Error }),
  );
const verify = (c: PadlHubApiClient) => c.verifyAuthChallenge(a.user.id, { code: '0000' });

it.each(['success', 'failure'] as const)(
  'does not let a retired read refresh %s overwrite a new verified session',
  async (outcome) => {
    const late = deferred<Response>();
    let refreshes = 0,
      reads = 0;
    const c = client(
      vi.fn<typeof fetch>((raw) => {
        const url = urlOf(raw);
        if (url.endsWith('/auth/session/refresh'))
          return ++refreshes === 1 ? Promise.resolve(Response.json(a)) : late.promise;
        if (url.endsWith('/verify')) return Promise.resolve(Response.json(b));
        if (url.endsWith('/auth/session'))
          return Promise.resolve(new Response(null, { status: 204 }));
        reads++;
        return Promise.resolve(new Response(null, { status: 401 }));
      }),
    );
    await c.refreshSession();
    const old = observe(c.getUserContext());
    await vi.waitFor(() => expect(refreshes).toBe(2));
    await c.revokeSession();
    await verify(c);
    if (outcome === 'success') late.resolve(Response.json(a));
    else late.reject(new TypeError('synthetic lost reply'));
    expect(await old).toMatchObject({ error: { code: 'AUTH_PRINCIPAL_CHANGED' } });
    expect(c.getAccessToken()).toBe(b.accessToken);
    expect(reads).toBe(1);
    expect(refreshes).toBe(2);
  },
);
it.each(['clear', 'same-token'] as const)(
  'retires refresh even for %s without token inequality',
  async (mode) => {
    const late = deferred<Response>();
    const c = client(() => late.promise);
    c.setAccessToken(a.accessToken);
    const old = observe(c.refreshSession());
    if (mode === 'clear') c.clearAccessToken();
    else c.setAccessToken(a.accessToken);
    late.resolve(Response.json(a));
    expect(await old).toMatchObject({ error: { code: 'AUTH_PRINCIPAL_CHANGED' } });
    expect(c.getAccessToken()).toBe(mode === 'clear' ? undefined : a.accessToken);
  },
);
it.each(['user', 'tenant', 'inconsistent'] as const)(
  'rejects changed refresh %s before read replay and blocks later automatic adoption',
  async (changed) => {
    let refreshes = 0,
      reads = 0;
    const changedSession =
      changed === 'user'
        ? b
        : changed === 'tenant'
          ? { ...a, context: { ...a.context, tenantId: b.user.id } }
          : { ...a, user: b.user };
    const c = client((raw) => {
      const url = urlOf(raw);
      if (url.endsWith('/auth/session/refresh'))
        return Promise.resolve(Response.json(++refreshes === 1 ? a : changedSession));
      reads++;
      return Promise.resolve(new Response(null, { status: 401 }));
    });
    await c.refreshSession();
    await expect(c.getUserContext()).rejects.toMatchObject({ code: 'AUTH_PRINCIPAL_CHANGED' });
    expect(c.getAccessToken()).toBeUndefined();
    expect(reads).toBe(1);
    await expect(c.getUserContext()).rejects.toMatchObject({ code: 'AUTH_PRINCIPAL_CHANGED' });
    expect(refreshes).toBe(2);
  },
);
it.each([200, 401])(
  'fences a late protected %s response before refresh or returning old account data',
  async (status) => {
    const late = deferred<Response>();
    let calls = 0;
    const c = client(() => {
      calls++;
      return late.promise;
    });
    c.setAccessToken(a.accessToken);
    const old = observe(c.getUserContext());
    c.setAccessToken(b.accessToken);
    late.resolve(Response.json({ synthetic: 'old-account' }, { status }));
    expect(await old).toMatchObject({ error: { code: 'AUTH_PRINCIPAL_CHANGED' } });
    expect(c.getAccessToken()).toBe(b.accessToken);
    expect(calls).toBe(1);
  },
);
it.each(['success', 'failure'] as const)(
  'late logout %s neither clears nor retries against a replacement session',
  async (outcome) => {
    const late = deferred<Response>();
    let logoutCalls = 0;
    const c = client((raw) => {
      if (urlOf(raw).endsWith('/verify')) return Promise.resolve(Response.json(b));
      logoutCalls++;
      return late.promise;
    });
    c.setAccessToken(a.accessToken);
    const old = observe(c.revokeSession());
    await verify(c);
    if (outcome === 'success') late.resolve(new Response(null, { status: 204 }));
    else late.reject(new TypeError('synthetic'));
    expect(await old).toMatchObject({ error: { code: 'AUTH_PRINCIPAL_CHANGED' } });
    expect(c.getAccessToken()).toBe(b.accessToken);
    expect(logoutCalls).toBe(1);
  },
);
it('late verification cannot install a session after explicit retirement', async () => {
  const late = deferred<Response>();
  const c = client(() => late.promise);
  const old = observe(verify(c));
  c.clearAccessToken();
  late.resolve(Response.json(a));
  expect(await old).toMatchObject({ error: { code: 'AUTH_PRINCIPAL_CHANGED' } });
  expect(c.getAccessToken()).toBeUndefined();
});

it.each([200, 401])(
  'fences late authenticated media %s before refresh or exposing bytes',
  async (status) => {
    const late = deferred<Response>();
    let calls = 0;
    const c = client(() => {
      calls++;
      return late.promise;
    });
    c.setAccessToken(a.accessToken);
    const old = observe(c.downloadConversationMedia(a.user.id, b.user.id));
    c.setAccessToken(b.accessToken);
    late.resolve(new Response('synthetic-old-bytes', { status }));
    expect(await old).toMatchObject({ error: { code: 'AUTH_PRINCIPAL_CHANGED' } });
    expect(c.getAccessToken()).toBe(b.accessToken);
    expect(calls).toBe(1);
  },
);
it('a retired refresh finalizer does not clear a replacement refresh promise', async () => {
  const first = deferred<Response>(),
    second = deferred<Response>();
  let calls = 0;
  const c = client(() => (++calls === 1 ? first.promise : second.promise));
  const old = observe(c.refreshSession());
  c.clearAccessToken();
  const current = c.refreshSession();
  first.resolve(Response.json(a));
  expect(await old).toMatchObject({ error: { code: 'AUTH_PRINCIPAL_CHANGED' } });
  expect(c.refreshSession()).toBe(current);
  second.resolve(Response.json(b));
  await expect(current).resolves.toEqual(b);
  expect(c.getAccessToken()).toBe(b.accessToken);
  expect(calls).toBe(2);
});
