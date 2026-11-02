import {
  ApiClientError,
  parseTournamentChatRequest,
  parseTournamentChatReadRequest,
} from '@phub/api-sdk';
const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const jsonString = '"(?:[^"\\\\\\u0000-\\u001f]|\\\\(?:["\\\\/bfnrt]|u[0-9a-fA-F]{4}))*"';
const sendEnvelope = new RegExp(
  `^\\s*\\{\\s*"requestId"\\s*:\\s*${jsonString}\\s*,\\s*"text"\\s*:\\s*${jsonString}\\s*\\}\\s*$`,
);
const readEnvelope = new RegExp(
  `^\\s*\\{\\s*"requestId"\\s*:\\s*"${uuid}"\\s*,\\s*"streamId"\\s*:\\s*"${uuid}"\\s*,\\s*"witnessHash"\\s*:\\s*"[a-f0-9]{64}"\\s*,\\s*"throughSequence"\\s*:\\s*(?:0|[1-9][0-9]*)\\s*\\}\\s*$`,
);
export interface NativeTournamentChatRequest {
  readonly resource: 'history' | 'send' | 'status' | 'position' | 'read' | 'readStatus';
  readonly resourceId: string;
  readonly requestId?: string;
  readonly query: Record<string, string>;
}
function reject(): never {
  throw new ApiClientError(
    'Native tournament chat request rejected',
    400,
    'NATIVE_REQUEST_REJECTED',
    'native',
  );
}
/** Exact six-operation envelope; neither native bridge can select another owner or tenant. */
export function tournamentChatRequest(
  value: string,
  init: RequestInit | undefined,
  config: { apiBaseUrl: string; tenantKey: string },
): NativeTournamentChatRequest | null {
  if (!value.includes('/tournaments/')) return null;
  const root = `${config.apiBaseUrl}/user/api/v1/${config.tenantKey}/tournaments/`;
  if (!value.startsWith(root)) return reject();
  const parts = value.slice(root.length).split('?');
  if (parts.length > 2) return reject();
  const match = new RegExp(
    `^(${uuid})/chat/(messages|read-position|message-requests|read-requests)(?:/(${uuid}))?$`,
  ).exec(parts[0]!);
  if (!match) return reject();
  const [, resourceId, route, original] = match;
  if (original && (route === 'messages' || route === 'read-position')) return reject();
  const resource =
    route === 'messages'
      ? 'history'
      : route === 'read-position'
        ? 'position'
        : route === 'message-requests'
          ? original
            ? 'status'
            : 'send'
          : original
            ? 'readStatus'
            : 'read';
  const write = resource === 'send' || resource === 'read';
  if ((init?.method ?? 'GET') !== (write ? 'POST' : 'GET')) return reject();
  const query: Record<string, string> = {};
  if (parts[1] !== undefined) {
    if (resource !== 'history' || !parts[1] || parts[1].length > 1840) return reject();
    for (const item of parts[1].split('&')) {
      const pair = item.split('=');
      if (pair.length !== 2 || Object.hasOwn(query, pair[0]!)) return reject();
      const [key, raw] = pair as [string, string];
      if (
        key === 'limit'
          ? !/^(?:[1-9]|[1-4][0-9]|50)$/.test(raw)
          : key !== 'cursor' || !/^[A-Za-z0-9_-]{1,1800}$/.test(raw)
      )
        return reject();
      query[key] = raw;
    }
  }
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
  let requestId = original;
  if (write) {
    if (
      parts[1] !== undefined ||
      typeof init?.body !== 'string' ||
      new TextEncoder().encode(init.body).length > 65536 ||
      headers.get('content-type') !== 'application/json' ||
      !(resource === 'send' ? sendEnvelope : readEnvelope).test(init.body)
    )
      return reject();
    try {
      requestId = (
        resource === 'send'
          ? parseTournamentChatRequest(JSON.parse(init.body))
          : parseTournamentChatReadRequest(JSON.parse(init.body))
      ).requestId;
    } catch {
      return reject();
    }
    if (headers.get('idempotency-key') !== requestId) return reject();
  } else if (
    init?.body != null ||
    headers.has('idempotency-key') ||
    (headers.has('content-type') && headers.get('content-type') !== 'application/json')
  )
    return reject();
  return { resource, resourceId: resourceId!, ...(requestId ? { requestId } : {}), query };
}
