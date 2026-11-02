import { ApiClientError } from '@phub/api-sdk';
import type { MobileRuntimeConfig } from './runtime-config.js';
const uuid =
  '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}';
const key = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/;
function deny(): never {
  throw new ApiClientError('Запрос недоступен.', 403, 'NATIVE_REQUEST_REJECTED', 'native');
}
function date(v: string | undefined): number {
  if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(v)) deny();
  const n = Date.parse(v + 'T00:00:00Z');
  if (!Number.isFinite(n) || new Date(n).toISOString().slice(0, 10) !== v) deny();
  return n;
}
/** Only this concrete first-party tournament surface. Not a generic public transport. */
export function nativeTournamentRequest(
  value: string,
  method: string,
  body: unknown,
  headers: Record<string, string>,
  config: MobileRuntimeConfig,
): 'PUBLIC' | 'USER' | null {
  const publicRoot = `${config.apiBaseUrl}/public/api/v1/${config.tenantKey}/tournaments`,
    userRoot = `${config.apiBaseUrl}/user/api/v1/${config.tenantKey}/tournaments`;
  const isPublic = value.startsWith(publicRoot),
    isUser = value.startsWith(userRoot);
  if (!isPublic && !isUser) return null;
  if (value.endsWith('?') || /[%#\\\s]|\.\./.test(value)) deny();
  const url = new URL(value),
    base = isPublic ? publicRoot : userRoot,
    path = url.href.split('?')[0]!.slice(base.length),
    seen = new Map<string, string>();
  for (const [k, v] of url.searchParams) {
    if (seen.has(k) || !v) deny();
    seen.set(k, v);
  }
  const allowed = new Set([
    'accept',
    'content-type',
    'authorization',
    'idempotency-key',
    'x-correlation-id',
    'x-app-platform',
    'x-app-version',
    'x-app-build',
  ]);
  for (const [name, v] of Object.entries(headers))
    if (!allowed.has(name) || v.length > 8192 || /[\r\n]/.test(v)) deny();
  if (isPublic) {
    if (
      method !== 'GET' ||
      body != null ||
      headers.authorization !== undefined ||
      headers['idempotency-key'] !== undefined ||
      !(path === '' || new RegExp(`^/${uuid}$`).test(path))
    )
      deny();
    for (const k of seen.keys())
      if (
        !(
          path === '' ? ['dateFrom', 'dateTo', 'availability', 'limit'] : ['dateFrom', 'dateTo']
        ).includes(k)
      )
        deny();
    const delta = date(seen.get('dateTo')) - date(seen.get('dateFrom'));
    if (delta <= 0 || delta > 15 * 86400000) deny();
    if (
      seen.has('availability') &&
      !['JOINABLE', 'INCLUDE_FULL'].includes(seen.get('availability')!)
    )
      deny();
    if (seen.has('limit') && !/^(?:[1-9]|[1-4][0-9]|50)$/.test(seen.get('limit')!)) deny();
    return 'PUBLIC';
  }
  if (!/^Bearer [A-Za-z0-9._-]{8,8192}$/.test(headers.authorization ?? '')) deny();
  if (
    method === 'GET' &&
    new RegExp(`^/${uuid}/(?:participants|registration-operation)$`).test(path)
  ) {
    if (body != null) deny();
    if (path.endsWith('/participants') && seen.size) deny();
    for (const [k, v] of seen) if (k !== 'operationId' || !new RegExp(`^${uuid}$`).test(v)) deny();
    if (headers['idempotency-key'] !== undefined && !key.test(headers['idempotency-key'])) deny();
    return 'USER';
  }
  if (method !== 'POST' || seen.size || !key.test(headers['idempotency-key'] ?? '')) deny();
  if (new RegExp(`^/${uuid}/registration-operations/${uuid}/retry$`).test(path)) {
    if (body != null) deny();
    return 'USER';
  }
  if (
    !new RegExp(`^/${uuid}/registrations$`).test(path) ||
    typeof body !== 'string' ||
    body.length > 256
  )
    deny();
  const a = '"action"\\s*:\\s*"LEAVE"',
    o = `"originalJoinOperationId"\\s*:\\s*"${uuid}"`;
  if (
    !new RegExp(
      `^\\s*\\{\\s*(?:"action"\\s*:\\s*"JOIN"|${a}\\s*,\\s*${o}|${o}\\s*,\\s*${a})\\s*\\}\\s*$`,
    ).test(body)
  )
    deny();
  return 'USER';
}
