import { createHash, timingSafeEqual } from 'node:crypto';

import type { CupPlayerLevelProjectionRepository } from '@phub/database';
import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify';
import { z } from 'zod';

import { sendApiError } from '../http-errors.js';

const payloadSchema = z
  .object({
    schemaVersion: z.literal(1),
    sourceEventId: z.string().trim().min(8).max(200),
    sourceRevision: z.number().int().nonnegative(),
    occurredAt: z.string().datetime({ offset: true }),
    player: z
      .object({
        externalClientId: z.string().trim().min(1).max(200),
      })
      .strict(),
    sportCode: z.literal('PADEL'),
    level: z
      .object({
        code: z.enum(['D', 'D+', 'C', 'C+', 'B', 'B+', 'A']),
        numericValue: z.number().min(1).max(7),
      })
      .strict(),
    source: z
      .object({
        eventType: z.enum([
          'RATING_INITIAL_IMPORTED',
          'RATING_BOOTSTRAPPED_FROM_VIVA',
          'RATING_MANUALLY_CHANGED',
        ]),
        formulaVersion: z.string().trim().min(1).max(100),
      })
      .strict(),
  })
  .strict();

function constantTimeEqual(expected: string, supplied: string | undefined): boolean {
  if (!supplied) return false;
  const expectedBytes = Buffer.from(expected);
  const suppliedBytes = Buffer.from(supplied);
  return (
    expectedBytes.length === suppliedBytes.length && timingSafeEqual(expectedBytes, suppliedBytes)
  );
}

function idempotencyKey(request: FastifyRequest): string | undefined {
  const value = request.headers['idempotency-key'];
  return typeof value === 'string' ? value : undefined;
}

function requestHash(payload: z.infer<typeof payloadSchema>): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

export function registerCupPlayerLevelProjectionRoutes(
  app: FastifyInstance,
  options: {
    readonly enabled: boolean;
    readonly integrationToken?: string;
    readonly authorizedTenantKey?: string;
    readonly repository?: CupPlayerLevelProjectionRepository;
    readonly commandHandlers: readonly preHandlerHookHandler[];
  },
): void {
  app.post(
    '/internal/api/v1/:tenantKey/player-level-projections',
    { preHandler: [...options.commandHandlers] },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (!options.enabled || !options.integrationToken || !options.repository) {
        return sendApiError(
          request,
          reply,
          503,
          'CUP_PLAYER_LEVEL_PROJECTION_DISABLED',
          'Синхронизация уровней отключена.',
        );
      }
      const supplied = request.headers['x-cup-player-level-token'];
      if (typeof supplied !== 'string' || !constantTimeEqual(options.integrationToken, supplied)) {
        return sendApiError(
          request,
          reply,
          403,
          'CUP_PLAYER_LEVEL_PROJECTION_FORBIDDEN',
          'Синхронизация уровней недоступна.',
        );
      }
      const tenantKey = (request.params as { readonly tenantKey?: unknown }).tenantKey;
      if (
        typeof tenantKey !== 'string' ||
        !options.authorizedTenantKey ||
        tenantKey !== options.authorizedTenantKey
      ) {
        return sendApiError(
          request,
          reply,
          403,
          'CUP_PLAYER_LEVEL_TENANT_FORBIDDEN',
          'Синхронизация уровней недоступна для этой организации.',
        );
      }
      const parsed = payloadSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendApiError(
          request,
          reply,
          400,
          'CUP_PLAYER_LEVEL_PROJECTION_INVALID',
          'Некорректная проекция уровня.',
        );
      }
      if (
        parsed.data.source.formulaVersion !== 'padel-rating-grade-v1'
      ) {
        return sendApiError(
          request,
          reply,
          400,
          'CUP_PLAYER_LEVEL_FORMULA_MISMATCH',
          'Версия формулы уровня не поддерживается.',
        );
      }
      const key = idempotencyKey(request);
      if (!key || key !== parsed.data.sourceEventId) {
        return sendApiError(
          request,
          reply,
          400,
          'CUP_PLAYER_LEVEL_IDEMPOTENCY_INVALID',
          'Некорректный ключ идемпотентности.',
        );
      }
      if (!request.tenantId) {
        return sendApiError(
          request,
          reply,
          503,
          'CUP_PLAYER_LEVEL_TENANT_UNAVAILABLE',
          'Организация временно недоступна.',
        );
      }
      const correlationId = String(reply.getHeader('X-Correlation-ID') ?? 'cup-level-projection');
      const result = await options.repository.apply({
        tenantId: request.tenantId,
        externalClientId: parsed.data.player.externalClientId,
        sportCode: parsed.data.sportCode,
        levelCode: parsed.data.level.code,
        numericValue: parsed.data.level.numericValue,
        sourceRevision: parsed.data.sourceRevision,
        sourceEventId: parsed.data.sourceEventId,
        sourceEventType: parsed.data.source.eventType,
        formulaVersion: parsed.data.source.formulaVersion,
        occurredAt: parsed.data.occurredAt,
        requestHash: requestHash(parsed.data),
        correlationId,
      });

      if (result.outcome === 'actor_not_mapped') {
        return sendApiError(
          request,
          reply,
          409,
          'CUP_PLAYER_LEVEL_ACTOR_NOT_MAPPED',
          'Профиль игрока ещё не связан.',
        );
      }
      if (result.outcome === 'level_not_found') {
        return sendApiError(
          request,
          reply,
          409,
          'CUP_PLAYER_LEVEL_CODE_UNKNOWN',
          'Код уровня не найден в активной шкале.',
        );
      }
      if (result.outcome === 'profile_not_found') {
        return sendApiError(
          request,
          reply,
          409,
          'CUP_PLAYER_LEVEL_PROFILE_NOT_FOUND',
          'Профиль игрока не найден.',
        );
      }
      if (result.outcome === 'idempotency_conflict') {
        return sendApiError(
          request,
          reply,
          409,
          'CUP_PLAYER_LEVEL_IDEMPOTENCY_CONFLICT',
          'Версия проекции противоречит сохранённой.',
        );
      }
      if (result.outcome === 'stale') {
        return reply.code(200).send({ outcome: 'stale', currentRevision: result.currentRevision });
      }
      return reply.code(200).send({
        outcome: result.outcome,
        replayed: result.replayed,
        projection: {
          sportCode: result.level.sportCode,
          code: result.level.code,
          numericValue: result.level.numericValue,
          scaleVersion: result.level.scaleVersion,
          source: result.level.source,
        },
      });
    },
  );
}
