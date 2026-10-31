import { ManagedSelfLeaveError } from '@phub/database/managed-self-leave';
import type { ManagedSelfLeaveRuntime } from './game-managed-self-leave.js';
import { createHash } from 'node:crypto';

import type {
  CancelStoredGameInput,
  CancelStoredGameResult,
  CreateStoredGameInput,
  CreateStoredGameResult,
  GameRepository,
  GameTestCourtRepository,
  GameRosterCommandErrorCode,
  GameRosterCommandResult,
  GameRosterOperation,
  GameRosterRepository,
} from '@phub/database';
import { GAME_KINDS, GAME_PLAYER_LEVELS, GAME_VISIBILITIES } from '@phub/games';
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';

import { sendApiError } from '../http-errors.js';
import { subscriptionRuntimeIdempotencyKeySha256 } from '../subscriptions/subscription-runtime-actor-delegation-issuer.js';
import {
  executeCommercialCreate,
  readCommercialCreateOperation,
  type CommercialCreateFailureCode,
  type CommercialCreatePriceConsent,
} from './game-create-commercial.js';
import type { GameCommercialCreateOptions } from './game-create-commercial-runtime.js';
import {
  commercialJoinRequestHash,
  commercialOperationId,
  executeCommercialJoin,
  readCommercialJoinOperation,
  reconcileCommercialJoinOperation,
  type CommercialJoinFailureCode,
  type CommercialJoinOwnerPort,
  type CommercialJoinRepositoryPort,
} from './game-commercial-join.js';
import type { GameJoinConditionsOwner } from './game-join-conditions.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type UserRosterRepository = Pick<
  GameRosterRepository,
  'join' | 'joinWaitlist' | 'leave' | 'leaveWaitlist' | 'getOperation'
>;
type UserManagementRepository = Pick<
  GameRepository,
  'create' | 'cancel' | 'getManagementOperation'
>;

type UserRosterCommand = 'JOIN_GAME' | 'LEAVE_GAME' | 'JOIN_WAITLIST' | 'LEAVE_WAITLIST';
type UserGameCommand = UserRosterCommand | 'CREATE_GAME' | 'CANCEL_GAME';

const COMMAND_TYPE: Readonly<Record<GameRosterOperation['commandType'], UserRosterCommand>> = {
  'game.join.v1': 'JOIN_GAME',
  'game.leave.v1': 'LEAVE_GAME',
  'game.waitlist.join.v1': 'JOIN_WAITLIST',
  'game.waitlist.leave.v1': 'LEAVE_WAITLIST',
};

const ERROR_MESSAGES: Partial<Record<GameRosterCommandErrorCode, string>> = {
  GAME_NOT_FOUND: 'Игра не найдена.',
  GAME_REVISION_CONFLICT: 'Игра уже изменилась. Обновите данные.',
  GAME_NOT_JOINABLE: 'К этой игре сейчас нельзя присоединиться.',
  GAME_JOIN_CUTOFF_PASSED: 'Время записи на игру закончилось.',
  GAME_ALREADY_JOINED: 'Вы уже участвуете в этой игре.',
  GAME_ALREADY_RESERVED: 'Место в игре уже зарезервировано.',
  GAME_ALREADY_WAITLISTED: 'Вы уже в очереди на эту игру.',
  GAME_FULL: 'В игре нет свободных мест.',
  GAME_WAITLIST_DISABLED: 'Очередь для этой игры отключена.',
  GAME_WAITLIST_NOT_AVAILABLE: 'Сейчас нельзя встать в очередь.',
  GAME_NOT_LEAVABLE: 'Сейчас нельзя выйти из игры.',
  GAME_PAYMENT_REQUIRED: 'Платёжный контур этой игры пока недоступен.',
  GAME_ORGANIZER_MUST_CANCEL: 'Организатор должен отменить игру.',
  GAME_NOT_WAITLISTED: 'Вы не состоите в очереди на эту игру.',
  PLAYER_LEVEL_REQUIRED: 'Укажите уровень, чтобы присоединиться.',
  PLAYER_LEVEL_UNKNOWN: 'Не удалось корректно определить ваш уровень.',
  LEVEL_NOT_ALLOWED: 'Эта игра рассчитана на другой уровень.',
  LEVEL_SPORT_MISMATCH: 'Уровень указан для другого вида спорта.',
  LEVEL_SCALE_VERSION_MISMATCH: 'Версия вашего уровня устарела. Обновите уровень и повторите.',
  ACTIVITY_LEVEL_UNDEFINED: 'Для игры не настроен диапазон уровней.',
  ACTIVITY_LEVEL_INVALID: 'Диапазон уровней игры настроен некорректно.',
  LEVEL_POLICY_MISCONFIGURED: 'Правило допуска временно настроено некорректно.',
};

const PUBLIC_ROSTER_ERROR_CODES = new Set<GameRosterCommandErrorCode>([
  'GAME_NOT_FOUND',
  'GAME_REVISION_CONFLICT',
  'GAME_NOT_JOINABLE',
  'GAME_JOIN_CUTOFF_PASSED',
  'GAME_ALREADY_JOINED',
  'GAME_ALREADY_RESERVED',
  'GAME_ALREADY_WAITLISTED',
  'GAME_FULL',
  'GAME_WAITLIST_DISABLED',
  'GAME_WAITLIST_NOT_AVAILABLE',
  'GAME_NOT_LEAVABLE',
  'GAME_PAYMENT_REQUIRED',
  'GAME_ORGANIZER_MUST_CANCEL',
  'GAME_NOT_WAITLISTED',
  'PLAYER_LEVEL_REQUIRED',
  'PLAYER_LEVEL_UNKNOWN',
  'LEVEL_NOT_ALLOWED',
  'LEVEL_SPORT_MISMATCH',
  'LEVEL_SCALE_VERSION_MISMATCH',
  'ACTIVITY_LEVEL_UNDEFINED',
  'ACTIVITY_LEVEL_INVALID',
  'LEVEL_POLICY_MISCONFIGURED',
]);

function principal(request: FastifyRequest): { tenantId: string; userId: string } | undefined {
  const current = request as FastifyRequest & {
    readonly tenantId?: string;
    readonly padlHubClaims?: { readonly sub?: string };
  };
  const userId = current.padlHubClaims?.sub;
  return current.tenantId && userId ? { tenantId: current.tenantId, userId } : undefined;
}

function sessionId(request: FastifyRequest): string {
  const current = request as FastifyRequest & {
    readonly padlHubClaims?: { readonly sid?: string };
  };
  return current.padlHubClaims?.sid ?? '';
}

function idempotencyKey(request: FastifyRequest): string {
  const value = request.headers['idempotency-key'];
  if (typeof value !== 'string') throw new Error('GAME_IDEMPOTENCY_PREHANDLER_MISSING');
  return value;
}

function gameId(request: FastifyRequest, reply: FastifyReply): string | undefined {
  const value = (request.params as { gameId?: string }).gameId;
  if (!value || !UUID_PATTERN.test(value)) {
    sendApiError(request, reply, 400, 'INVALID_REQUEST', 'Некорректный идентификатор игры.');
    return undefined;
  }
  return value;
}

interface ParsedJoinBody {
  readonly expectedRevision?: number;
  readonly invitationId?: string;
  readonly subscriptionInstanceId?: string;
  readonly priceConsent?: { readonly amountMinor: number; readonly currency: 'RUB' };
}

const JOIN_BODY_KEYS = new Set([
  'expectedRevision',
  'invitationId',
  'subscriptionInstanceId',
  'priceConsent',
]);

function parsePriceConsent(value: unknown): { amountMinor: number; currency: 'RUB' } | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join(',') !== 'amountMinor,currency' ||
    !Number.isSafeInteger(record.amountMinor) ||
    Number(record.amountMinor) < 0 ||
    record.currency !== 'RUB'
  )
    return undefined;
  return { amountMinor: Number(record.amountMinor), currency: 'RUB' };
}

function parseJoinBody(request: FastifyRequest, reply: FastifyReply): ParsedJoinBody | undefined {
  if (request.body === undefined || request.body === null) return {};
  if (typeof request.body !== 'object' || Array.isArray(request.body)) {
    sendApiError(request, reply, 400, 'INVALID_REQUEST', 'Некорректная команда входа в игру.');
    return undefined;
  }
  const body = request.body as Record<string, unknown>;
  const priceConsent =
    body.priceConsent === undefined ? undefined : parsePriceConsent(body.priceConsent);
  if (
    Object.keys(body).some((key) => !JOIN_BODY_KEYS.has(key)) ||
    (body.expectedRevision !== undefined &&
      (!Number.isSafeInteger(body.expectedRevision) || Number(body.expectedRevision) < 0)) ||
    (body.invitationId !== undefined &&
      (typeof body.invitationId !== 'string' || !UUID_PATTERN.test(body.invitationId))) ||
    (body.subscriptionInstanceId !== undefined &&
      (typeof body.subscriptionInstanceId !== 'string' ||
        !UUID_PATTERN.test(body.subscriptionInstanceId))) ||
    (body.priceConsent !== undefined && priceConsent === undefined)
  ) {
    sendApiError(request, reply, 400, 'INVALID_REQUEST', 'Некорректная команда входа в игру.');
    return undefined;
  }
  return {
    ...(body.expectedRevision === undefined
      ? {}
      : { expectedRevision: Number(body.expectedRevision) }),
    ...(typeof body.invitationId === 'string' ? { invitationId: body.invitationId } : {}),
    ...(typeof body.subscriptionInstanceId === 'string'
      ? { subscriptionInstanceId: body.subscriptionInstanceId }
      : {}),
    ...(priceConsent === undefined ? {} : { priceConsent }),
  };
}

const COMMERCIAL_FAILURE_STATUS: Readonly<Record<CommercialJoinFailureCode, number>> = {
  GAME_PAYMENT_REQUIRED: 409,
  GAME_PRICE_CONFIRMATION_REQUIRED: 409,
  GAME_SUBSCRIPTION_SELECTION_REQUIRED: 409,
  GAME_SERVICE_BLOCKED: 409,
  GAME_RECONCILIATION_REQUIRED: 409,
  GAME_COMMERCIAL_ATTEMPT_CONFLICT: 409,
  GAME_OWNER_UNAVAILABLE: 503,
  GAME_ALREADY_RESERVED: 409,
  GAME_REVISION_CONFLICT: 409,
  GAME_NOT_FOUND: 404,
  GAME_NOT_JOINABLE: 409,
  GAME_JOIN_CUTOFF_PASSED: 409,
  GAME_FULL: 409,
  GAME_ALREADY_JOINED: 409,
  GAME_PAYMENT_MODE_MISMATCH: 409,
  GAME_RESERVATION_EXPIRED: 409,
  GAME_RESERVATION_NOT_FOUND: 409,
};

/** Managed commercial CREATE failures reuse the existing stable codes and statuses. */
const COMMERCIAL_CREATE_FAILURE_STATUS: Readonly<Record<CommercialCreateFailureCode, number>> = {
  GAME_PAYMENT_MODE_MISMATCH: 409,
  GAME_PRICE_CONFIRMATION_REQUIRED: 409,
  GAME_SUBSCRIPTION_SELECTION_REQUIRED: 409,
  GAME_SERVICE_BLOCKED: 409,
  GAME_RECONCILIATION_REQUIRED: 409,
  GAME_COMMERCIAL_ATTEMPT_CONFLICT: 409,
  GAME_OWNER_UNAVAILABLE: 503,
  GAME_NOT_FOUND: 404,
  GAME_PAYMENT_REQUIRED: 409,
};

type CreateGamePayload = Omit<
  CreateStoredGameInput,
  | 'tenantId'
  | 'actorUserId'
  | 'idempotencyKey'
  | 'requestHash'
  | 'correlationId'
  | 'joinCutoffAt'
  | 'gameId'
  | 'operationId'
>;

interface ParsedCreateBody {
  readonly payload: CreateGamePayload;
  /** Only collected when the managed commercial CREATE contour is composed. */
  readonly commercial: {
    readonly subscriptionInstanceId?: string;
    readonly priceConsent?: CommercialCreatePriceConsent;
  };
}

function parseCreateBody(
  request: FastifyRequest,
  reply: FastifyReply,
  managedCreate: boolean,
): ParsedCreateBody | undefined {
  if (typeof request.body !== 'object' || request.body === null || Array.isArray(request.body)) {
    sendApiError(request, reply, 400, 'INVALID_REQUEST', 'Заполните параметры игры.');
    return undefined;
  }
  const body = request.body as Record<string, unknown>;
  const allowed = new Set([
    'title',
    'kind',
    'visibility',
    'stationId',
    'courtId',
    'startsAt',
    'endsAt',
    'timezone',
    'capacity',
    'levelRange',
    'paymentMode',
    'waitlistEnabled',
  ]);
  // Managed commercial CREATE extends the request additively. With the contour disabled the old
  // allowlist stays exactly as before, so an `OFF` request is rejected byte-identically.
  if (managedCreate) {
    allowed.add('priceConsent');
    allowed.add('subscriptionInstanceId');
  }
  const levelRange = body.levelRange;
  const rangeRecord =
    typeof levelRange === 'object' && levelRange !== null && !Array.isArray(levelRange)
      ? (levelRange as Record<string, unknown>)
      : undefined;
  const rangeFrom = rangeRecord?.from;
  const rangeTo = rangeRecord?.to;
  const validLevelRange =
    levelRange === undefined ||
    levelRange === null ||
    (rangeRecord !== undefined &&
      Object.keys(rangeRecord).every((key) => key === 'from' || key === 'to') &&
      typeof rangeFrom === 'string' &&
      typeof rangeTo === 'string' &&
      GAME_PLAYER_LEVELS.includes(rangeFrom as (typeof GAME_PLAYER_LEVELS)[number]) &&
      GAME_PLAYER_LEVELS.includes(rangeTo as (typeof GAME_PLAYER_LEVELS)[number]) &&
      GAME_PLAYER_LEVELS.indexOf(rangeFrom as (typeof GAME_PLAYER_LEVELS)[number]) <=
        GAME_PLAYER_LEVELS.indexOf(rangeTo as (typeof GAME_PLAYER_LEVELS)[number]));
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  const startsAt = typeof body.startsAt === 'string' ? body.startsAt : '';
  const endsAt = typeof body.endsAt === 'string' ? body.endsAt : '';
  const startsAtMs = Date.parse(startsAt);
  const endsAtMs = Date.parse(endsAt);
  let validTimezone = typeof body.timezone === 'string' && body.timezone.length <= 64;
  if (validTimezone) {
    try {
      new Intl.DateTimeFormat('en', { timeZone: body.timezone as string }).format();
    } catch {
      validTimezone = false;
    }
  }
  const priceConsent =
    managedCreate && body.priceConsent !== undefined
      ? parsePriceConsent(body.priceConsent)
      : undefined;
  const subscriptionInstanceId =
    managedCreate && typeof body.subscriptionInstanceId === 'string'
      ? body.subscriptionInstanceId
      : undefined;
  if (
    Object.keys(body).some((key) => !allowed.has(key)) ||
    title.length < 1 ||
    title.length > 160 ||
    !GAME_KINDS.includes(body.kind as never) ||
    !GAME_VISIBILITIES.includes(body.visibility as never) ||
    typeof body.stationId !== 'string' ||
    !UUID_PATTERN.test(body.stationId) ||
    (body.courtId !== undefined &&
      body.courtId !== null &&
      (typeof body.courtId !== 'string' || !UUID_PATTERN.test(body.courtId))) ||
    !Number.isFinite(startsAtMs) ||
    !Number.isFinite(endsAtMs) ||
    endsAtMs <= startsAtMs ||
    !validTimezone ||
    ![2, 4].includes(Number(body.capacity)) ||
    !validLevelRange ||
    !['ORGANIZER_PAYS', 'SPLIT', 'SUBSCRIPTION', 'NO_PAYMENT'].includes(String(body.paymentMode)) ||
    typeof body.waitlistEnabled !== 'boolean' ||
    (managedCreate && body.priceConsent !== undefined && priceConsent === undefined) ||
    (managedCreate &&
      body.subscriptionInstanceId !== undefined &&
      (subscriptionInstanceId === undefined || !UUID_PATTERN.test(subscriptionInstanceId)))
  ) {
    sendApiError(request, reply, 400, 'INVALID_REQUEST', 'Проверьте параметры и время игры.');
    return undefined;
  }
  return {
    payload: {
      title,
      kind: body.kind as CreateStoredGameInput['kind'],
      visibility: body.visibility as CreateStoredGameInput['visibility'],
      stationId: body.stationId,
      ...(typeof body.courtId === 'string' ? { courtId: body.courtId } : {}),
      startsAt: new Date(startsAtMs).toISOString(),
      endsAt: new Date(endsAtMs).toISOString(),
      timezone: body.timezone as string,
      capacity: Number(body.capacity),
      paymentMode: body.paymentMode as CreateStoredGameInput['paymentMode'],
      waitlistEnabled: body.waitlistEnabled,
      ...(rangeRecord
        ? {
            levelFrom: rangeFrom as NonNullable<CreateStoredGameInput['levelFrom']>,
            levelTo: rangeTo as NonNullable<CreateStoredGameInput['levelTo']>,
          }
        : {}),
    },
    commercial: {
      ...(subscriptionInstanceId === undefined ? {} : { subscriptionInstanceId }),
      ...(priceConsent === undefined ? {} : { priceConsent }),
    },
  };
}

function parseCancelBody(
  request: FastifyRequest,
  reply: FastifyReply,
): Pick<CancelStoredGameInput, 'reasonCode' | 'note'> | undefined {
  if (typeof request.body !== 'object' || request.body === null || Array.isArray(request.body)) {
    sendApiError(request, reply, 400, 'INVALID_REQUEST', 'Укажите причину отмены.');
    return undefined;
  }
  const body = request.body as Record<string, unknown>;
  if (
    Object.keys(body).some((key) => key !== 'reasonCode' && key !== 'note') ||
    !['ORGANIZER_REQUEST', 'VENUE_UNAVAILABLE', 'WEATHER', 'SAFETY', 'OTHER'].includes(
      String(body.reasonCode),
    ) ||
    (body.note !== undefined && body.note !== null && typeof body.note !== 'string') ||
    (typeof body.note === 'string' && body.note.length > 500)
  ) {
    sendApiError(request, reply, 400, 'INVALID_REQUEST', 'Некорректная причина отмены.');
    return undefined;
  }
  return {
    reasonCode: body.reasonCode as CancelStoredGameInput['reasonCode'],
    ...(body.note === undefined ? {} : { note: body.note }),
  };
}

function requestHash(
  command: UserGameCommand,
  currentGameId: string | null,
  payload: unknown,
): string {
  return createHash('sha256')
    .update(JSON.stringify({ command, gameId: currentGameId, payload }))
    .digest('hex');
}

function errorMessage(code: GameRosterCommandErrorCode): string {
  return ERROR_MESSAGES[code] ?? 'Команду нельзя выполнить в текущем состоянии игры.';
}

function operationBody(
  result: Extract<GameRosterCommandResult, { outcome: 'applied' }>,
  type: UserRosterCommand,
  replayed = result.replayed,
) {
  const processing = result.viewerRelation === 'SEAT_RESERVED';
  const body = {
    commandId: result.commandId,
    operation: {
      id: result.commandId,
      type,
      status: processing ? ('PROCESSING' as const) : ('SUCCEEDED' as const),
      gameId: result.gameId,
      aggregateRevision: result.revision,
      createdAt: result.committedAt,
      updatedAt: result.committedAt,
      nextAction: { type: 'NONE' as const },
      error: null,
    },
    game: null,
    replayed,
  };
  assertValidCommandBody(body);
  return body;
}

function managementOperationBody(
  result:
    | Extract<CreateStoredGameResult, { outcome: 'applied' }>
    | Extract<CancelStoredGameResult, { outcome: 'applied' }>,
  type: 'CREATE_GAME' | 'CANCEL_GAME',
) {
  const commandId = 'operationId' in result ? result.operationId : result.commandId;
  const body = {
    commandId,
    operation: {
      id: commandId,
      type,
      status: 'SUCCEEDED' as const,
      gameId: result.gameId,
      aggregateRevision: result.revision,
      createdAt: result.committedAt,
      updatedAt: result.committedAt,
      nextAction: { type: 'NONE' as const },
      error: null,
    },
    game: null,
    replayed: result.replayed,
  };
  assertValidCommandBody(body);
  return body;
}

function failedOperationBody(operation: GameRosterOperation) {
  if (!operation.errorCode || !PUBLIC_ROSTER_ERROR_CODES.has(operation.errorCode)) {
    throw new Error('GAME_OPERATION_ERROR_INVALID');
  }
  const body = {
    commandId: operation.commandId,
    operation: {
      id: operation.commandId,
      type: COMMAND_TYPE[operation.commandType],
      status: 'FAILED' as const,
      gameId: operation.gameId,
      aggregateRevision: null,
      createdAt: operation.committedAt,
      updatedAt: operation.committedAt,
      nextAction: { type: 'NONE' as const },
      error: { code: operation.errorCode, message: errorMessage(operation.errorCode) },
    },
    game: null,
    replayed: true,
  };
  assertValidCommandBody(body);
  return body;
}

function assertValidCommandBody(body: {
  readonly commandId: string;
  readonly operation: {
    readonly id: string;
    readonly type: UserGameCommand;
    readonly status: 'PROCESSING' | 'SUCCEEDED' | 'FAILED';
    readonly gameId: string | null;
    readonly aggregateRevision: number | null;
    readonly createdAt: string;
    readonly updatedAt: string;
    readonly nextAction: { readonly type: 'NONE' };
    readonly error: { readonly code: string; readonly message: string } | null;
  };
  readonly game: null;
  readonly replayed: boolean;
}): void {
  if (
    !UUID_PATTERN.test(body.commandId) ||
    body.operation.id !== body.commandId ||
    (body.operation.gameId !== null && !UUID_PATTERN.test(body.operation.gameId)) ||
    (body.operation.aggregateRevision !== null &&
      (!Number.isSafeInteger(body.operation.aggregateRevision) ||
        body.operation.aggregateRevision < 0)) ||
    Number.isNaN(Date.parse(body.operation.createdAt)) ||
    Number.isNaN(Date.parse(body.operation.updatedAt))
  ) {
    throw new Error('GAME_COMMAND_RESPONSE_INVALID');
  }
}

function unavailable(request: FastifyRequest, reply: FastifyReply) {
  return sendApiError(
    request,
    reply,
    503,
    'GAMES_RUNTIME_UNAVAILABLE',
    'Игровой модуль временно недоступен.',
  );
}

function rejected(
  request: FastifyRequest,
  reply: FastifyReply,
  result: Exclude<GameRosterCommandResult, { outcome: 'applied' }>,
) {
  if (result.outcome === 'idempotency_conflict') {
    return sendApiError(
      request,
      reply,
      409,
      'IDEMPOTENCY_KEY_REUSED',
      'Idempotency-Key уже использован для другой команды.',
    );
  }
  if (!PUBLIC_ROSTER_ERROR_CODES.has(result.code)) {
    throw new Error('GAME_COMMAND_INTERNAL_POLICY_ERROR');
  }
  return sendApiError(
    request,
    reply,
    result.code === 'GAME_NOT_FOUND' ? 404 : 409,
    result.code,
    errorMessage(result.code),
  );
}

export interface GameCommercialJoinOptions {
  readonly repository: CommercialJoinRepositoryPort;
  readonly conditionsOwner: GameJoinConditionsOwner;
  readonly owner: CommercialJoinOwnerPort;
}

export function registerGameRoutes(
  app: FastifyInstance,
  options: {
    readonly repository?: UserRosterRepository;
    readonly managementRepository?: UserManagementRepository;
    readonly testCourtRepository?: GameTestCourtRepository;
    readonly commercialJoin?: GameCommercialJoinOptions;
    readonly managedSelfLeave?: ManagedSelfLeaveRuntime;
    /** Composed only when the managed commercial CREATE contour is enabled (default OFF). */
    readonly commercialCreate?: GameCommercialCreateOptions;
    readonly authenticatedTenantHandlers: readonly preHandlerHookHandler[];
    readonly commandHandlers: readonly preHandlerHookHandler[];
  },
): void {
  app.get(
    '/user/api/v1/:tenantKey/games/test-courts',
    { preHandler: [...options.authenticatedTenantHandlers] },
    async (request, reply) => {
      reply.header('Cache-Control', 'private, no-store');
      const current = principal(request);
      if (!current)
        return sendApiError(request, reply, 401, 'AUTH_REQUIRED', 'Требуется авторизация.');
      return {
        items: (await options.testCourtRepository?.list(current.tenantId, current.userId)) ?? [],
      };
    },
  );
  app.post(
    '/user/api/v1/:tenantKey/games',
    { preHandler: [...options.commandHandlers] },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const current = principal(request);
      if (!current) {
        return sendApiError(request, reply, 401, 'AUTH_REQUIRED', 'Требуется авторизация.');
      }
      if (!options.managementRepository) return unavailable(request, reply);
      const parsed = parseCreateBody(request, reply, options.commercialCreate !== undefined);
      if (!parsed) return reply;
      const { payload, commercial } = parsed;
      if (payload.paymentMode !== 'NO_PAYMENT') {
        // The blanket beta guard stays byte-identical while the managed contour is not composed.
        if (!options.commercialCreate) {
          return sendApiError(
            request,
            reply,
            409,
            'GAME_PAYMENT_REQUIRED',
            'В ранней beta можно создать только бесплатную игру.',
          );
        }
        const key = idempotencyKey(request);
        const result = await executeCommercialCreate(
          {
            tenantId: current.tenantId,
            tenantKey: (request.params as { tenantKey: string }).tenantKey,
            userId: current.userId,
            sessionId: sessionId(request),
            correlationId: request.id,
            idempotencyKey: key,
            idempotencyKeySha256: subscriptionRuntimeIdempotencyKeySha256(key),
            payload,
            ...(commercial.subscriptionInstanceId === undefined
              ? {}
              : { subscriptionInstanceId: commercial.subscriptionInstanceId }),
            ...(commercial.priceConsent === undefined
              ? {}
              : { priceConsent: commercial.priceConsent }),
          },
          {
            repository: options.commercialCreate.repository,
            owner: options.commercialCreate.owner,
            onQuoteFailure: (code) =>
              app.log.warn({ code }, 'commercial CREATE quote observation failed'),
            onOwnerFailure: (code) =>
              app.log.warn({ code }, 'commercial CREATE owner boundary observation'),
          },
        );
        if (result.kind === 'failed') {
          return sendApiError(
            request,
            reply,
            COMMERCIAL_CREATE_FAILURE_STATUS[result.code],
            result.code,
            result.message,
          );
        }
        if (result.kind === 'create_rejected') {
          if (result.code === 'GAME_LOCATION_INVALID') {
            return sendApiError(
              request,
              reply,
              400,
              'INVALID_REQUEST',
              'Проверьте параметры и время игры.',
            );
          }
          return sendApiError(
            request,
            reply,
            400,
            'GAME_START_TIME_PASSED',
            'Время начала игры должно быть в будущем.',
          );
        }
        return reply.status(202).send(result.body);
      }
      const result = await options.managementRepository.create({
        tenantId: current.tenantId,
        actorUserId: current.userId,
        idempotencyKey: idempotencyKey(request),
        requestHash: requestHash('CREATE_GAME', null, payload),
        correlationId: request.id,
        ...payload,
        joinCutoffAt: new Date(Date.parse(payload.startsAt) - 30 * 60_000).toISOString(),
      });
      if (result.outcome === 'idempotency_conflict') {
        return sendApiError(
          request,
          reply,
          409,
          'IDEMPOTENCY_KEY_REUSED',
          'Idempotency-Key уже использован для другой команды.',
        );
      }
      if (result.outcome === 'rejected') {
        if (result.code === 'GAME_LOCATION_INVALID') {
          return sendApiError(
            request,
            reply,
            400,
            'INVALID_REQUEST',
            'Проверьте параметры и время игры.',
          );
        }
        return sendApiError(
          request,
          reply,
          400,
          'GAME_START_TIME_PASSED',
          'Время начала игры должно быть в будущем.',
        );
      }
      return reply.status(202).send(managementOperationBody(result, 'CREATE_GAME'));
    },
  );

  app.post(
    '/user/api/v1/:tenantKey/games/:gameId/cancel',
    { preHandler: [...options.commandHandlers] },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const current = principal(request);
      if (!current) {
        return sendApiError(request, reply, 401, 'AUTH_REQUIRED', 'Требуется авторизация.');
      }
      const currentGameId = gameId(request, reply);
      if (!currentGameId) return reply;
      if (!options.managementRepository) return unavailable(request, reply);
      const payload = parseCancelBody(request, reply);
      if (!payload) return reply;
      const result = await options.managementRepository.cancel({
        tenantId: current.tenantId,
        actorUserId: current.userId,
        gameId: currentGameId,
        idempotencyKey: idempotencyKey(request),
        requestHash: requestHash('CANCEL_GAME', currentGameId, payload),
        correlationId: request.id,
        ...payload,
      });
      if (result.outcome === 'idempotency_conflict') {
        return sendApiError(
          request,
          reply,
          409,
          'IDEMPOTENCY_KEY_REUSED',
          'Idempotency-Key уже использован для другой команды.',
        );
      }
      if (result.outcome === 'rejected') {
        const messages = {
          GAME_NOT_FOUND: 'Игра не найдена.',
          GAME_NOT_CANCELLABLE: 'Эту игру нельзя отменить в текущем состоянии.',
          GAME_PAYMENT_REQUIRED: 'Платную игру нужно отменять через платёжный контур.',
        } as const;
        return sendApiError(
          request,
          reply,
          result.code === 'GAME_NOT_FOUND' ? 404 : 409,
          result.code,
          messages[result.code],
        );
      }
      return reply.status(202).send(managementOperationBody(result, 'CANCEL_GAME'));
    },
  );

  const command = (
    method: 'POST' | 'DELETE',
    path: string,
    type: UserRosterCommand,
    execute: (
      repository: UserRosterRepository,
      input: Parameters<UserRosterRepository['join']>[0],
    ) => Promise<GameRosterCommandResult>,
    parseBody = false,
    commercialJoin = false,
  ) => {
    app.route({
      method,
      url: path,
      preHandler: [...options.commandHandlers],
      handler: async (request, reply) => {
        reply.header('Cache-Control', 'no-store');
        const current = principal(request);
        if (!current) {
          return sendApiError(request, reply, 401, 'AUTH_REQUIRED', 'Требуется авторизация.');
        }
        const currentGameId = gameId(request, reply);
        if (!currentGameId) return reply;
        if (!options.repository) return unavailable(request, reply);
        const payload = parseBody ? parseJoinBody(request, reply) : {};
        if (!payload) return reply;
        if (type === 'LEAVE_GAME' && options.managedSelfLeave) {
          try {
            const managed = await options.managedSelfLeave.execute({
              tenantId: current.tenantId,
              actorUserId: current.userId,
              tenantKey: (request.params as { tenantKey: string }).tenantKey,
              sessionId: sessionId(request),
              gameId: currentGameId,
              idempotencyKey: idempotencyKey(request),
              requestHash: requestHash(type, currentGameId, payload),
              correlationId: request.id,
            });
            if (managed)
              return reply
                .status(managed.operation.status === 'SUCCEEDED' ? 200 : 202)
                .send(managed);
          } catch (error) {
            if (error instanceof ManagedSelfLeaveError)
              return sendApiError(
                request,
                reply,
                error.code === 'GAME_NOT_FOUND' ? 404 : 409,
                error.code === 'MANAGED_SELF_LEAVE_BINDING_INVALID'
                  ? 'GAME_NOT_LEAVABLE'
                  : error.code,
                'Выход из игры пока не подтверждён.',
              );
            throw error;
          }
        }
        if (
          commercialJoin &&
          (payload.subscriptionInstanceId !== undefined || payload.priceConsent !== undefined)
        ) {
          // Paid participation goes through the existing owner of booking/entitlement. Until that
          // composition exists the previous GAME_PAYMENT_REQUIRED guard stays in force.
          if (!options.commercialJoin) {
            return sendApiError(
              request,
              reply,
              409,
              'GAME_PAYMENT_REQUIRED',
              'Платёжный контур этой игры пока недоступен.',
            );
          }
          const expectedRevision = payload.expectedRevision;
          if (expectedRevision === undefined) {
            return sendApiError(
              request,
              reply,
              400,
              'INVALID_REQUEST',
              'Обновите карточку игры: отсутствует актуальная ревизия.',
            );
          }
          const operationId = commercialOperationId({
            tenantId: current.tenantId,
            userId: current.userId,
            idempotencyKeySha256: subscriptionRuntimeIdempotencyKeySha256(idempotencyKey(request)),
          });
          const result = await executeCommercialJoin(
            {
              tenantId: current.tenantId,
              tenantKey: (request.params as { tenantKey: string }).tenantKey,
              userId: current.userId,
              sessionId:
                (request as FastifyRequest & { padlHubClaims?: { sid?: string } }).padlHubClaims
                  ?.sid ?? '',
              gameId: currentGameId,
              expectedRevision,
              correlationId: request.id,
              idempotencyKey: idempotencyKey(request),
              operationId,
              requestHash: commercialJoinRequestHash({
                tenantId: current.tenantId,
                tenantKey: (request.params as { tenantKey: string }).tenantKey,
                userId: current.userId,
                sessionId:
                  (request as FastifyRequest & { padlHubClaims?: { sid?: string } }).padlHubClaims
                    ?.sid ?? '',
                gameId: currentGameId,
                expectedRevision,
                correlationId: request.id,
                idempotencyKey: idempotencyKey(request),
                ...(payload.subscriptionInstanceId === undefined
                  ? {}
                  : { subscriptionInstanceId: payload.subscriptionInstanceId }),
                ...(payload.priceConsent === undefined
                  ? {}
                  : { priceConsent: payload.priceConsent }),
                ...(payload.invitationId === undefined
                  ? {}
                  : { invitationId: payload.invitationId }),
              }),
              ...(payload.subscriptionInstanceId === undefined
                ? {}
                : { subscriptionInstanceId: payload.subscriptionInstanceId }),
              ...(payload.priceConsent === undefined ? {} : { priceConsent: payload.priceConsent }),
              ...(payload.invitationId === undefined ? {} : { invitationId: payload.invitationId }),
            },
            {
              repository: options.commercialJoin.repository,
              conditionsOwner: options.commercialJoin.conditionsOwner,
              owner: options.commercialJoin.owner,
            },
          );
          if (result.kind === 'failed') {
            return sendApiError(
              request,
              reply,
              COMMERCIAL_FAILURE_STATUS[result.code],
              result.code,
              result.message,
            );
          }
          const acceptedBody = result.body;
          const httpStatus =
            acceptedBody.operation.status === 'SUCCEEDED'
              ? 200
              : acceptedBody.operation.status === 'FAILED'
                ? 409
                : 202;
          return reply.status(httpStatus).send(acceptedBody);
        }
        // Check current stored access before repository replay as well as new admission.
        if (
          (type === 'JOIN_GAME' || type === 'JOIN_WAITLIST') &&
          options.testCourtRepository &&
          !(await options.testCourtRepository.canJoin(
            current.tenantId,
            current.userId,
            currentGameId,
            {
              commandType: type === 'JOIN_GAME' ? 'game.join.v1' : 'game.waitlist.join.v1',
              correlationId: request.id,
            },
          ))
        ) {
          return sendApiError(request, reply, 404, 'GAME_NOT_FOUND', 'Игра не найдена.');
        }
        const result = await execute(options.repository, {
          tenantId: current.tenantId,
          actorUserId: current.userId,
          gameId: currentGameId,
          idempotencyKey: idempotencyKey(request),
          requestHash: requestHash(type, currentGameId, payload),
          correlationId: request.id,
          ...(payload.expectedRevision === undefined
            ? {}
            : { expectedRevision: payload.expectedRevision }),
          ...(payload.invitationId === undefined ? {} : { invitationId: payload.invitationId }),
        });
        if (result.outcome !== 'applied') return rejected(request, reply, result);
        return reply
          .status(result.viewerRelation === 'SEAT_RESERVED' ? 202 : 200)
          .send(operationBody(result, type));
      },
    });
  };

  command(
    'POST',
    '/user/api/v1/:tenantKey/games/:gameId/join',
    'JOIN_GAME',
    (repository, input) => repository.join(input),
    true,
    true,
  );

  app.get(
    '/user/api/v1/:tenantKey/games/:gameId/leave-operation',
    { preHandler: [...options.commandHandlers] },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const current = principal(request);
      if (!current)
        return sendApiError(request, reply, 401, 'AUTH_REQUIRED', 'Требуется авторизация.');
      const id = gameId(request, reply);
      if (!id) return reply;
      try {
        const result = await options.managedSelfLeave?.readByKey({
          tenantId: current.tenantId,
          actorUserId: current.userId,
          gameId: id,
          idempotencyKey: idempotencyKey(request),
        });
        return (
          result ??
          sendApiError(request, reply, 404, 'GAME_OPERATION_NOT_FOUND', 'Операция не найдена.')
        );
      } catch (error) {
        if (error instanceof ManagedSelfLeaveError)
          return sendApiError(
            request,
            reply,
            409,
            error.code === 'MANAGED_SELF_LEAVE_BINDING_INVALID' ? 'GAME_NOT_LEAVABLE' : error.code,
            'Исходная операция выхода недоступна.',
          );
        throw error;
      }
    },
  );

  // Recovery by the original key: the client keeps the key even when the JOIN response was lost,
  // so it can read the same commercial operation without ever sending a replacement POST.
  app.get(
    '/user/api/v1/:tenantKey/games/:gameId/join-operation',
    { preHandler: [...options.authenticatedTenantHandlers] },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const current = principal(request);
      if (!current) {
        return sendApiError(request, reply, 401, 'AUTH_REQUIRED', 'Требуется авторизация.');
      }
      const currentGameId = gameId(request, reply);
      if (!currentGameId) return reply;
      const key = request.headers['idempotency-key'];
      if (typeof key !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/.test(key)) {
        return sendApiError(
          request,
          reply,
          400,
          'INVALID_REQUEST',
          'Передайте исходный Idempotency-Key операции.',
        );
      }
      if (!options.commercialJoin) {
        return sendApiError(
          request,
          reply,
          409,
          'GAME_PAYMENT_REQUIRED',
          'Платёжный контур этой игры пока недоступен.',
        );
      }
      const recovered = await readCommercialJoinOperation(
        {
          tenantId: current.tenantId,
          tenantKey: (request.params as { tenantKey: string }).tenantKey,
          actorUserId: current.userId,
          sessionId: sessionId(request),
          operationId: commercialOperationId({
            tenantId: current.tenantId,
            userId: current.userId,
            idempotencyKeySha256: subscriptionRuntimeIdempotencyKeySha256(key),
          }),
          correlationId: request.id,
        },
        {
          repository: options.commercialJoin.repository,
          owner: options.commercialJoin.owner,
        },
      );
      if (!recovered || recovered.operation.gameId !== currentGameId) {
        return sendApiError(
          request,
          reply,
          404,
          'GAME_OPERATION_NOT_FOUND',
          'Операция не найдена.',
        );
      }
      return recovered;
    },
  );
  command(
    'DELETE',
    '/user/api/v1/:tenantKey/games/:gameId/participants/me',
    'LEAVE_GAME',
    (repository, input) => repository.leave(input),
  );
  command(
    'POST',
    '/user/api/v1/:tenantKey/games/:gameId/waitlist',
    'JOIN_WAITLIST',
    (repository, input) => repository.joinWaitlist(input),
    true,
  );
  command(
    'DELETE',
    '/user/api/v1/:tenantKey/games/:gameId/waitlist/me',
    'LEAVE_WAITLIST',
    (repository, input) => repository.leaveWaitlist(input),
  );

  app.post(
    '/user/api/v1/:tenantKey/game-operations/:operationId/reconcile',
    { preHandler: [...options.authenticatedTenantHandlers] },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const current = principal(request);
      if (!current)
        return sendApiError(request, reply, 401, 'AUTH_REQUIRED', 'Требуется авторизация.');
      const { operationId, tenantKey } = request.params as {
        operationId: string;
        tenantKey: string;
      };
      const key = request.headers['idempotency-key'];
      if (
        !UUID_PATTERN.test(operationId) ||
        key !== `join-reconcile:${operationId}` ||
        (request.body !== undefined &&
          request.body !== null &&
          JSON.stringify(request.body) !== '{}')
      ) {
        return sendApiError(request, reply, 400, 'INVALID_REQUEST', 'Некорректная команда сверки.');
      }
      if (!options.commercialJoin) return unavailable(request, reply);
      const result = await reconcileCommercialJoinOperation(
        {
          tenantId: current.tenantId,
          tenantKey,
          actorUserId: current.userId,
          sessionId: sessionId(request),
          operationId,
          correlationId: request.id,
        },
        {
          repository: options.commercialJoin.repository,
          owner: options.commercialJoin.owner,
          onReconciliationFailure: (code) =>
            app.log.warn(
              { operationId, code },
              'commercial JOIN receipt needs operator reconciliation',
            ),
        },
      );
      if (!result)
        return sendApiError(
          request,
          reply,
          404,
          'GAME_OPERATION_NOT_FOUND',
          'Операция не найдена.',
        );
      return result;
    },
  );

  app.get(
    '/user/api/v1/:tenantKey/game-operations/:operationId',
    { preHandler: [...options.authenticatedTenantHandlers] },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const current = principal(request);
      if (!current) {
        return sendApiError(request, reply, 401, 'AUTH_REQUIRED', 'Требуется авторизация.');
      }
      const operationId = (request.params as { operationId?: string }).operationId;
      if (!operationId || !UUID_PATTERN.test(operationId)) {
        return sendApiError(
          request,
          reply,
          400,
          'INVALID_REQUEST',
          'Некорректный идентификатор операции.',
        );
      }
      if (options.managedSelfLeave) {
        const managed = await options.managedSelfLeave.read({
          tenantId: current.tenantId,
          actorUserId: current.userId,
          operationId,
        });
        if (managed) return managed;
      }
      if (!options.repository && !options.managementRepository) return unavailable(request, reply);
      if (options.commercialJoin) {
        const commercialBody = await readCommercialJoinOperation(
          {
            tenantId: current.tenantId,
            tenantKey: (request.params as { tenantKey: string }).tenantKey,
            actorUserId: current.userId,
            sessionId: sessionId(request),
            operationId,
            correlationId: request.id,
          },
          {
            repository: options.commercialJoin.repository,
            owner: options.commercialJoin.owner,
          },
        );
        if (commercialBody) return commercialBody;
      }
      const managementOperation = await options.managementRepository?.getManagementOperation({
        tenantId: current.tenantId,
        actorUserId: current.userId,
        operationId,
      });
      if (managementOperation) {
        if (
          managementOperation.commandType === 'game.create.v1' &&
          'state' in managementOperation
        ) {
          // A managed commercial CREATE is durably accepted but still PROVISIONING. Readback keeps
          // it UNKNOWN with a reconciliation next action: never FAILED, never a second POST.
          return readCommercialCreateOperation({
            operationId: managementOperation.pending.operationId,
            gameId: managementOperation.pending.gameId,
            revision: managementOperation.pending.revision,
            createdAt: managementOperation.pending.createdAt,
            updatedAt: managementOperation.pending.updatedAt,
          });
        }
        return managementOperationBody(
          managementOperation.result,
          managementOperation.commandType === 'game.create.v1' ? 'CREATE_GAME' : 'CANCEL_GAME',
        );
      }
      if (!options.repository) {
        return sendApiError(
          request,
          reply,
          404,
          'GAME_OPERATION_NOT_FOUND',
          'Операция не найдена.',
        );
      }
      const operation = await options.repository.getOperation({
        tenantId: current.tenantId,
        actorUserId: current.userId,
        operationId,
      });
      if (!operation) {
        return sendApiError(
          request,
          reply,
          404,
          'GAME_OPERATION_NOT_FOUND',
          'Операция не найдена.',
        );
      }
      if (operation.state === 'FAILED') return failedOperationBody(operation);
      if (!operation.result) throw new Error('GAME_OPERATION_RESULT_MISSING');
      return operationBody(operation.result, COMMAND_TYPE[operation.commandType], true);
    },
  );
}
