import { describe, expect, it, vi } from 'vitest';
import {
  readActiveSubscriptions,
  subscriptionIsValidityOnly,
  subscriptionRemaining,
} from './active-subscriptions.js';
import type { ActiveSubscription } from './active-subscriptions.js';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const item = (n: number): ActiveSubscription => ({
  id: id(n),
  title: `Абонемент ${n}`,
  kind: 'INDIVIDUAL',
  status: 'ACTIVE',
  remaining: { amount: 8, unit: 'VISITS' },
  validUntil: '2026-12-31T00:00:00Z',
});
const snapshot = { id: id(999), asOf: '2026-10-16T09:00:00Z', staleAt: '2026-10-16T10:00:00Z' };
function page(
  items = [item(1)],
  offset = 0,
  total = items.length,
  nextCursor: string | null = null,
) {
  return {
    scope: 'CURRENT',
    coverage: 'COMPLETE',
    snapshot,
    freshness: 'FRESH',
    items,
    page: { offset, total, limit: 50, hasMore: nextCursor !== null, nextCursor },
  };
}
describe('complete active subscription reader', () => {
  it('consumes the full pinned cursor chain before returning only ACTIVE products', async () => {
    const first = Array.from({ length: 50 }, (_, i) => item(i + 1));
    first[0] = { ...item(1), status: 'PAUSED' };
    const request = vi
      .fn()
      .mockResolvedValueOnce(page(first, 0, 51, 'opaque+/='))
      .mockResolvedValueOnce(page([item(51)], 50, 51));
    const result = await readActiveSubscriptions(request);
    expect(result.items).toHaveLength(50);
    expect(result.items.at(-1)?.id).toBe(id(51));
    expect(result.items.some((value) => value.status !== 'ACTIVE')).toBe(false);
    expect(request.mock.calls).toEqual([
      ['/subscriptions?limit=50'],
      ['/subscriptions?limit=50&cursor=opaque%2B%2F%3D'],
    ]);
  });
  it('keeps a complete snapshot when it becomes stale during pagination', async () => {
    const first = page(
      Array.from({ length: 50 }, (_, i) => item(i + 1)),
      0,
      51,
      'cursor',
    );
    const second = { ...page([item(51)], 50, 51), freshness: 'STALE' };
    const result = await readActiveSubscriptions(
      vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second),
    );
    expect(result.items).toHaveLength(51);
    expect(result.freshness).toBe('STALE');
  });
  it('accepts proven complete empty and stale snapshots without inventing validity or units', async () => {
    expect((await readActiveSubscriptions(() => Promise.resolve(page([])))).items).toEqual([]);
    const result = await readActiveSubscriptions(() =>
      Promise.resolve({
        ...page([
          {
            ...item(1),
            title: null,
            validUntil: null,
            remaining: { amount: null, unit: 'UNKNOWN' },
          },
        ]),
        freshness: 'STALE',
      }),
    );
    expect(result.freshness).toBe('STALE');
    expect(result.items[0]?.remaining.amount).toBeNull();
  });
  it.each([
    { ...page(), coverage: 'PARTIAL' },
    { ...page(), scope: 'ARCHIVE' },
    page([item(1), item(1)]),
    page([item(2), item(1)]),
    page([{ ...item(1), remaining: { amount: 8, unit: 'UNKNOWN' } }]),
    page([{ ...item(1), validUntil: 'invalid' }]),
    page([], 0, 1, 'cursor'),
    page([item(1)], 0, 1, 'cursor'),
    { ...page(), page: { ...page().page, total: -1 } },
  ])(
    'rejects incomplete or malformed data rather than returning a partial list %#',
    async (value) => {
      await expect(readActiveSubscriptions(() => Promise.resolve(value))).rejects.toThrow(
        'SUBSCRIPTIONS_INCOMPLETE',
      );
    },
  );
  it.each(['id', 'asOf', 'staleAt', 'total', 'offset', 'duplicate'])(
    'discards the chain on %s drift',
    async (field) => {
      const first = page(
        Array.from({ length: 50 }, (_, i) => item(i + 1)),
        0,
        51,
        'cursor',
      );
      const second = page([item(51)], 50, 51);
      const changed =
        field === 'total'
          ? { ...second, page: { ...second.page, total: 52 } }
          : field === 'offset'
            ? { ...second, page: { ...second.page, offset: 49 } }
            : field === 'duplicate'
              ? { ...second, items: [item(50)] }
              : {
                  ...second,
                  snapshot: {
                    ...snapshot,
                    [field]: field === 'id' ? id(998) : '2026-10-16T09:30:00Z',
                  },
                };
      await expect(
        readActiveSubscriptions(
          vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(changed),
        ),
      ).rejects.toThrow('SUBSCRIPTIONS_INCOMPLETE');
    },
  );
  it.each(['404', '503', '409 SUBSCRIPTIONS_SNAPSHOT_CHANGED'])(
    'propagates %s without Home fallback or automatic retry',
    async (message) => {
      const request = vi
        .fn()
        .mockResolvedValueOnce(
          page(
            Array.from({ length: 50 }, (_, i) => item(i + 1)),
            0,
            51,
            'cursor',
          ),
        )
        .mockRejectedValueOnce(new Error(message));
      await expect(readActiveSubscriptions(request)).rejects.toThrow(message);
      expect(request).toHaveBeenCalledTimes(2);
    },
  );
});
describe('subscription display policy', () => {
  it.each(['Дружба', 'РА', 'Академия', 'Дружба 2.0', 'Дружба2.0', ' дружба   2.0 '])(
    'hides remainder only for exact product %s',
    (title) => expect(subscriptionIsValidityOnly(title)).toBe(true),
  );
  it.each(['Дружба Плюс', 'Энергия', 'Дети падел', null])('preserves remainder for %s', (title) =>
    expect(subscriptionIsValidityOnly(title)).toBe(false),
  );
  it('uses verified visit units and preserves other or unknown units', () => {
    expect(subscriptionRemaining(item(1))).toBe('Посещений осталось: 8');
    expect(subscriptionRemaining({ ...item(1), remaining: { amount: 0, unit: 'VISITS' } })).toBe(
      'Посещений осталось: 0',
    );
    expect(
      subscriptionRemaining({ ...item(1), remaining: { amount: null, unit: 'UNKNOWN' } }),
    ).toBe('Остаток не указан');
    expect(subscriptionRemaining({ ...item(1), remaining: { amount: 90, unit: 'MINUTES' } })).toBe(
      'Минут осталось: 90',
    );
  });
});
