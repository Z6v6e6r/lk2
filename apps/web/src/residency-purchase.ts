import type { ClientResidencyStatus } from '@phub/api-sdk';

/**
 * Typed client adapter for residency.
 *
 * - Status: the merged LK2 read `GET /residency` (ADR 0027).
 * - Orders: the LK2 surface of the LK1 residency lifecycle owner (Z6v6e6r/lk#443). Shapes follow
 *   that owner verbatim (docs/contracts/residency-purchase.md). Until the LK2 consumer is
 *   deployed the catalog read fails and the screen says purchase is unavailable.
 *
 * Nothing here is a mock: product, price, term, renewal rule, payment link and activation are
 * only ever rendered from validated server responses. Unknown extra fields are ignored; every
 * field the UI uses is validated, and a non-JSON or malformed body is never a success.
 */
export interface ResidencyGateway {
  /** Stable account epoch; a change invalidates every in-flight command and its result. */
  readonly residencyPrincipal: () => string | null;
  readonly getClientResidency: () => Promise<unknown>;
  readonly getResidencyCatalog: () => Promise<unknown>;
  readonly listUnresolvedResidencyOrders: () => Promise<unknown>;
  readonly reauthorizeResidency: () => Promise<void>;
  readonly createResidencyOrder: (input: ResidencyCreateInput, key: string) => Promise<unknown>;
  readonly getResidencyOrder: (orderId: string) => Promise<unknown>;
  readonly getResidencyOrderPayment: (orderId: string) => Promise<unknown>;
  readonly reconcileResidencyOrder: (orderId: string, key: string) => Promise<unknown>;
  readonly cancelResidencyOrder: (orderId: string, key: string) => Promise<unknown>;
  /** Leaves the app for the server-issued payment page. Never receives payment details. */
  readonly openResidencyPayment: (paymentUrl: string) => void;
}

export type ResidencyOrderMode = 'NEW' | 'RENEWAL';
export interface ResidencyCreateInput {
  readonly mode: ResidencyOrderMode;
  readonly expectedTotalMinor: number;
  readonly expectedProductId?: string;
}
export interface ResidencyRenewal {
  readonly eligible: boolean;
  readonly reason: string | null;
  readonly eligibleAt: string | null;
  readonly currentValidUntil: string | null;
  readonly expected: {
    readonly termDays: number;
    readonly startsAt: 'PAYMENT_DATE';
    readonly earliestValidUntil: string | null;
  } | null;
}
const RECOVERY_STATES = [
  'NONE',
  'AWAITING_PAYMENT',
  'AWAITING_CONFIRMATION',
  'UNKNOWN_OUTCOME',
  'ACTIVATION_PENDING',
  'REVIEW_REQUIRED',
  'TERMINAL',
] as const;
export interface ResidencyRecovery {
  readonly state: (typeof RECOVERY_STATES)[number];
  readonly required: boolean;
  readonly reason: string | null;
  readonly action: 'NONE' | 'PAY' | 'RETRY_RECONCILE' | 'CONTACT_SUPPORT' | 'START_NEW_ORDER';
  readonly retryable: boolean;
  readonly since: string;
}

export interface ResidencyCatalog {
  readonly renewal: ResidencyRenewal;
  readonly productId: string;
  readonly title: string;
  readonly termDays: number;
  readonly priceMinor: number;
  readonly currency: 'RUB';
  /** Only plain-text server benefit lines are shown; structured codes are not invented into text. */
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
/** Public payment statuses. The owner normalizes its internal DISPATCHING to UNKNOWN. */
const PAYMENT_STATUSES = ['NONE', 'PENDING', 'PAID', 'FAILED', 'UNKNOWN'] as const;
export type ResidencyPaymentStatus = (typeof PAYMENT_STATUSES)[number];

export interface ResidencyOrder {
  readonly productId: string;
  readonly consent: {
    readonly expectedTotalMinor: number;
    readonly productId: string;
    readonly acceptedAt: string;
  } | null;
  readonly recovery: ResidencyRecovery;
  readonly overdue: boolean;
  readonly orderId: string;
  readonly mode: ResidencyOrderMode;
  readonly state: ResidencyOrderState;
  readonly title: string;
  readonly totalMinor: number;
  readonly paymentStatus: ResidencyPaymentStatus;
  readonly paymentUrl: string | null;
  readonly paymentExpiresAt: string | null;
  readonly activationErrorCode: string | null;
  readonly residencyValidUntil: string | null;
}
export interface ResidencyPayment {
  readonly recovery: ResidencyRecovery;
  readonly overdue: boolean;
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
 * One purchase attempt. Each attempt lives in its own storage entry named by its idempotency key,
 * so concurrent tabs never overwrite or delete another attempt. Only the key, the requested
 * mode, the server order id and the confirmed catalog price are kept; never a link or payment
 * details. `orderId` is null until the create response arrives.
 */
export interface ResidencyAttempt extends ResidencyPrincipal {
  readonly version: 3;
  /** Absent on legacy records: never invent consent or replay those creates. */
  readonly createPayload?: ResidencyCreateInput;
  readonly key: string;
  readonly mode: ResidencyOrderMode;
  readonly orderId: string | null;
  /** The catalog price the user confirmed; the order total must not exceed it before payment opens. */
  readonly confirmedPriceMinor: number;
  readonly createdAt: string;
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
const isDay = (v: unknown): v is string =>
  typeof v === 'string' &&
  /^\d{4}-\d{2}-\d{2}$/.test(v) &&
  Number.isFinite(Date.parse(v + 'T00:00:00Z'));
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

const STATUS_STATES = ['ACTIVE', 'NONE', 'UNAVAILABLE'] as const;
/** Validates the ADR 0027 read; anything else (HTML, a proxy page, junk) is not a status. */
export function parseClientResidencyStatus(v: unknown): ClientResidencyStatus {
  const s = object(v);
  if (
    !oneOf(STATUS_STATES, s.state) ||
    (s.validFrom !== null && !isDay(s.validFrom)) ||
    (s.validUntil !== null && !isDay(s.validUntil)) ||
    (s.checkedAt !== null && !instant(s.checkedAt)) ||
    (s.unavailableReason !== null && typeof s.unavailableReason !== 'string')
  )
    return fail();
  return s as unknown as ClientResidencyStatus;
}

function parseRenewal(v: unknown): ResidencyRenewal {
  const r = object(v);
  const e = r.expected === null ? null : object(r.expected);
  if (
    typeof r.eligible !== 'boolean' ||
    (r.reason !== null && !text(r.reason, 64)) ||
    (r.eligibleAt !== null && !instant(r.eligibleAt)) ||
    (r.currentValidUntil !== null && !instant(r.currentValidUntil)) ||
    (e &&
      (!Number.isSafeInteger(e.termDays) ||
        (e.termDays as number) <= 0 ||
        e.startsAt !== 'PAYMENT_DATE' ||
        (e.earliestValidUntil !== null && !instant(e.earliestValidUntil))))
  )
    return fail();
  return r as unknown as ResidencyRenewal;
}
function parseRecovery(v: unknown): ResidencyRecovery {
  const r = object(v);
  if (
    !oneOf(RECOVERY_STATES, r.state) ||
    typeof r.required !== 'boolean' ||
    typeof r.retryable !== 'boolean' ||
    (r.reason !== null && !text(r.reason, 64)) ||
    !instant(r.since) ||
    !oneOf(
      ['NONE', 'PAY', 'RETRY_RECONCILE', 'CONTACT_SUPPORT', 'START_NEW_ORDER'] as const,
      r.action,
    )
  )
    return fail();
  return r as unknown as ResidencyRecovery;
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
    renewal: parseRenewal(c.renewal),
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
  const recovery = parseRecovery(o.recovery);
  const consent = o.consent === null ? null : object(o.consent);
  if (
    !uuid(product.productId) ||
    typeof payment.overdue !== 'boolean' ||
    (consent &&
      (!money(consent.expectedTotalMinor) ||
        !uuid(consent.productId) ||
        !instant(consent.acceptedAt)))
  )
    return fail();
  const activation = o.activation === undefined ? {} : object(o.activation);
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
    (activation.lastErrorCode !== undefined &&
      activation.lastErrorCode !== null &&
      !text(activation.lastErrorCode, 64)) ||
    // Only ACTIVE carries a residency window (owner contract).
    (o.state === 'ACTIVE' && (!residency || !instant(residency.validUntil))) ||
    (residency !== null && residency.validUntil !== null && !instant(residency.validUntil))
  )
    return fail();
  return {
    productId: product.productId,
    consent: consent as ResidencyOrder['consent'],
    recovery,
    overdue: payment.overdue,
    orderId: o.orderId.toLowerCase(),
    mode: o.mode,
    state: o.state,
    title: product.title,
    totalMinor: pricing.totalMinor,
    paymentStatus: payment.status,
    paymentUrl:
      o.state === 'PENDING_PAYMENT' && payment.status === 'PENDING'
        ? httpsUrl(payment.paymentUrl)
        : null,
    paymentExpiresAt: payment.expiresAt,
    activationErrorCode: activation.lastErrorCode ?? null,
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
    recovery: parseRecovery(p.recovery),
    overdue: typeof p.overdue === 'boolean' ? p.overdue : fail(),
    orderId: p.orderId.toLowerCase(),
    state: p.state,
    paymentStatus: p.paymentStatus,
    // A link is usable only for an unpaid pending order; a stale link is never opened.
    paymentUrl:
      p.state === 'PENDING_PAYMENT' && p.paymentStatus === 'PENDING'
        ? httpsUrl(p.paymentUrl)
        : null,
    expiresAt: p.expiresAt ?? null,
  };
}

export function parseUnresolvedResidencyOrders(v: unknown): ResidencyOrder[] {
  const e = object(v);
  if (
    e.schemaVersion !== 1 ||
    !Array.isArray(e.orders) ||
    e.count !== e.orders.length ||
    e.orders.length > 20
  )
    return fail();
  return e.orders.map((o) => parseResidencyOrder(o));
}

export function discoveredResidencyAttempt(
  p: ResidencyPrincipal,
  order: ResidencyOrder,
): ResidencyAttempt {
  return {
    ...p,
    version: 3,
    key: 'residency-lookup:' + order.orderId,
    mode: order.mode,
    orderId: order.orderId,
    confirmedPriceMinor: order.consent?.expectedTotalMinor ?? order.totalMinor,
    createdAt: order.consent?.acceptedAt ?? order.recovery.since,
  };
}

// ---------------------------------------------------------------------------------------------
// Attempt storage. One entry per idempotency key: a tab only ever writes or removes its own key.
// ---------------------------------------------------------------------------------------------

const ATTEMPT_PREFIX = 'phub.residency-order.v3:';
const attemptPrefix = (p: ResidencyPrincipal) => ATTEMPT_PREFIX + p.tenantId + ':' + p.userId + ':';
export const residencyAttemptStorageKey = (a: ResidencyPrincipal & { readonly key: string }) =>
  attemptPrefix(a) + a.key;
/** Web Locks name serializing this account's commands across tabs where the browser has it. */
export const residencyLockName = (p: ResidencyPrincipal) => attemptPrefix(p) + 'lock';

function parseAttempt(raw: string, p: ResidencyPrincipal, storageKey: string): ResidencyAttempt {
  const a = object(JSON.parse(raw));
  if (
    a.version !== 3 ||
    a.tenantId !== p.tenantId ||
    a.userId !== p.userId ||
    typeof a.key !== 'string' ||
    !/^residency(?:-lookup)?:[0-9a-f-]{36}$/.test(a.key) ||
    !uuid(a.key.split(':')[1]) ||
    storageKey !== attemptPrefix(p) + a.key ||
    !oneOf(['NEW', 'RENEWAL'] as const, a.mode) ||
    (a.orderId !== null && !uuid(a.orderId)) ||
    !money(a.confirmedPriceMinor) ||
    !instant(a.createdAt)
  )
    return fail();
  let createPayload: ResidencyCreateInput | undefined;
  if (a.createPayload !== undefined) {
    const c = object(a.createPayload);
    if (
      c.mode !== a.mode ||
      c.expectedTotalMinor !== a.confirmedPriceMinor ||
      !money(c.expectedTotalMinor) ||
      (c.expectedProductId !== undefined && !uuid(c.expectedProductId))
    )
      return fail();
    createPayload = {
      mode: c.mode as ResidencyOrderMode,
      expectedTotalMinor: c.expectedTotalMinor,
      ...(c.expectedProductId === undefined ? {} : { expectedProductId: c.expectedProductId }),
    };
  }
  return {
    ...(createPayload ? { createPayload } : {}),
    version: 3,
    tenantId: p.tenantId,
    userId: p.userId,
    key: a.key,
    mode: a.mode,
    orderId: a.orderId,
    confirmedPriceMinor: a.confirmedPriceMinor,
    createdAt: a.createdAt,
  };
}

/** All attempts of this account, oldest first. A malformed entry fails closed. */
export function listResidencyAttempts(storage: Storage, p: ResidencyPrincipal): ResidencyAttempt[] {
  const prefix = attemptPrefix(p);
  const keys: string[] = [];
  for (let i = 0; i < storage.length; i += 1) {
    const k = storage.key(i);
    if (k !== null && k.startsWith(prefix)) keys.push(k);
  }
  return keys
    .map((k) => parseAttempt(storage.getItem(k) ?? fail(), p, k))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.key.localeCompare(b.key));
}

export function saveResidencyAttempt(storage: Storage, a: ResidencyAttempt): void {
  const value = JSON.stringify(a);
  storage.setItem(residencyAttemptStorageKey(a), value);
  if (storage.getItem(residencyAttemptStorageKey(a)) !== value) fail();
}

/** Removes exactly this attempt; another tab's attempt with a different key is untouched. */
export function removeResidencyAttempt(storage: Storage, a: ResidencyAttempt): void {
  storage.removeItem(residencyAttemptStorageKey(a));
  if (storage.getItem(residencyAttemptStorageKey(a)) !== null) fail();
}

export function newResidencyAttempt(
  p: ResidencyPrincipal,
  mode: ResidencyOrderMode,
  confirmedPriceMinor: number,
  randomUuid: () => string,
  now: () => number = Date.now,
  expectedProductId?: string,
): ResidencyAttempt {
  return {
    version: 3,
    tenantId: p.tenantId,
    userId: p.userId,
    createPayload: {
      mode,
      expectedTotalMinor: confirmedPriceMinor,
      ...(expectedProductId === undefined ? {} : { expectedProductId }),
    },
    key: 'residency:' + randomUuid(),
    mode,
    orderId: null,
    confirmedPriceMinor,
    createdAt: new Date(now()).toISOString(),
  };
}

// ---------------------------------------------------------------------------------------------
// Errors. A refusal is definitive only when the owner proves no order exists for this key.
// ---------------------------------------------------------------------------------------------

/**
 * Owner create refusals raised only after its idempotency lookup found no order for the key
 * (lk#443 `createOrder`). They are definitive for this key, so its attempt may be removed.
 * Everything else (network, HTML, 401/403, rate limit, IDEMPOTENCY_CONFLICT, ORDER_CONFLICT,
 * 5xx from the consumer) is uncertain: the original key is kept for a same-key replay.
 */
const DEFINITIVE_CREATE_REFUSALS = new Set([
  'RESIDENCY_ORDER_ALREADY_PENDING',
  'RESIDENCY_RENEWAL_REQUIRED',
  'RESIDENCY_RENEWAL_NOT_ELIGIBLE',
  'RESIDENCY_STATUS_UNAVAILABLE',
  'RESIDENCY_CATALOG_UNAVAILABLE',
  'RESIDENCY_PRICING_UNAVAILABLE',
  'RESIDENCY_PRICING_INVALID',
  'RESIDENCY_RENEWAL_TOO_EARLY',
]);
export function residencyErrorCode(error: unknown): string | null {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code
    : null;
}
export function residencyErrorStatus(error: unknown): number | null {
  return error && typeof error === 'object' && 'status' in error && typeof error.status === 'number'
    ? error.status
    : null;
}
export function isDefinitiveCreateRefusal(error: unknown, attempt?: ResidencyAttempt): boolean {
  const code = residencyErrorCode(error);
  const status = residencyErrorStatus(error);
  const d = residencyErrorDetails(error);
  if (
    code === 'RESIDENCY_PRICE_CHANGED' &&
    status === 409 &&
    attempt?.createPayload &&
    d.expectedTotalMinor === attempt.createPayload.expectedTotalMinor &&
    money(d.totalMinor) &&
    d.totalMinor > attempt.createPayload.expectedTotalMinor &&
    d.currency === 'RUB' &&
    d.productId === attempt.createPayload.expectedProductId
  )
    return true;
  return (
    code !== null &&
    DEFINITIVE_CREATE_REFUSALS.has(code) &&
    status !== null &&
    status >= 400 &&
    status < 600
  );
}

export function residencyErrorDetails(error: unknown): Record<string, unknown> {
  if (
    !error ||
    typeof error !== 'object' ||
    !('details' in error) ||
    !error.details ||
    typeof error.details !== 'object' ||
    Array.isArray(error.details)
  )
    return {};
  return error.details as Record<string, unknown>;
}
export function renewalUnavailableMessage(
  r: Pick<ResidencyRenewal, 'reason' | 'eligibleAt'>,
): string {
  const reason =
    r.reason === 'REMAINING_DAYS_NOT_TRANSFERABLE'
      ? 'Оставшиеся дни не переносятся в новый срок.'
      : r.reason === 'STATUS_UNAVAILABLE'
        ? 'Клуб не смог проверить срок резидентства.'
        : r.reason === 'NOT_ACTIVE'
          ? 'Нет активного резидентства для продления.'
          : 'Продление пока недоступно.';
  return (
    reason +
    (r.eligibleAt
      ? ' Продление доступно с ' +
        new Date(r.eligibleAt).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' }) +
        ' (МСК).'
      : '')
  );
}

/** Stable owner and consumer error codes the UI explains; anything else is generic. */
const ORDER_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  RESIDENCY_PRICE_CONSENT_REQUIRED:
    'Не удалось подтвердить исходное согласие на цену. Операция сохранена: проверьте заказ или обратитесь в поддержку.',
  RESIDENCY_PRICE_CHANGED:
    'Цена или продукт изменились. Проверьте условия; исходное согласие не изменено.',
  RESIDENCY_REAUTH_REQUIRED:
    'Для проверки операции нужно повторно войти через Viva. Операция сохранена.',
  RESIDENCY_REAUTH_UNAVAILABLE:
    'Повторный вход временно недоступен. Операция сохранена, попробуйте позже.',
  RESIDENCY_LEGACY_ATTEMPT:
    'Сохранена прежняя попытка без полного согласия. Новый заказ не создаётся. Проверьте найденный заказ или обратитесь в поддержку.',

  RESIDENCY_ORDER_ALREADY_PENDING:
    'У вас уже есть незавершённый заказ резидентства, начатый в другой вкладке или на другом устройстве. Проверьте заказ: новый платёж недоступен до подтверждения результата.',
  RESIDENCY_RENEWAL_REQUIRED:
    'Резидентство уже активно, поэтому доступно только продление. Статус обновлён.',
  RESIDENCY_RENEWAL_NOT_ELIGIBLE:
    'Продление недоступно: активного резидентства нет. Статус обновлён.',
  RESIDENCY_STATUS_UNAVAILABLE:
    'Клуб не смог проверить ваш статус, поэтому заказ не создан. Попробуйте позже.',
  RESIDENCY_CATALOG_UNAVAILABLE: 'Условия резидентства сейчас недоступны. Заказ не создан.',
  RESIDENCY_PRICING_UNAVAILABLE: 'Не удалось подтвердить цену. Заказ не создан.',
  RESIDENCY_PRICING_INVALID: 'Не удалось подтвердить цену. Заказ не создан.',
  RESIDENCY_ORDER_PAID: 'Заказ уже оплачен и не может быть отменён. Ждём активации.',
  RESIDENCY_ORDER_NOT_CANCELLABLE: 'Этот заказ уже нельзя отменить.',
  RESIDENCY_PAYMENT_STATUS_UNKNOWN:
    'Банк ещё не подтвердил статус оплаты, поэтому заказ не отменён. Попробуйте позже.',
  RESIDENCY_PRODUCT_TERMS_MISMATCH: 'Условия резидентства изменились. Оформление приостановлено.',
  RESIDENCY_RATE_LIMITED: 'Слишком много запросов. Попробуйте через минуту.',
};
export function residencyErrorMessage(error: unknown, fallback: string): string {
  const code = residencyErrorCode(error);
  const status = residencyErrorStatus(error);
  if (code === 'RESIDENCY_RENEWAL_TOO_EARLY') {
    const d = residencyErrorDetails(error);
    return renewalUnavailableMessage({
      reason: typeof d.reason === 'string' ? d.reason : null,
      eligibleAt: instant(d.eligibleAt) ? d.eligibleAt : null,
    });
  }
  if (code === 'RESIDENCY_PRICE_CHANGED') {
    const d = residencyErrorDetails(error);
    if (money(d.totalMinor) && money(d.expectedTotalMinor))
      return `Цена выросла до ${formatRub(d.totalMinor)}. Вы подтвердили ${formatRub(d.expectedTotalMinor)}. Подтвердите новые условия отдельно.`;
  }
  if (code && ORDER_ERROR_MESSAGES[code]) return ORDER_ERROR_MESSAGES[code];
  if (status === 401) return 'Сессия истекла. Войдите снова и проверьте заказ.';
  if (status === 403) return 'Нет доступа к оформлению резидентства для этого аккаунта.';
  return fallback;
}

// ---------------------------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------------------------

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

/** A calendar day in the residency business calendar (Europe/Moscow, docs/domains/residency.md). */
export function moscowDay(at: number | string = Date.now()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Moscow',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(at));
}

export function residencyStatusView(
  s: ClientResidencyStatus,
  now = Date.now(),
): ResidencyStatusView {
  if (s.state === 'ACTIVE' && s.checkedAt)
    return { kind: 'active', validFrom: s.validFrom, validUntil: s.validUntil };
  if (s.state === 'NONE' && s.checkedAt) {
    if (isDay(s.validUntil) && s.validUntil < moscowDay(now))
      return { kind: 'expired', validUntil: s.validUntil };
    return { kind: 'none' };
  }
  // ACTIVE/NONE without a complete read is not trustworthy, exactly like UNAVAILABLE.
  return { kind: 'unavailable', reason: s.unavailableReason };
}

/** What the order panel shows. Activation requires the order and the independent read. */
export type ResidencyOrderPhase =
  | 'idle'
  | 'creating'
  | 'payment-pending'
  | 'confirming'
  | 'uncertain'
  | 'review'
  | 'activated'
  | 'failed';

/** Owner activation codes of a create whose provider outcome is not known (lk#443). */
const UNKNOWN_DISPATCH_CODES = new Set([
  'DISPATCH_OUTCOME_UNKNOWN',
  'DISPATCH_LEASE_EXPIRED',
  'TRANSACTION_ID_MISSING',
]);

/**
 * The independent read confirms *this* order: ACTIVE, and its end date is not earlier than the
 * end the owner activated. An old ACTIVE read (before a renewal lands) is not confirmation.
 */
export function readConfirmsOrder(
  status: ResidencyStatusView | null,
  order: ResidencyOrder,
): boolean {
  if (status?.kind !== 'active' || !order.residencyValidUntil || !status.validUntil) return false;
  return status.validUntil >= moscowDay(order.residencyValidUntil);
}

export function residencyOrderPhase(
  attempt: ResidencyAttempt | null,
  order: ResidencyOrder | null,
  status: ResidencyStatusView | null,
): ResidencyOrderPhase {
  if (!attempt) return 'idle';
  if (!attempt.orderId) return 'creating';
  if (!order) return 'confirming';
  if (order.recovery.state === 'UNKNOWN_OUTCOME' || order.paymentStatus === 'UNKNOWN')
    return 'uncertain';
  if (order.recovery.state === 'REVIEW_REQUIRED') return 'review';
  if (
    order.overdue ||
    order.recovery.state === 'AWAITING_CONFIRMATION' ||
    order.recovery.state === 'ACTIVATION_PENDING'
  )
    return 'confirming';
  switch (order.state) {
    case 'PENDING_PAYMENT':
      return order.recovery.state === 'AWAITING_PAYMENT' && order.recovery.action === 'PAY'
        ? 'payment-pending'
        : 'confirming';
    case 'PAID':
    case 'PAID_ACTIVATION_PENDING':
      return 'confirming';
    case 'ACTIVE':
      // Neither a returned payment page nor the order alone is success: the independent
      // residency read must confirm this order's period too.
      return readConfirmsOrder(status, order) ? 'activated' : 'confirming';
    case 'ACTIVATION_FAILED':
    case 'PAID_REQUIRES_REVIEW':
      return 'review';
    default:
      // A terminal order whose provider outcome is unknown is not a failure and not a
      // cancellation: the payment may exist. No new payment is offered until it is resolved.
      if (
        order.activationErrorCode !== null &&
        UNKNOWN_DISPATCH_CODES.has(order.activationErrorCode)
      )
        return 'uncertain';
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
      return 'Банк отклонил оплату. Резидентство не оформлено.';
  }
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

export function shortOrderReference(orderId: string): string {
  return orderId.replace(/-/g, '').slice(-8).toUpperCase();
}
