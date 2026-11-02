import { expect, it, vi } from 'vitest';
import {
  config,
  fixtureReply,
  nativeResult,
  syntheticSession,
} from './testing/cabinet-fixtures.js';
import { createIOSFetch, type IOSSessionPlugin } from './session.js';
import { selfLeaveRequest } from '../native-self-leave-request.js';
const id = '11111111-1111-4111-8111-111111111111',
  key = '22222222-2222-4222-8222-222222222222';
const root = `${config.apiBaseUrl}/user/api/v1/${config.tenantKey}/games/${id}`;
const headers = { authorization: 'Bearer synthetic-access', 'idempotency-key': key };
it('dispatches exact bodyless original-key leave/status/reconcile through one iOS session', async () => {
  const request = vi.fn<IOSSessionPlugin['request']>((v) =>
    Promise.resolve(v.operation === 'selfLeave' ? nativeResult({}) : fixtureReply(v)),
  );
  const session = syntheticSession(request);
  await session.restore();
  for (const resource of ['leave', 'status', 'reconcile'] as const)
    await session.selfLeave(resource, id, key);
  const calls = request.mock.calls.filter(([v]) => v.operation === 'selfLeave').map(([v]) => v);
  expect(calls.map((v) => v.resource)).toEqual(['leave', 'status', 'reconcile']);
  for (const call of calls) {
    expect(call).toMatchObject({ resourceId: id, headers: { 'idempotency-key': key } });
    expect(call).not.toHaveProperty('body');
  }
});
it.each([401, 503, 'network'] as const)('never replays a self leave after %s', async (status) => {
  const request = vi.fn<IOSSessionPlugin['request']>((v) =>
    v.operation !== 'selfLeave'
      ? Promise.resolve(fixtureReply(v))
      : status === 'network'
        ? Promise.reject(
            Object.assign(new Error('synthetic'), { code: 'NATIVE_NETWORK_UNAVAILABLE' }),
          )
        : Promise.resolve(
            nativeResult({ error: { code: 'UNAVAILABLE', message: 'unavailable' } }, status),
          ),
  );
  const session = syntheticSession(request);
  await session.restore();
  await expect(session.selfLeave('leave', id, key)).rejects.toThrow();
  expect(request.mock.calls.filter(([v]) => v.operation === 'selfLeave')).toHaveLength(1);
  expect(request.mock.calls.filter(([v]) => v.operation === 'refresh')).toHaveLength(1);
});
it('duplicate dispatch, logout late ACK and bridge bypass are denied', async () => {
  let finish!: (v: Awaited<ReturnType<IOSSessionPlugin['request']>>) => void;
  const request = vi.fn<IOSSessionPlugin['request']>((v) =>
    v.operation === 'selfLeave'
      ? new Promise((r) => {
          finish = r;
        })
      : Promise.resolve(fixtureReply(v)),
  );
  const session = syntheticSession(request);
  await session.restore();
  const pending = session.selfLeave('leave', id, key),
    rejected = expect(pending).rejects.toThrow();
  await vi.waitFor(() => expect(finish).toBeDefined());
  await expect(session.selfLeave('leave', id, key)).rejects.toThrow();
  session.closeQuarterCreate();
  finish(nativeResult({}));
  await rejected;
  await expect(
    createIOSFetch(config, { request, configuration: () => Promise.resolve(config) })(
      root + '/participants/me',
      { method: 'DELETE', headers },
    ),
  ).rejects.toThrow();
  expect(request.mock.calls.filter(([v]) => v.operation === 'selfLeave')).toHaveLength(1);
});
it('strict TS wire rejects other members, query/body/header/method expansion', () => {
  expect(
    selfLeaveRequest(root + '/participants/me', { method: 'DELETE', headers }, config)?.resource,
  ).toBe('leave');
  for (const suffix of [
    '/participants/other',
    '/participants/me?',
    '/leave-operation?x=1',
    '/leave-operation/reconcile/',
  ])
    expect(() => selfLeaveRequest(root + suffix, { method: 'DELETE', headers }, config)).toThrow();
  for (const init of [
    { method: 'POST', headers },
    { method: 'DELETE', headers, body: '' },
    { method: 'DELETE', headers: { ...headers, cookie: 'synthetic' } },
    { method: 'DELETE', headers: { authorization: headers.authorization } },
  ])
    expect(() => selfLeaveRequest(root + '/participants/me', init, config)).toThrow();
});
it('iOS rejects ACK after token rotation during SDK JSON decoding', async () => {
  const request = vi.fn<IOSSessionPlugin['request']>((v) =>
    Promise.resolve(
      v.operation === 'selfLeave' ? nativeResult({ marker: 'self-leave' }) : fixtureReply(v),
    ),
  );
  const session = syntheticSession(request);
  await session.restore();
  const original = Response.prototype.json;
  let release!: (v: unknown) => void;
  const spy = vi.spyOn(Response.prototype, 'json').mockImplementation(function (this: Response) {
    return original.call(this).then((v: unknown) =>
      typeof v === 'object' && v !== null && 'marker' in v
        ? new Promise((r) => {
            release = r;
          })
        : v,
    );
  });
  try {
    const command = session.selfLeave('leave', id, key),
      rejected = expect(command).rejects.toThrow();
    await vi.waitFor(() => expect(release).toBeDefined());
    await session.read((api) => {
      api.setAccessToken('synthetic-rotated-token');
      return Promise.resolve();
    });
    release({});
    await rejected;
  } finally {
    spy.mockRestore();
  }
});
