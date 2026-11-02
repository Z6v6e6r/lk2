import { describe, it, expect, vi } from 'vitest';
import { PadlHubApiClient } from './index.js';
const id = '11111111-1111-4111-a111-111111111111';
describe('tournament SDK single explicit mutation', () => {
  it.each(['network', 401, 503])('never auto retries %s or refreshes new actor', async (status) => {
    const fetchImplementation = vi.fn<typeof fetch>();
    if (status === 'network') fetchImplementation.mockRejectedValue(new TypeError('offline'));
    else
      fetchImplementation.mockResolvedValue(
        new Response(
          JSON.stringify({
            error: { code: 'UNAVAILABLE', message: 'test', correlationId: 'test' },
          }),
          { status: status as number },
        ),
      );
    const client = new PadlHubApiClient({
      baseUrl: 'https://api.example.test',
      tenantKey: 'local',
      platform: 'web',
      appVersion: 'test',
      fetchImplementation,
    });
    client.setAccessToken('synthetic');
    await expect(client.commandTournament(id, { action: 'JOIN' }, id)).rejects.toThrow();
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
  });
  it('recovery names existing public operation with key and no body', async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}'));
    const client = new PadlHubApiClient({
      baseUrl: 'https://api.example.test',
      tenantKey: 'local',
      platform: 'web',
      appVersion: 'test',
      fetchImplementation,
    });
    client.setAccessToken('synthetic');
    await client.retryTournament(id, id, id);
    const [url, options] = fetchImplementation.mock.calls[0]!;
    expect(typeof url === 'string' ? url : url instanceof URL ? url.href : url.url).toContain(
      `/registration-operations/${id}/retry`,
    );
    expect(options?.body).toBeUndefined();
    expect(new Headers(options?.headers).get('Idempotency-Key')).toBe(id);
  });
  it('status is an explicit availability envelope and a read only request', async () => {
    const status = { commandsEnabled: false, result: null },
      fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(Response.json(status));
    const client = new PadlHubApiClient({
      baseUrl: 'https://api.example.test',
      tenantKey: 'local',
      platform: 'web',
      appVersion: 'test',
      fetchImplementation,
    });
    client.setAccessToken('synthetic');
    expect(await client.getTournamentRegistration(id, {})).toEqual(status);
    const [, request] = fetchImplementation.mock.calls[0]!;
    expect(request?.method ?? 'GET').toBe('GET');
    expect(request?.body).toBeUndefined();
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
  });
});
