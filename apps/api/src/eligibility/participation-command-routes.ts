import { createHash, timingSafeEqual } from 'node:crypto';

import {
  PARTICIPATION_COMMAND_ACTIONS,
  PARTICIPATION_PAYMENT_MODES,
  type ParticipationCommandRepository,
  type ParticipationCommandView,
} from '@phub/database';
import { PARTICIPATION_ACTIVITY_TYPES } from '@phub/domain';
import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify';
import { z } from 'zod';

import { sendApiError } from '../http-errors.js';
import {
  CupIdentityVerificationError,
  type VerifiedCupIdentity,
} from '../identity/cup-identity-verifier.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{2,127}$/;
const AUTHORIZATION_PATTERN = /^Bearer\s+\S+$/i;

export interface ParticipationIdentityVerifier {
  verify(authorization: string): Promise<VerifiedCupIdentity>;
}

const authorizeSchema = z
  .object({
    activity: z
      .object({
        type: z.enum(PARTICIPATION_ACTIVITY_TYPES),
        id: z.string().uuid(),
        expectedSourceRevision: z.number().int().nonnegative().optional(),
      })
      .strict(),
    action: z.enum(PARTICIPATION_COMMAND_ACTIONS),
    payment: z
      .object({
        operationId: z.string().uuid(),
        mode: z.enum(PARTICIPATION_PAYMENT_MODES),
      })
      .strict()
      .optional(),
  })
  .strict();

const acknowledgementSchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('APPLIED'), writerOperationId: z.string().uuid() }).strict(),
  z
    .object({
      outcome: z.literal('FAILED'),
      writerOperationId: z.string().uuid(),
      errorCode: z.string().regex(ERROR_CODE_PATTERN),
    })
    .strict(),
]);

function constantTimeEqual(expected: string, supplied: string | undefined): boolean {
  if (!supplied) return false;
  const expectedBytes = Buffer.from(expected);
  const suppliedBytes = Buffer.from(supplied);
  return (
    expectedBytes.length === suppliedBytes.length && timingSafeEqual(expectedBytes, suppliedBytes)
  );
}

function requestHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function idempotencyKey(request: FastifyRequest): string {
  const value = request.headers['idempotency-key'];
  if (typeof value !== 'string') throw new Error('PARTICIPATION_IDEMPOTENCY_MIDDLEWARE_MISSING');
  return value;
}

/**
 * Digest of the originating caller credential, recorded on the command so that a later
 * acknowledgement can be bound to the caller that authorized it.
 *
 * Without this, every holder of the tenant-wide integration token is interchangeable and any of
 * them can acknowledge another caller's command as APPLIED or FAILED.
 */
function callerKey(request: FastifyRequest): string | undefined {
  const value = request.headers['x-phub-participation-caller-token'];
  if (typeof value !== 'string' || !value.trim()) return undefined;
  return createHash('sha256').update(value.trim()).digest('hex');
}

function commandResponse(
  reply: Parameters<typeof sendApiError>[1],
  view: ParticipationCommandView,
) {
  if (view.state === 'AUTHORIZED' || view.state === 'APPLIED') return reply.send(view);
  return reply.status(409).send(view);
}

export function registerParticipationCommandRoutes(
  app: FastifyInstance,
  options: {
    readonly enabled: boolean;
    readonly integrationToken?: string;
    readonly authorizedTenantKey?: string;
    readonly principalKey?: string;
    readonly authorizationTtlSeconds: number;
    readonly repository?: ParticipationCommandRepository;
    /**
     * Verifies the end user's forwarded bearer assertion and returns the external identity
     * (issuer, subject). The canonical actor is then resolved from that verified identity, so a
     * caller can never nominate an arbitrary end user in the request body.
     */
    readonly identityVerifier?: ParticipationIdentityVerifier;
    readonly commandHandlers: readonly preHandlerHookHandler[];
    readonly readHandlers: readonly preHandlerHookHandler[];
  },
): void {
  const requireServiceBoundary = async (
    request: FastifyRequest,
    reply: Parameters<typeof sendApiError>[1],
  ): Promise<boolean> => {
    reply.header('Cache-Control', 'no-store');
    if (
      !options.enabled ||
      !options.integrationToken ||
      !options.authorizedTenantKey ||
      !options.principalKey ||
      !options.repository ||
      !options.identityVerifier
    ) {
      sendApiError(
        request,
        reply,
        503,
        'PARTICIPATION_COMMANDS_DISABLED',
        'Серверный контур допуска отключён.',
      );
      return false;
    }
    const supplied = request.headers['x-phub-participation-token'];
    if (
      typeof supplied !== 'string' ||
      !constantTimeEqual(options.integrationToken, supplied) ||
      (request.params as { readonly tenantKey?: string }).tenantKey !== options.authorizedTenantKey
    ) {
      sendApiError(
        request,
        reply,
        403,
        'PARTICIPATION_COMMANDS_FORBIDDEN',
        'Серверный контур допуска недоступен.',
      );
      return false;
    }
    if (!request.tenantId) {
      sendApiError(
        request,
        reply,
        503,
        'PARTICIPATION_TENANT_CONTEXT_UNAVAILABLE',
        'Контекст организации недоступен.',
      );
      return false;
    }
    return true;
  };

  app.post(
    '/internal/api/v1/:tenantKey/participation-commands',
    { preHandler: [...options.commandHandlers] },
    async (request, reply) => {
      if (!(await requireServiceBoundary(request, reply))) return;
      const parsed = authorizeSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendApiError(
          request,
          reply,
          400,
          'PARTICIPATION_COMMAND_INVALID',
          'Некорректная команда допуска.',
        );
      }
      // The end user is never named by the caller. The caller forwards the user's own bearer
      // assertion; we verify it and resolve the canonical PadlHub actor from the verified
      // external identity, scoped to the tenant.
      const authorization = request.headers.authorization;
      if (!authorization || !AUTHORIZATION_PATTERN.test(authorization)) {
        return sendApiError(
          request,
          reply,
          401,
          'PARTICIPATION_USER_ASSERTION_REQUIRED',
          'Требуется подтверждение пользователя.',
        );
      }
      let identity: VerifiedCupIdentity;
      try {
        identity = await options.identityVerifier!.verify(authorization);
      } catch (error) {
        if (error instanceof CupIdentityVerificationError) {
          return sendApiError(
            request,
            reply,
            error.outcome === 'rejected' ? 401 : 503,
            error.outcome === 'rejected'
              ? 'PARTICIPATION_USER_ASSERTION_INVALID'
              : 'PARTICIPATION_IDENTITY_VERIFIER_UNAVAILABLE',
            error.outcome === 'rejected'
              ? 'Подтверждение пользователя недействительно.'
              : 'Проверка пользователя временно недоступна.',
          );
        }
        throw error;
      }
      const tenantKey = (request.params as { readonly tenantKey?: string }).tenantKey;
      if (!tenantKey || identity.tenantKey !== tenantKey) {
        return sendApiError(
          request,
          reply,
          403,
          'PARTICIPATION_USER_TENANT_MISMATCH',
          'Подтверждение относится к другой организации.',
        );
      }
      const resolvedActor = await options.repository!.resolveActor({
        tenantId: request.tenantId!,
        issuer: identity.issuer,
        subject: identity.subject,
      });
      if (resolvedActor.outcome === 'actor_not_linked') {
        return sendApiError(
          request,
          reply,
          409,
          'PARTICIPATION_ACTOR_NOT_LINKED',
          'Профиль ещё не связан с PadlHub. Обновите авторизацию.',
        );
      }
      const originatingCaller = callerKey(request);
      const result = await options.repository!.authorize({
        tenantId: request.tenantId!,
        principalKey: options.principalKey!,
        ...(originatingCaller ? { callerKey: originatingCaller } : {}),
        idempotencyKey: idempotencyKey(request),
        // The hash covers the resolved actor, so the same Idempotency-Key replayed by a
        // different user is a conflict rather than a replay of someone else's decision.
        requestHash: requestHash({
          actorUserId: resolvedActor.userId,
          activity: parsed.data.activity,
          action: parsed.data.action,
          ...(parsed.data.payment ? { payment: parsed.data.payment } : {}),
        }),
        actorUserId: resolvedActor.userId,
        activityType: parsed.data.activity.type,
        activityId: parsed.data.activity.id,
        action: parsed.data.action,
        ...(parsed.data.activity.expectedSourceRevision === undefined
          ? {}
          : { expectedActivityRevision: parsed.data.activity.expectedSourceRevision }),
        ...(parsed.data.payment ? { payment: parsed.data.payment } : {}),
        correlationId: request.id,
        authorizationTtlSeconds: options.authorizationTtlSeconds,
      });
      if (result.outcome === 'command') return commandResponse(reply, result);
      const conflicts = {
        actor_not_found: ['PARTICIPATION_ACTOR_NOT_FOUND', 'Игрок не найден.'],
        activity_not_found: ['PARTICIPATION_ACTIVITY_NOT_FOUND', 'Активность не найдена.'],
        activity_revision_conflict: [
          'PARTICIPATION_ACTIVITY_REVISION_CONFLICT',
          'Активность изменилась. Повторите проверку.',
        ],
        idempotency_conflict: [
          'IDEMPOTENCY_KEY_REUSED',
          'Idempotency-Key уже использован для другой команды.',
        ],
        payment_operation_conflict: [
          'PARTICIPATION_PAYMENT_OPERATION_CONFLICT',
          'Платёжная операция уже связана с другим решением.',
        ],
      } as const;
      const [code, message] = conflicts[result.outcome];
      return sendApiError(request, reply, 409, code, message);
    },
  );

  app.post(
    '/internal/api/v1/:tenantKey/participation-commands/:commandId/acknowledgements',
    { preHandler: [...options.commandHandlers] },
    async (request, reply) => {
      if (!(await requireServiceBoundary(request, reply))) return;
      const commandId = (request.params as { readonly commandId?: string }).commandId;
      const parsed = acknowledgementSchema.safeParse(request.body);
      if (!commandId || !UUID_PATTERN.test(commandId) || !parsed.success) {
        return sendApiError(
          request,
          reply,
          400,
          'PARTICIPATION_ACKNOWLEDGEMENT_INVALID',
          'Некорректное подтверждение записи.',
        );
      }
      const acknowledgingCaller = callerKey(request);
      const result = await options.repository!.acknowledge({
        tenantId: request.tenantId!,
        principalKey: options.principalKey!,
        ...(acknowledgingCaller ? { callerKey: acknowledgingCaller } : {}),
        commandId,
        idempotencyKey: idempotencyKey(request),
        requestHash: requestHash(parsed.data),
        writerOperationId: parsed.data.writerOperationId,
        result:
          parsed.data.outcome === 'APPLIED'
            ? { outcome: 'APPLIED' }
            : { outcome: 'FAILED', errorCode: parsed.data.errorCode },
        correlationId: request.id,
      });
      if (result.outcome === 'command') return commandResponse(reply, result);
      if (result.outcome === 'writer_operation_conflict') {
        return sendApiError(
          request,
          reply,
          409,
          'PARTICIPATION_WRITER_OPERATION_CONFLICT',
          'Операция записи уже связана с другой командой.',
        );
      }
      return sendApiError(
        request,
        reply,
        result.outcome === 'command_not_found' ? 404 : 409,
        result.outcome === 'command_not_found'
          ? 'PARTICIPATION_COMMAND_NOT_FOUND'
          : 'IDEMPOTENCY_KEY_REUSED',
        result.outcome === 'command_not_found'
          ? 'Команда допуска не найдена.'
          : 'Idempotency-Key уже использован для другого подтверждения.',
      );
    },
  );

  app.get(
    '/internal/api/v1/:tenantKey/participation-commands/:commandId',
    { preHandler: [...options.readHandlers] },
    async (request, reply) => {
      if (!(await requireServiceBoundary(request, reply))) return;
      const commandId = (request.params as { readonly commandId?: string }).commandId;
      if (!commandId || !UUID_PATTERN.test(commandId)) {
        return sendApiError(
          request,
          reply,
          400,
          'PARTICIPATION_COMMAND_ID_INVALID',
          'Некорректный идентификатор команды.',
        );
      }
      const readingCaller = callerKey(request);
      const view = await options.repository!.get({
        tenantId: request.tenantId!,
        principalKey: options.principalKey!,
        ...(readingCaller ? { callerKey: readingCaller } : {}),
        commandId,
      });
      if (!view) {
        return sendApiError(
          request,
          reply,
          404,
          'PARTICIPATION_COMMAND_NOT_FOUND',
          'Команда допуска не найдена.',
        );
      }
      return reply.send(view);
    },
  );
}
