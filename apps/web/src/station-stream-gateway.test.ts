// @vitest-environment jsdom
import { it, expect, vi } from 'vitest';
import { createBrowserAuthGateway } from './auth-gateway.js';
const id = '11111111-1111-4111-8111-111111111111';
const session = {
  accessToken: 'synthetic',
  tokenType: 'Bearer',
  expiresAt: '2099-01-01T00:00:00.000Z',
  user: { id, displayName: 'Player' },
  context: {
    userId: id,
    tenantId: '22222222-2222-4222-8222-222222222222',
    displayName: 'Player',
    phoneLast4: '0101',
    roles: ['client'],
    permissions: [],
  },
};
it.each([
  ['web', 204],
  ['web', 503],
  ['android', 204],
  ['android', 503],
] as const)(
  'actual gateway fences v3 reads/commands synchronously during pending logout %s/%i',
  async (platform, status) => {
    let finish!: (r: Response) => void, revoke!: (r: Response) => void;
    const transport = vi.fn<typeof fetch>((raw, init) => {
      const url = raw instanceof Request ? raw.url : raw.toString();
      if (url.endsWith('/auth/session') && init?.method === 'DELETE')
        return new Promise((resolve) => {
          revoke = resolve;
        });
      if (url.endsWith('/auth/session') || url.endsWith('/auth/session/refresh'))
        return Promise.resolve(Response.json(session));
      if (url.endsWith('/auth/logout'))
        return new Promise((resolve) => {
          revoke = resolve;
        });
      if (url.includes('/read-requests'))
        return new Promise((resolve) => {
          finish = resolve;
        });
      return Promise.resolve(new Response(null, { status: 404 }));
    });
    const gateway = createBrowserAuthGateway({
      baseUrl: 'https://api.invalid',
      tenantKey: 'test',
      appVersion: 'test',
      platform,
      nativeSessionTransport: platform === 'android',
      fetchImplementation: transport,
    });
    await gateway.restoreSession();
    const pending = gateway.requestStationCommunityRead!(id, {
      requestId: id,
      streamId: id,
      membershipEpoch: 0,
      throughSequence: 1,
    });
    const denied = expect(pending).rejects.toThrow('AUTH_PRINCIPAL_CHANGED');
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    const closing = gateway.logout().catch(() => undefined);
    expect(gateway.stationMessagePrincipal!()).toBeNull();
    for (const call of [
      () => gateway.listStationStreamSummaries!([id]),
      () => gateway.getStationCommunityStream!(id),
      () => gateway.getStationCommunityReadRequest!(id, id),
      () =>
        gateway.requestStationCommunityRead!(id, {
          requestId: id,
          streamId: id,
          membershipEpoch: 0,
          throughSequence: 1,
        }),
    ])
      await expect(call()).rejects.toThrow('AUTH_PRINCIPAL_CHANGED');
    finish(
      Response.json({
        contractVersion: 1,
        contract: 'station-read',
        requestId: id,
        outcome: 'UNKNOWN',
        code: 'READ_RECEIPT_UNPROVEN',
      }),
    );
    await denied;
    await vi.waitFor(() => expect(revoke).toBeTypeOf('function'));
    revoke(new Response(null, { status }));
    await closing;
    expect(
      transport.mock.calls.filter(([raw]) =>
        (raw instanceof Request ? raw.url : raw.toString()).includes('/read-requests'),
      ),
    ).toHaveLength(1);
  },
);
it('native gateway denies v3 transport without authenticated principal', async () => {
  const transport = vi.fn<typeof fetch>();
  const gateway = createBrowserAuthGateway({
    baseUrl: 'https://api.invalid',
    tenantKey: 'test',
    appVersion: 'test',
    platform: 'android',
    nativeSessionTransport: true,
    fetchImplementation: transport,
  });
  await expect(gateway.listStationStreamSummaries!([id])).rejects.toThrow('AUTH_PRINCIPAL_CHANGED');
  expect(transport).not.toHaveBeenCalled();
});
