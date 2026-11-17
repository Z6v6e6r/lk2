// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import type { SubmitGameResultRequest } from '@phub/api-sdk';
import { createBrowserAuthGateway } from '../../web/src/auth-gateway.js';
import { createNativeApiFetch, type AndroidSessionPlugin } from './native-api-fetch.js';
import { auth, config } from './ios/testing/cabinet-fixtures.js';

const id = '11111111-1111-4111-8111-111111111111';
const submission = '55555555-5555-4555-8555-555555555555';
const body: SubmitGameResultRequest = {
  sets: [
    {
      setNumber: 1,
      teamAUserIds: [id, '22222222-2222-4222-8222-222222222222'],
      teamBUserIds: [
        '33333333-3333-4333-8333-333333333333',
        '44444444-4444-4444-8444-444444444444',
      ],
      teamA: 6,
      teamB: 4,
    },
  ],
};
const reply = (value: unknown) => ({
  status: 200,
  headers: { 'content-type': 'application/json' },
  body: Buffer.from(JSON.stringify(value)).toString('base64'),
});
function harness() {
  let current = auth;
  let fail!: (error: Error) => void;
  let finish!: (value: ReturnType<typeof reply>) => void;
  const request = vi.fn<AndroidSessionPlugin['request']>((input) => {
    if (input.path.endsWith('/auth/session/refresh')) return Promise.resolve(reply(current));
    if (input.path.endsWith('/auth/session')) return Promise.resolve(reply({}));
    return new Promise((resolve, reject) => {
      fail = reject;
      finish = resolve;
    });
  });
  const plugin = { configuration: vi.fn().mockResolvedValue(config), request };
  const fetcher = createNativeApiFetch(config, plugin);
  const gateway = createBrowserAuthGateway({
    baseUrl: config.apiBaseUrl,
    tenantKey: config.tenantKey,
    appVersion: 'test',
    platform: 'android',
    nativeSessionTransport: true,
    fetchImplementation: fetcher,
  });
  return {
    gateway,
    fetcher,
    request,
    fail: () =>
      fail(
        Object.assign(new Error('synthetic native transport failure'), {
          code: 'NATIVE_NETWORK_UNAVAILABLE',
        }),
      ),
    finish: () => finish(reply({})),
    switchAccount: () => {
      const userId = '77777777-7777-4777-8777-777777777777';
      current = {
        ...auth,
        accessToken: 'synthetic-new-account-token',
        user: { ...auth.user, id: userId },
        context: { ...auth.context, userId },
      };
    },
  };
}
const invoke = (gateway: ReturnType<typeof createBrowserAuthGateway>, command: string) =>
  command === 'submit'
    ? gateway.submitGameResult(id, body)
    : command === 'confirm'
      ? gateway.confirmGameResult(id, submission)
      : gateway.disputeGameResult(id, submission, { reasonCode: 'SCORE_INCORRECT' });
const resultCalls = (request: ReturnType<typeof harness>['request']) =>
  request.mock.calls.filter(([input]) => input.path.includes('/result-submissions'));

it.each(['submit', 'confirm', 'dispute'])(
  'never retries %s from A with B credentials after a lost native response',
  async (command) => {
    const h = harness();
    await h.gateway.restoreSession();
    const pending = invoke(h.gateway, command);
    const rejection = expect(pending).rejects.toThrow('AUTH_PRINCIPAL_CHANGED');
    await vi.waitFor(() => expect(resultCalls(h.request)).toHaveLength(1));
    h.gateway.closeQuarterCreate?.();
    await h.fetcher.cancelUpcomingBookingsRefresh();
    await h.gateway.logout();
    h.switchAccount();
    await h.gateway.restoreSession();
    h.fail();
    await rejection;
    expect(resultCalls(h.request)).toHaveLength(1);
  },
);
it.each(['submit', 'confirm', 'dispute'])(
  'discards late %s success after local logout before push cleanup',
  async (command) => {
    const h = harness();
    await h.gateway.restoreSession();
    const pending = invoke(h.gateway, command);
    const rejection = expect(pending).rejects.toThrow('AUTH_PRINCIPAL_CHANGED');
    await vi.waitFor(() => expect(resultCalls(h.request)).toHaveLength(1));
    h.gateway.closeQuarterCreate?.();
    await h.fetcher.cancelUpcomingBookingsRefresh();
    h.finish();
    await rejection;
    expect(resultCalls(h.request)).toHaveLength(1);
  },
);
it('retains the original body and key for a same-account bounded network retry', async () => {
  const h = harness();
  await h.gateway.restoreSession();
  const pending = invoke(h.gateway, 'submit');
  await vi.waitFor(() => expect(resultCalls(h.request)).toHaveLength(1));
  h.fail();
  await vi.waitFor(() => expect(resultCalls(h.request)).toHaveLength(2));
  const calls = resultCalls(h.request);
  expect(calls[1]?.[0].headers['idempotency-key']).toBe(calls[0]?.[0].headers['idempotency-key']);
  expect(calls[1]?.[0].body).toBe(calls[0]?.[0].body);
  h.finish();
  await pending;
});
