import { ApiClientError } from '@phub/api-sdk';
export const monthlyOfferId = '862670f6-a476-4a18-aecb-9e27661fbad3';
export const monthlyUuid =
  '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const reject = (): never => {
  throw new ApiClientError('Native request rejected', 400, 'NATIVE_REQUEST_REJECTED', 'native');
};
export function monthlyRequest(
  value: string,
  init: RequestInit | undefined,
  config: { apiBaseUrl: string; tenantKey: string },
): {
  resource: 'capability' | 'quote' | 'purchase' | 'byKey' | 'reconcile' | 'launch';
  resourceId?: string;
} | null {
  const root = `${config.apiBaseUrl}/user/api/v1/${config.tenantKey}/subscription-purchase-operations`;
  if (!value.startsWith(root)) return null;
  const suffix = value.slice(root.length),
    method = init?.method ?? 'GET';
  let resource: 'capability' | 'quote' | 'purchase' | 'byKey' | 'reconcile' | 'launch',
    resourceId: string | undefined;
  if (method === 'GET' && suffix === '/capability') resource = 'capability';
  else if (method === 'GET' && suffix === '/by-key') resource = 'byKey';
  else if (method === 'POST' && suffix === '/quote') resource = 'quote';
  else if (method === 'POST' && suffix === '') resource = 'purchase';
  else {
    const m = new RegExp(`^/(${monthlyUuid})/(reconcile|payment-launch)$(?![\\s\\S])`).exec(suffix);
    if (method !== 'POST' || !m) return reject();
    resource = m[2] === 'reconcile' ? 'reconcile' : 'launch';
    resourceId = m[1];
  }
  const h = new Headers(init?.headers),
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
  for (const [k, v] of h) if (!allowed.has(k) || /[\r\n]/.test(v)) reject();
  if (!/^Bearer [A-Za-z0-9._-]{8,8192}$(?![\s\S])/.test(h.get('authorization') ?? '')) reject();
  if (
    resource === 'capability'
      ? h.has('idempotency-key')
      : !/^[A-Za-z0-9._:-]{16,128}$(?![\s\S])/.test(h.get('idempotency-key') ?? '')
  )
    reject();
  if (method === 'GET') {
    if (init?.body != null) reject();
  } else {
    const body = init?.body;
    if (typeof body !== 'string' || body.length > 1024) return reject();
    if (h.has('content-type') && h.get('content-type')?.toLowerCase() !== 'application/json')
      reject();
    // Count lexical fields before JSON parsing so duplicate/escaped names cannot disappear.
    const field =
      '"(?:offerId|expectedRevision|amountMinor|currency)"\\s*:\\s*(?:"[A-Za-z0-9:-]+"|[0-9]+)';
    const count = resource === 'quote' ? 1 : resource === 'purchase' ? 4 : 0;
    const pattern = count
      ? `^\\s*\\{\\s*${field}(?:\\s*,\\s*${field}){${count - 1}}\\s*\\}\\s*$(?![\\s\\S])`
      : '^\\s*\\{\\s*\\}\\s*$(?![\\s\\S])';
    if (!new RegExp(pattern).test(body)) reject();
    let b: Record<string, unknown>;
    try {
      b = JSON.parse(body) as Record<string, unknown>;
    } catch {
      return reject();
    }
    if (
      Object.keys(b).sort().join() !==
      (count === 1 ? 'offerId' : count === 4 ? 'amountMinor,currency,expectedRevision,offerId' : '')
    )
      reject();
    if (count && b.offerId !== monthlyOfferId) reject();
    if (
      count === 4 &&
      (!Number.isSafeInteger(b.amountMinor) ||
        Number(b.amountMinor) < 1 ||
        Number(b.amountMinor) > 100000000 ||
        b.currency !== 'RUB' ||
        typeof b.expectedRevision !== 'string' ||
        !/^sha256:[0-9a-f]{64}$(?![\s\S])/.test(b.expectedRevision))
    )
      reject();
  }
  return { resource, ...(resourceId ? { resourceId } : {}) };
}
