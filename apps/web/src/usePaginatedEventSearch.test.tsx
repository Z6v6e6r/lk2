// @vitest-environment jsdom

import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import {
  usePaginatedEventSearch,
  type PaginatedEventSearchPage,
} from './usePaginatedEventSearch.js';

interface Item {
  readonly id: string;
}

function deferred<Value>(): {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value) => void;
  readonly reject: (error: unknown) => void;
} {
  let resolve!: (value: Value) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const itemKey = (item: Item) => item.id;

describe('usePaginatedEventSearch', () => {
  it('deduplicates page boundaries and advances the cursor', async () => {
    const loadPage = vi
      .fn()
      .mockResolvedValueOnce({ items: [{ id: 'one' }, { id: 'one' }], nextCursor: 'page-2' })
      .mockResolvedValueOnce({ items: [{ id: 'one' }, { id: 'two' }], nextCursor: null });
    const { result } = renderHook(() =>
      usePaginatedEventSearch({
        queryKey: 'date=one',
        query: { date: 'one' },
        loadPage,
        itemKey,
      }),
    );

    await waitFor(() => expect(result.current.items).toEqual([{ id: 'one' }]));
    await act(() => result.current.loadMore());

    expect(result.current.items).toEqual([{ id: 'one' }, { id: 'two' }]);
    expect(result.current.nextCursor).toBeNull();
    expect(loadPage.mock.calls[1]?.[1]).toMatchObject({ cursor: 'page-2' });
  });

  it('rejects a stale first page after the query changes', async () => {
    const first = deferred<PaginatedEventSearchPage<Item>>();
    const second = deferred<PaginatedEventSearchPage<Item>>();
    const loadPage = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const { result, rerender } = renderHook(
      ({ date }) =>
        usePaginatedEventSearch({
          queryKey: `date=${date}`,
          query: { date },
          loadPage,
          itemKey,
        }),
      { initialProps: { date: 'one' } },
    );
    await waitFor(() => expect(loadPage).toHaveBeenCalledTimes(1));

    rerender({ date: 'two' });
    expect(result.current.items).toEqual([]);
    await waitFor(() => expect(loadPage).toHaveBeenCalledTimes(2));
    act(() => second.resolve({ items: [{ id: 'new' }], nextCursor: null }));
    await waitFor(() => expect(result.current.items).toEqual([{ id: 'new' }]));
    act(() => first.resolve({ items: [{ id: 'stale' }], nextCursor: null }));

    expect(result.current.items).toEqual([{ id: 'new' }]);
  });

  it('does not append an old load-more response after the query changes', async () => {
    const oldMore = deferred<PaginatedEventSearchPage<Item>>();
    const loadPage = vi
      .fn()
      .mockResolvedValueOnce({ items: [{ id: 'old-first' }], nextCursor: 'old-page-2' })
      .mockImplementationOnce(() => oldMore.promise)
      .mockResolvedValueOnce({ items: [{ id: 'new-first' }], nextCursor: null });
    const { result, rerender } = renderHook(
      ({ date }) =>
        usePaginatedEventSearch({
          queryKey: `date=${date}`,
          query: { date },
          loadPage,
          itemKey,
        }),
      { initialProps: { date: 'one' } },
    );
    await waitFor(() => expect(result.current.nextCursor).toBe('old-page-2'));

    let oldRequest!: Promise<void>;
    act(() => {
      oldRequest = result.current.loadMore();
    });
    await waitFor(() => expect(loadPage).toHaveBeenCalledTimes(2));
    rerender({ date: 'two' });
    await waitFor(() => expect(result.current.items).toEqual([{ id: 'new-first' }]));
    act(() => oldMore.resolve({ items: [{ id: 'old-more' }], nextCursor: null }));
    await oldRequest;

    expect(result.current.items).toEqual([{ id: 'new-first' }]);
  });

  it('retries an initial failure as a fresh generation', async () => {
    const loadPage = vi
      .fn()
      .mockRejectedValueOnce(new Error('initial failed'))
      .mockResolvedValueOnce({ items: [{ id: 'recovered' }], nextCursor: null });
    const { result } = renderHook(() =>
      usePaginatedEventSearch({
        queryKey: 'date=one',
        query: { date: 'one' },
        loadPage,
        itemKey,
      }),
    );
    await waitFor(() => expect(result.current.errorPhase).toBe('initial'));

    await act(() => result.current.retry());

    await waitFor(() => expect(result.current.items).toEqual([{ id: 'recovered' }]));
    expect(result.current.error).toBeNull();
    expect(loadPage).toHaveBeenCalledTimes(2);
  });

  it('retries the failed cursor without dropping previously loaded items', async () => {
    const loadPage = vi
      .fn()
      .mockResolvedValueOnce({ items: [{ id: 'first' }], nextCursor: 'page-2' })
      .mockRejectedValueOnce(new Error('more failed'))
      .mockResolvedValueOnce({ items: [{ id: 'second' }], nextCursor: null });
    const { result } = renderHook(() =>
      usePaginatedEventSearch({
        queryKey: 'date=one',
        query: { date: 'one' },
        loadPage,
        itemKey,
      }),
    );
    await waitFor(() => expect(result.current.nextCursor).toBe('page-2'));
    await act(() => result.current.loadMore());
    expect(result.current.errorPhase).toBe('more');
    expect(result.current.items).toEqual([{ id: 'first' }]);

    await act(() => result.current.retry());

    expect(result.current.items).toEqual([{ id: 'first' }, { id: 'second' }]);
    expect(loadPage.mock.calls[1]?.[1]).toMatchObject({ cursor: 'page-2' });
    expect(loadPage.mock.calls[2]?.[1]).toMatchObject({ cursor: 'page-2' });
  });
});
