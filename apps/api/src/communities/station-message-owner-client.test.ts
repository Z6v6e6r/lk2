import { describe, it, expect, vi } from 'vitest';
import type { CommunityLegacyBridgeRepository } from '@phub/communities';
import { StationMessageOwnerClient } from './station-message-owner-client.js';
const id = '11111111-1111-4111-8111-111111111111';
const actor = {
  tenantKey: 'test',
  tenantId: id,
  userId: id,
  sessionId: id,
  communityId: id,
  correlationId: 'correlation',
};
const confirmed = {
  contractVersion: 1,
  contract: 'station-message',
  requestId: id,
  outcome: 'CONFIRMED',
  message: {
    id: '22222222-2222-8222-8222-222222222222',
    body: 'hello',
    sentAt: '2026-11-01T00:00:00.000Z',
    author: { displayName: 'Player' },
    isViewer: true,
  },
};
function setup(response: unknown = confirmed, status = 200) {
  const bridge = {
    getCommunityExternalId: vi.fn<
      NonNullable<CommunityLegacyBridgeRepository['getCommunityExternalId']>
    >(() => Promise.resolve('private-community')),
    getViewerIdentity: vi.fn(() => Promise.resolve({})),
    resolveCommunityIds: vi.fn(() => Promise.resolve(new Map())),
  };
  const token = vi.fn(() => Promise.resolve('synthetic-user-token'));
  const transport = vi.fn<typeof fetch>(() => Promise.resolve(Response.json(response, { status })));
  return {
    bridge,
    token,
    transport,
    client: new StationMessageOwnerClient({
      baseUrl: 'https://lk.example.test',
      timeoutMs: 100,
      bridge,
      token,
      fetchImplementation: transport,
    }),
  };
}
describe('station message owner session custody', () => {
  it('uses only new canonical routes with exact original key/body and actor delegation; GET never dispatches', async () => {
    const { client, token, transport, bridge } = setup();
    expect(await client.send(actor, { requestId: id, text: ' hello ' })).toEqual(confirmed);
    await client.status(actor, id);
    expect(token).toHaveBeenCalledWith(actor);
    expect(bridge.getViewerIdentity).not.toHaveBeenCalled();
    expect(bridge.resolveCommunityIds).not.toHaveBeenCalled();
    expect(
      transport.mock.calls.map(([url]) => (url instanceof Request ? url.url : url.toString())),
    ).toEqual([
      'https://lk.example.test/lk/communities/private-community/message-requests',
      `https://lk.example.test/lk/communities/private-community/message-requests/${id}`,
    ]);
    expect(transport.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      redirect: 'error',
      body: JSON.stringify({ requestId: id, text: ' hello ' }),
      headers: {
        Authorization: 'Bearer synthetic-user-token',
        'X-PadlHub-Community-Message-Contract': 'station-message.v1',
      },
    });
    expect(transport.mock.calls[1]?.[1]).not.toHaveProperty('body');
  });
  it('denies absent or ambiguous public mapping before token/remote and never creates one', async () => {
    const { client, bridge, token, transport } = setup();
    vi.mocked(bridge.getCommunityExternalId).mockResolvedValue(undefined);
    await expect(client.status(actor, id)).rejects.toMatchObject({ status: 403 });
    expect(bridge.getCommunityExternalId).toHaveBeenCalledWith(actor.tenantId, actor.communityId);
    expect(token).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
  });
  it('denies missing/revoked session delegation without anonymous fallback', async () => {
    const { client, token, transport } = setup();
    await expect(client.status({ ...actor, sessionId: '' }, id)).rejects.toThrow();
    token.mockRejectedValue(new Error('private-error-not-exposed'));
    await expect(client.status(actor, id)).rejects.toThrow('STATION_MESSAGE_UNAVAILABLE');
    expect(transport).not.toHaveBeenCalled();
  });
  it.each([
    {},
    { ...confirmed, requestId: '33333333-3333-4333-8333-333333333333' },
    { ...confirmed, privateId: 'hidden' },
    { ...confirmed, message: { ...confirmed.message, body: 'other' } },
  ])('fails closed malformed/mismatched receipt without retry', async (value) => {
    const { client, transport } = setup(value);
    await expect(client.send(actor, { requestId: id, text: 'hello' })).rejects.toThrow();
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it.each([403, 404, 503])('status %i never creates candidate or falls back', async (status) => {
    const { client, transport } = setup({}, status);
    await expect(client.status(actor, id)).rejects.toThrow();
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls[0]?.[1]?.method).toBe('GET');
  });
  it('retains versioned UNKNOWN and bounds broken upstream responses', async () => {
    const value = {
      contractVersion: 1,
      contract: 'station-message',
      requestId: id,
      outcome: 'UNKNOWN',
      code: 'MESSAGE_RECEIPT_UNPROVEN',
    };
    expect(await setup(value).client.status(actor, id)).toEqual(value);
    const { client, transport } = setup();
    transport.mockResolvedValue(new Response('x'.repeat(40001)));
    await expect(client.status(actor, id)).rejects.toThrow();
  });
});

it.each([401, 403, 404])(
  'three expected owner %i denials do not open breaker for another actor',
  async (status) => {
    const { client, transport } = setup({}, status);
    for (let i = 0; i < 3; i++)
      await expect(client.status(actor, id)).rejects.toMatchObject({ status: 403 });
    transport.mockResolvedValueOnce(Response.json(confirmed));
    expect(await client.status({ ...actor, userId: 'other' }, id)).toEqual(confirmed);
    expect(transport).toHaveBeenCalledTimes(4);
  },
);
it('three absent mappings do not open the remote breaker; transport failures do', async () => {
  const { client, bridge, transport } = setup();
  bridge.getCommunityExternalId.mockResolvedValue(undefined);
  for (let i = 0; i < 3; i++)
    await expect(client.status(actor, id)).rejects.toMatchObject({ status: 403 });
  bridge.getCommunityExternalId.mockResolvedValue('private-community');
  expect(await client.status(actor, id)).toEqual(confirmed);
  transport.mockRejectedValue(new Error('network'));
  for (let i = 0; i < 4; i++) await expect(client.status(actor, id)).rejects.toThrow();
  expect(transport).toHaveBeenCalledTimes(4);
});
it('rejects arbitrary uppercase owner codes rather than exposing them', async () => {
  const { client } = setup({
    contractVersion: 1,
    contract: 'station-message',
    requestId: id,
    outcome: 'UNKNOWN',
    code: 'ARBITRARY_PRIVATE_CODE',
  });
  await expect(client.status(actor, id)).rejects.toThrow('STATION_MESSAGE_UNAVAILABLE');
});

it('does not normalize an unsafe existing mapping into a different owner route', async () => {
  const { client, bridge, token, transport } = setup();
  bridge.getCommunityExternalId.mockResolvedValue('..');
  await expect(client.status(actor, id)).rejects.toMatchObject({ status: 403 });
  expect(token).not.toHaveBeenCalled();
  expect(transport).not.toHaveBeenCalled();
});
