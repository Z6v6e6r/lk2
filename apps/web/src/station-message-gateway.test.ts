// @vitest-environment jsdom
import { it, expect, vi } from 'vitest';
import { createBrowserAuthGateway } from './auth-gateway.js';
const id = '11111111-1111-4111-8111-111111111111';
const receipt = {
  contractVersion: 1,
  contract: 'station-message',
  requestId: id,
  outcome: 'UNKNOWN',
  code: 'MESSAGE_RECEIPT_UNPROVEN',
};
const session = {
  accessToken: 'synthetic',
  tokenType: 'Bearer',
  expiresAt: '2099-01-01T00:00:00.000Z',
  user: { id, displayName: 'Player' },
  context: {
    userId: id,
    tenantId: '22222222-2222-4222-8222-222222222222',
    displayName: 'Player',
    phoneLast4: '0001',
    roles: ['client'],
    permissions: [],
  },
};
it('gateway rejects late old-session receipt after logout, without automatic new request', async () => {
  let finish!: (response: Response) => void;
  const transport = vi.fn<typeof fetch>(async (url) => {
    if ((url instanceof Request ? url.url : url.toString()).endsWith('/auth/session'))
      return Response.json(session);
    if ((url instanceof Request ? url.url : url.toString()).endsWith('/auth/logout'))
      return new Response(null, { status: 204 });
    if ((url instanceof Request ? url.url : url.toString()).includes('/message-requests'))
      return new Promise<Response>((resolve) => {
        finish = resolve;
      });
    return Response.json(session);
  });
  const gateway = createBrowserAuthGateway({
    baseUrl: 'https://api.example.test',
    tenantKey: 'test',
    appVersion: 'test',
    fetchImplementation: transport,
  });
  await gateway.restoreSession();
  const pending = gateway.sendStationCommunityMessage!(id, { requestId: id, text: 'hello' });
  await gateway.logout();
  finish(Response.json(receipt));
  await expect(pending).rejects.toThrow('AUTH_PRINCIPAL_CHANGED');
  expect(
    transport.mock.calls.filter(([url]) =>
      (url instanceof Request ? url.url : url.toString()).includes('/message-requests'),
    ),
  ).toHaveLength(1);
  await expect(gateway.getStationCommunityMessageRequest!(id, id)).rejects.toThrow(
    'AUTH_PRINCIPAL_CHANGED',
  );
});
