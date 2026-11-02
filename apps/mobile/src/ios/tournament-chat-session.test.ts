import { afterEach, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { fixtureReply, nativeResult, syntheticSession } from './testing/cabinet-fixtures.js';
import type { IOSSessionPlugin } from './session.js';
const tid = '11111111-1111-4111-8111-111111111111',
  key = '22222222-2222-4222-8222-222222222222';
const read = { requestId: key, streamId: tid, witnessHash: 'a'.repeat(64), throughSequence: 42 };
const receipt = (resource: string) => ({
  contractVersion:
    resource === 'send' || resource === 'status' ? 'tournament-chat.v1' : 'tournament-chat-read.v1',
  tournamentId: tid,
  requestId: key,
  status: 'UNKNOWN',
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it.each([401, 403, 404, 503, 0])('never retries either native command after %i', async (status) => {
  vi.stubGlobal('crypto', webcrypto);
  for (const resource of ['send', 'read']) {
    const request = vi.fn<IOSSessionPlugin['request']>((input) => {
      if (input.operation !== 'tournamentChat') return Promise.resolve(fixtureReply(input));
      return status
        ? Promise.resolve(nativeResult({}, status))
        : Promise.reject(Object.assign(Error('offline'), { code: 'NATIVE_NETWORK_UNAVAILABLE' }));
    });
    const session = syntheticSession(request);
    await session.restore();
    await expect(
      resource === 'send'
        ? session.sendTournamentChatMessage(tid, { requestId: key, text: 'hello' })
        : session.advanceTournamentChatRead(tid, read),
    ).rejects.toThrow();
    const calls = request.mock.calls.filter(([v]) => v.operation === 'tournamentChat');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toMatchObject({
      operation: 'tournamentChat',
      resource,
      resourceId: tid,
      requestId: key,
      query: {},
      body: JSON.stringify(resource === 'send' ? { requestId: key, text: 'hello' } : read),
    });
  }
});
it('UNKNOWN recovery only reads the original request and never replays commands', async () => {
  vi.stubGlobal('crypto', webcrypto);
  const request = vi.fn<IOSSessionPlugin['request']>((input) =>
    Promise.resolve(
      input.operation === 'tournamentChat'
        ? nativeResult(receipt(input.resource!))
        : fixtureReply(input),
    ),
  );
  const session = syntheticSession(request);
  await session.restore();
  expect(
    await session.sendTournamentChatMessage(tid, { requestId: key, text: 'hello' }),
  ).toMatchObject({ status: 'UNKNOWN' });
  await session.tournamentChatStatus(tid, key);
  expect(await session.advanceTournamentChatRead(tid, read)).toMatchObject({ status: 'UNKNOWN' });
  await session.tournamentChatReadStatus(tid, key);
  expect(
    request.mock.calls.filter(([v]) => v.operation === 'tournamentChat').map(([v]) => v.resource),
  ).toEqual(['send', 'status', 'read', 'readStatus']);
});
it.each(['send', 'read'])('logout during hash prevents native %s dispatch', async (resource) => {
  vi.stubGlobal('crypto', webcrypto);
  let finish!: () => void;
  const digest = webcrypto.subtle.digest.bind(webcrypto.subtle);
  vi.spyOn(webcrypto.subtle, 'digest').mockImplementationOnce(
    (...args) =>
      new Promise((resolve, reject) => {
        finish = () => {
          void digest(...args).then(resolve, reject);
        };
      }),
  );
  const request = vi.fn<IOSSessionPlugin['request']>((input) =>
    Promise.resolve(fixtureReply(input)),
  );
  const session = syntheticSession(request);
  await session.restore();
  const pending =
    resource === 'send'
      ? session.sendTournamentChatMessage(tid, { requestId: key, text: 'hello' })
      : session.advanceTournamentChatRead(tid, read);
  const rejected = expect(pending).rejects.toThrow();
  expect(finish).toBeTypeOf('function');
  session.closeQuarterCreate();
  finish();
  await rejected;
  expect(request.mock.calls.filter(([v]) => v.operation === 'tournamentChat')).toHaveLength(0);
});
it.each(['history', 'position', 'status', 'readStatus', 'send', 'read'])(
  'discards late %s after principal closure',
  async (resource) => {
    vi.stubGlobal('crypto', webcrypto);
    let finish!: (value: ReturnType<typeof nativeResult>) => void;
    const request = vi.fn<IOSSessionPlugin['request']>((input) =>
      input.operation === 'tournamentChat'
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : Promise.resolve(fixtureReply(input)),
    );
    const session = syntheticSession(request);
    await session.restore();
    const pending =
      resource === 'history'
        ? session.tournamentChatHistory(tid)
        : resource === 'position'
          ? session.tournamentChatReadPosition(tid)
          : resource === 'status'
            ? session.tournamentChatStatus(tid, key)
            : resource === 'readStatus'
              ? session.tournamentChatReadStatus(tid, key)
              : resource === 'send'
                ? session.sendTournamentChatMessage(tid, { requestId: key, text: 'hello' })
                : session.advanceTournamentChatRead(tid, read);
    const rejected = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    session.closeQuarterCreate();
    finish(nativeResult(receipt(resource)));
    await rejected;
    await expect(session.tournamentChatStatus(tid, key)).rejects.toThrow();
    expect(request.mock.calls.filter(([v]) => v.operation === 'tournamentChat')).toHaveLength(1);
  },
);
