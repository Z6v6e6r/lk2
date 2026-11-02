import { describe, it, expect, vi } from 'vitest';
import fixture from './fixtures/station-notification-owner-wire.json';
import { StationNotificationClient } from './station-notification-client.js';
import { stationRequests } from './station-notification-protocol.js';
const sample = fixture.operations[2]!,
  request = stationRequests.eligibility.parse(sample.request);
describe('station owner readonly bounded client', () => {
  it('uses exact origin/headers/body and has a nonextendable authorization budget', async () => {
    let now = sample.response.checkedAtMs,
      mono = 0;
    const fetch = vi.fn((url: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.redirect).toBe('error');
      expect(init?.method).toBe('POST');
      expect(init?.headers).toMatchObject({ 'x-correlation-id': request.requestId });
      const r = new Response(JSON.stringify(sample.response));
      Object.defineProperty(r, 'url', {
        value: typeof url === 'string' ? url : url instanceof URL ? url.href : url.url,
      });
      return Promise.resolve(r);
    });
    const client = new StationNotificationClient({
      origin: 'https://owner.example.test',
      sign: () => 'synthetic',
      fetch,
      now: () => now,
      monotonic: () => mono,
    });
    const accepted = await client.read('eligibility', request);
    expect(accepted.fresh()).toBe(true);
    mono = 5001;
    now++;
    expect(accepted.fresh()).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each(['wrong-url', 'extra', 'oversize', 'denied', 'expired'])(
    'rejects %s without treating error as owner DENY',
    async (kind) => {
      const response = kind === 'extra' ? { ...sample.response, extra: 1 } : sample.response;
      const fetch = vi.fn(() => {
        const r = new Response(kind === 'oversize' ? 'x'.repeat(65537) : JSON.stringify(response), {
          status: kind === 'denied' ? 403 : 200,
        });
        Object.defineProperty(r, 'url', {
          value:
            kind === 'wrong-url'
              ? 'https://other.example.test'
              : 'https://owner.example.test/lk/internal/station-notifications/v1/eligibility',
        });
        return Promise.resolve(r);
      });
      const c = new StationNotificationClient({
        origin: 'https://owner.example.test',
        sign: () => 'synthetic',
        fetch,
        now: () =>
          kind === 'expired' ? sample.response.validUntilMs : sample.response.checkedAtMs,
      });
      await expect(c.read('eligibility', request)).rejects.toThrow('STATION_OWNER_UNAVAILABLE');
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );
  it('bounded failure circuit and telemetry exceptions do not manufacture permission', async () => {
    let now = 0;
    const fetch = vi.fn().mockRejectedValue(Error('network'));
    const c = new StationNotificationClient({
      origin: 'https://owner.example.test',
      sign: () => 'synthetic',
      fetch,
      now: () => now,
      observe: () => {
        throw Error('telemetry');
      },
    });
    for (let i = 0; i < 4; i++) await expect(c.read('eligibility', request)).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(3);
    now = 30001;
    await expect(c.read('eligibility', request)).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(4);
  });
});
