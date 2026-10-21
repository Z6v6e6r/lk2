import type { LevelEligibilityPolicyRepository } from '@phub/database';
import type {
  SubscriptionPolicyRegistryClient,
  SubscriptionPolicyRegistryResult,
} from '@phub/subscription-runtime-adapter';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import { z } from 'zod';

import { sendApiError } from '../http-errors.js';

const sportCodeSchema = z
  .string()
  .regex(/^[A-Z][A-Z0-9_]{1,31}$/)
  .default('PADEL');
const correlationIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;

export interface RulesRegistryAdminRouteOptions {
  readonly levelEligibilityRepository?: Pick<LevelEligibilityPolicyRepository, 'getState'>;
  readonly subscriptionPolicyRegistryClient?: Pick<SubscriptionPolicyRegistryClient, 'read'>;
  readonly authenticatedTenantHandlers: readonly preHandlerHookHandler[];
}

interface RegistryLevelSource {
  readonly source: 'LK2_LEVEL';
  readonly status: 'OK';
  readonly sportCode: string;
  readonly state: Awaited<ReturnType<LevelEligibilityPolicyRepository['getState']>>;
}

interface RegistrySubscriptionSource {
  readonly source: 'CUP_PUBLISHED';
  readonly status: 'OK' | 'UNAVAILABLE';
  readonly reason?: string;
  readonly registry?: SubscriptionPolicyRegistryResult;
}

interface RegistryLevelUnavailable {
  readonly source: 'LK2_LEVEL';
  readonly status: 'UNAVAILABLE';
  readonly reason: string;
}

export interface RulesRegistryAdminResponse {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly level: RegistryLevelSource | RegistryLevelUnavailable;
  readonly subscriptions: RegistrySubscriptionSource;
}

function principal(request: FastifyRequest): { tenantId: string; actorUserId: string } | undefined {
  const tenantId = request.tenantId;
  const actorUserId = request.padlHubClaims?.sub;
  return tenantId && actorUserId ? { tenantId, actorUserId } : undefined;
}

/**
 * Read-only operator registry. Reuses the strongest existing CUP permission
 * (`eligibility.publish`) so the view can never widen an existing read grant; a dedicated
 * `subscriptions.rules.read` permission is a separate approved auth change.
 */
function requireRegistryRead(request: FastifyRequest, reply: FastifyReply): boolean {
  if (request.headers['x-app-platform'] !== 'cup-admin') {
    sendApiError(request, reply, 403, 'ADMIN_CLIENT_REQUIRED', 'Операция доступна только из ЦУП.');
    return false;
  }
  const roles = request.padlHubClaims?.roles ?? [];
  const permissions = request.padlHubClaims?.permissions ?? [];
  if (roles.includes('admin') && permissions.includes('eligibility.publish')) return true;
  sendApiError(request, reply, 403, 'ADMIN_FORBIDDEN', 'Недостаточно прав для реестра правил.');
  return false;
}

function correlationId(request: FastifyRequest): string {
  const header = request.headers['x-correlation-id'];
  if (typeof header === 'string' && correlationIdPattern.test(header)) return header;
  return randomUUID();
}

export function registerRulesRegistryAdminRoutes(
  app: FastifyInstance,
  options: RulesRegistryAdminRouteOptions,
): void {
  app.get(
    '/admin/api/v1/:tenantKey/rules-registry',
    { preHandler: [...options.authenticatedTenantHandlers] },
    async (request, reply): Promise<RulesRegistryAdminResponse | undefined> => {
      reply.header('Cache-Control', 'no-store');
      if (!requireRegistryRead(request, reply)) return undefined;
      const current = principal(request);
      if (!current) {
        sendApiError(request, reply, 401, 'AUTH_REQUIRED', 'Требуется авторизация.');
        return undefined;
      }
      const parsedSport = sportCodeSchema.safeParse(
        (request.query as { readonly sportCode?: string }).sportCode,
      );
      if (!parsedSport.success) {
        sendApiError(request, reply, 400, 'SPORT_CODE_INVALID', 'Некорректный вид спорта.');
        return undefined;
      }
      const sportCode = parsedSport.data;
      let level: RegistryLevelSource | RegistryLevelUnavailable;
      if (!options.levelEligibilityRepository) {
        level = {
          source: 'LK2_LEVEL',
          status: 'UNAVAILABLE',
          reason: 'LEVEL_ELIGIBILITY_REPOSITORY_NOT_CONFIGURED',
        };
      } else {
        level = {
          source: 'LK2_LEVEL',
          status: 'OK',
          sportCode,
          state: await options.levelEligibilityRepository.getState(current.tenantId, sportCode),
        };
      }
      let subscriptions: RegistrySubscriptionSource;
      if (!options.subscriptionPolicyRegistryClient) {
        subscriptions = {
          source: 'CUP_PUBLISHED',
          status: 'UNAVAILABLE',
          reason: 'SUBSCRIPTION_POLICY_REGISTRY_NOT_CONFIGURED',
        };
      } else {
        try {
          subscriptions = {
            source: 'CUP_PUBLISHED',
            status: 'OK',
            registry: await options.subscriptionPolicyRegistryClient.read(correlationId(request)),
          };
        } catch {
          subscriptions = {
            source: 'CUP_PUBLISHED',
            status: 'UNAVAILABLE',
            reason: 'SUBSCRIPTION_POLICY_REGISTRY_UNAVAILABLE',
          };
        }
      }
      return {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        level,
        subscriptions,
      };
    },
  );
}
