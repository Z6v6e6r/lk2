import type { SubscriptionRuntimeActorContextRepository } from '@phub/database';
import {
  ManagedSubscriptionRuntimeQuoteClientError,
  type ManagedSubscriptionRuntimeQuoteClient,
  type ManagedSubscriptionRuntimeV1QuoteOutcome,
  type ManagedSubscriptionRuntimeV1QuoteRequest,
} from '@phub/subscription-runtime-adapter';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { sendApiError } from '../http-errors.js';
import {
  subscriptionRuntimeIdempotencyKeySha256,
  type SubscriptionRuntimeActorDelegationIssuer,
} from './subscription-runtime-actor-delegation-issuer.js';

const quoteRequestSchema = z.strictObject({
  action: z.enum(['CREATE_GAME', 'JOIN_GAME']),
  target: z.strictObject({
    kind: z.literal('GAME'),
    id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{2,199}$/),
    expectedRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  }),
  preferredSubscriptionInstanceId: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{2,199}$/)
    .optional(),
  paymentIntent: z.enum(['AUTO_BEST_PRICE', 'PAY_FULL_PRICE', 'USE_SUBSCRIPTION']),
});

type WarnMode = 'OFF' | 'WARN';
type RouteHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void> | void;

export interface SubscriptionRuntimeWarnRouteOptions {
  readonly mode: WarnMode;
  readonly actorContextRepository?: Pick<SubscriptionRuntimeActorContextRepository, 'resolve'>;
  readonly delegationIssuer?: Pick<SubscriptionRuntimeActorDelegationIssuer, 'issue'>;
  readonly quoteClient?: Pick<ManagedSubscriptionRuntimeQuoteClient, 'quote'>;
  readonly commandHandlers: readonly RouteHandler[];
}

function publicOutcome(quote: ManagedSubscriptionRuntimeV1QuoteOutcome) {
  return {
    outcome: quote.outcome,
    paymentIntent: quote.paymentIntent,
    serviceAllowed: quote.serviceAllowed,
    subscriptionBenefitAllowed: quote.subscriptionBenefitAllowed,
    blockers: quote.blockers,
    warnings: quote.warnings,
    expiresAt: quote.expiresAt,
  };
}

function sendBoundaryFailure(
  request: FastifyRequest,
  reply: FastifyReply,
  error: ManagedSubscriptionRuntimeQuoteClientError,
): void {
  if (error.status === 401) {
    sendApiError(
      request,
      reply,
      401,
      'SUBSCRIPTION_RUNTIME_DELEGATION_REJECTED',
      'Проверка серверной делегации отклонена.',
    );
    return;
  }
  if (error.status === 403) {
    sendApiError(
      request,
      reply,
      403,
      'SUBSCRIPTION_RUNTIME_DELEGATION_FORBIDDEN',
      'Серверная делегация не разрешена для этого контекста.',
    );
    return;
  }
  if (error.status === 409) {
    sendApiError(
      request,
      reply,
      409,
      'SUBSCRIPTION_RUNTIME_DELEGATION_CONFLICT',
      'Проверка делегации конфликтует с ранее обработанным запросом.',
    );
    return;
  }
  sendApiError(
    request,
    reply,
    503,
    'SUBSCRIPTION_RUNTIME_UNAVAILABLE',
    'Проверка подписки временно недоступна.',
  );
}

export function registerSubscriptionRuntimeWarnRoutes(
  app: FastifyInstance,
  options: SubscriptionRuntimeWarnRouteOptions,
): void {
  app.post(
    '/user/api/v1/:tenantKey/subscription-runtime/quote',
    { preHandler: [...options.commandHandlers] },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (
        options.mode !== 'WARN' ||
        !options.actorContextRepository ||
        !options.delegationIssuer ||
        !options.quoteClient
      ) {
        sendApiError(
          request,
          reply,
          503,
          'SUBSCRIPTION_RUNTIME_DISABLED',
          'Проверка подписки не включена.',
        );
        return;
      }

      const parsed = quoteRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        sendApiError(
          request,
          reply,
          400,
          'SUBSCRIPTION_RUNTIME_QUOTE_REQUEST_INVALID',
          'Некорректный запрос проверки подписки.',
        );
        return;
      }
      const claims = request.padlHubClaims;
      const tenantId = request.tenantId;
      const tenantKey = (request.params as { tenantKey?: string }).tenantKey;
      const idempotencyKey = request.headers['idempotency-key'];
      if (!claims || !tenantId || !tenantKey || typeof idempotencyKey !== 'string') {
        sendApiError(
          request,
          reply,
          401,
          'SUBSCRIPTION_RUNTIME_ACTOR_CONTEXT_INVALID',
          'Проверенный контекст пользователя недоступен.',
        );
        return;
      }

      try {
        const context = await options.actorContextRepository.resolve({
          tenantId,
          userId: claims.sub,
          sessionId: claims.sid,
        });
        if (context.outcome !== 'ok') {
          if (context.outcome === 'session_inactive') {
            sendApiError(
              request,
              reply,
              401,
              'SUBSCRIPTION_RUNTIME_SESSION_INACTIVE',
              'Сессия пользователя недействительна.',
            );
          } else {
            sendApiError(
              request,
              reply,
              503,
              'SUBSCRIPTION_RUNTIME_ACTOR_MAPPING_UNAVAILABLE',
              'Проверенный профиль подписки временно недоступен.',
            );
          }
          return;
        }

        const quoteRequest = {
          action: parsed.data.action,
          target: {
            kind: parsed.data.target.kind,
            id: parsed.data.target.id,
            ...(parsed.data.target.expectedRevision === undefined
              ? {}
              : { expectedRevision: parsed.data.target.expectedRevision }),
          },
          ...(parsed.data.preferredSubscriptionInstanceId === undefined
            ? {}
            : { preferredSubscriptionInstanceId: parsed.data.preferredSubscriptionInstanceId }),
          paymentIntent: parsed.data.paymentIntent,
        } satisfies ManagedSubscriptionRuntimeV1QuoteRequest;
        const actorDelegation = await options.delegationIssuer.issue({
          userId: claims.sub,
          tenantId,
          tenantKey,
          sessionId: claims.sid,
          providerClientId: context.providerClientId,
          providerMappingId: context.providerMappingId,
          action: parsed.data.action,
          correlationId: request.id,
          request: quoteRequest,
          idempotencyKey,
        });
        const quote = await options.quoteClient.quote(quoteRequest, {
          actorDelegation,
          correlationId: request.id,
          idempotencyKey,
        });

        reply.send({
          contractVersion: 1,
          mode: 'WARN',
          verdict: quote.outcome === 'ENTITLEMENT_APPLIED' ? 'accepted' : 'warning',
          nonBinding: true,
          requiresReservationRecheck: true,
          actor: { userId: claims.sub, tenantId, tenantKey },
          request: {
            correlationId: request.id,
            idempotencyKeyDigest: subscriptionRuntimeIdempotencyKeySha256(idempotencyKey),
          },
          delegation: {
            provider: 'VIVA',
            scope: 'subscription-runtime.quote',
            recipient: 'ph-admin',
            singleUse: true,
            verified: true,
          },
          advisory: publicOutcome(quote),
        });
      } catch (error) {
        if (error instanceof ManagedSubscriptionRuntimeQuoteClientError) {
          sendBoundaryFailure(request, reply, error);
          return;
        }
        sendApiError(
          request,
          reply,
          503,
          'SUBSCRIPTION_RUNTIME_UNAVAILABLE',
          'Проверка подписки временно недоступна.',
        );
      }
    },
  );
}
