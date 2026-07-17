import { createHash } from 'node:crypto';

import type { NotificationEndpointRepository, WebPushProviderSelector } from '@phub/database';
import {
  canonicalWebPushSubscription,
  webPushSubscriptionSchema,
  type NotificationEndpointCipher,
} from '@phub/notifications';
import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify';

import { sendApiError } from '../http-errors.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function principal(request: FastifyRequest): { tenantId: string; userId: string } | undefined {
  const notificationRequest = request as FastifyRequest & {
    readonly tenantId?: string;
    readonly padlHubClaims?: { readonly sub?: string };
  };
  const tenantId = notificationRequest.tenantId;
  const userId = notificationRequest.padlHubClaims?.sub;
  return tenantId && userId ? { tenantId, userId } : undefined;
}

function commandHash(command: 'REGISTER' | 'REVOKE', payload: string): string {
  return createHash('sha256').update(`${command}:${payload}`).digest('hex');
}

export function registerWebPushRoutes(
  app: FastifyInstance,
  options: {
    readonly repository?: NotificationEndpointRepository;
    readonly cipher?: NotificationEndpointCipher;
    readonly enabledGlobally: boolean;
    readonly publicKey?: string;
    readonly selector: WebPushProviderSelector;
    readonly authenticatedTenantHandlers: readonly preHandlerHookHandler[];
    readonly commandHandlers: readonly preHandlerHookHandler[];
  },
): void {
  app.get(
    '/user/api/v1/:tenantKey/notification-endpoints/web/config',
    { preHandler: [...options.authenticatedTenantHandlers] },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const current = principal(request);
      if (!current) {
        return sendApiError(request, reply, 401, 'AUTH_REQUIRED', 'Требуется авторизация.');
      }
      if (!options.repository) {
        return {
          enabled: false,
          reason: 'RUNTIME_UNAVAILABLE',
        };
      }
      const capabilities = await options.repository.getWebPushCapabilities(
        current.tenantId,
        options.selector,
      );
      const enabled =
        options.enabledGlobally &&
        Boolean(options.publicKey) &&
        Boolean(options.cipher) &&
        capabilities.tenantEnabled &&
        capabilities.providerConfigured;
      return {
        enabled,
        ...(enabled && options.publicKey ? { publicKey: options.publicKey } : {}),
        ...(!enabled
          ? {
              reason: !options.enabledGlobally
                ? 'GLOBAL_GATE_DISABLED'
                : !capabilities.tenantEnabled
                  ? 'TENANT_GATE_DISABLED'
                  : !capabilities.providerConfigured
                    ? 'PROVIDER_NOT_CONFIGURED'
                    : 'RUNTIME_UNAVAILABLE',
            }
          : {}),
      };
    },
  );

  app.post(
    '/user/api/v1/:tenantKey/notification-endpoints/web',
    { preHandler: [...options.commandHandlers] },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const current = principal(request);
      if (!current) {
        return sendApiError(request, reply, 401, 'AUTH_REQUIRED', 'Требуется авторизация.');
      }
      if (!options.repository || !options.cipher || !options.enabledGlobally) {
        return sendApiError(request, reply, 404, 'WEB_PUSH_DISABLED', 'Web Push не включён.');
      }
      const capabilities = await options.repository.getWebPushCapabilities(
        current.tenantId,
        options.selector,
      );
      if (!capabilities.tenantEnabled) {
        return sendApiError(request, reply, 404, 'WEB_PUSH_DISABLED', 'Web Push не включён.');
      }
      if (!capabilities.providerConfigured) {
        return sendApiError(
          request,
          reply,
          503,
          'WEB_PUSH_PROVIDER_UNAVAILABLE',
          'Провайдер Web Push не настроен.',
        );
      }

      const body = request.body as Record<string, unknown> | null;
      if (
        !body ||
        Array.isArray(body) ||
        Object.keys(body).some((key) => key !== 'installationId' && key !== 'subscription') ||
        Object.keys(body).length !== 2 ||
        typeof body.installationId !== 'string' ||
        !UUID_PATTERN.test(body.installationId)
      ) {
        return sendApiError(
          request,
          reply,
          400,
          'WEB_PUSH_SUBSCRIPTION_INVALID',
          'Некорректная подписка Web Push.',
        );
      }
      const subscription = webPushSubscriptionSchema.safeParse(body.subscription);
      if (!subscription.success) {
        return sendApiError(
          request,
          reply,
          400,
          'WEB_PUSH_SUBSCRIPTION_INVALID',
          'Некорректная подписка Web Push.',
        );
      }
      const idempotencyKey = request.headers['idempotency-key'];
      if (typeof idempotencyKey !== 'string') {
        return sendApiError(
          request,
          reply,
          400,
          'IDEMPOTENCY_KEY_REQUIRED',
          'Для этой операции требуется корректный Idempotency-Key.',
        );
      }

      const canonical = canonicalWebPushSubscription(subscription.data);
      const encrypted = options.cipher.encrypt(canonical);
      const result = await options.repository.registerWebPush({
        tenantId: current.tenantId,
        userId: current.userId,
        selector: options.selector,
        installationId: body.installationId,
        ciphertext: encrypted.ciphertext,
        addressHash: createHash('sha256').update(subscription.data.endpoint).digest('hex'),
        encryptionKeyId: encrypted.keyId,
        requestHash: commandHash('REGISTER', `${body.installationId}:${canonical}`),
        idempotencyKey,
        correlationId: request.id,
      });
      if (result.outcome === 'provider_unavailable') {
        return sendApiError(
          request,
          reply,
          503,
          'WEB_PUSH_PROVIDER_UNAVAILABLE',
          'Провайдер Web Push не настроен.',
        );
      }
      if (result.outcome === 'idempotency_conflict') {
        return sendApiError(
          request,
          reply,
          409,
          'IDEMPOTENCY_KEY_REUSED',
          'Idempotency-Key уже использован для другой команды.',
        );
      }
      if (result.outcome !== 'updated') {
        return sendApiError(request, reply, 500, 'INTERNAL_ERROR', 'Внутренняя ошибка сервиса.');
      }
      return result;
    },
  );

  app.delete(
    '/user/api/v1/:tenantKey/notification-endpoints/web/:installationId',
    { preHandler: [...options.commandHandlers] },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const current = principal(request);
      if (!current) {
        return sendApiError(request, reply, 401, 'AUTH_REQUIRED', 'Требуется авторизация.');
      }
      if (!options.repository) {
        return sendApiError(
          request,
          reply,
          503,
          'WEB_PUSH_RUNTIME_UNAVAILABLE',
          'Web Push временно недоступен.',
        );
      }
      const installationId = (request.params as { installationId?: string }).installationId;
      if (!installationId || !UUID_PATTERN.test(installationId)) {
        return sendApiError(
          request,
          reply,
          400,
          'WEB_PUSH_INSTALLATION_INVALID',
          'Некорректный идентификатор установки.',
        );
      }
      const idempotencyKey = request.headers['idempotency-key'];
      if (typeof idempotencyKey !== 'string') {
        return sendApiError(
          request,
          reply,
          400,
          'IDEMPOTENCY_KEY_REQUIRED',
          'Для этой операции требуется корректный Idempotency-Key.',
        );
      }

      const result = await options.repository.revokeWebPush({
        tenantId: current.tenantId,
        userId: current.userId,
        selector: options.selector,
        installationId,
        requestHash: commandHash('REVOKE', installationId),
        idempotencyKey,
        correlationId: request.id,
      });
      if (result.outcome === 'not_found') {
        return sendApiError(
          request,
          reply,
          404,
          'WEB_PUSH_ENDPOINT_NOT_FOUND',
          'Подписка Web Push не найдена.',
        );
      }
      if (result.outcome === 'idempotency_conflict') {
        return sendApiError(
          request,
          reply,
          409,
          'IDEMPOTENCY_KEY_REUSED',
          'Idempotency-Key уже использован для другой команды.',
        );
      }
      if (result.outcome !== 'updated') {
        return sendApiError(request, reply, 500, 'INTERNAL_ERROR', 'Внутренняя ошибка сервиса.');
      }
      return result;
    },
  );
}
