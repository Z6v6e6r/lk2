import {
  VIVA_CLIENT_ADMIN_MAX_PAGE_SIZE,
  VIVA_CLIENT_BOOKING_PERIODS,
  VIVA_CLIENT_SUBSCRIPTION_GROUPS,
  VivaClientAdminReadError,
  type VivaClientAdminReadSource,
} from '@phub/viva-adapter';
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import { z } from 'zod';

import { sendApiError } from '../http-errors.js';

/**
 * CUP operator read of one PadlHub user's Viva record: card, counters, subscriptions,
 * bookings and transactions. Read-only (Viva GET only), `support.read` or `support.manage`,
 * `X-App-Platform: cup-admin`, tenant from the admin JWT, Viva client resolved server-side from
 * the synced identity mapping. Responses carry no Viva identifiers and no contact PII.
 */

export type UserVivaAdminSource = Pick<
  VivaClientAdminReadSource,
  'readProfile' | 'readSummary' | 'listSubscriptions' | 'listBookings' | 'listTransactions'
>;

export type UserVivaAdminSection =
  'profile' | 'summary' | 'subscriptions' | 'bookings' | 'transactions';

const paramsSchema = z.object({ tenantKey: z.string().min(1), userId: z.string().uuid() }).strict();
const pageQuery = {
  page: z.coerce.number().int().min(0).max(1_000).default(0),
  size: z.coerce.number().int().min(1).max(VIVA_CLIENT_ADMIN_MAX_PAGE_SIZE).default(25),
};
const emptyQuerySchema = z.object({}).strict();
const subscriptionsQuerySchema = z
  .object({ group: z.enum(VIVA_CLIENT_SUBSCRIPTION_GROUPS).default('CURRENT'), ...pageQuery })
  .strict();
const bookingsQuerySchema = z
  .object({
    period: z.enum(VIVA_CLIENT_BOOKING_PERIODS).default('FUTURE'),
    includeCancelled: z.enum(['true', 'false']).default('false'),
    ...pageQuery,
  })
  .strict();
const transactionsQuerySchema = z.object(pageQuery).strict();

function allowSupportRead(request: FastifyRequest, reply: FastifyReply): boolean {
  if (request.headers['x-app-platform'] !== 'cup-admin') {
    sendApiError(request, reply, 403, 'ADMIN_CLIENT_REQUIRED', 'Операция доступна только из ЦУП.');
    return false;
  }
  const claims = request.padlHubClaims;
  if (
    claims?.roles.includes('admin') &&
    (claims.permissions.includes('support.read') || claims.permissions.includes('support.manage'))
  ) {
    return true;
  }
  sendApiError(
    request,
    reply,
    403,
    'USER_VIVA_READ_PERMISSION_REQUIRED',
    'Нет права на просмотр данных пользователя в Viva.',
  );
  return false;
}

function mapSourceError(request: FastifyRequest, reply: FastifyReply, error: unknown) {
  if (error instanceof VivaClientAdminReadError) {
    if (error.code === 'CLIENT_ADMIN_READ_NOT_FOUND') {
      return sendApiError(
        request,
        reply,
        404,
        'USER_VIVA_CLIENT_NOT_FOUND',
        'Клиент Viva для пользователя не найден.',
      );
    }
    if (error.code === 'CLIENT_ADMIN_READ_OWNERSHIP_CONFLICT') {
      return sendApiError(
        request,
        reply,
        502,
        'USER_VIVA_OWNERSHIP_CONFLICT',
        'Viva вернула данные другого клиента.',
      );
    }
    if (error.code === 'CLIENT_ADMIN_READ_RESPONSE_INVALID') {
      return sendApiError(
        request,
        reply,
        502,
        'USER_VIVA_RESPONSE_INVALID',
        'Viva вернула неожиданный ответ.',
      );
    }
  }
  return sendApiError(
    request,
    reply,
    503,
    'USER_VIVA_UNAVAILABLE',
    'Данные Viva временно недоступны.',
  );
}

export function registerUserVivaAdminRoutes(
  app: FastifyInstance,
  options: {
    readonly source?: UserVivaAdminSource;
    readonly resolveVivaClientId?: (input: {
      readonly tenantId: string;
      readonly userId: string;
    }) => Promise<string | undefined>;
    readonly authenticatedTenantHandlers: readonly preHandlerHookHandler[];
  },
): void {
  const route = <Q extends z.ZodTypeAny>(
    section: UserVivaAdminSection,
    querySchema: Q,
    read: (
      source: UserVivaAdminSource,
      input: { readonly providerClientId: string; readonly correlationId: string },
      query: z.infer<Q>,
    ) => Promise<unknown>,
  ) => {
    app.get(
      `/admin/api/v1/:tenantKey/users/:userId/viva/${section}`,
      { preHandler: [...options.authenticatedTenantHandlers] },
      async (request, reply) => {
        reply.header('Cache-Control', 'no-store');
        if (!allowSupportRead(request, reply)) return;
        const tenantId = request.tenantId;
        const actorUserId = request.padlHubClaims?.sub;
        if (!tenantId || !actorUserId) {
          return sendApiError(request, reply, 401, 'AUTH_REQUIRED', 'Требуется авторизация.');
        }
        const params = paramsSchema.safeParse(request.params);
        const query = querySchema.safeParse(request.query ?? {});
        if (!params.success || !query.success) {
          return sendApiError(
            request,
            reply,
            400,
            'USER_VIVA_QUERY_INVALID',
            'Проверьте пользователя и параметры запроса.',
          );
        }
        if (!options.source || !options.resolveVivaClientId) {
          return sendApiError(
            request,
            reply,
            503,
            'USER_VIVA_SOURCE_DISABLED',
            'Чтение данных Viva не настроено.',
          );
        }
        const subjectUserId = params.data.userId;
        // Access audit: who read which section of whose Viva record. Never the payload.
        request.log.info(
          {
            audit: {
              event: 'admin.user_viva.read',
              actorUserId,
              tenantId,
              subjectUserId,
              section,
              correlationId: request.id,
            },
          },
          'admin user viva read',
        );
        let providerClientId: string | undefined;
        try {
          providerClientId = await options.resolveVivaClientId({ tenantId, userId: subjectUserId });
        } catch {
          return sendApiError(
            request,
            reply,
            503,
            'USER_VIVA_UNAVAILABLE',
            'Данные Viva временно недоступны.',
          );
        }
        if (!providerClientId) {
          return sendApiError(
            request,
            reply,
            404,
            'USER_VIVA_NOT_LINKED',
            'Пользователь не связан с клиентом Viva.',
          );
        }
        try {
          return await read(
            options.source,
            { providerClientId, correlationId: request.id },
            query.data,
          );
        } catch (error) {
          request.log.warn(
            {
              code: error instanceof VivaClientAdminReadError ? error.code : 'UNEXPECTED',
              section,
              correlationId: request.id,
            },
            'admin user viva read failed',
          );
          return mapSourceError(request, reply, error);
        }
      },
    );
  };

  route('profile', emptyQuerySchema, (source, input) => source.readProfile(input));
  route('summary', emptyQuerySchema, (source, input) => source.readSummary(input));
  route('subscriptions', subscriptionsQuerySchema, (source, input, query) =>
    source.listSubscriptions({ ...input, ...query }),
  );
  route('bookings', bookingsQuerySchema, (source, input, query) =>
    source.listBookings({
      ...input,
      period: query.period,
      includeCancelled: query.includeCancelled === 'true',
      page: query.page,
      size: query.size,
    }),
  );
  route('transactions', transactionsQuerySchema, (source, input, query) =>
    source.listTransactions({ ...input, ...query }),
  );
}
