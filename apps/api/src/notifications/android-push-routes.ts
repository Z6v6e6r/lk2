import { createHash } from 'node:crypto';

import type { AndroidPushProviderSelector, NotificationEndpointRepository } from '@phub/database';
import { z } from 'zod';
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
    .update(`${command}:${selector.platform}:${selector.appId}:${selector.environment}:${payload}`)
    .digest('hex');
}

export function registerNativePushRoutes(
  app: FastifyInstance,
  options: {
    readonly platform?: 'IOS' | 'ANDROID';
    readonly repository?: NotificationEndpointRepository;
    readonly cipher?: NotificationEndpointCipher;
    readonly enabledGlobally: boolean;
    readonly maxEndpointsPerUser: number;
    readonly selector: AndroidPushProviderSelector;
    readonly authenticatedTenantHandlers: readonly preHandlerHookHandler[];
    readonly commandHandlers: readonly preHandlerHookHandler[];
  },
): void {
  const ios = options.platform === 'IOS';
  if (
    options.selector.platform !== (ios ? 'IOS' : 'ANDROID') ||
    options.selector.provider !== (ios ? 'APNS' : 'FCM') ||
    (ios && !options.selector.credentialRef)
  )
    throw new Error('NATIVE_PUSH_SELECTOR_INVALID');
  const root = '/user/api/v1/:tenantKey/notification-endpoints/' + (ios ? 'ios' : 'android');
  const prefix = ios ? 'IOS_PUSH' : 'ANDROID_PUSH';
  const registerEndpoint = ios
    ? options.repository?.registerWebPush.bind(options.repository)
    : options.repository?.registerAndroidPush?.bind(options.repository);
  const revokeEndpoint = ios
    ? options.repository?.revokeWebPush.bind(options.repository)
    : options.repository?.revokeAndroidPush?.bind(options.repository);
  const getCapabilities = ios
    ? options.repository?.getIosPushCapabilities?.bind(options.repository)
    : options.repository?.getAndroidPushCapabilities?.bind(options.repository);
  const tokenSchema = ios
    ? z
        .string()
        .regex(/^[a-f0-9]{32,1024}$/i)
        .refine((value) => value.length % 2 === 0)
        .transform((value) => value.toLowerCase())
    : androidFcmTokenSchema;
  app.get(
    root + '/config',
    { preHandler: [...options.authenticatedTenantHandlers] },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (!currentPrincipal(request))
        return sendApiError(request, reply, 401, 'AUTH_REQUIRED', 'Требуется авторизация.');
      const capabilities = getCapabilities
        ? await getCapabilities(
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
  app.post(root, { preHandler: [...options.commandHandlers] }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const principal = currentPrincipal(request);
    if (!principal)
      return sendApiError(request, reply, 401, 'AUTH_REQUIRED', 'Требуется авторизация.');
    if (!options.enabledGlobally || !registerEndpoint || !options.cipher) {
      return sendApiError(request, reply, 404, prefix + '_DISABLED', 'Push не включён.');
    }
    const capabilities = getCapabilities
      ? await getCapabilities(principal.tenantId, options.selector)
      : undefined;
    if (!capabilities?.tenantEnabled)
      return sendApiError(request, reply, 404, prefix + '_DISABLED', 'Push не включён.');
    if (!capabilities.providerConfigured)
      return sendApiError(
        request,
        reply,
        503,
        prefix + '_PROVIDER_UNAVAILABLE',
        'Провайдер Push не настроен.',
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
        prefix + '_TOKEN_INVALID',
        'Некорректный токен Push.',
      );
    }
    const installationId = body.installationId;
    const token = tokenSchema.safeParse(body.token);
    if (!token.success)
      return sendApiError(
        request,
        reply,
        400,
        prefix + '_TOKEN_INVALID',
        'Некорректный токен Push.',
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
    const result = await registerEndpoint({
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
        prefix + '_ENDPOINT_LIMIT_REACHED',
        'Достигнут лимит устройств.',
      );
    if (result.outcome !== 'updated')
      return sendApiError(request, reply, 500, 'INTERNAL_ERROR', 'Внутренняя ошибка сервиса.');
    return result;
  });
  app.delete(
    root + '/:installationId',
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
        return sendApiError(request, reply, 400, 'INVALID_REQUEST', 'Некорректная команда Push.');
      if (!revokeEndpoint)
        return sendApiError(
          request,
          reply,
          503,
          'NOTIFICATIONS_UNAVAILABLE',
          'Уведомления временно недоступны.',
        );
      const result = await revokeEndpoint({
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

export const registerAndroidPushRoutes = registerNativePushRoutes;
