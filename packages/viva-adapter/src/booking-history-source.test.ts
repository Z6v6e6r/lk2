import { describe, expect, it, vi } from 'vitest';

import {
  VIVA_BOOKING_HISTORY_EMPTY_PAGE_FIXTURE,
  VIVA_BOOKING_HISTORY_MIXED_PAGE_FIXTURE,
  VIVA_BOOKING_HISTORY_NAME_FALLBACK_PAGE_FIXTURE,
} from './booking-history-source.fixtures.js';
import {
  VivaBookingHistorySourceAdapter,
  VivaBookingHistorySourceError,
  type VivaBookingHistorySourceMetric,
} from './booking-history-source.js';

const access = { accessToken: 'server-only-token', correlationId: 'correlation-history-123' };

function adapter(fetchImplementation: typeof fetch) {
  return new VivaBookingHistorySourceAdapter({
    mode: 'sandbox',
    apiBaseUrl: 'https://api.vivacrm.invalid/end-user/api',
    tenantKey: 'tenant-key',
    timeoutMs: 100,
    fetchImplementation,
  });
}

function fetchUrl(value: Parameters<typeof fetch>[0] | undefined): URL {
  if (typeof value === 'string') return new URL(value);
  if (value instanceof URL) return value;
  if (value instanceof Request) return new URL(value.url);
  throw new Error('Expected a fetch URL');
}

describe('Viva booking history source adapter', () => {
  it('reads the legacy-compatible endpoint and normalizes all supported kinds', async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json(VIVA_BOOKING_HISTORY_MIXED_PAGE_FIXTURE));

    await expect(adapter(fetchImplementation).readPage({ ...access, size: 4 })).resolves.toEqual({
      records: [
        expect.objectContaining({
          sourceRef: {
            bookingRef: '11111111-1111-4111-8111-111111111111',
            exerciseRef: '21111111-1111-4111-8111-111111111111',
          },
          kind: 'GAME',
          status: 'COMPLETED',
          title: 'Своя игра',
          startsAt: '2026-07-10T09:00:00+03:00',
          endsAt: '2026-07-10T10:00:00+03:00',
          venue: {
            name: 'ПаделхАБ Терехово',
            address: 'Терехово, 1',
            room: 'Корт 4',
          },
          routeHint: 'GAME_DETAILS',
        }),
        expect.objectContaining({ kind: 'TRAINING', routeHint: 'NONE' }),
        expect.objectContaining({ kind: 'TOURNAMENT', routeHint: 'TOURNAMENT_DETAILS' }),
        expect.objectContaining({ kind: 'GAME', status: 'CANCELLED' }),
      ],
      page: 0,
      size: 4,
      totalElements: 5,
      isLastPage: false,
      nextPage: 1,
    });

    const url = fetchUrl(fetchImplementation.mock.calls[0]?.[0]);
    expect(url.pathname).toBe('/end-user/api/v2/tenant-key/bookings/history');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      includeCanceled: 'true',
      page: '0',
      size: '4',
    });
    expect(fetchImplementation.mock.calls[0]?.[1]?.headers).toEqual({
      Authorization: `Bearer ${access.accessToken}`,
      'X-Correlation-ID': access.correlationId,
    });
  });

  it('uses tested name fallbacks only after explicit provider IDs', async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json(VIVA_BOOKING_HISTORY_NAME_FALLBACK_PAGE_FIXTURE));

    const result = await adapter(fetchImplementation).readPage(access);

    expect(result.records.map((record) => record.kind)).toEqual(['TOURNAMENT', 'TRAINING', 'GAME']);
  });

  it('uses the confirmed tournament direction as the Time for Friends title', async () => {
    const providerPage = {
      ...VIVA_BOOKING_HISTORY_EMPTY_PAGE_FIXTURE,
      content: [
        {
          id: '19999999-9999-4999-8999-999999999999',
          isCancelled: false,
          exercise: {
            id: '29999999-9999-4999-8999-999999999999',
            direction: { id: 5278, name: 'Время на друзей' },
            type: { id: 839, name: 'Падел Турнир' },
            timeFrom: '2026-08-04T08:30:00+03:00',
            timeTo: '2026-08-04T10:00:00+03:00',
            studio: { name: 'Терехово', address: 'Москва' },
            room: { name: 'Корт №1' },
          },
        },
      ],
      totalElements: 1,
      numberOfElements: 1,
      empty: false,
    };
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json(providerPage));

    const result = await adapter(fetchImplementation).readPage(access);

    expect(result.records).toEqual([
      expect.objectContaining({
        kind: 'TOURNAMENT',
        title: 'Время на друзей',
      }),
    ]);
  });

  it('returns a completed empty page without inventing activity', async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json(VIVA_BOOKING_HISTORY_EMPTY_PAGE_FIXTURE));

    await expect(adapter(fetchImplementation).readPage(access)).resolves.toEqual({
      records: [],
      page: 0,
      size: 20,
      totalElements: 0,
      isLastPage: true,
      nextPage: null,
    });
  });

  it('ignores non-exercise history rows that are outside the supported activity contract', async () => {
    const page = {
      ...VIVA_BOOKING_HISTORY_EMPTY_PAGE_FIXTURE,
      content: [{ id: '18888888-8888-4888-8888-888888888888', isCancelled: false }],
      totalElements: 1,
      numberOfElements: 1,
      empty: false,
    };
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(Response.json(page));

    await expect(adapter(fetchImplementation).readPage(access)).resolves.toMatchObject({
      records: [],
      totalElements: 1,
      isLastPage: true,
    });
  });

  it('bounds the requested page size and reports pagination completion', async () => {
    const finalPage = {
      ...VIVA_BOOKING_HISTORY_EMPTY_PAGE_FIXTURE,
      totalPages: 2,
      totalElements: 5,
      number: 1,
      size: 100,
    };
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(Response.json(finalPage));

    const result = await adapter(fetchImplementation).readPage({ ...access, page: 1, size: 1000 });

    expect(result).toMatchObject({ page: 1, size: 100, isLastPage: true, nextPage: null });
    expect(fetchUrl(fetchImplementation.mock.calls[0]?.[0]).searchParams.get('size')).toBe('100');
  });

  it('uses safe defaults for non-finite runtime pagination values', async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json(VIVA_BOOKING_HISTORY_EMPTY_PAGE_FIXTURE));

    await adapter(fetchImplementation).readPage({ ...access, page: Number.NaN, size: Infinity });

    const url = fetchUrl(fetchImplementation.mock.calls[0]?.[0]);
    expect(url.searchParams.get('page')).toBe('0');
    expect(url.searchParams.get('size')).toBe('20');
  });

  it('rejects an invalid payload with redacted structured issues', async () => {
    const invalid = {
      ...VIVA_BOOKING_HISTORY_MIXED_PAGE_FIXTURE,
      content: [
        {
          ...VIVA_BOOKING_HISTORY_MIXED_PAGE_FIXTURE.content[0],
          exercise: {
            ...VIVA_BOOKING_HISTORY_MIXED_PAGE_FIXTURE.content[0].exercise,
            timeFrom: 'not-a-date',
          },
        },
      ],
    };
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(Response.json(invalid));

    const promise = adapter(fetchImplementation).readPage(access);

    await expect(promise).rejects.toMatchObject({
      code: 'EXTERNAL_SOURCE_RESPONSE_INVALID',
      retryable: false,
      issues: [{ path: 'content.0.exercise.timeFrom', code: 'invalid_format' }],
    });
    await expect(promise).rejects.not.toHaveProperty('accessToken');
  });

  it('retries only a bounded transient failure and emits redacted metrics', async () => {
    const metrics: VivaBookingHistorySourceMetric[] = [];
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(Response.json(VIVA_BOOKING_HISTORY_EMPTY_PAGE_FIXTURE));
    const source = new VivaBookingHistorySourceAdapter({
      mode: 'sandbox',
      apiBaseUrl: 'https://api.vivacrm.invalid/end-user/api',
      tenantKey: 'tenant-key',
      timeoutMs: 100,
      maxAttempts: 2,
      fetchImplementation,
      sleep: () => Promise.resolve(),
      onMetric: (metric) => metrics.push(metric),
    });

    await expect(source.readPage(access)).resolves.toMatchObject({ records: [] });
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
    expect(
      metrics.map(({ operation, outcome, attempt, status }) => ({
        operation,
        outcome,
        attempt,
        status,
      })),
    ).toEqual([
      { operation: 'booking_history', outcome: 'retry', attempt: 1, status: 503 },
      { operation: 'booking_history', outcome: 'success', attempt: 2, status: 200 },
    ]);
    expect(JSON.stringify(metrics)).not.toContain(access.accessToken);
  });

  it('aborts a timed-out request and returns the stable timeout error', async () => {
    const fetchImplementation = vi.fn<typeof fetch>((_url, init) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'));
        });
      });
    });
    const source = new VivaBookingHistorySourceAdapter({
      mode: 'sandbox',
      apiBaseUrl: 'https://api.vivacrm.invalid/end-user/api',
      tenantKey: 'tenant-key',
      timeoutMs: 1,
      maxAttempts: 1,
      fetchImplementation,
    });

    await expect(source.readPage(access)).rejects.toMatchObject({
      code: 'EXTERNAL_SOURCE_TIMEOUT',
      retryable: true,
    });
    expect(fetchImplementation).toHaveBeenCalledOnce();
  });

  it('does not call Viva in mock mode', async () => {
    const fetchImplementation = vi.fn<typeof fetch>();
    const source = new VivaBookingHistorySourceAdapter({
      mode: 'mock',
      apiBaseUrl: 'https://api.vivacrm.invalid/end-user/api',
      tenantKey: 'tenant-key',
      timeoutMs: 100,
      fetchImplementation,
    });

    await expect(source.readPage(access)).resolves.toMatchObject({ records: [], isLastPage: true });
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it('exposes a stable error type without response body or credential fields', () => {
    const error = new VivaBookingHistorySourceError('EXTERNAL_SOURCE_UNAVAILABLE', true, 503);

    expect(error).toMatchObject({
      name: 'VivaBookingHistorySourceError',
      message: 'EXTERNAL_SOURCE_UNAVAILABLE',
      status: 503,
    });
    expect(JSON.stringify(error)).not.toContain('token');
  });
});
