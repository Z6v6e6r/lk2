import { createHash } from 'node:crypto';

import { bookedOperationAdmissionId } from '@phub/subscription-runtime-adapter';

import {
  readGameJoinConditions,
  GameJoinConditionsError,
  type GameJoinConditionsActor,
  type GameJoinConditionsOwner,
} from './game-join-conditions.js';

/**
 * Commercial JOIN orchestration for a paid game.
 *
 * The client never decides identity, tenant, product or price. The server:
 *   1. re-reads the owner conditions and takes the server-owned price,
 *   2. requires an explicit echo of exactly that price,
 *   3. persists the original operation and the seat reservation before any external effect,
 *   4. asks the existing owner of booking/entitlement to execute exactly that operation,
 *   5. never sends a replacement owner POST for a repeat, a second tab, a refresh or a lost response,
 *   6. keeps an unresolved outcome as UNKNOWN instead of FAILED, so no replacement payment is allowed.
 *
 * A trusted receipt (legacy CONFIRM_PAYMENT or an owner-confirmed receipt) is the only way an
 * attempt becomes SUCCEEDED. An owner "HTTP 200"/booking id is not financial success.
 */

export type CommercialJoinFailureCode =
  | 'GAME_PAYMENT_REQUIRED'
  | 'GAME_PRICE_CONFIRMATION_REQUIRED'
  | 'GAME_SUBSCRIPTION_SELECTION_REQUIRED'
  | 'GAME_SERVICE_BLOCKED'
  | 'GAME_RECONCILIATION_REQUIRED'
  | 'GAME_COMMERCIAL_ATTEMPT_CONFLICT'
  | 'GAME_OWNER_UNAVAILABLE'
  | 'GAME_ALREADY_RESERVED'
  | 'GAME_REVISION_CONFLICT'
  | 'GAME_NOT_FOUND'
  | 'GAME_NOT_JOINABLE'
  | 'GAME_JOIN_CUTOFF_PASSED'
  | 'GAME_FULL'
  | 'GAME_ALREADY_JOINED'
  | 'GAME_PAYMENT_MODE_MISMATCH'
  | 'GAME_RESERVATION_EXPIRED'
  | 'GAME_RESERVATION_NOT_FOUND';

export interface CommercialJoinPrice {
  readonly amountMinor: number;
  readonly currency: 'RUB';
  readonly basePriceMinor: number;
  readonly freeMinutes: number;
  readonly paidMinutes: number;
  readonly evaluatedAt: string;
  readonly expiresAt: string;
}

export interface CommercialJoinReservationView {
  readonly id: string;
  readonly state: 'ACTIVE' | 'CONFIRMED' | 'EXPIRED' | 'CANCELLED';
  readonly expiresAt: string;
}

export interface CommercialJoinReceiptView {
  readonly provider: 'VIVA';
  readonly status: 'CONFIRMED';
  readonly confirmedAt: string;
}

export type CommercialJoinAttemptState =
  'NOT_ATTEMPTED' | 'DISPATCH_STARTED' | 'OWNER_PENDING' | 'OWNER_CONFIRMED' | 'UNKNOWN' | 'FAILED';

/** Server-side port onto the existing write owner of the games aggregate. */
export interface CommercialJoinRepositoryPort {
  beginPaidJoin(input: {
    readonly tenantId: string;
    readonly actorUserId: string;
    readonly gameId: string;
    readonly idempotencyKey: string;
    readonly requestHash: string;
    readonly correlationId: string;
    readonly expectedRevision: number;
    readonly operationId: string;
    readonly subscriptionInstanceId: string;
    readonly price: CommercialJoinPrice;
    readonly invitationId?: string;
    readonly reservationTtlSeconds: number;
  }): Promise<CommercialJoinBeginResult>;
  getPaidJoinAttempt(input: {
    readonly tenantId: string;
    readonly actorUserId: string;
    readonly operationId: string;
  }): Promise<CommercialJoinAttemptView | null>;
  failPaidJoinAttempt(input: {
    readonly tenantId: string;
    readonly actorUserId: string;
    readonly operationId: string;
    readonly gameId: string;
    readonly code: string;
    readonly correlationId: string;
  }): Promise<unknown>;
}

export interface CommercialJoinAppliedResult {
  readonly commandId: string;
  readonly gameId: string;
  readonly revision: number;
  readonly viewerRelation: 'PARTICIPANT' | 'SEAT_RESERVED';
  readonly participationId?: string;
  readonly reservationId?: string;
  readonly committedAt: string;
}

export type CommercialJoinBeginResult =
  | {
      readonly outcome: 'reserved';
      readonly operationId: string;
      readonly reservationId: string;
      readonly expiresAt: string;
      readonly revision: number;
    }
  | {
      readonly outcome: 'replayed';
      readonly operationId: string;
      readonly state: 'IN_PROGRESS' | 'COMPLETED' | 'FAILED';
      readonly result?: CommercialJoinAppliedResult;
      readonly errorCode?: string;
    }
  | { readonly outcome: 'rejected'; readonly code: string; readonly currentRevision?: number }
  | { readonly outcome: 'idempotency_conflict' }
  | { readonly outcome: 'reservation_conflict' };

export interface CommercialJoinAttemptView {
  readonly commandId: string;
  readonly gameId: string;
  readonly state: 'IN_PROGRESS' | 'COMPLETED' | 'FAILED';
  readonly result: CommercialJoinAppliedResult | null;
  readonly errorCode: string | null;
  readonly reservation: CommercialJoinReservationView | null;
  readonly receipt: CommercialJoinReceiptView | null;
}

/**
 * Port onto the existing commercial executor (owner of booking and entitlement).
 * The executor MUST be idempotent by `operationId` and MUST NOT be retried by LK2.
 * It cannot report success: confirmation arrives only as a trusted receipt.
 */
export interface CommercialJoinOwnerActor {
  readonly tenantId: string;
  readonly tenantKey: string;
  readonly userId: string;
  readonly sessionId: string;
  readonly gameId: string;
  readonly expectedRevision: number;
}

export interface CommercialJoinOwnerPort {
  execute(input: {
    readonly actor: CommercialJoinOwnerActor;
    readonly operationId: string;
    readonly idempotencyKey: string;
    readonly correlationId: string;
    readonly subscriptionInstanceId: string;
    readonly price: CommercialJoinPrice;
  }): Promise<CommercialJoinOwnerOutcome>;
  read(input: {
    readonly actor: CommercialJoinOwnerActor;
    readonly operationId: string;
    readonly correlationId: string;
  }): Promise<CommercialJoinOwnerOutcome | null>;
}

export type CommercialJoinOwnerOutcome =
  | { readonly status: 'PENDING' }
  | { readonly status: 'UNKNOWN' }
  | {
      readonly status: 'REJECTED';
      readonly code: 'GAME_SERVICE_BLOCKED' | 'GAME_PAYMENT_REQUIRED';
    };

export interface CommercialJoinCommandEnvelope {
  readonly tenantId: string;
  readonly tenantKey: string;
  readonly userId: string;
  readonly sessionId: string;
  readonly gameId: string;
  readonly expectedRevision: number;
  readonly correlationId: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly operationId: string;
  readonly subscriptionInstanceId?: string | undefined;
  readonly priceConsent?: { readonly amountMinor: number; readonly currency: 'RUB' } | undefined;
  readonly invitationId?: string | undefined;
}

/** Fields the request fingerprint is derived from; never the derived ids themselves. */
export type CommercialJoinRequestFingerprintInput = Omit<
  CommercialJoinCommandEnvelope,
  'requestHash' | 'operationId'
>;

export type CommercialJoinResult =
  | { readonly kind: 'accepted'; readonly body: CommercialJoinResponseBody }
  | { readonly kind: 'failed'; readonly code: CommercialJoinFailureCode; readonly message: string };

export interface CommercialJoinCommercialView {
  readonly attemptState: CommercialJoinAttemptState;
  readonly reservation: CommercialJoinReservationView | null;
  readonly price: {
    readonly amountMinor: number;
    readonly currency: 'RUB';
    readonly consent: 'SETTLED' | 'REQUIRED';
  } | null;
  readonly receipt: CommercialJoinReceiptView | null;
  readonly reason: string | null;
}

export interface CommercialJoinResponseBody {
  readonly commandId: string;
  readonly operation: {
    readonly id: string;
    readonly type: 'JOIN_GAME';
    readonly status: 'PROCESSING' | 'UNKNOWN' | 'SUCCEEDED' | 'FAILED';
    readonly gameId: string | null;
    readonly aggregateRevision: number | null;
    readonly createdAt: string;
    readonly updatedAt: string;
    readonly nextAction:
      | { readonly type: 'NONE' }
      | { readonly type: 'WAIT_FOR_RECONCILIATION'; readonly retryAfterSeconds: number };
    readonly error: { readonly code: string; readonly message: string } | null;
    readonly commercial: CommercialJoinCommercialView;
  };
  readonly game: null;
  readonly replayed: boolean;
}

const FAILURE_MESSAGES: Readonly<Record<CommercialJoinFailureCode, string>> = {
  GAME_PAYMENT_REQUIRED: 'Платёжный контур этой игры пока недоступен.',
  GAME_PRICE_CONFIRMATION_REQUIRED:
    'Цена изменилась или ещё не подтверждена. Подтвердите актуальную цену.',
  GAME_SUBSCRIPTION_SELECTION_REQUIRED: 'Выберите подписку, по которой хотите записаться.',
  GAME_SERVICE_BLOCKED: 'Эта услуга недоступна по правилам клуба; оплата не снимает запрет.',
  GAME_RECONCILIATION_REQUIRED:
    'Предыдущая попытка ещё не завершена. Дождитесь проверки статуса, новую оплату не начинайте.',
  GAME_COMMERCIAL_ATTEMPT_CONFLICT:
    'Ключ операции уже использован для другой записи. Проверьте статус исходной операции.',
  GAME_OWNER_UNAVAILABLE: 'Статус операции не подтверждён владельцем. Сохраняем попытку.',
  GAME_ALREADY_RESERVED: 'Место в игре уже зарезервировано.',
  GAME_REVISION_CONFLICT: 'Игра уже изменилась. Обновите данные.',
  GAME_NOT_FOUND: 'Игра не найдена.',
  GAME_NOT_JOINABLE: 'К этой игре сейчас нельзя присоединиться.',
  GAME_JOIN_CUTOFF_PASSED: 'Время записи на игру закончилось.',
  GAME_FULL: 'В игре нет свободных мест.',
  GAME_ALREADY_JOINED: 'Вы уже участвуете в этой игре.',
  GAME_PAYMENT_MODE_MISMATCH: 'У игры другой платёжный режим.',
  GAME_RESERVATION_EXPIRED: 'Резерв места истёк. Повторите проверку условий.',
  GAME_RESERVATION_NOT_FOUND: 'Резерв места не найден.',
};

export function commercialFailure(
  code: CommercialJoinFailureCode,
): Extract<CommercialJoinResult, { kind: 'failed' }> {
  return { kind: 'failed', code, message: FAILURE_MESSAGES[code] };
}

/**
 * Owner preview reason codes that prohibit the service itself. Kept intentionally narrow: extending
 * this table is a product rule (NEEDS_PRODUCT_RULE), not an implementation detail.
 */
export const SERVICE_PROHIBITION_REASON_CODES: readonly string[] = ['SERVICE_BLOCKED'];

export function isServiceProhibitionReason(reasonCode: string | null): boolean {
  return reasonCode !== null && SERVICE_PROHIBITION_REASON_CODES.includes(reasonCode);
}

export function isCommercialFailureCode(value: string): value is CommercialJoinFailureCode {
  return Object.hasOwn(FAILURE_MESSAGES, value);
}

/** Stable server-side name of the operation, derived only from the request key. */
export function commercialJoinRequestHash(input: CommercialJoinRequestFingerprintInput): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        command: 'JOIN_GAME',
        contract: 'game.join.paid.v1',
        tenantId: input.tenantId,
        userId: input.userId,
        gameId: input.gameId,
        expectedRevision: input.expectedRevision,
        subscriptionInstanceId: input.subscriptionInstanceId ?? null,
        amountMinor: input.priceConsent?.amountMinor ?? null,
        currency: input.priceConsent?.currency ?? null,
        invitationId: input.invitationId ?? null,
      }),
    )
    .digest('hex');
}

/**
 * The owner-visible operation id reuses the existing booked-operation derivation: one key can only
 * ever name one commercial operation, so a repeat cannot mint a second purchase.
 */
export function commercialOperationId(input: {
  readonly tenantId: string;
  readonly userId: string;
  readonly idempotencyKeySha256: string;
}): string {
  return bookedOperationAdmissionId(input.tenantId, input.userId, input.idempotencyKeySha256);
}

export interface CommercialJoinDependencies {
  readonly repository: CommercialJoinRepositoryPort;
  readonly conditionsOwner: GameJoinConditionsOwner;
  readonly owner: CommercialJoinOwnerPort;
  readonly now?: () => number;
  readonly reservationTtlSeconds?: number;
  readonly reconciliationRetryAfterSeconds?: number;
}

function attemptView(
  state: CommercialJoinAttemptState,
  reservation: CommercialJoinReservationView | null,
  price: CommercialJoinCommercialView['price'],
  receipt: CommercialJoinReceiptView | null,
  reason: string | null,
): CommercialJoinCommercialView {
  return { attemptState: state, reservation, price, receipt, reason };
}

function operationBody(input: {
  readonly operationId: string;
  readonly status: CommercialJoinResponseBody['operation']['status'];
  readonly gameId: string | null;
  readonly revision: number | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly retryAfterSeconds?: number;
  readonly error?: { readonly code: string; readonly message: string } | null;
  readonly commercial: CommercialJoinCommercialView;
  readonly replayed: boolean;
}): CommercialJoinResponseBody {
  return {
    commandId: input.operationId,
    operation: {
      id: input.operationId,
      type: 'JOIN_GAME',
      status: input.status,
      gameId: input.gameId,
      aggregateRevision: input.revision,
      createdAt: input.createdAt,
      updatedAt: input.updatedAt,
      nextAction:
        input.retryAfterSeconds === undefined
          ? { type: 'NONE' }
          : { type: 'WAIT_FOR_RECONCILIATION', retryAfterSeconds: input.retryAfterSeconds },
      error: input.error ?? null,
      commercial: input.commercial,
    },
    game: null,
    replayed: input.replayed,
  };
}

/**
 * Executes one commercial JOIN. It returns either an accepted operation body (accepted even when the
 * outcome is still pending/unknown) or a stable failure the route maps onto an HTTP error.
 */
export async function executeCommercialJoin(
  input: CommercialJoinCommandEnvelope,
  dependencies: CommercialJoinDependencies,
): Promise<CommercialJoinResult> {
  const now = dependencies.now ?? Date.now;
  const retryAfter = dependencies.reconciliationRetryAfterSeconds ?? 5;
  const reservationTtlSeconds = dependencies.reservationTtlSeconds ?? 900;

  if (!input.subscriptionInstanceId)
    return commercialFailure('GAME_SUBSCRIPTION_SELECTION_REQUIRED');
  if (!input.priceConsent) return commercialFailure('GAME_PRICE_CONFIRMATION_REQUIRED');

  const actor: GameJoinConditionsActor = {
    tenantKey: input.tenantKey,
    correlationId: input.correlationId,
    tenantId: input.tenantId,
    userId: input.userId,
    sessionId: input.sessionId,
    gameId: input.gameId,
    expectedRevision: input.expectedRevision,
    subscriptionInstanceId: input.subscriptionInstanceId,
  };

  // 1. Conditions are re-read on the server immediately before the reservation: the price and the
  //    decision are the server's, and a consent for an older price cannot authorise a new one.
  let conditions;
  try {
    conditions = await readGameJoinConditions(
      dependencies.conditionsOwner,
      actor,
      input.correlationId,
      {
        now,
      },
    );
  } catch (error) {
    if (error instanceof GameJoinConditionsError && error.status === 409) {
      return commercialFailure(
        error.code === 'GAME_JOIN_CONDITIONS_REVISION_CHANGED'
          ? 'GAME_REVISION_CONFLICT'
          : 'GAME_RESERVATION_EXPIRED',
      );
    }
    return commercialFailure('GAME_PAYMENT_REQUIRED');
  }
  if (conditions.eligibility !== 'AVAILABLE' || conditions.price.amountMinor === null) {
    // A prohibited service is a rule decision, not a payment problem: paying never removes it.
    // Broader `reasonCode -> LK2 code` mapping is NEEDS_PRODUCT_RULE; only the explicit service
    // prohibition is separated here. A benefit-only refusal keeps the fail-closed beta guard.
    if (isServiceProhibitionReason(conditions.reasonCode)) {
      return commercialFailure('GAME_SERVICE_BLOCKED');
    }
    return commercialFailure('GAME_PAYMENT_REQUIRED');
  }
  if (Date.parse(conditions.expiresAt) <= now()) {
    // The advisory price window closed between the read and the command: force a fresh consent.
    return commercialFailure('GAME_PRICE_CONFIRMATION_REQUIRED');
  }
  const serverAmountMinor = conditions.price.amountMinor;
  if (
    input.priceConsent.amountMinor !== serverAmountMinor ||
    input.priceConsent.currency !== 'RUB'
  ) {
    return commercialFailure('GAME_PRICE_CONFIRMATION_REQUIRED');
  }

  const price: CommercialJoinPrice = {
    amountMinor: serverAmountMinor,
    currency: 'RUB',
    basePriceMinor: serverAmountMinor,
    freeMinutes: conditions.freeMinutes,
    paidMinutes: conditions.paidMinutes,
    evaluatedAt: conditions.evaluatedAt,
    expiresAt: conditions.expiresAt,
  };

  // 2. Durable attempt + seat reservation. The operation exists before the owner call.
  let begin: CommercialJoinBeginResult;
  try {
    begin = await dependencies.repository.beginPaidJoin({
      tenantId: input.tenantId,
      actorUserId: input.userId,
      gameId: input.gameId,
      idempotencyKey: input.idempotencyKey,
      requestHash: input.requestHash,
      correlationId: input.correlationId,
      expectedRevision: input.expectedRevision,
      operationId: input.operationId,
      subscriptionInstanceId: input.subscriptionInstanceId,
      price,
      ...(input.invitationId === undefined ? {} : { invitationId: input.invitationId }),
      reservationTtlSeconds,
    });
  } catch {
    return commercialFailure('GAME_OWNER_UNAVAILABLE');
  }

  if (begin.outcome === 'idempotency_conflict')
    return commercialFailure('GAME_COMMERCIAL_ATTEMPT_CONFLICT');
  if (begin.outcome === 'reservation_conflict')
    return commercialFailure('GAME_RECONCILIATION_REQUIRED');
  if (begin.outcome === 'rejected')
    return commercialFailure(
      isCommercialFailureCode(begin.code) ? begin.code : 'GAME_NOT_JOINABLE',
    );

  const reservation: CommercialJoinReservationView | null =
    begin.outcome === 'reserved'
      ? { id: begin.reservationId, state: 'ACTIVE', expiresAt: begin.expiresAt }
      : null;
  const createdAt = new Date(now()).toISOString();

  if (begin.outcome === 'replayed') {
    // A repeat never dispatches a replacement owner POST.
    if (begin.state === 'COMPLETED') {
      const applied = begin.result;
      if (!applied) return commercialFailure('GAME_OWNER_UNAVAILABLE');
      return {
        kind: 'accepted',
        body: operationBody({
          operationId: begin.operationId,
          status: 'SUCCEEDED',
          gameId: applied.gameId,
          revision: applied.revision,
          createdAt: applied.committedAt,
          updatedAt: applied.committedAt,
          commercial: attemptView(
            'OWNER_CONFIRMED',
            applied.reservationId
              ? { id: applied.reservationId, state: 'CONFIRMED', expiresAt: applied.committedAt }
              : null,
            { amountMinor: serverAmountMinor, currency: 'RUB', consent: 'SETTLED' },
            null,
            null,
          ),
          replayed: true,
        }),
      };
    }
    if (begin.state === 'FAILED') {
      const code =
        begin.errorCode && isCommercialFailureCode(begin.errorCode)
          ? begin.errorCode
          : 'GAME_RECONCILIATION_REQUIRED';
      return commercialFailure(code);
    }
    return {
      kind: 'accepted',
      body: operationBody({
        operationId: begin.operationId,
        status: 'UNKNOWN',
        gameId: input.gameId,
        revision: null,
        createdAt,
        updatedAt: createdAt,
        retryAfterSeconds: retryAfter,
        commercial: attemptView(
          'UNKNOWN',
          reservation,
          { amountMinor: serverAmountMinor, currency: 'RUB', consent: 'SETTLED' },
          null,
          'GAME_RECONCILIATION_REQUIRED',
        ),
        replayed: true,
      }),
    };
  }

  // 3. The existing owner executes exactly this operation. No retry, no replacement key.
  let outcome: CommercialJoinOwnerOutcome;
  try {
    outcome = await dependencies.owner.execute({
      actor: {
        tenantId: input.tenantId,
        tenantKey: input.tenantKey,
        userId: input.userId,
        sessionId: input.sessionId,
        gameId: input.gameId,
        expectedRevision: input.expectedRevision,
      },
      operationId: begin.operationId,
      idempotencyKey: input.idempotencyKey,
      correlationId: input.correlationId,
      subscriptionInstanceId: input.subscriptionInstanceId,
      price,
    });
  } catch {
    outcome = { status: 'UNKNOWN' };
  }

  if (outcome.status === 'REJECTED') {
    try {
      await dependencies.repository.failPaidJoinAttempt({
        tenantId: input.tenantId,
        actorUserId: input.userId,
        operationId: begin.operationId,
        gameId: input.gameId,
        code: outcome.code,
        correlationId: input.correlationId,
      });
    } catch {
      // A failed terminal write must not turn a definitive rejection into a silent success.
    }
    return commercialFailure(outcome.code);
  }

  if (outcome.status === 'PENDING') {
    return {
      kind: 'accepted',
      body: operationBody({
        operationId: begin.operationId,
        status: 'PROCESSING',
        gameId: input.gameId,
        revision: null,
        createdAt,
        updatedAt: createdAt,
        commercial: attemptView(
          'OWNER_PENDING',
          reservation,
          { amountMinor: serverAmountMinor, currency: 'RUB', consent: 'SETTLED' },
          null,
          null,
        ),
        replayed: false,
      }),
    };
  }

  return {
    kind: 'accepted',
    body: operationBody({
      operationId: begin.operationId,
      status: 'UNKNOWN',
      gameId: input.gameId,
      revision: null,
      createdAt,
      updatedAt: createdAt,
      retryAfterSeconds: retryAfter,
      commercial: attemptView(
        'UNKNOWN',
        reservation,
        { amountMinor: serverAmountMinor, currency: 'RUB', consent: 'SETTLED' },
        null,
        'GAME_RECONCILIATION_REQUIRED',
      ),
      replayed: false,
    }),
  };
}

/**
 * Readback of a commercial operation. Read-only: it never reserves, confirms, releases or fails.
 */
export async function readCommercialJoinOperation(
  input: {
    readonly tenantId: string;
    readonly tenantKey: string;
    readonly actorUserId: string;
    readonly sessionId: string;
    readonly operationId: string;
    readonly correlationId: string;
  },
  dependencies: Pick<CommercialJoinDependencies, 'repository' | 'owner' | 'now'>,
): Promise<CommercialJoinResponseBody | null> {
  const now = dependencies.now ?? Date.now;
  const attempt = await dependencies.repository.getPaidJoinAttempt({
    tenantId: input.tenantId,
    actorUserId: input.actorUserId,
    operationId: input.operationId,
  });
  if (!attempt) return null;
  const updatedAt = attempt.receipt?.confirmedAt ?? new Date(now()).toISOString();
  const price: CommercialJoinCommercialView['price'] = null;

  if (attempt.state === 'COMPLETED' && attempt.result) {
    return operationBody({
      operationId: attempt.commandId,
      status: 'SUCCEEDED',
      gameId: attempt.result.gameId,
      revision: attempt.result.revision,
      createdAt: attempt.result.committedAt,
      updatedAt,
      commercial: attemptView(
        'OWNER_CONFIRMED',
        attempt.reservation,
        attempt.receipt ? null : price,
        attempt.receipt,
        null,
      ),
      replayed: true,
    });
  }
  if (attempt.state === 'FAILED') {
    return operationBody({
      operationId: attempt.commandId,
      status: 'FAILED',
      gameId: attempt.gameId,
      revision: null,
      createdAt: updatedAt,
      updatedAt,
      error: {
        code: attempt.errorCode ?? 'GAME_RECONCILIATION_REQUIRED',
        message:
          attempt.errorCode && isCommercialFailureCode(attempt.errorCode)
            ? FAILURE_MESSAGES[attempt.errorCode]
            : FAILURE_MESSAGES.GAME_RECONCILIATION_REQUIRED,
      },
      commercial: attemptView('FAILED', attempt.reservation, null, null, attempt.errorCode),
      replayed: true,
    });
  }

  // IN_PROGRESS. A trusted receipt may already have arrived through the legacy owner channel.
  if (attempt.receipt) {
    return operationBody({
      operationId: attempt.commandId,
      status: 'SUCCEEDED',
      gameId: attempt.gameId,
      revision: null,
      createdAt: attempt.receipt.confirmedAt,
      updatedAt,
      commercial: attemptView('OWNER_CONFIRMED', attempt.reservation, price, attempt.receipt, null),
      replayed: true,
    });
  }
  const ownerPending = await dependencies.owner
    .read({
      actor: {
        tenantId: input.tenantId,
        tenantKey: input.tenantKey,
        userId: input.actorUserId,
        sessionId: input.sessionId,
        gameId: attempt.gameId,
        expectedRevision: 0,
      },
      operationId: attempt.commandId,
      correlationId: input.correlationId,
    })
    .then((ownerState) => ownerState?.status === 'PENDING')
    .catch(() => false);
  if (ownerPending) {
    return operationBody({
      operationId: attempt.commandId,
      status: 'PROCESSING',
      gameId: attempt.gameId,
      revision: null,
      createdAt: updatedAt,
      updatedAt,
      commercial: attemptView('OWNER_PENDING', attempt.reservation, price, null, null),
      replayed: true,
    });
  }
  return operationBody({
    operationId: attempt.commandId,
    status: 'UNKNOWN',
    gameId: attempt.gameId,
    revision: null,
    createdAt: updatedAt,
    updatedAt,
    retryAfterSeconds: 5,
    commercial: attemptView(
      'UNKNOWN',
      attempt.reservation,
      price,
      null,
      'GAME_RECONCILIATION_REQUIRED',
    ),
    replayed: true,
  });
}
