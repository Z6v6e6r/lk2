import { useCallback, useEffect, useReducer, useRef, useState } from 'react';

export interface PaginatedEventSearchPage<Item, Metadata = undefined> {
  readonly items: readonly Item[];
  readonly nextCursor?: string | null;
  readonly metadata?: Metadata;
}

export interface PaginatedEventSearchRequest {
  readonly cursor?: string;
  readonly signal: AbortSignal;
}

export type PaginatedEventSearchErrorPhase = 'initial' | 'more';

export interface PaginatedEventSearchResult<Item, Metadata = undefined> {
  readonly items: readonly Item[];
  readonly nextCursor: string | null;
  readonly metadata: Metadata | undefined;
  readonly loading: boolean;
  readonly loadingMore: boolean;
  readonly error: Error | null;
  readonly errorPhase: PaginatedEventSearchErrorPhase | null;
  readonly loadMore: () => Promise<void>;
  readonly retry: () => Promise<void>;
  readonly restart: () => Promise<void>;
}

export interface PaginatedEventSearchOptions<Query, Item, Metadata = undefined> {
  /** A stable identity for every server-visible field in query. */
  readonly queryKey: string;
  readonly query: Query;
  readonly loadPage: (
    query: Query,
    request: PaginatedEventSearchRequest,
  ) => Promise<PaginatedEventSearchPage<Item, Metadata>>;
  readonly itemKey: (item: Item) => string;
}

interface SearchState<Item, Metadata> {
  readonly queryKey: string;
  readonly generation: number;
  readonly items: readonly Item[];
  readonly nextCursor: string | null;
  readonly metadata: Metadata | undefined;
  readonly loading: boolean;
  readonly loadingMore: boolean;
  readonly error: Error | null;
  readonly errorPhase: PaginatedEventSearchErrorPhase | null;
}

type SearchAction<Item, Metadata> =
  | { readonly type: 'initial-started'; readonly queryKey: string; readonly generation: number }
  | {
      readonly type: 'initial-succeeded';
      readonly generation: number;
      readonly page: PaginatedEventSearchPage<Item, Metadata>;
      readonly itemKey: (item: Item) => string;
    }
  | { readonly type: 'initial-failed'; readonly generation: number; readonly error: Error }
  | { readonly type: 'more-started'; readonly generation: number }
  | {
      readonly type: 'more-succeeded';
      readonly generation: number;
      readonly page: PaginatedEventSearchPage<Item, Metadata>;
      readonly itemKey: (item: Item) => string;
    }
  | { readonly type: 'more-failed'; readonly generation: number; readonly error: Error };

function asError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

function uniqueItems<Item>(
  current: readonly Item[],
  incoming: readonly Item[],
  itemKey: (item: Item) => string,
): readonly Item[] {
  const seen = new Set<string>();
  const result: Item[] = [];
  for (const item of [...current, ...incoming]) {
    const key = itemKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function reducer<Item, Metadata>(
  state: SearchState<Item, Metadata>,
  action: SearchAction<Item, Metadata>,
): SearchState<Item, Metadata> {
  if (action.type === 'initial-started') {
    return {
      queryKey: action.queryKey,
      generation: action.generation,
      items: [],
      nextCursor: null,
      metadata: undefined,
      loading: true,
      loadingMore: false,
      error: null,
      errorPhase: null,
    };
  }
  if (action.generation !== state.generation) return state;
  switch (action.type) {
    case 'initial-succeeded':
      return {
        ...state,
        items: uniqueItems([], action.page.items, action.itemKey),
        nextCursor: action.page.nextCursor ?? null,
        metadata: action.page.metadata,
        loading: false,
        error: null,
        errorPhase: null,
      };
    case 'initial-failed':
      return {
        ...state,
        loading: false,
        error: action.error,
        errorPhase: 'initial',
      };
    case 'more-started':
      return { ...state, loadingMore: true, error: null, errorPhase: null };
    case 'more-succeeded':
      return {
        ...state,
        items: uniqueItems(state.items, action.page.items, action.itemKey),
        nextCursor: action.page.nextCursor ?? null,
        metadata: action.page.metadata ?? state.metadata,
        loadingMore: false,
        error: null,
        errorPhase: null,
      };
    case 'more-failed':
      return {
        ...state,
        loadingMore: false,
        error: action.error,
        errorPhase: 'more',
      };
  }
}

/**
 * Owns one cursor chain for one canonical event-search query.
 *
 * Changing queryKey starts a new generation, clears the previous cursor and ignores every late
 * response from the previous generation. Callers must include every server-visible query field in
 * queryKey.
 */
export function usePaginatedEventSearch<Query, Item, Metadata = undefined>({
  queryKey,
  query,
  loadPage,
  itemKey,
}: PaginatedEventSearchOptions<Query, Item, Metadata>): PaginatedEventSearchResult<Item, Metadata> {
  const generationRef = useRef(0);
  const controllersRef = useRef(new Set<AbortController>());
  const moreRequestRef = useRef<Promise<void> | null>(null);
  const queryRef = useRef(query);
  const loadPageRef = useRef(loadPage);
  const itemKeyRef = useRef(itemKey);
  const [retryToken, setRetryToken] = useState(0);
  const [state, dispatch] = useReducer(reducer<Item, Metadata>, {
    queryKey,
    generation: 0,
    items: [],
    nextCursor: null,
    metadata: undefined,
    loading: true,
    loadingMore: false,
    error: null,
    errorPhase: null,
  });

  useEffect(() => {
    queryRef.current = query;
    loadPageRef.current = loadPage;
    itemKeyRef.current = itemKey;
  }, [itemKey, loadPage, query]);

  useEffect(() => {
    const controllers = controllersRef.current;
    return () => {
      for (const controller of controllers) controller.abort();
      controllers.clear();
      moreRequestRef.current = null;
    };
  }, []);

  useEffect(() => {
    const controllers = controllersRef.current;
    for (const controller of controllers) controller.abort();
    controllers.clear();
    moreRequestRef.current = null;

    const generation = generationRef.current + 1;
    generationRef.current = generation;
    const controller = new AbortController();
    controllers.add(controller);
    dispatch({ type: 'initial-started', queryKey, generation });

    void Promise.resolve()
      .then(() => loadPageRef.current(queryRef.current, { signal: controller.signal }))
      .then(
        (page) => {
          if (controller.signal.aborted) return;
          dispatch({
            type: 'initial-succeeded',
            generation,
            page,
            itemKey: itemKeyRef.current,
          });
        },
        (error: unknown) => {
          if (controller.signal.aborted) return;
          dispatch({ type: 'initial-failed', generation, error: asError(error) });
        },
      )
      .finally(() => controllers.delete(controller));

    return () => {
      controller.abort();
      controllers.delete(controller);
    };
  }, [queryKey, retryToken]);

  const currentState: SearchState<Item, Metadata> =
    state.queryKey === queryKey
      ? state
      : {
          queryKey,
          generation: state.generation + 1,
          items: [],
          nextCursor: null,
          metadata: undefined,
          loading: true,
          loadingMore: false,
          error: null,
          errorPhase: null,
        };

  const loadMore = useCallback(async (): Promise<void> => {
    if (state.queryKey !== queryKey || state.loading || state.loadingMore || !state.nextCursor) {
      return;
    }
    if (moreRequestRef.current) return moreRequestRef.current;

    const generation = state.generation;
    const cursor = state.nextCursor;
    const requestQuery = queryRef.current;
    const controller = new AbortController();
    controllersRef.current.add(controller);
    dispatch({ type: 'more-started', generation });

    const request = Promise.resolve()
      .then(() =>
        loadPageRef.current(requestQuery, {
          cursor,
          signal: controller.signal,
        }),
      )
      .then(
        (page) => {
          if (controller.signal.aborted) return;
          dispatch({
            type: 'more-succeeded',
            generation,
            page,
            itemKey: itemKeyRef.current,
          });
        },
        (error: unknown) => {
          if (controller.signal.aborted) return;
          dispatch({ type: 'more-failed', generation, error: asError(error) });
        },
      )
      .finally(() => {
        controllersRef.current.delete(controller);
        if (moreRequestRef.current === request) moreRequestRef.current = null;
      });
    moreRequestRef.current = request;
    return request;
  }, [
    queryKey,
    state.generation,
    state.loading,
    state.loadingMore,
    state.nextCursor,
    state.queryKey,
  ]);

  const retry = useCallback(async (): Promise<void> => {
    if (state.queryKey === queryKey && state.errorPhase === 'more' && state.nextCursor) {
      return loadMore();
    }
    setRetryToken((current) => current + 1);
  }, [loadMore, queryKey, state.errorPhase, state.nextCursor, state.queryKey]);

  const restart = useCallback((): Promise<void> => {
    setRetryToken((current) => current + 1);
    return Promise.resolve();
  }, []);

  return {
    items: currentState.items,
    nextCursor: currentState.nextCursor,
    metadata: currentState.metadata,
    loading: currentState.loading,
    loadingMore: currentState.loadingMore,
    error: currentState.error,
    errorPhase: currentState.errorPhase,
    loadMore,
    retry,
    restart,
  };
}
