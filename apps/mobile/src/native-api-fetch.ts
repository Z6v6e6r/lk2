import { registerPlugin } from '@capacitor/core';
import { ApiClientError } from '@phub/api-sdk';
import type { MobileRuntimeConfig } from './runtime-config.js';
import { sanitizedNativeSessionError } from './session-failure.js';

export interface AndroidSessionPlugin {
  configuration(): Promise<MobileRuntimeConfig>;
  request(input: {
    readonly path: string;
    readonly method: string;
    readonly headers: Record<string, string>;
    readonly body?: string;
  }): Promise<{
    readonly status: number;
    readonly headers: Record<string, string>;
    /** Base64; Set-Cookie is consumed only by the native session engine. */
    readonly body: string;
    /** Native cache metadata, never read from server-supplied headers. */
    readonly cache?: { readonly state: 'fresh-cache' | 'stale'; readonly savedAt: number };
  }>;
}

export const androidSessionPlugin = registerPlugin<AndroidSessionPlugin>('PadlHubAndroidSession');

export interface NativeCacheObservation {
  readonly path: string;
  readonly state: 'fresh-cache' | 'stale' | 'live' | 'unavailable';
  readonly savedAt?: number;
  /** The shared App retains loaded screen state on errors; discard it after a failed read. */
  readonly invalidate?: boolean;
}

function rejected(): ApiClientError {
  return new ApiClientError('Запрос недоступен.', 403, 'NATIVE_REQUEST_REJECTED', 'native');
}

/** Native HTTPS + Keystore custody; there is deliberately no browser-fetch fallback. */
export function createNativeApiFetch(
  config: MobileRuntimeConfig,
  plugin: AndroidSessionPlugin = androidSessionPlugin,
  onSessionExpired?: () => void,
  onCacheObservation?: (observation: NativeCacheObservation) => void,
): typeof fetch {
  let active = false;
  let generation = 0;
  const displayedReads = new Set<string>();
  return async (input, init) => {
    const value = typeof input === 'string' ? input : input instanceof URL ? input.href : '';
    const root = `${config.apiBaseUrl}/user/api/v1/${config.tenantKey}/`;
    // Check before URL normalization, which would hide traversal or encoded delimiters.
    if (!value.startsWith(root) || /[%#\\]|\.\./.test(value.split('?')[0] ?? '')) throw rejected();
    const url = new URL(value);
    if (url.origin !== config.apiBaseUrl || url.username || url.password || url.hash)
      throw rejected();
    const method = init?.method ?? 'GET';
    if (init?.body != null && typeof init.body !== 'string') throw rejected();
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    if ('cookie' in headers || 'set-cookie' in headers || 'origin' in headers) throw rejected();
    if (init?.signal?.aborted) throw new DOMException('Request aborted', 'AbortError');
    const refresh = url.pathname.endsWith('/auth/session/refresh');
    if (method === 'DELETE' && url.pathname.endsWith('/auth/session')) {
      active = false;
      generation += 1;
      displayedReads.clear();
    }
    const requestGeneration = generation;
    const cacheRead = method === 'GET' && [root + 'home/base', root + 'locations'].includes(value);
    const unavailable = (): void => {
      if (!cacheRead || requestGeneration !== generation) return;
      const invalidate = displayedReads.has(url.pathname);
      if (invalidate) {
        displayedReads.clear();
        generation += 1;
      }
      onCacheObservation?.({ path: url.pathname, state: 'unavailable', invalidate });
    };
    try {
      const result = await plugin.request({
        path: url.pathname + url.search,
        method,
        headers,
        ...(typeof init?.body === 'string' ? { body: init.body } : {}),
      });
      if (init?.signal?.aborted) throw new DOMException('Request aborted', 'AbortError');
      if (result.status === 200 && (refresh || url.pathname.endsWith('/verify'))) active = true;
      if (result.status === 401 && refresh && active) {
        active = false;
        generation += 1;
        onSessionExpired?.();
      }
      if (requestGeneration === generation && cacheRead) {
        if (result.status === 200) {
          displayedReads.add(url.pathname);
          onCacheObservation?.({
            path: url.pathname,
            state: result.cache?.state ?? 'live',
            ...(result.cache ? { savedAt: result.cache.savedAt } : {}),
          });
        } else {
          unavailable();
        }
      }
      const safeHeaders = Object.fromEntries(
        Object.entries(result.headers).filter(([name]) =>
          ['content-type', 'x-correlation-id', 'retry-after'].includes(name.toLowerCase()),
        ),
      );
      const bytes = Uint8Array.from(atob(result.body), (character) => character.charCodeAt(0));
      return new Response(result.status === 204 ? null : bytes, {
        status: result.status,
        headers: safeHeaders,
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error;
      unavailable();
      // eslint-disable-next-line preserve-caught-error -- Preserve only allowlisted codes, never a raw native error/cause.
      throw sanitizedNativeSessionError(error);
    }
  };
}
