import { createHmac } from 'node:crypto';

import { normalizePhoneE164 } from '@phub/auth';
import type { AppConfig } from '@phub/config';
import { isValidIdempotencyKey } from '@phub/domain';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { sendApiError } from '../http-errors.js';
import { AuthServiceError, type AuthService, type AuthSessionResult } from './auth-service.js';

export const REFRESH_COOKIE_NAME = 'phub_refresh';

const challengeBodySchema = z.object({
  method: z.literal('phone_otp'),
  phone: z.string().min(5).max(32),
});
const verifyBodySchema = z.object({ code: z.string().regex(/^\d{4}$/) });
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
    AUTH_SESSION_REVOKED: 'Сессия завершена. Войдите снова.',
    AUTH_REFRESH_RACE: 'Сессия обновляется в другой вкладке. Повторите запрос.',
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
      roles: ['client'],
      permissions: ['profile.read'],
    },
  };
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
): void {
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
        );
        setRefreshCookie(reply, config, tenantKey, session);
        preventCredentialCaching(reply);
        return reply.send(publicSession(session));
      } catch (error) {
        if (!(error instanceof AuthServiceError) || error.code !== 'AUTH_REFRESH_RACE') {
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
        if (token) await authService.revokeSession(tenantKey, token, request.id);
        clearRefreshCookie(reply, config, tenantKey);
        return reply.status(204).send();
      } catch (error) {
        return handleAuthError(error, request, reply);
      }
    },
  );
}
