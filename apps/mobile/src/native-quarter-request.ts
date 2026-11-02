import { ApiClientError } from '@phub/api-sdk';
const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const reject = (): never => {
  throw new ApiClientError('Native request rejected', 400, 'NATIVE_REQUEST_REJECTED', 'native');
};
export function quarterRequest(
  value: string,
  init: RequestInit | undefined,
  config: { apiBaseUrl: string; tenantKey: string },
): {
  resource: 'capability' | 'locations' | 'byKey' | 'create' | 'reconcile';
  resourceId?: string;
} | null {
  const root = `${config.apiBaseUrl}/user/api/v1/${config.tenantKey}/game-create-operations`;
  if (!value.startsWith(root)) return null;
  const method = init?.method ?? 'GET';
  const suffix = value.slice(root.length);
  let resource: 'capability' | 'locations' | 'byKey' | 'create' | 'reconcile';
  let resourceId: string | undefined;
  if (method === 'GET' && suffix === '/capability') resource = 'capability';
  else if (method === 'GET' && suffix === '/locations') resource = 'locations';
  else if (method === 'GET' && suffix === '/by-key') resource = 'byKey';
  else if (method === 'POST' && suffix === '') resource = 'create';
  else {
    const m = new RegExp(`^/(${uuid})/reconcile$`).exec(suffix);
    if (method !== 'POST' || !m || /[\r\n]/.test(suffix)) return reject();
    resource = 'reconcile';
    resourceId = m[1];
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
  for (const [name, v] of headers) if (!allowed.has(name) || /[\r\n]/.test(v)) reject();
  if (!/^Bearer [A-Za-z0-9._-]{8,8192}$/.test(headers.get('authorization') ?? '')) reject();
  const keyed = method === 'POST' || resource === 'byKey';
  if (
    keyed
      ? !/^[A-Za-z0-9._:-]{16,128}$/.test(headers.get('idempotency-key') ?? '')
      : headers.has('idempotency-key')
  )
    reject();
  if (method === 'GET') {
    if (init?.body != null) reject();
  } else {
    const body = init?.body;
    if (typeof body !== 'string' || body.length > 1024) return reject();
    // Only four unescaped string properties; duplicates cannot disappear through JSON.parse.
    const property =
      '"(?:stationId|courtId|startsAt|subscriptionId)"\\s*:\\s*"[^"\\\\\\u0000-\\u001f]*"';
    if (!new RegExp(`^\\s*\\{\\s*${property}(?:\\s*,\\s*${property}){3}\\s*\\}\\s*$`).test(body))
      reject();
    let x: Record<string, unknown>;
    try {
      x = JSON.parse(body) as Record<string, unknown>;
    } catch {
      return reject();
    }
    if (
      Object.keys(x).sort().join() !== 'courtId,startsAt,stationId,subscriptionId' ||
      ![x.stationId, x.courtId, x.subscriptionId].every(
        (v) => typeof v === 'string' && new RegExp(`^${uuid}$`).test(v),
      )
    )
      reject();
    const date = x.startsAt;
    if (
      typeof date !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\.000Z$/.test(date) ||
      !Number.isFinite(Date.parse(date)) ||
      new Date(date).toISOString() !== date ||
      date.startsWith('0000')
    )
      reject();
    const content = headers.get('content-type');
    if (content && content.toLowerCase() !== 'application/json') reject();
  }
  return { resource, ...(resourceId ? { resourceId } : {}) };
}
