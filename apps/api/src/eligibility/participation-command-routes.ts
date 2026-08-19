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

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{2,127}$/;

const authorizeSchema = z
  .object({
    actor: z.object({ userId: z.string().uuid() }).strict(),
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
      !options.repository
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
      const result = await options.repository!.authorize({
        tenantId: request.tenantId!,
        principalKey: options.principalKey!,
        idempotencyKey: idempotencyKey(request),
        requestHash: requestHash(parsed.data),
        actorUserId: parsed.data.actor.userId,
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
      const result = await options.repository!.acknowledge({
        tenantId: request.tenantId!,
        principalKey: options.principalKey!,
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
      const view = await options.repository!.get({
        tenantId: request.tenantId!,
        principalKey: options.principalKey!,
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
