import { ApiClientError } from '@phub/api-sdk';
import type { MobileRuntimeConfig } from './runtime-config.js';

/** Bearer-only native session: never store or send browser refresh cookies. */
export function createNativeApiFetch(
  config: MobileRuntimeConfig,
  transport: typeof fetch = (input, init) => globalThis.fetch(input, init),
): typeof fetch {
  return async (input, init) => {
    const requestUrl =
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(requestUrl);
    const roots = [
      `/user/api/v1/${config.tenantKey}/`,
      `/user/api/v2/${config.tenantKey}/`,
      `/public/api/v1/${config.tenantKey}/`,
      '/public/api/v1/media/',
    ];
    if (
      url.origin !== config.apiBaseUrl ||
      url.username ||
      url.password ||
      !roots.some((root) => url.pathname.startsWith(root))
    ) {
      throw new ApiClientError(
        'Адрес сервиса недоступен.',
        403,
        'NATIVE_ORIGIN_REJECTED',
        'native',
      );
    }
    if (url.pathname.endsWith('/auth/session/refresh')) {
      throw new ApiClientError('Войдите заново.', 401, 'AUTH_SESSION_REVOKED', 'native');
    }
    if (
      url.pathname.includes('/auth/viva') ||
      url.pathname.includes('-read-jobs') ||
      url.pathname.includes('/notification-endpoints/web')
    ) {
      throw new ApiClientError(
        'Этот способ подключения пока недоступен.',
        409,
        'NATIVE_FLOW_UNAVAILABLE',
        'native',
      );
    }
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const timeout = AbortSignal.timeout(15_000);
    const response = await transport(input, {
      ...init,
      credentials: 'omit',
      redirect: 'error',
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    return response;
  };
}
