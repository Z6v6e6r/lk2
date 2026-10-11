import { createHash } from 'node:crypto';

import type { AndroidPushProviderSelector, NotificationEndpointRepository } from '@phub/database';
import { androidFcmTokenSchema, type NotificationEndpointCipher } from '@phub/notifications';
import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify';

import { sendApiError } from '../http-errors.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function currentPrincipal(
  request: FastifyRequest,
): { tenantId: string; userId: string } | undefined {
  const scoped = request as FastifyRequest & {
    tenantId?: string;
    padlHubClaims?: { sub?: string };
  };
  return scoped.tenantId && scoped.padlHubClaims?.sub
    ? { tenantId: scoped.tenantId, userId: scoped.padlHubClaims.sub }
    : undefined;
}

function commandHash(
  command: 'REGISTER' | 'REVOKE',
  selector: AndroidPushProviderSelector,
  payload: string,
): string {
  return createHash('sha256')
    .update(`${command}:ANDROID:${selector.appId}:${selector.environment}:${payload}`)
    .digest('hex');
}

export function registerAndroidPushRoutes(
  app: FastifyInstance,
  options: {
    readonly repository?: NotificationEndpointRepository;
    readonly cipher?: NotificationEndpointCipher;
    readonly enabledGlobally: boolean;
    readonly maxEndpointsPerUser: number;
    readonly selector: AndroidPushProviderSelector;
    readonly authenticatedTenantHandlers: readonly preHandlerHookHandler[];
    readonly commandHandlers: readonly preHandlerHookHandler[];
  },
): void {
  app.get(
    '/user/api/v1/:tenantKey/notification-endpoints/android/config',
    { preHandler: [...options.authenticatedTenantHandlers] },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (!currentPrincipal(request))
        return sendApiError(request, reply, 401, 'AUTH_REQUIRED', 'Требуется авторизация.');
      const capabilities = options.repository?.getAndroidPushCapabilities
        ? await options.repository.getAndroidPushCapabilities(
            (currentPrincipal(request) as { tenantId: string }).tenantId,
            options.selector,
          )
        : undefined;
      const enabled = Boolean(
        options.enabledGlobally &&
        options.cipher &&
        capabilities?.tenantEnabled &&
        capabilities.providerConfigured,
      );
      return enabled
        ? { enabled: true }
        : {
            enabled: false,
            reason: !options.enabledGlobally
              ? 'GLOBAL_GATE_DISABLED'
              : !capabilities?.tenantEnabled
                ? 'TENANT_GATE_DISABLED'
                : !capabilities.providerConfigured
                  ? 'PROVIDER_NOT_CONFIGURED'
                  : 'RUNTIME_UNAVAILABLE',
          };
    },
  );
  app.post(
    '/user/api/v1/:tenantKey/notification-endpoints/android',
    { preHandler: [...options.commandHandlers] },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const principal = currentPrincipal(request);
      if (!principal)
        return sendApiError(request, reply, 401, 'AUTH_REQUIRED', 'Требуется авторизация.');
      if (!options.enabledGlobally || !options.repository?.registerAndroidPush || !options.cipher) {
        return sendApiError(
          request,
          reply,
          404,
          'ANDROID_PUSH_DISABLED',
          'Android Push не включён.',
        );
      }
      const capabilities = options.repository.getAndroidPushCapabilities
        ? await options.repository.getAndroidPushCapabilities(principal.tenantId, options.selector)
        : undefined;
      if (!capabilities?.tenantEnabled)
        return sendApiError(
          request,
          reply,
          404,
          'ANDROID_PUSH_DISABLED',
          'Android Push не включён.',
        );
      if (!capabilities.providerConfigured)
        return sendApiError(
          request,
          reply,
          503,
          'ANDROID_PUSH_PROVIDER_UNAVAILABLE',
          'Провайдер Android Push не настроен.',
        );
      const body = request.body as Record<string, unknown> | null;
      if (
        !body ||
        Array.isArray(body) ||
        Object.keys(body).length !== 2 ||
        typeof body.installationId !== 'string' ||
        !UUID_PATTERN.test(body.installationId)
      ) {
        return sendApiError(
          request,
          reply,
          400,
          'ANDROID_PUSH_TOKEN_INVALID',
          'Некорректный токен Android Push.',
        );
      }
      const installationId = body.installationId;
      const token = androidFcmTokenSchema.safeParse(body.token);
      if (!token.success)
        return sendApiError(
          request,
          reply,
          400,
          'ANDROID_PUSH_TOKEN_INVALID',
          'Некорректный токен Android Push.',
        );
      const idempotencyKey = request.headers['idempotency-key'];
      if (typeof idempotencyKey !== 'string')
        return sendApiError(
          request,
          reply,
          400,
          'IDEMPOTENCY_KEY_REQUIRED',
          'Для этой операции требуется корректный Idempotency-Key.',
        );
      const encrypted = options.cipher.encrypt(token.data);
      const result = await options.repository.registerAndroidPush({
        tenantId: principal.tenantId,
        userId: principal.userId,
        selector: options.selector,
        installationId,
        ciphertext: encrypted.ciphertext,
        addressHash: createHash('sha256').update(token.data).digest('hex'),
        encryptionKeyId: encrypted.keyId,
        endpointsPerUserMax: options.maxEndpointsPerUser,
        requestHash: commandHash('REGISTER', options.selector, `${installationId}:${token.data}`),
        idempotencyKey,
        correlationId: request.id,
      });
      if (result.outcome === 'idempotency_conflict')
        return sendApiError(
          request,
          reply,
          409,
          'IDEMPOTENCY_KEY_REUSED',
          'Idempotency-Key уже использован для другой команды.',
        );
      if (result.outcome === 'endpoint_limit_reached')
        return sendApiError(
          request,
          reply,
          409,
          'ANDROID_PUSH_ENDPOINT_LIMIT_REACHED',
          'Достигнут лимит Android-устройств.',
        );
      if (result.outcome !== 'updated')
        return sendApiError(request, reply, 500, 'INTERNAL_ERROR', 'Внутренняя ошибка сервиса.');
      return result;
    },
  );
  app.delete(
    '/user/api/v1/:tenantKey/notification-endpoints/android/:installationId',
    { preHandler: [...options.commandHandlers] },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const principal = currentPrincipal(request);
      const installationId = (request.params as { installationId?: string }).installationId;
      const idempotencyKey = request.headers['idempotency-key'];
      if (!principal)
        return sendApiError(request, reply, 401, 'AUTH_REQUIRED', 'Требуется авторизация.');
      if (
        !installationId ||
        !UUID_PATTERN.test(installationId) ||
        typeof idempotencyKey !== 'string'
      )
        return sendApiError(
          request,
          reply,
          400,
          'INVALID_REQUEST',
          'Некорректная команда Android Push.',
        );
      if (!options.repository?.revokeAndroidPush)
        return sendApiError(
          request,
          reply,
          503,
          'NOTIFICATIONS_UNAVAILABLE',
          'Уведомления временно недоступны.',
        );
      const result = await options.repository.revokeAndroidPush({
        tenantId: principal.tenantId,
        userId: principal.userId,
        selector: options.selector,
        installationId,
        requestHash: commandHash('REVOKE', options.selector, installationId),
        idempotencyKey,
        correlationId: request.id,
      });
      if (result.outcome === 'not_found')
        return { outcome: 'updated', installationId, status: 'REVOKED', replayed: false };
      if (result.outcome === 'idempotency_conflict')
        return sendApiError(
          request,
          reply,
          409,
          'IDEMPOTENCY_KEY_REUSED',
          'Idempotency-Key уже использован для другой команды.',
        );
      if (result.outcome !== 'updated')
        return sendApiError(request, reply, 500, 'INTERNAL_ERROR', 'Внутренняя ошибка сервиса.');
      return result;
    },
  );
}
