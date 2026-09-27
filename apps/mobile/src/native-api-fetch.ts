import { registerPlugin } from '@capacitor/core';
import { ApiClientError } from '@phub/api-sdk';
import type { MobileRuntimeConfig } from './runtime-config.js';

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
  }>;
}

export const androidSessionPlugin = registerPlugin<AndroidSessionPlugin>('PadlHubAndroidSession');

function rejected(): ApiClientError {
  return new ApiClientError('Запрос недоступен.', 403, 'NATIVE_REQUEST_REJECTED', 'native');
}

/** Native HTTPS + Keystore custody; there is deliberately no browser-fetch fallback. */
export function createNativeApiFetch(
  config: MobileRuntimeConfig,
  plugin: AndroidSessionPlugin = androidSessionPlugin,
  onSessionExpired?: () => void,
): typeof fetch {
  let active = false;
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
    if (method === 'DELETE' && url.pathname.endsWith('/auth/session')) active = false;
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
        onSessionExpired?.();
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
      const code =
        typeof error === 'object' && error !== null && 'code' in error ? error.code : null;
      if (code === 'NATIVE_NETWORK_UNAVAILABLE') {
        // eslint-disable-next-line preserve-caught-error -- Native errors may contain credentials; expose only a fixed retryable class.
        throw new TypeError('Native network unavailable');
      }
      throw new ApiClientError(
        'Не удалось подключиться. Повторите попытку.',
        503,
        'NATIVE_SESSION_UNAVAILABLE',
        'native',
      );
    }
  };
}
