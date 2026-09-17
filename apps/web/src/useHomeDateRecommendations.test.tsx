// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  BookingRecommendationPage,
  HomeBookingRecommendationFilters,
} from './auth-gateway.js';
import {
  recommendationCalendarDays,
  recommendationLocalDateKey,
  useHomeDateRecommendations,
} from './useHomeDateRecommendations.js';

const page = (date: string, nextCursor: string | null = null): BookingRecommendationPage => ({
  version: date,
  generatedAt: `${date}T09:00:00Z`,
  staleAt: `${date}T09:05:00Z`,
  personalization: 'BASIC',
  nextCursor,
  items: [
    {
      kind: 'TRAINING',
      reasons: [],
      activity: {
        id: date,
        kind: 'TRAINING',
        title: date,
        startsAt: `${date}T09:00:00Z`,
        endsAt: `${date}T10:00:00Z`,
        timezone: 'Europe/Moscow',
        station: { id: 'test', name: 'Test', shortAddress: null },
        levelRange: null,
        capacity: { total: 4, open: 4 },
        host: null,
        route: '/trainings',
      },
    },
  ],
});
const deferred = () => {
  let resolve!: (value: BookingRecommendationPage) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<BookingRecommendationPage>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-07-19T09:01:00Z'));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
describe('Home date recommendations', () => {
  it('shows warm matches immediately without using the weekly cursor; isolates out-of-order dates and reuses visited days', async () => {
    const a = deferred();
    const b = deferred();
    const load = vi.fn((input?: HomeBookingRecommendationFilters) =>
      input?.localDate === '2026-07-19' ? a.promise : b.promise,
    );
    const initial = page('2026-07-19', 'weekly-cursor');
    const { result, rerender } = renderHook(
      ({ date }: { date: string | null }) => useHomeDateRecommendations(date, initial, load),
      { initialProps: { date: '2026-07-19' } },
    );
    expect(result.current.page?.items).toEqual(initial.items);
    expect(result.current.page?.nextCursor).toBeNull();
    expect(result.current.loading).toBe(true);
    expect(load).toHaveBeenCalledWith({ limit: 14, localDate: '2026-07-19' });
    rerender({ date: '2026-07-20' });
    expect(result.current.page?.items).toEqual([]);
    await act(async () => {
      await Promise.resolve();
      b.resolve(page('2026-07-20'));
    });
    await act(async () => {
      await Promise.resolve();
      a.resolve(page('2026-07-19'));
    });
    expect(result.current.page?.version).toBe('2026-07-20');
    rerender({ date: '2026-07-19' });
    expect(result.current.page?.items).toEqual(initial.items);
    expect(result.current.loading).toBe(false);
    expect(load).toHaveBeenCalledTimes(2);
    rerender({ date: null });
    expect(result.current.page).toBe(initial);
  });

  it('preserves warm cards on failure, retries only the date, and stops on an empty complete day', async () => {
    const initial = page('2026-07-19');
    const load = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ ...initial, items: [] });
    const { result } = renderHook(() => useHomeDateRecommendations('2026-07-19', initial, load));
    await waitFor(() => expect(result.current.error).toBe(true));
    expect(result.current.page?.items).toEqual(initial.items);
    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.error).toBe(false));
    expect(result.current.page?.items).toEqual([]);
    expect(result.current.loading).toBe(false);
    expect(load).toHaveBeenCalledTimes(2);
    expect(load).toHaveBeenLastCalledWith({ limit: 14, localDate: '2026-07-19' });
  });

  it('reuses fresh dates and refreshes expired days when selected again', async () => {
    const initial = page('2026-07-19');
    const refreshed = { ...initial, version: 'fresh', staleAt: '2026-07-19T09:11:00Z' };
    const load = vi.fn().mockResolvedValueOnce(initial).mockResolvedValueOnce(refreshed);
    const { result, rerender } = renderHook(
      ({ date }: { date: string | null }) => useHomeDateRecommendations(date, initial, load),
      { initialProps: { date: '2026-07-19' } },
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    rerender({ date: null });
    vi.setSystemTime(new Date('2026-07-19T09:06:00Z'));
    rerender({ date: '2026-07-19' });
    expect(result.current.page?.items).toEqual(initial.items);
    await waitFor(() => expect(result.current.page?.version).toBe('fresh'));
    expect(load).toHaveBeenCalledTimes(2);
    expect(load).toHaveBeenLastCalledWith({ limit: 14, localDate: '2026-07-19' });
  });

  it('uses Moscow days at a UTC date boundary for all 15 calendar buttons', () => {
    const days = recommendationCalendarDays(new Date('2026-07-18T22:30:00Z'));
    expect(days).toHaveLength(15);
    expect(days.map(recommendationLocalDateKey)).toEqual(
      Array.from(
        { length: 15 },
        (_, i) =>
          `2026-${i < 13 ? '07' : '08'}-${String(i < 13 ? 19 + i : i - 12).padStart(2, '0')}`,
      ),
    );
  });

  it('keeps partial rows and retries the date rather than treating it as complete', async () => {
    const partial = { ...page('2026-07-19'), incomplete: true };
    const load = vi.fn().mockResolvedValueOnce(partial).mockResolvedValueOnce(page('2026-07-19'));
    const { result } = renderHook(() => useHomeDateRecommendations('2026-07-19', null, load));
    await waitFor(() => expect(result.current.error).toBe(true));
    expect(result.current.page?.items).toEqual(partial.items);
    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.error).toBe(false));
    expect(load).toHaveBeenLastCalledWith({ limit: 14, localDate: '2026-07-19' });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('paginates only the selected-day cursor and deduplicates concurrent load-more calls', async () => {
    const first = page('2026-07-19', 'day-cursor');
    const next = deferred();
    const load = vi
      .fn()
      .mockResolvedValueOnce(first)
      .mockImplementation(() => next.promise);
    const { result } = renderHook(() => useHomeDateRecommendations('2026-07-19', null, load));
    await waitFor(() => expect(result.current.page).toEqual(first));
    act(() => {
      result.current.loadMore();
      result.current.loadMore();
    });
    expect(load).toHaveBeenCalledTimes(2);
    expect(load).toHaveBeenLastCalledWith({ limit: 12, cursor: 'day-cursor' });
    await act(async () => {
      await Promise.resolve();
      next.resolve(page('2026-07-19'));
    });
    expect(result.current.page?.items).toHaveLength(1);
    expect(result.current.page?.nextCursor).toBeNull();
  });
});
