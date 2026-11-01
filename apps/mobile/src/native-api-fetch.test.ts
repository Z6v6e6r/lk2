import { describe, expect, it, vi } from 'vitest';
import { createNativeApiFetch, type AndroidSessionPlugin } from './native-api-fetch.js';

const config = {
  apiBaseUrl: 'https://lk2.padlhub.su',
  tenantKey: 'local-padel',
  appVersion: 'test',
};
const root = `${config.apiBaseUrl}/user/api/v1/${config.tenantKey}`;
const result = (status = 200) => ({
  status,
  headers: { 'content-type': 'application/json', 'set-cookie': 'synthetic-not-for-JS' },
  body: btoa('{"ok":true}'),
});
function plugin() {
  return {
    configuration: vi.fn().mockResolvedValue(config),
    request: vi.fn<AndroidSessionPlugin['request']>().mockResolvedValue(result()),
  };
}

describe('Android native bridge adapter', () => {
  it('does not upload an attachment cancelled while Blob conversion was pending', async () => {
    const native = plugin();
    const controller = new AbortController();
    let release!: (value: ArrayBuffer) => void;
    const blob = new Blob(['synthetic']);
    vi.spyOn(blob, 'arrayBuffer').mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const pending = createNativeApiFetch(config, native)(
      `${root}/conversations/11111111-1111-4111-8111-111111111111/media/22222222-2222-4222-8222-222222222222/bytes`,
      {
        method: 'PUT',
        body: blob,
        signal: controller.signal,
      },
    );
    controller.abort();
    release(new ArrayBuffer(1));
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(native.request).not.toHaveBeenCalled();
  });
  it('resolves account and nested avatars against the API while preserving account data and routes', async () => {
    const native = plugin();
    const observe = vi.fn();
    const photo = '/public/api/v1/media/profile-photos/tenant/photo';
    const account = {
      userId: 'synthetic-account',
      displayName: 'Анна Петрова',
      firstName: 'Анна',
      lastName: 'Петрова',
      phoneLast4: '0001',
      balanceMinor: 54000,
      currency: 'RUB',
      level: { label: 'C+', value: 3.8, assessmentRequired: false },
      avatarUrl: photo,
      participants: [{ avatarUrl: photo, route: '/profile/synthetic-account' }],
    };
    native.request.mockResolvedValue({
      ...result(),
      body: Buffer.from(JSON.stringify(account)).toString('base64'),
    });
    const response = await createNativeApiFetch(
      config,
      native,
      undefined,
      undefined,
      observe,
    )(`${root}/profile`);
    expect(await response.json()).toEqual({
      ...account,
      avatarUrl: config.apiBaseUrl + photo,
      participants: [{ avatarUrl: config.apiBaseUrl + photo, route: '/profile/synthetic-account' }],
    });
    expect(native.request).toHaveBeenCalledOnce();
    expect(observe).toHaveBeenCalledWith({ section: 'profile', failure: null });
  });

  it('uses only the native plugin and strips credential response headers', async () => {
    const native = plugin();
    const response = await createNativeApiFetch(config, native)(`${root}/profile`, {
      credentials: 'include',
      headers: { Authorization: 'Bearer synthetic-access' },
    });
    expect(native.request).toHaveBeenCalledWith({
      path: '/user/api/v1/local-padel/profile',
      method: 'GET',
      headers: { authorization: 'Bearer synthetic-access' },
    });
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(await response.json()).toEqual({ ok: true });
  });
  it.each([
    [503, 'application/json', '{"avatarUrl":"/error","code":"UNAVAILABLE"}'],
    [200, 'text/plain', '/public/api/v1/media/photo'],
    [200, 'application/json', '{invalid'],
  ])('preserves error and non-JSON bodies (%s, %s)', async (status, contentType, body) => {
    const native = plugin();
    native.request.mockResolvedValue({
      status,
      headers: { 'Content-Type': contentType },
      body: btoa(body),
    });
    const response = await createNativeApiFetch(config, native)(`${root}/profile`);
    expect(response.status).toBe(status);
    expect(await response.text()).toBe(body);
  });
  it.each([
    'https://api.vivacrm.invalid/end-user/api/profile',
    `${config.apiBaseUrl}/user/api/v1/other-tenant/profile`,
    `${config.apiBaseUrl}/user/api/v1/local-padel-evil/profile`,
    `${root}/../profile`,
    `${root}/%2e%2e/profile`,
    `${root}/profile#secret`,
  ])('rejects a foreign or ambiguous URL before entering native code: %s', async (url) => {
    const native = plugin();
    await expect(createNativeApiFetch(config, native)(url)).rejects.toThrow();
    expect(native.request).not.toHaveBeenCalled();
  });
  it('does not accept JS cookies or initiate an already aborted operation', async () => {
    const native = plugin();
    const fetch = createNativeApiFetch(config, native);
    await expect(fetch(`${root}/profile`, { headers: { Cookie: 'synthetic' } })).rejects.toThrow();
    await expect(fetch(`${root}/profile`, { signal: AbortSignal.abort() })).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(native.request).not.toHaveBeenCalled();
  });
  it('passes raw chat-media bytes only through the reviewed native relay as internal base64', async () => {
    const native = plugin();
    const observe = vi.fn();
    const conversationId = '00000000-0000-4000-8000-000000000010';
    const mediaId = '00000000-0000-4000-8000-000000000011';
    const bytes = new Uint8Array([0, 1, 2, 250, 255]);
    await createNativeApiFetch(
      config,
      native,
      undefined,
      undefined,
      observe,
    )(`${root}/conversations/${conversationId}/media/${mediaId}/bytes`, {
      method: 'PUT',
      headers: {
        Authorization: 'Bearer synthetic-access',
        'Idempotency-Key': '00000000-0000-4000-8000-000000000012',
      },
      body: bytes,
    });
    expect(native.request).toHaveBeenCalledWith(
      expect.objectContaining({
        path: `/user/api/v1/local-padel/conversations/${conversationId}/media/${mediaId}/bytes`,
        method: 'PUT',
        bodyBase64: Buffer.from(bytes).toString('base64'),
      }),
    );
    expect(native.request.mock.calls[0]?.[0]).not.toHaveProperty('body');
    expect(observe).not.toHaveBeenCalled();
  });

  it.each([
    [`${root}/profile`, new Uint8Array([1])],
    [
      `${root}/conversations/00000000-0000-4000-8000-000000000010/media/00000000-0000-4000-8000-000000000011/bytes`,
      new Uint8Array(15 * 1024 * 1024 + 1),
    ],
  ])('rejects binary data outside the bounded relay before native code: %s', async (url, body) => {
    const native = plugin();
    await expect(
      createNativeApiFetch(config, native)(url, { method: 'PUT', body }),
    ).rejects.toThrow();
    expect(native.request).not.toHaveBeenCalled();
  });
  it('does not remount on empty startup, but expires an active session once after refresh 401', async () => {
    const native = plugin();
    const expire = vi.fn();
    const fetch = createNativeApiFetch(config, native, expire);
    native.request.mockResolvedValueOnce(result(401));
    await fetch(`${root}/auth/session/refresh`, { method: 'POST' });
    expect(expire).not.toHaveBeenCalled();
    await fetch(`${root}/auth/challenges/id/verify`, { method: 'POST' });
    native.request.mockResolvedValue(result(401));
    await fetch(`${root}/auth/session/refresh`, { method: 'POST' });
    await fetch(`${root}/auth/session/refresh`, { method: 'POST' });
    expect(expire).toHaveBeenCalledOnce();
  });
  it('redacts raw native failures while retaining the SDK network-retry classification', async () => {
    const native = plugin();
    native.request
      .mockRejectedValueOnce({
        code: 'NATIVE_STORAGE_UNAVAILABLE',
        message: 'sensitive-native-detail',
      })
      .mockRejectedValueOnce({
        code: 'NATIVE_NETWORK_UNAVAILABLE',
        message: 'sensitive-native-detail',
      });
    const fetch = createNativeApiFetch(config, native);
    await expect(fetch(`${root}/profile`)).rejects.toMatchObject({
      code: 'NATIVE_SESSION_UNAVAILABLE',
    });
    await expect(fetch(`${root}/profile`)).rejects.toThrow('Native network unavailable');
  });

  it('reports stale data with its saved time and clears only the same successful resource', async () => {
    const native = plugin();
    const observe = vi.fn();
    const fetch = createNativeApiFetch(config, native, undefined, observe);
    native.request.mockResolvedValueOnce({
      ...result(),
      cache: { state: 'stale', savedAt: 1_790_530_000_000 },
    });
    await fetch(`${root}/home/base`);
    expect(observe).toHaveBeenLastCalledWith({
      path: '/user/api/v1/local-padel/home/base',
      state: 'stale',
      savedAt: 1_790_530_000_000,
    });
    await fetch(`${root}/profile`);
    expect(observe).toHaveBeenCalledOnce();
    await fetch(`${root}/home/base`);
    expect(observe).toHaveBeenLastCalledWith({
      path: '/user/api/v1/local-padel/home/base',
      state: 'live',
    });
    native.request.mockResolvedValueOnce(result(403));
    await fetch(`${root}/home/base`);
    expect(observe).toHaveBeenLastCalledWith({
      path: '/user/api/v1/local-padel/home/base',
      state: 'unavailable',
      invalidate: true,
    });
    await fetch(`${root}/home/base`);
    native.request.mockResolvedValueOnce(result(404));
    await fetch(`${root}/home/base`);
    expect(observe).toHaveBeenLastCalledWith(expect.objectContaining({ invalidate: true }));
    native.request.mockResolvedValueOnce(result(404));
    await fetch(`${root}/home/base`);
    expect(observe).toHaveBeenLastCalledWith(expect.objectContaining({ invalidate: false }));
  });

  it('ignores spoofed HTTP cache metadata and late observations after logout starts', async () => {
    const native = plugin();
    const observe = vi.fn();
    const fetch = createNativeApiFetch(config, native, undefined, observe);
    native.request.mockResolvedValueOnce({
      ...result(),
      headers: { 'x-phub-cache-state': 'stale' },
    });
    await fetch(`${root}/locations`);
    expect(observe).toHaveBeenLastCalledWith({
      path: '/user/api/v1/local-padel/locations',
      state: 'live',
    });
    observe.mockClear();
    let finish!: (value: Awaited<ReturnType<AndroidSessionPlugin['request']>>) => void;
    native.request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = fetch(`${root}/home/base`);
    await fetch(`${root}/auth/session`, { method: 'DELETE' });
    finish({ ...result(), cache: { state: 'stale', savedAt: 1_790_530_000_000 } });
    await pending;
    expect(observe).not.toHaveBeenCalled();
  });
});

it('Android station adapter preserves exact UTF-8 send once and original GET-only recovery', async () => {
  const native = plugin();
  const fetcher = createNativeApiFetch(config, native);
  const community = '11111111-1111-4111-8111-111111111111',
    requestId = '22222222-2222-4222-8222-222222222222';
  const path = `${root}/community-views/${community}/message-requests`;
  const body = JSON.stringify({ requestId, text: 'я'.repeat(8000) });
  const headers = {
    authorization: 'Bearer synthetic.session',
    'content-type': 'application/json',
    'idempotency-key': requestId,
  };
  native.request.mockRejectedValueOnce(
    Object.assign(new Error('synthetic'), { code: 'NATIVE_NETWORK_UNAVAILABLE' }),
  );
  await expect(fetcher(path, { method: 'POST', headers, body })).rejects.toThrow();
  expect(native.request).toHaveBeenCalledTimes(1);
  expect(native.request.mock.calls[0]![0]).toMatchObject({ method: 'POST', body, headers });
  await fetcher(`${path}/${requestId}`, { headers: { authorization: 'Bearer synthetic.session' } });
  expect(native.request).toHaveBeenCalledTimes(2);
  expect(native.request.mock.calls[1]![0].method).toBe('GET');
  await expect(
    fetcher(path, { method: 'POST', headers, body: body.replace(requestId, community) }),
  ).rejects.toThrow();
  expect(native.request).toHaveBeenCalledTimes(2);
});

it('native station v3 forwards exact four routes without response credentials or mutation retries', async () => {
  const native = plugin(),
    transport = createNativeApiFetch(config, native);
  const id = '11111111-1111-4111-8111-111111111111',
    key = '22222222-2222-4222-8222-222222222222';
  const headers = { authorization: 'Bearer synthetic.session' };
  for (const path of [
    `station-stream-summaries?communityIds=${id}%2C${key}`,
    `${id}/station-stream?limit=50&cursor=${'a'.repeat(1024)}`,
    `${id}/read-requests/${key}`,
  ])
    await transport(`${root}/community-views/${path}`, { headers });
  native.request.mockRejectedValueOnce(new TypeError('offline'));
  await expect(
    transport(`${root}/community-views/${id}/read-requests`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json', 'idempotency-key': key },
      body: JSON.stringify({
        requestId: key,
        streamId: id,
        membershipEpoch: 1,
        throughSequence: 2,
      }),
    }),
  ).rejects.toThrow();
  expect(native.request).toHaveBeenCalledTimes(4);
  expect(native.request.mock.calls.at(-1)?.[0]).toMatchObject({
    method: 'POST',
    path: `/user/api/v1/local-padel/community-views/${id}/read-requests`,
  });
});
it('native v3 history alone accepts3MiB while oversized responses and receipts fail before parse', async () => {
  const native = plugin(),
    transport = createNativeApiFetch(config, native),
    id = '11111111-1111-4111-8111-111111111111';
  const headers = { authorization: 'Bearer synthetic.session' };
  const body = JSON.stringify({
    items: Array.from({ length: 50 }, () => ({ body: 'x' + '\u0001'.repeat(7998) + 'y' })),
  });
  expect(Buffer.byteLength(body)).toBeGreaterThan(2_000_000);
  native.request.mockResolvedValue({ ...result(), body: Buffer.from(body).toString('base64') });
  const response = await transport(`${root}/community-views/${id}/station-stream?limit=50`, {
    headers,
  });
  expect(await response.text()).toBe(body);
  native.request.mockResolvedValue({
    ...result(),
    body: Buffer.alloc(3 * 1024 * 1024 + 1, 32).toString('base64'),
  });
  await expect(
    transport(`${root}/community-views/${id}/station-stream`, { headers }),
  ).rejects.toThrow();
  native.request.mockResolvedValue({
    ...result(),
    body: Buffer.alloc(1024 * 1024 + 1, 32).toString('base64'),
  });
  for (const suffix of ['station-stream-summaries?communityIds=' + id, `${id}/read-requests/${id}`])
    await expect(transport(`${root}/community-views/${suffix}`, { headers })).rejects.toThrow();
});
