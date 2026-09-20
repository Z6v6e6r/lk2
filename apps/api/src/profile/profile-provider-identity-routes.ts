import { normalizeProviderViewerPhone } from '@phub/viva-adapter';
import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { z } from 'zod';

import { sendApiError } from '../http-errors.js';
import type { LegacyViewerAssociationProofOutcome } from './legacy-viewer-association-proof.js';

const bodySchema = z.object({ phoneE164: z.string().min(4).max(32) }).strict();

export type ProviderPhoneLinkOutcome = 'linked' | 'unchanged' | 'conflict' | 'absent';

/**
 * Accepts the provider-asserted viewer phone from our own client. The provider only certifies the
 * browser transport for its end-user profile API, so the web client reads the profile itself and hands
 * the phone to this endpoint. The value is linked in integration custody: it never becomes a PadlHub
 * login key, never enters the auth-owned profile column and never authorizes payment, participation
 * state or another account's history. It identifies the viewer's own legacy scope only, because a
 * phone already linked to another active account is refused by the link itself.
 *
 * The link is also the moment this account can resolve which imported legacy player it belongs to, so
 * a friend request saved against that player row starts being deliverable. That resolution is
 * delivery-only and never becomes a durable identity binding; it is best-effort and never changes the
 * link outcome.
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
    readonly associationProof?: {
      readonly prove: (input: {
        readonly tenantKey: string | undefined;
        readonly tenantId: string;
        readonly userId: string;
        readonly phoneE164: string;
        readonly correlationId: string;
      }) => Promise<LegacyViewerAssociationProofOutcome>;
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
      if ((outcome === 'linked' || outcome === 'unchanged') && options.associationProof) {
        // A saved friend request for an imported player row is delivered to the account that proves
        // the phone, so resolve it here and answer the same either way.
        await options.associationProof
          .prove({
            tenantKey: (request.params as { readonly tenantKey?: string }).tenantKey,
            tenantId,
            userId,
            phoneE164,
            correlationId: request.id,
          })
          .catch(() => 'unavailable' as const);
      }
      return { outcome };
    },
  );
}
