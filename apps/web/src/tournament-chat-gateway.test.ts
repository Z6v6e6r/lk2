// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { createBrowserAuthGateway } from './auth-gateway.js';
const id = '10000000-0000-4000-8000-000000000001';
const session = {
  accessToken: 'synthetic',
  tokenType: 'Bearer',
  expiresAt: '2099-01-01T00:00:00.000Z',
  user: { id, displayName: 'Synthetic' },
  context: {
    userId: id,
    tenantId: '10000000-0000-4000-8000-000000000002',
    displayName: 'Synthetic',
    phoneLast4: '0001',
    roles: ['client'],
    permissions: [],
  },
};
it('actual gateway refuses late tournament ACK after logout and no automatic retry', async () => {
  let finish!: (r: Response) => void;
  const transport = vi.fn<typeof fetch>((raw) => {
    const url = raw instanceof Request ? raw.url : raw.toString();
    if (url.includes('/chat/message-requests'))
      return new Promise((r) => {
        finish = r;
      });
    if (url.endsWith('/auth/logout')) return Promise.resolve(new Response(null, { status: 204 }));
    return Promise.resolve(Response.json(session));
  });
  const gateway = createBrowserAuthGateway({
    baseUrl: 'https://api.invalid',
    tenantKey: 'synthetic',
    appVersion: 'test',
    fetchImplementation: transport,
  });
  await gateway.restoreSession();
  expect(gateway.tournamentChatPrincipal!()).not.toBeNull();
  const pending = gateway.getTournamentChatRequest!(id, id);
  const assertion = expect(pending).rejects.toThrow('AUTH_PRINCIPAL_CHANGED');
  await gateway.logout();
  finish(
    Response.json({
      contractVersion: 'tournament-chat.v1',
      tournamentId: id,
      requestId: id,
      status: 'UNKNOWN',
    }),
  );
  await assertion;
  await expect(gateway.getTournamentChatRequest!(id, id)).rejects.toThrow('AUTH_PRINCIPAL_CHANGED');
  expect(
    transport.mock.calls.filter((c) =>
      (c[0] instanceof Request ? c[0].url : c[0].toString()).includes('/chat/'),
    ),
  ).toHaveLength(1);
});
it('native gateway denies tournament API even if directly invoked', async () => {
  const transport = vi.fn<typeof fetch>();
  const gateway = createBrowserAuthGateway({
    baseUrl: 'https://api.invalid',
    tenantKey: 'synthetic',
    appVersion: 'test',
    platform: 'android',
    fetchImplementation: transport,
  });
  expect(gateway.tournamentChatPrincipal!()).toBeNull();
  await expect(
    gateway.sendTournamentChatMessage!(id, { requestId: id, text: 'x' }),
  ).rejects.toThrow();
  await expect(gateway.getTournamentChatRequest!(id, id)).rejects.toThrow();
  await expect(gateway.getTournamentChatHistory!(id)).rejects.toThrow();
  expect(transport).not.toHaveBeenCalled();
});
