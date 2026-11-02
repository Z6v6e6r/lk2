import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { MONTHLY_FRIENDSHIP_OFFER_ID, type SubscriptionPurchaseConsent } from '@phub/api-contracts';
export const mpVersion = 'monthly-friendship.v1' as const;
export const mpOfferId = MONTHLY_FRIENDSHIP_OFFER_ID;
export type MonthlyMode = 'quote' | 'purchase' | 'read' | 'reconcile';
export const mpPath = (mode: MonthlyMode) => '/lk/integrations/v1/monthly-friendship/' + mode;
export class MonthlyPurchaseError extends Error {
  constructor(
    public readonly code = 'SUBSCRIPTION_PURCHASE_UNAVAILABLE',
    public readonly status = 503,
  ) {
    super(code);
  }
}
export const mpBad = (): never => {
  throw new MonthlyPurchaseError('SUBSCRIPTION_PURCHASE_EVIDENCE_INVALID');
};
export const mpExact = (v: unknown, keys: string): Record<string, unknown> => {
  if (
    !v ||
    typeof v !== 'object' ||
    Array.isArray(v) ||
    Object.keys(v).sort().join() !== keys.split(',').sort().join()
  )
    return mpBad();
  return v as Record<string, unknown>;
};
export const mpUuid = (v: unknown): v is string =>
  typeof v === 'string' &&
  v.length === 36 &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$(?![\s\S])/.test(v);
export const mpId = (v: unknown): v is string =>
  typeof v === 'string' &&
  !/[\r\n]/.test(v) &&
  /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$(?![\s\S])/.test(v);
export const mpDigest = (v: unknown): v is string =>
  typeof v === 'string' && v.length === 71 && /^sha256:[a-f0-9]{64}$(?![\s\S])/.test(v);
export const mpIso = (v: unknown): v is string =>
  typeof v === 'string' &&
  v.length === 24 &&
  Number.isFinite(Date.parse(v)) &&
  new Date(v).toISOString() === v;
export function mpStable(x: unknown): string {
  const sort = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(sort)
      : v && typeof v === 'object'
        ? Object.fromEntries(
            Object.entries(v)
              .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
              .map(([k, val]) => [k, sort(val)]),
          )
        : v;
  return JSON.stringify(sort(x));
}
export const mpHash = (x: string) => 'sha256:' + createHash('sha256').update(x).digest('hex');
export function mpOperationId(tenantId: string, userId: string, keyHash: string) {
  if (!mpUuid(tenantId) || !mpUuid(userId) || !mpDigest(keyHash)) return mpBad();
  const h = mpHash('monthly-friendship-operation:v1\0' + tenantId + '\0' + userId + '\0' + keyHash)
    .slice(7, 39)
    .split('');
  h[12] = '8';
  h[16] = ((parseInt(h[16]!, 16) & 3) | 8).toString(16);
  const s = h.join('');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}
export function parsePurchaseConsent(v: unknown): SubscriptionPurchaseConsent {
  const r = mpExact(v, 'offerId,expectedRevision,amountMinor,currency');
  if (
    r.offerId !== mpOfferId ||
    !mpDigest(r.expectedRevision) ||
    !Number.isSafeInteger(r.amountMinor) ||
    Number(r.amountMinor) <= 0 ||
    r.currency !== 'RUB'
  )
    return mpBad();
  return {
    offerId: mpOfferId,
    expectedRevision: r.expectedRevision,
    amountMinor: Number(r.amountMinor),
    currency: 'RUB',
  };
}
export type MonthlyBody =
  | { contract: typeof mpVersion; offerId: string }
  | (SubscriptionPurchaseConsent & { contract: typeof mpVersion });
export function mpBody(mode: MonthlyMode, consent?: SubscriptionPurchaseConsent): MonthlyBody {
  return mode === 'purchase'
    ? { contract: mpVersion, ...parsePurchaseConsent(consent) }
    : { contract: mpVersion, offerId: mpOfferId };
}
export const mpRequestHash = (mode: MonthlyMode, body: MonthlyBody) =>
  mpHash(mpVersion + '\0' + mode + '\0' + mpStable(body));
export interface MonthlyOwnerQuote {
  contract: typeof mpVersion;
  offerId: string;
  revision: string;
  amountMinor: number;
  currency: 'RUB';
  inventoryId: string;
  productId: string;
  operationId: string;
}
export function parseMonthlyOwnerQuote(v: unknown, operationId: string): MonthlyOwnerQuote {
  const q = mpExact(
    v,
    'contract,offerId,revision,amountMinor,currency,inventoryId,productId,operationId',
  );
  if (
    q.contract !== mpVersion ||
    q.offerId !== mpOfferId ||
    !mpDigest(q.revision) ||
    !mpUuid(q.operationId) ||
    q.operationId !== operationId ||
    !mpId(q.inventoryId) ||
    !mpId(q.productId) ||
    !Number.isSafeInteger(q.amountMinor) ||
    Number(q.amountMinor) <= 0 ||
    q.currency !== 'RUB'
  )
    return mpBad();
  return {
    contract: mpVersion,
    offerId: mpOfferId,
    revision: q.revision,
    amountMinor: Number(q.amountMinor),
    currency: 'RUB',
    inventoryId: q.inventoryId,
    productId: q.productId,
    operationId: q.operationId,
  };
}
/** Bank handoff is navigation only. Reject local/IP/userinfo targets; no network probe. */
export function mpPaymentUrl(v: unknown): v is string {
  if (
    typeof v !== 'string' ||
    v.length > 2048 ||
    /[\s\\]/.test(v) ||
    Array.from(v).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
  )
    return false;
  try {
    const u = new URL(v),
      h = u.hostname.toLowerCase();
    return (
      u.protocol === 'https:' &&
      !u.username &&
      !u.password &&
      (!u.port || u.port === '443') &&
      !u.hash &&
      h.includes('.') &&
      !h.endsWith('.') &&
      !isIP(h.replace(/^\[|\]$(?![\s\S])/g, '')) &&
      !['localhost', 'local', 'internal', 'lan', 'home', 'test', 'invalid'].some(
        (s) => h === s || h.endsWith('.' + s),
      )
    );
  } catch {
    return false;
  }
}
export interface MonthlyOwnerReceipt {
  contract: typeof mpVersion;
  operationId: string;
  offerId: string;
  state: 'PROVIDER_UNKNOWN' | 'PAYMENT_PENDING' | 'PAID';
  amountMinor: number;
  currency: 'RUB';
  paymentUrl: string | null;
  paymentExpiresAt: string | null;
  providerTransactionId: string | null;
  providerSubscriptionId: string | null;
}
export function parseMonthlyOwnerReceipt(v: unknown, q: MonthlyOwnerQuote): MonthlyOwnerReceipt {
  const r = mpExact(
    v,
    'contract,operationId,offerId,state,amountMinor,currency,paymentUrl,paymentExpiresAt,providerTransactionId,providerSubscriptionId',
  );
  if (
    r.contract !== mpVersion ||
    r.operationId !== q.operationId ||
    r.offerId !== mpOfferId ||
    r.amountMinor !== q.amountMinor ||
    r.currency !== 'RUB' ||
    !['PROVIDER_UNKNOWN', 'PAYMENT_PENDING', 'PAID'].includes(String(r.state)) ||
    (r.providerTransactionId !== null && !mpId(r.providerTransactionId)) ||
    (r.providerSubscriptionId !== null && !mpId(r.providerSubscriptionId)) ||
    (r.paymentUrl !== null && !mpPaymentUrl(r.paymentUrl)) ||
    (r.paymentExpiresAt !== null && !mpIso(r.paymentExpiresAt)) ||
    (r.paymentUrl !== null && r.paymentExpiresAt === null) ||
    (r.state === 'PAID'
      ? !mpId(r.providerTransactionId) || !mpId(r.providerSubscriptionId) || r.paymentUrl !== null
      : r.providerSubscriptionId !== null) ||
    (r.state === 'PAYMENT_PENDING' &&
      (!mpId(r.providerTransactionId) || !mpIso(r.paymentExpiresAt))) ||
    (r.state === 'PROVIDER_UNKNOWN' && r.paymentUrl !== null)
  )
    return mpBad();
  return r as unknown as MonthlyOwnerReceipt;
}
