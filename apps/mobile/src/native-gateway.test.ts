import { describe, expect, it, vi } from 'vitest';
import { PadlHubApiClient } from '@phub/api-sdk';
import { createBrowserAuthGateway } from '../../web/src/auth-gateway.js';
import {
  createNativeApiFetch,
  type AndroidSessionPlugin,
  type NativeReadObservation,
} from './native-api-fetch.js';
import { sessionFailureDetails } from './session-failure.js';
import { homeBase } from './ios/testing/cabinet-fixtures.js';

const userId = '00000000-0000-4000-8000-000000000001';
const session = {
  accessToken: 'synthetic-process-token',
  tokenType: 'Bearer',
  expiresAt: '2099-09-27T00:00:00Z',
  user: { id: userId, displayName: 'Тестовый игрок' },
  context: {
    userId,
    tenantId: '00000000-0000-4000-8000-000000000002',
    displayName: 'Тестовый игрок',
    phoneLast4: '0001',
    roles: ['client'],
    permissions: ['profile.read'],
  },
};
const options = {
  baseUrl: 'https://lk.nano.padlhub.su',
  tenantKey: 'local-padel',
  platform: 'android' as const,
  appVersion: 'test',
};
const acceptance = {
  publicOfferAccepted: true as const,
  personalDataPolicyAccepted: true as const,
};

it.each([
  ['NATIVE_NETWORK_UNAVAILABLE', 2],
  ['NATIVE_STORAGE_UNAVAILABLE', 1],
  ['NATIVE_TLS_REJECTED', 1],
] as const)(
  'preserves native refresh retry policy and safe diagnostics for %s',
  async (code, count) => {
    const native = {
      configuration: vi.fn(),
      request: vi
        .fn<AndroidSessionPlugin['request']>()
        .mockRejectedValue({ code, message: 'private-native-detail' }),
    };
    const config = {
      apiBaseUrl: options.baseUrl,
      tenantKey: options.tenantKey,
      appVersion: 'test',
    };
    const gateway = createBrowserAuthGateway({
      ...options,
      nativeSessionTransport: true,
      fetchImplementation: createNativeApiFetch(config, native),
    });
    const failure: unknown = await gateway.restoreSession().catch((error: unknown) => error);
    expect(sessionFailureDetails(failure).code).toBe(code);
    expect(native.request).toHaveBeenCalledTimes(count);
    const first = native.request.mock.calls[0]![0];
    expect(first.path).toMatch(/\/auth\/session\/refresh$/);
    expect(first.headers['idempotency-key']).toBeTruthy();
    for (const [request] of native.request.mock.calls) {
      expect(request.headers['idempotency-key']).toBe(first.headers['idempotency-key']);
      expect(request.headers['x-session-intent']).toBe('refresh');
    }
    expect(JSON.stringify(failure)).not.toContain('private-native-detail');
  },
);
function url(input: Parameters<typeof fetch>[0]): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
}

describe('Android process session using the existing API contract', () => {
  it.each(['profile', 'home', 'home/base'])(
    'discards a late %s read while native logout is still pending',
    async (path) => {
      let finishRead!: (response: Response) => void;
      let finishLogout!: (response: Response) => void;
      const transport = vi.fn<typeof fetch>().mockImplementation((input) => {
        if (url(input).endsWith('/verify')) return Promise.resolve(Response.json(session));
        return new Promise((resolve) => {
          if (url(input).endsWith('/auth/session')) finishLogout = resolve;
          else finishRead = resolve;
        });
      });
      const gateway = createBrowserAuthGateway({
        ...options,
        nativeSessionTransport: true,
        fetchImplementation: transport,
      });
      await gateway.verifyCode({ challengeId: 'challenge', code: '0000', acceptance });
      const read =
        path === 'profile'
          ? gateway.getSelfProfile
          : path === 'home'
            ? gateway.getHomeDashboard
            : gateway.getHomeBase;
      const pending = read();
      const discarded = expect(pending).rejects.toThrow('AUTH_PRINCIPAL_CHANGED');
      const logout = gateway.logout();
      finishRead(
        Response.json(
          path === 'profile'
            ? { userId, displayName: 'Тестовый игрок' }
            : path === 'home'
              ? { profile: { userId } }
              : homeBase,
        ),
      );
      await discarded;
      await expect(gateway.getSelfProfile()).rejects.toThrow('AUTH_REQUIRED');
      finishLogout(new Response(null, { status: 204 }));
      await logout;
    },
  );
  it.each(['profile', 'home', 'home/base'])(
    'rejects another account in the canonical %s read',
    async (path) => {
      const foreignId = '00000000-0000-4000-8000-000000000099';
      const transport = vi
        .fn<typeof fetch>()
        .mockImplementation((input) =>
          Promise.resolve(
            Response.json(
              url(input).endsWith('/verify')
                ? session
                : path === 'profile'
                  ? { userId: foreignId, displayName: 'Другой аккаунт' }
                  : path === 'home'
                    ? { profile: { userId: foreignId } }
                    : { ...homeBase, viewerUserId: foreignId },
            ),
          ),
        );
      const gateway = createBrowserAuthGateway({ ...options, fetchImplementation: transport });
      await gateway.verifyCode({ challengeId: 'challenge', code: '0000', acceptance });
      const read =
        path === 'profile'
          ? gateway.getSelfProfile
          : path === 'home'
            ? gateway.getHomeDashboard
            : gateway.getHomeBase;
      if (path === 'home/base') await expect(read()).rejects.toThrow('HOME_BASE_VIEWER_MISMATCH');
      else
        await expect(read()).rejects.toMatchObject({
          code: 'NATIVE_ACCOUNT_MISMATCH',
          status: 403,
        });
      expect(transport).toHaveBeenCalledTimes(2);
    },
  );

  it.each(['profile', 'home', 'home/base'])(
    'discards a late %s response after logout and login to the same account',
    async (path) => {
      let finish!: (response: Response) => void;
      const transport = vi.fn<typeof fetch>().mockImplementation((input) =>
        url(input).endsWith('/verify')
          ? Promise.resolve(Response.json(session))
          : new Promise((resolve) => {
              finish = resolve;
            }),
      );
      const gateway = createBrowserAuthGateway({ ...options, fetchImplementation: transport });
      await gateway.verifyCode({ challengeId: 'challenge', code: '0000', acceptance });
      const read =
        path === 'profile'
          ? gateway.getSelfProfile
          : path === 'home'
            ? gateway.getHomeDashboard
            : gateway.getHomeBase;
      const pending = read();
      const discarded = expect(pending).rejects.toThrow('AUTH_PRINCIPAL_CHANGED');
      await gateway.logout();
      await gateway.verifyCode({ challengeId: 'challenge', code: '0000', acceptance });
      finish(
        Response.json(
          path === 'profile'
            ? { userId, displayName: 'Тестовый игрок' }
            : path === 'home'
              ? { profile: { userId } }
              : homeBase,
        ),
      );
      await discarded;
    },
  );

  it('restores without network; OTP then reads the canonical profile with the Android header', async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockImplementation((input) =>
        Promise.resolve(
          Response.json(
            url(input).endsWith('/verify') ? session : { userId, displayName: 'Тестовый игрок' },
          ),
        ),
      );
    const gateway = createBrowserAuthGateway({ ...options, fetchImplementation: transport });
    expect(await gateway.restoreSession()).toBeNull();
    expect(transport).not.toHaveBeenCalled();
    expect(
      (await gateway.verifyCode({ challengeId: 'challenge', code: '0000', acceptance })).context
        .user.id,
    ).toBe(userId);
    await gateway.getSelfProfile();
    expect(transport).toHaveBeenCalledTimes(2);
    const [input, init] = transport.mock.calls[1]!;
    expect(url(input)).toContain('/profile');
    expect(new Headers(init?.headers).get('X-App-Platform')).toBe('android');
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer synthetic-process-token');
    expect(init?.credentials).toBe('omit');
    await gateway.logout();
    await expect(gateway.getSelfProfile()).rejects.toThrow('AUTH_REQUIRED');
    expect(transport).toHaveBeenCalledTimes(2);
  });
  it('never exchanges native credentials for browser-only providers, payments, community uploads or Web Push', async () => {
    const transport = vi.fn<typeof fetch>();
    const gateway = createBrowserAuthGateway({ ...options, fetchImplementation: transport });
    await expect(gateway.startVivaOAuth({ provider: 'yandex', acceptance })).rejects.toThrow();
    await expect(gateway.refreshVivaAccessToken()).rejects.toThrow('DIRECT_VIVA_DISABLED');
    await expect(gateway.listTrainingSchedule()).rejects.toMatchObject({
      code: 'NATIVE_FLOW_UNAVAILABLE',
    });
    await expect(gateway.createPublicGiftCertificatePaymentIntent('order')).rejects.toMatchObject({
      code: 'NATIVE_FLOW_UNAVAILABLE',
    });
    await expect(
      gateway.finalizeCommunityMediaUpload('community', 'media', 1),
    ).rejects.toMatchObject({ code: 'NATIVE_FLOW_UNAVAILABLE' });
    await expect(gateway.revokeWebPushEndpoint('installation')).rejects.toMatchObject({
      code: 'NATIVE_FLOW_UNAVAILABLE',
    });
    expect(await gateway.getWebPushConfiguration()).toEqual({ enabled: false });
    expect(transport).not.toHaveBeenCalled();
  });
  it('sends authorized station chat and media commands only to the PadlHub API', async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockImplementation((input) =>
        Promise.resolve(
          url(input).endsWith('/verify')
            ? Response.json(session)
            : url(input).endsWith('/content')
              ? new Response(new Uint8Array([1]), { headers: { 'content-type': 'image/webp' } })
              : Response.json({ items: [], hasMore: false }),
        ),
      );
    const gateway = createBrowserAuthGateway({ ...options, fetchImplementation: transport });
    await gateway.verifyCode({ challengeId: 'challenge', code: '0000', acceptance });
    await gateway.listStationSupportStations();
    await gateway.listStationSupportMessages('dialog');
    await gateway.sendStationSupportMessage({
      clientMessageId: 'synthetic-command',
      text: 'synthetic',
      stationId: 'station',
    });
    await gateway.uploadStationSupportAttachment({
      fileName: 'photo.png',
      contentType: 'image/png',
      data: 'AQ==',
    });
    expect((await gateway.loadStationSupportAttachment('attachment')).size).toBe(1);
    await gateway.finalizeConversationMediaUpload('chat', 'media', 1, 'synthetic-finalize');
    const requests = transport.mock.calls.slice(1);
    expect(requests).toHaveLength(6);
    for (const [input, init] of requests) {
      expect(new URL(url(input)).origin).toBe(new URL(options.baseUrl).origin);
      expect(new Headers(init?.headers).get('X-App-Platform')).toBe('android');
      expect(new Headers(init?.headers).get('Authorization')).toBe(
        'Bearer synthetic-process-token',
      );
    }
    const command = requests.find(([input]) => url(input).endsWith('/support/messages'))!;
    expect(new Headers(command[1]?.headers).get('Idempotency-Key')).toBe('synthetic-command');
  });
  it('does not retry a 401 or retain an expired token in the SDK', async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json(
          { code: 'AUTH_REQUIRED', message: 'Expired', correlationId: 'test' },
          { status: 401 },
        ),
      );
    const client = new PadlHubApiClient({
      ...options,
      sessionMode: 'memory',
      initialAccessToken: 'synthetic-process-token',
      fetchImplementation: transport,
    });
    await expect(client.getUserProfile()).rejects.toMatchObject({ status: 401 });
    expect(client.getAccessToken()).toBeUndefined();
    expect(transport).toHaveBeenCalledOnce();
    await expect(client.refreshSession()).rejects.toMatchObject({ status: 401 });
    await client.revokeSession();
    expect(transport).toHaveBeenCalledOnce();
  });
});

it('does not let an old in-flight 401 invalidate a later Android session', async () => {
  let resolveOld!: (response: Response) => void;
  const expire = vi.fn();
  const transport = vi.fn<typeof fetch>().mockImplementation(
    () =>
      new Promise((resolve) => {
        resolveOld = resolve;
      }),
  );
  const client = new PadlHubApiClient({
    ...options,
    sessionMode: 'memory',
    onSessionExpired: expire,
    initialAccessToken: 'old-synthetic-token',
    fetchImplementation: transport,
  });
  const oldRequest = client.getUserProfile();
  client.setAccessToken('new-synthetic-token');
  resolveOld(Response.json({ code: 'AUTH_REQUIRED', message: 'Expired' }, { status: 401 }));
  await expect(oldRequest).rejects.toMatchObject({ status: 401 });
  expect(client.getAccessToken()).toBe('new-synthetic-token');
  expect(expire).not.toHaveBeenCalled();
});

it('requires an explicit transport before enabling a durable Android session', () => {
  expect(() => createBrowserAuthGateway({ ...options, nativeSessionTransport: true })).toThrow(
    'NATIVE_TRANSPORT_REQUIRED',
  );
});

it('restores and revokes a durable Android session through the injected native transport only', async () => {
  const transport = vi
    .fn<typeof fetch>()
    .mockImplementation((input) =>
      Promise.resolve(
        url(input).endsWith('/auth/session')
          ? new Response(null, { status: 204 })
          : Response.json(session),
      ),
    );
  const gateway = createBrowserAuthGateway({
    ...options,
    nativeSessionTransport: true,
    fetchImplementation: transport,
  });
  expect((await gateway.restoreSession())?.context.user.id).toBe(userId);
  expect(transport).toHaveBeenCalledOnce();
  expect(url(transport.mock.calls[0]![0])).toMatch(/\/auth\/session\/refresh$/);
  await gateway.logout();
  expect(transport).toHaveBeenCalledTimes(2);
  expect(transport.mock.calls[1]![1]?.method).toBe('DELETE');
  expect(new Headers(transport.mock.calls[1]![1]?.headers).get('X-Session-Intent')).toBe('logout');
  expect(new Headers(transport.mock.calls[1]![1]?.headers).has('Authorization')).toBe(false);
  await expect(gateway.getSelfProfile()).rejects.toThrow('AUTH_REQUIRED');
});

describe('bounded Android profile and bookings diagnostics', () => {
  const config = {
    apiBaseUrl: options.baseUrl,
    tenantKey: options.tenantKey,
    appVersion: options.appVersion,
  };
  const root = `${options.baseUrl}/user/api/v1/${options.tenantKey}/`;
  const correlationId = '00000000-0000-4000-8000-00000000000a';
  const headers = { 'x-correlation-id': correlationId };
  const privateDetail = 'PRIVATE_RESPONSE_SENTINEL';
  const envelope = {
    code: 'PROFILE_PROJECTION_STALE',
    message: privateDetail,
    stack: privateDetail,
    correlationId: privateDetail,
    user: { displayName: privateDetail, phone: privateDetail },
    accessToken: privateDetail,
  };
  function result(status: number, payload: unknown, responseHeaders: Record<string, string> = {}) {
    const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
    return {
      status,
      headers: { 'content-type': 'application/json', ...responseHeaders },
      body: btoa(String.fromCharCode(...new TextEncoder().encode(body))),
    };
  }
  function fixture() {
    const native = { configuration: vi.fn(), request: vi.fn<AndroidSessionPlugin['request']>() };
    const observe = vi.fn<(observation: NativeReadObservation) => void>();
    const fetch = createNativeApiFetch(config, native, undefined, undefined, observe);
    return { native, observe, fetch };
  }

  it('preserves the SDK failure and original body while retaining only reviewed metadata', async () => {
    const { native, observe, fetch } = fixture();
    native.request.mockImplementation((input) =>
      Promise.resolve(
        result(503, envelope, { 'x-correlation-id': input.headers['x-correlation-id']! }),
      ),
    );
    const client = new PadlHubApiClient({
      ...options,
      sessionMode: 'memory',
      initialAccessToken: 'synthetic-process-token',
      fetchImplementation: fetch,
    });
    await expect(client.getUserProfile()).rejects.toMatchObject({
      status: 503,
      code: 'PROFILE_PROJECTION_STALE',
    });
    expect(native.request).toHaveBeenCalledOnce();
    const requestCorrelation = native.request.mock.calls[0]![0].headers['x-correlation-id'];
    expect(observe).toHaveBeenCalledExactlyOnceWith({
      section: 'profile',
      failure: { status: 503, code: 'PROFILE_PROJECTION_STALE', correlationId: requestCorrelation },
    });
    expect(JSON.stringify(observe.mock.calls)).not.toContain(privateDetail);
    const response = await fetch(root + 'profile', { headers });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual(envelope);
  });

  it.each([
    ['unknown code', { ...envelope, code: privateDetail }],
    ['malformed JSON', privateDetail],
    ['oversized JSON', { ...envelope, message: privateDetail.repeat(300) }],
    ['non-object JSON', ['PROFILE_PROJECTION_STALE', privateDetail]],
  ])('maps %s to a stable fallback without retaining response content', async (_name, payload) => {
    const { native, observe, fetch } = fixture();
    native.request.mockResolvedValue(result(503, payload));
    const response = await fetch(root + 'profile', { headers });
    expect(await response.text()).toBe(
      typeof payload === 'string' ? payload : JSON.stringify(payload),
    );
    expect(observe).toHaveBeenCalledExactlyOnceWith({
      section: 'profile',
      failure: { status: 503, code: 'HTTP_ERROR', correlationId },
    });
    expect(JSON.stringify(observe.mock.calls)).not.toContain(privateDetail);
  });

  it.each([
    [undefined, correlationId],
    [correlationId.toUpperCase(), correlationId],
    ['00000000-0000-4000-8000-000000000004', undefined],
    [privateDetail, undefined],
    ['', undefined],
  ])(
    'keeps only a matching request UUID when the response header is %s',
    async (returned, expected) => {
      const { native, observe, fetch } = fixture();
      native.request.mockResolvedValue(
        result(503, envelope, returned === undefined ? {} : { 'x-correlation-id': returned }),
      );
      await fetch(root + 'profile', { headers });
      expect(observe.mock.calls[0]![0].failure).toEqual({
        status: 503,
        code: 'PROFILE_PROJECTION_STALE',
        ...(expected ? { correlationId: expected } : {}),
      });
      expect(JSON.stringify(observe.mock.calls)).not.toContain(privateDetail);
    },
  );

  it.each([undefined, privateDetail, correlationId + privateDetail])(
    'omits an invalid request correlation %s',
    async (requestCorrelation) => {
      const { native, observe, fetch } = fixture();
      native.request.mockResolvedValue(
        result(503, envelope, { 'x-correlation-id': correlationId }),
      );
      await fetch(root + 'profile', {
        headers: requestCorrelation ? { 'x-correlation-id': requestCorrelation } : {},
      });
      expect(observe.mock.calls[0]![0].failure).toEqual({
        status: 503,
        code: 'PROFILE_PROJECTION_STALE',
      });
    },
  );

  it('reports unavailable bookings and clears each resource on a successful read', async () => {
    const { native, observe, fetch } = fixture();
    native.request
      .mockResolvedValueOnce(result(200, { state: 'UNAVAILABLE', message: privateDetail }))
      .mockResolvedValueOnce(result(200, { state: 'READY', items: [] }))
      .mockResolvedValueOnce(result(200, envelope));
    await fetch(root + 'bookings/upcoming', { headers });
    await fetch(root + 'bookings/upcoming', { headers });
    await fetch(root + 'profile', { headers });
    expect(observe.mock.calls.map(([observation]) => observation)).toEqual([
      {
        section: 'bookings',
        failure: { status: 200, code: 'BOOKINGS_UNAVAILABLE', correlationId },
      },
      { section: 'bookings', failure: null },
      { section: 'profile', failure: null },
    ]);
  });

  it('ignores query, POST, refresh, and other paths and rejects a foreign origin', async () => {
    const { native, observe, fetch } = fixture();
    native.request.mockResolvedValue(result(503, envelope));
    await fetch(root + 'profile?detail=1', { headers });
    await fetch(root + 'bookings/upcoming?detail=1', { headers });
    await fetch(root + 'profile', { headers, method: 'POST' });
    await fetch(root + 'auth/session/refresh', { headers, method: 'POST' });
    await fetch(root + 'home/base', { headers });
    await expect(fetch('https://foreign.invalid/profile', { headers })).rejects.toMatchObject({
      code: 'NATIVE_REQUEST_REJECTED',
    });
    expect(observe).not.toHaveBeenCalled();
    expect(native.request).toHaveBeenCalledTimes(5);
  });

  it.each([
    ['NATIVE_NETWORK_UNAVAILABLE', 'NATIVE_NETWORK_UNAVAILABLE'],
    ['NATIVE_TLS_REJECTED', 'NATIVE_TLS_REJECTED'],
    [privateDetail, 'NATIVE_SESSION_UNAVAILABLE'],
  ])(
    'retains native error classification without exposing its raw fields: %s',
    async (code, expected) => {
      const { native, observe, fetch } = fixture();
      native.request.mockRejectedValue({
        code,
        message: privateDetail,
        stack: privateDetail,
        token: privateDetail,
      });
      const failure: unknown = await fetch(root + 'profile', { headers }).catch(
        (error: unknown) => error,
      );
      expect(sessionFailureDetails(failure).code).toBe(expected);
      expect(native.request).toHaveBeenCalledOnce();
      expect(observe).toHaveBeenCalledExactlyOnceWith({
        section: 'profile',
        failure: { code: expected, correlationId },
      });
      expect(JSON.stringify(observe.mock.calls)).not.toContain(privateDetail);
    },
  );

  it('clears the first 401 after the unchanged SDK refresh and retry succeed', async () => {
    const { native, observe, fetch } = fixture();
    native.request
      .mockResolvedValueOnce(result(401, { code: 'AUTH_REQUIRED' }))
      .mockResolvedValueOnce(result(200, session))
      .mockResolvedValueOnce(result(200, { userId, displayName: 'Тестовый игрок' }));
    const client = new PadlHubApiClient({
      ...options,
      initialAccessToken: 'synthetic-process-token',
      fetchImplementation: fetch,
    });
    await expect(client.getUserProfile()).resolves.toMatchObject({ userId });
    expect(native.request).toHaveBeenCalledTimes(3);
    const first = native.request.mock.calls[0]![0];
    const retry = native.request.mock.calls[2]![0];
    expect(retry.headers['x-correlation-id']).toBe(first.headers['x-correlation-id']);
    expect(observe.mock.calls.map(([observation]) => observation)).toEqual([
      {
        section: 'profile',
        failure: {
          status: 401,
          code: 'AUTH_REQUIRED',
          correlationId: first.headers['x-correlation-id'],
        },
      },
      { section: 'profile', failure: null },
    ]);
  });

  it.each(['newer success', 'logout', 'abort'] as const)(
    'ignores a pending failure after %s',
    async (transition) => {
      const { native, observe, fetch } = fixture();
      let resolveOld!: (value: Awaited<ReturnType<AndroidSessionPlugin['request']>>) => void;
      native.request
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolveOld = resolve;
            }),
        )
        .mockResolvedValue(result(200, { userId }));
      const controller = new AbortController();
      const old = fetch(root + 'profile', { headers, signal: controller.signal });
      if (transition === 'newer success') await fetch(root + 'profile', { headers });
      else if (transition === 'logout') await fetch(root + 'auth/session', { method: 'DELETE' });
      else controller.abort();
      resolveOld(result(503, envelope));
      if (transition === 'abort') await expect(old).rejects.toMatchObject({ name: 'AbortError' });
      else expect((await old).status).toBe(503);
      expect(observe.mock.calls.map(([observation]) => observation)).toEqual(
        transition === 'newer success' ? [{ section: 'profile', failure: null }] : [],
      );
    },
  );

  it('keeps simultaneous profile and bookings failures independent', async () => {
    const { native, observe, fetch } = fixture();
    let resolveProfile!: (value: Awaited<ReturnType<AndroidSessionPlugin['request']>>) => void;
    native.request
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveProfile = resolve;
          }),
      )
      .mockResolvedValueOnce(result(503, { code: 'BOOKINGS_PROJECTION_STALE' }));
    const profile = fetch(root + 'profile', { headers });
    await fetch(root + 'bookings/upcoming', { headers });
    resolveProfile(result(503, envelope));
    await profile;
    expect(observe.mock.calls.map(([observation]) => observation.section)).toEqual([
      'bookings',
      'profile',
    ]);
  });

  it('does not let an observer exception change a response or native failure', async () => {
    const { native, observe, fetch } = fixture();
    observe.mockImplementation(() => {
      throw new Error(privateDetail);
    });
    native.request
      .mockResolvedValueOnce(result(503, envelope))
      .mockRejectedValueOnce({ code: 'NATIVE_TLS_REJECTED', message: privateDetail });
    const response = await fetch(root + 'profile', { headers });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual(envelope);
    const failure: unknown = await fetch(root + 'profile', { headers }).catch(
      (error: unknown) => error,
    );
    expect(sessionFailureDetails(failure).code).toBe('NATIVE_TLS_REJECTED');
    expect(native.request).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(failure)).not.toContain(privateDetail);
  });
});
