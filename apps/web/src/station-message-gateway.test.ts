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
it.each([204, 503])(
  'Android original epoch fences a late station ACK during pending logout %i',
  async (status) => {
    let finish!: (r: Response) => void;
    let revoke!: (r: Response) => void;
    const transport = vi.fn<typeof fetch>(async (raw, init) => {
      await Promise.resolve();
      const url = raw instanceof Request ? raw.url : raw.toString();
      if (url.endsWith('/auth/session/refresh')) return Response.json(session);
      if (url.endsWith('/auth/session') && init?.method === 'DELETE')
        return await new Promise<Response>((r) => {
          revoke = r;
        });
      if (url.includes('/message-requests'))
        return await new Promise<Response>((r) => {
          finish = r;
        });
      return new Response(null, { status: 404 });
    });
    const gateway = createBrowserAuthGateway({
      baseUrl: 'https://api.example.test',
      tenantKey: 'test',
      appVersion: 'test',
      platform: 'android',
      nativeSessionTransport: true,
      fetchImplementation: transport,
    });
    await gateway.restoreSession();
    const original = gateway.stationMessagePrincipal!();
    expect(original).not.toBeNull();
    const pending = gateway.sendStationCommunityMessage!(id, { requestId: id, text: 'hello' });
    const rejection = expect(pending).rejects.toThrow('AUTH_PRINCIPAL_CHANGED');
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    const closing = gateway.logout().catch(() => undefined);
    expect(gateway.stationMessagePrincipal!()).toBeNull();
    await expect(
      gateway.sendStationCommunityMessage!(id, { requestId: id, text: 'hello' }),
    ).rejects.toThrow('AUTH_PRINCIPAL_CHANGED');
    await expect(gateway.getStationCommunityMessageRequest!(id, id)).rejects.toThrow(
      'AUTH_PRINCIPAL_CHANGED',
    );
    finish(Response.json(receipt));
    await rejection;
    await vi.waitFor(() => expect(revoke).toBeTypeOf('function'));
    revoke(new Response(null, { status }));
    await closing;
    expect(
      transport.mock.calls.filter(([raw]) =>
        (raw instanceof Request ? raw.url : raw.toString()).includes('/message-requests'),
      ),
    ).toHaveLength(1);
  },
);
