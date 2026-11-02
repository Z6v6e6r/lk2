export interface NativeSelfLeaveRequest {
  resource: 'leave' | 'status' | 'reconcile';
  resourceId: string;
}
/** Closed original-key self operation; no arbitrary member, body, query or provider selector. */
export function selfLeaveRequest(
  value: string,
  init: RequestInit | undefined,
  config: { apiBaseUrl: string; tenantKey: string },
): NativeSelfLeaveRequest | null {
  const root = `${config.apiBaseUrl}/user/api/v1/${config.tenantKey}/games/`;
  if (!value.startsWith(root) || !/\/(?:participants|leave-operation)(?:\/|\?|$)/.test(value))
    return null;
  const match =
    /^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/(participants\/me|leave-operation(?:\/reconcile)?)$/.exec(
      value.slice(root.length),
    );
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
  const resource =
    match?.[2] === 'participants/me'
      ? 'leave'
      : match?.[2] === 'leave-operation'
        ? 'status'
        : 'reconcile';
  if (
    !match ||
    match[0] !== value.slice(root.length) ||
    init?.body != null ||
    (init?.method ?? 'GET') !==
      ({ leave: 'DELETE', status: 'GET', reconcile: 'POST' } as const)[resource] ||
    [...headers].some(([name, v]) => !allowed.has(name) || v.length > 8192 || /[\r\n]/.test(v)) ||
    !/^Bearer [A-Za-z0-9._-]{8,8192}$/.test(headers.get('authorization') ?? '') ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/.test(headers.get('idempotency-key') ?? '') ||
    (headers.has('content-type') && headers.get('content-type') !== 'text/plain')
  )
    throw new Error('NATIVE_REQUEST_REJECTED');
  return { resource, resourceId: match[1]! };
}
export const selfLeaveRequestKey = (request: NativeSelfLeaveRequest, key: string) =>
  JSON.stringify([request.resource, request.resourceId, key]);
