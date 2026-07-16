import type { ClientRoutingPlan } from '@phub/domain';
import { describe, expect, it, vi } from 'vitest';

import { createClientTransportExecutor } from './index.js';

const operations = [
  'profile.read',
  'bookings.read',
  'bookings.details.read',
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
