import { expect, it, vi } from 'vitest';
import { fixtureReply, nativeResult, syntheticSession } from './testing/cabinet-fixtures.js';
import type { IOSSessionPlugin } from './session.js';
const input = { expectedVersion: 0, contactPolicy: 'NOBODY', chatPolicy: 'AUTHORIZED' } as const;
it.each([401, 409, 503, 'network'] as const)(
  'settings %s has one attempt, explicit identical retry retains key',
  async (status) => {
    const request = vi.fn<IOSSessionPlugin['request']>((v) =>
      v.operation !== 'profileSettings'
        ? Promise.resolve(fixtureReply(v))
        : status === 'network'
          ? Promise.reject(new Error('lost ack'))
          : Promise.resolve(
              nativeResult({ error: { code: 'UNAVAILABLE', message: 'unavailable' } }, status),
            ),
    );
    const session = syntheticSession(request);
    await session.restore();
    await expect(session.updateProfileSettings('privacy', input)).rejects.toThrow();
    expect(request.mock.calls.filter(([v]) => v.operation === 'profileSettings')).toHaveLength(1);
    expect(request.mock.calls.filter(([v]) => v.operation === 'refresh')).toHaveLength(1);
    if (status === 401) {
      await expect(session.updateProfileSettings('privacy', input)).rejects.toThrow();
      expect(request.mock.calls.filter(([v]) => v.operation === 'profileSettings')).toHaveLength(1);
      return;
    }
    await expect(session.updateProfileSettings('privacy', input)).rejects.toThrow();
    const calls = request.mock.calls.filter(([v]) => v.operation === 'profileSettings');
    expect(calls[0]?.[0].body).toBe(calls[1]?.[0].body);
    expect(calls[0]?.[0].headers?.['idempotency-key']).toBe(
      calls[1]?.[0].headers?.['idempotency-key'],
    );
  },
);
it.each(['logout', 'rotation'] as const)(
  'rejects duplicate and late success after %s',
  async (mode) => {
    let finish!: (v: Awaited<ReturnType<IOSSessionPlugin['request']>>) => void;
    const request = vi.fn<IOSSessionPlugin['request']>((v) =>
      v.operation === 'profileSettings'
        ? new Promise((r) => {
            finish = r;
          })
        : Promise.resolve(fixtureReply(v)),
    );
    const session = syntheticSession(request);
    await session.restore();
    const pending = session.updateProfileSettings('privacy', input),
      rejected = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(finish).toBeDefined());
    await expect(session.updateProfileSettings('privacy', input)).rejects.toThrow();
    if (mode === 'logout') session.closeQuarterCreate();
    else
      await session.read((api) => {
        api.setAccessToken('synthetic-rotated');
        return Promise.resolve();
      });
    finish(nativeResult({ ...input, version: 1 }));
    await rejected;
    expect(request.mock.calls.filter(([v]) => v.operation === 'profileSettings')).toHaveLength(1);
  },
);
it('rejects a token rotation while SDK decodes a success response', async () => {
  const request = vi.fn<IOSSessionPlugin['request']>((v) =>
    Promise.resolve(
      v.operation === 'profileSettings' ? nativeResult({ marker: true }) : fixtureReply(v),
    ),
  );
  const session = syntheticSession(request);
  await session.restore();
  // eslint-disable-next-line @typescript-eslint/unbound-method -- called with original response receiver below.
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
    const pending = session.updateProfileSettings('privacy', input),
      rejected = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(release).toBeDefined());
    await session.read((api) => {
      api.setAccessToken('synthetic-rotated');
      return Promise.resolve();
    });
    release({ version: 1 });
    await rejected;
  } finally {
    spy.mockRestore();
  }
});
it('new token owns independent custody while old completion cannot retire it', async () => {
  const pending: Array<(v: Awaited<ReturnType<IOSSessionPlugin['request']>>) => void> = [];
  const request = vi.fn<IOSSessionPlugin['request']>((v) =>
    v.operation === 'profileSettings'
      ? new Promise((r) => pending.push(r))
      : Promise.resolve(fixtureReply(v)),
  );
  const session = syntheticSession(request);
  await session.restore();
  const first = session.updateProfileSettings('privacy', input),
    firstRejected = expect(first).rejects.toThrow();
  await vi.waitFor(() => expect(pending).toHaveLength(1));
  await session.read((api) => {
    api.setAccessToken('synthetic-new-token');
    return Promise.resolve();
  });
  const second = session.updateProfileSettings('privacy', input);
  await vi.waitFor(() => expect(pending).toHaveLength(2));
  pending[0]!(nativeResult({ version: 1 }));
  await firstRejected;
  await expect(session.updateProfileSettings('privacy', input)).rejects.toThrow();
  pending[1]!(nativeResult({ version: 1 }));
  await expect(second).resolves.toMatchObject({ version: 1 });
});
