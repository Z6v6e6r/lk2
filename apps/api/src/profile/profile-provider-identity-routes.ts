import { normalizeProviderViewerPhone } from '@phub/viva-adapter';
import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { z } from 'zod';

import { sendApiError } from '../http-errors.js';

const bodySchema = z.object({ phoneE164: z.string().min(4).max(32) }).strict();

export type ProviderPhoneLinkOutcome = 'linked' | 'unchanged' | 'conflict' | 'absent';

/**
 * Accepts the provider-asserted viewer phone from our own client. The provider only certifies the
 * browser transport for its end-user profile API, so the web client reads the profile itself and hands
 * the phone to this endpoint. The value is linked in integration custody: it never becomes a PadlHub
 * login key, never enters the auth-owned profile column and never serves as proof for payment,
 * participation or activity-history guards.
 */
export function registerProfileProviderIdentityRoutes(
  app: FastifyInstance,
  options: {
    readonly enabled: boolean;
    readonly repository?: {
      readonly linkProviderPhone: (input: {
        readonly tenantId: string;
        readonly userId: string;
        readonly phoneE164: string;
        readonly fetchedAt: string;
      }) => Promise<ProviderPhoneLinkOutcome>;
    };
    readonly commandHandlers: readonly preHandlerHookHandler[];
    readonly now?: () => Date;
  },
): void {
  app.post(
    '/user/api/v1/:tenantKey/profile/provider-phone',
    { preHandler: [...options.commandHandlers] },
    async (request, reply) => {
      reply.header('Cache-Control', 'private, no-store');
      const tenantId = request.tenantId;
      const userId = request.padlHubClaims?.sub;
      if (!tenantId || !userId) {
        return sendApiError(request, reply, 401, 'AUTH_REQUIRED', 'Требуется авторизация.');
      }
      if (!options.enabled) {
        return sendApiError(
          request,
          reply,
          503,
          'PROVIDER_IDENTITY_LINK_DISABLED',
          'Привязка провайдерского телефона ещё не включена.',
        );
      }
      if (!options.repository?.linkProviderPhone) {
        return sendApiError(
          request,
          reply,
          503,
          'PROVIDER_IDENTITY_LINK_UNAVAILABLE',
          'Привязка провайдерского телефона временно недоступна.',
        );
      }
      const parsed = bodySchema.safeParse(request.body);
      if (!parsed.success) {
        return sendApiError(request, reply, 400, 'INVALID_REQUEST', 'Некорректный номер телефона.');
      }
      const phoneE164 = normalizeProviderViewerPhone(parsed.data.phoneE164);
      if (!phoneE164) {
        return sendApiError(request, reply, 400, 'INVALID_REQUEST', 'Некорректный номер телефона.');
      }
      const outcome = await options.repository.linkProviderPhone({
        tenantId,
        userId,
        phoneE164,
        fetchedAt: (options.now?.() ?? new Date()).toISOString(),
      });
      return { outcome };
    },
  );
}
