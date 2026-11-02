import { describe, it, expect, vi } from 'vitest';
import { PadlHubApiClient } from './index.js';
const input = {
  stationId: '11111111-1111-4111-8111-000000000003',
  courtId: '11111111-1111-4111-8111-000000000004',
  subscriptionId: '11111111-1111-4111-8111-000000000005',
  startsAt: '2030-01-01T12:00:00.000Z',
};
describe('quarter API transport', () => {
  it('uses PadlHub-only paths, original body/key and no retry after401', async () => {
    const fetchImplementation = vi.fn(async () => {
        await Promise.resolve();
        return new Response(JSON.stringify({ code: 'AUTH_REQUIRED', message: 'Session expired' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        });
      }),
      client = new PadlHubApiClient({
        baseUrl: 'https://padlhub.invalid',
        tenantKey: 'synthetic',
        platform: 'web',
        appVersion: 'synthetic',
        fetchImplementation,
      });
    await expect(client.createQuarterGame(input, 'synthetic-original-key')).rejects.toThrow();
    expect(fetchImplementation).toHaveBeenCalledOnce();
    expect(fetchImplementation.mock.calls[0]).toMatchObject([
      'https://padlhub.invalid/user/api/v1/synthetic/game-create-operations',
      { method: 'POST', body: JSON.stringify(input), cache: 'no-store' },
    ]);
  });
  it('status uses GET by-key and manual reconciliation uses POST original operation only', async () => {
    const fetchImplementation = vi.fn(async () => {
        await Promise.resolve();
        return new Response('{}', { headers: { 'Content-Type': 'application/json' } });
      }),
      client = new PadlHubApiClient({
        baseUrl: 'https://padlhub.invalid',
        tenantKey: 'synthetic',
        platform: 'web',
        appVersion: 'synthetic',
        fetchImplementation,
      });
    await client.getQuarterCreateOperation('synthetic-original-key');
    await client.reconcileQuarterCreateOperation(input.courtId, input, 'synthetic-original-key');
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
    expect(fetchImplementation).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('/game-create-operations/by-key'),
      expect.anything(),
    );
    expect(fetchImplementation.mock.calls[1]).toMatchObject([
      expect.stringContaining('/' + input.courtId + '/reconcile'),
      { method: 'POST', body: JSON.stringify(input) },
    ]);
  });
});
