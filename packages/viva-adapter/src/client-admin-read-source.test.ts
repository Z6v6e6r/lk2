import { describe, expect, it, vi } from 'vitest';

import {
  VivaClientAdminReadError,
  VivaClientAdminReadSource,
  type VivaClientAdminReadSourceOptions,
} from './client-admin-read-source.js';

const CLIENT = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const NOW = Date.parse('2026-11-09T08:00:00.000Z');

function json(body: unknown, status = 200): Promise<Response> {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  );
}

function page(content: unknown[], extra: Record<string, unknown> = {}) {
  return { content, number: 0, totalElements: content.length, totalPages: 1, last: true, ...extra };
}

function source(
  fetchImplementation: typeof fetch,
  overrides: Partial<VivaClientAdminReadSourceOptions> = {},
) {
  return new VivaClientAdminReadSource({
    mode: 'production',
    apiBaseUrl: 'https://viva.example.test',
    apiKey: 'synthetic-admin-key',
    timeoutMs: 1_000,
    sleep: () => Promise.resolve(),
    now: () => NOW,
    fetchImplementation,
    ...overrides,
  });
}

const input = { providerClientId: CLIENT, correlationId: 'corr-1' };

describe('VivaClientAdminReadSource', () => {
  it('projects the client card without contact PII or provider identifiers', async () => {
    const fetchMock = vi.fn(() =>
      json({
        id: CLIENT,
        email: 'synthetic@example.test',
        firstName: 'Synthetic',
        lastName: 'Player',
        phone: '79990000000',
        registrationDate: '2025-08-20T21:53:58.47834',
        lastLogin: '2026-11-08T14:54:47.33981',
        lastVisit: '2026-11-03T06:00:00',
        deposit: 2100,
        source: 'widget',
        loyaltyCard: '0000-0000',
        clientCategory: { id: 3, name: 'Резидент', color: '#fff' },
        trialUsed: true,
        managerId: null,
        deleted: false,
        blacklisted: false,
        offerAccepted: true,
        offerAcceptedAt: '2025-08-20T21:53:58.47834',
        personalDataAccepted: true,
        personalDataAcceptedAt: '2025-08-20T21:53:58.47834',
        privacyPolicyAccepted: false,
        privacyPolicyAcceptedAt: null,
        marketingConsent: false,
        marketingConsentAt: null,
        hasFamily: false,
        customFields: [],
      }),
    ) as unknown as typeof fetch;

    const profile = await source(fetchMock).readProfile(input);

    expect(profile).toMatchObject({
      depositKopecks: 2100,
      categoryName: 'Резидент',
      hasLoyaltyCard: true,
      trialUsed: true,
      consents: { offer: { accepted: true }, privacyPolicy: { accepted: false, acceptedAt: null } },
      checkedAt: '2026-11-09T08:00:00.000Z',
    });
    const serialized = JSON.stringify(profile);
    expect(serialized).not.toContain(CLIENT);
    expect(serialized).not.toContain('synthetic@example.test');
    expect(serialized).not.toContain('79990000000');
    expect(serialized).not.toContain('0000-0000');

    const [url, init] = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      URL,
      RequestInit,
    ];
    expect(String(url)).toBe(`https://viva.example.test/api/v1/clients/${CLIENT}`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'error' });
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer synthetic-admin-key',
      'X-Correlation-ID': 'corr-1',
    });
  });

  it('fails closed when the card belongs to another client', async () => {
    const fetchMock = vi.fn(() => json({ id: OTHER })) as unknown as typeof fetch;
    await expect(source(fetchMock).readProfile(input)).rejects.toMatchObject({
      code: 'CLIENT_ADMIN_READ_OWNERSHIP_CONFLICT',
    });
  });

  it('combines card meta, statistics and bonus balance into one summary', async () => {
    const fetchMock = vi.fn((url: URL) => {
      const path = url.pathname;
      if (path.endsWith('/card/meta')) {
        return json({
          todayBookingsCount: 1,
          activeSubscriptionsCount: 2,
          waitingTransactionsCount: 3,
        });
      }
      if (path.endsWith('/card/statistics-snapshot')) {
        return json({
          totalBookings: 40,
          cancelled: 5,
          noShow: 1,
          attendancePct: 87,
          salesRub: 125000,
          refundsRub: 0,
          debtRub: 12.5,
          activeSubUntil: '2026-11-15',
          daysWithoutSub: 0,
          withUs: '1 год',
        });
      }
      return json({ activePoints: 300, pendingPoints: 0, totalEarned: 900 });
    }) as unknown as typeof fetch;

    const summary = await source(fetchMock).readSummary(input);
    expect(summary.counters).toMatchObject({ todayBookings: 1, activeSubscriptions: 2 });
    expect(summary.statistics).toMatchObject({
      totalBookings: 40,
      debtRub: 12.5,
      activeSubscriptionUntil: '2026-11-15',
      tenure: '1 год',
    });
    expect(summary.bonusPoints).toEqual({ active: 300, pending: 0, totalEarned: 900 });
  });

  it('fails the whole summary when one part is unavailable', async () => {
    const fetchMock = vi.fn((url: URL) =>
      url.pathname.endsWith('/bonus-points/balance') ? json({}, 403) : json({}),
    ) as unknown as typeof fetch;
    await expect(source(fetchMock).readSummary(input)).rejects.toMatchObject({
      code: 'CLIENT_ADMIN_READ_UNAVAILABLE',
      status: 403,
    });
  });

  it('maps subscription groups to Viva statuses and projects limitations', async () => {
    const fetchMock = vi.fn(() =>
      json(
        page([
          {
            subscriptionId: '33333333-3333-4333-8333-333333333333',
            product: { id: '44444444-4444-4444-8444-444444444444', name: 'Падел 8 занятий' },
            status: 'expired',
            variant: 'BY_VISITS',
            appliesTo: 'BOOKING',
            paymentMethod: 'NO_PAYMENT',
            cost: 0,
            purchaseDate: '2026-09-29T09:57:27.991813',
            activationDate: '2026-09-29T21:02:18.304246',
            expirationDate: '2026-11-08',
            holdUntil: null,
            visitsTotal: 8,
            visitsLeft: 8,
            totalFreezeDays: 0,
            availableFreezeDays: 0,
            availableStudios: [],
            availableTypes: [{ id: 1271, name: 'Групповые' }],
            availableDirections: [{ id: 4194, name: 'Уровень 1' }],
            bookings: [{ client: { id: CLIENT } }],
          },
        ]),
      ),
    ) as unknown as typeof fetch;

    const result = await source(fetchMock).listSubscriptions({
      ...input,
      group: 'ARCHIVED',
      page: 0,
      size: 25,
    });
    const url = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0] as URL;
    expect(url.searchParams.getAll('statuses')).toEqual(['EXPIRED', 'REFUNDED', 'NO_VISITS']);
    expect(url.searchParams.get('size')).toBe('25');
    expect(result).toMatchObject({ page: 0, size: 25, totalElements: 1, hasNext: false });
    expect(result.items[0]).toMatchObject({
      productName: 'Падел 8 занятий',
      status: 'EXPIRED',
      visitsLeft: 8,
      expiresOn: '2026-11-08',
      limitations: { studios: [], exerciseTypes: ['Групповые'], directions: ['Уровень 1'] },
      bookingsCount: 1,
    });
    expect(JSON.stringify(result)).not.toContain('33333333');
  });

  it('rejects a subscription booking that names another client', async () => {
    const fetchMock = vi.fn(() =>
      json(
        page([
          {
            subscriptionId: '33333333-3333-4333-8333-333333333333',
            status: 'ACTIVE',
            bookings: [{ client: { id: OTHER } }],
          },
        ]),
      ),
    ) as unknown as typeof fetch;
    await expect(
      source(fetchMock).listSubscriptions({ ...input, group: 'CURRENT', page: 0, size: 25 }),
    ).rejects.toMatchObject({ code: 'CLIENT_ADMIN_READ_OWNERSHIP_CONFLICT' });
  });

  it('passes the booking period and cancelled filter and reports next page', async () => {
    const fetchMock = vi.fn(() =>
      json(
        page(
          [
            {
              id: '55555555-5555-4555-8555-555555555555',
              client: { id: CLIENT },
              exerciseDate: '2026-11-09T09:00:00+03:00',
              exerciseDuration: 'PT1H',
              studio: { id: 'x', name: 'Студия' },
              room: { id: 'y', name: 'Корт 1' },
              exerciseDirection: { id: 1, name: 'Падел' },
              exerciseType: { id: 2, name: 'Игра' },
              exerciseTypeFormat: 'GROUP',
              detailedPaymentType: 'SUBSCRIPTION',
              isCancelled: false,
              visitConfirmed: true,
              bookingSettlement: { status: 'PAID', outstanding: 0 },
              familyMember: null,
              createdAt: '2026-11-07T16:38:36.64196',
            },
          ],
          { last: false, totalElements: 30, totalPages: 2 },
        ),
      ),
    ) as unknown as typeof fetch;

    const result = await source(fetchMock).listBookings({
      ...input,
      period: 'PAST',
      includeCancelled: true,
      page: 0,
      size: 1,
    });
    const url = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0] as URL;
    expect(url.pathname).toBe(`/api/v1/clients/${CLIENT}/bookings`);
    expect(url.searchParams.get('timeFilter')).toBe('PAST');
    expect(url.searchParams.get('includeCanceled')).toBe('true');
    expect(result.hasNext).toBe(true);
    expect(result.items[0]).toMatchObject({
      studioName: 'Студия',
      roomName: 'Корт 1',
      paymentType: 'SUBSCRIPTION',
      visitConfirmed: true,
      settlementStatus: 'PAID',
      familyBooking: false,
    });
  });

  it('projects transactions in kopecks from the v2 endpoint', async () => {
    const fetchMock = vi.fn(() =>
      json(
        page([
          {
            id: '66666666-6666-4666-8666-666666666666',
            client: { id: CLIENT },
            createDate: '2026-10-23T15:24:29.04921',
            paymentDate: null,
            status: 'UNPAID',
            transactionFormat: 'SUBSCRIPTION',
            paymentMethod: 'SMS',
            sum: 1_980_000,
            toPay: 1_980_000,
            discount: 0,
            paymentStudio: { id: 'z', name: 'Студия' },
            cardPaymentInfo: { paymentUrl: 'https://pay.example.test/secret' },
            products: [
              { name: 'Абонемент', type: 'SUBSCRIPTION', cost: 1_980_000, count: 1, discount: 0 },
            ],
          },
        ]),
      ),
    ) as unknown as typeof fetch;

    const result = await source(fetchMock).listTransactions({ ...input, page: 0, size: 25 });
    const url = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0] as URL;
    expect(url.pathname).toBe(`/api/v2/clients/${CLIENT}/transactions`);
    expect(url.searchParams.get('sort')).toBe('createDate,desc');
    expect(result.items[0]).toMatchObject({
      status: 'UNPAID',
      sumKopecks: 1_980_000,
      products: [{ name: 'Абонемент', costKopecks: 1_980_000, count: 1 }],
    });
    expect(JSON.stringify(result)).not.toContain('pay.example.test');
  });

  it('retries a 5xx once and opens the circuit after repeated failures', async () => {
    const fetchMock = vi.fn(() => json({}, 503)) as unknown as typeof fetch;
    const metrics: string[] = [];
    const adapter = source(fetchMock, {
      circuitFailureThreshold: 2,
      onMetric: (metric) => metrics.push(metric.outcome),
    });
    await expect(adapter.readProfile(input)).rejects.toMatchObject({
      code: 'CLIENT_ADMIN_READ_UNAVAILABLE',
      status: 503,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await expect(adapter.readProfile(input)).rejects.toMatchObject({
      code: 'CLIENT_ADMIN_READ_CIRCUIT_OPEN',
    });
    expect(metrics).toEqual(['retry', 'failure', 'circuit_open']);
  });

  it('does not retry 404 and maps a timeout', async () => {
    const notFound = vi.fn(() => json({}, 404)) as unknown as typeof fetch;
    await expect(source(notFound).readProfile(input)).rejects.toMatchObject({
      code: 'CLIENT_ADMIN_READ_NOT_FOUND',
    });
    expect(notFound).toHaveBeenCalledTimes(1);

    const aborting = vi.fn(() => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      return Promise.reject(error);
    }) as unknown as typeof fetch;
    await expect(source(aborting, { maxAttempts: 1 }).readProfile(input)).rejects.toMatchObject({
      code: 'CLIENT_ADMIN_READ_TIMEOUT',
    });
  });

  it('rejects malformed payloads, bad page bounds and disabled mode without calling Viva', async () => {
    const malformed = vi.fn(() => json({ content: 'nope' })) as unknown as typeof fetch;
    await expect(
      source(malformed).listTransactions({ ...input, page: 0, size: 25 }),
    ).rejects.toBeInstanceOf(VivaClientAdminReadError);

    const untouched = vi.fn() as unknown as typeof fetch;
    await expect(
      source(untouched).listTransactions({ ...input, page: 0, size: 500 }),
    ).rejects.toMatchObject({ code: 'CLIENT_ADMIN_READ_RESPONSE_INVALID' });
    await expect(source(untouched, { mode: 'mock' }).readProfile(input)).rejects.toMatchObject({
      code: 'CLIENT_ADMIN_READ_DISABLED',
    });
    await expect(
      source(untouched).readProfile({ ...input, providerClientId: '../admin' }),
    ).rejects.toMatchObject({ code: 'CLIENT_ADMIN_READ_RESPONSE_INVALID' });
    expect(untouched).not.toHaveBeenCalled();
  });

  it('requires https and credentials for live modes', () => {
    expect(() =>
      source(vi.fn() as unknown as typeof fetch, { apiBaseUrl: 'http://viva.example.test' }),
    ).toThrow('VIVA_CLIENT_ADMIN_READ_BASE_URL_INVALID');
    expect(() => source(vi.fn() as unknown as typeof fetch, { apiKey: '' })).toThrow(
      'VIVA_CLIENT_ADMIN_READ_CREDENTIALS_REQUIRED',
    );
  });
});
