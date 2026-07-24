import { createHash } from 'node:crypto';

import type {
  GameResultCommandErrorCode,
  GameResultCommandResult,
  GameResultRepository,
} from '@phub/database';
import {
  disputeGameResultInputSchema,
  submitGameResultInputSchema,
  type DisputeGameResultInput,
  type SubmitGameResultInput,
} from '@phub/games';
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';

import { sendApiError } from '../http-errors.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type UserResultRepository = Pick<GameResultRepository, 'submit' | 'confirm' | 'dispute'>;
type ResultOperation = 'SUBMIT_RESULT' | 'CONFIRM_RESULT' | 'DISPUTE_RESULT';

const ERROR_MESSAGES: Record<GameResultCommandErrorCode, string> = {
  GAME_NOT_FOUND: 'Игра не найдена.',
  GAME_RESULT_NOT_AVAILABLE: 'Результат можно внести только после завершения игры.',
  GAME_RESULT_NOT_PARTICIPANT: 'Внести результат может только участник игры.',
  GAME_RESULT_INVALID_ROSTER: 'В каждом сете должны быть все четыре участника игры.',
  GAME_RESULT_SUBMISSION_NOT_FOUND: 'Предложение результата не найдено.',
  GAME_RESULT_REVIEW_FORBIDDEN: 'Автор не может согласовать свой результат.',
  GAME_RESULT_STATE_CONFLICT: 'Результат уже изменился. Обновите карточку игры.',
};

function principal(request: FastifyRequest): { tenantId: string; userId: string } | undefined {
  const current = request as FastifyRequest & {
    readonly tenantId?: string;
    readonly padlHubClaims?: { readonly sub?: string };
  };
  const userId = current.padlHubClaims?.sub;
  return current.tenantId && userId ? { tenantId: current.tenantId, userId } : undefined;
}

function routeId(
  request: FastifyRequest,
  reply: FastifyReply,
  name: 'gameId' | 'submissionId',
): string | undefined {
  const value = (request.params as Record<string, string | undefined>)[name];
  if (!value || !UUID_PATTERN.test(value)) {
    sendApiError(request, reply, 400, 'INVALID_REQUEST', 'Некорректный идентификатор.');
    return undefined;
  }
  return value;
}

function idempotencyKey(request: FastifyRequest): string {
  const value = request.headers['idempotency-key'];
  if (typeof value !== 'string') throw new Error('GAME_IDEMPOTENCY_PREHANDLER_MISSING');
  return value;
}

function requestHash(operation: ResultOperation, gameId: string, payload: unknown): string {
  return createHash('sha256').update(JSON.stringify({ operation, gameId, payload })).digest('hex');
}

function unavailable(request: FastifyRequest, reply: FastifyReply) {
  return sendApiError(
    request,
    reply,
    503,
    'GAMES_RESULTS_RUNTIME_UNAVAILABLE',
    'Внесение результатов временно недоступно.',
  );
}

function rejected(
  request: FastifyRequest,
  reply: FastifyReply,
  result: Exclude<GameResultCommandResult, { outcome: 'applied' }>,
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
  const status = result.code.endsWith('NOT_FOUND')
    ? 404
    : result.code === 'GAME_RESULT_REVIEW_FORBIDDEN'
      ? 403
      : result.code === 'GAME_RESULT_INVALID_ROSTER'
        ? 400
        : 409;
  return sendApiError(request, reply, status, result.code, ERROR_MESSAGES[result.code]);
}

function operationBody(
  result: Extract<GameResultCommandResult, { outcome: 'applied' }>,
  type: ResultOperation,
) {
  return {
    commandId: result.commandId,
    operation: {
      id: result.commandId,
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
}

export function registerGameResultRoutes(
  app: FastifyInstance,
  options: {
    readonly repository?: UserResultRepository;
    readonly commandHandlers: readonly preHandlerHookHandler[];
  },
): void {
  app.post(
    '/user/api/v1/:tenantKey/games/:gameId/result-submissions',
    { preHandler: [...options.commandHandlers] },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const current = principal(request);
      if (!current)
        return sendApiError(request, reply, 401, 'AUTH_REQUIRED', 'Требуется авторизация.');
      const gameId = routeId(request, reply, 'gameId');
      if (!gameId) return reply;
      const body = submitGameResultInputSchema.safeParse(request.body);
      if (!body.success) {
        return sendApiError(
          request,
          reply,
          400,
          'INVALID_REQUEST',
          'Проверьте состав пар и счёт сетов.',
        );
      }
      if (!options.repository) return unavailable(request, reply);
      const payload: SubmitGameResultInput = body.data;
      const result = await options.repository.submit({
        tenantId: current.tenantId,
        actorUserId: current.userId,
        gameId,
        result: payload,
        idempotencyKey: idempotencyKey(request),
        requestHash: requestHash('SUBMIT_RESULT', gameId, payload),
        correlationId: request.id,
      });
      if (result.outcome !== 'applied') return rejected(request, reply, result);
      return operationBody(result, 'SUBMIT_RESULT');
    },
  );

  app.post(
    '/user/api/v1/:tenantKey/games/:gameId/result-submissions/:submissionId/confirm',
    { preHandler: [...options.commandHandlers] },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const current = principal(request);
      if (!current)
        return sendApiError(request, reply, 401, 'AUTH_REQUIRED', 'Требуется авторизация.');
      const gameId = routeId(request, reply, 'gameId');
      const submissionId = routeId(request, reply, 'submissionId');
      if (!gameId || !submissionId) return reply;
      if (!options.repository) return unavailable(request, reply);
      const result = await options.repository.confirm({
        tenantId: current.tenantId,
        actorUserId: current.userId,
        gameId,
        submissionId,
        idempotencyKey: idempotencyKey(request),
        requestHash: requestHash('CONFIRM_RESULT', gameId, { submissionId }),
        correlationId: request.id,
      });
      if (result.outcome !== 'applied') return rejected(request, reply, result);
      return operationBody(result, 'CONFIRM_RESULT');
    },
  );

  app.post(
    '/user/api/v1/:tenantKey/games/:gameId/result-submissions/:submissionId/dispute',
    { preHandler: [...options.commandHandlers] },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const current = principal(request);
      if (!current)
        return sendApiError(request, reply, 401, 'AUTH_REQUIRED', 'Требуется авторизация.');
      const gameId = routeId(request, reply, 'gameId');
      const submissionId = routeId(request, reply, 'submissionId');
      if (!gameId || !submissionId) return reply;
      const rawBody =
        typeof request.body === 'object' && request.body !== null && !Array.isArray(request.body)
          ? {
              ...request.body,
              ...((request.body as { note?: unknown }).note === null ? { note: undefined } : {}),
            }
          : request.body;
      const body = disputeGameResultInputSchema.safeParse(rawBody);
      if (!body.success) {
        return sendApiError(request, reply, 400, 'INVALID_REQUEST', 'Укажите причину оспаривания.');
      }
      if (!options.repository) return unavailable(request, reply);
      const payload: DisputeGameResultInput = body.data;
      const result = await options.repository.dispute({
        tenantId: current.tenantId,
        actorUserId: current.userId,
        gameId,
        submissionId,
        dispute: payload,
        idempotencyKey: idempotencyKey(request),
        requestHash: requestHash('DISPUTE_RESULT', gameId, { submissionId, ...payload }),
        correlationId: request.id,
      });
      if (result.outcome !== 'applied') return rejected(request, reply, result);
      return operationBody(result, 'DISPUTE_RESULT');
    },
  );
}
