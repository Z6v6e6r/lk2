import type { ProfileContacts } from '@phub/api-sdk';
import type { ContactReader } from '@phub/database/contacts';
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import { z } from 'zod';

import type { AuthService } from '../auth/auth-service.js';
import { sendApiError } from '../http-errors.js';

const querySchema = z.object({}).strict();

function unavailable(request: FastifyRequest, reply: FastifyReply) {
  return sendApiError(
    request,
    reply,
    503,
    'PROFILE_CONTACTS_UNAVAILABLE',
    'Контакты временно недоступны.',
  );
}

export function registerProfileContactRoutes(
  app: FastifyInstance,
  options: {
    readonly reader?: ContactReader;
    readonly getUserContext?: AuthService['getUserContext'];
    readonly authenticatedTenantHandlers: readonly preHandlerHookHandler[];
  },
): void {
  app.get(
    '/user/api/v1/:tenantKey/profile/contacts',
    {
      preHandler: [...options.authenticatedTenantHandlers],
      // The shared limiter returns a stable code without a statusCode property.
      errorHandler: (error, request, reply) => {
        if (error.code === 'RATE_LIMIT_EXCEEDED') {
          sendApiError(
            request,
            reply,
            429,
            'RATE_LIMIT_EXCEEDED',
            'Слишком много запросов. Повторите позже.',
          );
          return;
        }
        app.errorHandler(error, request, reply);
      },
      onSend: (_request, reply, payload, done) => {
        reply.header('Cache-Control', 'private, no-store');
        done(null, payload);
      },
    },
    async (request, reply) => {
      const tenantId = request.tenantId;
      const userId = request.padlHubClaims?.sub;
      if (!tenantId || !userId) {
        return sendApiError(request, reply, 401, 'AUTH_REQUIRED', 'Требуется авторизация.');
      }
      if (!request.padlHubClaims?.permissions.includes('profile.read')) {
        return sendApiError(
          request,
          reply,
          403,
          'PROFILE_CONTACTS_PERMISSION_REQUIRED',
          'Нет доступа к контактам.',
        );
      }
      if (!querySchema.safeParse(request.query).success) {
        return sendApiError(
          request,
          reply,
          400,
          'PROFILE_CONTACTS_QUERY_INVALID',
          'Параметры чтения контактов не поддерживаются.',
        );
      }
      if (!options.reader || !options.getUserContext) return unavailable(request, reply);
      try {
        const user = await options.getUserContext(tenantId, userId);
        if (!user || user.id !== userId || user.tenantId !== tenantId) {
          return sendApiError(request, reply, 401, 'AUTH_SESSION_REVOKED', 'Сессия завершена.');
        }
        const contacts = await options.reader.listForUser(tenantId, userId);
        // Fail closed if an injected implementation violates the self-only reader contract.
        if (contacts.some((contact) => contact.userId !== userId))
          return unavailable(request, reply);
        const result: ProfileContacts = {
          contacts: contacts.map((contact) => ({
            id: contact.id,
            type: contact.type,
            normalizedValue: contact.normalizedValue,
            provenance: {
              sourceKind: contact.sourceKind,
              sourceUpdatedAt: contact.sourceUpdatedAt?.toISOString() ?? null,
            },
          })),
        };
        return result;
      } catch {
        request.log.warn({ correlationId: request.id }, 'profile contacts read failed');
        return unavailable(request, reply);
      }
    },
  );
}
