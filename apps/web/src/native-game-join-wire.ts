import type { NativeJoinRequest } from './native-game-join-attempt.js';
export const nativeGameUuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export interface NativeJoinBody {
  expectedRevision: number;
  invitationId?: string;
  subscriptionInstanceId?: string;
  priceConsent?: { amountMinor: number; currency: 'RUB' };
}
export function readNativeJoinBody(body: string): NativeJoinBody {
  if (body.length > 2048 || body.includes('\\')) throw new Error('NATIVE_JOIN_BODY_INVALID');
  const value = JSON.parse(body) as NativeJoinBody;
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !Number.isSafeInteger(value.expectedRevision) ||
    value.expectedRevision < 0 ||
    Object.keys(value).some(
      (k) =>
        !['expectedRevision', 'invitationId', 'subscriptionInstanceId', 'priceConsent'].includes(k),
    )
  )
    throw new Error('NATIVE_JOIN_BODY_INVALID');
  if (value.invitationId !== undefined && !nativeGameUuid.test(value.invitationId))
    throw new Error('NATIVE_JOIN_BODY_INVALID');
  const paid = value.subscriptionInstanceId !== undefined;
  if (paid) {
    if (
      !nativeGameUuid.test(value.subscriptionInstanceId!) ||
      !value.priceConsent ||
      Object.keys(value.priceConsent).sort().join(',') !== 'amountMinor,currency' ||
      !Number.isSafeInteger(value.priceConsent.amountMinor) ||
      value.priceConsent.amountMinor < 0 ||
      value.priceConsent.currency !== 'RUB'
    )
      throw new Error('NATIVE_JOIN_BODY_INVALID');
  } else if (value.priceConsent !== undefined) throw new Error('NATIVE_JOIN_BODY_INVALID');
  // JSON parsers may silently keep the last duplicate. Closed wire keys must appear once, unescaped.
  const keys = [...Object.keys(value), ...(paid ? ['amountMinor', 'currency'] : [])];
  for (const key of keys)
    if ((body.match(new RegExp('"' + key + '"\\s*:', 'g')) ?? []).length !== 1)
      throw new Error('NATIVE_JOIN_BODY_INVALID');
  return value;
}
/** The app chooses a closed resource; the transport constructs the API path. */
export function nativeJoinTarget(request: NativeJoinRequest) {
  const id = encodeURIComponent(request.resourceId);
  const path =
    request.resource === 'conditions'
      ? `/games/${id}/join-conditions?${new URLSearchParams(request.query ?? {}).toString()}`
      : request.resource === 'join'
        ? `/games/${id}/join`
        : request.resource === 'paidStatus'
          ? `/games/${id}/join-operation`
          : `/game-operations/${id}${request.resource === 'reconcile' ? '/reconcile' : ''}`;
  return {
    path,
    method: request.resource === 'join' || request.resource === 'reconcile' ? 'POST' : 'GET',
  };
}
