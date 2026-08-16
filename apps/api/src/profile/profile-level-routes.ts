import { createHash } from 'node:crypto';

import type { PlayerLevelRepository } from '@phub/database';
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import { z } from 'zod';

import { sendApiError } from '../http-errors.js';

const sportCodeSchema = z
  .string()
  .regex(/^[A-Z][A-Z0-9_]{1,31}$/)
  .default('PADEL');
const updateSchema = z
  .object({
    sportCode: sportCodeSchema,
    levelId: z.string().uuid(),
  })
  .strict();

function principal(request: FastifyRequest): { tenantId: string; playerId: string } | undefined {
  const tenantId = request.tenantId;
  const playerId = request.padlHubClaims?.sub;
  return tenantId && playerId ? { tenantId, playerId } : undefined;
}

function canManageOwnLevel(request: FastifyRequest, reply: FastifyReply): boolean {
  if (request.padlHubClaims?.permissions.includes('profile.read')) return true;
  sendApiError(
    request,
    reply,
    403,
    'PROFILE_LEVEL_PERMISSION_REQUIRED',
    'Нет доступа к уровню профиля.',
  );
  return false;
}

function unavailable(request: FastifyRequest, reply: FastifyReply) {
  return sendApiError(
    request,
    reply,
    503,
    'PROFILE_LEVEL_UNAVAILABLE',
    'Уровень профиля временно недоступен.',
  );
}

function requestHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function registerProfileLevelRoutes(
  app: FastifyInstance,
  options: {
    readonly repository?: PlayerLevelRepository;
    readonly authenticatedTenantHandlers: readonly preHandlerHookHandler[];
    readonly commandHandlers: readonly preHandlerHookHandler[];
  },
): void {
  app.get(
    '/user/api/v1/:tenantKey/profile/level',
    { preHandler: [...options.authenticatedTenantHandlers] },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (!canManageOwnLevel(request, reply)) return;
      const current = principal(request);
      const sport = sportCodeSchema.safeParse(
        (request.query as { readonly sportCode?: string }).sportCode,
      );
      if (!current) {
        return sendApiError(request, reply, 401, 'AUTH_REQUIRED', 'Требуется авторизация.');
      }
      if (!sport.success) {
        return sendApiError(request, reply, 400, 'SPORT_CODE_INVALID', 'Некорректный вид спорта.');
      }
      if (!options.repository) return unavailable(request, reply);
      return options.repository.getState(current.tenantId, current.playerId, sport.data);
    },
  );

  app.put(
    '/user/api/v1/:tenantKey/profile/level',
    { preHandler: [...options.commandHandlers] },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (!canManageOwnLevel(request, reply)) return;
      const current = principal(request);
      const idempotencyKey = request.headers['idempotency-key'];
      if (!current || typeof idempotencyKey !== 'string') {
        return sendApiError(request, reply, 401, 'AUTH_REQUIRED', 'Требуется авторизация.');
      }
      const parsed = updateSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendApiError(
          request,
          reply,
          400,
          'PROFILE_LEVEL_PAYLOAD_INVALID',
          'Выберите уровень из актуальной шкалы.',
        );
      }
      if (!options.repository) return unavailable(request, reply);
      const result = await options.repository.setLevel({
        tenantId: current.tenantId,
        playerId: current.playerId,
        sportCode: parsed.data.sportCode,
        levelId: parsed.data.levelId,
        source: 'SELF_DECLARED',
        idempotencyKey,
        requestHash: requestHash(parsed.data),
        correlationId: request.id,
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
      if (result.outcome === 'level_not_found') {
        return sendApiError(
          request,
          reply,
          409,
          'PROFILE_LEVEL_STALE',
          'Шкала уровней изменилась. Обновите список и выберите уровень ещё раз.',
        );
      }
      if (result.outcome === 'profile_not_found') {
        return sendApiError(request, reply, 404, 'PROFILE_NOT_FOUND', 'Профиль не найден.');
      }
      reply.header('X-Idempotent-Replayed', String(result.replayed));
      return result.level;
    },
  );
}
