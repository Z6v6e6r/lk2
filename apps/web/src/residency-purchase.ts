import type { ClientResidencyStatus } from '@phub/api-sdk';

/**
 * Typed client adapter for residency.
 *
 * - Status: the merged LK2 read `GET /residency` (ADR 0027).
 * - Orders: the LK2 surface of the LK1 residency lifecycle owner (Z6v6e6r/lk#443). Shapes follow
 *   that owner verbatim (docs/contracts/residency-purchase.md). Until the LK2 surface is deployed
 *   the catalog read fails and the screen says purchase is unavailable.
 *
 * Nothing here is a mock: product, price, term, benefits, renewal rule, payment link and
 * activation are only ever rendered from validated server responses. Unknown extra fields are
 * ignored; every field the UI uses is validated.
 */
export interface ResidencyGateway {
  /** Stable account epoch; a change invalidates every in-flight command and its result. */
  readonly residencyPrincipal: () => string | null;
  readonly getClientResidency: () => Promise<ClientResidencyStatus>;
  readonly getResidencyCatalog: () => Promise<unknown>;
  readonly createResidencyOrder: (mode: ResidencyOrderMode, key: string) => Promise<unknown>;
  readonly getResidencyOrder: (orderId: string) => Promise<unknown>;
  readonly getResidencyOrderPayment: (orderId: string) => Promise<unknown>;
  readonly reconcileResidencyOrder: (orderId: string, key: string) => Promise<unknown>;
  readonly cancelResidencyOrder: (orderId: string, key: string) => Promise<unknown>;
  /** Leaves the app for the server-issued payment page. Never receives payment details. */
  readonly openResidencyPayment: (paymentUrl: string) => void;
}

export type ResidencyOrderMode = 'NEW' | 'RENEWAL';

export interface ResidencyCatalog {
  readonly productId: string;
  readonly title: string;
  readonly termDays: number;
  readonly priceMinor: number;
  readonly currency: 'RUB';
  /** Only plain-text server benefits are shown; the owner currently publishes none. */
  readonly benefits: readonly string[];
  readonly checkedAt: string;
}

export const RESIDENCY_ORDER_STATES = [
  'PENDING_PAYMENT',
  'PAYMENT_FAILED',
  'EXPIRED',
  'CANCELLED',
  'PAID',
  'PAID_ACTIVATION_PENDING',
  'ACTIVE',
  'ACTIVATION_FAILED',
  'PAID_REQUIRES_REVIEW',
] as const;
export type ResidencyOrderState = (typeof RESIDENCY_ORDER_STATES)[number];
const PAYMENT_STATUSES = ['NONE', 'PENDING', 'PAID', 'FAILED', 'UNKNOWN'] as const;
export type ResidencyPaymentStatus = (typeof PAYMENT_STATUSES)[number];

export interface ResidencyOrder {
  readonly orderId: string;
  readonly mode: ResidencyOrderMode;
  readonly state: ResidencyOrderState;
  readonly title: string;
  readonly totalMinor: number;
  readonly paymentStatus: ResidencyPaymentStatus;
  readonly paymentUrl: string | null;
  readonly paymentExpiresAt: string | null;
  readonly residencyValidUntil: string | null;
}
export interface ResidencyPayment {
  readonly orderId: string;
  readonly state: ResidencyOrderState;
  readonly paymentStatus: ResidencyPaymentStatus;
  readonly paymentUrl: string | null;
  readonly expiresAt: string | null;
}
export interface ResidencyPrincipal {
  readonly tenantId: string;
  readonly userId: string;
}
/**
 * Only the idempotency key, the requested mode and the server order id are kept; never a price,
 * payment link or payment details. `orderId` is null until the create response arrives: a reload
 * then repeats the create with the same key, which the owner answers with the same order.
 */
export interface ResidencyCustody extends ResidencyPrincipal {
  readonly version: 2;
  readonly key: string;
  readonly mode: ResidencyOrderMode;
  readonly orderId: string | null;
}

export class ResidencyContractError extends Error {
  public constructor() {
    super('RESIDENCY_CONTRACT_INVALID');
  }
}
const fail = (): never => {
  throw new ResidencyContractError();
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);
const text = (v: unknown, max = 200): v is string =>
  typeof v === 'string' && v.trim().length > 0 && v.length <= max;
const instant = (v: unknown): v is string =>
  typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v) && Number.isFinite(Date.parse(v));
const money = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;
const oneOf = <T extends string>(list: readonly T[], v: unknown): v is T =>
  typeof v === 'string' && (list as readonly string[]).includes(v);
function object(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return fail();
  return v as Record<string, unknown>;
}
function httpsUrl(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'string') return fail();
  let url: URL;
  try {
    url = new URL(v);
  } catch {
    return fail();
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') return fail();
  return url.toString();
}

export function parseResidencyCatalog(v: unknown): ResidencyCatalog {
  const c = object(v);
  const p = object(c.product);
  if (
    c.schemaVersion !== 1 ||
    !uuid(p.productId) ||
    !text(p.title) ||
    !Number.isSafeInteger(p.termDays) ||
    (p.termDays as number) <= 0 ||
    !money(p.priceMinor) ||
    p.currency !== 'RUB' ||
    !Array.isArray(p.benefits) ||
    p.benefits.length > 20 ||
    !instant(c.checkedAt)
  )
    return fail();
  return {
    productId: p.productId,
    title: p.title,
    termDays: p.termDays as number,
    priceMinor: p.priceMinor,
    currency: 'RUB',
    benefits: p.benefits.filter((b): b is string => text(b, 300)),
    checkedAt: c.checkedAt,
  };
}

export function parseResidencyOrder(v: unknown, expectedOrderId?: string): ResidencyOrder {
  const o = object(v);
  const product = object(o.product);
  const pricing = object(o.pricing);
  const payment = object(o.payment);
  const residency = o.residency === null ? null : object(o.residency);
  if (
    o.schemaVersion !== 1 ||
    !uuid(o.orderId) ||
    (expectedOrderId !== undefined && o.orderId.toLowerCase() !== expectedOrderId.toLowerCase()) ||
    !oneOf(['NEW', 'RENEWAL'] as const, o.mode) ||
    !oneOf(RESIDENCY_ORDER_STATES, o.state) ||
    !text(product.title) ||
    !money(pricing.totalMinor) ||
    pricing.currency !== 'RUB' ||
    !oneOf(PAYMENT_STATUSES, payment.status) ||
    (payment.expiresAt !== null && !instant(payment.expiresAt)) ||
    // Only ACTIVE carries a residency window (owner contract).
    (o.state === 'ACTIVE' && (!residency || !instant(residency.validUntil))) ||
    (residency !== null && residency.validUntil !== null && !instant(residency.validUntil))
  )
    return fail();
  return {
    orderId: o.orderId.toLowerCase(),
    mode: o.mode,
    state: o.state,
    title: product.title,
    totalMinor: pricing.totalMinor,
    paymentStatus: payment.status,
    paymentUrl: payment.status === 'PENDING' ? httpsUrl(payment.paymentUrl) : null,
    paymentExpiresAt: payment.expiresAt,
    residencyValidUntil: residency ? (residency.validUntil as string | null) : null,
  };
}

/** `POST /orders`, `/reconcile` and `/cancel` wrap the order: `{ schemaVersion, order, ... }`. */
export function parseResidencyOrderEnvelope(v: unknown, expectedOrderId?: string): ResidencyOrder {
  const e = object(v);
  if (e.schemaVersion !== 1) return fail();
  return parseResidencyOrder(e.order, expectedOrderId);
}

export function parseResidencyPayment(v: unknown, orderId: string): ResidencyPayment {
  const p = object(v);
  if (
    p.schemaVersion !== 1 ||
    !uuid(p.orderId) ||
    p.orderId.toLowerCase() !== orderId.toLowerCase() ||
    !oneOf(RESIDENCY_ORDER_STATES, p.state) ||
    !oneOf(PAYMENT_STATUSES, p.paymentStatus) ||
    (p.expiresAt !== null && p.expiresAt !== undefined && !instant(p.expiresAt))
  )
    return fail();
  return {
    orderId: p.orderId.toLowerCase(),
    state: p.state,
    paymentStatus: p.paymentStatus,
    // A link is usable only for an unpaid pending order; a stale link is never opened.
    paymentUrl:
      p.state === 'PENDING_PAYMENT' && p.paymentStatus === 'PENDING'
        ? httpsUrl(p.paymentUrl)
        : null,
    expiresAt: (p.expiresAt) ?? null,
  };
}

export const residencyStorageKey = (p: ResidencyPrincipal) =>
  'phub.residency-order.v2:' + p.tenantId + ':' + p.userId;

export function loadResidencyCustody(
  storage: Pick<Storage, 'getItem'>,
  p: ResidencyPrincipal,
): ResidencyCustody | null {
  const raw = storage.getItem(residencyStorageKey(p));
  if (raw === null) return null;
  const c = object(JSON.parse(raw));
  if (
    c.version !== 2 ||
    c.tenantId !== p.tenantId ||
    c.userId !== p.userId ||
    typeof c.key !== 'string' ||
    !/^residency:[0-9a-f-]{36}$/.test(c.key) ||
    !uuid(c.key.slice('residency:'.length)) ||
    !oneOf(['NEW', 'RENEWAL'] as const, c.mode) ||
    (c.orderId !== null && !uuid(c.orderId))
  )
    return fail();
  return {
    version: 2,
    tenantId: p.tenantId,
    userId: p.userId,
    key: c.key,
    mode: c.mode,
    orderId: c.orderId,
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
  mode: ResidencyOrderMode,
  randomUuid: () => string,
): ResidencyCustody {
  return {
    version: 2,
    tenantId: p.tenantId,
    userId: p.userId,
    key: 'residency:' + randomUuid(),
    mode,
    orderId: null,
  };
}

/** The independent status read decides what the user currently has. */
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
const isDay = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);

export function residencyStatusView(
  s: ClientResidencyStatus,
  now = Date.now(),
): ResidencyStatusView {
  if (s.state === 'ACTIVE' && s.checkedAt)
    return { kind: 'active', validFrom: s.validFrom, validUntil: s.validUntil };
  if (s.state === 'NONE' && s.checkedAt) {
    if (isDay(s.validUntil) && s.validUntil < moscowToday(now))
      return { kind: 'expired', validUntil: s.validUntil };
    return { kind: 'none' };
  }
  // ACTIVE/NONE without a complete read is not trustworthy, exactly like UNAVAILABLE.
  return { kind: 'unavailable', reason: s.unavailableReason };
}

/** What the order panel shows. Activation requires the order and the independent read. */
export type ResidencyOrderPhase =
  'idle' | 'creating' | 'payment-pending' | 'confirming' | 'review' | 'activated' | 'failed';

export function residencyOrderPhase(
  custody: ResidencyCustody | null,
  order: ResidencyOrder | null,
  status: ResidencyStatusView | null,
): ResidencyOrderPhase {
  if (!custody) return 'idle';
  if (!custody.orderId || !order) return 'creating';
  switch (order.state) {
    case 'PENDING_PAYMENT':
      return order.paymentStatus === 'UNKNOWN' ? 'confirming' : 'payment-pending';
    case 'PAID':
    case 'PAID_ACTIVATION_PENDING':
      return 'confirming';
    case 'ACTIVE':
      // Neither a returned payment page nor the order alone is success: the independent
      // residency read must confirm the active residency too.
      return status?.kind === 'active' ? 'activated' : 'confirming';
    case 'ACTIVATION_FAILED':
    case 'PAID_REQUIRES_REVIEW':
      return 'review';
    default:
      return 'failed';
  }
}

export function residencyFailureMessage(order: ResidencyOrder | null): string {
  switch (order?.state) {
    case 'EXPIRED':
      return 'Время на оплату истекло. Резидентство не оформлено.';
    case 'CANCELLED':
      return 'Заказ отменён. Резидентство не оформлено.';
    default:
      return 'Оплата не прошла. Резидентство не оформлено.';
  }
}

/** Stable owner error codes the UI explains; anything else is a generic failure. */
const ORDER_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  RESIDENCY_ORDER_ALREADY_PENDING:
    'У вас уже есть неоплаченный заказ резидентства. Оплатите его или дождитесь, пока он истечёт.',
  RESIDENCY_RENEWAL_REQUIRED: 'Резидентство уже активно — доступно продление.',
  RESIDENCY_RENEWAL_NOT_ELIGIBLE: 'Продление недоступно: активного резидентства нет.',
  RESIDENCY_ORDER_PAID: 'Заказ уже оплачен и не может быть отменён. Ждём активации.',
  RESIDENCY_ORDER_NOT_CANCELLABLE: 'Этот заказ уже нельзя отменить.',
  RESIDENCY_PRODUCT_TERMS_MISMATCH: 'Условия резидентства изменились. Оформление приостановлено.',
  RESIDENCY_RATE_LIMITED: 'Слишком много запросов. Попробуйте через минуту.',
};
export function residencyErrorCode(error: unknown): string | null {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code
    : null;
}
export function residencyErrorMessage(error: unknown, fallback: string): string {
  const code = residencyErrorCode(error);
  return (code ? ORDER_ERROR_MESSAGES[code] : undefined) ?? fallback;
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

/** Accepts a business day (`YYYY-MM-DD`) or an instant; renders the Moscow calendar day. */
export function formatDay(value: string): string {
  const date = isDay(value) ? new Date(value + 'T12:00:00.000Z') : new Date(value);
  return date.toLocaleDateString('ru-RU', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'Europe/Moscow',
  });
}

export function formatTerm(days: number): string {
  const mod10 = days % 10,
    mod100 = days % 100;
  const word =
    mod10 === 1 && mod100 !== 11
      ? 'день'
      : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)
        ? 'дня'
        : 'дней';
  return `${days} ${word}`;
}
