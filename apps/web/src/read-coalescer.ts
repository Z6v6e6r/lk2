/**
 * Shares one in-flight read between callers that ask for the same thing at the same time.
 *
 * Several effects on one screen read the same list (badges, the notifications page and the chat
 * badge all poll notifications, friend requests or conversations). Without sharing, one screen
 * issues the same request twice. The coalescer is deliberately not a cache: an entry exists only
 * while its request is pending, so a later read always goes to the API and no stale copy can
 * outlive the call. Keys carry the principal and the request parameters; `clear()` is called when
 * the session changes or ends, so two accounts can never share an entry.
 */
export interface ReadCoalescer {
  read<T>(key: string, start: () => Promise<T>): Promise<T>;
  clear(): void;
}

export function createReadCoalescer(): ReadCoalescer {
  const inFlight = new Map<string, Promise<unknown>>();
  return {
    read<T>(key: string, start: () => Promise<T>): Promise<T> {
      const pending = inFlight.get(key);
      if (pending) return pending as Promise<T>;
      const request = start();
      inFlight.set(key, request);
      const settle = (): void => {
        if (inFlight.get(key) === request) inFlight.delete(key);
      };
      request.then(settle, settle);
      return request;
    },
    clear(): void {
      inFlight.clear();
    },
  };
}
