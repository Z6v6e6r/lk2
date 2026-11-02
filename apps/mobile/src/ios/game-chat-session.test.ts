import { afterEach, expect, it, vi } from 'vitest';
import {
  fixtureReply,
  nativeResult,
  syntheticSession,
  config,
} from './testing/cabinet-fixtures.js';
import { createIOSFetch, type IOSSessionPlugin } from './session.js';
const id = '11111111-1111-4111-8111-111111111111';
afterEach(() => vi.restoreAllMocks());
it('uses one authenticated game command and never refreshes/replays a rejected write', async () => {
  const request = vi.fn<IOSSessionPlugin['request']>(
    async (input) =>
      await Promise.resolve(
        input.resource === 'createGame'
          ? {
              status: 401,
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ error: { code: 'AUTH_REQUIRED', message: 'expired' } }),
            }
          : fixtureReply(input),
      ),
  );
  const session = syntheticSession(request);
  await session.restore();
  await expect(session.openGameChat(id)).rejects.toThrow();
  const writes = request.mock.calls.filter(([v]) => v.resource === 'createGame');
  expect(writes).toHaveLength(1);
  expect(writes[0]![0]).toMatchObject({
    operation: 'messaging',
    body: JSON.stringify({ gameId: id }),
  });
  expect(writes[0]![0].headers['idempotency-key']).toBeTruthy();
  expect(request.mock.calls.filter(([v]) => v.operation === 'refresh')).toHaveLength(1);
});
it('late game-chat result cannot survive logout and duplicate in-flight click cannot dispatch', async () => {
  let resolve!: (v: Awaited<ReturnType<IOSSessionPlugin['request']>>) => void;
  const request = vi.fn<IOSSessionPlugin['request']>((input) =>
    input.resource === 'createGame'
      ? new Promise((r) => {
          resolve = r;
        })
      : Promise.resolve(fixtureReply(input)),
  );
  const session = syntheticSession(request);
  await session.restore();
  const pending = session.openGameChat(id);
  const rejection = expect(pending).rejects.toThrow();
  await vi.waitFor(() => expect(resolve).toBeDefined());
  await expect(session.openGameChat(id)).rejects.toThrow();
  session.closeQuarterCreate();
  resolve(nativeResult({ outcome: 'ok', conversation: { id }, created: true, replayed: false }));
  await rejection;
  expect(request.mock.calls.filter(([v]) => v.resource === 'createGame')).toHaveLength(1);
});
it('direct bridge callers cannot bypass game-chat custody', async () => {
  const request = vi.fn<IOSSessionPlugin['request']>();
  await expect(
    createIOSFetch(config, { request, configuration: () => Promise.resolve(config) })(
      `${config.apiBaseUrl}/user/api/v1/${config.tenantKey}/conversations/game`,
      {
        method: 'POST',
        headers: { authorization: 'Bearer synthetic', 'idempotency-key': 'synthetic-game-key' },
        body: JSON.stringify({ gameId: id }),
      },
    ),
  ).rejects.toThrow();
  expect(request).not.toHaveBeenCalled();
});
