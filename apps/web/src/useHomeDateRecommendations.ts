import { useCallback, useEffect, useRef, useState } from 'react';

import type {
  BookingRecommendationPage,
  HomeBookingRecommendationFilters,
  HomeBookingRecommendationPage,
} from './auth-gateway.js';

const dateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Moscow',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

export function recommendationLocalDateKey(date: Date): string {
  return dateFormatter.format(date);
}

export function recommendationCalendarDays(now: Date): readonly Date[] {
  const firstDay = Date.parse(`${recommendationLocalDateKey(now)}T12:00:00Z`);
  return Array.from({ length: 15 }, (_, index) => new Date(firstDay + index * 86_400_000));
}

function isStale(page: BookingRecommendationPage): boolean {
  return !(Date.parse(page.staleAt) > Date.now());
}

interface DateEntry {
  readonly page: HomeBookingRecommendationPage | null;
  readonly loading: boolean;
  readonly error: boolean;
}

function itemsOnDate(
  page: HomeBookingRecommendationPage,
  date: string,
): HomeBookingRecommendationPage {
  return {
    ...page,
    items: page.items.filter(
      (item) =>
        dateFormatter.format(
          new Date(item.kind === 'GAME' ? item.game.startsAt : item.activity.startsAt),
        ) === date,
    ),
  };
}

export function useHomeDateRecommendations(
  date: string | null,
  initialPage: BookingRecommendationPage | null,
  load: (input?: HomeBookingRecommendationFilters) => Promise<HomeBookingRecommendationPage>,
) {
  const [entries, setEntries] = useState<Record<string, DateEntry>>({});
  const pending = useRef(new Set<string>());
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const entry = date ? entries[date] : undefined;
  const fetchPage = useCallback(
    (requestedDate: string, cursor?: string) => {
      if (pending.current.has(requestedDate)) return;
      pending.current.add(requestedDate);
      const input = cursor ? { limit: 12, cursor } : { limit: 14, localDate: requestedDate };
      void load(input)
        .then((page) => {
          if (cursor && page.nextCursor === cursor)
            throw new Error('RECOMMENDATION_CURSOR_STALLED');
          if (!mounted.current) return;
          setEntries((current) => {
            const previous = current[requestedDate]?.page;
            const key = (item: BookingRecommendationPage['items'][number]) =>
              `${item.kind}:${item.kind === 'GAME' ? item.game.id : item.activity.id}`;
            const known = new Set(previous?.items.map(key));
            return {
              ...current,
              [requestedDate]: {
                page: itemsOnDate(
                  previous && cursor
                    ? {
                        ...page,
                        items: [
                          ...previous.items,
                          ...page.items.filter((item) => !known.has(key(item))),
                        ],
                      }
                    : page,
                  requestedDate,
                ),
                loading: false,
                error: page.incomplete === true,
              },
            };
          });
        })
        .catch(() => {
          if (mounted.current)
            setEntries((current) => ({
              ...current,
              [requestedDate]: {
                page: current[requestedDate]?.page ?? null,
                loading: false,
                error: true,
              },
            }));
        })
        .finally(() => {
          pending.current.delete(requestedDate);
        });
    },
    [load],
  );
  const loadMore = useCallback(() => {
    if (!date || pending.current.has(date)) return;
    const restart = entry?.page && (entry.page.incomplete || isStale(entry.page));
    const cursor = restart ? undefined : entry?.page?.nextCursor;
    if (entry?.page && !cursor && !restart) return;
    setEntries((current) => ({
      ...current,
      [date]: {
        page: current[date]?.page ?? null,
        loading: true,
        error: false,
      },
    }));
    fetchPage(date, cursor ?? undefined);
  }, [date, entry, fetchPage]);
  const lastSelectedDate = useRef<string | null>(null);
  useEffect(() => {
    if (lastSelectedDate.current === date) return;
    lastSelectedDate.current = date;
    if (date && (!entry?.page || isStale(entry.page)) && !entry?.error) fetchPage(date);
  }, [date, entry, fetchPage]);

  // Warm items are useful immediately, but their weekly cursor must never be used for a date.
  const warmPage =
    date && initialPage ? { ...itemsOnDate(initialPage, date), nextCursor: null } : null;
  return {
    page: date ? (entry?.page ?? warmPage) : initialPage,
    loading: Boolean(date && (!entry || entry.loading)),
    error: entry?.error ?? false,
    loadMore,
  };
}
