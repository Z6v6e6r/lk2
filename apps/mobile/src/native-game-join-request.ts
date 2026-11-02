import type { NativeJoinRequest } from '../../web/src/native-game-join-attempt.js';
import { nativeGameUuid, readNativeJoinBody } from '../../web/src/native-game-join-wire.js';
export function nativeJoinIdentity(v: NativeJoinRequest) {
  return JSON.stringify([
    v.resource,
    v.resourceId,
    v.key ?? null,
    v.body ?? null,
    Object.entries(v.query ?? {}).sort(([a], [b]) => a.localeCompare(b)),
  ]);
}
export function nativeJoinRequest(
  value: string,
  init: RequestInit | undefined,
  config: { apiBaseUrl: string; tenantKey: string },
): NativeJoinRequest | null {
  const root = `${config.apiBaseUrl}/user/api/v1/${config.tenantKey}`;
  if (
    !value.startsWith(root + '/') ||
    !/(?:\/games\/[^/]+\/join[^/]*(?:\/|\?|$)|\/game-operations\/)/.test(value)
  )
    return null;
  if (value.length > 8192 || /[%#\\]|\.\./.test(value.split('?')[0] ?? ''))
    throw new Error('NATIVE_REQUEST_REJECTED');
  const url = new URL(value),
    path = url.pathname.slice(new URL(root).pathname.length),
    headers = new Headers(init?.headers),
    method = init?.method ?? 'GET';
  const m = /^\/games\/([^/]+)\/(join|join-conditions|join-operation)$/.exec(path),
    op = /^\/game-operations\/([^/]+)(\/reconcile)?$/.exec(path);
  const id = m?.[1] ?? op?.[1] ?? '';
  if (
    !nativeGameUuid.test(id) ||
    url.origin !== config.apiBaseUrl ||
    url.username ||
    url.password ||
    url.hash
  )
    throw new Error('NATIVE_REQUEST_REJECTED');
  const resource: NativeJoinRequest['resource'] =
    m?.[2] === 'join'
      ? 'join'
      : m?.[2] === 'join-conditions'
        ? 'conditions'
        : m?.[2] === 'join-operation'
          ? 'paidStatus'
          : op?.[2]
            ? 'reconcile'
            : 'operation';
  const query = Object.fromEntries(url.searchParams),
    key = headers.get('idempotency-key');
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
  if (
    [...headers].some(([k, v]) => !allowed.has(k) || v.length > 8192 || /[\r\n]/.test(v)) ||
    !/^Bearer [A-Za-z0-9._-]{8,8192}$/.test(headers.get('authorization') ?? '')
  )
    throw new Error('NATIVE_REQUEST_REJECTED');
  if (resource === 'conditions') {
    if (
      method !== 'GET' ||
      init?.body != null ||
      key !== null ||
      [...url.searchParams].length !== 2 ||
      Object.keys(query).sort().join(',') !== 'expectedRevision,subscriptionInstanceId' ||
      !/^\d+$/.test(query.expectedRevision ?? '') ||
      !Number.isSafeInteger(Number(query.expectedRevision)) ||
      !nativeGameUuid.test(query.subscriptionInstanceId ?? '')
    )
      throw new Error('NATIVE_REQUEST_REJECTED');
    return { resource, resourceId: id, query };
  }
  if (
    url.search ||
    value.endsWith('?') ||
    !key ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/.test(key) ||
    method !== (resource === 'join' || resource === 'reconcile' ? 'POST' : 'GET')
  )
    throw new Error('NATIVE_REQUEST_REJECTED');
  if (resource === 'join') {
    if (typeof init?.body !== 'string' || headers.get('content-type') !== 'application/json')
      throw new Error('NATIVE_REQUEST_REJECTED');
    readNativeJoinBody(init.body);
    return { resource, resourceId: id, key, body: init.body };
  }
  if (
    init?.body != null ||
    headers.has('content-type') ||
    (resource === 'reconcile' && key !== `join-reconcile:${id}`)
  )
    throw new Error('NATIVE_REQUEST_REJECTED');
  return { resource, resourceId: id, key };
}
