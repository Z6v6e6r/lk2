/**
 * Booked-operation contract v3: subscription JOIN/CREATE with an explicit settlement.
 *
 * v2 remains valid and unchanged: zero-surcharge managed JOIN keeps using it. v3 adds only the
 * fields the owner needs to create or read a payment attempt (exact amount, checkout link,
 * payment deadline) and the two explicit cancellation outcomes. It is source-only until LK1
 * publishes the matching receiver; no LK2 caller uses it yet.
 *
 * State axes are deliberately separate. A payment can be PAID while a booking is still PENDING,
 * and a cancelled payment says nothing about a previously confirmed participation.
 */

export const BOOKED_OPERATION_V3_CONTRACT_VERSION = 3 as const;
export const BOOKED_OPERATION_V3_PREFLIGHT_PATH = '/lk/integrations/v3/booked-operation-preflights';
export const BOOKED_OPERATION_V3_ADMISSION_PATH = '/lk/integrations/v3/booked-operation-admissions';
export const BOOKED_OPERATION_V3_READ_PREFIX = '/lk/integrations/v3/booked-operations/';
export const BOOKED_OPERATION_V3_CANCEL_PREFIX = '/lk/integrations/v3/booked-operations/';

export type BookedOperationV3Action = 'JOIN_GAME' | 'CREATE_GAME';
export type BookedOperationV3PaymentIntent = 'USE_SUBSCRIPTION' | 'PAY_FULL_PRICE';
export type BookedOperationV3Basis = 'SUBSCRIPTION' | 'OWN_QUARTER' | 'WHOLE_COURT';
export type BookedOperationV3Duration = 60 | 90 | 120;
export type BookedOperationV3PaymentState = 'NOT_REQUIRED' | 'OPEN' | 'PAID' | 'CLOSED' | 'UNKNOWN';
export type BookedOperationV3BookingState =
  'NONE' | 'PENDING' | 'CONFIRMED' | 'CANCELLED' | 'UNKNOWN';
export type BookedOperationV3VisitState =
  'NOT_CONSUMED' | 'CONSUMED' | 'RETURNED' | 'NOT_APPLICABLE' | 'UNKNOWN';

export interface BookedOperationV3Target {
  readonly kind: 'GAME' | 'DRAFT_GAME';
  readonly id: string;
  readonly expectedRevision: number;
}

export interface BookedOperationV3Quote {
  readonly quoteId: string;
  readonly operationId: string;
  readonly basis: BookedOperationV3Basis;
  readonly durationMinutes: BookedOperationV3Duration;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly amountMinor: number;
  readonly currency: 'RUB';
  readonly coveredMinutes: number;
  readonly surchargeMinor: number;
  readonly expiresAt: string;
  readonly policyVersion: string;
  readonly priceDigest: string;
}

export interface BookedOperationV3Settlement {
  readonly mode: 'ZERO' | 'SURCHARGE';
  readonly currency: 'RUB';
  readonly toPayMinor: number;
  readonly checkoutUrl: string | null;
  readonly expiresAt: string | null;
  readonly state: BookedOperationV3PaymentState;
}

export interface BookedOperationV3PreflightRequest {
  readonly contractVersion: 3;
  readonly action: BookedOperationV3Action;
  readonly target: BookedOperationV3Target;
  readonly paymentIntent: BookedOperationV3PaymentIntent;
}

export interface BookedOperationV3PreflightResult {
  readonly contractVersion: 3;
  readonly nonBinding: true;
  readonly operationId: string;
  readonly action: BookedOperationV3Action;
  readonly target: BookedOperationV3Target;
  readonly quote: BookedOperationV3Quote | null;
  readonly settlement: BookedOperationV3Settlement | null;
}

export interface BookedOperationV3AdmissionRequest extends BookedOperationV3PreflightRequest {
  readonly settlementConsent: {
    readonly quoteId: string;
    readonly amountMinor: number;
    readonly currency: 'RUB';
  };
}

export interface BookedOperationV3ReadOutcome {
  readonly contractVersion: 3;
  readonly operationId: string;
  readonly status: 'PENDING' | 'UNKNOWN' | 'CONFIRMED' | 'CANCELLED';
  readonly asOf: string | null;
  readonly payment: {
    readonly state: BookedOperationV3PaymentState;
    readonly toPayMinor: number;
    readonly paidMinor: number;
    readonly checkoutUrl: string | null;
  };
  readonly booking: {
    readonly state: BookedOperationV3BookingState;
    readonly bookingRef?: string;
  };
  readonly visit: {
    readonly state: BookedOperationV3VisitState;
    readonly usageRef?: string;
  };
  readonly reason: string | null;
}

export interface BookedOperationV3CancelRequest {
  readonly contractVersion: 3;
  readonly operationId: string;
  readonly reason: 'USER_CANCEL';
}

export interface BookedOperationV3CancelResult {
  readonly contractVersion: 3;
  readonly operationId: string;
  readonly status: 'CLOSING' | 'CLOSED' | 'PAID' | 'UNKNOWN';
  readonly cancelled: boolean;
  readonly limitReleased: boolean;
  readonly visitReturned: boolean;
}

export class BookedOperationV3ContractError extends Error {
  public constructor(
    public readonly code:
      'BOOKED_OPERATION_V3_INPUT_INVALID' | 'BOOKED_OPERATION_V3_RESULT_INVALID',
  ) {
    super(code);
  }
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,199}$/;
const sha256Pattern = /^sha256:[a-f0-9]{64}$/;

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
function keys(value: unknown, names: string): value is Record<string, unknown> {
  return (
    isObject(value) && Object.keys(value).sort().join(',') === names.split(',').sort().join(',')
  );
}
function keysWithOptional(
  value: unknown,
  required: string,
  optional: string,
): value is Record<string, unknown> {
  if (!isObject(value)) return false;
  const requiredKeys = required.split(',');
  const allowed = new Set([...requiredKeys, ...optional.split(',')]);
  return (
    requiredKeys.every((key) => Object.prototype.hasOwnProperty.call(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key))
  );
}
function uuid(value: unknown): value is string {
  return typeof value === 'string' && uuidPattern.test(value) && value === value.toLowerCase();
}
function id(value: unknown): value is string {
  return typeof value === 'string' && idPattern.test(value);
}
function integer(value: unknown, min: number, max: number): value is number {
  return Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max;
}
function instant(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}
function httpsUrl(value: unknown): value is string {
  if (typeof value !== 'string' || !/^https:\/\/\S+$/.test(value)) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}
function invalid(): never {
  throw new BookedOperationV3ContractError('BOOKED_OPERATION_V3_INPUT_INVALID');
}
function invalidResult(): never {
  throw new BookedOperationV3ContractError('BOOKED_OPERATION_V3_RESULT_INVALID');
}

export function parseBookedOperationV3Target(value: unknown): BookedOperationV3Target {
  if (!keys(value, 'kind,id,expectedRevision')) invalid();
  if (value.kind !== 'GAME' && value.kind !== 'DRAFT_GAME') invalid();
  if (!uuid(value.id) || !integer(value.expectedRevision, 1, Number.MAX_SAFE_INTEGER)) invalid();
  return {
    kind: value.kind,
    id: value.id,
    expectedRevision: Number(value.expectedRevision),
  };
}

export function parseBookedOperationV3PreflightRequest(
  value: unknown,
): BookedOperationV3PreflightRequest {
  if (!keys(value, 'contractVersion,action,target,paymentIntent')) invalid();
  if (value.contractVersion !== 3) invalid();
  if (value.action !== 'JOIN_GAME' && value.action !== 'CREATE_GAME') invalid();
  if (value.paymentIntent !== 'USE_SUBSCRIPTION' && value.paymentIntent !== 'PAY_FULL_PRICE')
    invalid();
  return {
    contractVersion: 3,
    action: value.action,
    target: parseBookedOperationV3Target(value.target),
    paymentIntent: value.paymentIntent,
  };
}

export function parseBookedOperationV3Quote(value: unknown): BookedOperationV3Quote {
  if (
    !keys(
      value,
      'quoteId,operationId,basis,durationMinutes,startsAt,endsAt,amountMinor,currency,coveredMinutes,surchargeMinor,expiresAt,policyVersion,priceDigest',
    )
  )
    invalidResult();
  if (
    !uuid(value.quoteId) ||
    !uuid(value.operationId) ||
    !['SUBSCRIPTION', 'OWN_QUARTER', 'WHOLE_COURT'].includes(String(value.basis)) ||
    ![60, 90, 120].includes(Number(value.durationMinutes)) ||
    !instant(value.startsAt) ||
    !instant(value.endsAt) ||
    Date.parse(value.endsAt) <= Date.parse(value.startsAt) ||
    !integer(value.amountMinor, 0, Number.MAX_SAFE_INTEGER) ||
    value.currency !== 'RUB' ||
    !integer(value.coveredMinutes, 0, 120) ||
    !integer(value.surchargeMinor, 0, Number.MAX_SAFE_INTEGER) ||
    !instant(value.expiresAt) ||
    !id(value.policyVersion) ||
    !sha256Pattern.test(String(value.priceDigest))
  )
    invalidResult();
  return {
    quoteId: value.quoteId,
    operationId: value.operationId,
    basis: value.basis as BookedOperationV3Basis,
    durationMinutes: Number(value.durationMinutes) as BookedOperationV3Duration,
    startsAt: value.startsAt,
    endsAt: value.endsAt,
    amountMinor: Number(value.amountMinor),
    currency: 'RUB',
    coveredMinutes: Number(value.coveredMinutes),
    surchargeMinor: Number(value.surchargeMinor),
    expiresAt: value.expiresAt,
    policyVersion: value.policyVersion,
    priceDigest: value.priceDigest as string,
  };
}

export function parseBookedOperationV3Settlement(value: unknown): BookedOperationV3Settlement {
  if (!keys(value, 'mode,currency,toPayMinor,checkoutUrl,expiresAt,state')) invalidResult();
  if (
    (value.mode !== 'ZERO' && value.mode !== 'SURCHARGE') ||
    value.currency !== 'RUB' ||
    !integer(value.toPayMinor, 0, Number.MAX_SAFE_INTEGER) ||
    !['NOT_REQUIRED', 'OPEN', 'PAID', 'CLOSED', 'UNKNOWN'].includes(String(value.state)) ||
    (value.checkoutUrl !== null && !httpsUrl(value.checkoutUrl)) ||
    (value.expiresAt !== null && !instant(value.expiresAt)) ||
    (value.mode === 'ZERO' && value.toPayMinor !== 0) ||
    (value.mode === 'SURCHARGE' && value.toPayMinor <= 0) ||
    (value.state === 'OPEN' && (value.checkoutUrl === null || value.expiresAt === null))
  )
    invalidResult();
  return {
    mode: value.mode,
    currency: 'RUB',
    toPayMinor: Number(value.toPayMinor),
    checkoutUrl: value.checkoutUrl,
    expiresAt: value.expiresAt,
    state: value.state as BookedOperationV3PaymentState,
  };
}

export function parseBookedOperationV3PreflightResult(
  value: unknown,
): BookedOperationV3PreflightResult {
  if (!keys(value, 'contractVersion,nonBinding,operationId,action,target,quote,settlement'))
    invalidResult();
  if (value.contractVersion !== 3 || value.nonBinding !== true || !uuid(value.operationId))
    invalidResult();
  if (value.action !== 'JOIN_GAME' && value.action !== 'CREATE_GAME') invalidResult();
  return {
    contractVersion: 3,
    nonBinding: true,
    operationId: value.operationId,
    action: value.action,
    target: parseBookedOperationV3Target(value.target),
    quote: value.quote === null ? null : parseBookedOperationV3Quote(value.quote),
    settlement:
      value.settlement === null ? null : parseBookedOperationV3Settlement(value.settlement),
  };
}

export function parseBookedOperationV3AdmissionRequest(
  value: unknown,
): BookedOperationV3AdmissionRequest {
  if (!keys(value, 'contractVersion,action,target,paymentIntent,settlementConsent')) invalid();
  const base = parseBookedOperationV3PreflightRequest({
    contractVersion: value.contractVersion,
    action: value.action,
    target: value.target,
    paymentIntent: value.paymentIntent,
  });
  const consent = value.settlementConsent;
  if (!keys(consent, 'quoteId,amountMinor,currency')) invalid();
  if (
    !uuid(consent.quoteId) ||
    !integer(consent.amountMinor, 0, Number.MAX_SAFE_INTEGER) ||
    consent.currency !== 'RUB'
  )
    invalid();
  return {
    ...base,
    settlementConsent: {
      quoteId: consent.quoteId,
      amountMinor: Number(consent.amountMinor),
      currency: 'RUB',
    },
  };
}

export function parseBookedOperationV3ReadOutcome(value: unknown): BookedOperationV3ReadOutcome {
  if (!keys(value, 'contractVersion,operationId,status,asOf,payment,booking,visit,reason'))
    invalidResult();
  if (
    value.contractVersion !== 3 ||
    !uuid(value.operationId) ||
    !['PENDING', 'UNKNOWN', 'CONFIRMED', 'CANCELLED'].includes(String(value.status)) ||
    (value.asOf !== null && !instant(value.asOf)) ||
    !keys(value.payment, 'state,toPayMinor,paidMinor,checkoutUrl') ||
    !keysWithOptional(value.booking, 'state', 'bookingRef') ||
    !keysWithOptional(value.visit, 'state', 'usageRef') ||
    (value.reason !== null && !id(value.reason))
  )
    invalidResult();
  if (
    !['NOT_REQUIRED', 'OPEN', 'PAID', 'CLOSED', 'UNKNOWN'].includes(String(value.payment.state)) ||
    !integer(value.payment.toPayMinor, 0, Number.MAX_SAFE_INTEGER) ||
    !integer(value.payment.paidMinor, 0, Number.MAX_SAFE_INTEGER) ||
    (value.payment.checkoutUrl !== null && !httpsUrl(value.payment.checkoutUrl)) ||
    !['NONE', 'PENDING', 'CONFIRMED', 'CANCELLED', 'UNKNOWN'].includes(
      String(value.booking.state),
    ) ||
    (value.booking.bookingRef !== undefined && !id(value.booking.bookingRef)) ||
    !['NOT_CONSUMED', 'CONSUMED', 'RETURNED', 'NOT_APPLICABLE', 'UNKNOWN'].includes(
      String(value.visit.state),
    ) ||
    (value.visit.usageRef !== undefined && !id(value.visit.usageRef))
  )
    invalidResult();
  return {
    contractVersion: 3,
    operationId: value.operationId,
    status: value.status as BookedOperationV3ReadOutcome['status'],
    asOf: value.asOf,
    payment: {
      state: value.payment.state as BookedOperationV3PaymentState,
      toPayMinor: Number(value.payment.toPayMinor),
      paidMinor: Number(value.payment.paidMinor),
      checkoutUrl: value.payment.checkoutUrl,
    },
    booking: {
      state: value.booking.state as BookedOperationV3BookingState,
      ...(value.booking.bookingRef === undefined ? {} : { bookingRef: value.booking.bookingRef }),
    },
    visit: {
      state: value.visit.state as BookedOperationV3VisitState,
      ...(value.visit.usageRef === undefined ? {} : { usageRef: value.visit.usageRef }),
    },
    reason: value.reason,
  };
}

export function parseBookedOperationV3CancelRequest(
  value: unknown,
): BookedOperationV3CancelRequest {
  if (!keys(value, 'contractVersion,operationId,reason')) invalid();
  if (value.contractVersion !== 3 || !uuid(value.operationId) || value.reason !== 'USER_CANCEL')
    invalid();
  return { contractVersion: 3, operationId: value.operationId, reason: 'USER_CANCEL' };
}

export function parseBookedOperationV3CancelResult(value: unknown): BookedOperationV3CancelResult {
  if (!keys(value, 'contractVersion,operationId,status,cancelled,limitReleased,visitReturned'))
    invalidResult();
  if (
    value.contractVersion !== 3 ||
    !uuid(value.operationId) ||
    !['CLOSING', 'CLOSED', 'PAID', 'UNKNOWN'].includes(String(value.status)) ||
    typeof value.cancelled !== 'boolean' ||
    typeof value.limitReleased !== 'boolean' ||
    typeof value.visitReturned !== 'boolean'
  )
    invalidResult();
  return {
    contractVersion: 3,
    operationId: value.operationId,
    status: value.status as BookedOperationV3CancelResult['status'],
    cancelled: value.cancelled,
    limitReleased: value.limitReleased,
    visitReturned: value.visitReturned,
  };
}
