import { describe, it, expect, vi } from 'vitest';
import {
  VivaNotificationSource,
  normalizeVivaSubscription,
  normalizeVivaAttendance,
  vivaBirthdayFacts,
  vivaSubscriptionDeadline,
} from './notification-lifecycle-source.js';
const now = new Date('2026-10-21T12:00:00Z');
const subscription = {
  subscriptionId: 'synthetic-subscription',
  status: 'ACTIVE',
  activationDate: '2026-09-01',
  expirationDate: '2026-10-31',
};
const exercise = {
  id: 'exercise-synthetic',
  type: { id: 11 },
  studio: { id: 'studio-synthetic' },
  timeTo: '2026-10-21T11:00:00+03:00',
};
const booking = { client: { id: 'client-synthetic' }, visitConfirmed: true };
const normalize = (b: unknown, e: unknown = exercise) =>
  normalizeVivaAttendance(e, b, now, ['11'], ['studio-synthetic']);
function page(content: unknown[], number = 0, total = content.length, totalPages = 1, last = true) {
  return { content, number, totalElements: total, totalPages, last };
}
describe('Viva notification facts from LK1 contracts', () => {
  it('uses inclusive provider-local expiry and handles month/year boundaries', () => {
    expect(vivaSubscriptionDeadline('2026-12-31')).toBe('2026-12-31T21:00:00.000Z');
    expect(() => vivaSubscriptionDeadline('2026-02-30')).toThrow();
    expect(normalizeVivaSubscription(subscription)).toMatchObject({
      valid: true,
      anchor: '2026-10-31T21:00:00.000Z',
    });
  });
  it.each([
    { status: 'HOLD' },
    { status: 'REFUNDED' },
    { status: 'EXPIRED' },
    { status: 'UNKNOWN' },
    { status: 'NEW' },
    { isFrozen: true },
    { holdUntil: '2026-11-01' },
    { frozenUntil: '2026-11-01' },
    { activationDate: null },
    { expirationDate: null },
  ])('suppresses uncertain/renewed/frozen state %j', (patch) =>
    expect(normalizeVivaSubscription({ ...subscription, ...patch }, now).valid).toBe(false),
  );
  it('minimizes birthday data and uses explicit leap-day policy', () => {
    expect(vivaBirthdayFacts('1987-10-22', now)).toEqual([
      {
        key: 'birthday:2026',
        trigger: 'BIRTHDAY',
        anchor: '2026-10-22T10:00:00+03:00',
        valid: true,
        serviceTitle: 'День рождения',
        scope: 'BIRTHDAY',
      },
      {
        key: 'birthday:2027',
        trigger: 'BIRTHDAY',
        anchor: '2027-10-22T10:00:00+03:00',
        valid: true,
        serviceTitle: 'День рождения',
        scope: 'BIRTHDAY',
      },
    ]);
    expect(JSON.stringify(vivaBirthdayFacts('1987-10-22', now))).not.toContain('1987');
    expect(vivaBirthdayFacts('2000-02-29', now)).toEqual([]);
    expect(vivaBirthdayFacts(null, now)).toEqual([]);
  });
  it('accepts only an explicit visit and a configured past training, without a phone fallback', () => {
    expect(normalize(booking)?.valid).toBe(true);
    expect(normalize({ client: { phone: 'synthetic' } })).toBeNull();
    expect(normalize(booking, { ...exercise, type: { id: 99 } })).toBeNull();
    expect(normalize(booking, { ...exercise, studio: { id: 'other' } })).toBeNull();
  });
  it.each([
    { visitConfirmed: false, status: 'ATTENDED' },
    { visitConfirmed: false, visited: true },
    { status: 'COMPLETED', visitConfirmed: undefined },
    { paymentStatus: 'UNPAID' },
    { status: 'NO_SHOW' },
    { cancelled: true },
  ])('does not invent attendance for %j', (patch) =>
    expect(normalize({ ...booking, ...patch })?.valid).toBe(false),
  );
  it('revokes a cancelled exercise and rejects a future exercise', () => {
    expect(normalize(booking, { ...exercise, cancelled: true })?.valid).toBe(false);
    expect(normalize(booking, { ...exercise, timeTo: '2026-10-22T11:00:00+03:00' })?.valid).toBe(
      false,
    );
  });
  it('drains complete owned subscription pages against fixed Viva paths', async () => {
    const urls: string[] = [];
    const fetcher = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString();
      urls.push(url);
      expect(init?.redirect).toBe('error');
      expect(new URL(url).origin).toBe('https://api.vivacrm.ru');
      return Promise.resolve(
        Response.json(
          url.endsWith('/profile')
            ? { id: 'client-synthetic', birthDate: null }
            : url.includes('page=0')
              ? page([subscription], 0, 2, 2, false)
              : page([{ ...subscription, subscriptionId: 'second' }], 1, 2, 2, true),
        ),
      );
    });
    const source = new VivaNotificationSource({
      providerTenantKey: 'iSkq6G',
      timeoutMs: 500,
      fetchImplementation: fetcher,
    });
    const result = await source.readOwned({
      accessToken: 'synthetic-token',
      correlationId: 'synthetic',
      now,
    });
    expect(result.facts).toHaveLength(2);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(urls[1]).toContain('includeFinished=true');
  });
  it.each([
    page([subscription], 0, 2, 1, true),
    page([subscription], 2, 1, 1, true),
    page([subscription, subscription], 0, 2, 1, true),
  ])('rejects incomplete/inconsistent/duplicate snapshots', async (response) => {
    const fetcher = (input: RequestInfo | URL): Promise<Response> =>
      Promise.resolve(
        Response.json(
          (input instanceof Request ? input.url : input.toString()).endsWith('/profile')
            ? { id: 'client-synthetic', birthDate: null }
            : response,
        ),
      );
    const source = new VivaNotificationSource({
      providerTenantKey: 'iSkq6G',
      timeoutMs: 500,
      fetchImplementation: fetcher,
    });
    await expect(
      source.readOwned({ accessToken: 'synthetic-token', correlationId: 'synthetic', now }),
    ).rejects.toThrow();
  });
  it('reports complete empty attendance scope for revoked confirmations', async () => {
    const fetcher = (input: RequestInfo | URL): Promise<Response> =>
      Promise.resolve(
        Response.json(
          (input instanceof Request ? input.url : input.toString()).includes('/bookings?')
            ? page([])
            : page([exercise]),
        ),
      );
    const source = new VivaNotificationSource({
      providerTenantKey: 'iSkq6G',
      timeoutMs: 500,
      fetchImplementation: fetcher,
    });
    expect(
      await source.readAttendance({
        accessToken: 'synthetic-token',
        correlationId: 'synthetic',
        date: '2026-10-21',
        now,
        allowedTypeIds: ['11'],
        allowedStudioIds: ['studio-synthetic'],
      }),
    ).toEqual({ facts: [], scopes: ['ATTENDANCE:exercise-synthetic'] });
  });
  it('bounds aggregate rows even when each provider page is valid', async () => {
    let calls = 0;
    const fetcher = (input: RequestInfo | URL): Promise<Response> => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      calls++;
      if (url.pathname.endsWith('/profile'))
        return Promise.resolve(Response.json({ id: 'client-synthetic', birthDate: null }));
      const number = Number(url.searchParams.get('page'));
      return Promise.resolve(
        Response.json(
          page(
            Array.from({ length: 500 }, (_, i) => ({
              ...subscription,
              subscriptionId: `synthetic-${number}-${i}`,
            })),
            number,
            2500,
            5,
            number === 4,
          ),
        ),
      );
    };
    const source = new VivaNotificationSource({
      providerTenantKey: 'iSkq6G',
      timeoutMs: 500,
      fetchImplementation: fetcher,
    });
    await expect(
      source.readOwned({ accessToken: 'synthetic-token', correlationId: 'synthetic', now }),
    ).rejects.toThrow('VIVA_NOTIFICATION_SCAN_BUDGET_EXCEEDED');
    expect(calls).toBe(6);
  });
  it('refuses an oversized exercise fanout before reading any bookings', async () => {
    const fetcher = vi.fn(() =>
      Promise.resolve(
        Response.json(
          page(Array.from({ length: 31 }, (_, i) => ({ ...exercise, id: `synthetic-${i}` }))),
        ),
      ),
    );
    const source = new VivaNotificationSource({
      providerTenantKey: 'iSkq6G',
      timeoutMs: 500,
      fetchImplementation: fetcher,
    });
    await expect(
      source.readAttendance({
        accessToken: 'synthetic-token',
        correlationId: 'synthetic',
        date: '2026-10-21',
        now,
        allowedTypeIds: ['11'],
        allowedStudioIds: ['studio-synthetic'],
      }),
    ).rejects.toThrow('VIVA_NOTIFICATION_SCAN_BUDGET_EXCEEDED');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
