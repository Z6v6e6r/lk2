import { randomUUID } from 'node:crypto';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import {
  PROVIDER_ACCOUNT_TENANT_KEY,
  ProviderAccountOwnerError,
  type ProviderAccountAttestation,
  type ProviderAccountAttestationRequest,
} from '../../../../packages/subscription-runtime-adapter/src/provider-account-attestation.js';
import {
  ProviderAccountMappingConflict,
  type AttestedAccountInput,
  type AttestedAccountResult,
} from '../../../../packages/database/src/provider-account-mapping-repository.js';
import { sendApiError } from '../http-errors.js';

/**
 * ADR 0028 read surface: one fresh LK1 owner attestation per request, mapped to PadlHub UUIDs.
 * The response never contains Viva identifiers and is never merged with Home or cached fields.
 */
export interface JoinableSubscriptionsOptions {
  readonly client: {
    attest(
      request: ProviderAccountAttestationRequest,
      envelope: {
        readonly actorDelegation: string;
        readonly actorToken: { readonly token: string; readonly expiresAt: string };
        readonly correlationId: string;
      },
    ): Promise<ProviderAccountAttestation>;
  };
  readonly issuer: {
    issueProviderAccountAttestation(input: {
      readonly userId: string;
      readonly tenantId: string;
      readonly tenantKey: string;
      readonly sessionId: string;
      readonly correlationId: string;
      readonly request: ProviderAccountAttestationRequest;
      readonly actorToken: string;
      readonly actorTokenExpiresAt: string;
    }): Promise<string>;
  };
  readonly repository: {
    recordAttestation(input: AttestedAccountInput): Promise<AttestedAccountResult>;
  };
  /** Issues the actor's own short-lived Viva token for the same session as the delegation. */
  readonly issueActorToken: (actor: {
    readonly tenantKey: string;
    readonly tenantId: string;
    readonly userId: string;
    readonly sessionId: string;
    readonly correlationId: string;
  }) => Promise<{ readonly token: string; readonly expiresAt: string }>;
}

type ActorRequest = FastifyRequest & {
  tenantId?: string;
  padlHubClaims?: { readonly sub: string; readonly sid: string };
};

export function registerJoinableSubscriptionsRoutes(
  app: FastifyInstance,
  options: {
    readonly joinable?: JoinableSubscriptionsOptions;
    readonly authenticatedTenantHandlers: readonly ((
      request: ActorRequest,
      reply: FastifyReply,
    ) => Promise<void> | void)[];
  },
): void {
  app.get(
    '/user/api/v1/:tenantKey/subscriptions/joinable',
    {
      config: {
        rateLimit: {
          max: 6,
          timeWindow: 60_000,
          hook: 'preHandler',
          keyGenerator: (request: ActorRequest) =>
            `joinable-subscriptions:${request.tenantId ?? 'missing'}:${request.padlHubClaims?.sub ?? request.ip}`,
        },
      },
      preHandler: [...options.authenticatedTenantHandlers],
    },
    async (request, reply) => {
      const actorRequest = request as ActorRequest;
      reply.header('Cache-Control', 'private, no-store');
      const params = z.object({ tenantKey: z.string().min(1) }).safeParse(request.params);
      const claims = actorRequest.padlHubClaims;
      if (!params.success) {
        return sendApiError(request, reply, 400, 'INVALID_REQUEST', 'Некорректный запрос.');
      }
      if (!claims || !actorRequest.tenantId) {
        return sendApiError(request, reply, 401, 'AUTH_REQUIRED', 'Требуется авторизация.');
      }
      const joinable = options.joinable;
      if (!joinable) {
        return sendApiError(
          request,
          reply,
          503,
          'PROVIDER_ACCOUNT_UNAVAILABLE',
          'Абонементы временно недоступны.',
        );
      }
      const correlationId = request.id;
      try {
        const actorToken = await joinable.issueActorToken({
          tenantKey: params.data.tenantKey,
          tenantId: actorRequest.tenantId,
          userId: claims.sub,
          sessionId: claims.sid,
          correlationId,
        });
        const attestationRequest: ProviderAccountAttestationRequest = {
          contractVersion: 1,
          operationId: randomUUID(),
        };
        const actorDelegation = await joinable.issuer.issueProviderAccountAttestation({
          tenantId: actorRequest.tenantId,
          userId: claims.sub,
          sessionId: claims.sid,
          tenantKey: PROVIDER_ACCOUNT_TENANT_KEY,
          correlationId,
          request: attestationRequest,
          actorToken: actorToken.token,
          actorTokenExpiresAt: actorToken.expiresAt,
        });
        const attestation = await joinable.client.attest(attestationRequest, {
          actorDelegation,
          actorToken,
          correlationId,
        });
        const recorded = await joinable.repository.recordAttestation({
          tenantId: actorRequest.tenantId,
          userId: claims.sub,
          operationId: attestation.operationId,
          correlationId,
          providerClientId: attestation.providerClientId,
          attestedAt: attestation.attestedAt,
          subscriptions: attestation.subscriptions,
        });
        return {
          attestedAt: attestation.attestedAt,
          items: recorded.subscriptions.map((item) => ({
            id: item.subscriptionId,
            title: item.title,
            state: item.state,
            remainingUnits: item.remainingUnits,
            validUntil: item.validUntil,
          })),
        };
      } catch (error) {
        const code =
          error instanceof ProviderAccountMappingConflict
            ? 'PROVIDER_ACCOUNT_CONFLICT'
            : error instanceof ProviderAccountOwnerError
              ? error.code
              : 'PROVIDER_ACCOUNT_UNAVAILABLE';
        request.log.info({ code }, 'joinable subscriptions refused');
        const status =
          code === 'PROVIDER_ACCOUNT_CONFLICT'
            ? 409
            : code === 'PROVIDER_ACCOUNT_FORBIDDEN'
              ? 403
              : code === 'PROVIDER_ACCOUNT_INVALID'
                ? 502
                : 503;
        return sendApiError(
          request,
          reply,
          status,
          code,
          code === 'PROVIDER_ACCOUNT_CONFLICT'
            ? 'Учётная запись Viva уже привязана к другому пользователю. Обратитесь в поддержку.'
            : 'Абонементы временно недоступны.',
        );
      }
    },
  );
}
