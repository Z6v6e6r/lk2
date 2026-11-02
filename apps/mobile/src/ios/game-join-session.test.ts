import { expect, it, vi } from 'vitest';
import {
  config,
  fixtureReply,
  nativeResult,
  syntheticSession,
} from './testing/cabinet-fixtures.js';
import { createIOSFetch, type IOSSessionPlugin } from './session.js';
const id = '11111111-1111-4111-8111-111111111111',
  key = '22222222-2222-4222-8222-222222222222';
const body = JSON.stringify({ expectedRevision: 1 });
it('native JOIN preserves original body/key, explicit status/reconcile and conditions', async () => {
  const request = vi.fn<IOSSessionPlugin['request']>((v) =>
    Promise.resolve(v.operation === 'gameJoin' ? nativeResult({}) : fixtureReply(v)),
  );
  const session = syntheticSession(request);
  await session.restore();
  await session.gameJoin({ resource: 'join', resourceId: id, key, body });
  await session.gameJoin({ resource: 'paidStatus', resourceId: id, key });
  await session.gameJoin({ resource: 'operation', resourceId: id, key });
  await session.gameJoin({ resource: 'reconcile', resourceId: id, key: `join-reconcile:${id}` });
  await session.gameJoin({
    resource: 'conditions',
    resourceId: id,
    query: { expectedRevision: '1', subscriptionInstanceId: key },
  });
  const calls = request.mock.calls.filter(([v]) => v.operation === 'gameJoin').map(([v]) => v);
  expect(calls.map((v) => v.resource)).toEqual([
    'join',
    'paidStatus',
    'operation',
    'reconcile',
    'conditions',
  ]);
  expect(calls[0]).toMatchObject({ body, headers: { 'idempotency-key': key } });
  expect(calls[3]).not.toHaveProperty('body');
  expect(calls[4]?.headers).not.toHaveProperty('idempotency-key');
});
it.each([401, 503, 'network'] as const)('never auto replays JOIN after %s', async (status) => {
  const request = vi.fn<IOSSessionPlugin['request']>((v) =>
    v.operation !== 'gameJoin'
      ? Promise.resolve(fixtureReply(v))
      : status === 'network'
        ? Promise.reject(new Error('synthetic'))
        : Promise.resolve(
            nativeResult({ error: { code: 'UNAVAILABLE', message: 'unavailable' } }, status),
          ),
  );
  const session = syntheticSession(request);
  await session.restore();
  await expect(session.gameJoin({ resource: 'join', resourceId: id, key, body })).rejects.toThrow();
  expect(request.mock.calls.filter(([v]) => v.operation === 'gameJoin')).toHaveLength(1);
  expect(request.mock.calls.filter(([v]) => v.operation === 'refresh')).toHaveLength(1);
});
it('denies duplicate JOIN, late logout ACK and unregistered bridge command', async () => {
  let finish!: (v: Awaited<ReturnType<IOSSessionPlugin['request']>>) => void;
  const request = vi.fn<IOSSessionPlugin['request']>((v) =>
    v.operation === 'gameJoin'
      ? new Promise((r) => {
          finish = r;
        })
      : Promise.resolve(fixtureReply(v)),
  );
  const session = syntheticSession(request);
  await session.restore();
  const pending = session.gameJoin({ resource: 'join', resourceId: id, key, body }),
    denied = expect(pending).rejects.toThrow();
  await vi.waitFor(() => expect(finish).toBeDefined());
  await expect(session.gameJoin({ resource: 'join', resourceId: id, key, body })).rejects.toThrow();
  session.closeQuarterCreate();
  finish(nativeResult({}));
  await denied;
  await expect(
    createIOSFetch(config, { request, configuration: () => Promise.resolve(config) })(
      `${config.apiBaseUrl}/user/api/v1/${config.tenantKey}/games/${id}/join`,
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer synthetic-access',
          'content-type': 'application/json',
          'idempotency-key': key,
        },
        body,
      },
    ),
  ).rejects.toThrow();
  expect(request.mock.calls.filter(([v]) => v.operation === 'gameJoin')).toHaveLength(1);
});

it('iOS rejects ACK after token rotation during SDK JSON decoding', async () => {
  const request = vi.fn<IOSSessionPlugin['request']>((v) =>
    Promise.resolve(
      v.operation === 'gameJoin' ? nativeResult({ marker: 'self-leave' }) : fixtureReply(v),
    ),
  );
  const session = syntheticSession(request);
  await session.restore();
  // eslint-disable-next-line @typescript-eslint/unbound-method -- The spy invokes this saved method with original.call(this).
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
    const command = session.gameJoin({ resource: 'join', resourceId: id, key, body }),
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
