import { createHash } from 'node:crypto';

import type { CreateStoredGameInput, CreateStoredGameResult } from '@phub/database';
import { bookedOperationAdmissionId } from '@phub/subscription-runtime-adapter';

/**
 * Managed commercial CREATE orchestration (WARN contour).
 *
 * The client never decides identity, tenant, price or the commercial outcome. The server:
 *   1. derives a stable draft game id and operation id from verified claims and the request key,
 *   2. takes a server-owned advisory (WARN) quote through the owner port,
 *   3. requires an explicit echo of an authoritative price when the owner supplies one,
 *   4. creates the local PROVISIONING game under the existing write-owner lock and idempotency row,
 *   5. asks the owner to reserve exactly that operation without a replacement POST on a repeat,
 *   6. keeps an unresolved outcome UNKNOWN instead of FAILED and never reports financial success
 *      without a trusted receipt.
 *
 * In WARN the owner is advisory: it never reserves, charges or books, and the created game stays
 * PROVISIONING with a PENDING operation. `OFF` never reaches this module.
 *
 * Contract and decision record: docs/contracts/game-commercial-create.md.
 */

export type CommercialCreateFailureCode =
  | 'GAME_PAYMENT_MODE_MISMATCH'
  | 'GAME_PRICE_CONFIRMATION_REQUIRED'
  | 'GAME_SUBSCRIPTION_SELECTION_REQUIRED'
  | 'GAME_SERVICE_BLOCKED'
  | 'GAME_RECONCILIATION_REQUIRED'
  | 'GAME_COMMERCIAL_ATTEMPT_CONFLICT'
  | 'GAME_OWNER_UNAVAILABLE'
  | 'GAME_NOT_FOUND'
  | 'GAME_PAYMENT_REQUIRED';

/** Payment modes the managed contour can represent. Anything else is a managed refusal. */
export type CommercialCreatePaymentMode = 'SPLIT' | 'SUBSCRIPTION';
const MANAGED_CREATE_PAYMENT_MODES: readonly CommercialCreatePaymentMode[] = [
  'SPLIT',
  'SUBSCRIPTION',
];

export function isManagedCreatePaymentMode(
  paymentMode: string,
): paymentMode is CommercialCreatePaymentMode {
  return (MANAGED_CREATE_PAYMENT_MODES as readonly string[]).includes(paymentMode);
}

export interface CommercialCreatePriceConsent {
  readonly amountMinor: number;
  readonly currency: 'RUB';
}

export interface CommercialCreatePriceSnapshot {
  readonly amountMinor: number;
  readonly currency: 'RUB';
  readonly expiresAt: string;
}

export type CommercialCreateQuoteOutcome =
  | 'ALLOWED'
  | 'SERVICE_BLOCKED'
  | 'SUBSCRIPTION_SELECTION_REQUIRED'
  | 'PRICE_CONFIRMATION_REQUIRED'
  | 'UNAVAILABLE';

/**
 * Advisory or authoritative server-side quote. `basis = ADVISORY` is the WARN observation: it can
 * never block or price the create. `basis = OWNER` is the future authoritative owner decision and
 * the only basis that can demand a price echo.
 */
export interface CommercialCreateQuote {
  readonly basis: 'ADVISORY' | 'OWNER';
  readonly decisionId: string;
  readonly outcome: CommercialCreateQuoteOutcome;
  readonly price: CommercialCreatePriceSnapshot | null;
  readonly reasonCodes: readonly string[];
  readonly evaluatedAt: string;
  readonly expiresAt: string;
}

/** Everything the owner sees about one create. Built only from verified claims and request data. */
export interface CommercialCreateOwnerRequest {
  readonly tenantId: string;
  readonly tenantKey: string;
  readonly userId: string;
  readonly sessionId: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
  readonly operationId: string;
  readonly draftGameId: string;
  readonly expectedRevision: number;
  readonly paymentMode: CommercialCreatePaymentMode;
  readonly paymentIntent: 'USE_SUBSCRIPTION' | 'AUTO_BEST_PRICE' | 'PAY_FULL_PRICE';
  readonly stationId: string;
  readonly courtId?: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly timezone: string;
  readonly capacity: number;
  readonly kind: string;
  readonly visibility: string;
  readonly preferredSubscriptionInstanceId?: string;
  readonly priceConsent?: CommercialCreatePriceConsent;
}

export type CommercialCreateOwnerOutcome =
  | { readonly status: 'SKIPPED_ADVISORY'; readonly reason: string }
  | { readonly status: 'PENDING' }
  | { readonly status: 'UNKNOWN' }
  | { readonly status: 'REJECTED'; readonly code: CommercialCreateFailureCode };

/**
 * Public-safe view of a trusted owner receipt. The LK1 receipt identity fields (receiptId,
 * appliedRule, usageRef, bookingRef) stay inside the owner transport and are never exposed to a
 * browser or mobile client; only the provider confirmation and its instant are public.
 */
export interface CommercialCreateReceiptView {
  readonly provider: 'VIVA';
  readonly status: 'CONFIRMED';
  readonly confirmedAt: string;
}

export interface CommercialCreateOwnerReadOutcome {
  readonly status: 'PENDING' | 'UNKNOWN' | 'CONFIRMED';
  readonly receipt?: CommercialCreateReceiptView;
}

/**
 * Port onto the existing owner of booking/entitlement. Implementations must be idempotent by
 * `operationId` and must never be retried with a replacement key by LK2.
 */
export interface CommercialCreateOwnerPort {
  quote(input: CommercialCreateOwnerRequest): Promise<CommercialCreateQuote>;
  reserve(
    input: CommercialCreateOwnerRequest & { readonly quote: CommercialCreateQuote | null },
  ): Promise<CommercialCreateOwnerOutcome>;
  read?(input: {
    readonly tenantId: string;
    readonly tenantKey: string;
    readonly userId: string;
    readonly sessionId: string;
    readonly correlationId: string;
    readonly operationId: string;
  }): Promise<CommercialCreateOwnerReadOutcome | null>;
  release?(input: {
    readonly tenantId: string;
    readonly tenantKey: string;
    readonly userId: string;
    readonly sessionId: string;
    readonly correlationId: string;
    readonly operationId: string;
    readonly reason: 'LOCAL_WRITE_REJECTED' | 'RECONCILIATION';
  }): Promise<void>;
}

/** Write-owner port; the local repository keeps its single-writer lock and idempotency row. */
export interface CommercialCreateRepositoryPort {
  create(input: CreateStoredGameInput): Promise<CreateStoredGameResult>;
}

export type CommercialCreateGamePayload = Omit<
  CreateStoredGameInput,
  | 'tenantId'
  | 'actorUserId'
  | 'idempotencyKey'
  | 'requestHash'
  | 'correlationId'
  | 'gameId'
  | 'operationId'
>;

export interface CommercialCreateCommandEnvelope {
  readonly tenantId: string;
  readonly tenantKey: string;
  readonly userId: string;
  readonly sessionId: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
  readonly idempotencyKeySha256: string;
  readonly payload: CommercialCreateGamePayload;
  readonly subscriptionInstanceId?: string;
  readonly priceConsent?: CommercialCreatePriceConsent;
}

export interface CommercialCreateDependencies {
  readonly repository: CommercialCreateRepositoryPort;
  readonly owner: CommercialCreateOwnerPort;
  readonly now?: () => number;
  readonly reconciliationRetryAfterSeconds?: number;
  readonly onQuoteFailure?: (code: string) => void;
  readonly onOwnerFailure?: (code: string) => void;
}

export type CommercialCreateAttemptState =
  'NOT_ATTEMPTED' | 'WARN_OBSERVED' | 'OWNER_PENDING' | 'OWNER_CONFIRMED' | 'UNKNOWN' | 'FAILED';

export interface CommercialCreateQuoteView {
  readonly basis: 'ADVISORY' | 'OWNER';
  readonly decisionId: string;
  readonly outcome: CommercialCreateQuoteOutcome;
  readonly price: CommercialCreatePriceSnapshot | null;
  readonly reasonCodes: readonly string[];
  readonly evaluatedAt: string;
  readonly expiresAt: string;
}

export interface CommercialCreateCommercialView {
  readonly attemptState: CommercialCreateAttemptState;
  readonly quote: CommercialCreateQuoteView | null;
  readonly price: {
    readonly amountMinor: number;
    readonly currency: 'RUB';
    readonly consent: 'SETTLED' | 'REQUIRED';
  } | null;
  readonly reservation: {
    readonly id: string;
    readonly state: 'ACTIVE' | 'CONFIRMED' | 'EXPIRED' | 'CANCELLED';
    readonly expiresAt: string;
  } | null;
  readonly receipt: CommercialCreateReceiptView | null;
  readonly reason: string | null;
}

export type CommercialCreateOperationStatus = 'PROCESSING' | 'UNKNOWN' | 'SUCCEEDED' | 'FAILED';

export interface CommercialCreateResponseBody {
  readonly commandId: string;
  readonly operation: {
    readonly id: string;
    readonly type: 'CREATE_GAME';
    readonly status: CommercialCreateOperationStatus;
    readonly gameId: string | null;
    readonly aggregateRevision: number | null;
    readonly createdAt: string;
    readonly updatedAt: string;
    readonly nextAction:
      | { readonly type: 'NONE' }
      | { readonly type: 'WAIT_FOR_RECONCILIATION'; readonly retryAfterSeconds: number };
    readonly error: { readonly code: string; readonly message: string } | null;
    readonly commercial: CommercialCreateCommercialView;
  };
  readonly game: null;
  readonly replayed: boolean;
}

export type CommercialCreateResult =
  | { readonly kind: 'accepted'; readonly body: CommercialCreateResponseBody }
  | {
      readonly kind: 'failed';
      readonly code: CommercialCreateFailureCode;
      readonly message: string;
    }
  | {
      /** Stable local-writer rejections keep their existing route mapping (400). */
      readonly kind: 'create_rejected';
      readonly code: 'GAME_LOCATION_INVALID' | 'GAME_START_TIME_PASSED';
    };

export const COMMERCIAL_CREATE_FAILURE_MESSAGES: Readonly<
  Record<CommercialCreateFailureCode, string>
> = {
  GAME_PAYMENT_MODE_MISMATCH: 'Этот режим оплаты игры сейчас недоступен.',
  GAME_PRICE_CONFIRMATION_REQUIRED:
    'Цена игры изменилась или ещё не подтверждена. Подтвердите актуальную цену.',
  GAME_SUBSCRIPTION_SELECTION_REQUIRED: 'Выберите подписку, по которой хотите создать игру.',
  GAME_SERVICE_BLOCKED: 'Эта услуга недоступна по правилам клуба; оплата не снимает запрет.',
  GAME_RECONCILIATION_REQUIRED:
    'Предыдущая попытка ещё не завершена. Дождитесь проверки статуса, новую оплату не начинайте.',
  GAME_COMMERCIAL_ATTEMPT_CONFLICT:
    'Ключ операции уже использован для другой команды. Проверьте статус исходной операции.',
  GAME_OWNER_UNAVAILABLE: 'Статус операции не подтверждён владельцем. Сохраняем попытку.',
  GAME_NOT_FOUND: 'Игра не найдена.',
  GAME_PAYMENT_REQUIRED: 'Платёжный контур этой игры пока недоступен.',
};

export function commercialCreateFailure(
  code: CommercialCreateFailureCode,
): Extract<CommercialCreateResult, { kind: 'failed' }> {
  return { kind: 'failed', code, message: COMMERCIAL_CREATE_FAILURE_MESSAGES[code] };
}

export function isCommercialCreateFailureCode(value: string): value is CommercialCreateFailureCode {
  return Object.hasOwn(COMMERCIAL_CREATE_FAILURE_MESSAGES, value);
}

/**
 * Stable draft game id derived only from verified claims and the request key. A retry with the same
 * `Idempotency-Key` names the same draft, so the owner never sees a second target for one create.
 */
export function commercialCreateDraftGameId(input: {
  readonly tenantId: string;
  readonly userId: string;
  readonly idempotencyKeySha256: string;
}): string {
  const hex = createHash('sha256')
    .update(
      `game-commercial-create:v1\0draft-game-id\0${input.tenantId}\0${input.userId}\0${input.idempotencyKeySha256}`,
      'utf8',
    )
    .digest('hex')
    .slice(0, 32)
    .split('');
  hex[12] = '8';
  hex[16] = ((parseInt(hex[16]!, 16) & 3) | 8).toString(16);
  const value = hex.join('');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

/** Owner-visible operation id: one request key can only ever name one commercial operation. */
export function commercialCreateOperationId(input: {
  readonly tenantId: string;
  readonly userId: string;
  readonly idempotencyKeySha256: string;
}): string {
  return bookedOperationAdmissionId(input.tenantId, input.userId, input.idempotencyKeySha256);
}

/** Fingerprint of the whole commercial create request; a repeat must match it exactly. */
export function commercialCreateRequestHash(
  input: CommercialCreateCommandEnvelope,
  options: { readonly joinCutoffAt: string },
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        command: 'CREATE_GAME',
        contract: 'game.create.commercial.v1',
        tenantId: input.tenantId,
        userId: input.userId,
        payload: input.payload,
        joinCutoffAt: options.joinCutoffAt,
        subscriptionInstanceId: input.subscriptionInstanceId ?? null,
        priceConsent: input.priceConsent ?? null,
      }),
    )
    .digest('hex');
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function instant(value: string): boolean {
  return Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

const attemptStates: readonly CommercialCreateAttemptState[] = [
  'NOT_ATTEMPTED',
  'WARN_OBSERVED',
  'OWNER_PENDING',
  'OWNER_CONFIRMED',
  'UNKNOWN',
  'FAILED',
];
const reservationStates = ['ACTIVE', 'CONFIRMED', 'EXPIRED', 'CANCELLED'] as const;
const reasonCodeShape = /^[A-Z][A-Z0-9_]{2,127}$/;

function isValidCommercialView(view: CommercialCreateCommercialView): boolean {
  const price = view.price;
  const reservation = view.reservation;
  const receipt = view.receipt;
  return (
    attemptStates.includes(view.attemptState) &&
    (view.quote === null || isPublishableCreateQuote(view.quote)) &&
    (price === null ||
      (typeof price === 'object' &&
        Object.keys(price).sort().join() === 'amountMinor,consent,currency' &&
        Number.isSafeInteger(price.amountMinor) &&
        price.amountMinor >= 0 &&
        price.currency === 'RUB' &&
        (price.consent === 'SETTLED' || price.consent === 'REQUIRED'))) &&
    (reservation === null ||
      (typeof reservation === 'object' &&
        Object.keys(reservation).sort().join() === 'expiresAt,id,state' &&
        UUID_PATTERN.test(reservation.id) &&
        (reservationStates as readonly string[]).includes(reservation.state) &&
        instant(reservation.expiresAt))) &&
    (receipt === null ||
      (typeof receipt === 'object' &&
        Object.keys(receipt).sort().join() === 'confirmedAt,provider,status' &&
        receipt.provider === 'VIVA' &&
        receipt.status === 'CONFIRMED' &&
        instant(receipt.confirmedAt))) &&
    (view.reason === null || (typeof view.reason === 'string' && reasonCodeShape.test(view.reason)))
  );
}

/** Internal response-shape guard: a malformed operation body must never reach the public API. */
export function assertValidCommercialCreateBody(body: CommercialCreateResponseBody): void {
  const { operation } = body;
  if (
    !UUID_PATTERN.test(body.commandId) ||
    operation.id !== body.commandId ||
    operation.type !== 'CREATE_GAME' ||
    !['PROCESSING', 'UNKNOWN', 'SUCCEEDED', 'FAILED'].includes(operation.status) ||
    (operation.gameId !== null && !UUID_PATTERN.test(operation.gameId)) ||
    (operation.aggregateRevision !== null &&
      (!Number.isSafeInteger(operation.aggregateRevision) || operation.aggregateRevision < 0)) ||
    !instant(operation.createdAt) ||
    !instant(operation.updatedAt) ||
    body.game !== null ||
    !isValidCommercialView(operation.commercial) ||
    (operation.status === 'FAILED') !== (operation.error !== null) ||
    // Only a trusted receipt may present an operation as financially succeeded.
    (operation.status === 'SUCCEEDED' && operation.commercial.receipt === null) ||
    (operation.status === 'UNKNOWN') !== (operation.nextAction.type === 'WAIT_FOR_RECONCILIATION')
  ) {
    throw new Error('GAME_COMMERCIAL_CREATE_RESPONSE_INVALID');
  }
}

const quoteBases = ['ADVISORY', 'OWNER'] as const;
const quoteOutcomes: readonly CommercialCreateQuoteOutcome[] = [
  'ALLOWED',
  'SERVICE_BLOCKED',
  'SUBSCRIPTION_SELECTION_REQUIRED',
  'PRICE_CONFIRMATION_REQUIRED',
  'UNAVAILABLE',
];
const decisionIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,199}$/;
const reasonCodePattern = /^[A-Z][A-Z0-9_]{2,127}$/;

function validPriceSnapshot(price: unknown): price is CommercialCreatePriceSnapshot {
  if (typeof price !== 'object' || price === null || Array.isArray(price)) return false;
  const record = price as Record<string, unknown>;
  return (
    Object.keys(record).sort().join() === 'amountMinor,currency,expiresAt' &&
    Number.isSafeInteger(record.amountMinor) &&
    Number(record.amountMinor) >= 0 &&
    record.currency === 'RUB' &&
    typeof record.expiresAt === 'string' &&
    instant(record.expiresAt)
  );
}

/** True when the owner supplied a structurally valid quote that may be published as evidence. */
export function isPublishableCreateQuote(value: unknown): value is CommercialCreateQuote {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const quote = value as Record<string, unknown>;
  if (
    Object.keys(quote).sort().join() !==
      'basis,decisionId,evaluatedAt,expiresAt,outcome,price,reasonCodes' ||
    !(quoteBases as readonly unknown[]).includes(quote.basis) ||
    typeof quote.decisionId !== 'string' ||
    !decisionIdPattern.test(quote.decisionId) ||
    !(quoteOutcomes as readonly unknown[]).includes(quote.outcome) ||
    typeof quote.evaluatedAt !== 'string' ||
    typeof quote.expiresAt !== 'string' ||
    !instant(quote.evaluatedAt) ||
    !instant(quote.expiresAt) ||
    Date.parse(quote.expiresAt) <= Date.parse(quote.evaluatedAt) ||
    !Array.isArray(quote.reasonCodes) ||
    quote.reasonCodes.length > 32 ||
    !quote.reasonCodes.every((code) => typeof code === 'string' && reasonCodePattern.test(code)) ||
    new Set(quote.reasonCodes).size !== quote.reasonCodes.length
  )
    return false;
  return quote.price === null || validPriceSnapshot(quote.price);
}

/**
 * Only a strictly validated quote is published. A defective owner object is dropped instead of
 * leaking unknown fields or an unbacked price/decision into the public operation body.
 */
function quoteView(quote: CommercialCreateQuote | null): CommercialCreateQuoteView | null {
  if (quote === null || !isPublishableCreateQuote(quote)) return null;
  return {
    basis: quote.basis,
    decisionId: quote.decisionId,
    outcome: quote.outcome,
    price: quote.price === null ? null : { ...quote.price },
    reasonCodes: [...quote.reasonCodes],
    evaluatedAt: quote.evaluatedAt,
    expiresAt: quote.expiresAt,
  };
}

function settledPrice(
  quote: CommercialCreateQuote | null,
  consent: CommercialCreatePriceConsent | undefined,
): CommercialCreateCommercialView['price'] {
  if (quote === null || quote.basis !== 'OWNER' || quote.price === null) return null;
  return {
    amountMinor: quote.price.amountMinor,
    currency: 'RUB',
    consent: consent === undefined ? 'REQUIRED' : 'SETTLED',
  };
}

function operationBody(input: {
  readonly operationId: string;
  readonly status: CommercialCreateOperationStatus;
  readonly gameId: string | null;
  readonly revision: number | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly retryAfterSeconds?: number;
  readonly commercial: CommercialCreateCommercialView;
  readonly replayed: boolean;
}): CommercialCreateResponseBody {
  const body: CommercialCreateResponseBody = {
    commandId: input.operationId,
    operation: {
      id: input.operationId,
      type: 'CREATE_GAME',
      status: input.status,
      gameId: input.gameId,
      aggregateRevision: input.revision,
      createdAt: input.createdAt,
      updatedAt: input.updatedAt,
      nextAction:
        input.retryAfterSeconds === undefined
          ? { type: 'NONE' }
          : { type: 'WAIT_FOR_RECONCILIATION', retryAfterSeconds: input.retryAfterSeconds },
      error:
        input.status === 'FAILED'
          ? { code: 'GAME_RECONCILIATION_REQUIRED', message: 'Операция не завершена.' }
          : null,
      commercial: input.commercial,
    },
    game: null,
    replayed: input.replayed,
  };
  assertValidCommercialCreateBody(body);
  return body;
}

function ownerRequestFromEnvelope(
  input: CommercialCreateCommandEnvelope,
): CommercialCreateOwnerRequest {
  return {
    tenantId: input.tenantId,
    tenantKey: input.tenantKey,
    userId: input.userId,
    sessionId: input.sessionId,
    correlationId: input.correlationId,
    idempotencyKey: input.idempotencyKey,
    operationId: commercialCreateOperationId(input),
    draftGameId: commercialCreateDraftGameId(input),
    expectedRevision: 1,
    paymentMode: input.payload.paymentMode as CommercialCreatePaymentMode,
    paymentIntent:
      input.subscriptionInstanceId === undefined ? 'AUTO_BEST_PRICE' : 'USE_SUBSCRIPTION',
    stationId: input.payload.stationId,
    ...(input.payload.courtId === undefined ? {} : { courtId: input.payload.courtId }),
    startsAt: input.payload.startsAt,
    endsAt: input.payload.endsAt,
    timezone: input.payload.timezone,
    capacity: input.payload.capacity,
    kind: input.payload.kind,
    visibility: input.payload.visibility,
    ...(input.subscriptionInstanceId === undefined
      ? {}
      : { preferredSubscriptionInstanceId: input.subscriptionInstanceId }),
    ...(input.priceConsent === undefined ? {} : { priceConsent: input.priceConsent }),
  };
}

/**
 * Executes one managed commercial CREATE. Advisory (WARN) quotes never change the writer result;
 * an authoritative owner quote can refuse it or demand a price echo before any local write.
 */
export async function executeCommercialCreate(
  input: CommercialCreateCommandEnvelope,
  dependencies: CommercialCreateDependencies,
): Promise<CommercialCreateResult> {
  const now = dependencies.now ?? Date.now;
  const retryAfter = dependencies.reconciliationRetryAfterSeconds ?? 5;

  if (!isManagedCreatePaymentMode(input.payload.paymentMode))
    return commercialCreateFailure('GAME_PAYMENT_MODE_MISMATCH');

  const ownerRequest = ownerRequestFromEnvelope(input);
  let quote: CommercialCreateQuote | null = null;
  try {
    quote = await dependencies.owner.quote(ownerRequest);
  } catch {
    // A quote failure is an observation problem, never a silent price authority. In WARN the
    // advisory quote cannot block the create; the local writer and the response below stay the
    // same and the failure is only observable through the metric callback.
    dependencies.onQuoteFailure?.('GAME_COMMERCIAL_CREATE_QUOTE_UNAVAILABLE');
  }

  if (quote !== null && quote.basis === 'OWNER') {
    // An authoritative decision must be structurally valid before it can refuse, price or demand a
    // consent. A malformed owner quote fails closed instead of being interpreted.
    if (!isPublishableCreateQuote(quote)) {
      dependencies.onQuoteFailure?.('GAME_OWNER_UNAVAILABLE');
      return commercialCreateFailure('GAME_OWNER_UNAVAILABLE');
    }
    if (quote.outcome === 'SERVICE_BLOCKED') return commercialCreateFailure('GAME_SERVICE_BLOCKED');
    if (quote.outcome === 'SUBSCRIPTION_SELECTION_REQUIRED')
      return commercialCreateFailure('GAME_SUBSCRIPTION_SELECTION_REQUIRED');
    if (quote.outcome === 'UNAVAILABLE') {
      dependencies.onQuoteFailure?.('GAME_OWNER_UNAVAILABLE');
      return commercialCreateFailure('GAME_OWNER_UNAVAILABLE');
    }
    if (quote.outcome === 'PRICE_CONFIRMATION_REQUIRED')
      return commercialCreateFailure('GAME_PRICE_CONFIRMATION_REQUIRED');
    if (quote.price !== null) {
      // Both timelines are authoritative: the decision window and the price snapshot it carries.
      // A closed window forces a fresh consent instead of honouring a stale amount.
      if (Date.parse(quote.expiresAt) <= now() || Date.parse(quote.price.expiresAt) <= now())
        return commercialCreateFailure('GAME_PRICE_CONFIRMATION_REQUIRED');
      if (input.priceConsent === undefined)
        return commercialCreateFailure('GAME_PRICE_CONFIRMATION_REQUIRED');
      if (
        input.priceConsent.amountMinor !== quote.price.amountMinor ||
        input.priceConsent.currency !== 'RUB'
      )
        return commercialCreateFailure('GAME_PRICE_CONFIRMATION_REQUIRED');
    }
  }

  const joinCutoffAt = new Date(Date.parse(input.payload.startsAt) - 30 * 60_000).toISOString();
  let created: CreateStoredGameResult;
  try {
    created = await dependencies.repository.create({
      ...input.payload,
      tenantId: input.tenantId,
      actorUserId: input.userId,
      idempotencyKey: input.idempotencyKey,
      requestHash: commercialCreateRequestHash(input, { joinCutoffAt }),
      correlationId: input.correlationId,
      joinCutoffAt,
      gameId: ownerRequest.draftGameId,
      operationId: ownerRequest.operationId,
    });
  } catch {
    dependencies.onOwnerFailure?.('GAME_CREATE_WRITE_UNAVAILABLE');
    return commercialCreateFailure('GAME_OWNER_UNAVAILABLE');
  }

  if (created.outcome === 'idempotency_conflict')
    return commercialCreateFailure('GAME_COMMERCIAL_ATTEMPT_CONFLICT');
  if (created.outcome === 'rejected') return { kind: 'create_rejected', code: created.code };
  // The write owner must have used exactly the server-derived draft identity; otherwise the
  // advertised operation id could never be read back and a second target would exist silently.
  if (
    created.gameId !== ownerRequest.draftGameId ||
    created.operationId !== ownerRequest.operationId
  ) {
    dependencies.onOwnerFailure?.('GAME_CREATE_DRAFT_ID_MISMATCH');
    return commercialCreateFailure('GAME_OWNER_UNAVAILABLE');
  }

  const commercialBase: CommercialCreateCommercialView = {
    attemptState: 'NOT_ATTEMPTED',
    quote: quoteView(quote),
    price: settledPrice(quote, input.priceConsent),
    reservation: null,
    receipt: null,
    reason: null,
  };

  if (created.replayed) {
    // A repeat never dispatches a replacement owner POST. The readback path reports the outcome.
    return {
      kind: 'accepted',
      body: operationBody({
        operationId: ownerRequest.operationId,
        status: 'UNKNOWN',
        gameId: created.gameId,
        revision: created.revision,
        createdAt: created.committedAt,
        updatedAt: created.committedAt,
        retryAfterSeconds: retryAfter,
        commercial: {
          ...commercialBase,
          attemptState: 'UNKNOWN',
          reason: 'GAME_RECONCILIATION_REQUIRED',
        },
        replayed: true,
      }),
    };
  }

  let outcome: CommercialCreateOwnerOutcome;
  try {
    outcome = await dependencies.owner.reserve({ ...ownerRequest, quote });
  } catch {
    // An accepted-but-unanswered owner call keeps the attempt unresolved: never FAILED, never a
    // replacement POST, and the local PROVISIONING game remains PENDING for reconciliation.
    outcome = { status: 'UNKNOWN' };
  }

  if (outcome.status === 'REJECTED') {
    dependencies.onOwnerFailure?.(outcome.code);
    // The local PROVISIONING aggregate is already durable and intentionally not deleted here: a
    // refund/compensation decision belongs to the future owner contract, not to WARN.
    return commercialCreateFailure(outcome.code);
  }

  if (outcome.status === 'PENDING') {
    return {
      kind: 'accepted',
      body: operationBody({
        operationId: ownerRequest.operationId,
        status: 'PROCESSING',
        gameId: created.gameId,
        revision: created.revision,
        createdAt: created.committedAt,
        updatedAt: created.committedAt,
        commercial: { ...commercialBase, attemptState: 'OWNER_PENDING' },
        replayed: false,
      }),
    };
  }

  if (outcome.status === 'SKIPPED_ADVISORY') {
    return {
      kind: 'accepted',
      body: operationBody({
        operationId: ownerRequest.operationId,
        status: 'UNKNOWN',
        gameId: created.gameId,
        revision: created.revision,
        createdAt: created.committedAt,
        updatedAt: created.committedAt,
        retryAfterSeconds: retryAfter,
        commercial: { ...commercialBase, attemptState: 'WARN_OBSERVED' },
        replayed: false,
      }),
    };
  }

  return {
    kind: 'accepted',
    body: operationBody({
      operationId: ownerRequest.operationId,
      status: 'UNKNOWN',
      gameId: created.gameId,
      revision: created.revision,
      createdAt: created.committedAt,
      updatedAt: created.committedAt,
      retryAfterSeconds: retryAfter,
      commercial: {
        ...commercialBase,
        attemptState: 'UNKNOWN',
        reason: 'GAME_RECONCILIATION_REQUIRED',
      },
      replayed: false,
    }),
  };
}

/**
 * Readback of a paid create whose local operation is still PENDING. Read-only: it never reserves,
 * confirms, releases, retries a POST or reports FAILED for an unresolved attempt.
 */
export function readCommercialCreateOperation(input: {
  readonly operationId: string;
  readonly gameId: string;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly retryAfterSeconds?: number;
}): CommercialCreateResponseBody {
  return operationBody({
    operationId: input.operationId,
    status: 'UNKNOWN',
    gameId: input.gameId,
    revision: input.revision,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
    retryAfterSeconds: input.retryAfterSeconds ?? 5,
    commercial: {
      attemptState: 'UNKNOWN',
      quote: null,
      price: null,
      reservation: null,
      receipt: null,
      reason: 'GAME_RECONCILIATION_REQUIRED',
    },
    replayed: true,
  });
}
