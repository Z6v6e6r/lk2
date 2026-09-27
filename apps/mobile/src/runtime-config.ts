// Existing staging origin. Adding a native API target requires review; builds have no default target.
export const ANDROID_API_ORIGINS = ['https://lk.nano.padlhub.su'] as const;

export interface MobileRuntimeConfig {
  readonly apiBaseUrl: string;
  readonly tenantKey: string;
  readonly appVersion: string;
}

export function resolveMobileRuntimeConfig(input: {
  readonly native: boolean;
  readonly origin: string;
  readonly apiBaseUrl?: string;
  readonly tenantKey?: string;
  readonly appVersion?: string;
}): MobileRuntimeConfig {
  if (input.native && (!input.apiBaseUrl?.trim() || !input.tenantKey?.trim())) {
    throw new Error('MOBILE_API_NOT_CONFIGURED');
  }
  const url = new URL(input.apiBaseUrl?.trim() || input.origin);
  if (
    (input.native && !ANDROID_API_ORIGINS.some((origin) => url.origin === origin)) ||
    !['https:', 'http:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/' ||
    (input.native && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
  ) {
    throw new Error('MOBILE_API_ORIGIN_INVALID');
  }
  const tenantKey = input.tenantKey?.trim() || 'local-padel';
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(tenantKey)) {
    throw new Error('MOBILE_TENANT_INVALID');
  }
  return { apiBaseUrl: url.origin, tenantKey, appVersion: input.appVersion || 'development' };
}
