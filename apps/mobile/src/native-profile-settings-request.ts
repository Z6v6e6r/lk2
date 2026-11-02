import { ApiClientError } from '@phub/api-sdk';
import {
  readProfileSettingsBody,
  type NativeProfileSettingsRequest,
} from '../../web/src/native-profile-settings.js';
export function nativeProfileSettingsRequest(
  value: string,
  init: RequestInit | undefined,
  config: { apiBaseUrl: string; tenantKey: string },
): NativeProfileSettingsRequest | null {
  const root = `${config.apiBaseUrl}/user/api/v1/${config.tenantKey}/profile/`;
  if (
    !value.startsWith(root) ||
    !/^.*\/(privacy|booking-preferences)/.test(value) ||
    (init?.method ?? 'GET') === 'GET'
  )
    return null;
  const fail = () => {
    throw new ApiClientError('NATIVE_REQUEST_REJECTED', 403, 'NATIVE_REQUEST_REJECTED', 'native');
  };
  const suffix = value.slice(root.length),
    resource =
      suffix === 'privacy' ? 'privacy' : suffix === 'booking-preferences' ? 'preferences' : null;
  if (!resource || init?.method !== 'PUT' || typeof init.body !== 'string') return fail();
  const headers = new Headers(init.headers),
    allowed = new Set([
      'authorization',
      'accept',
      'content-type',
      'idempotency-key',
      'x-correlation-id',
      'x-app-platform',
      'x-app-version',
      'x-app-build',
    ]);
  if (
    [...headers].some(([k, v]) => !allowed.has(k) || v.length > 8192 || /[\r\n]/.test(v)) ||
    !/^Bearer [A-Za-z0-9._-]{8,8192}$/.test(headers.get('authorization') ?? '') ||
    headers.get('content-type') !== 'application/json'
  )
    fail();
  const key = headers.get('idempotency-key') ?? '';
  if (!new RegExp(`^profile-settings:${resource}:[0-9a-f]{64}$`).test(key)) fail();
  try {
    readProfileSettingsBody(resource, init.body);
  } catch {
    return fail();
  }
  return { resource, body: init.body, key };
}
