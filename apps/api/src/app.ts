import { createHash, randomUUID } from 'node:crypto';

import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import type { AppConfig } from '@phub/config';
import { checkDatabaseReady } from '@phub/database';
import { isValidIdempotencyKey } from '@phub/domain';
import type { Logger } from 'pino';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type Redis from 'ioredis';
import { jwtVerify, type JWTPayload } from 'jose';
import type { Pool } from 'pg';

import { registerAuthRoutes } from './auth/auth-routes.js';
import type { AuthService } from './auth/auth-service.js';
import { sendApiError } from './http-errors.js';

interface PadlHubClaims extends JWTPayload {
  readonly sub: string;
  readonly tenants: readonly string[];
  readonly roles: readonly string[];
  readonly permissions: readonly string[];
  readonly sid: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CORRELATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const TENANT_KEY_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}$/;

declare module 'fastify' {
  interface FastifyRequest {
    padlHubClaims?: PadlHubClaims;
    tenantId?: string;
  }
}

export interface BuildAppOptions {
  readonly config: AppConfig;
  readonly logger: Logger;
  readonly pool?: Pool;
  readonly authService?: AuthService;
  readonly authDependencyReady?: () => Promise<boolean>;
  readonly rateLimitRedis?: Redis;
}

function parseAllowedOrigins(value: string): ReadonlySet<string> {
  return new Set(
    value
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
  );
}

function parseTrustedProxies(value: string): readonly string[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function safeCorrelationId(header: string | readonly string[] | undefined): string {
  return typeof header === 'string' && CORRELATION_ID_PATTERN.test(header) ? header : randomUUID();
}

function correlationIdFromHeader(request: FastifyRequest): string {
  return request.id;
}

function rateLimitKey(request: FastifyRequest): string {
  const authorization = request.headers.authorization;
  if (!authorization) return `anonymous:${request.ip}`;
  const principalHash = createHash('sha256').update(authorization).digest('base64url');
  return `authenticated:${principalHash}`;
}

export function requireIdempotencyKey(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const value = request.headers['idempotency-key'];
  if (typeof value !== 'string' || !isValidIdempotencyKey(value)) {
    sendApiError(
      request,
      reply,
      400,
      'IDEMPOTENCY_KEY_REQUIRED',
      'Для этой операции требуется корректный Idempotency-Key.',
    );
    return Promise.resolve();
  }
  return Promise.resolve();
}

async function authenticate(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith('Bearer ')) {
    sendApiError(request, reply, 401, 'AUTH_REQUIRED', 'Требуется авторизация.');
    return;
  }

  const config = request.server.config;
  try {
    const result = await jwtVerify(
      authorization.slice('Bearer '.length),
      new TextEncoder().encode(config.JWT_ACCESS_SECRET),
      { issuer: config.JWT_ISSUER, audience: config.JWT_AUDIENCE, algorithms: ['HS256'] },
    );
    const payload = result.payload as Partial<PadlHubClaims>;
    if (
      typeof payload.sub !== 'string' ||
      !UUID_PATTERN.test(payload.sub) ||
      !Array.isArray(payload.tenants) ||
      !payload.tenants.every((tenant) => typeof tenant === 'string' && UUID_PATTERN.test(tenant)) ||
      !Array.isArray(payload.roles) ||
      !payload.roles.every((role) => typeof role === 'string') ||
      !Array.isArray(payload.permissions) ||
      !payload.permissions.every((permission) => typeof permission === 'string') ||
      typeof payload.sid !== 'string' ||
      !UUID_PATTERN.test(payload.sid)
    ) {
      throw new Error('Required PadlHub claims are missing');
    }
    request.padlHubClaims = payload as PadlHubClaims;
  } catch {
    sendApiError(request, reply, 401, 'AUTH_TOKEN_INVALID', 'Сессия недействительна.');
  }
}

async function resolveTenant(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (reply.sent) return;
  const tenantKey = (request.params as { tenantKey?: string }).tenantKey;
  const pool = request.server.pool;
  if (!tenantKey || !pool) {
    sendApiError(
      request,
      reply,
      503,
      'TENANT_CONTEXT_UNAVAILABLE',
      'Контекст организации недоступен.',
    );
    return;
  }
  if (!TENANT_KEY_PATTERN.test(tenantKey)) {
    sendApiError(
      request,
      reply,
      400,
      'TENANT_KEY_INVALID',
      'Некорректный идентификатор организации.',
    );
    return;
  }

  const result = await pool.query<{ id: string }>(
    'select id from identity.tenants where tenant_key = $1 and active = true',
    [tenantKey],
  );
  const tenantId = result.rows[0]?.id;
  if (!tenantId) {
    sendApiError(request, reply, 404, 'TENANT_NOT_FOUND', 'Организация не найдена.');
    return;
  }
  if (!request.padlHubClaims?.tenants.includes(tenantId)) {
    sendApiError(request, reply, 403, 'TENANT_ACCESS_DENIED', 'Доступ к организации запрещён.');
    return;
  }
  request.tenantId = tenantId;
}

declare module 'fastify' {
  interface FastifyInstance {
    config: AppConfig;
    pool?: Pool;
  }
}

export async function buildApp(options: BuildAppOptions) {
  const trustedProxies = parseTrustedProxies(options.config.TRUSTED_PROXY_CIDRS);
  const app = Fastify({
    loggerInstance: options.logger,
    trustProxy: trustedProxies.length > 0 ? [...trustedProxies] : false,
    requestIdHeader: false,
    genReqId: (request) => safeCorrelationId(request.headers['x-correlation-id']),
    bodyLimit: 1_048_576,
  });

  app.decorate('config', options.config);
  if (options.pool) app.decorate('pool', options.pool);

  await app.register(cookie);

  const allowedOrigins = parseAllowedOrigins(options.config.CORS_ORIGINS);
  await app.register(cors, {
    origin(origin, callback) {
      if (!origin || allowedOrigins.has(origin)) callback(null, true);
      else callback(null, false);
    },
    credentials: true,
    allowedHeaders: [
      'Authorization',
      'Content-Type',
      'Idempotency-Key',
      'X-App-Build',
      'X-App-Platform',
      'X-App-Version',
      'X-Correlation-ID',
      'X-Session-Intent',
    ],
    exposedHeaders: ['Retry-After', 'X-Correlation-ID'],
  });
  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(rateLimit, {
    max: 120,
    timeWindow: '1 minute',
    hook: 'preHandler',
    ...(options.rateLimitRedis ? { redis: options.rateLimitRedis } : {}),
    keyGenerator: rateLimitKey,
    errorResponseBuilder: (request) => ({
      code: 'RATE_LIMIT_EXCEEDED',
      message: 'Слишком много запросов. Повторите позже.',
      correlationId: correlationIdFromHeader(request),
    }),
  });

  app.addHook('onRequest', async (request, reply) => {
    reply.header('X-Correlation-ID', correlationIdFromHeader(request));
  });

  app.get('/health', () => ({ status: 'ok', service: 'phub-api' }));
  app.get('/health/live', () => ({ status: 'ok', service: 'phub-api' }));
  app.get('/health/ready', async (_request, reply) => {
    const databaseReady = options.pool ? await checkDatabaseReady(options.pool) : false;
    const authReady = options.authDependencyReady
      ? await options.authDependencyReady().catch(() => false)
      : true;
    if (!databaseReady || !authReady) {
      return reply
        .status(503)
        .send({ status: 'not_ready', database: databaseReady, auth: authReady });
    }
    return { status: 'ready', database: true, auth: true };
  });

  if (options.authService) {
    registerAuthRoutes(app as unknown as FastifyInstance, options.authService, options.config, [
      authenticate,
      resolveTenant,
    ]);
  }

  app.get(
    '/user/api/v1/:tenantKey/context',
    { preHandler: [authenticate, resolveTenant] },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      reply.header('Pragma', 'no-cache');
      const tenantId = request.tenantId;
      const userId = request.padlHubClaims?.sub;
      if (!tenantId || !userId) {
        return sendApiError(request, reply, 401, 'AUTH_REQUIRED', 'Требуется авторизация.');
      }
      const user = options.authService
        ? await options.authService.getUserContext(tenantId, userId)
        : undefined;
      if (options.authService && !user) {
        return sendApiError(request, reply, 401, 'AUTH_SESSION_REVOKED', 'Сессия завершена.');
      }
      return {
        tenantId,
        userId,
        ...(user ? { displayName: user.displayName, phoneLast4: user.phoneLast4 } : {}),
        roles: request.padlHubClaims?.roles,
        permissions: request.padlHubClaims?.permissions,
      };
    },
  );

  app.setNotFoundHandler((request, reply) => {
    sendApiError(request, reply, 404, 'ROUTE_NOT_FOUND', 'Маршрут не найден.');
  });
  app.setErrorHandler((error, request, reply) => {
    request.log.error(
      { err: error, correlationId: correlationIdFromHeader(request) },
      'request failed',
    );
    if (reply.sent) return;
    const statusCode = (error as { statusCode?: unknown }).statusCode;
    if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) {
      sendApiError(request, reply, statusCode, 'INVALID_REQUEST', 'Некорректный запрос.');
      return;
    }
    sendApiError(request, reply, 500, 'INTERNAL_ERROR', 'Внутренняя ошибка сервиса.');
  });

  return app;
}
