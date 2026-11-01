import { describe, it, expect, vi } from 'vitest';
import { quarterRequest } from './native-quarter-request.js';
import { createNativeApiFetch } from './native-api-fetch.js';
import { createIOSFetch, type IOSSessionPlugin } from './ios/session.js';
import { createIOSQuarterGateway } from './ios/quarter-gateway.js';
import {
  config,
  fixtureReply,
  syntheticSession,
  nativeResult,
} from './ios/testing/cabinet-fixtures.js';
const id = '11111111-1111-4111-8111-111111111111',
  key = '22222222-2222-4222-8222-222222222222';
const root = config.apiBaseUrl + '/user/api/v1/' + config.tenantKey + '/game-create-operations';
const q = { stationId: id, courtId: id, subscriptionId: id, startsAt: '2030-01-01T12:00:00.000Z' };
const headers = {
  Authorization: 'Bearer synthetic-access',
  'Idempotency-Key': key,
  'Content-Type': 'application/json',
};
const readHeaders = { Authorization: 'Bearer synthetic-access' };
describe('fixed quarter native contract', () => {
  it('recognizes only five authenticated routes with original bytes', () => {
    for (const s of ['capability', 'locations'])
      expect(quarterRequest(root + '/' + s, { headers: readHeaders }, config)?.resource).toBe(s);
    expect(quarterRequest(root + '/by-key', { headers }, config)?.resource).toBe('byKey');
    expect(
      quarterRequest(root, { method: 'POST', headers, body: JSON.stringify(q) }, config)?.resource,
    ).toBe('create');
    expect(
      quarterRequest(
        root + '/' + id + '/reconcile',
        { method: 'POST', headers, body: JSON.stringify(q) },
        config,
      ),
    ).toEqual({ resource: 'reconcile', resourceId: id });
  });
  it.each([
    '?x=1',
    '/capability?x=1',
    '/by-key?key=x',
    '/../games',
    '//' + id + '/reconcile',
    '/' + id + '/reconcile\n',
    '/unknown',
  ])('rejects path %s', (suffix) => {
    expect(() =>
      quarterRequest(root + suffix, { method: 'POST', headers, body: JSON.stringify(q) }, config),
    ).toThrow();
  });
  it.each([
    JSON.stringify({ ...q, price: 0 }),
    JSON.stringify({ ...q, startsAt: '2030-02-30T12:00:00.000Z' }),
    JSON.stringify({ ...q, startsAt: '2030-01-01T12:00:01.000Z' }),
    JSON.stringify({ ...q, startsAt: '0000-01-01T12:00:00.000Z' }),
    JSON.stringify(q).replace('"stationId":', '"courtId":'),
    '{}',
    'null',
  ])('rejects noncanonical body %s', (body) => {
    expect(() => quarterRequest(root, { method: 'POST', headers, body }, config)).toThrow();
  });
  it.each([
    {},
    { ...headers, Cookie: 'synthetic' },
    { ...headers, Origin: config.apiBaseUrl },
    { ...headers, 'Idempotency-Key': 'short' },
    { ...headers, Authorization: 'bad' },
  ])('rejects invalid headers', (h) => {
    expect(() =>
      quarterRequest(root, { method: 'POST', headers: h, body: JSON.stringify(q) }, config),
    ).toThrow();
  });
  it('JS bridges deny foreign origin/tenant, GET body and unauthorized quarter before native dispatch', async () => {
    const android = { request: vi.fn(), configuration: vi.fn() };
    const ios = { request: vi.fn(), configuration: vi.fn() };
    const androidFetch = createNativeApiFetch(
      { ...config, platform: 'android', native: true } as never,
      android,
    );
    const iosFetch = createIOSFetch(config, ios);
    for (const f of [androidFetch, iosFetch])
      for (const url of [
        root.replace(config.apiBaseUrl, 'https://foreign.invalid'),
        root.replace(config.tenantKey, 'other'),
        root + '/by-key?source=viva',
      ])
        await expect(f(url, { headers })).rejects.toThrow();
    for (const f of [androidFetch, iosFetch])
      await expect(f(root + '/locations', { headers, body: '{}' })).rejects.toThrow();
    expect(android.request).not.toHaveBeenCalled();
    expect(ios.request).not.toHaveBeenCalled();
  });
  it.each([401, 503, 0])('actual SDK sends once without refresh for status %s', async (status) => {
    const request = vi.fn<IOSSessionPlugin['request']>(async (input) => {
      await Promise.resolve();
      if (input.operation === 'quarterCreate') {
        if (!status)
          throw Object.assign(new Error('Synthetic network failure'), {
            code: 'NATIVE_NETWORK_UNAVAILABLE',
          });
        return nativeResult({}, status);
      }
      return fixtureReply(input);
    });
    const session = syntheticSession(request);
    await session.restore();
    request.mockClear();
    await expect(createIOSQuarterGateway(session).createQuarterGame!(q, key)).rejects.toThrow();
    expect(request.mock.calls.filter(([x]) => x.operation === 'quarterCreate')).toHaveLength(1);
    expect(request.mock.calls.filter(([x]) => x.operation === 'refresh')).toHaveLength(0);
  });
  it('late response and restore cannot reopen outer logout fence', async () => {
    let finish!: (x: ReturnType<typeof nativeResult>) => void;
    const request = vi.fn<IOSSessionPlugin['request']>(async (input) =>
      input.operation === 'quarterCreate'
        ? await new Promise((resolve) => {
            finish = resolve;
          })
        : fixtureReply(input),
    );
    const session = syntheticSession(request);
    await session.restore();
    const gateway = createIOSQuarterGateway(session);
    const result = gateway.createQuarterGame!(q, key);
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    session.closeQuarterCreate();
    finish(nativeResult({}));
    await expect(result).rejects.toThrow();
    await session.restore();
    expect(gateway.quarterCreatePrincipal!()).toBeNull();
    await expect(gateway.createQuarterGame!(q, key)).rejects.toThrow();
    expect(request.mock.calls.filter(([x]) => x.operation === 'quarterCreate')).toHaveLength(1);
  });
  it('preserves exact recovery body/key and private selector', async () => {
    const request = vi.fn<IOSSessionPlugin['request']>(async (input) => {
      await Promise.resolve();
      return input.operation === 'quarterCreate' ? nativeResult({}) : fixtureReply(input);
    });
    const session = syntheticSession(request);
    await session.restore();
    const gateway = createIOSQuarterGateway(session);
    await gateway.getQuarterCreateOperation!(key);
    await gateway.reconcileQuarterCreateOperation!(id, q, key);
    const calls = request.mock.calls
      .filter(([x]) => x.operation === 'quarterCreate')
      .map(([x]) => x);
    expect(calls[0]?.resource).toBe('byKey');
    expect(calls[1]?.resourceId).toBe(id);
    expect(calls[1]?.body).toBe(JSON.stringify(q));
    expect(calls.every((x) => x.headers['idempotency-key'] === key)).toBe(true);
  });
});

it.each([401, 503, 0])(
  'Android real gateway/SDK has one mutation and no refresh replay for %s',
  async (status) => {
    const { createBrowserAuthGateway } = await import('../../web/src/auth-gateway.js');
    const { auth } = await import('./ios/testing/cabinet-fixtures.js');
    const request = vi.fn(
      async (x: {
        path: string;
        method: string;
        headers: Record<string, string>;
        body?: string;
      }) => {
        await Promise.resolve();
        const isQuarter = x.path.includes('/game-create-operations');
        if (isQuarter && !status)
          throw Object.assign(new Error('Synthetic network failure'), {
            code: 'NATIVE_NETWORK_UNAVAILABLE',
          });
        return {
          status: isQuarter ? status : 200,
          headers: { 'content-type': 'application/json' },
          body: Buffer.from(JSON.stringify(isQuarter ? {} : auth), 'utf8').toString('base64'),
        };
      },
    );
    const gateway = createBrowserAuthGateway({
      baseUrl: config.apiBaseUrl,
      tenantKey: config.tenantKey,
      appVersion: 'test',
      platform: 'android',
      nativeSessionTransport: true,
      fetchImplementation: createNativeApiFetch(config, {
        request,
        configuration: () => Promise.resolve(config),
      }),
    });
    await gateway.restoreSession();
    request.mockClear();
    await expect(gateway.createQuarterGame!(q, key)).rejects.toThrow();
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0]?.[0].path).toBe(
      '/user/api/v1/' + config.tenantKey + '/game-create-operations',
    );
  },
);
it('iOS close during accepted verification cannot reopen the quarter principal', async () => {
  let finish!: (x: ReturnType<typeof nativeResult>) => void;
  const request = vi.fn<IOSSessionPlugin['request']>(async (x) =>
    x.operation === 'verify'
      ? await new Promise((r) => {
          finish = r;
        })
      : x.operation === 'refresh'
        ? nativeResult({}, 401)
        : fixtureReply(x),
  );
  const session = syntheticSession(request);
  await session.restore();
  const verified = session.verify(id, '1234');
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  session.closeQuarterCreate();
  finish(fixtureReply({ operation: 'verify', headers: {} }));
  await verified;
  expect(session.quarterCreatePrincipal()).toBeNull();
});
