import { ApiClientError, validateStationReadRequest } from '@phub/api-sdk';
const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const id = new RegExp(`^${uuid}$`);
export interface NativeStationStreamRequest {
  readonly resource: 'summaries' | 'stream' | 'read' | 'readStatus';
  readonly resourceId?: string;
  readonly requestId?: string;
  readonly query: Record<string, string>;
}
function reject(): never {
  throw new ApiClientError(
    'Native stream request rejected',
    400,
    'NATIVE_REQUEST_REJECTED',
    'native',
  );
}
export function stationStreamRequest(
  value: string,
  init: RequestInit | undefined,
  config: { apiBaseUrl: string; tenantKey: string },
): NativeStationStreamRequest | null {
  if (
    !value.includes('/community-views/') ||
    !/\/(?:station-stream(?:-summaries)?|read-requests)(?:\/|$)/.test(value.split('?')[0] ?? '')
  )
    return null;
  const root = `${config.apiBaseUrl}/user/api/v1/${config.tenantKey}/community-views/`;
  if (!value.startsWith(root)) return reject();
  const parts = value.slice(root.length).split('?');
  if (parts.length > 2) return reject();
  const path = parts[0]!;
  const match = new RegExp(`^(${uuid})/(station-stream|read-requests(?:/(${uuid}))?)$`).exec(path);
  const resource =
    path === 'station-stream-summaries'
      ? 'summaries'
      : match?.[2] === 'station-stream'
        ? 'stream'
        : match?.[3]
          ? 'readStatus'
          : match
            ? 'read'
            : null;
  if (!resource || (init?.method ?? 'GET') !== (resource === 'read' ? 'POST' : 'GET'))
    return reject();
  const query: Record<string, string> = {};
  if (parts[1] !== undefined) {
    if (!parts[1] || parts[1].length > 1960) return reject();
    for (const part of parts[1].split('&')) {
      const pair = part.split('=');
      if (pair.length !== 2 || Object.hasOwn(query, pair[0]!)) return reject();
      const [key, raw] = pair as [string, string];
      if (resource === 'summaries' && key === 'communityIds') {
        if (!new RegExp(`^${uuid}(?:(?:%2C|,)${uuid}){0,49}$`).test(raw)) return reject();
        const ids = raw.split(/%2C|,/);
        if (new Set(ids).size !== ids.length) return reject();
        query[key] = ids.join(',');
      } else if (
        resource === 'stream' &&
        (key === 'limit'
          ? /^(?:[1-9]|[1-4][0-9]|50)$/.test(raw)
          : key === 'cursor' && /^[A-Za-z0-9_-]{16,1024}$/.test(raw))
      )
        query[key] = raw;
      else return reject();
    }
  }
  if (resource === 'summaries' && !query.communityIds) return reject();
  const headers = new Headers(init?.headers);
  const allowed = new Set([
    'authorization',
    'accept',
    'content-type',
    'idempotency-key',
    'x-correlation-id',
    'x-app-platform',
    'x-app-version',
    'x-app-build',
  ]);
  for (const [name, header] of headers)
    if (!allowed.has(name) || header.length > 8192 || /[\r\n]/.test(header)) return reject();
  if (!/^Bearer [A-Za-z0-9._-]{8,8192}$/.test(headers.get('authorization') ?? '')) return reject();
  let requestId = match?.[3];
  if (resource === 'read') {
    if (
      parts[1] !== undefined ||
      typeof init?.body !== 'string' ||
      new TextEncoder().encode(init.body).length > 16384 ||
      headers.get('content-type') !== 'application/json'
    )
      return reject();
    // Canonical SDK order and decimal integer spelling also reject duplicate JSON fields.
    const envelope = new RegExp(
      `^\\s*\\{\\s*"requestId"\\s*:\\s*"(${uuid})"\\s*,\\s*"streamId"\\s*:\\s*"${uuid}"\\s*,\\s*"membershipEpoch"\\s*:\\s*(?:0|[1-9][0-9]*)\\s*,\\s*"throughSequence"\\s*:\\s*(?:0|[1-9][0-9]*)\\s*\\}\\s*$`,
    );
    if (!envelope.test(init.body)) return reject();
    try {
      requestId = validateStationReadRequest(JSON.parse(init.body)).requestId;
    } catch {
      return reject();
    }
    if (!requestId || !id.test(requestId) || headers.get('idempotency-key') !== requestId)
      return reject();
  } else if (
    init?.body != null ||
    headers.has('idempotency-key') ||
    (headers.has('content-type') && headers.get('content-type') !== 'application/json')
  )
    return reject();
  return {
    resource,
    ...(match ? { resourceId: match[1]! } : {}),
    ...(requestId ? { requestId } : {}),
    query,
  };
}
