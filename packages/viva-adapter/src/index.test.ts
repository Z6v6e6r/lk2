import { describe, expect, it, vi } from 'vitest';

import { VivaAdapter, type VivaAdapterMetric } from './index.js';

const input = {
  tenantId: '86afbe01-0318-4dd2-bc25-303b7bf0d430',
  stationId: '4d3ef8d2-568c-4769-9274-92734206fbbc',
  date: '2026-07-11',
  correlationId: 'test-correlation-123',
} as const;

const internalIds = {
  'availability_slot:42': '64d02ef6-6b53-4056-a318-89cd9355849a',
  'station:10': '4d3ef8d2-568c-4769-9274-92734206fbbc',
  'space:11': 'c3db698e-d7b3-4aae-813c-a2fcbacb113b',
} as const;

function resolveInternalId(inputValue: {
  readonly entityType: 'availability_slot' | 'station' | 'space';
  readonly externalId: string;
}): Promise<string> {
  const key = `${inputValue.entityType}:${inputValue.externalId}` as keyof typeof internalIds;
  return Promise.resolve(internalIds[key]);
}

describe('VivaAdapter resilience boundary', () => {
  it('retries a bounded transient failure and normalizes the response', async () => {
    const metrics: VivaAdapterMetric[] = [];
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(
        Response.json([
          {
            id: 42,
            station_id: 10,
            space_id: 11,
            starts_at: '2026-07-11T10:00:00Z',
            ends_at: '2026-07-11T11:00:00Z',
            price_minor: 500000,
            currency: 'RUB',
          },
        ]),
      );
    const adapter = new VivaAdapter({
      mode: 'sandbox',
      apiUrl: 'https://sandbox.viva.invalid',
      timeoutMs: 100,
      maxAttempts: 2,
      fetchImplementation,
      resolveInternalId,
      sleep: () => Promise.resolve(),
      onMetric: (metric) => metrics.push(metric),
    });

    await expect(adapter.readAvailability(input)).resolves.toMatchObject([
      {
        id: internalIds['availability_slot:42'],
        stationId: internalIds['station:10'],
        spaceId: internalIds['space:11'],
        price: { amount: 500000 },
      },
    ]);
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
    expect(metrics).toContainEqual({ name: 'retry', outcome: 'failure', attempt: 1, status: 503 });
  });

  it('opens the circuit after the configured failure threshold', async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 503 }));
    const adapter = new VivaAdapter({
      mode: 'sandbox',
      apiUrl: 'https://sandbox.viva.invalid',
      timeoutMs: 100,
      maxAttempts: 1,
      circuitFailureThreshold: 1,
      circuitResetMs: 30_000,
      fetchImplementation,
      resolveInternalId,
    });

    await expect(adapter.readAvailability(input)).rejects.toThrow('EXTERNAL_SOURCE_REQUEST_FAILED');
    await expect(adapter.readAvailability(input)).rejects.toThrow('EXTERNAL_SOURCE_UNAVAILABLE');
    expect(fetchImplementation).toHaveBeenCalledOnce();
  });

  it('never calls a remote source in mock mode', async () => {
    const fetchImplementation = vi.fn<typeof fetch>();
    const adapter = new VivaAdapter({ mode: 'mock', timeoutMs: 100, fetchImplementation });

    await expect(adapter.readAvailability(input)).resolves.toEqual([]);
    expect(fetchImplementation).not.toHaveBeenCalled();
  });
});
