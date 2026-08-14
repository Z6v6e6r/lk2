import type { ClientRoutingPlan } from '@phub/domain';
import { describe, expect, it, vi } from 'vitest';

import { createClientTransportExecutor } from './index.js';

const operations = [
  'profile.read',
  'bookings.read',
  'bookings.details.read',
  'bookings.history.read',
  'subscriptions.read',
  'schedule.read',
] as const;

function plan(
  mode: ClientRoutingPlan['mode'],
  expiresAt = new Date(Date.now() + 60_000).toISOString(),
): ClientRoutingPlan {
  const direct = mode === 'MIXED_END_USER_READS';
  return {
    revision: '7',
    mode,
    issuedAt: new Date().toISOString(),
    expiresAt,
    operations: operations.map((operation) => ({
      operation,
      transport: direct ? 'DIRECT_VIVA' : 'PADLHUB_API',
      fallback: direct ? 'UNAVAILABLE' : 'PADLHUB_API',
    })),
    ...(direct
      ? {
          directViva: {
            apiBaseUrl: 'https://api.vivacrm.invalid/end-user/api',
            providerTenantKey: 'tenant key',
            accessTokenPath: '/auth/viva/access',
            allowedRequestHeaders: ['Authorization'],
          },
        }
      : {}),
  };
}

const identity = (payload: unknown) => payload;

describe('client transport executor', () => {
  it('executes only a fixed server-directed schedule read for immediate relay', async () => {
    const vivaFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ content: [{ id: 'provider-id' }] }));
    const executor = createClientTransportExecutor({
      getRoutingPlan: vi.fn().mockResolvedValue(plan('MIXED_END_USER_READS')),
      getVivaAccessToken: () => 'user-access-token',
      refreshVivaAccessToken: vi.fn(),
      executePadlHub: vi.fn(),
      fetchImplementation: vivaFetch,
    });

    await expect(
      executor.executeClientAssistedScheduleRead({
        operation: 'schedule.read',
        date: '2026-07-30',
      }),
    ).resolves.toEqual({ content: [{ id: 'provider-id' }] });
    const [url, init] = vivaFetch.mock.calls[0] ?? [];
    expect((url as URL).toString()).toBe(
      'https://api.vivacrm.invalid/end-user/api/v1/tenant%20key/exercises?date=2026-07-30',
    );
    expect(Object.fromEntries(new Headers(init?.headers))).toEqual({
      authorization: 'Bearer user-access-token',
    });
  });

  it('accepts a bounded schedule response larger than the generic one-megabyte read limit', async () => {
    const payload = { content: [{ id: 'provider-id', presentation: 'x'.repeat(1_200_000) }] };
    const executor = createClientTransportExecutor({
      getRoutingPlan: vi.fn().mockResolvedValue(plan('MIXED_END_USER_READS')),
      getVivaAccessToken: () => 'user-access-token',
      refreshVivaAccessToken: vi.fn(),
      executePadlHub: vi.fn(),
      fetchImplementation: vi.fn().mockResolvedValue(Response.json(payload)),
    });

    await expect(
      executor.executeClientAssistedScheduleRead({
        operation: 'schedule.read',
        date: '2026-07-30',
      }),
    ).resolves.toEqual(payload);
  });

  it('derives booking detail identifiers only from the active list response', async () => {
    const vivaFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          content: [
            { id: 'active-booking-secret', isCancelled: false },
            { id: 'cancelled-booking-secret', isCancelled: true },
          ],
        }),
      )
      .mockResolvedValueOnce(Response.json([{ id: 'active-booking-secret', isCancelled: false }]));
    const executor = createClientTransportExecutor({
      getRoutingPlan: vi.fn().mockResolvedValue(plan('MIXED_END_USER_READS')),
      getVivaAccessToken: () => 'user-access-token',
      refreshVivaAccessToken: vi.fn(),
      executePadlHub: vi.fn(),
      fetchImplementation: vivaFetch,
    });

    await expect(
      executor.executeClientAssistedUpcomingBookingsRead({
        operation: 'bookings.read',
        detailsOperation: 'bookings.details.read',
        page: 0,
        size: 50,
      }),
    ).resolves.toEqual({
      bookings: {
        content: [
          { id: 'active-booking-secret', isCancelled: false },
          { id: 'cancelled-booking-secret', isCancelled: true },
        ],
      },
      details: [{ id: 'active-booking-secret', isCancelled: false }],
    });
    expect(vivaFetch).toHaveBeenCalledTimes(2);
    expect((vivaFetch.mock.calls[0]?.[0] as URL).toString()).toBe(
      'https://api.vivacrm.invalid/end-user/api/v2/tenant%20key/bookings?page=0&size=50',
    );
    const detailsUrl = vivaFetch.mock.calls[1]?.[0] as URL;
    expect(detailsUrl.pathname).toBe('/end-user/api/v1/tenant%20key/bookings/list');
    expect(detailsUrl.searchParams.getAll('bookingIds')).toEqual(['active-booking-secret']);
    expect(detailsUrl.toString()).not.toContain('cancelled-booking-secret');
  });

  it('executes one fixed client-assisted history page without server fallback', async () => {
    const payload = { content: [], totalPages: 0, totalElements: 0, last: true };
    const vivaFetch = vi.fn<typeof fetch>().mockResolvedValue(Response.json(payload));
    const executor = createClientTransportExecutor({
      getRoutingPlan: vi.fn().mockResolvedValue(plan('MIXED_END_USER_READS')),
      getVivaAccessToken: () => 'user-access-token',
      refreshVivaAccessToken: vi.fn(),
      executePadlHub: vi.fn(),
      fetchImplementation: vivaFetch,
    });

    await expect(
      executor.executeClientAssistedActivityHistoryRead({
        operation: 'bookings.history.read',
        page: 3,
        size: 50,
      }),
    ).resolves.toEqual(payload);
    expect((vivaFetch.mock.calls[0]?.[0] as URL).toString()).toBe(
      'https://api.vivacrm.invalid/end-user/api/v2/tenant%20key/bookings/history?includeCanceled=true&page=3&size=50',
    );
  });

  it('fails a client-assisted read closed when direct transport is absent', async () => {
    const vivaFetch = vi.fn<typeof fetch>();
    const executor = createClientTransportExecutor({
      getRoutingPlan: vi.fn().mockResolvedValue(plan('PADLHUB_ONLY')),
      getVivaAccessToken: () => 'user-access-token',
      refreshVivaAccessToken: vi.fn(),
      executePadlHub: vi.fn(),
      fetchImplementation: vivaFetch,
    });

    await expect(
      executor.executeClientAssistedScheduleRead({
        operation: 'schedule.read',
        date: '2026-07-30',
      }),
    ).rejects.toMatchObject({
      code: 'DIRECT_VIVA_UNAVAILABLE',
      operation: 'schedule.read',
    });
    expect(vivaFetch).not.toHaveBeenCalled();
  });

  it('fails closed to PadlHub when the plan is missing or invalid', async () => {
    const executePadlHub = vi.fn().mockResolvedValue({ source: 'padlhub' });
    const vivaFetch = vi.fn<typeof fetch>();
    const executor = createClientTransportExecutor({
      getRoutingPlan: vi.fn().mockRejectedValue(new Error('offline')),
      getVivaAccessToken: () => undefined,
      refreshVivaAccessToken: vi.fn(),
      executePadlHub,
      fetchImplementation: vivaFetch,
    });

    await expect(
      executor.executeRead({
        request: { operation: 'profile.read' },
        normalizePadlHub: identity,
        normalizeViva: identity,
      }),
    ).resolves.toEqual({ source: 'padlhub' });
    expect(executePadlHub).toHaveBeenCalledWith({ operation: 'profile.read' });
    expect(vivaFetch).not.toHaveBeenCalled();
  });

  it('uses only Authorization for an explicitly allowlisted contract-ready direct read', async () => {
    const vivaFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ source: 'viva', id: 'external-only' }));
    const executePadlHub = vi.fn();
    const executor = createClientTransportExecutor({
      getRoutingPlan: vi.fn().mockResolvedValue(plan('MIXED_END_USER_READS')),
      getVivaAccessToken: () => 'user-access-token',
      refreshVivaAccessToken: vi.fn(),
      executePadlHub,
      fetchImplementation: vivaFetch,
    });

    await expect(
      executor.executeRead({
        request: { operation: 'profile.read' },
        normalizePadlHub: identity,
        normalizeViva: identity,
      }),
    ).resolves.toEqual({ source: 'viva', id: 'external-only' });
    expect(executePadlHub).not.toHaveBeenCalled();
    const [url, init] = vivaFetch.mock.calls[0] ?? [];
    expect(url).toBeInstanceOf(URL);
    expect((url as URL).toString()).toBe(
      'https://api.vivacrm.invalid/end-user/api/v1/tenant%20key/profile',
    );
    expect(Object.fromEntries(new Headers(init?.headers))).toEqual({
      authorization: 'Bearer user-access-token',
    });
    expect(init?.credentials).toBe('omit');
  });

  it('rejects an oversized direct profile response before normalization', async () => {
    const executor = createClientTransportExecutor({
      getRoutingPlan: vi.fn().mockResolvedValue(plan('MIXED_END_USER_READS')),
      getVivaAccessToken: () => 'user-access-token',
      refreshVivaAccessToken: vi.fn(),
      executePadlHub: vi.fn(),
      fetchImplementation: vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(JSON.stringify({ value: 'x'.repeat(70 * 1024) }))),
    });

    await expect(
      executor.executeRead({
        request: { operation: 'profile.read' },
        normalizePadlHub: identity,
        normalizeViva: identity,
      }),
    ).rejects.toMatchObject({
      code: 'DIRECT_VIVA_RESPONSE_INVALID',
      operation: 'profile.read',
    });
  });

  it('counts semantic profile validation failures before opening the circuit', async () => {
    const invalidMetrics: Array<{ outcome: string }> = [];
    const invalidFetch = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ changed: true }));
    const invalidExecutor = createClientTransportExecutor({
      getRoutingPlan: vi.fn().mockResolvedValue(plan('MIXED_END_USER_READS')),
      getVivaAccessToken: () => 'user-access-token',
      refreshVivaAccessToken: vi.fn(),
      executePadlHub: vi.fn(),
      fetchImplementation: invalidFetch,
      onMetric: (metric) => invalidMetrics.push(metric),
    });
    const invalidExecution = {
      request: { operation: 'profile.read' as const },
      normalizePadlHub: identity,
      normalizeViva: () => {
        throw new Error('profile schema changed');
      },
    };

    await expect(invalidExecutor.executeRead(invalidExecution)).rejects.toMatchObject({
      code: 'DIRECT_VIVA_RESPONSE_INVALID',
      operation: 'profile.read',
    });
    await expect(invalidExecutor.executeRead(invalidExecution)).rejects.toMatchObject({
      code: 'DIRECT_VIVA_UNAVAILABLE',
      operation: 'profile.read',
    });
    expect(invalidFetch).toHaveBeenCalledTimes(1);
    expect(invalidMetrics.map((metric) => metric.outcome)).toEqual(['INVALID', 'CIRCUIT_OPEN']);

    const validMetrics: Array<{ outcome: string }> = [];
    const validExecutor = createClientTransportExecutor({
      getRoutingPlan: vi.fn().mockResolvedValue(plan('MIXED_END_USER_READS')),
      getVivaAccessToken: () => 'user-access-token',
      refreshVivaAccessToken: vi.fn(),
      executePadlHub: vi.fn(),
      fetchImplementation: vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ok: true })),
      onMetric: (metric) => validMetrics.push(metric),
    });
    await expect(
      validExecutor.executeRead({
        request: { operation: 'profile.read' },
        normalizePadlHub: identity,
        normalizeViva: (payload) => payload,
      }),
    ).resolves.toEqual({ ok: true });
    expect(validMetrics.map((metric) => metric.outcome)).toEqual(['SUCCESS']);
  });

  it('keeps provider-id reads behind PadlHub even if a plan is misconfigured', async () => {
    const executePadlHub = vi.fn().mockResolvedValue({ source: 'padlhub' });
    const vivaFetch = vi.fn<typeof fetch>();
    const executor = createClientTransportExecutor({
      getRoutingPlan: vi.fn().mockResolvedValue(plan('MIXED_END_USER_READS')),
      getVivaAccessToken: () => 'user-access-token',
      refreshVivaAccessToken: vi.fn(),
      executePadlHub,
      fetchImplementation: vivaFetch,
    });

    await expect(
      executor.executeRead({
        request: { operation: 'bookings.read', page: 0, size: 6 },
        normalizePadlHub: identity,
        normalizeViva: identity,
      }),
    ).resolves.toEqual({ source: 'padlhub' });
    expect(executePadlHub).toHaveBeenCalledWith({
      operation: 'bookings.read',
      page: 0,
      size: 6,
    });
    expect(vivaFetch).not.toHaveBeenCalled();
  });

  it('refreshes a rejected user token once without server-side Viva fallback', async () => {
    let token = 'expired-token';
    const refreshVivaAccessToken = vi.fn(() => {
      token = 'fresh-token';
      return Promise.resolve(token);
    });
    const vivaFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(Response.json({ ok: true }));
    const executePadlHub = vi.fn();
    const executor = createClientTransportExecutor({
      getRoutingPlan: vi.fn().mockResolvedValue(plan('MIXED_END_USER_READS')),
      getVivaAccessToken: () => token,
      refreshVivaAccessToken,
      executePadlHub,
      fetchImplementation: vivaFetch,
    });

    await expect(
      executor.executeRead({
        request: { operation: 'profile.read' },
        normalizePadlHub: identity,
        normalizeViva: identity,
      }),
    ).resolves.toEqual({ ok: true });
    expect(refreshVivaAccessToken).toHaveBeenCalledTimes(1);
    expect(vivaFetch).toHaveBeenCalledTimes(2);
    expect(executePadlHub).not.toHaveBeenCalled();
  });

  it('does not amplify Viva rate limiting through a hidden PadlHub fallback', async () => {
    const executePadlHub = vi.fn();
    const executor = createClientTransportExecutor({
      getRoutingPlan: vi.fn().mockResolvedValue(plan('MIXED_END_USER_READS')),
      getVivaAccessToken: () => 'user-access-token',
      refreshVivaAccessToken: vi.fn(),
      executePadlHub,
      fetchImplementation: vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(null, { status: 429 })),
    });

    await expect(
      executor.executeRead({
        request: { operation: 'profile.read' },
        normalizePadlHub: identity,
        normalizeViva: identity,
      }),
    ).rejects.toMatchObject({
      code: 'DIRECT_VIVA_UNAVAILABLE',
      operation: 'profile.read',
      status: 429,
    });
    expect(executePadlHub).not.toHaveBeenCalled();
  });

  it('rejects commands and unknown operations before any transport call', async () => {
    const executePadlHub = vi.fn();
    const vivaFetch = vi.fn<typeof fetch>();
    const executor = createClientTransportExecutor({
      getRoutingPlan: vi.fn().mockResolvedValue(plan('MIXED_END_USER_READS')),
      getVivaAccessToken: () => 'user-access-token',
      refreshVivaAccessToken: vi.fn(),
      executePadlHub,
      fetchImplementation: vivaFetch,
    });

    await expect(
      executor.executeRead({
        request: { operation: 'booking.cancel' } as never,
        normalizePadlHub: identity,
        normalizeViva: identity,
      }),
    ).rejects.toThrow();
    expect(executePadlHub).not.toHaveBeenCalled();
    expect(vivaFetch).not.toHaveBeenCalled();
  });

  it('refreshes an expired plan before choosing transport', async () => {
    const getRoutingPlan = vi
      .fn()
      .mockResolvedValueOnce(plan('MIXED_END_USER_READS', '2020-01-01T00:00:00.000Z'))
      .mockResolvedValueOnce(plan('PADLHUB_ONLY'));
    const executePadlHub = vi.fn().mockResolvedValue({ source: 'padlhub' });
    const executor = createClientTransportExecutor({
      getRoutingPlan,
      getVivaAccessToken: () => 'user-access-token',
      refreshVivaAccessToken: vi.fn(),
      executePadlHub,
      fetchImplementation: vi.fn<typeof fetch>(),
    });

    await expect(
      executor.executeRead({
        request: { operation: 'schedule.read', date: '2026-07-15' },
        normalizePadlHub: identity,
        normalizeViva: identity,
      }),
    ).resolves.toEqual({ source: 'padlhub' });
    expect(getRoutingPlan).toHaveBeenNthCalledWith(1, false);
    expect(getRoutingPlan).toHaveBeenNthCalledWith(2, true);
  });
});
