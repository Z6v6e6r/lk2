import { createHash, randomUUID } from 'node:crypto';

import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import type { AppConfig } from '@phub/config';
import type { CommunityDirectoryService } from '@phub/communities';
import { checkDatabaseReady } from '@phub/database';
import type {
  ClientRoutingPlanRepository,
  AdminNotificationRepository,
  BookingPreferencesRepository,
  HomeDashboardProjectionRepository,
  GameRosterRepository,
  GameRepository,
  LocationRepository,
  NotificationEndpointRepository,
  NotificationInboxRepository,
  ProfilePrivacyRepository,
} from '@phub/database';
import { isValidIdempotencyKey, type ClientPlatform } from '@phub/domain';
import type { NotificationEndpointCipher } from '@phub/notifications';
import type { Logger } from 'pino';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type Redis from 'ioredis';
import { jwtVerify, type JWTPayload } from 'jose';
import type { Pool } from 'pg';

import { registerAuthRoutes } from './auth/auth-routes.js';
import { registerAdminNotificationRoutes } from './admin/notification-admin-routes.js';
import { registerLocationAdminRoutes } from './admin/location-admin-routes.js';
import type { AuthService } from './auth/auth-service.js';
import { registerBookingPreferenceRoutes } from './bookings/booking-preference-routes.js';
import { registerBookingRecommendationRoutes } from './bookings/booking-recommendation-routes.js';
import { registerCommunityRoutes } from './communities/community-routes.js';
import { registerGameRoutes } from './games/game-routes.js';
import { registerGameReadRoutes } from './games/game-read-routes.js';
import { buildMockHomeDashboard } from './home/home-dashboard.js';
import {
  homeDashboardSchema,
  normalizeHomeDashboardPayload,
  type HomeDashboard,
} from './home/home-dashboard-schema.js';
import { sendApiError } from './http-errors.js';
import { registerLocationRoutes } from './locations/location-routes.js';
import { registerNotificationRoutes } from './notifications/notification-routes.js';
import { registerWebPushRoutes } from './notifications/web-push-routes.js';
import { registerProfilePrivacyRoutes } from './profile/profile-privacy-routes.js';
import { buildPlayerProfileView } from './profile/profile-view.js';
import { buildClientRoutingPlan, canUseDirectViva } from './routing/client-routing-plan.js';

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
  readonly communityDirectory?: CommunityDirectoryService;
  readonly homeDashboardRepository?: Pick<HomeDashboardProjectionRepository, 'get'>;
  readonly gameRosterRepository?: Pick<
    GameRosterRepository,
    'join' | 'joinWaitlist' | 'leave' | 'leaveWaitlist' | 'getOperation'
  >;
  readonly gameReadRepository?: Pick<
    GameRepository,
    'getCardProjection' | 'listPublicCardProjections' | 'listViewerCardProjections'
  > &
    Partial<Pick<GameRepository, 'listRecommendationCardProjections'>>;
  readonly clientRoutingPlanRepository?: Pick<ClientRoutingPlanRepository, 'get'>;
  readonly notificationRepository?: NotificationInboxRepository;
  readonly notificationEndpointRepository?: NotificationEndpointRepository;
  readonly notificationEndpointCipher?: NotificationEndpointCipher;
  readonly adminNotificationRepository?: AdminNotificationRepository;
  readonly locationRepository?: LocationRepository;
  readonly profilePrivacyRepository?: ProfilePrivacyRepository;
  readonly bookingPreferencesRepository?: BookingPreferencesRepository;
  readonly rateLimitRedis?: Redis;
}

function clientPlatform(request: FastifyRequest): ClientPlatform {
  const value = request.headers['x-app-platform'];
  return value === 'web' || value === 'ios' || value === 'android' || value === 'cup-admin'
    ? value
    : 'internal';
}

function upcomingBookingsResponse(dashboard: HomeDashboard) {
  return {
    version: dashboard.snapshot.version,
    generatedAt: dashboard.snapshot.generatedAt,
    staleAt: dashboard.snapshot.staleAt,
    items: dashboard.upcoming,
  };
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

export function sanitizeRequestLogUrl(value: string): string {
  const queryIndex = value.indexOf('?');
  return queryIndex === -1 ? value : value.slice(0, queryIndex);
}

function requestLogSerializer(request: FastifyRequest) {
  return {
    method: request.method,
    url: sanitizeRequestLogUrl(request.url),
    host: request.headers.host,
    remoteAddress: request.ip,
    remotePort: request.socket.remotePort,
  };
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

async function authenticateForAudience(
  request: FastifyRequest,
  reply: FastifyReply,
  audience: string,
): Promise<void> {
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
      { issuer: config.JWT_ISSUER, audience, algorithms: ['HS256'] },
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

async function authenticate(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  return authenticateForAudience(request, reply, request.server.config.JWT_AUDIENCE);
}

async function authenticateAdmin(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  return authenticateForAudience(request, reply, request.server.config.JWT_ADMIN_AUDIENCE);
}

function authorizeNotificationAdmin(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (reply.sent) return Promise.resolve();
  if (request.headers['x-app-platform'] !== 'cup-admin') {
    sendApiError(request, reply, 403, 'ADMIN_CLIENT_REQUIRED', 'Операция доступна только из ЦУП.');
    return Promise.resolve();
  }
  if (
    !request.padlHubClaims?.roles.includes('admin') ||
    !request.padlHubClaims.permissions.includes('notifications.manage')
  ) {
    sendApiError(
      request,
      reply,
      403,
      'ADMIN_PERMISSION_REQUIRED',
      'Нет права на отправку уведомлений.',
    );
  }
  return Promise.resolve();
}

function authorizeGamesPlayer(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (reply.sent) return Promise.resolve();
  if (!request.padlHubClaims?.permissions.includes('games.play')) {
    sendApiError(request, reply, 403, 'GAME_PERMISSION_REQUIRED', 'Нет права на участие в играх.');
  }
  return Promise.resolve();
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

async function resolvePublicTenant(request: FastifyRequest, reply: FastifyReply): Promise<void> {
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
  request.tenantId = tenantId;
}

declare module 'fastify' {
  interface FastifyInstance {
    config: AppConfig;
    pool?: Pool;
  }
}

export async function buildApp(options: BuildAppOptions) {
  const clientRoutingPlanRepository = options.clientRoutingPlanRepository;
  const trustedProxies = parseTrustedProxies(options.config.TRUSTED_PROXY_CIDRS);
  const requestSafeLogger = options.logger.child(
    {},
    { serializers: { req: requestLogSerializer } },
  );
  const app = Fastify({
    loggerInstance: requestSafeLogger,
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
    registerAuthRoutes(
      app as unknown as FastifyInstance,
      options.authService,
      options.config,
      [authenticate, resolveTenant],
      clientRoutingPlanRepository
        ? async (tenantId, userId, platform) =>
            canUseDirectViva({
              config: options.config,
              stored: await clientRoutingPlanRepository.get(tenantId, userId),
              platform,
            })
        : undefined,
    );
  }

  registerNotificationRoutes(app as unknown as FastifyInstance, {
    ...(options.notificationRepository ? { repository: options.notificationRepository } : {}),
    authenticatedTenantHandlers: [authenticate, resolveTenant],
    commandHandlers: [authenticate, resolveTenant, requireIdempotencyKey],
  });
  registerCommunityRoutes(app as unknown as FastifyInstance, {
    ...(options.communityDirectory ? { service: options.communityDirectory } : {}),
    authenticatedTenantHandlers: [authenticate, resolveTenant],
  });
  registerGameRoutes(app as unknown as FastifyInstance, {
    ...(options.gameRosterRepository ? { repository: options.gameRosterRepository } : {}),
    authenticatedTenantHandlers: [authenticate, authorizeGamesPlayer, resolveTenant],
    commandHandlers: [authenticate, authorizeGamesPlayer, resolveTenant, requireIdempotencyKey],
  });
  registerGameReadRoutes(app as unknown as FastifyInstance, {
    ...(options.gameReadRepository ? { repository: options.gameReadRepository } : {}),
    publicTenantHandlers: [resolvePublicTenant],
    authenticatedTenantHandlers: [authenticate, authorizeGamesPlayer, resolveTenant],
  });
  registerBookingRecommendationRoutes(app as unknown as FastifyInstance, {
    ...(options.gameReadRepository?.listRecommendationCardProjections
      ? {
          gameRepository: options.gameReadRepository as Pick<
            GameRepository,
            'listRecommendationCardProjections'
          >,
        }
      : {}),
    ...(options.bookingPreferencesRepository
      ? { preferencesRepository: options.bookingPreferencesRepository }
      : {}),
    authenticatedTenantHandlers: [authenticate, authorizeGamesPlayer, resolveTenant],
  });
  registerWebPushRoutes(app as unknown as FastifyInstance, {
    ...(options.notificationEndpointRepository
      ? { repository: options.notificationEndpointRepository }
      : {}),
    ...(options.notificationEndpointCipher ? { cipher: options.notificationEndpointCipher } : {}),
    enabledGlobally: options.config.WEB_PUSH_ENABLED,
    ...(options.config.WEB_PUSH_VAPID_PUBLIC_KEY
      ? { publicKey: options.config.WEB_PUSH_VAPID_PUBLIC_KEY }
      : {}),
    selector: {
      appId: options.config.WEB_PUSH_APP_ID,
      environment: options.config.WEB_PUSH_ENVIRONMENT,
    },
    authenticatedTenantHandlers: [authenticate, resolveTenant],
    commandHandlers: [authenticate, resolveTenant, requireIdempotencyKey],
  });
  registerAdminNotificationRoutes(app as unknown as FastifyInstance, {
    ...(options.adminNotificationRepository
      ? { repository: options.adminNotificationRepository }
      : {}),
    webPushGloballyEnabled: options.config.WEB_PUSH_ENABLED,
    webPushAppId: options.config.WEB_PUSH_APP_ID,
    webPushEnvironment: options.config.WEB_PUSH_ENVIRONMENT,
    authenticatedTenantHandlers: [authenticateAdmin, authorizeNotificationAdmin, resolveTenant],
    commandHandlers: [
      authenticateAdmin,
      authorizeNotificationAdmin,
      resolveTenant,
      requireIdempotencyKey,
    ],
  });
  registerLocationAdminRoutes(app as unknown as FastifyInstance, {
    ...(options.locationRepository ? { repository: options.locationRepository } : {}),
    authenticatedTenantHandlers: [authenticateAdmin, resolveTenant],
    commandHandlers: [authenticateAdmin, resolveTenant, requireIdempotencyKey],
  });
  registerLocationRoutes(app as unknown as FastifyInstance, {
    ...(options.locationRepository ? { repository: options.locationRepository } : {}),
    authenticatedTenantHandlers: [authenticate, resolveTenant],
  });
  registerProfilePrivacyRoutes(app as unknown as FastifyInstance, {
    ...(options.profilePrivacyRepository ? { repository: options.profilePrivacyRepository } : {}),
    authenticatedTenantHandlers: [authenticate, resolveTenant],
    commandHandlers: [authenticate, resolveTenant, requireIdempotencyKey],
  });
  registerBookingPreferenceRoutes(app as unknown as FastifyInstance, {
    ...(options.bookingPreferencesRepository
      ? { repository: options.bookingPreferencesRepository }
      : {}),
    authenticatedTenantHandlers: [authenticate, resolveTenant],
    commandHandlers: [authenticate, resolveTenant, requireIdempotencyKey],
  });

  app.get(
    '/user/api/v1/:tenantKey/routing-plan',
    { preHandler: [authenticate, resolveTenant] },
    async (request, reply) => {
      const tenantId = request.tenantId;
      const userId = request.padlHubClaims?.sub;
      if (!tenantId || !userId) {
        return sendApiError(request, reply, 401, 'AUTH_REQUIRED', 'Требуется авторизация.');
      }
      const stored = await clientRoutingPlanRepository?.get(tenantId, userId);
      if (!stored) {
        return sendApiError(
          request,
          reply,
          503,
          'ROUTING_PLAN_UNAVAILABLE',
          'Схема подключения временно недоступна.',
        );
      }
      const plan = buildClientRoutingPlan({
        config: options.config,
        stored,
        platform: clientPlatform(request),
      });
      const maxAge = Math.max(0, Math.min(30, Math.floor(stored.validForSeconds / 2)));
      reply.header('Cache-Control', `private, max-age=${maxAge}`);
      return plan;
    },
  );

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

  app.get(
    '/user/api/v1/:tenantKey/profile',
    { preHandler: [authenticate, resolveTenant] },
    async (request, reply) => {
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

      if (options.config.HOME_READ_MODE === 'mock') {
        reply.header('Cache-Control', 'private, max-age=15, stale-while-revalidate=45');
        return buildMockHomeDashboard({
          tenantId,
          userId,
          displayName: user?.displayName ?? 'Игрок ПадлХАБ',
          phoneLast4: user?.phoneLast4 ?? '0000',
          roles: request.padlHubClaims?.roles ?? [],
          permissions: request.padlHubClaims?.permissions ?? [],
        }).profile;
      }

      const projection = await options.homeDashboardRepository?.get(tenantId, userId);
      if (!projection) {
        return sendApiError(
          request,
          reply,
          503,
          'PROFILE_PROJECTION_NOT_READY',
          'Профиль ещё не подготовлен.',
        );
      }
      const parsedDashboard = homeDashboardSchema.safeParse(
        normalizeHomeDashboardPayload(projection.payload),
      );
      if (
        !parsedDashboard.success ||
        parsedDashboard.data.snapshot.source !== 'LOCAL_PROJECTION' ||
        parsedDashboard.data.snapshot.version !== projection.snapshotVersion ||
        parsedDashboard.data.profile.userId !== userId
      ) {
        return sendApiError(
          request,
          reply,
          503,
          'PROFILE_PROJECTION_INVALID',
          'Профиль временно недоступен.',
        );
      }
      const staleAt = Date.parse(parsedDashboard.data.snapshot.staleAt);
      if (Date.now() > staleAt + options.config.HOME_PROJECTION_MAX_STALE_SECONDS * 1_000) {
        return sendApiError(
          request,
          reply,
          503,
          'PROFILE_PROJECTION_STALE',
          'Профиль обновляется.',
        );
      }
      reply.header(
        'Cache-Control',
        Date.now() > staleAt
          ? 'private, max-age=0, stale-while-revalidate=45'
          : 'private, max-age=15, stale-while-revalidate=45',
      );
      return parsedDashboard.data.profile;
    },
  );

  app.get(
    '/user/api/v1/:tenantKey/profiles/:userId',
    { preHandler: [authenticate, resolveTenant] },
    async (request, reply) => {
      const tenantId = request.tenantId;
      const viewerUserId = request.padlHubClaims?.sub;
      const permissions = request.padlHubClaims?.permissions ?? [];
      const targetUserId = (request.params as { userId?: string }).userId;
      if (!tenantId || !viewerUserId) {
        return sendApiError(request, reply, 401, 'AUTH_REQUIRED', 'Требуется авторизация.');
      }
      if (!permissions.includes('profile.read')) {
        return sendApiError(
          request,
          reply,
          403,
          'PROFILE_READ_DENIED',
          'Нет доступа к профилям игроков.',
        );
      }
      if (!targetUserId || !UUID_PATTERN.test(targetUserId)) {
        return sendApiError(
          request,
          reply,
          400,
          'PROFILE_ID_INVALID',
          'Некорректный идентификатор профиля.',
        );
      }
      const privacyPolicy =
        targetUserId === viewerUserId
          ? undefined
          : await options.profilePrivacyRepository?.get(tenantId, targetUserId);

      if (options.config.HOME_READ_MODE === 'mock') {
        const isSelf = targetUserId === viewerUserId;
        const user =
          isSelf && options.authService
            ? await options.authService.getUserContext(tenantId, viewerUserId)
            : undefined;
        const profile = buildMockHomeDashboard({
          tenantId,
          userId: targetUserId,
          displayName: user?.displayName ?? 'Игрок ПадлХАБ',
          phoneLast4: user?.phoneLast4 ?? '0000',
          roles: request.padlHubClaims?.roles ?? [],
          permissions,
        }).profile;
        reply.header('Cache-Control', 'private, max-age=15, stale-while-revalidate=45');
        return buildPlayerProfileView({
          profile,
          viewerUserId,
          permissions,
          ...(privacyPolicy ? { policy: privacyPolicy } : {}),
        });
      }

      const projection = await options.homeDashboardRepository?.get(tenantId, targetUserId);
      if (!projection) {
        return sendApiError(request, reply, 404, 'PROFILE_NOT_FOUND', 'Профиль игрока не найден.');
      }
      const parsedDashboard = homeDashboardSchema.safeParse(
        normalizeHomeDashboardPayload(projection.payload),
      );
      if (
        !parsedDashboard.success ||
        parsedDashboard.data.snapshot.source !== 'LOCAL_PROJECTION' ||
        parsedDashboard.data.snapshot.version !== projection.snapshotVersion ||
        parsedDashboard.data.profile.userId !== targetUserId
      ) {
        return sendApiError(
          request,
          reply,
          503,
          'PROFILE_VIEW_PROJECTION_INVALID',
          'Профиль временно недоступен.',
        );
      }
      const staleAt = Date.parse(parsedDashboard.data.snapshot.staleAt);
      if (Date.now() > staleAt + options.config.HOME_PROJECTION_MAX_STALE_SECONDS * 1_000) {
        return sendApiError(
          request,
          reply,
          503,
          'PROFILE_VIEW_PROJECTION_STALE',
          'Профиль обновляется.',
        );
      }
      reply.header(
        'Cache-Control',
        Date.now() > staleAt
          ? 'private, max-age=0, stale-while-revalidate=45'
          : 'private, max-age=15, stale-while-revalidate=45',
      );
      return buildPlayerProfileView({
        profile: parsedDashboard.data.profile,
        viewerUserId,
        permissions,
        ...(privacyPolicy ? { policy: privacyPolicy } : {}),
      });
    },
  );

  app.get(
    '/user/api/v1/:tenantKey/bookings/upcoming',
    { preHandler: [authenticate, resolveTenant] },
    async (request, reply) => {
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

      if (options.config.HOME_READ_MODE === 'mock') {
        reply.header('Cache-Control', 'private, max-age=15, stale-while-revalidate=45');
        return upcomingBookingsResponse(
          buildMockHomeDashboard({
            tenantId,
            userId,
            displayName: user?.displayName ?? 'Игрок ПадлХАБ',
            phoneLast4: user?.phoneLast4 ?? '0000',
            roles: request.padlHubClaims?.roles ?? [],
            permissions: request.padlHubClaims?.permissions ?? [],
          }),
        );
      }

      const projection = await options.homeDashboardRepository?.get(tenantId, userId);
      if (!projection) {
        return sendApiError(
          request,
          reply,
          503,
          'BOOKINGS_PROJECTION_NOT_READY',
          'Записи ещё не подготовлены.',
        );
      }
      const parsedDashboard = homeDashboardSchema.safeParse(
        normalizeHomeDashboardPayload(projection.payload),
      );
      if (
        !parsedDashboard.success ||
        parsedDashboard.data.snapshot.source !== 'LOCAL_PROJECTION' ||
        parsedDashboard.data.snapshot.version !== projection.snapshotVersion ||
        Date.parse(parsedDashboard.data.snapshot.generatedAt) !==
          Date.parse(projection.generatedAt) ||
        Date.parse(parsedDashboard.data.snapshot.staleAt) !== Date.parse(projection.staleAt) ||
        parsedDashboard.data.profile.userId !== userId
      ) {
        return sendApiError(
          request,
          reply,
          503,
          'BOOKINGS_PROJECTION_INVALID',
          'Записи временно недоступны.',
        );
      }
      const staleAt = Date.parse(parsedDashboard.data.snapshot.staleAt);
      if (Date.now() > staleAt + options.config.HOME_PROJECTION_MAX_STALE_SECONDS * 1_000) {
        return sendApiError(
          request,
          reply,
          503,
          'BOOKINGS_PROJECTION_STALE',
          'Записи обновляются.',
        );
      }
      reply.header(
        'Cache-Control',
        Date.now() > staleAt
          ? 'private, max-age=0, stale-while-revalidate=45'
          : 'private, max-age=15, stale-while-revalidate=45',
      );
      return upcomingBookingsResponse(parsedDashboard.data);
    },
  );

  app.get(
    '/user/api/v1/:tenantKey/home',
    { preHandler: [authenticate, resolveTenant] },
    async (request, reply) => {
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

      if (options.config.HOME_READ_MODE === 'mock') {
        reply.header('Cache-Control', 'private, max-age=15, stale-while-revalidate=45');
        return buildMockHomeDashboard({
          tenantId,
          userId,
          displayName: user?.displayName ?? 'Игрок ПадлХАБ',
          phoneLast4: user?.phoneLast4 ?? '0000',
          roles: request.padlHubClaims?.roles ?? [],
          permissions: request.padlHubClaims?.permissions ?? [],
        });
      }

      const projection = await options.homeDashboardRepository?.get(tenantId, userId);
      if (!projection) {
        return sendApiError(
          request,
          reply,
          503,
          'HOME_PROJECTION_NOT_READY',
          'Данные главной страницы ещё не подготовлены.',
        );
      }

      const parsedDashboard = homeDashboardSchema.safeParse(
        normalizeHomeDashboardPayload(projection.payload),
      );
      if (
        !parsedDashboard.success ||
        parsedDashboard.data.snapshot.source !== 'LOCAL_PROJECTION' ||
        parsedDashboard.data.snapshot.version !== projection.snapshotVersion ||
        Date.parse(parsedDashboard.data.snapshot.generatedAt) !==
          Date.parse(projection.generatedAt) ||
        Date.parse(parsedDashboard.data.snapshot.staleAt) !== Date.parse(projection.staleAt) ||
        parsedDashboard.data.profile.userId !== userId
      ) {
        request.log.error(
          {
            tenantId,
            userId,
            sourceRevision: projection.sourceRevision,
            validationIssues: parsedDashboard.success
              ? undefined
              : parsedDashboard.error.issues.map((issue) => ({
                  path: issue.path.join('.'),
                  code: issue.code,
                })),
          },
          'invalid Home projection rejected',
        );
        return sendApiError(
          request,
          reply,
          503,
          'HOME_PROJECTION_INVALID',
          'Данные главной страницы временно недоступны.',
        );
      }

      const staleAt = Date.parse(parsedDashboard.data.snapshot.staleAt);
      const staleGraceMs = options.config.HOME_PROJECTION_MAX_STALE_SECONDS * 1_000;
      if (Date.now() > staleAt + staleGraceMs) {
        return sendApiError(
          request,
          reply,
          503,
          'HOME_PROJECTION_STALE',
          'Данные главной страницы обновляются.',
        );
      }

      reply.header(
        'Cache-Control',
        Date.now() > staleAt
          ? 'private, max-age=0, stale-while-revalidate=45'
          : 'private, max-age=15, stale-while-revalidate=45',
      );
      return parsedDashboard.data;
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
