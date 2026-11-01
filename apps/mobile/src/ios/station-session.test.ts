import { expect, it, vi } from 'vitest';
import {
  syntheticSession,
  fixtureReply,
  nativeResult,
  viewerId,
} from './testing/cabinet-fixtures.js';
import { createIOSFetch } from './session.js';
const community = '22222222-2222-4222-8222-222222222222';
const id = '33333333-3333-4333-8333-333333333333';
const unknown = {
  contractVersion: 1,
  contract: 'station-message',
  requestId: id,
  outcome: 'UNKNOWN',
  code: 'MESSAGE_RECEIPT_UNPROVEN',
};
it.each([401, 403, 404, 503, 0])(
  'actual SDK never retries station mutation/status (%i)',
  async (status) => {
    const request = vi.fn(async (input: Parameters<typeof fixtureReply>[0]) => {
      await Promise.resolve();
      if (input.operation === 'stationMessage') {
        if (!status)
          throw Object.assign(new Error('synthetic'), { code: 'NATIVE_NETWORK_UNAVAILABLE' });
        return nativeResult(status === 503 ? unknown : {}, status);
      }
      return fixtureReply(input);
    });
    const session = syntheticSession(request);
    await session.restore();
    await expect(
      session.sendStationMessage(community, { requestId: id, text: 'hello' }),
    ).rejects.toThrow();
    expect(request.mock.calls.filter(([v]) => v.operation === 'stationMessage')).toHaveLength(1);
  },
);
it('matches typed original request and discards late ACK during synchronous logout closure', async () => {
  let finish!: (v: ReturnType<typeof nativeResult>) => void;
  const request = vi.fn(async (input: Parameters<typeof fixtureReply>[0]) =>
    input.operation === 'stationMessage'
      ? new Promise<ReturnType<typeof nativeResult>>((resolve) => {
          finish = resolve;
        })
      : fixtureReply(input),
  );
  const session = syntheticSession(request);
  await session.restore();
  const result = session.sendStationMessage(community, { requestId: id, text: 'hello' });
  const observed = result.catch((error) => error as Error);
  expect(request.mock.calls.at(-1)?.[0]).toMatchObject({
    operation: 'stationMessage',
    resource: 'send',
    resourceId: community,
    requestId: id,
    body: JSON.stringify({ requestId: id, text: 'hello' }),
  });
  session.closeQuarterCreate();
  finish(nativeResult(unknown));
  expect(await observed).toBeInstanceOf(Error);
  await expect(session.stationMessageStatus(community, id)).rejects.toThrow();
  expect(request.mock.calls.filter(([v]) => v.operation === 'stationMessage')).toHaveLength(1);
});
it('reads history/status with no command and rejects unbound bridge calls', async () => {
  const request = vi.fn(
    async (input: Parameters<typeof fixtureReply>[0]) =>
      await Promise.resolve(
        input.operation === 'stationMessage'
          ? nativeResult(
              input.resource === 'history'
                ? { items: [], canRequestStationMessage: true }
                : unknown,
            )
          : fixtureReply(input),
      ),
  );
  const session = syntheticSession(request);
  await session.restore();
  await session.stationHistory(community);
  await session.stationMessageStatus(community, id);
  expect(
    request.mock.calls.filter(([v]) => v.operation === 'stationMessage').map(([v]) => v.resource),
  ).toEqual(['history', 'status']);
  const transport = createIOSFetch(session.configuration, {
    configuration: () => Promise.resolve(session.configuration),
    request,
  });
  await expect(
    transport(
      `${session.configuration.apiBaseUrl}/user/api/v1/${session.configuration.tenantKey}/community-views/${community}/message-requests`,
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer synthetic.session',
          'idempotency-key': id,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ requestId: id, text: 'hello' }),
      },
    ),
  ).rejects.toThrow('Session changed');
  expect(viewerId).toBeTruthy();
});
