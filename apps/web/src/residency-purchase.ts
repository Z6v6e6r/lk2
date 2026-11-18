import type { ClientResidencyStatus } from '@phub/api-sdk';

/**
 * Typed client adapter for residency. The status read is the merged server method
 * `GET /residency` (ADR 0027). The purchase operations follow the provisional contract in
 * docs/contracts/residency-purchase.md; until the server owner is deployed the capability read
 * fails or answers `available: false` and the UI says so. Nothing here is a mock: offers, prices,
 * validity and payment outcome are only ever rendered from validated server responses.
 */
export interface ResidencyGateway {
  /** Stable account epoch; a change invalidates every in-flight command and its result. */
  readonly residencyPrincipal: () => string | null;
  readonly getClientResidency: () => Promise<ClientResidencyStatus>;
  readonly getResidencyPurchaseCapability: () => Promise<unknown>;
  readonly quoteResidencyPurchase: (offerId: string, key: string) => Promise<unknown>;
  readonly purchaseResidency: (input: ResidencyPurchaseConsent, key: string) => Promise<unknown>;
  readonly getResidencyPurchase: (key: string) => Promise<unknown>;
  readonly reconcileResidencyPurchase: (operationId: string, key: string) => Promise<unknown>;
  readonly launchResidencyPayment: (operationId: string, key: string) => Promise<unknown>;
  /** Leaves the app for the server-issued payment page. Never receives payment details. */
  readonly openResidencyPayment: (paymentUrl: string) => void;
}

export interface ResidencyOffer {
  readonly offerId: string;
  readonly title: string;
  readonly description: string | null;
  readonly durationLabel: string;
  readonly amountMinor: number;
  readonly currency: 'RUB';
  readonly benefits: readonly string[];
}
export interface ResidencyCapability {
  readonly available: boolean;
  readonly offers: readonly ResidencyOffer[];
}
export interface ResidencyQuote {
  readonly contractVersion: 1;
  readonly operationId: string;
  readonly offerId: string;
  readonly title: string;
  readonly revision: string;
  readonly amountMinor: number;
  readonly currency: 'RUB';
  readonly validFrom: string;
  readonly validUntil: string;
  readonly expiresAt: string;
}
export const RESIDENCY_OPERATION_STATUSES = [
  'QUOTED',
  'PAYMENT_PENDING',
  'CONFIRMING',
  'ACTIVATED',
  'PAYMENT_FAILED',
  'EXPIRED',
  'UNKNOWN',
] as const;
export type ResidencyOperationStatus = (typeof RESIDENCY_OPERATION_STATUSES)[number];
export interface ResidencyPurchaseResult {
  readonly operationId: string;
  readonly offerId: string;
  readonly status: ResidencyOperationStatus;
  readonly amountMinor: number | null;
  readonly currency: 'RUB';
  readonly canOpenPayment: boolean;
  readonly paymentExpiresAt: string | null;
  readonly failureCode: string | null;
}
export interface ResidencyPurchaseConsent {
  readonly offerId: string;
  readonly expectedRevision: string;
  readonly amountMinor: number;
  readonly currency: 'RUB';
}
export interface ResidencyPaymentLaunch {
  readonly operationId: string;
  readonly paymentUrl: string;
  readonly expiresAt: string;
}
export interface ResidencyPrincipal {
  readonly tenantId: string;
  readonly userId: string;
}
/** Only the idempotency key and the server quote are kept; no payment details ever. */
export interface ResidencyCustody extends ResidencyPrincipal {
  readonly version: 1;
  readonly key: string;
  readonly submitted: boolean;
  readonly quote: ResidencyQuote | null;
}

export class ResidencyContractError extends Error {
  public constructor() {
    super('RESIDENCY_CONTRACT_INVALID');
  }
}
const fail = (): never => {
  throw new ResidencyContractError();
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const uuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);
const text = (v: unknown, max = 200): v is string =>
  typeof v === 'string' && v.trim().length > 0 && v.length <= max;
const instant = (v: unknown): v is string =>
  typeof v === 'string' && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
const day = (v: unknown): v is string =>
  typeof v === 'string' &&
  /^\d{4}-\d{2}-\d{2}$/.test(v) &&
  new Date(v + 'T00:00:00.000Z').toISOString().slice(0, 10) === v;
const money = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;
function exact(v: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    !v ||
    typeof v !== 'object' ||
    Array.isArray(v) ||
    Object.keys(v).sort().join() !== [...keys].sort().join()
  )
    return fail();
  return v as Record<string, unknown>;
}

export function parseResidencyCapability(v: unknown): ResidencyCapability {
  const c = exact(v, ['contractVersion', 'available', 'offers']);
  if (c.contractVersion !== 1 || typeof c.available !== 'boolean' || !Array.isArray(c.offers))
    return fail();
  if (c.offers.length > 20) return fail();
  const ids = new Set<string>();
  const offers = c.offers.map((raw): ResidencyOffer => {
    const o = exact(raw, [
      'offerId',
      'title',
      'description',
      'durationLabel',
      'amountMinor',
      'currency',
      'benefits',
    ]);
    if (
      !uuid(o.offerId) ||
      ids.has(o.offerId) ||
      !text(o.title) ||
      (o.description !== null && !text(o.description, 1000)) ||
      !text(o.durationLabel, 80) ||
      !money(o.amountMinor) ||
      o.currency !== 'RUB' ||
      !Array.isArray(o.benefits) ||
      o.benefits.length > 20 ||
      !o.benefits.every((b) => text(b, 300))
    )
      return fail();
    ids.add(o.offerId);
    return {
      offerId: o.offerId,
      title: o.title,
      description: o.description,
      durationLabel: o.durationLabel,
      amountMinor: o.amountMinor,
      currency: 'RUB',
      benefits: o.benefits,
    };
  });
  // An enabled purchase without a single offer is not trustworthy; an offer list on a disabled
  // capability is still shown as conditions only.
  if (c.available && offers.length === 0) return fail();
  return { available: c.available, offers };
}

export function parseResidencyQuote(v: unknown, offerId?: string): ResidencyQuote {
  const q = exact(v, [
    'contractVersion',
    'operationId',
    'offerId',
    'title',
    'revision',
    'amountMinor',
    'currency',
    'validFrom',
    'validUntil',
    'expiresAt',
  ]);
  if (
    q.contractVersion !== 1 ||
    !uuid(q.operationId) ||
    !uuid(q.offerId) ||
    (offerId !== undefined && q.offerId !== offerId) ||
    !text(q.title) ||
    !text(q.revision, 200) ||
    !money(q.amountMinor) ||
    q.currency !== 'RUB' ||
    !day(q.validFrom) ||
    !day(q.validUntil) ||
    q.validUntil < q.validFrom ||
    !instant(q.expiresAt)
  )
    return fail();
  return {
    contractVersion: 1,
    operationId: q.operationId,
    offerId: q.offerId,
    title: q.title,
    revision: q.revision,
    amountMinor: q.amountMinor,
    currency: 'RUB',
    validFrom: q.validFrom,
    validUntil: q.validUntil,
    expiresAt: q.expiresAt,
  };
}

export function parseResidencyResult(
  v: unknown,
  custody: ResidencyCustody,
): ResidencyPurchaseResult {
  const r = exact(v, [
    'contractVersion',
    'operationId',
    'offerId',
    'status',
    'amountMinor',
    'currency',
    'canOpenPayment',
    'paymentExpiresAt',
    'failureCode',
  ]);
  const status = r.status as ResidencyOperationStatus;
  if (
    r.contractVersion !== 1 ||
    !uuid(r.operationId) ||
    !uuid(r.offerId) ||
    (custody.quote &&
      (r.operationId !== custody.quote.operationId || r.offerId !== custody.quote.offerId)) ||
    !RESIDENCY_OPERATION_STATUSES.includes(status) ||
    r.currency !== 'RUB' ||
    (r.amountMinor !== null && !money(r.amountMinor)) ||
    (custody.quote && r.amountMinor !== null && r.amountMinor !== custody.quote.amountMinor) ||
    typeof r.canOpenPayment !== 'boolean' ||
    (r.paymentExpiresAt !== null && !instant(r.paymentExpiresAt)) ||
    (r.canOpenPayment && (status !== 'PAYMENT_PENDING' || r.paymentExpiresAt === null)) ||
    (r.failureCode !== null &&
      (typeof r.failureCode !== 'string' || !/^[A-Z][A-Z0-9_]{1,63}$/.test(r.failureCode)))
  )
    return fail();
  return {
    operationId: r.operationId,
    offerId: r.offerId,
    status,
    amountMinor: r.amountMinor,
    currency: 'RUB',
    canOpenPayment: r.canOpenPayment,
    paymentExpiresAt: r.paymentExpiresAt,
    failureCode: r.failureCode,
  };
}

export function parseResidencyLaunch(
  v: unknown,
  custody: ResidencyCustody,
  now = Date.now(),
): ResidencyPaymentLaunch {
  const r = exact(v, ['contractVersion', 'operationId', 'paymentUrl', 'expiresAt']);
  let url: URL | null;
  try {
    url = typeof r.paymentUrl === 'string' ? new URL(r.paymentUrl) : null;
  } catch {
    url = null;
  }
  if (
    r.contractVersion !== 1 ||
    !uuid(r.operationId) ||
    r.operationId !== custody.quote?.operationId ||
    !url ||
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    !instant(r.expiresAt) ||
    Date.parse(r.expiresAt) <= now
  )
    return fail();
  return { operationId: r.operationId, paymentUrl: url.toString(), expiresAt: r.expiresAt };
}

export function residencyConsent(q: ResidencyQuote): ResidencyPurchaseConsent {
  return {
    offerId: q.offerId,
    expectedRevision: q.revision,
    amountMinor: q.amountMinor,
    currency: 'RUB',
  };
}

export const residencyStorageKey = (p: ResidencyPrincipal) =>
  'phub.residency-purchase.v1:' + p.tenantId + ':' + p.userId;

export function loadResidencyCustody(
  storage: Pick<Storage, 'getItem'>,
  p: ResidencyPrincipal,
): ResidencyCustody | null {
  const raw = storage.getItem(residencyStorageKey(p));
  if (raw === null) return null;
  const c = exact(JSON.parse(raw), ['version', 'tenantId', 'userId', 'key', 'submitted', 'quote']);
  if (
    c.version !== 1 ||
    c.tenantId !== p.tenantId ||
    c.userId !== p.userId ||
    typeof c.key !== 'string' ||
    !/^residency:[0-9a-f-]{36}$/.test(c.key) ||
    !uuid(c.key.slice('residency:'.length)) ||
    typeof c.submitted !== 'boolean' ||
    (c.submitted && c.quote === null)
  )
    return fail();
  return {
    version: 1,
    tenantId: p.tenantId,
    userId: p.userId,
    key: c.key,
    submitted: c.submitted,
    quote: c.quote === null ? null : parseResidencyQuote(c.quote),
  };
}

export function saveResidencyCustody(storage: Storage, c: ResidencyCustody): void {
  const value = JSON.stringify(c);
  storage.setItem(residencyStorageKey(c), value);
  if (storage.getItem(residencyStorageKey(c)) !== value) fail();
}

export function clearResidencyCustody(storage: Storage, p: ResidencyPrincipal): void {
  storage.removeItem(residencyStorageKey(p));
  if (storage.getItem(residencyStorageKey(p)) !== null) fail();
}

export function newResidencyCustody(
  p: ResidencyPrincipal,
  randomUuid: () => string,
): ResidencyCustody {
  return {
    version: 1,
    tenantId: p.tenantId,
    userId: p.userId,
    key: 'residency:' + randomUuid(),
    submitted: false,
    quote: null,
  };
}

/** The residency read decides what the user currently has. */
export type ResidencyStatusView =
  | {
      readonly kind: 'active';
      readonly validFrom: string | null;
      readonly validUntil: string | null;
    }
  | { readonly kind: 'expired'; readonly validUntil: string }
  | { readonly kind: 'none' }
  | { readonly kind: 'unavailable'; readonly reason: string | null };

/** Today in the residency business calendar (Europe/Moscow, as in docs/domains/residency.md). */
export function moscowToday(now = Date.now()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Moscow',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(now));
}

export function residencyStatusView(
  s: ClientResidencyStatus,
  now = Date.now(),
): ResidencyStatusView {
  if (s.state === 'ACTIVE' && s.checkedAt)
    return { kind: 'active', validFrom: s.validFrom, validUntil: s.validUntil };
  if (s.state === 'NONE' && s.checkedAt) {
    if (s.validUntil && day(s.validUntil) && s.validUntil < moscowToday(now))
      return { kind: 'expired', validUntil: s.validUntil };
    return { kind: 'none' };
  }
  // ACTIVE/NONE without a complete read is not trustworthy, exactly like UNAVAILABLE.
  return { kind: 'unavailable', reason: s.unavailableReason };
}

/** What the purchase panel shows. Activation requires the server operation and the status read. */
export type ResidencyPurchasePhase =
  'idle' | 'quoted' | 'payment-pending' | 'confirming' | 'activated' | 'failed';

export function residencyPurchasePhase(
  custody: ResidencyCustody | null,
  result: ResidencyPurchaseResult | null,
  status: ResidencyStatusView | null,
): ResidencyPurchasePhase {
  if (!custody) return 'idle';
  if (!custody.submitted) return custody.quote ? 'quoted' : 'idle';
  if (!result) return 'confirming';
  switch (result.status) {
    case 'PAYMENT_PENDING':
      return 'payment-pending';
    case 'ACTIVATED':
      // A returned payment page or a server ACTIVATED alone is not shown as success until the
      // independent residency read confirms the active residency.
      return status?.kind === 'active' ? 'activated' : 'confirming';
    case 'PAYMENT_FAILED':
    case 'EXPIRED':
      return 'failed';
    case 'QUOTED':
      return 'quoted';
    default:
      return 'confirming';
  }
}

const FAILURE_MESSAGES: Readonly<Record<string, string>> = {
  PAYMENT_DECLINED: 'Платёж отклонён банком. Резидентство не оформлено.',
  PAYMENT_CANCELLED: 'Оплата отменена.',
  PAYMENT_EXPIRED: 'Время на оплату истекло.',
  QUOTE_EXPIRED: 'Предложение устарело. Запросите стоимость заново.',
  OFFER_UNAVAILABLE: 'Это предложение больше недоступно.',
};
export function residencyFailureMessage(result: ResidencyPurchaseResult | null): string {
  if (result?.status === 'EXPIRED') return 'Время на оплату истекло. Резидентство не оформлено.';
  return (
    (result?.failureCode ? FAILURE_MESSAGES[result.failureCode] : undefined) ??
    'Оплата не прошла. Резидентство не оформлено.'
  );
}

const UNAVAILABLE_MESSAGES: Readonly<Record<string, string>> = {
  PRODUCT_NOT_CONFIGURED: 'Резидентство ещё не настроено для этого клуба.',
  IDENTITY_MAPPING_MISSING:
    'Профиль ещё не связан с клубной системой. Статус появится после синхронизации.',
};
export function residencyUnavailableMessage(reason: string | null): string {
  return (
    (reason ? UNAVAILABLE_MESSAGES[reason] : undefined) ??
    'Не удалось проверить статус резидентства. Попробуйте позже.'
  );
}

export function formatRub(amountMinor: number): string {
  return new Intl.NumberFormat('ru-RU', {
    style: 'currency',
    currency: 'RUB',
    maximumFractionDigits: amountMinor % 100 === 0 ? 0 : 2,
  }).format(amountMinor / 100);
}

export function formatDay(value: string): string {
  return new Date(value + 'T12:00:00.000Z').toLocaleDateString('ru-RU', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'Europe/Moscow',
  });
}
