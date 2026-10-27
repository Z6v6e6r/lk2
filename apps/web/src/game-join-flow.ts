/**
 * Pure state machine for the paid JOIN client flow.
 *
 * The server owns identity, product and price. The client only echoes an explicit consent for the
 * exact server amount it displayed. This module contains no network, no timers and no storage, so the
 * rules below are testable in isolation and are the single source of truth for the UI.
 *
 * Non-negotiable rules encoded here:
 * - SUCCEEDED requires a trusted server signal (`commercial.receipt` or `attemptState OWNER_CONFIRMED`)
 *   for a paid JOIN; an owner "HTTP 200" or a bare `SUCCEEDED` status is not enough;
 * - a changed price never becomes consent automatically: stale consent is rejected and the new server
 *   amount must be shown for a fresh explicit tap;
 * - UNKNOWN / WAIT_FOR_RECONCILIATION keeps custody and offers readback only — it never offers a
 *   replacement purchase;
 * - service-blocked, payment-unavailable and price-consent-required are distinct outcomes;
 * - NO_PAYMENT join is untouched and never requires consent.
 *
 * Contract types are declared locally as structural views of HANDOFF-C1 §2 and the C1 contract
 * (`GameJoinConditions`, `GameCommandResult`, `GameOperationCommercial`). Regenerated
 * `@phub/api-contracts` types are an ignored build artifact, so these readers stay tolerant of a
 * deployment whose generated types lag the public contract. Reconcile with C1 if the shape changes.
 */
import { GAME_JOIN_ATTEMPT_QUIET_MS, type GameJoinPriceConsent } from './game-join-attempt.js';

export type GameJoinOperationStatus =
  'ACCEPTED' | 'PROCESSING' | 'UNKNOWN' | 'SUCCEEDED' | 'FAILED';

export type GameJoinAttemptState =
  'NOT_ATTEMPTED' | 'DISPATCH_STARTED' | 'OWNER_PENDING' | 'OWNER_CONFIRMED' | 'UNKNOWN' | 'FAILED';

export interface GameJoinOperationCommercialView {
  readonly attemptState: GameJoinAttemptState;
  readonly receipt: {
    readonly provider: 'VIVA';
    readonly status: 'CONFIRMED';
    readonly confirmedAt: string;
  } | null;
  readonly reason: string | null;
}

export interface GameJoinOperationView {
  readonly id: string;
  readonly status: GameJoinOperationStatus;
  readonly gameId: string | null;
  readonly aggregateRevision: number | null;
  readonly nextAction:
    | { readonly type: 'NONE' }
    | { readonly type: 'OPEN_PAYMENT'; readonly url: string }
    | { readonly type: 'WAIT_FOR_RECONCILIATION'; readonly retryAfterSeconds: number };
  readonly error: { readonly code: string; readonly message: string } | null;
  readonly commercial: GameJoinOperationCommercialView | null;
}

export interface GameJoinCommandResultView {
  readonly commandId: string;
  readonly operation: GameJoinOperationView;
  readonly replayed: boolean;
}

export interface GameJoinConditionsPriceView {
  readonly status: 'ADVISORY' | 'MISSING';
  readonly amountMinor: number | null;
  readonly currency: 'RUB';
  readonly confirmed: boolean;
}

export interface GameJoinConditionsView {
  readonly gameId: string;
  readonly revision: number;
  readonly subscriptionInstanceId: string;
  readonly eligibility: 'AVAILABLE' | 'UNAVAILABLE' | 'LIMIT_USED';
  readonly reasonCode: string | null;
  readonly subscriptionApplied: boolean;
  readonly price: GameJoinConditionsPriceView;
  readonly expiresAt: string;
  readonly requiresPriceConsent: boolean;
}

export type GameJoinFlowState =
  | { readonly kind: 'IDLE' }
  | { readonly kind: 'CHECKING_CONDITIONS'; readonly reason: 'USER_REQUEST' | 'PRICE_CHANGED' }
  | { readonly kind: 'NEEDS_SUBSCRIPTION'; readonly message: string }
  | {
      readonly kind: 'NEEDS_CONSENT';
      readonly expiresAt: string;
      readonly revision: number;
      readonly consent: GameJoinPriceConsent;
      readonly subscriptionInstanceId: string;
      readonly message: string;
    }
  | { readonly kind: 'DISPATCHING' }
  | { readonly kind: 'CONFIRMED_UPDATING' }
  | {
      readonly kind: 'WAIT_FOR_RECONCILIATION';
      readonly reason: 'UNKNOWN' | 'OWNER_PENDING' | 'UNVERIFIED' | 'RECOVERY' | 'UNCERTAIN';
      readonly retryAfterSeconds: number;
      readonly message: string;
    }
  | { readonly kind: 'SERVICE_BLOCKED'; readonly message: string }
  | { readonly kind: 'PAYMENT_UNAVAILABLE'; readonly message: string }
  | { readonly kind: 'FAILED'; readonly code: string; readonly message: string }
  | { readonly kind: 'SUCCEEDED'; readonly message: string };

export interface GameJoinConditionsCheck {
  readonly kind: 'CONSENT' | 'FREE' | 'SUBSCRIPTION_REQUIRED' | 'UNAVAILABLE';
  readonly consent: GameJoinPriceConsent | null;
  readonly subscriptionInstanceId: string | null;
  readonly message: string;
}

export interface GameJoinResultClassification {
  readonly state: GameJoinFlowState;
  /** `KEEP` means the client still owns an unresolved attempt and must not start a new purchase. */
  readonly custody: 'KEEP' | 'DISCARD' | 'NONE';
  readonly trustedSuccess: boolean;
}

export interface GameJoinErrorPlan {
  readonly state: GameJoinFlowState;
  readonly custody: 'KEEP' | 'DISCARD';
  readonly reloadConditions: boolean;
}

export interface GameJoinRecoveryView {
  readonly operationId: string | null;
  readonly message: string;
}

const SUCCESS_MESSAGE = 'Вы в игре. Состав и доступные действия обновлены.';
const RECOVERY_MESSAGE =
  'Статус операции не подтверждён. Повторная оплата недоступна, пока сервер не подтвердит исход.';
const PRICE_CHANGED_MESSAGE =
  'Цена изменилась. Подтвердите актуальную стоимость — без нового подтверждения запись не отправится.';
const SERVICE_BLOCKED_MESSAGE =
  'Эта услуга недоступна по правилам клуба. Оплата не снимает этот запрет.';
const PAYMENT_UNAVAILABLE_MESSAGE = 'Платёжный контур этой игры пока недоступен.';
const SUBSCRIPTION_MESSAGE = 'Выберите подписку, по которой хотите записаться.';
const CONDITIONS_UNAVAILABLE_MESSAGE =
  'Условия и цена не подтверждены. Повторите проверку перед записью.';

export function gameJoinRecoveryState(): Extract<
  GameJoinFlowState,
  { kind: 'WAIT_FOR_RECONCILIATION' }
> {
  return waitingState('RECOVERY', 5, RECOVERY_MESSAGE);
}

export function gameJoinServiceBlockedMessage(): string {
  return SERVICE_BLOCKED_MESSAGE;
}

export function gameJoinPaymentUnavailableMessage(): string {
  return PAYMENT_UNAVAILABLE_MESSAGE;
}

export function gameJoinSubscriptionRequiredMessage(): string {
  return SUBSCRIPTION_MESSAGE;
}

export function gameJoinConditionsUnavailableMessage(): string {
  return CONDITIONS_UNAVAILABLE_MESSAGE;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isSafeAmount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function readAttemptState(value: unknown): GameJoinAttemptState | null {
  switch (value) {
    case 'NOT_ATTEMPTED':
    case 'DISPATCH_STARTED':
    case 'OWNER_PENDING':
    case 'OWNER_CONFIRMED':
    case 'UNKNOWN':
    case 'FAILED':
      return value;
    default:
      return null;
  }
}

function readCommercial(value: unknown): GameJoinOperationCommercialView | null {
  if (!isRecord(value)) return null;
  const attemptState = readAttemptState(value.attemptState);
  if (!attemptState) return null;
  const receipt =
    isRecord(value.receipt) &&
    value.receipt.provider === 'VIVA' &&
    value.receipt.status === 'CONFIRMED' &&
    isString(value.receipt.confirmedAt) &&
    Number.isFinite(Date.parse(value.receipt.confirmedAt))
      ? {
          provider: 'VIVA' as const,
          status: 'CONFIRMED' as const,
          confirmedAt: value.receipt.confirmedAt,
        }
      : null;
  return {
    attemptState,
    receipt,
    reason: typeof value.reason === 'string' ? value.reason : null,
  };
}

function readNextAction(value: unknown): GameJoinOperationView['nextAction'] | null {
  if (!isRecord(value)) return null;
  if (value.type === 'NONE') return { type: 'NONE' };
  if (value.type === 'OPEN_PAYMENT' && isString(value.url)) {
    return { type: 'OPEN_PAYMENT', url: value.url };
  }
  if (
    value.type === 'WAIT_FOR_RECONCILIATION' &&
    typeof value.retryAfterSeconds === 'number' &&
    Number.isFinite(value.retryAfterSeconds) &&
    value.retryAfterSeconds > 0
  ) {
    return { type: 'WAIT_FOR_RECONCILIATION', retryAfterSeconds: value.retryAfterSeconds };
  }
  return null;
}

/** Structural reader for `GameCommandResult` — tolerant of an older generated type with no `commercial`. */
export function readGameJoinCommandResult(value: unknown): GameJoinCommandResultView | null {
  if (!isRecord(value) || !isRecord(value.operation)) return null;
  const operation = value.operation;
  const status = operation.status;
  if (
    status !== 'ACCEPTED' &&
    status !== 'PROCESSING' &&
    status !== 'UNKNOWN' &&
    status !== 'SUCCEEDED' &&
    status !== 'FAILED'
  ) {
    return null;
  }
  if (!isString(operation.id)) return null;
  const nextAction = readNextAction(operation.nextAction);
  if (!nextAction) return null;
  const error = isRecord(operation.error)
    ? {
        code: isString(operation.error.code) ? operation.error.code : 'GAME_OPERATION_FAILED',
        message: isString(operation.error.message)
          ? operation.error.message
          : 'Операция не выполнена.',
      }
    : null;
  return {
    commandId: isString(value.commandId) ? value.commandId : operation.id,
    operation: {
      id: operation.id,
      status,
      gameId: isString(operation.gameId) ? operation.gameId : null,
      aggregateRevision:
        typeof operation.aggregateRevision === 'number' ? operation.aggregateRevision : null,
      nextAction,
      error,
      commercial: readCommercial(operation.commercial),
    },
    replayed: value.replayed === true,
  };
}

/** Structural reader for `GameJoinConditions` (HANDOFF-C1 §2.1). */
export function readGameJoinConditions(value: unknown): GameJoinConditionsView | null {
  if (!isRecord(value) || !isRecord(value.price)) return null;
  const eligibility = value.eligibility;
  if (
    eligibility !== 'AVAILABLE' &&
    eligibility !== 'UNAVAILABLE' &&
    eligibility !== 'LIMIT_USED'
  ) {
    return null;
  }
  if (
    !isString(value.gameId) ||
    !isString(value.subscriptionInstanceId) ||
    typeof value.revision !== 'number' ||
    !Number.isSafeInteger(value.revision) ||
    !isString(value.expiresAt) ||
    Number.isNaN(Date.parse(value.expiresAt)) ||
    typeof value.requiresPriceConsent !== 'boolean' ||
    (value.price.currency !== 'RUB' && value.price.currency !== undefined)
  ) {
    return null;
  }
  const status = value.price.status;
  if (status !== 'ADVISORY' && status !== 'MISSING') return null;
  const amountMinor = value.price.amountMinor;
  if (amountMinor !== null && !isSafeAmount(amountMinor)) return null;
  return {
    gameId: value.gameId,
    revision: value.revision,
    subscriptionInstanceId: value.subscriptionInstanceId,
    eligibility,
    reasonCode: typeof value.reasonCode === 'string' ? value.reasonCode : null,
    subscriptionApplied: value.subscriptionApplied === true,
    price: {
      status,
      amountMinor,
      currency: 'RUB',
      confirmed: value.price.confirmed === true,
    },
    expiresAt: new Date(value.expiresAt).toISOString(),
    requiresPriceConsent: value.requiresPriceConsent,
  };
}

/**
 * Extracts the server-owned amount that the user must explicitly echo, or `null` when the client must
 * not ask for/accept consent (not required, not available, expired, or missing amount). C1 exposes
 * the consent amount as `price.amountMinor` of the advisory conditions response (HANDOFF-C1 §2.1/§2.2).
 */
export function resolveGameJoinConsent(input: {
  readonly conditions: GameJoinConditionsView;
  readonly gameId: string;
  readonly revision: number;
  readonly subscriptionInstanceId: string;
  readonly nowMs: number;
}): GameJoinPriceConsent | null {
  const { conditions } = input;
  if (
    conditions.gameId !== input.gameId ||
    conditions.revision !== input.revision ||
    conditions.subscriptionInstanceId !== input.subscriptionInstanceId ||
    !conditions.requiresPriceConsent ||
    conditions.eligibility !== 'AVAILABLE' ||
    conditions.price.status !== 'ADVISORY' ||
    conditions.price.amountMinor === null ||
    Date.parse(conditions.expiresAt) <= input.nowMs
  ) {
    return null;
  }
  return { amountMinor: conditions.price.amountMinor, currency: 'RUB' };
}

export function checkGameJoinConditions(input: {
  readonly conditions: GameJoinConditionsView;
  readonly gameId: string;
  readonly revision: number;
  readonly subscriptionInstanceId: string;
  readonly nowMs: number;
}): GameJoinConditionsCheck {
  const { conditions } = input;
  if (
    conditions.gameId !== input.gameId ||
    conditions.revision !== input.revision ||
    conditions.subscriptionInstanceId !== input.subscriptionInstanceId
  ) {
    return {
      kind: 'UNAVAILABLE',
      consent: null,
      subscriptionInstanceId: null,
      message: 'Условия относятся к другому состоянию игры. Обновите карточку и повторите.',
    };
  }
  if (Date.parse(conditions.expiresAt) <= input.nowMs) {
    return {
      kind: 'UNAVAILABLE',
      consent: null,
      subscriptionInstanceId: null,
      message: 'Срок проверки условий истёк. Повторите проверку.',
    };
  }
  if (conditions.eligibility !== 'AVAILABLE') {
    return {
      kind: 'UNAVAILABLE',
      consent: null,
      subscriptionInstanceId: null,
      message:
        conditions.eligibility === 'LIMIT_USED'
          ? 'Лимит этой подписки уже использован. Выберите другую подписку.'
          : 'Выбранная подписка не применяется к этой игре.',
    };
  }
  const consent = resolveGameJoinConsent(input);
  if (!conditions.requiresPriceConsent) {
    return {
      kind: 'FREE',
      consent: null,
      subscriptionInstanceId: input.subscriptionInstanceId,
      message: '',
    };
  }
  if (!consent) {
    return {
      kind: 'UNAVAILABLE',
      consent: null,
      subscriptionInstanceId: null,
      message: CONDITIONS_UNAVAILABLE_MESSAGE,
    };
  }
  return {
    kind: 'CONSENT',
    consent,
    subscriptionInstanceId: input.subscriptionInstanceId,
    message: PRICE_CHANGED_MESSAGE,
  };
}

function trustedPaidSuccess(operation: GameJoinOperationView): boolean {
  const commercial = operation.commercial;
  return (
    commercial !== null &&
    (commercial.attemptState === 'OWNER_CONFIRMED' ||
      (commercial.receipt !== null && commercial.receipt.status === 'CONFIRMED'))
  );
}

function waitingState(
  reason: Extract<GameJoinFlowState, { kind: 'WAIT_FOR_RECONCILIATION' }>['reason'],
  retryAfterSeconds: number,
  message = RECOVERY_MESSAGE,
): Extract<GameJoinFlowState, { kind: 'WAIT_FOR_RECONCILIATION' }> {
  return { kind: 'WAIT_FOR_RECONCILIATION', reason, retryAfterSeconds, message };
}

function failedState(
  code: string,
  message: string,
): Extract<GameJoinFlowState, { kind: 'FAILED' }> {
  return { kind: 'FAILED', code, message };
}

/**
 * Maps a normalized command/readback result to the next screen. `paid` distinguishes the untouched
 * NO_PAYMENT join (a `SUCCEEDED` status is enough) from the paid flow (a trusted commercial signal is
 * required).
 */
export function classifyGameJoinOperation(
  result: GameJoinCommandResultView,
  options: { readonly paid: boolean },
): GameJoinResultClassification {
  const { operation } = result;
  if (operation.status === 'FAILED') {
    const code = operation.error?.code ?? 'GAME_OPERATION_FAILED';
    if (
      options.paid &&
      [
        'GAME_SERVICE_BLOCKED',
        'GAME_PAYMENT_REQUIRED',
        'GAME_SUBSCRIPTION_SELECTION_REQUIRED',
        'GAME_OPERATION_NOT_FOUND',
        'GAME_RESERVATION_EXPIRED',
        'GAME_RESERVATION_NOT_FOUND',
      ].includes(code)
    ) {
      const plan = classifyGameJoinErrorCode(code, options);
      return { state: plan.state, custody: plan.custody, trustedSuccess: false };
    }
    if (code === 'GAME_RECONCILIATION_REQUIRED' || code === 'GAME_OWNER_UNAVAILABLE') {
      return {
        state: waitingState('UNKNOWN', 5, RECOVERY_MESSAGE),
        custody: 'KEEP',
        trustedSuccess: false,
      };
    }
    return {
      state: failedState(code, operation.error?.message ?? 'Операция не выполнена.'),
      custody: 'DISCARD',
      trustedSuccess: false,
    };
  }
  if (operation.status === 'UNKNOWN') {
    return {
      state: waitingState('UNKNOWN', readRetryAfterSeconds(operation)),
      custody: 'KEEP',
      trustedSuccess: false,
    };
  }
  if (operation.nextAction.type === 'WAIT_FOR_RECONCILIATION') {
    return {
      state: waitingState(
        'OWNER_PENDING',
        operation.nextAction.retryAfterSeconds,
        'Проверяем статус операции у владельца. Повторная оплата недоступна.',
      ),
      custody: 'KEEP',
      trustedSuccess: false,
    };
  }
  if (operation.status === 'ACCEPTED' || operation.status === 'PROCESSING') {
    return {
      state: waitingState(
        'OWNER_PENDING',
        readRetryAfterSeconds(operation),
        'Операция ещё выполняется. Проверяем статус — повторная оплата недоступна.',
      ),
      custody: 'KEEP',
      trustedSuccess: false,
    };
  }
  // status === SUCCEEDED
  if (!options.paid)
    return {
      state: { kind: 'SUCCEEDED', message: SUCCESS_MESSAGE },
      custody: 'NONE',
      trustedSuccess: true,
    };
  if (!trustedPaidSuccess(operation)) {
    return {
      state: waitingState(
        'UNVERIFIED',
        5,
        'Сервер ещё не подтвердил оплату доверенной квитанцией. Повторная оплата недоступна.',
      ),
      custody: 'KEEP',
      trustedSuccess: false,
    };
  }
  return {
    state: { kind: 'SUCCEEDED', message: SUCCESS_MESSAGE },
    custody: 'KEEP',
    trustedSuccess: true,
  };
}

function readRetryAfterSeconds(operation: GameJoinOperationView): number {
  return operation.nextAction.type === 'WAIT_FOR_RECONCILIATION'
    ? operation.nextAction.retryAfterSeconds
    : 5;
}

export function classifyGameJoinErrorCode(
  code: string | undefined,
  options: { readonly paid: boolean },
): GameJoinErrorPlan {
  switch (code) {
    case 'GAME_PRICE_CONFIRMATION_REQUIRED':
      return {
        state: { kind: 'CHECKING_CONDITIONS', reason: 'PRICE_CHANGED' },
        custody: 'DISCARD',
        reloadConditions: true,
      };
    case 'GAME_SUBSCRIPTION_SELECTION_REQUIRED':
      return {
        state: { kind: 'NEEDS_SUBSCRIPTION', message: SUBSCRIPTION_MESSAGE },
        custody: 'DISCARD',
        reloadConditions: false,
      };
    case 'GAME_SERVICE_BLOCKED':
      return {
        state: { kind: 'SERVICE_BLOCKED', message: SERVICE_BLOCKED_MESSAGE },
        custody: 'DISCARD',
        reloadConditions: false,
      };
    case 'GAME_PAYMENT_REQUIRED':
      return {
        state: { kind: 'PAYMENT_UNAVAILABLE', message: PAYMENT_UNAVAILABLE_MESSAGE },
        custody: 'DISCARD',
        reloadConditions: false,
      };
    case 'GAME_RECONCILIATION_REQUIRED':
    case 'GAME_COMMERCIAL_ATTEMPT_CONFLICT':
    case 'GAME_ALREADY_RESERVED':
      return {
        state: waitingState('UNKNOWN', 5, RECOVERY_MESSAGE),
        custody: 'KEEP',
        reloadConditions: false,
      };
    case 'GAME_RESERVATION_EXPIRED':
    case 'GAME_RESERVATION_NOT_FOUND':
      return {
        state: waitingState('UNKNOWN', 5),
        custody: 'KEEP',
        reloadConditions: false,
      };
    case 'GAME_REVISION_CONFLICT':
      return {
        state: failedState(code, 'Игра уже изменилась. Обновите карточку и повторите.'),
        custody: 'DISCARD',
        reloadConditions: false,
      };
    case 'GAME_FULL':
      return {
        state: failedState(code, 'Свободное место уже заняли. Обновили состав игры.'),
        custody: 'DISCARD',
        reloadConditions: false,
      };
    case 'GAME_ALREADY_JOINED':
      return {
        state: failedState(code, 'Вы уже участвуете в этой игре.'),
        custody: 'DISCARD',
        reloadConditions: false,
      };
    case 'GAME_JOIN_CUTOFF_PASSED':
      return {
        state: failedState(code, 'Запись уже закрыта.'),
        custody: 'DISCARD',
        reloadConditions: false,
      };
    case 'GAME_NOT_JOINABLE':
      return {
        state: failedState(code, 'К этой игре сейчас нельзя присоединиться.'),
        custody: 'DISCARD',
        reloadConditions: false,
      };
    case 'GAME_OPERATION_NOT_FOUND':
      return {
        state: waitingState(
          'UNKNOWN',
          5,
          'Сервер пока не нашёл исходную операцию. Сохранили её ключ; новая запись и повторная оплата недоступны до подтверждения результата.',
        ),
        custody: 'KEEP',
        reloadConditions: false,
      };
    case 'GAME_COMMERCIAL_JOIN_UNCERTAIN':
      return { state: waitingState('UNCERTAIN', 5), custody: 'KEEP', reloadConditions: false };
    default:
      return {
        state: options.paid
          ? waitingState('UNCERTAIN', 5, RECOVERY_MESSAGE)
          : failedState(
              code ?? 'NETWORK_ERROR',
              'Не удалось выполнить действие. Проверьте связь и повторите.',
            ),
        custody: options.paid ? 'KEEP' : 'DISCARD',
        reloadConditions: false,
      };
  }
}

export interface GameJoinNotFoundPlan {
  readonly state: GameJoinFlowState;
  /** `true` only when the attempt has been quiet long enough to close it without hiding a write. */
  readonly release: boolean;
  /** Remaining quiet time while custody must still be kept. */
  readonly retryAfterSeconds: number;
}

const NOT_FOUND_WAITING_MESSAGE =
  'Сервер пока не нашёл исходную операцию. Ключ сохранён; проверяем результат — повторная оплата недоступна.';
const NOT_FOUND_RELEASED_MESSAGE =
  'Сервер не нашёл операцию по сохранённому ключу: подтверждённой записи нет. Исходная попытка закрыта; чтобы записаться, проверьте условия и подтвердите стоимость заново.';

/**
 * Product rule for a readback that answered `GAME_OPERATION_NOT_FOUND` (#453/#466 open rule).
 *
 * A GET can overtake the original POST or run while another tab is still dispatching, so absence is
 * not proof by itself. Custody is released only after the attempt has been quiet for
 * `GAME_JOIN_ATTEMPT_QUIET_MS`: from `savedAt` when no POST was ever marked, otherwise from the
 * durable `dispatchStartedAt`. Before that the original key stays authoritative and only readback is
 * offered; after it, the flow returns to a fresh conditions/consent check. Releasing never dispatches.
 */
export function classifyGameJoinReadbackNotFound(
  attempt: {
    readonly state: string;
    readonly savedAt: string;
    readonly dispatchStartedAt?: string;
  },
  options: { readonly now?: Date; readonly quietMs?: number } = {},
): GameJoinNotFoundPlan {
  const quietMs = options.quietMs ?? GAME_JOIN_ATTEMPT_QUIET_MS;
  const now = (options.now ?? new Date()).getTime();
  const quietSince = Date.parse(attempt.dispatchStartedAt ?? attempt.savedAt);
  const validWindow = Number.isSafeInteger(quietMs) && quietMs >= 0;
  const quiet =
    attempt.state !== 'SUCCEEDED' &&
    Number.isFinite(quietSince) &&
    validWindow &&
    now - quietSince >= quietMs;
  if (quiet) {
    return {
      state: failedState('GAME_OPERATION_NOT_FOUND', NOT_FOUND_RELEASED_MESSAGE),
      release: true,
      retryAfterSeconds: 0,
    };
  }
  const remainingMs =
    Number.isFinite(quietSince) && validWindow ? Math.max(0, quietMs - (now - quietSince)) : 0;
  const retryAfterSeconds = Math.max(1, Math.ceil(remainingMs / 1000));
  return {
    state: waitingState('UNVERIFIED', retryAfterSeconds, NOT_FOUND_WAITING_MESSAGE),
    release: false,
    retryAfterSeconds,
  };
}

/** Structural reader for the SDK's `GameJoinAttemptUncertainError` (lost response / owner 5xx). */
export function readUncertainGameJoinError(
  error: unknown,
): { readonly gameId: string; readonly idempotencyKey: string } | null {
  if (!isRecord(error)) return null;
  if (
    error.operationStatus !== 'UNKNOWN' ||
    error.recoveryAction !== 'KEEP_SAME_ATTEMPT' ||
    error.canStartNewPurchase !== false ||
    !isString(error.gameId) ||
    !isString(error.idempotencyKey)
  ) {
    return null;
  }
  return { gameId: error.gameId, idempotencyKey: error.idempotencyKey };
}

export function ensureFreshGameJoinConsent(
  current: GameJoinPriceConsent,
  next: GameJoinPriceConsent,
): boolean {
  return current.amountMinor === next.amountMinor && current.currency === next.currency;
}

export type GameJoinFlowEvent =
  | { readonly type: 'CHECK_CONDITIONS'; readonly reason: 'USER_REQUEST' | 'PRICE_CHANGED' }
  | {
      readonly type: 'CONDITIONS_CONSENT_REQUIRED';
      readonly expiresAt: string;
      readonly revision: number;
      readonly consent: GameJoinPriceConsent;
      readonly subscriptionInstanceId: string;
    }
  | { readonly type: 'CONDITIONS_FREE' }
  | { readonly type: 'CONDITIONS_UNAVAILABLE'; readonly message: string }
  | { readonly type: 'SUBSCRIPTION_REQUIRED'; readonly message?: string }
  | { readonly type: 'CONSENT_GIVEN'; readonly consent: GameJoinPriceConsent }
  | { readonly type: 'DISPATCH_STARTED' }
  | {
      readonly type: 'COMMAND_RESULT';
      readonly result: GameJoinCommandResultView;
      readonly paid: boolean;
    }
  | { readonly type: 'COMMAND_ERROR'; readonly code: string | undefined; readonly paid: boolean }
  | { readonly type: 'READBACK_RESULT'; readonly result: GameJoinCommandResultView }
  | {
      readonly type: 'RECOVERY_FOUND';
      readonly operationId: string | null;
      readonly message?: string;
    }
  | { readonly type: 'RESET' };

export function reduceGameJoinFlow(
  state: GameJoinFlowState,
  event: GameJoinFlowEvent,
): GameJoinFlowState {
  switch (event.type) {
    case 'RESET':
      return { kind: 'IDLE' };
    case 'CHECK_CONDITIONS':
      return { kind: 'CHECKING_CONDITIONS', reason: event.reason };
    case 'CONDITIONS_CONSENT_REQUIRED':
      return {
        kind: 'NEEDS_CONSENT',
        consent: event.consent,
        expiresAt: event.expiresAt,
        revision: event.revision,
        subscriptionInstanceId: event.subscriptionInstanceId,
        message: '',
      };
    case 'CONDITIONS_FREE':
      return { kind: 'IDLE' };
    case 'CONDITIONS_UNAVAILABLE':
      return failedState('GAME_JOIN_CONDITIONS_UNAVAILABLE', event.message);
    case 'SUBSCRIPTION_REQUIRED':
      return { kind: 'NEEDS_SUBSCRIPTION', message: event.message ?? SUBSCRIPTION_MESSAGE };
    case 'CONSENT_GIVEN': {
      if (state.kind !== 'NEEDS_CONSENT') return state;
      if (!ensureFreshGameJoinConsent(state.consent, event.consent)) {
        // A price that is not the one the user saw is never turned into consent.
        return {
          kind: 'NEEDS_CONSENT',
          consent: state.consent,
          expiresAt: state.expiresAt,
          revision: state.revision,
          subscriptionInstanceId: state.subscriptionInstanceId,
          message: PRICE_CHANGED_MESSAGE,
        };
      }
      return { kind: 'DISPATCHING' };
    }
    case 'DISPATCH_STARTED':
      return state.kind === 'IDLE' || state.kind === 'NEEDS_CONSENT'
        ? { kind: 'DISPATCHING' }
        : state;
    case 'COMMAND_RESULT':
      return classifyGameJoinOperation(event.result, { paid: event.paid }).state;
    case 'COMMAND_ERROR':
      return classifyGameJoinErrorCode(event.code, { paid: event.paid }).state;
    case 'READBACK_RESULT':
      return classifyGameJoinOperation(event.result, { paid: true }).state;
    case 'RECOVERY_FOUND':
      return {
        kind: 'WAIT_FOR_RECONCILIATION',
        reason: 'RECOVERY',
        retryAfterSeconds: 5,
        message: event.message ?? RECOVERY_MESSAGE,
      };
  }
}

/** True when the flow must not show a purchase/JOIN button (custody or consent owns the action). */
export function gameJoinFlowBlocksPurchase(state: GameJoinFlowState): boolean {
  return (
    state.kind === 'CHECKING_CONDITIONS' ||
    state.kind === 'NEEDS_SUBSCRIPTION' ||
    state.kind === 'NEEDS_CONSENT' ||
    state.kind === 'DISPATCHING' ||
    state.kind === 'CONFIRMED_UPDATING' ||
    state.kind === 'WAIT_FOR_RECONCILIATION'
  );
}

/** True when readback of the original operation is the only allowed next action. */
export function gameJoinFlowWaitsForReconciliation(state: GameJoinFlowState): boolean {
  return state.kind === 'WAIT_FOR_RECONCILIATION' || state.kind === 'DISPATCHING';
}

/** The reason the ordinary JOIN button is replaced by a status line while the flow owns the action. */
export function gameJoinBlockedLabel(flow: GameJoinFlowState): string | null {
  switch (flow.kind) {
    case 'CHECKING_CONDITIONS':
      return 'Проверяем условия и цену…';
    case 'NEEDS_SUBSCRIPTION':
      return 'Выберите подписку';
    case 'NEEDS_CONSENT':
      return 'Подтвердите стоимость участия';
    case 'DISPATCHING':
      return 'Отправляем запись…';
    case 'WAIT_FOR_RECONCILIATION':
      return 'Проверяем статус оплаты…';
    case 'CONFIRMED_UPDATING':
      return 'Запись подтверждена, данные обновляются…';
    default:
      return null;
  }
}

/**
 * Client-side paid-flow marker. The server still decides; this only chooses whether the JOIN button
 * asks for subscription/consent instead of posting the free command. NO_PAYMENT games stay free.
 */
export function gameJoinRequiresPaidFlow(game: {
  readonly priceSummary?: { readonly amountMinor: number; readonly currency: string } | null;
  readonly viewerPaymentState?: string;
  readonly allowedActions: readonly string[];
}): boolean {
  return (
    game.priceSummary != null ||
    game.viewerPaymentState === 'REQUIRES_ACTION' ||
    game.allowedActions.includes('PAY') ||
    game.allowedActions.includes('RETRY_PAYMENT')
  );
}
