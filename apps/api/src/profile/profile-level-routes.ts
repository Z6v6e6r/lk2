import { createHash } from 'node:crypto';

import { PlayerLevelProjectionConflictError, type PlayerLevelRepository } from '@phub/database';
import { PADEL_LEVEL_ASSESSMENT_DEFINITION } from '@phub/domain';
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
const assessmentSchema = z
  .object({
    sportCode: z.literal('PADEL'),
    assessmentVersion: z.string().min(1).max(100),
    answers: z.record(z.string().regex(/^[a-z0-9_]{1,32}$/), z.array(z.string()).min(1).max(8)),
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

function cupAuthoritative(request: FastifyRequest, reply: FastifyReply) {
  return sendApiError(
    request,
    reply,
    409,
    'PROFILE_LEVEL_CUP_AUTHORITATIVE',
    'Уровень назначается в ЦУП. Подтвердите его в личном кабинете клуба.',
  );
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
      try {
        return await options.repository.getState(current.tenantId, current.playerId, sport.data);
      } catch (error) {
        if (error instanceof PlayerLevelProjectionConflictError) {
          return sendApiError(
            request,
            reply,
            409,
            'PROFILE_LEVEL_PROJECTION_CONFLICT',
            'Данные проекции уровня требуют проверки.',
          );
        }
        request.log.warn({ correlationId: request.id }, 'profile level read failed');
        return unavailable(request, reply);
      }
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
      if (parsed.data.sportCode === 'PADEL') return cupAuthoritative(request, reply);
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
      if (result.outcome === 'cup_authoritative') return cupAuthoritative(request, reply);
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

  app.get(
    '/user/api/v1/:tenantKey/profile/level-assessment',
    { preHandler: [...options.authenticatedTenantHandlers] },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (!canManageOwnLevel(request, reply)) return;
      if (!principal(request)) {
        return sendApiError(request, reply, 401, 'AUTH_REQUIRED', 'Требуется авторизация.');
      }
      return PADEL_LEVEL_ASSESSMENT_DEFINITION;
    },
  );

  app.post(
    '/user/api/v1/:tenantKey/profile/level-assessment',
    { preHandler: [...options.commandHandlers] },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (!canManageOwnLevel(request, reply)) return;
      const current = principal(request);
      const idempotencyKey = request.headers['idempotency-key'];
      if (!current || typeof idempotencyKey !== 'string') {
        return sendApiError(request, reply, 401, 'AUTH_REQUIRED', 'Требуется авторизация.');
      }
      const parsed = assessmentSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendApiError(
          request,
          reply,
          400,
          'LEVEL_ASSESSMENT_PAYLOAD_INVALID',
          'Ответы анкеты некорректны.',
        );
      }
      return cupAuthoritative(request, reply);
    },
  );
}
