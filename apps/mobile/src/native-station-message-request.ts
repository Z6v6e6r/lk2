import { ApiClientError } from '@phub/api-sdk';

const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const jsonString = '"(?:[^"\\\\\\u0000-\\u001f]|\\\\(?:["\\\\/bfnrt]|u[0-9a-fA-F]{4}))*"';
const envelope = new RegExp(
  `^\\s*\\{\\s*"requestId"\\s*:\\s*${jsonString}\\s*,\\s*"text"\\s*:\\s*${jsonString}\\s*\\}\\s*$`,
);
export interface NativeStationRequest {
  readonly resource: 'history' | 'send' | 'status';
  readonly resourceId: string;
  readonly requestId?: string;
  readonly query: Record<string, string>;
}
function reject(): never {
  throw new ApiClientError(
    'Native station request rejected',
    400,
    'NATIVE_REQUEST_REJECTED',
    'native',
  );
}
/** A bounded SDK envelope, independently validated again by Java/Swift. No caller-selected origin. */
export function stationRequest(
  value: string,
  init: RequestInit | undefined,
  config: { apiBaseUrl: string; tenantKey: string },
): NativeStationRequest | null {
  const root = `${config.apiBaseUrl}/user/api/v1/${config.tenantKey}`;
  if (!value.includes('/community-views/')) return null;
  const match = new RegExp(
    `^${root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/community-views/(${uuid})/(chat|message-requests(?:/(${uuid}))?)(?:\\?([^#]*))?$`,
  ).exec(value);
  if (!match || match[0] !== value) return reject();
  const method = init?.method ?? 'GET';
  const resource = match[2] === 'chat' ? 'history' : match[3] ? 'status' : 'send';
  if (method !== (resource === 'send' ? 'POST' : 'GET')) return reject();
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
  const query: Record<string, string> = {};
  if (match[4] !== undefined) {
    if (resource !== 'history' || !match[4]) return reject();
    for (const part of match[4].split('&')) {
      const pair = part.split('=');
      if (pair.length !== 2 || Object.hasOwn(query, pair[0]!)) return reject();
      const [key, entry] = pair as [string, string];
      if (
        key === 'limit'
          ? !/^(?:[1-9]|[1-4][0-9]|50)$/.test(entry)
          : key !== 'cursor' || !/^[A-Za-z0-9_-]{16,512}$/.test(entry)
      )
        return reject();
      query[key] = entry;
    }
  }
  if (resource === 'send') {
    if (
      typeof init?.body !== 'string' ||
      new TextEncoder().encode(init.body).length > 65_536 ||
      !envelope.test(init.body) ||
      headers.get('content-type') !== 'application/json'
    )
      return reject();
    const body = JSON.parse(init.body) as { requestId: unknown; text: unknown };
    if (
      typeof body.requestId !== 'string' ||
      !new RegExp(`^${uuid}$`).test(body.requestId) ||
      headers.get('idempotency-key') !== body.requestId ||
      typeof body.text !== 'string' ||
      body.text.length > 8000 ||
      !body.text.trim()
    )
      return reject();
    return { resource, resourceId: match[1]!, requestId: body.requestId, query };
  }
  if (
    init?.body != null ||
    headers.has('idempotency-key') ||
    (headers.has('content-type') && headers.get('content-type') !== 'application/json')
  )
    return reject();
  return { resource, resourceId: match[1]!, ...(match[3] ? { requestId: match[3] } : {}), query };
}
