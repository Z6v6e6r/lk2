import { describe, expect, it, vi } from 'vitest';

import { VivaHomeSourceAdapter } from './home-source.js';

const access = { accessToken: 'server-only-token', correlationId: 'correlation-test-123' };

function fetchUrl(value: Parameters<typeof fetch>[0] | undefined): URL {
  if (typeof value === 'string') return new URL(value);
  if (value instanceof URL) return value;
  if (value instanceof Request) return new URL(value.url);
  throw new Error('Expected a fetch URL');
}

function profile() {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    firstName: 'Алексей',
    middleName: null,
    lastName: 'Петров',
    phone: null,
    photo: 'https://562807.selcdn.ru/smstretching/profile-source.jpg',
    deposit: -12_500,
    customFields: [
      {
        id: 'eabfe27b-3f72-4496-9185-1a2ec6e6465e',
        value: ['3,7'],
      },
    ],
  };
}

describe('Viva Home source adapter', () => {
  it('normalizes real profile, enriched bookings and subscriptions without inventing data', async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(profile()))
      .mockResolvedValueOnce(
        Response.json({
          content: [{ id: '22222222-2222-4222-8222-222222222222', isCancelled: false }],
        }),
      )
      .mockResolvedValueOnce(
        Response.json([
          {
            id: '22222222-2222-4222-8222-222222222222',
            isCancelled: false,
            transactionStatus: { transactionStatus: 'UNPAID' },
            exercise: {
              timeFrom: '2026-07-16T09:00:00+03:00',
              inWaitlist: false,
              direction: { name: 'Падел' },
              type: { name: 'Групповая тренировка' },
              studio: { name: 'Селигерская', address: 'Коровинское шоссе, 10' },
              room: { id: '33333333-3333-4333-8333-333333333333', name: 'Корт 1' },
            },
          },
        ]),
      )
      .mockResolvedValueOnce(
        Response.json({
          content: [
            {
              subscriptionId: '44444444-4444-4444-8444-444444444444',
              type: 'GROUP',
              status: 'HOLD',
              variant: 'BY_VISITS',
              visitsLeft: 4,
              availableMinutes: 0,
              availableDays: 0,
              expirationDate: '2026-09-01',
            },
          ],
        }),
      );
    const adapter = new VivaHomeSourceAdapter({
      mode: 'sandbox',
      apiBaseUrl: 'https://api.vivacrm.invalid/end-user/api',
      tenantKey: 'tenant-key',
      timeoutMs: 100,
      fetchImplementation,
      now: () => Date.parse('2026-07-15T12:00:00.000Z'),
    });

    await expect(adapter.read(access)).resolves.toEqual({
      profile: {
        externalId: '11111111-1111-4111-8111-111111111111',
        displayName: 'Алексей Петров',
        firstName: 'Алексей',
        photoUrl: 'https://562807.selcdn.ru/smstretching/profile-source.jpg',
        balanceMinor: -12_500,
        level: { label: 'C+', value: 3.7, assessmentRequired: false },
      },
      upcoming: [
        {
          externalId: '22222222-2222-4222-8222-222222222222',
          title: 'Групповая тренировка',
          startsAt: '2026-07-16T09:00:00+03:00',
          venue: 'Селигерская · Коровинское шоссе, 10',
          status: 'payment_required',
        },
      ],
      subscriptions: [
        {
          externalId: '44444444-4444-4444-8444-444444444444',
          title: 'Групповой абонемент',
          status: 'paused',
          remainingUnits: 4,
          validUntil: '2026-09-01T23:59:59.000Z',
        },
      ],
      fetchedAt: '2026-07-15T12:00:00.000Z',
    });
    expect(fetchImplementation).toHaveBeenCalledTimes(4);
    const detailUrl = fetchUrl(fetchImplementation.mock.calls[2]?.[0]);
    expect(detailUrl.pathname).toBe('/end-user/api/v1/tenant-key/bookings/list');
    expect(detailUrl.searchParams.getAll('bookingIds')).toEqual([
      '22222222-2222-4222-8222-222222222222',
    ]);
    for (const call of fetchImplementation.mock.calls) {
      expect(call[1]?.headers).toMatchObject({
        Authorization: 'Bearer server-only-token',
        'X-Correlation-ID': access.correlationId,
      });
    }
  });

  it('retries a bounded retryable GET and reports the retry metric', async () => {
    const metrics: string[] = [];
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(Response.json(profile()))
      .mockResolvedValueOnce(Response.json({ content: [] }))
      .mockResolvedValueOnce(Response.json({ content: [] }));
    const adapter = new VivaHomeSourceAdapter({
      mode: 'sandbox',
      apiBaseUrl: 'https://api.vivacrm.invalid/end-user/api',
      tenantKey: 'tenant-key',
      timeoutMs: 100,
      fetchImplementation,
      sleep: () => Promise.resolve(),
      onMetric: (metric) => metrics.push(`${metric.operation}:${metric.outcome}`),
    });

    await expect(adapter.read(access)).resolves.toMatchObject({ upcoming: [], subscriptions: [] });
    expect(fetchImplementation).toHaveBeenCalledTimes(4);
    expect(metrics).toContain('profile:retry');
  });
});
