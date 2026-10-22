import {
  NOTIFICATION_SCENARIO_CATALOG,
  notificationScenarioInputSchema,
} from '@phub/domain/notification-scenarios';
import type { NotificationScenarioRepository } from '@phub/database/notification-scenarios';
import type { FastifyInstance, FastifyRequest, FastifyReply, preHandlerHookHandler } from 'fastify';
import { z } from 'zod';

import { sendApiError } from '../http-errors.js';

const saveSchema = z
  .object({ expectedVersion: z.number().int().min(0), definition: notificationScenarioInputSchema })
  .strict();
export function registerNotificationScenarioRoutes(
  app: FastifyInstance,
  options: {
    readonly repository?: NotificationScenarioRepository;
    readonly runtimeEnabled: boolean;
    readonly authenticatedTenantHandlers: readonly preHandlerHookHandler[];
    readonly commandHandlers: readonly preHandlerHookHandler[];
  },
): void {
  async function handle(
    request: FastifyRequest,
    reply: FastifyReply,
    operation: (repository: NotificationScenarioRepository) => Promise<unknown>,
  ): Promise<unknown> {
    reply.header('Cache-Control', 'no-store');
    if (!options.repository || !request.tenantId)
      return sendApiError(
        request,
        reply,
        503,
        'NOTIFICATION_SCENARIOS_UNAVAILABLE',
        'Сценарии рассылок временно недоступны.',
      );
    try {
      return await operation(options.repository);
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      const status =
        code === 'ADMIN_PERMISSION_REQUIRED'
          ? 403
          : code === 'SCENARIO_NOT_FOUND'
            ? 404
            : [
                  'SCENARIO_VERSION_CONFLICT',
                  'IDEMPOTENCY_KEY_REUSED',
                  'SCENARIO_LIMIT_REACHED',
                ].includes(code)
              ? 409
              : 503;
      return sendApiError(
        request,
        reply,
        status,
        status === 503 ? 'NOTIFICATION_SCENARIOS_UNAVAILABLE' : code,
        status === 409
          ? 'Сценарий изменился или команда уже использована. Обновите данные.'
          : status === 403
            ? 'Недостаточно прав.'
            : 'Сценарии рассылок временно недоступны.',
      );
    }
  }
  const root = '/admin/api/v1/:tenantKey/notifications/scenarios';
  app.get(root, { preHandler: [...options.authenticatedTenantHandlers] }, (request, reply) =>
    handle(request, reply, async (repository) => ({
      items: await repository.list(request.tenantId!),
      catalog: NOTIFICATION_SCENARIO_CATALOG,
      runtimeEnabled: options.runtimeEnabled,
      channels: ['IN_APP', 'WEB_PUSH', 'ANDROID_PUSH'],
    })),
  );
  app.get(
    `${root}/runs`,
    { preHandler: [...options.authenticatedTenantHandlers] },
    (request, reply) => {
      const query = z
        .object({ scenarioId: z.string().uuid().optional() })
        .strict()
        .safeParse(request.query);
      if (!query.success)
        return sendApiError(request, reply, 400, 'INVALID_REQUEST', 'Некорректный фильтр журнала.');
      return handle(request, reply, async (repository) => ({
        items: await repository.runs(request.tenantId!, query.data.scenarioId),
      }));
    },
  );
  for (const method of ['POST', 'PUT'] as const)
    app.route({
      method,
      url: method === 'POST' ? root : `${root}/:scenarioId`,
      preHandler: [...options.commandHandlers],
      handler: (request, reply) => {
        const parsed = saveSchema.safeParse(request.body);
        const id =
          method === 'PUT'
            ? z
                .string()
                .uuid()
                .safeParse((request.params as { scenarioId: string }).scenarioId)
            : undefined;
        if (
          !parsed.success ||
          (id && !id.success) ||
          (method === 'POST' && parsed.data.expectedVersion !== 0)
        )
          return sendApiError(
            request,
            reply,
            400,
            'INVALID_REQUEST',
            'Проверьте параметры сценария и переменные шаблона.',
          );
        return handle(request, reply, (repository) =>
          repository.save({
            tenantId: request.tenantId!,
            actorUserId: request.padlHubClaims!.sub,
            ...(id?.success ? { id: id.data } : {}),
            ...parsed.data,
            idempotencyKey: request.headers['idempotency-key'] as string,
            correlationId: request.id,
          }),
        );
      },
    });
}
