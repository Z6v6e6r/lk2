import { createHmac } from 'node:crypto';

import { normalizePhoneE164 } from '@phub/auth';
import type { AppConfig } from '@phub/config';
import { isValidIdempotencyKey, type ClientPlatform } from '@phub/domain';
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import { z } from 'zod';

import { sendApiError } from '../http-errors.js';
import { AuthServiceError, type AuthService, type AuthSessionResult } from './auth-service.js';

export const REFRESH_COOKIE_NAME = 'phub_refresh';

const challengeBodySchema = z.object({
  method: z.literal('phone_otp'),
  phone: z.string().min(5).max(32),
});
const verifyBodySchema = z.object({
  code: z.string().regex(/^\d{4}$/),
  acceptance: z
    .object({
      publicOfferAccepted: z.literal(true),
      personalDataPolicyAccepted: z.literal(true),
    })
    .optional(),
});
const vivaOAuthStartBodySchema = z.object({
  provider: z.enum(['vkid', 'yandex']),
  acceptance: z.object({
    publicOfferAccepted: z.literal(true),
    personalDataPolicyAccepted: z.literal(true),
  }),
});
const vivaOAuthCallbackQuerySchema = z.object({
  state: z.string().min(20).max(512),
  code: z.string().min(1).max(4096),
});
const vivaAccessBodySchema = z.object({ handoffCode: z.string().min(20).max(256).optional() });
const paramsSchema = z.object({
  tenantKey: z.string(),
});
const verifyParamsSchema = paramsSchema.extend({ challengeId: z.string().uuid() });

function protectedRateKey(
  request: FastifyRequest,
  config: AppConfig,
  operation: 'challenge' | 'verify',
): string {
  const params = request.params as { tenantKey?: string; challengeId?: string };
  const body = request.body as { phone?: unknown } | undefined;
  const discriminator =
    operation === 'challenge'
      ? (normalizePhoneE164(typeof body?.phone === 'string' ? body.phone : '') ?? 'invalid-phone')
      : (params.challengeId ?? 'invalid-challenge');
  const digest = createHmac('sha256', config.JWT_REFRESH_SECRET)
    .update(discriminator)
    .digest('base64url');
  return `auth:${operation}:${params.tenantKey ?? 'invalid-tenant'}:${digest}:${request.ip}`;
}

function isAllowedBrowserOrigin(request: FastifyRequest, config: AppConfig): boolean {
  const origin = request.headers.origin;
  if (!origin) return true;
  return config.CORS_ORIGINS.split(',')
    .map((value) => value.trim())
    .includes(origin);
}

function errorMessage(code: string): string {
  const messages: Readonly<Record<string, string>> = {
    AUTH_PHONE_INVALID: 'Введите корректный номер телефона.',
    AUTH_CODE_INVALID: 'Код не подошёл. Проверьте его и попробуйте ещё раз.',
    AUTH_CODE_EXPIRED: 'Код истёк. Запросите новый код.',
    AUTH_CHALLENGE_IN_PROGRESS: 'Код уже проверяется. Подождите и повторите.',
    AUTH_RATE_LIMITED: 'Слишком много попыток. Повторите позже.',
    AUTH_PROVIDER_UNAVAILABLE: 'Вход временно недоступен. Повторите позже.',
    AUTH_ADMIN_ACCESS_DENIED: 'Для этой учётной записи доступ в ЦУП не выдан.',
    AUTH_SESSION_REVOKED: 'Сессия завершена. Войдите снова.',
    AUTH_REFRESH_RACE: 'Сессия обновляется в другой вкладке. Повторите запрос.',
    VIVA_REAUTH_REQUIRED: 'Сессия Viva завершена. Войдите через Viva снова.',
    VIVA_DELEGATION_BUSY: 'Сессия Viva обновляется в другой вкладке. Повторите запрос.',
    LEGAL_ACCEPTANCE_REQUIRED: 'Подтвердите публичную оферту и обработку персональных данных.',
    AUTH_IDENTITY_CONFLICT:
      'Профиль уже связан с другим аккаунтом ПаделХАБ. Обратитесь в поддержку.',
    IDEMPOTENCY_KEY_CONFLICT: 'Этот ключ операции уже использован с другими данными.',
    TENANT_KEY_INVALID: 'Некорректный идентификатор организации.',
    TENANT_NOT_FOUND: 'Организация не найдена.',
  };
  return messages[code] ?? 'Не удалось выполнить вход.';
}

function requireAuthIdempotency(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const key = request.headers['idempotency-key'];
  if (typeof key !== 'string' || !isValidIdempotencyKey(key)) {
    sendApiError(
      request,
      reply,
      400,
      'IDEMPOTENCY_KEY_REQUIRED',
      'Для операции требуется корректный Idempotency-Key.',
    );
  }
  return Promise.resolve();
}

function idempotencyKey(request: FastifyRequest): string {
  return request.headers['idempotency-key'] as string;
}

function handleAuthError(
  error: unknown,
  request: FastifyRequest,
  reply: FastifyReply,
): FastifyReply {
  if (error instanceof AuthServiceError) {
    return sendApiError(request, reply, error.status, error.code, errorMessage(error.code));
  }
  if (error instanceof z.ZodError) {
    return sendApiError(request, reply, 400, 'INVALID_REQUEST', 'Проверьте данные запроса.');
  }
  throw error;
}

function publicSession(result: AuthSessionResult) {
  return {
    accessToken: result.accessToken,
    tokenType: result.tokenType,
    expiresAt: result.expiresAt,
    user: { id: result.user.id, displayName: result.user.displayName },
    context: {
      tenantId: result.user.tenantId,
      userId: result.user.id,
      displayName: result.user.displayName,
      ...(result.user.phoneLast4 ? { phoneLast4: result.user.phoneLast4 } : {}),
      roles: result.roles,
      permissions: result.permissions,
    },
  };
}

function accessAudience(request: FastifyRequest): 'client' | 'admin' {
  return request.headers['x-app-platform'] === 'cup-admin' ? 'admin' : 'client';
}

function preventCredentialCaching(reply: FastifyReply): void {
  reply.header('Cache-Control', 'no-store');
  reply.header('Pragma', 'no-cache');
}

function setRefreshCookie(
  reply: FastifyReply,
  config: AppConfig,
  tenantKey: string,
  result: AuthSessionResult,
): void {
  reply.setCookie(REFRESH_COOKIE_NAME, result.refreshToken, {
    httpOnly: true,
    secure: config.AUTH_COOKIE_SECURE,
    sameSite: 'lax',
    path: `/user/api/v1/${tenantKey}/auth`,
    maxAge: config.AUTH_REFRESH_TTL_SECONDS,
  });
}

function clearRefreshCookie(reply: FastifyReply, config: AppConfig, tenantKey: string): void {
  reply.clearCookie(REFRESH_COOKIE_NAME, {
    httpOnly: true,
    secure: config.AUTH_COOKIE_SECURE,
    sameSite: 'lax',
    path: `/user/api/v1/${tenantKey}/auth`,
  });
}

export function registerAuthRoutes(
  app: FastifyInstance,
  authService: AuthService,
  config: AppConfig,
  authenticatedPreHandlers: readonly preHandlerHookHandler[] = [],
  directVivaAccessAllowed?: (
    tenantId: string,
    userId: string,
    platform: ClientPlatform,
  ) => Promise<boolean>,
): void {
  app.post(
    '/user/api/v1/:tenantKey/auth/viva/authorize',
    { preHandler: requireAuthIdempotency },
    async (request, reply) => {
      try {
        const { tenantKey } = paramsSchema.parse(request.params);
        const body = vivaOAuthStartBodySchema.parse(request.body);
        const result = await authService.startVivaOAuth({
          tenantKey,
          provider: body.provider,
          publicOfferAccepted: body.acceptance.publicOfferAccepted,
          personalDataPolicyAccepted: body.acceptance.personalDataPolicyAccepted,
          correlationId: request.id,
        });
        return reply.status(200).send(result);
      } catch (error) {
        return handleAuthError(error, request, reply);
      }
    },
  );

  app.get('/user/api/v1/:tenantKey/auth/viva/callback', async (request, reply) => {
    try {
      const { tenantKey } = paramsSchema.parse(request.params);
      const query = vivaOAuthCallbackQuerySchema.parse(request.query);
      const session = await authService.completeVivaOAuth({
        tenantKey,
        state: query.state,
        code: query.code,
        correlationId: request.id,
        idempotencyKey: query.state,
      });
      setRefreshCookie(reply, config, tenantKey, session);
      preventCredentialCaching(reply);
      const redirectUrl = config.VIVA_OAUTH_SUCCESS_REDIRECT_URL;
      if (!redirectUrl) throw new AuthServiceError('AUTH_PROVIDER_UNAVAILABLE');
      const target = new URL(redirectUrl);
      const fragment = new URLSearchParams(target.hash.replace(/^#/, ''));
      fragment.set('viva_handoff', session.vivaHandoffCode);
      target.hash = fragment.toString();
      return reply.redirect(target.toString());
    } catch (error) {
      return handleAuthError(error, request, reply);
    }
  });

  app.post(
    '/user/api/v1/:tenantKey/auth/viva/access',
    { preHandler: [...authenticatedPreHandlers, requireAuthIdempotency] },
    async (request, reply) => {
      try {
        const body = vivaAccessBodySchema.parse(request.body ?? {});
        const tenantId = request.tenantId;
        const userId = request.padlHubClaims?.sub;
        if (!tenantId || !userId) {
          return sendApiError(request, reply, 401, 'AUTH_REQUIRED', 'Требуется авторизация.');
        }
        const platformHeader = request.headers['x-app-platform'];
        const platform: ClientPlatform =
          platformHeader === 'web' ||
          platformHeader === 'ios' ||
          platformHeader === 'android' ||
          platformHeader === 'cup-admin'
            ? platformHeader
            : 'internal';
        if (
          !directVivaAccessAllowed ||
          !(await directVivaAccessAllowed(tenantId, userId, platform))
        ) {
          return sendApiError(
            request,
            reply,
            403,
            'DIRECT_VIVA_DISABLED',
            'Прямое подключение к Viva отключено сервером.',
          );
        }
        const access = await authService.issueVivaAccessToken({
          tenantId,
          userId,
          ...(body.handoffCode ? { handoffCode: body.handoffCode } : {}),
          correlationId: request.id,
        });
        preventCredentialCaching(reply);
        return reply.send(access);
      } catch (error) {
        return handleAuthError(error, request, reply);
      }
    },
  );

  app.post(
    '/user/api/v1/:tenantKey/auth/challenges',
    {
      config: {
        rateLimit: {
          max: 5,
          timeWindow: '1 minute',
          groupId: 'auth-challenge',
          keyGenerator: (request) => protectedRateKey(request, config, 'challenge'),
        },
      },
      preHandler: requireAuthIdempotency,
    },
    async (request, reply) => {
      try {
        const { tenantKey } = paramsSchema.parse(request.params);
        const body = challengeBodySchema.parse(request.body);
        const challenge = await authService.startPhoneChallenge({
          tenantKey,
          phone: body.phone,
          correlationId: request.id,
          idempotencyKey: idempotencyKey(request),
          accessAudience: accessAudience(request),
        });
        return reply.status(202).send(challenge);
      } catch (error) {
        return handleAuthError(error, request, reply);
      }
    },
  );

  app.post(
    '/user/api/v1/:tenantKey/auth/challenges/:challengeId/verify',
    {
      config: {
        rateLimit: {
          max: 10,
          timeWindow: '1 minute',
          groupId: 'auth-verify',
          keyGenerator: (request) => protectedRateKey(request, config, 'verify'),
        },
      },
      preHandler: requireAuthIdempotency,
    },
    async (request, reply) => {
      try {
        const { tenantKey, challengeId } = verifyParamsSchema.parse(request.params);
        const body = verifyBodySchema.parse(request.body);
        const session = await authService.verifyPhoneChallenge({
          tenantKey,
          challengeId,
          code: body.code,
          correlationId: request.id,
          idempotencyKey: idempotencyKey(request),
          accessAudience: accessAudience(request),
          ...(body.acceptance ? { acceptance: body.acceptance } : {}),
        });
        setRefreshCookie(reply, config, tenantKey, session);
        preventCredentialCaching(reply);
        return reply.send(publicSession(session));
      } catch (error) {
        return handleAuthError(error, request, reply);
      }
    },
  );

  app.post(
    '/user/api/v1/:tenantKey/auth/session/refresh',
    { preHandler: requireAuthIdempotency },
    async (request, reply) => {
      try {
        const { tenantKey } = paramsSchema.parse(request.params);
        if (!isAllowedBrowserOrigin(request, config)) {
          return sendApiError(
            request,
            reply,
            403,
            'ORIGIN_NOT_ALLOWED',
            'Источник запроса запрещён.',
          );
        }
        if (request.headers['x-session-intent'] !== 'refresh') {
          return sendApiError(
            request,
            reply,
            400,
            'SESSION_INTENT_REQUIRED',
            'Некорректный запрос.',
          );
        }
        const token = request.cookies[REFRESH_COOKIE_NAME];
        if (!token) throw new AuthServiceError('AUTH_SESSION_REVOKED');
        const session = await authService.refreshSession(
          tenantKey,
          token,
          request.id,
          idempotencyKey(request),
          accessAudience(request),
        );
        setRefreshCookie(reply, config, tenantKey, session);
        preventCredentialCaching(reply);
        return reply.send(publicSession(session));
      } catch (error) {
        if (
          !(error instanceof AuthServiceError) ||
          (error.code !== 'AUTH_REFRESH_RACE' && error.code !== 'AUTH_ADMIN_ACCESS_DENIED')
        ) {
          clearRefreshCookie(
            reply,
            config,
            String((request.params as { tenantKey?: string }).tenantKey),
          );
        }
        return handleAuthError(error, request, reply);
      }
    },
  );

  app.delete(
    '/user/api/v1/:tenantKey/auth/session',
    { preHandler: requireAuthIdempotency },
    async (request, reply) => {
      try {
        const { tenantKey } = paramsSchema.parse(request.params);
        if (!isAllowedBrowserOrigin(request, config)) {
          return sendApiError(
            request,
            reply,
            403,
            'ORIGIN_NOT_ALLOWED',
            'Источник запроса запрещён.',
          );
        }
        if (request.headers['x-session-intent'] !== 'logout') {
          return sendApiError(
            request,
            reply,
            400,
            'SESSION_INTENT_REQUIRED',
            'Некорректный запрос.',
          );
        }
        const token = request.cookies[REFRESH_COOKIE_NAME];
        if (token) {
          await authService.revokeSession(
            tenantKey,
            token,
            request.id,
            request.headers['x-app-platform'] !== 'cup-admin',
          );
        }
        clearRefreshCookie(reply, config, tenantKey);
        return reply.status(204).send();
      } catch (error) {
        return handleAuthError(error, request, reply);
      }
    },
  );
}
