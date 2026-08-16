import { createHash } from 'node:crypto';

import type { LevelEligibilityPolicyRepository } from '@phub/database';
import {
  evaluateLevelEligibility,
  levelResultAllowsParticipation,
  LEVEL_ELIGIBILITY_MODES,
  PARTICIPATION_ACTIVITY_TYPES,
  type ParticipationActivityType,
} from '@phub/domain';
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import { z } from 'zod';

import { sendApiError } from '../http-errors.js';

const sportCodeSchema = z
  .string()
  .regex(/^[A-Z][A-Z0-9_]{1,31}$/)
  .default('PADEL');
const activityTypeSchema = z.enum(PARTICIPATION_ACTIVITY_TYPES);
const policyInputSchema = z
  .object({
    expectedVersion: z.number().int().nonnegative(),
    mode: z.enum(LEVEL_ELIGIBILITY_MODES),
    lowerToleranceSteps: z.number().int().nonnegative(),
    upperToleranceSteps: z.number().int().nonnegative(),
    missingActivityConstraintAction: z.enum(['ALLOW', 'WARN', 'BLOCK']),
    legacyTextConstraintAction: z.enum(['ALLOW', 'WARN']),
    recheckWaitlistPromotion: z.boolean(),
    changeComment: z.string().trim().min(3).max(500),
  })
  .strict();
const rollbackInputSchema = z
  .object({
    expectedVersion: z.number().int().positive(),
    targetVersion: z.number().int().positive(),
    changeComment: z.string().trim().min(3).max(500),
  })
  .strict();
const previewInputSchema = z
  .object({
    sportCode: sportCodeSchema,
    activityType: activityTypeSchema,
    playerLevelId: z.string().uuid().nullable(),
    minimumLevelId: z.string().uuid().nullable(),
    maximumLevelId: z.string().uuid().nullable(),
    personalInvitation: z.boolean(),
    organizerCreation: z.boolean(),
    policy: policyInputSchema.omit({ expectedVersion: true, changeComment: true }),
  })
  .strict();

function principal(request: FastifyRequest): { tenantId: string; actorUserId: string } | undefined {
  const tenantId = request.tenantId;
  const actorUserId = request.padlHubClaims?.sub;
  return tenantId && actorUserId ? { tenantId, actorUserId } : undefined;
}

function requirePermission(
  request: FastifyRequest,
  reply: FastifyReply,
  mode: 'read' | 'publish',
): boolean {
  if (request.headers['x-app-platform'] !== 'cup-admin') {
    sendApiError(request, reply, 403, 'ADMIN_CLIENT_REQUIRED', 'Операция доступна только из ЦУП.');
    return false;
  }
  const roles = request.padlHubClaims?.roles ?? [];
  const permissions = request.padlHubClaims?.permissions ?? [];
  const allowed =
    roles.includes('admin') &&
    (mode === 'publish'
      ? permissions.includes('eligibility.publish')
      : permissions.some((value) =>
          ['eligibility.read', 'eligibility.manage', 'eligibility.publish'].includes(value),
        ));
  if (allowed) return true;
  sendApiError(
    request,
    reply,
    403,
    'LEVEL_ELIGIBILITY_ADMIN_PERMISSION_REQUIRED',
    mode === 'publish'
      ? 'Нет права на публикацию правил допуска.'
      : 'Нет права на просмотр правил допуска.',
  );
  return false;
}

function unavailable(request: FastifyRequest, reply: FastifyReply) {
  return sendApiError(
    request,
    reply,
    503,
    'LEVEL_ELIGIBILITY_ADMIN_UNAVAILABLE',
    'Управление правилами допуска временно недоступно.',
  );
}

function requestHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function idempotencyKey(request: FastifyRequest): string {
  const value = request.headers['idempotency-key'];
  if (typeof value !== 'string') throw new Error('LEVEL_ELIGIBILITY_IDEMPOTENCY_MISSING');
  return value;
}

function activityType(
  request: FastifyRequest,
  reply: FastifyReply,
): ParticipationActivityType | undefined {
  const parsed = activityTypeSchema.safeParse(
    (request.params as { readonly activityType?: string }).activityType,
  );
  if (parsed.success) return parsed.data;
  sendApiError(request, reply, 400, 'ACTIVITY_TYPE_INVALID', 'Некорректный тип активности.');
  return undefined;
}

function sportCode(request: FastifyRequest, reply: FastifyReply): string | undefined {
  const parsed = sportCodeSchema.safeParse(
    (request.query as { readonly sportCode?: string }).sportCode,
  );
  if (parsed.success) return parsed.data;
  sendApiError(request, reply, 400, 'SPORT_CODE_INVALID', 'Некорректный вид спорта.');
  return undefined;
}

function publishResult(
  request: FastifyRequest,
  reply: FastifyReply,
  result: Awaited<ReturnType<LevelEligibilityPolicyRepository['publish']>>,
) {
  switch (result.outcome) {
    case 'applied':
      return { policy: result.policy, replayed: result.replayed };
    case 'version_conflict':
      return sendApiError(
        request,
        reply,
        409,
        'LEVEL_POLICY_VERSION_CONFLICT',
        `Политику уже изменили. Текущая версия: ${result.currentVersion}.`,
      );
    case 'idempotency_conflict':
      return sendApiError(
        request,
        reply,
        409,
        'LEVEL_POLICY_IDEMPOTENCY_CONFLICT',
        'Ключ операции уже использован с другими данными.',
      );
    case 'sport_not_found':
      return sendApiError(
        request,
        reply,
        404,
        'LEVEL_POLICY_SPORT_NOT_FOUND',
        'Каноническая шкала для вида спорта не найдена.',
      );
    case 'activation_not_ready':
      return sendApiError(
        request,
        reply,
        422,
        'LEVEL_POLICY_BLOCK_ACTIVATION_NOT_READY',
        `BLOCK недоступен до закрытия контуров: ${result.missingGates.join(', ')}.`,
      );
    case 'tolerance_out_of_range':
      return sendApiError(
        request,
        reply,
        422,
        'LEVEL_POLICY_TOLERANCE_OUT_OF_RANGE',
        `Допуск не может превышать ${result.maximumSteps} шагов.`,
      );
  }
}

export function registerLevelEligibilityAdminRoutes(
  app: FastifyInstance,
  options: {
    readonly repository?: LevelEligibilityPolicyRepository;
    readonly authenticatedTenantHandlers: readonly preHandlerHookHandler[];
    readonly commandHandlers: readonly preHandlerHookHandler[];
  },
): void {
  app.get(
    '/admin/api/v1/:tenantKey/level-eligibility',
    { preHandler: [...options.authenticatedTenantHandlers] },
    async (request, reply) => {
      if (!requirePermission(request, reply, 'read')) return;
      const current = principal(request);
      const sport = sportCode(request, reply);
      if (!current || !sport) return;
      if (!options.repository) return unavailable(request, reply);
      return options.repository.getState(current.tenantId, sport);
    },
  );

  app.get(
    '/admin/api/v1/:tenantKey/level-eligibility/:activityType/history',
    { preHandler: [...options.authenticatedTenantHandlers] },
    async (request, reply) => {
      if (!requirePermission(request, reply, 'read')) return;
      const current = principal(request);
      const sport = sportCode(request, reply);
      const type = activityType(request, reply);
      if (!current || !sport || !type) return;
      if (!options.repository) return unavailable(request, reply);
      return { items: await options.repository.listHistory(current.tenantId, sport, type) };
    },
  );

  app.get(
    '/admin/api/v1/:tenantKey/level-eligibility/impact',
    { preHandler: [...options.authenticatedTenantHandlers] },
    async (request, reply) => {
      if (!requirePermission(request, reply, 'read')) return;
      const current = principal(request);
      const sport = sportCode(request, reply);
      if (!current || !sport) return;
      if (!options.repository) return unavailable(request, reply);
      return { items: await options.repository.getImpact(current.tenantId, sport) };
    },
  );

  app.post(
    '/admin/api/v1/:tenantKey/level-eligibility/preview',
    { preHandler: [...options.authenticatedTenantHandlers] },
    async (request, reply) => {
      if (!requirePermission(request, reply, 'read')) return;
      const current = principal(request);
      const parsed = previewInputSchema.safeParse(request.body);
      if (!current) return;
      if (!parsed.success) {
        return sendApiError(request, reply, 400, 'INVALID_REQUEST', 'Некорректные данные preview.');
      }
      if (!options.repository) return unavailable(request, reply);
      const state = await options.repository.getState(current.tenantId, parsed.data.sportCode);
      const byId = new Map(state.levels.map((level) => [level.id, level]));
      const player = parsed.data.playerLevelId ? byId.get(parsed.data.playerLevelId) : undefined;
      const minimum = parsed.data.minimumLevelId ? byId.get(parsed.data.minimumLevelId) : undefined;
      const maximum = parsed.data.maximumLevelId ? byId.get(parsed.data.maximumLevelId) : undefined;
      const hasRange = Boolean(parsed.data.minimumLevelId || parsed.data.maximumLevelId);
      const result = evaluateLevelEligibility(
        {
          action: parsed.data.organizerCreation ? 'CREATE_ACTIVITY' : 'JOIN',
          activityType: parsed.data.activityType,
          activityId: '00000000-0000-4000-8000-000000000000',
          sportId: parsed.data.sportCode,
          playerId: current.actorUserId,
          playerLevel: player
            ? {
                playerId: current.actorUserId,
                sportId: parsed.data.sportCode,
                levelId: player.id,
                rank: player.rank,
                source: 'MANUAL',
                scaleVersion: player.scaleVersion,
              }
            : null,
          activityLevelConstraint: !hasRange
            ? { mode: 'NONE', source: 'CANONICAL', dataQuality: 'VALID' }
            : {
                mode: 'RANGE',
                ...(minimum ? { minLevelId: minimum.id, minRank: minimum.rank } : {}),
                ...(maximum ? { maxLevelId: maximum.id, maxRank: maximum.rank } : {}),
                source: 'CANONICAL',
                dataQuality: minimum && maximum ? 'VALID' : 'INVALID',
                scaleVersion: Math.max(minimum?.scaleVersion ?? 0, maximum?.scaleVersion ?? 0),
              },
          ...(parsed.data.personalInvitation
            ? { validPersonalInvitationId: '00000000-0000-4000-8000-000000000001' }
            : {}),
          ...(parsed.data.organizerCreation ? { actorIsOrganizer: true } : {}),
        },
        { ...parsed.data.policy, version: 0 },
      );
      return {
        allowed: levelResultAllowsParticipation(result),
        status:
          result.outcome === 'FAIL' ? 'DENIED' : result.outcome === 'WARN' ? 'WARNING' : 'ALLOWED',
        result,
      };
    },
  );

  app.put(
    '/admin/api/v1/:tenantKey/level-eligibility/:activityType',
    { preHandler: [...options.commandHandlers] },
    async (request, reply) => {
      if (!requirePermission(request, reply, 'publish')) return;
      const current = principal(request);
      const sport = sportCode(request, reply);
      const type = activityType(request, reply);
      const parsed = policyInputSchema.safeParse(request.body);
      if (!current || !sport || !type) return;
      if (!parsed.success) {
        return sendApiError(
          request,
          reply,
          400,
          'INVALID_REQUEST',
          'Некорректная политика допуска.',
        );
      }
      if (!options.repository) return unavailable(request, reply);
      return publishResult(
        request,
        reply,
        await options.repository.publish({
          tenantId: current.tenantId,
          actorUserId: current.actorUserId,
          sportCode: sport,
          activityType: type,
          ...parsed.data,
          idempotencyKey: idempotencyKey(request),
          requestHash: requestHash({ sport, type, ...parsed.data }),
        }),
      );
    },
  );

  app.post(
    '/admin/api/v1/:tenantKey/level-eligibility/:activityType/rollback',
    { preHandler: [...options.commandHandlers] },
    async (request, reply) => {
      if (!requirePermission(request, reply, 'publish')) return;
      const current = principal(request);
      const sport = sportCode(request, reply);
      const type = activityType(request, reply);
      const parsed = rollbackInputSchema.safeParse(request.body);
      if (!current || !sport || !type) return;
      if (!parsed.success) {
        return sendApiError(request, reply, 400, 'INVALID_REQUEST', 'Некорректный rollback.');
      }
      if (!options.repository) return unavailable(request, reply);
      const target = await options.repository.getVersion(
        current.tenantId,
        sport,
        type,
        parsed.data.targetVersion,
      );
      if (!target) {
        return sendApiError(
          request,
          reply,
          404,
          'LEVEL_POLICY_VERSION_NOT_FOUND',
          'Версия не найдена.',
        );
      }
      const command = {
        tenantId: current.tenantId,
        actorUserId: current.actorUserId,
        sportCode: sport,
        activityType: type,
        expectedVersion: parsed.data.expectedVersion,
        mode: target.mode,
        lowerToleranceSteps: target.lowerToleranceSteps,
        upperToleranceSteps: target.upperToleranceSteps,
        missingActivityConstraintAction: target.missingActivityConstraintAction,
        legacyTextConstraintAction: target.legacyTextConstraintAction,
        recheckWaitlistPromotion: target.recheckWaitlistPromotion,
        changeComment: parsed.data.changeComment,
        idempotencyKey: idempotencyKey(request),
        requestHash: requestHash({ sport, type, ...parsed.data }),
      };
      return publishResult(request, reply, await options.repository.publish(command));
    },
  );
}
