import { createHash } from 'node:crypto';

import type {
  GameRosterCommandErrorCode,
  GameRosterCommandResult,
  GameRosterOperation,
  GameRosterRepository,
  ParticipationDecision,
} from '@phub/database';
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';

import { sendApiError } from '../http-errors.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type UserRosterRepository = Pick<
  GameRosterRepository,
  'join' | 'joinWaitlist' | 'leave' | 'leaveWaitlist' | 'getOperation'
>;

type UserRosterCommand = 'JOIN_GAME' | 'LEAVE_GAME' | 'JOIN_WAITLIST' | 'LEAVE_WAITLIST';

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
  GAME_ORGANIZER_MUST_CANCEL: 'Организатор должен отменить игру.',
  GAME_NOT_WAITLISTED: 'Вы не состоите в очереди на эту игру.',
  PLAYER_LEVEL_REQUIRED: 'Укажите уровень, чтобы присоединиться.',
  PLAYER_LEVEL_UNKNOWN: 'Не удалось корректно определить ваш уровень.',
  PLAYER_LEVEL_STALE: 'Обновите уровень, чтобы продолжить.',
  LEVEL_NOT_ALLOWED: 'Эта игра рассчитана на другой уровень.',
  LEVEL_TOO_LOW: 'Уровень игры выше указанного вами уровня.',
  LEVEL_TOO_HIGH: 'Уровень игры ниже указанного вами уровня.',
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
  'GAME_ORGANIZER_MUST_CANCEL',
  'GAME_NOT_WAITLISTED',
  'PLAYER_LEVEL_REQUIRED',
  'PLAYER_LEVEL_UNKNOWN',
  'PLAYER_LEVEL_STALE',
  'LEVEL_NOT_ALLOWED',
  'LEVEL_TOO_LOW',
  'LEVEL_TOO_HIGH',
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

function parseJoinBody(
  request: FastifyRequest,
  reply: FastifyReply,
): { readonly expectedRevision?: number; readonly invitationId?: string } | undefined {
  if (request.body === undefined || request.body === null) return {};
  if (typeof request.body !== 'object' || Array.isArray(request.body)) {
    sendApiError(request, reply, 400, 'INVALID_REQUEST', 'Некорректная команда входа в игру.');
    return undefined;
  }
  const body = request.body as Record<string, unknown>;
  if (
    Object.keys(body).some((key) => key !== 'expectedRevision' && key !== 'invitationId') ||
    (body.expectedRevision !== undefined &&
      (!Number.isSafeInteger(body.expectedRevision) || Number(body.expectedRevision) < 0)) ||
    (body.invitationId !== undefined &&
      (typeof body.invitationId !== 'string' || !UUID_PATTERN.test(body.invitationId)))
  ) {
    sendApiError(request, reply, 400, 'INVALID_REQUEST', 'Некорректная команда входа в игру.');
    return undefined;
  }
  return {
    ...(body.expectedRevision === undefined
      ? {}
      : { expectedRevision: Number(body.expectedRevision) }),
    ...(typeof body.invitationId === 'string' ? { invitationId: body.invitationId } : {}),
  };
}

function requestHash(command: UserRosterCommand, currentGameId: string, payload: unknown): string {
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
  updatedAt = result.committedAt,
) {
  const recoveryState = result.providerRecoveryState;
  const providerRejected = recoveryState === 'REJECTED';
  const processing =
    !providerRejected &&
    (result.viewerRelation === 'SEAT_RESERVED' ||
      recoveryState === 'READY' ||
      recoveryState === 'SUBMITTING' ||
      recoveryState === 'UNKNOWN' ||
      recoveryState === 'RECONCILING' ||
      recoveryState === 'MANUAL_REVIEW');
  const recovery = recoveryState
    ? {
        phase:
          recoveryState === 'READY'
            ? ('PENDING' as const)
            : recoveryState === 'CONFIRMED'
              ? ('COMPLETED' as const)
              : recoveryState,
        automaticRetryExhausted: recoveryState === 'MANUAL_REVIEW',
      }
    : undefined;
  const body = {
    commandId: result.commandId,
    operation: {
      id: result.commandId,
      type,
      status: providerRejected
        ? ('FAILED' as const)
        : processing
          ? ('PROCESSING' as const)
          : ('SUCCEEDED' as const),
      gameId: result.gameId,
      aggregateRevision: result.revision,
      createdAt: result.committedAt,
      updatedAt,
      nextAction: { type: 'NONE' as const },
      error: providerRejected
        ? {
            // Keep the v1 enum stable for older sealed native clients. The message
            // provides the provider-specific explanation without a new error code.
            code: 'GAME_NOT_JOINABLE' as const,
            message: 'Внешний сервис отклонил операцию.',
          }
        : null,
      ...(recovery ? { recovery } : {}),
    },
    game: null,
    ...(result.eligibility ? { eligibility: result.eligibility } : {}),
    replayed,
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
    ...(operation.eligibility ? { eligibility: operation.eligibility } : {}),
    replayed: true,
  };
  assertValidCommandBody(body);
  return body;
}

function assertValidCommandBody(body: {
  readonly commandId: string;
  readonly operation: {
    readonly id: string;
    readonly type: UserRosterCommand;
    readonly status: 'PROCESSING' | 'SUCCEEDED' | 'FAILED';
    readonly gameId: string | null;
    readonly aggregateRevision: number | null;
    readonly createdAt: string;
    readonly updatedAt: string;
    readonly nextAction: { readonly type: 'NONE' };
    readonly error: { readonly code: string; readonly message: string } | null;
    readonly recovery?: {
      readonly phase:
        | 'PENDING'
        | 'SUBMITTING'
        | 'UNKNOWN'
        | 'RECONCILING'
        | 'COMPLETED'
        | 'REJECTED'
        | 'MANUAL_REVIEW';
      readonly automaticRetryExhausted: boolean;
    };
  };
  readonly game: null;
  readonly eligibility?: ParticipationDecision;
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
  return reply.status(result.code === 'GAME_NOT_FOUND' ? 404 : 409).send({
    code: result.code,
    message: errorMessage(result.code),
    correlationId: request.id,
    ...(result.eligibility ? { eligibility: result.eligibility } : {}),
  });
}

export function registerGameRoutes(
  app: FastifyInstance,
  options: {
    readonly repository?: UserRosterRepository;
    readonly authenticatedTenantHandlers: readonly preHandlerHookHandler[];
    readonly commandHandlers: readonly preHandlerHookHandler[];
  },
): void {
  const command = (
    method: 'POST' | 'DELETE',
    path: string,
    type: UserRosterCommand,
    execute: (
      repository: UserRosterRepository,
      input: Parameters<UserRosterRepository['join']>[0],
    ) => Promise<GameRosterCommandResult>,
    parseBody = false,
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
      if (!options.repository) return unavailable(request, reply);
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
      return operationBody(
        operation.result,
        COMMAND_TYPE[operation.commandType],
        true,
        operation.updatedAt,
      );
    },
  );
}
