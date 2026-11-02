import { afterEach, it, expect, vi } from 'vitest';
import { MonthlyPurchaseOwnerClient } from './monthly-purchase.js';
import {
  monthlyQuote,
  monthlyReceipt,
  monthlyConsent,
} from '../../domain/src/subscription-purchase.test-fixture.js';
const envelope = () => ({
  operationId: monthlyQuote().operationId,
  actorDelegation: 'fixture.header.signature',
  correlationId: 'fixture-correlation',
  actorToken: {
    token: 'fixture-actor-token-never-live',
    expiresAt: new Date(Date.now() + 120000).toISOString(),
  },
});
const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
afterEach(() => vi.useRealTimers());
it('fixed private URL and closed request bind original quote; secrets never enter metrics', async () => {
  const fetcher = vi.fn(async () => await Promise.resolve(response(monthlyQuote()))),
    metric = vi.fn(),
    c = new MonthlyPurchaseOwnerClient({
      baseUrl: 'https://padlhub.su/',
      environment: 'production',
      timeoutMs: 10000,
      fetchImplementation: fetcher,
      onMetric: metric,
    });
  expect(await c.quote(envelope())).toEqual(monthlyQuote());
  expect(fetcher).toHaveBeenCalledTimes(1);
  const call = fetcher.mock.calls[0] as unknown as [string, RequestInit];
  expect(call[0]).toBe('https://padlhub.su/lk/integrations/v1/monthly-friendship/quote');
  expect(call[1].redirect).toBe('error');
  expect(call[1].cache).toBe('no-store');
  expect(JSON.stringify(metric.mock.calls)).not.toContain('fixture-actor-token');
  expect(metric).toHaveBeenCalledWith(
    expect.objectContaining({ operation: 'quote', outcome: 'success' }),
  );
});
it('timeout never retries purchase and late completion cannot produce a response', async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn(() => new Promise<Response>(() => undefined));
  const c = new MonthlyPurchaseOwnerClient({
    baseUrl: 'https://padlhub.su/',
    environment: 'production',
    timeoutMs: 100,
    fetchImplementation: fetcher,
  });
  const pending = expect(
    c.purchase(envelope(), monthlyConsent(), monthlyQuote()),
  ).rejects.toThrow();
  await vi.advanceTimersByTimeAsync(101);
  await pending;
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it('foreign response, malformed evidence and oversized body open the bounded circuit', async () => {
  const metric = vi.fn(),
    fetcher = vi.fn(
      async () =>
        await Promise.resolve(
          response({ ...monthlyReceipt(), operationId: monthlyQuote().offerId }),
        ),
    );
  const c = new MonthlyPurchaseOwnerClient({
    baseUrl: 'https://padlhub.su/',
    environment: 'production',
    timeoutMs: 1000,
    fetchImplementation: fetcher,
    onMetric: metric,
  });
  for (let i = 0; i < 4; i++)
    await expect(c.purchase(envelope(), monthlyConsent(), monthlyQuote())).rejects.toThrow();
  expect(fetcher).toHaveBeenCalledTimes(3);
  expect(metric.mock.calls.every(([m]) => (m as { outcome: string }).outcome === 'failure')).toBe(
    true,
  );
  const oversized = new MonthlyPurchaseOwnerClient({
    baseUrl: 'https://padlhub.su/',
    environment: 'production',
    timeoutMs: 1000,
    fetchImplementation: async () => await Promise.resolve(response({ data: 'x'.repeat(33000) })),
  });
  await expect(oversized.quote(envelope())).rejects.toThrow();
});
it('unsafe owner configuration and credential headers fail before fetch', async () => {
  for (const baseUrl of [
    'http://padlhub.su/',
    'https://other.example/',
    'https://padlhub.su/path',
    'https://padlhub.su/?x=1',
  ])
    expect(
      () => new MonthlyPurchaseOwnerClient({ baseUrl, environment: 'production', timeoutMs: 1000 }),
    ).toThrow();
  const fetcher = vi.fn(),
    c = new MonthlyPurchaseOwnerClient({
      baseUrl: 'https://padlhub.su/',
      environment: 'production',
      timeoutMs: 1000,
      fetchImplementation: fetcher,
    });
  for (const patch of [
    { correlationId: 'x\n' },
    { actorDelegation: 'fixture.header.signature\n' },
    {
      actorToken: {
        token: 'fixture-actor-token\u2028',
        expiresAt: new Date(Date.now() + 60000).toISOString(),
      },
    },
  ])
    await expect(c.quote({ ...envelope(), ...patch })).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled();
});
