import type {
  PadlHubApiClient,
  SubscriptionPurchaseConsent,
  SubscriptionPurchaseQuote,
  SubscriptionPurchaseResult,
  SubscriptionPaymentLaunch,
} from '@phub/api-sdk';
export const monthlyOffer = '862670f6-a476-4a18-aecb-9e27661fbad3';
export interface MonthlyPurchaseGateway extends Pick<
  PadlHubApiClient,
  | 'getSubscriptionPurchaseCapability'
  | 'quoteSubscriptionPurchase'
  | 'purchaseSubscription'
  | 'getSubscriptionPurchase'
  | 'reconcileSubscriptionPurchase'
  | 'launchSubscriptionPayment'
> {
  monthlyPurchasePrincipal: () => string | null;
  openSubscriptionPayment: (input: { operationId: string; launchCode: string }) => Promise<void>;
}
export interface MonthlyPrincipal {
  tenantId: string;
  userId: string;
}
export interface MonthlyCustody extends MonthlyPrincipal {
  version: 1;
  key: string;
  submitted: boolean;
  quote: SubscriptionPurchaseQuote | null;
}
export const monthlyStorageKey = (p: MonthlyPrincipal) =>
  'phub.monthly-purchase.v1:' + p.tenantId + ':' + p.userId;
const fail = (): never => {
  throw new Error('MONTHLY_PURCHASE_INVALID');
};
const uuid = (v: unknown): v is string =>
  typeof v === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$(?![\s\S])/.test(v);
const digest = (v: unknown): v is string =>
  typeof v === 'string' && /^sha256:[0-9a-f]{64}$(?![\s\S])/.test(v);
function exact(v: unknown, keys: string): Record<string, unknown> {
  if (
    !v ||
    typeof v !== 'object' ||
    Array.isArray(v) ||
    Object.keys(v).sort().join() !== keys.split(',').sort().join()
  )
    return fail();
  return v as Record<string, unknown>;
}
const date = (v: unknown): v is string =>
  typeof v === 'string' && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
export function monthlyQuote(v: unknown): SubscriptionPurchaseQuote {
  const q = exact(
    v,
    'contractVersion,operationId,keySha256,offerId,title,revision,amountMinor,currency,expiresAt',
  );
  if (
    q.contractVersion !== 1 ||
    !uuid(q.operationId) ||
    !digest(q.keySha256) ||
    q.offerId !== monthlyOffer ||
    q.title !== 'Абонемент «Дружба»' ||
    !digest(q.revision) ||
    !Number.isSafeInteger(q.amountMinor) ||
    Number(q.amountMinor) <= 0 ||
    q.currency !== 'RUB' ||
    !date(q.expiresAt)
  )
    return fail();
  return q as unknown as SubscriptionPurchaseQuote;
}
export function loadMonthlyCustody(storage: Storage, p: MonthlyPrincipal): MonthlyCustody | null {
  const raw = storage.getItem(monthlyStorageKey(p));
  if (raw === null) return null;
  const c = exact(JSON.parse(raw), 'version,tenantId,userId,key,submitted,quote');
  if (
    c.version !== 1 ||
    c.tenantId !== p.tenantId ||
    c.userId !== p.userId ||
    !uuid(c.tenantId) ||
    !uuid(c.userId) ||
    typeof c.key !== 'string' ||
    !/^monthly:[0-9a-f-]{36}$(?![\s\S])/.test(c.key) ||
    !uuid(c.key.slice(8)) ||
    typeof c.submitted !== 'boolean' ||
    (c.submitted && c.quote === null)
  )
    return fail();
  return {
    version: 1,
    ...p,
    key: c.key,
    submitted: c.submitted,
    quote: c.quote === null ? null : monthlyQuote(c.quote),
  };
}
export function saveMonthlyCustody(storage: Storage, c: MonthlyCustody): void {
  const value = JSON.stringify(c);
  storage.setItem(monthlyStorageKey(c), value);
  if (JSON.stringify(loadMonthlyCustody(storage, c)) !== value) fail();
}
async function sha(v: string) {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(v))),
  )
    .map((x) => x.toString(16).padStart(2, '0'))
    .join('');
}
export async function monthlyIdentity(c: Pick<MonthlyCustody, 'key' | 'tenantId' | 'userId'>) {
  const keySha256 = 'sha256:' + (await sha(c.key)),
    h = (
      await sha(
        'monthly-friendship-operation:v1\0' + c.tenantId + '\0' + c.userId + '\0' + keySha256,
      )
    )
      .slice(0, 32)
      .split('');
  h[12] = '8';
  h[16] = ((parseInt(h[16]!, 16) & 3) | 8).toString(16);
  const s = h.join('');
  return {
    keySha256,
    operationId: `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`,
  };
}
export async function validateMonthlyQuote(v: unknown, c: MonthlyCustody) {
  const q = monthlyQuote(v),
    expected = await monthlyIdentity(c);
  if (q.operationId !== expected.operationId || q.keySha256 !== expected.keySha256) return fail();
  return q;
}
export async function validateMonthlyResult(
  v: unknown,
  c: MonthlyCustody,
): Promise<SubscriptionPurchaseResult> {
  const r = exact(
      v,
      'contractVersion,operationId,keySha256,offerId,status,amountMinor,currency,canOpenPayment,paymentExpiresAt',
    ),
    expected = await monthlyIdentity(c);
  if (
    r.contractVersion !== 1 ||
    r.operationId !== expected.operationId ||
    r.keySha256 !== expected.keySha256 ||
    r.offerId !== monthlyOffer ||
    r.currency !== 'RUB' ||
    typeof r.status !== 'string' ||
    !['QUOTING', 'QUOTED', 'UNKNOWN', 'PAYMENT_PENDING', 'PAID'].includes(r.status) ||
    typeof r.canOpenPayment !== 'boolean' ||
    (r.paymentExpiresAt !== null && !date(r.paymentExpiresAt)) ||
    (r.amountMinor !== null &&
      (!Number.isSafeInteger(r.amountMinor) || Number(r.amountMinor) <= 0)) ||
    (c.quote &&
      !['QUOTING', 'QUOTED'].includes(r.status) &&
      r.amountMinor !== c.quote.amountMinor) ||
    (r.canOpenPayment && (r.status !== 'PAYMENT_PENDING' || !date(r.paymentExpiresAt))) ||
    (['PAYMENT_PENDING', 'PAID'].includes(r.status) && r.amountMinor === null)
  )
    return fail();
  return r as unknown as SubscriptionPurchaseResult;
}
export function monthlyConsent(q: SubscriptionPurchaseQuote): SubscriptionPurchaseConsent {
  return {
    offerId: monthlyOffer,
    expectedRevision: q.revision,
    amountMinor: q.amountMinor,
    currency: 'RUB',
  };
}
export async function validateMonthlyLaunch(
  v: unknown,
  c: MonthlyCustody,
): Promise<SubscriptionPaymentLaunch> {
  const r = exact(v, 'contractVersion,operationId,launchCode,expiresAt'),
    id = await monthlyIdentity(c);
  if (
    r.contractVersion !== 1 ||
    r.operationId !== id.operationId ||
    typeof r.launchCode !== 'string' ||
    !new RegExp('^' + c.tenantId + '\\.[0-9a-f]{64}$(?![\\s\\S])').test(r.launchCode) ||
    !date(r.expiresAt) ||
    Date.parse(r.expiresAt) <= Date.now() ||
    Date.parse(r.expiresAt) > Date.now() + 61000
  )
    return fail();
  return r as unknown as SubscriptionPaymentLaunch;
}
