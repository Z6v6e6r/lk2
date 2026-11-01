import { describe, it, expect, vi } from 'vitest';
import { PadlHubApiClient, parseStationMessageReceipt } from './index.js';
const id = '11111111-1111-4111-8111-111111111111';
const unknown = {
  contractVersion: 1,
  contract: 'station-message',
  requestId: id,
  outcome: 'UNKNOWN',
  code: 'MESSAGE_RECEIPT_UNPROVEN',
};
function client(fetchImplementation: typeof fetch) {
  return new PadlHubApiClient({
    baseUrl: 'https://api.example.test',
    tenantKey: 'test',
    platform: 'web',
    appVersion: 'test',
    initialAccessToken: 'synthetic-padlhub-token',
    fetchImplementation,
  });
}
describe('station SDK original operation', () => {
  it('uses public IDs and original key, GET has no body or POST fallback', async () => {
    const transport = vi.fn<typeof fetch>(() => Promise.resolve(Response.json(unknown)));
    const api = client(transport);
    await api.sendStationCommunityMessage(id, { requestId: id, text: 'hello' });
    await api.getStationCommunityMessageRequest(id, id);
    expect(transport.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      headers: { 'Idempotency-Key': id, Authorization: 'Bearer synthetic-padlhub-token' },
    });
    expect(
      new URL(
        transport.mock.calls[1]![0] instanceof Request
          ? transport.mock.calls[1]![0].url
          : transport.mock.calls[1]![0].toString(),
      ).toString(),
    ).toContain(`/message-requests/${id}`);
    expect(transport.mock.calls[1]?.[1]).not.toHaveProperty('body');
  });
  it.each(['send', 'status'])(
    '401 %s does not refresh/replay under a changed principal',
    async (method) => {
      const transport = vi.fn<typeof fetch>(() =>
        Promise.resolve(Response.json({ code: 'AUTH_REQUIRED', message: 'auth' }, { status: 401 })),
      );
      const api = client(transport);
      await expect(
        method === 'send'
          ? api.sendStationCommunityMessage(id, { requestId: id, text: 'hello' })
          : api.getStationCommunityMessageRequest(id, id),
      ).rejects.toThrow();
      expect(transport).toHaveBeenCalledTimes(1);
    },
  );
  it.each([
    {},
    { ...unknown, requestId: '22222222-2222-4222-8222-222222222222' },
    { ...unknown, privateId: 'no' },
  ])('does not trust a missing/foreign/non-strict contract', (value) => {
    expect(() => parseStationMessageReceipt(value, id)).toThrow('UNKNOWN');
  });
});
