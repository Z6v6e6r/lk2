import { createHash, randomUUID } from 'node:crypto';

import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import type { AppConfig, RuntimeContourAttestation } from '@phub/config';
import type {
  CommunityCreateService,
  CommunityDirectoryService,
  CommunityDirectInviteService,
  CommunityMembershipPinService,
  CommunityMembershipLifecycleService,
  CommunityReadService,
  CommunityOwnershipTransferService,
  CommunityContentService,
  CommunityContentModerationService,
  CommunityEventRecoveryService,
  CommunityMediaService,
  CommunityReadExperienceService,
} from '@phub/communities';
import { checkDatabaseReady } from '@phub/database';
import type {
  ClientRoutingPlanRepository,
  CommunityLogoMediaRepository,
  CupPlayerLevelProjectionRepository,
  CommunityMediaPersistenceRepository,
  AdminNotificationRepository,
  BookingPreferencesRepository,
  BookingScreenMappingRepository,
  ActivityHistoryRepository,
  HomeBaseProjectionRepository,
  HomeDashboardProjectionRepository,
  GameResultRepository,
  GameRosterRepository,
  GameRepository,
  GiftCertificateCatalogRepository,
  GiftCertificateIssuanceRepository,
  GiftCertificateMediaRepository,
  GiftCertificateSaleRepository,
  LocationMediaRepository,
  LocationRepository,
  LevelEligibilityPolicyRepository,
  LegacyGameRosterBridgeRepository,
  PlayerLevelRepository,
  MessagingRepository,
  NotificationEndpointRepository,
  NotificationInboxRepository,
  ParticipationCommandRepository,
  ProfileFriendshipRepository,
  ProfileLevelHistoryRepository,
  ProfilePrivacyRepository,
  ProfileSummaryRepository,
  PromotionEngagementRepository,
  RealtimeAuthorizationRepository,
  TrainerAvatarRepository,
  UpcomingBookingsRepository,
} from '@phub/database';
import {
  DIRECT_VIVA_READ_OPERATIONS,
  isValidIdempotencyKey,
  profilePhotoDeliveryUrl,
  type ClientPlatform,
} from '@phub/domain';
import { homeBaseSchema, normalizeHomeBaseFreshness, type HomeBase } from '@phub/home-projection';
import type { NotificationEndpointCipher } from '@phub/notifications';
import type { VivaExerciseRecommendationSourceAdapter } from '@phub/viva-adapter';
import type { Logger } from 'pino';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type Redis from 'ioredis';
import { jwtVerify, type JWTPayload } from 'jose';
import type { Pool } from 'pg';
import { z } from 'zod';

import { registerAuthRoutes } from './auth/auth-routes.js';
import { registerAdminNotificationRoutes } from './admin/notification-admin-routes.js';
import { registerLocationAdminRoutes } from './admin/location-admin-routes.js';
import { registerLevelEligibilityAdminRoutes } from './admin/level-eligibility-admin-routes.js';
import { registerGiftCertificateAdminRoutes } from './admin/gift-certificate-admin-routes.js';
import { registerCommunityMembershipAdminRoutes } from './admin/community-membership-admin-routes.js';
import { registerCommunityDirectInviteAdminRoutes } from './admin/community-direct-invite-admin-routes.js';
import { registerCommunityCreateQuotaAdminRoutes } from './admin/community-create-quota-admin-routes.js';
import { registerCommunityContentModerationAdminRoutes } from './admin/community-content-moderation-admin-routes.js';
import type { AuthService } from './auth/auth-service.js';
import { registerBookingPreferenceRoutes } from './bookings/booking-preference-routes.js';
import {
  registerBookingRecommendationRoutes,
  type EventCatalogItem,
} from './bookings/booking-recommendation-routes.js';
import type { BookingScreenReadJobStore } from './bookings/booking-screen-read-job-store.js';
import type { EventCatalogSnapshotStore } from './bookings/event-catalog-snapshot-store.js';
import {
  registerActivityHistoryRoutes,
  type ActivityHistoryProjectionService,
  type ActivityHistoryRefreshService,
} from './bookings/activity-history-routes.js';
import { registerCommunityRoutes } from './communities/community-routes.js';
import { registerCommunityLogoMediaRoutes } from './communities/community-logo-media-routes.js';
import { registerCommunityExperienceRoutes } from './communities/community-experience-routes.js';
import { registerCommunityDirectInviteRoutes } from './communities/community-direct-invite-routes.js';
import { registerCommunityContentRoutes } from './communities/community-content-routes.js';
import { registerCommunityEventRoutes } from './communities/community-event-routes.js';
import {
  registerCommunityMediaRoutes,
  type CommunityMediaDeliveryAuthorizer,
} from './communities/community-media-routes.js';
import type { CommunityMediaObjectStore } from './communities/community-media-object-store.js';
import {
  EventAvatarMediaProxy,
  PersistentTrainerAvatarMedia,
  type EventAvatarMedia,
} from './event-avatar-media.js';
import { registerCoachGameSummaryRoutes } from './coach-games/coach-game-summary-routes.js';
import { registerGameRoutes } from './games/game-routes.js';
import { registerLegacyGameRosterBridgeRoutes } from './games/legacy-game-roster-bridge-routes.js';
import type { LegacyLkIdentityVerifier } from './games/legacy-lk-identity-verifier.js';
import { registerGameResultRoutes } from './games/game-result-routes.js';
import { registerGameReadRoutes } from './games/game-read-routes.js';
import { registerGiftCertificateRoutes } from './gift-certificates/gift-certificate-routes.js';
import type { GiftCertificateArtifactReadStore } from './gift-certificates/gift-certificate-artifact-store.js';
import { registerGiftCertificateMediaRoutes } from './gift-certificates/gift-certificate-media-routes.js';
import type { GiftCertificateMediaStore } from './gift-certificates/gift-certificate-media-store.js';
import { registerGiftCertificateSaleRoutes } from './gift-certificates/gift-certificate-sale-routes.js';
import { buildMockHomeDashboard } from './home/home-dashboard.js';
import {
  homeDashboardSchema,
  normalizeHomeDashboardPayload,
  type HomeDashboard,
} from './home/home-dashboard-schema.js';
import { sendApiError } from './http-errors.js';
import { registerLocationRoutes } from './locations/location-routes.js';
import { registerParticipationCommandRoutes } from './eligibility/participation-command-routes.js';
import { registerLocationMediaRoutes } from './locations/location-media-routes.js';
import type { LocationMediaStore } from './locations/location-media-store.js';
import { registerMessagingRoutes } from './messaging/messaging-routes.js';
import type { RealtimeTicketIssuer } from './messaging/realtime-ticket-issuer.js';
import type { TrainerAvatarMediaStore } from './trainer-avatar-media-store.js';
import { registerNotificationRoutes } from './notifications/notification-routes.js';
import { registerWebPushRoutes } from './notifications/web-push-routes.js';
import { registerProfilePrivacyRoutes } from './profile/profile-privacy-routes.js';
import { registerProfileFriendshipRoutes } from './profile/profile-friendship-routes.js';
import { registerProfileLevelHistoryRoutes } from './profile/profile-level-history-routes.js';
import { registerProfileLevelRoutes } from './profile/profile-level-routes.js';
import { registerCupPlayerLevelProjectionRoutes } from './profile/cup-player-level-projection-routes.js';
import { registerPromotionEngagementRoutes } from './promotions/promotion-engagement-routes.js';
import type { PromotionEngagementSink } from './promotions/legacy-promotion-engagement-sink.js';
import { registerProfilePhotoMediaRoutes } from './profile/profile-photo-media-routes.js';
import type { ProfilePhotoMediaStore } from './profile/profile-photo-media-store.js';
import {
  homeProfilePhotoUserIds,
  stabilizeHomeProfilePhotos,
  stableProfilePhotoUrl,
} from './profile/profile-photo-url.js';
import { buildPlayerProfileView } from './profile/profile-view.js';
import { buildClientRoutingPlan, canUseDirectViva } from './routing/client-routing-plan.js';
import { registerRealtimeRoutes } from './realtime/realtime-routes.js';
import {
  registerTournamentSummaryRoutes,
  type TournamentSummarySource,
} from './tournaments/tournament-summary-routes.js';

interface PadlHubClaims extends JWTPayload {
  readonly sub: string;
  readonly tenants: readonly string[];
  readonly roles: readonly string[];
  readonly permissions: readonly string[];
  readonly sid: string;
}

const directVivaOutcomeSchema = z
  .object({
    operation: z.enum([...DIRECT_VIVA_READ_OPERATIONS, 'profile.photo.sync']),
    routingRevision: z.string().regex(/^[0-9]+$/),
    outcome: z.enum(['SUCCESS', 'UNAVAILABLE', 'REAUTH_REQUIRED', 'INVALID', 'CIRCUIT_OPEN']),
    statusClass: z
      .string()
      .regex(/^[1-5]xx$/)
      .optional(),
    durationMs: z.number().int().min(0).max(60_000),
  })
  .strict();

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CORRELATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const TENANT_KEY_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}$/;

function profileLevel(label: string | null): {
  readonly label: string;
  readonly value: number;
  readonly assessmentRequired: boolean;
} {
  const values: Record<string, number> = {
    D: 0,
    'D+': 2.5,
    C: 3,
    'C+': 3.5,
    B: 4.5,
    'B+': 5,
    A: 6,
  };
  const value = label ? values[label] : undefined;
  if (!label || value === undefined) return { label: 'D', value: 0, assessmentRequired: true };
  return { label, value, assessmentRequired: false };
}

function profileNameParts(displayName: string): {
  readonly firstName: string;
  readonly lastName: string | null;
} {
  const [firstName, ...lastName] = displayName.trim().split(/\s+/);
  return { firstName: firstName || displayName, lastName: lastName.join(' ') || null };
}

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
  readonly runtimeContourAttestation?: RuntimeContourAttestation;
  readonly communityDirectory?: CommunityDirectoryService;
  readonly communityReadExperienceService?: CommunityReadExperienceService;
  readonly communityCreateService?: CommunityCreateService;
  readonly communityMembershipPinService?: CommunityMembershipPinService;
  readonly communityMembershipLifecycleService?: CommunityMembershipLifecycleService;
  readonly communityReadService?: CommunityReadService;
  readonly communityDirectInviteService?: CommunityDirectInviteService;
  readonly communityOwnershipTransferService?: CommunityOwnershipTransferService;
  readonly communityContentService?: CommunityContentService;
  readonly communityContentModerationService?: CommunityContentModerationService;
  readonly communityEventRecoveryService?: CommunityEventRecoveryService;
  readonly communityMediaService?: CommunityMediaService;
  readonly communityMediaDeliveryAuthorizer?: CommunityMediaDeliveryAuthorizer;
  readonly communityMediaModerationAuthorizer?: CommunityMediaDeliveryAuthorizer;
  readonly communityMediaObjectStore?: CommunityMediaObjectStore;
  readonly communityMediaOperationsRepository?: Pick<
    CommunityMediaPersistenceRepository,
    'replayFailedScan' | 'replayDeadGc'
  >;
  readonly homeDashboardRepository?: Pick<HomeDashboardProjectionRepository, 'get'>;
  readonly homeBaseRepository?: Pick<HomeBaseProjectionRepository, 'get'>;
  readonly homeBaseProjector?: (input: {
    readonly tenantId: string;
    readonly userId: string;
    readonly correlationId: string;
  }) => Promise<unknown>;
  readonly gameRosterRepository?: Pick<
    GameRosterRepository,
    'join' | 'joinWaitlist' | 'leave' | 'leaveWaitlist' | 'getOperation'
  > &
    Partial<Pick<GameRosterRepository, 'confirmPayment'>>;
  readonly legacyGameRosterBridgeRepository?: LegacyGameRosterBridgeRepository;
  readonly legacyLkIdentityVerifier?: LegacyLkIdentityVerifier;
  readonly gameResultRepository?: Pick<GameResultRepository, 'submit' | 'confirm' | 'dispute'>;
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
  readonly messagingRepository?: MessagingRepository;
  readonly realtimeTicketIssuer?: RealtimeTicketIssuer;
  readonly locationRepository?: LocationRepository;
  readonly levelEligibilityPolicyRepository?: LevelEligibilityPolicyRepository;
  readonly playerLevelRepository?: PlayerLevelRepository;
  readonly cupPlayerLevelProjectionRepository?: CupPlayerLevelProjectionRepository;
  readonly participationCommandRepository?: ParticipationCommandRepository;
  readonly locationMediaRepository?: LocationMediaRepository;
  readonly giftCertificateCatalogRepository?: GiftCertificateCatalogRepository;
  readonly giftCertificateMediaRepository?: GiftCertificateMediaRepository;
  readonly giftCertificateSaleRepository?: GiftCertificateSaleRepository;
  readonly giftCertificateIssuanceRepository?: GiftCertificateIssuanceRepository;
  readonly giftCertificateMediaStore?: GiftCertificateMediaStore;
  readonly locationMediaStore?: LocationMediaStore;
  readonly giftCertificateArtifactStore?: GiftCertificateArtifactReadStore;
  readonly profilePrivacyRepository?: ProfilePrivacyRepository;
  readonly profileFriendshipRepository?: ProfileFriendshipRepository;
  readonly profileLevelHistoryRepository?: ProfileLevelHistoryRepository;
  readonly profileSummaryRepository?: Pick<ProfileSummaryRepository, 'get'>;
  readonly promotionEngagementRepository?: PromotionEngagementRepository;
  readonly promotionEngagementSink?: PromotionEngagementSink;
  readonly profilePhotoMediaRepository?: Pick<
    ProfileSummaryRepository,
    'getPhotoObjectKey' | 'getPhotoDeliveryIds'
  > &
    Partial<
      Pick<
        ProfileSummaryRepository,
        | 'getDisplayNames'
        | 'getLevelValues'
        | 'getPhotoDeliveryState'
        | 'reserveClientAssistedPhoto'
        | 'finalizeClientAssistedPhoto'
        | 'removeClientAssistedPhoto'
      >
    >;
  readonly profilePhotoMediaStore?: ProfilePhotoMediaStore;
  readonly communityLogoMediaRepository?: CommunityLogoMediaRepository;
  readonly bookingPreferencesRepository?: BookingPreferencesRepository;
  readonly bookingScreenReadJobStore?: BookingScreenReadJobStore;
  readonly eventCatalogSnapshotStore?: EventCatalogSnapshotStore<EventCatalogItem>;
  readonly bookingScreenMappingRepository?: BookingScreenMappingRepository;
  readonly upcomingBookingsRepository?: UpcomingBookingsRepository;
  readonly activityHistoryRepository?: ActivityHistoryRepository;
  readonly activityHistoryRefresher?: ActivityHistoryRefreshService;
  readonly activityHistoryProjector?: ActivityHistoryProjectionService;
  readonly tournamentSummarySource?: TournamentSummarySource;
  readonly eventAvatarMedia?: EventAvatarMedia;
  readonly trainerAvatarRepository?: TrainerAvatarRepository;
  readonly trainerAvatarMediaStore?: TrainerAvatarMediaStore;
  readonly exerciseRecommendationSource?: Pick<
    VivaExerciseRecommendationSourceAdapter,
    'readDate'
  > &
    Partial<
      Pick<
        VivaExerciseRecommendationSourceAdapter,
        | 'readAvatarSource'
        | 'registerAvatarSource'
        | 'readTrainerAvatarSource'
        | 'registerTrainerAvatarSource'
      >
    >;
  readonly rateLimitRedis?: Redis;
  readonly realtimeAuthorizationRepository?: RealtimeAuthorizationRepository;
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

async function normalizeProjectedHomeDashboard(input: {
  readonly payload: unknown;
  readonly tenantId: string;
  readonly photoRepository?: Pick<ProfileSummaryRepository, 'getPhotoDeliveryIds'>;
}): Promise<unknown> {
  const normalized = normalizeHomeDashboardPayload(input.payload);
  const deliveryIds = input.photoRepository
    ? await input.photoRepository.getPhotoDeliveryIds(
        input.tenantId,
        homeProfilePhotoUserIds(normalized),
      )
    : new Map<string, string>();
  return stabilizeHomeProfilePhotos(normalized, input.tenantId, deliveryIds);
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

function authorizeDirectChat(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (reply.sent) return Promise.resolve();
  if (!request.padlHubClaims?.permissions.includes('chat.direct.create')) {
    sendApiError(
      request,
      reply,
      403,
      'CHAT_PERMISSION_REQUIRED',
      'Нет права на создание личного диалога.',
    );
  }
  return Promise.resolve();
}

function authorizeMessagingCommand(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (reply.sent) return Promise.resolve();
  const permissions = request.padlHubClaims?.permissions ?? [];
  if (!permissions.includes('chat.direct.create') && !permissions.includes('games.play')) {
    sendApiError(request, reply, 403, 'CHAT_PERMISSION_REQUIRED', 'Нет права на операцию с чатом.');
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
  const remoteEventAvatarMedia = new EventAvatarMediaProxy({
    allowedHosts: options.config.PROFILE_PHOTO_ALLOWED_HOSTS.split(',')
      .map((host) => host.trim())
      .filter(Boolean),
    timeoutMs: options.config.VIVA_TIMEOUT_MS,
    maxBytes: options.config.PROFILE_PHOTO_MAX_BYTES,
    maxDimension: options.config.PROFILE_PHOTO_MAX_DIMENSION,
    webpQuality: options.config.PROFILE_PHOTO_WEBP_QUALITY,
    circuitFailureThreshold: 3,
    circuitResetMs: 30_000,
    onMetric: (metric) => options.logger.info({ metric }, 'event avatar media read'),
  });
  const eventAvatarMedia =
    options.eventAvatarMedia ??
    (options.trainerAvatarRepository && options.trainerAvatarMediaStore
      ? new PersistentTrainerAvatarMedia({
          remote: remoteEventAvatarMedia,
          repository: options.trainerAvatarRepository,
          store: options.trainerAvatarMediaStore,
          maxBytes: options.config.PROFILE_PHOTO_MAX_BYTES,
          onPersistenceError: (err) =>
            options.logger.warn({ err }, 'trainer avatar persistence failed'),
        })
      : remoteEventAvatarMedia);

  const userRuntimeCapabilities = {
    communityDirectory: Boolean(options.communityDirectory),
    communityReadDetail:
      options.config.COMMUNITY_LEGACY_READ_DETAIL_ENABLED &&
      Boolean(options.communityReadExperienceService),
    communityReadFeed:
      options.config.COMMUNITY_LEGACY_READ_FEED_ENABLED &&
      Boolean(options.communityReadExperienceService),
    communityReadChat:
      options.config.COMMUNITY_LEGACY_READ_CHAT_ENABLED &&
      Boolean(options.communityReadExperienceService),
    communityReadRating:
      options.config.COMMUNITY_LEGACY_READ_RATING_ENABLED &&
      Boolean(options.communityReadExperienceService),
    communityCanonical: Boolean(options.communityReadService),
    communityDirectInvites:
      options.config.COMMUNITY_INVITES_ENABLED && Boolean(options.communityDirectInviteService),
    communityRealtime:
      options.config.COMMUNITIES_REALTIME_ENABLED &&
      Boolean(options.realtimeAuthorizationRepository) &&
      Boolean(options.realtimeTicketIssuer),
  } as const;

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
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Authorization',
      'Content-Type',
      'Idempotency-Key',
      'X-App-Build',
      'X-App-Platform',
      'X-App-Version',
      'X-Correlation-ID',
      'X-Profile-Photo-Grant',
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
    const [databaseReady, authReady, communityMediaReady] = await Promise.all([
      options.pool ? checkDatabaseReady(options.pool) : Promise.resolve(false),
      options.authDependencyReady
        ? options.authDependencyReady().catch(() => false)
        : Promise.resolve(true),
      options.communityMediaObjectStore
        ? options.communityMediaObjectStore
            .checkReady()
            .then(() => true)
            .catch(() => false)
        : Promise.resolve(true),
    ]);
    if (!databaseReady || !authReady || !communityMediaReady) {
      return reply.status(503).send({
        status: 'not_ready',
        database: databaseReady,
        auth: authReady,
        communityMedia: communityMediaReady,
        ...(options.runtimeContourAttestation
          ? { runtimeContour: options.runtimeContourAttestation }
          : {}),
      });
    }
    return {
      status: 'ready',
      database: true,
      auth: true,
      communityMedia: true,
      ...(options.runtimeContourAttestation
        ? { runtimeContour: options.runtimeContourAttestation }
        : {}),
    };
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
      userRuntimeCapabilities,
      options.profilePhotoMediaRepository?.getPhotoDeliveryState
        ? async (tenantId, userId) => {
            const state = await options.profilePhotoMediaRepository?.getPhotoDeliveryState?.(
              tenantId,
              userId,
            );
            return state
              ? {
                  avatarUrl: profilePhotoDeliveryUrl(tenantId, state.deliveryId),
                  syncedAt: state.syncedAt,
                }
              : undefined;
          }
        : undefined,
    );
  }

  registerNotificationRoutes(app as unknown as FastifyInstance, {
    ...(options.notificationRepository ? { repository: options.notificationRepository } : {}),
    authenticatedTenantHandlers: [authenticate, resolveTenant],
    commandHandlers: [authenticate, resolveTenant, requireIdempotencyKey],
  });
  registerMessagingRoutes(app as unknown as FastifyInstance, {
    ...(options.messagingRepository ? { repository: options.messagingRepository } : {}),
    ...(options.realtimeTicketIssuer ? { realtimeTicketIssuer: options.realtimeTicketIssuer } : {}),
    userBlockCommandsEnabled: options.config.MESSAGING_USER_BLOCK_COMMANDS_ENABLED,
    authenticatedTenantHandlers: [authenticate, resolveTenant],
    directCommandHandlers: [
      authenticate,
      authorizeDirectChat,
      resolveTenant,
      requireIdempotencyKey,
    ],
    contextualCommandHandlers: [
      authenticate,
      authorizeGamesPlayer,
      resolveTenant,
      requireIdempotencyKey,
    ],
    commandHandlers: [
      authenticate,
      authorizeMessagingCommand,
      resolveTenant,
      requireIdempotencyKey,
    ],
  });
  registerCommunityRoutes(app as unknown as FastifyInstance, {
    ...(options.communityDirectory ? { service: options.communityDirectory } : {}),
    ...(options.communityCreateService ? { createService: options.communityCreateService } : {}),
    ...(options.communityMembershipPinService
      ? { membershipPinService: options.communityMembershipPinService }
      : {}),
    ...(options.communityMembershipLifecycleService
      ? { membershipLifecycleService: options.communityMembershipLifecycleService }
      : {}),
    ...(options.communityReadService ? { readService: options.communityReadService } : {}),
    ...(options.communityOwnershipTransferService
      ? { ownershipTransferService: options.communityOwnershipTransferService }
      : {}),
    authenticatedTenantHandlers: [authenticate, resolveTenant],
    commandHandlers: [authenticate, resolveTenant, requireIdempotencyKey],
  });
  registerCommunityDirectInviteRoutes(app as unknown as FastifyInstance, {
    ...(options.communityDirectInviteService
      ? { service: options.communityDirectInviteService }
      : {}),
    authenticatedTenantHandlers: [authenticate, resolveTenant],
    commandHandlers: [authenticate, resolveTenant, requireIdempotencyKey],
  });
  registerCommunityContentRoutes(app as unknown as FastifyInstance, {
    ...(options.communityContentService ? { service: options.communityContentService } : {}),
    authenticatedTenantHandlers: [authenticate, resolveTenant],
    commandHandlers: [authenticate, resolveTenant, requireIdempotencyKey],
  });
  registerCommunityEventRoutes(app as unknown as FastifyInstance, {
    ...(options.communityEventRecoveryService
      ? { service: options.communityEventRecoveryService }
      : {}),
    authenticatedTenantHandlers: [authenticate, resolveTenant],
  });
  registerCommunityMediaRoutes(app as unknown as FastifyInstance, {
    ...(options.communityMediaService ? { service: options.communityMediaService } : {}),
    ...(options.communityMediaDeliveryAuthorizer
      ? { deliveryAuthorizer: options.communityMediaDeliveryAuthorizer }
      : {}),
    ...(options.communityMediaObjectStore
      ? { objectStore: options.communityMediaObjectStore }
      : {}),
    readUrlTtlSeconds: options.config.COMMUNITY_MEDIA_READ_URL_TTL_SECONDS,
    authenticatedTenantHandlers: [authenticate, resolveTenant],
    commandHandlers: [authenticate, resolveTenant, requireIdempotencyKey],
  });
  registerRealtimeRoutes(app as unknown as FastifyInstance, {
    enabled: options.config.COMMUNITIES_REALTIME_ENABLED,
    ...(options.realtimeAuthorizationRepository
      ? { repository: options.realtimeAuthorizationRepository }
      : {}),
    ...(options.realtimeTicketIssuer ? { ticketIssuer: options.realtimeTicketIssuer } : {}),
    authenticatedTenantHandlers: [authenticate, resolveTenant],
  });
  registerCommunityMembershipAdminRoutes(app as unknown as FastifyInstance, {
    ...(options.communityMembershipLifecycleService
      ? { service: options.communityMembershipLifecycleService }
      : {}),
    authenticatedTenantHandlers: [authenticateAdmin, resolveTenant],
    commandHandlers: [authenticateAdmin, resolveTenant, requireIdempotencyKey],
  });
  registerCommunityDirectInviteAdminRoutes(app as unknown as FastifyInstance, {
    ...(options.communityDirectInviteService
      ? { service: options.communityDirectInviteService }
      : {}),
    commandHandlers: [authenticateAdmin, resolveTenant, requireIdempotencyKey],
  });
  registerCommunityCreateQuotaAdminRoutes(app as unknown as FastifyInstance, {
    ...(options.communityCreateService ? { service: options.communityCreateService } : {}),
    commandHandlers: [authenticateAdmin, resolveTenant, requireIdempotencyKey],
  });
  registerCommunityContentModerationAdminRoutes(app as unknown as FastifyInstance, {
    ...(options.communityContentModerationService
      ? { service: options.communityContentModerationService }
      : {}),
    ...(options.communityMediaModerationAuthorizer
      ? { mediaAuthorizer: options.communityMediaModerationAuthorizer }
      : {}),
    ...(options.communityMediaObjectStore
      ? { mediaObjectStore: options.communityMediaObjectStore }
      : {}),
    ...(options.communityMediaOperationsRepository
      ? { mediaOperationsRepository: options.communityMediaOperationsRepository }
      : {}),
    mediaReadUrlTtlSeconds: options.config.COMMUNITY_MEDIA_READ_URL_TTL_SECONDS,
    authenticatedTenantHandlers: [authenticateAdmin, resolveTenant],
    commandHandlers: [authenticateAdmin, resolveTenant, requireIdempotencyKey],
  });
  registerCommunityExperienceRoutes(app as unknown as FastifyInstance, {
    ...(options.communityReadExperienceService
      ? { service: options.communityReadExperienceService }
      : {}),
    authenticatedTenantHandlers: [authenticate, resolveTenant],
    enabled: {
      detail: userRuntimeCapabilities.communityReadDetail,
      feed: userRuntimeCapabilities.communityReadFeed,
      chat: userRuntimeCapabilities.communityReadChat,
      rating: userRuntimeCapabilities.communityReadRating,
    },
  });
  registerGameRoutes(app as unknown as FastifyInstance, {
    ...(options.gameRosterRepository ? { repository: options.gameRosterRepository } : {}),
    authenticatedTenantHandlers: [authenticate, authorizeGamesPlayer, resolveTenant],
    commandHandlers: [authenticate, authorizeGamesPlayer, resolveTenant, requireIdempotencyKey],
  });
  registerLegacyGameRosterBridgeRoutes(app as unknown as FastifyInstance, {
    enabled: options.config.LEGACY_GAME_COMMAND_BRIDGE_ENABLED,
    ...(options.config.LEGACY_GAME_COMMAND_BRIDGE_TOKEN
      ? { integrationToken: options.config.LEGACY_GAME_COMMAND_BRIDGE_TOKEN }
      : {}),
    ...(options.legacyLkIdentityVerifier
      ? { identityVerifier: options.legacyLkIdentityVerifier }
      : {}),
    ...(options.legacyGameRosterBridgeRepository
      ? { contextRepository: options.legacyGameRosterBridgeRepository }
      : {}),
    ...(options.gameRosterRepository?.confirmPayment
      ? {
          rosterRepository: {
            join: options.gameRosterRepository.join,
            joinWaitlist: options.gameRosterRepository.joinWaitlist,
            confirmPayment: options.gameRosterRepository.confirmPayment,
          },
        }
      : {}),
    commandHandlers: [resolvePublicTenant, requireIdempotencyKey],
  });
  registerCupPlayerLevelProjectionRoutes(app as unknown as FastifyInstance, {
    enabled: options.config.CUP_PLAYER_LEVEL_PROJECTION_ENABLED,
    ...(options.config.CUP_PLAYER_LEVEL_PROJECTION_TOKEN
      ? { integrationToken: options.config.CUP_PLAYER_LEVEL_PROJECTION_TOKEN }
      : {}),
    ...(options.config.CUP_PLAYER_LEVEL_PROJECTION_TENANT_KEY
      ? { authorizedTenantKey: options.config.CUP_PLAYER_LEVEL_PROJECTION_TENANT_KEY }
      : {}),
    ...(options.cupPlayerLevelProjectionRepository
      ? { repository: options.cupPlayerLevelProjectionRepository }
      : {}),
    commandHandlers: [resolvePublicTenant],
  });
  registerParticipationCommandRoutes(app as unknown as FastifyInstance, {
    enabled: options.config.PARTICIPATION_COMMANDS_ENABLED,
    ...(options.config.PARTICIPATION_COMMAND_TOKEN
      ? { integrationToken: options.config.PARTICIPATION_COMMAND_TOKEN }
      : {}),
    ...(options.config.PARTICIPATION_COMMAND_TENANT_KEY
      ? { authorizedTenantKey: options.config.PARTICIPATION_COMMAND_TENANT_KEY }
      : {}),
    ...(options.config.PARTICIPATION_COMMAND_PRINCIPAL_KEY
      ? { principalKey: options.config.PARTICIPATION_COMMAND_PRINCIPAL_KEY }
      : {}),
    authorizationTtlSeconds: options.config.PARTICIPATION_COMMAND_AUTHORIZATION_TTL_SECONDS,
    ...(options.participationCommandRepository
      ? { repository: options.participationCommandRepository }
      : {}),
    commandHandlers: [resolvePublicTenant, requireIdempotencyKey],
    readHandlers: [resolvePublicTenant],
  });
  registerGameResultRoutes(app as unknown as FastifyInstance, {
    ...(options.gameResultRepository ? { repository: options.gameResultRepository } : {}),
    commandHandlers: [authenticate, authorizeGamesPlayer, resolveTenant, requireIdempotencyKey],
  });
  registerGameReadRoutes(app as unknown as FastifyInstance, {
    ...(options.gameReadRepository ? { repository: options.gameReadRepository } : {}),
    ...(options.profilePhotoMediaRepository
      ? { photoRepository: options.profilePhotoMediaRepository }
      : {}),
    publicTenantHandlers: [resolvePublicTenant],
    authenticatedTenantHandlers: [authenticate, resolveTenant],
  });
  registerTournamentSummaryRoutes(app as unknown as FastifyInstance, {
    ...(options.tournamentSummarySource ? { source: options.tournamentSummarySource } : {}),
    avatarMedia: eventAvatarMedia,
    publicTenantHandlers: [resolvePublicTenant],
    authenticatedTenantHandlers: [authenticate, authorizeGamesPlayer, resolveTenant],
  });
  registerCoachGameSummaryRoutes(app as unknown as FastifyInstance, {
    publicTenantHandlers: [resolvePublicTenant],
  });
  const bookingRecommendationAuthService = options.authService;
  registerBookingRecommendationRoutes(app as unknown as FastifyInstance, {
    ...(options.gameReadRepository?.listRecommendationCardProjections
      ? {
          gameRepository: options.gameReadRepository as Pick<
            GameRepository,
            'listRecommendationCardProjections' | 'listPublicCardProjections'
          >,
        }
      : {}),
    ...(options.locationRepository ? { locationRepository: options.locationRepository } : {}),
    ...(options.bookingPreferencesRepository
      ? { preferencesRepository: options.bookingPreferencesRepository }
      : {}),
    ...(options.profileFriendshipRepository
      ? { friendshipRepository: options.profileFriendshipRepository }
      : {}),
    ...(options.bookingScreenReadJobStore
      ? { clientAssistedJobStore: options.bookingScreenReadJobStore }
      : {}),
    ...(options.eventCatalogSnapshotStore
      ? { eventCatalogSnapshotStore: options.eventCatalogSnapshotStore }
      : {}),
    ...(options.bookingScreenMappingRepository
      ? { bookingScreenMappingRepository: options.bookingScreenMappingRepository }
      : {}),
    ...(options.upcomingBookingsRepository
      ? { upcomingBookingsRepository: options.upcomingBookingsRepository }
      : {}),
    ...(options.profilePhotoMediaRepository
      ? { photoRepository: options.profilePhotoMediaRepository }
      : {}),
    ...(options.exerciseRecommendationSource
      ? { exerciseSource: options.exerciseRecommendationSource }
      : {}),
    ...(options.tournamentSummarySource
      ? { tournamentSource: options.tournamentSummarySource }
      : {}),
    ...(options.exerciseRecommendationSource && bookingRecommendationAuthService
      ? {
          getExerciseAccessToken: async (input: {
            readonly tenantKey: string;
            readonly tenantId: string;
            readonly userId: string;
            readonly sessionId: string;
            readonly correlationId: string;
          }) =>
            (
              await bookingRecommendationAuthService.issueVivaAccessToken({
                tenantKey: input.tenantKey,
                tenantId: input.tenantId,
                userId: input.userId,
                sessionId: input.sessionId,
                correlationId: input.correlationId,
              })
            ).accessToken,
        }
      : {}),
    avatarMedia: eventAvatarMedia,
    publicTenantHandlers: [resolvePublicTenant],
    authenticatedTenantHandlers: [authenticate, authorizeGamesPlayer, resolveTenant],
  });
  registerPromotionEngagementRoutes(app as unknown as FastifyInstance, {
    ...(options.promotionEngagementRepository
      ? { repository: options.promotionEngagementRepository }
      : {}),
    ...(options.promotionEngagementSink ? { sink: options.promotionEngagementSink } : {}),
    commandHandlers: [authenticate, resolveTenant, requireIdempotencyKey],
  });
  registerActivityHistoryRoutes(app as unknown as FastifyInstance, {
    ...(options.activityHistoryRepository ? { repository: options.activityHistoryRepository } : {}),
    ...(options.activityHistoryRefresher ? { refresher: options.activityHistoryRefresher } : {}),
    ...(options.bookingScreenReadJobStore
      ? { clientAssistedJobStore: options.bookingScreenReadJobStore }
      : {}),
    ...(options.activityHistoryProjector ? { projector: options.activityHistoryProjector } : {}),
    providerPageSize: options.config.ACTIVITY_HISTORY_PROVIDER_PAGE_SIZE,
    ...(options.profilePhotoMediaRepository
      ? { photoRepository: options.profilePhotoMediaRepository }
      : {}),
    authenticatedTenantHandlers: [authenticate, resolveTenant],
  });
  registerWebPushRoutes(app as unknown as FastifyInstance, {
    ...(options.notificationEndpointRepository
      ? { repository: options.notificationEndpointRepository }
      : {}),
    ...(options.notificationEndpointCipher ? { cipher: options.notificationEndpointCipher } : {}),
    enabledGlobally: options.config.WEB_PUSH_ENABLED,
    maxEndpointsPerUser: options.config.WEB_PUSH_ENDPOINTS_PER_USER_MAX,
    allowedEndpointOrigins:
      options.config.WEB_PUSH_ALLOWED_ENDPOINT_ORIGINS.split(',').filter(Boolean),
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
  registerLevelEligibilityAdminRoutes(app as unknown as FastifyInstance, {
    ...(options.levelEligibilityPolicyRepository
      ? { repository: options.levelEligibilityPolicyRepository }
      : {}),
    authenticatedTenantHandlers: [authenticateAdmin, resolveTenant],
    commandHandlers: [authenticateAdmin, resolveTenant, requireIdempotencyKey],
  });
  registerGiftCertificateAdminRoutes(app as unknown as FastifyInstance, {
    ...(options.giftCertificateCatalogRepository
      ? { repository: options.giftCertificateCatalogRepository }
      : {}),
    authenticatedTenantHandlers: [authenticateAdmin, resolveTenant],
    commandHandlers: [authenticateAdmin, resolveTenant, requireIdempotencyKey],
  });
  registerLocationRoutes(app as unknown as FastifyInstance, {
    ...(options.locationRepository ? { repository: options.locationRepository } : {}),
    authenticatedTenantHandlers: [authenticate, resolveTenant],
  });
  registerGiftCertificateRoutes(app as unknown as FastifyInstance, {
    ...(options.giftCertificateCatalogRepository
      ? { repository: options.giftCertificateCatalogRepository }
      : {}),
    publicTenantHandlers: [resolvePublicTenant],
    authenticatedTenantHandlers: [authenticate, resolveTenant],
  });
  registerLocationMediaRoutes(app as unknown as FastifyInstance, {
    ...(options.locationMediaRepository ? { repository: options.locationMediaRepository } : {}),
    ...(options.locationMediaStore ? { store: options.locationMediaStore } : {}),
    enabled: options.config.LOCATION_MEDIA_ENABLED,
    maxBytes: options.config.LOCATION_MEDIA_MAX_BYTES,
    parserMaxBytes: Math.max(
      options.config.LOCATION_MEDIA_MAX_BYTES,
      options.config.GIFT_CERTIFICATE_MEDIA_MAX_BYTES,
    ),
    maxDimension: options.config.LOCATION_MEDIA_MAX_DIMENSION,
    webpQuality: options.config.LOCATION_MEDIA_WEBP_QUALITY,
    authenticatedTenantHandlers: [authenticateAdmin, resolveTenant],
    commandHandlers: [authenticateAdmin, resolveTenant, requireIdempotencyKey],
    publicTenantHandlers: [resolvePublicTenant],
  });
  registerProfilePhotoMediaRoutes(app as unknown as FastifyInstance, {
    ...(options.profilePhotoMediaRepository
      ? { repository: options.profilePhotoMediaRepository }
      : {}),
    ...(options.profilePhotoMediaStore ? { store: options.profilePhotoMediaStore } : {}),
    maxBytes: options.config.PROFILE_PHOTO_MAX_BYTES,
    maxDimension: options.config.PROFILE_PHOTO_MAX_DIMENSION,
    webpQuality: options.config.PROFILE_PHOTO_WEBP_QUALITY,
    previousObjectRetentionSeconds:
      options.config.PROFILE_PHOTO_URL_TTL_SECONDS +
      options.config.HOME_PROJECTION_MAX_STALE_SECONDS +
      60,
    clientSyncEnabled: options.config.PROFILE_PHOTO_CLIENT_SYNC_ENABLED,
    commandHandlers: [authenticate, resolveTenant, requireIdempotencyKey],
    grantIssuer: options.config.JWT_ISSUER,
    grantAudience: options.config.JWT_AUDIENCE,
    grantSecret: options.config.JWT_ACCESS_SECRET,
  });
  registerCommunityLogoMediaRoutes(app as unknown as FastifyInstance, {
    ...(options.communityLogoMediaRepository
      ? { repository: options.communityLogoMediaRepository }
      : {}),
    ...(options.profilePhotoMediaStore ? { store: options.profilePhotoMediaStore } : {}),
  });
  registerGiftCertificateMediaRoutes(app as unknown as FastifyInstance, {
    ...(options.giftCertificateMediaRepository
      ? { repository: options.giftCertificateMediaRepository }
      : {}),
    ...(options.giftCertificateMediaStore ? { store: options.giftCertificateMediaStore } : {}),
    enabled: options.config.GIFT_CERTIFICATE_MEDIA_ENABLED,
    maxBytes: options.config.GIFT_CERTIFICATE_MEDIA_MAX_BYTES,
    maxDimension: options.config.GIFT_CERTIFICATE_MEDIA_MAX_DIMENSION,
    webpQuality: options.config.GIFT_CERTIFICATE_MEDIA_WEBP_QUALITY,
    authenticatedTenantHandlers: [authenticateAdmin, resolveTenant],
    commandHandlers: [authenticateAdmin, resolveTenant, requireIdempotencyKey],
    publicTenantHandlers: [resolvePublicTenant],
  });
  registerGiftCertificateSaleRoutes(app as unknown as FastifyInstance, {
    ...(options.giftCertificateSaleRepository
      ? { repository: options.giftCertificateSaleRepository }
      : {}),
    ...(options.giftCertificateIssuanceRepository
      ? { issuanceRepository: options.giftCertificateIssuanceRepository }
      : {}),
    ...(options.giftCertificateArtifactStore
      ? { artifactStore: options.giftCertificateArtifactStore }
      : {}),
    artifactsEnabled: options.config.GIFT_CERTIFICATE_ISSUANCE_ENABLED,
    sandboxEnabled: options.config.GIFT_CERTIFICATE_PAYMENT_MODE === 'sandbox',
    purchaseSecret: options.config.JWT_REFRESH_SECRET,
    secureCookies: options.config.AUTH_COOKIE_SECURE,
    publicTenantHandlers: [resolvePublicTenant],
    publicCommandHandlers: [resolvePublicTenant, requireIdempotencyKey],
    authenticatedTenantHandlers: [authenticate, resolveTenant],
    authenticatedCommandHandlers: [authenticate, resolveTenant, requireIdempotencyKey],
  });
  registerProfilePrivacyRoutes(app as unknown as FastifyInstance, {
    ...(options.profilePrivacyRepository ? { repository: options.profilePrivacyRepository } : {}),
    authenticatedTenantHandlers: [authenticate, resolveTenant],
    commandHandlers: [authenticate, resolveTenant, requireIdempotencyKey],
  });
  registerProfileFriendshipRoutes(app as unknown as FastifyInstance, {
    ...(options.profileFriendshipRepository
      ? { repository: options.profileFriendshipRepository }
      : {}),
    authenticatedTenantHandlers: [authenticate, resolveTenant],
    commandHandlers: [authenticate, resolveTenant, requireIdempotencyKey],
  });
  registerProfileLevelHistoryRoutes(app as unknown as FastifyInstance, {
    ...(options.profileLevelHistoryRepository
      ? { repository: options.profileLevelHistoryRepository }
      : {}),
    authenticatedTenantHandlers: [authenticate, resolveTenant],
  });
  registerProfileLevelRoutes(app as unknown as FastifyInstance, {
    ...(options.playerLevelRepository ? { repository: options.playerLevelRepository } : {}),
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

  app.post(
    '/user/api/v1/:tenantKey/routing-outcomes',
    { preHandler: [authenticate, resolveTenant] },
    async (request, reply) => {
      const outcome = directVivaOutcomeSchema.safeParse(request.body);
      if (!outcome.success) {
        return sendApiError(request, reply, 400, 'REQUEST_INVALID', 'Некорректный запрос.');
      }
      request.log.info({ event: 'direct_viva_read_outcome', ...outcome.data });
      return reply.status(204).send();
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
        runtimeCapabilities: userRuntimeCapabilities,
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
        await normalizeProjectedHomeDashboard({
          payload: projection.payload,
          tenantId,
          ...(options.profilePhotoMediaRepository
            ? { photoRepository: options.profilePhotoMediaRepository }
            : {}),
        }),
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
      const shouldResolveDirectChatRuntime =
        targetUserId !== viewerUserId &&
        permissions.includes('chat.direct.create') &&
        privacyPolicy?.chatPolicy !== 'NOBODY';
      const messagingRuntime = shouldResolveDirectChatRuntime
        ? await options.messagingRepository?.getRuntimeSettings(tenantId)
        : undefined;
      const directChatEnabled = Boolean(
        messagingRuntime?.httpEnabled && messagingRuntime.directEnabled,
      );

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
          directChatEnabled,
          ...(privacyPolicy ? { policy: privacyPolicy } : {}),
        });
      }

      const projection = await options.homeDashboardRepository?.get(tenantId, targetUserId);
      if (!projection) {
        const summary =
          targetUserId === viewerUserId
            ? undefined
            : await options.profileSummaryRepository?.get(tenantId, targetUserId);
        if (summary) {
          const names = profileNameParts(summary.displayName);
          const deliveryIds = options.profilePhotoMediaRepository
            ? await options.profilePhotoMediaRepository.getPhotoDeliveryIds(tenantId, [
                summary.userId,
              ])
            : new Map<string, string>();
          reply.header('Cache-Control', 'private, max-age=15, stale-while-revalidate=45');
          return buildPlayerProfileView({
            profile: {
              userId: summary.userId,
              displayName: summary.displayName,
              firstName: names.firstName,
              lastName: names.lastName,
              avatarUrl: stableProfilePhotoUrl({
                tenantId,
                userId: summary.userId,
                currentUrl: summary.avatarUrl,
                deliveryIds,
              }) as string | null,
              balanceMinor: 0,
              currency: 'RUB',
              level: profileLevel(summary.levelLabel),
            },
            viewerUserId,
            permissions,
            directChatEnabled,
            ...(privacyPolicy ? { policy: privacyPolicy } : {}),
          });
        }
        return sendApiError(request, reply, 404, 'PROFILE_NOT_FOUND', 'Профиль игрока не найден.');
      }
      const parsedDashboard = homeDashboardSchema.safeParse(
        await normalizeProjectedHomeDashboard({
          payload: projection.payload,
          tenantId,
          ...(options.profilePhotoMediaRepository
            ? { photoRepository: options.profilePhotoMediaRepository }
            : {}),
        }),
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
        directChatEnabled,
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

      if (options.upcomingBookingsRepository) {
        const projection = await options.upcomingBookingsRepository.get(tenantId, userId);
        if (!projection) {
          return sendApiError(
            request,
            reply,
            503,
            'BOOKINGS_PROJECTION_NOT_READY',
            'Записи ещё не подготовлены.',
          );
        }
        const staleAt = Date.parse(projection.staleAt);
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
        return {
          version: projection.version,
          generatedAt: projection.generatedAt,
          staleAt: projection.staleAt,
          items: projection.items,
        };
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
        await normalizeProjectedHomeDashboard({
          payload: projection.payload,
          tenantId,
          ...(options.profilePhotoMediaRepository
            ? { photoRepository: options.profilePhotoMediaRepository }
            : {}),
        }),
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
        await normalizeProjectedHomeDashboard({
          payload: projection.payload,
          tenantId,
          ...(options.profilePhotoMediaRepository
            ? { photoRepository: options.profilePhotoMediaRepository }
            : {}),
        }),
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

  app.get(
    '/user/api/v1/:tenantKey/home/base',
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
      let projection = await options.homeBaseRepository?.get(tenantId, userId);
      if (!projection && options.homeBaseProjector) {
        try {
          await options.homeBaseProjector({
            tenantId,
            userId,
            correlationId: correlationIdFromHeader(request),
          });
          projection = await options.homeBaseRepository?.get(tenantId, userId);
        } catch (error) {
          request.log.warn(
            { err: error, tenantId, userId },
            'on-demand HomeBase projection failed',
          );
        }
      }
      if (!projection) {
        return sendApiError(
          request,
          reply,
          503,
          'HOME_BASE_PROJECTION_NOT_READY',
          'Базовые данные главной страницы ещё не подготовлены.',
        );
      }

      let homeBase: HomeBase;
      try {
        homeBase = normalizeHomeBaseFreshness(
          projection.payload,
          new Date(),
          options.config.HOME_PROJECTION_MAX_STALE_SECONDS,
        );
      } catch (error) {
        request.log.error(
          {
            err: error,
            tenantId,
            userId,
            sourceRevision: projection.sourceRevision,
          },
          'invalid HomeBase projection rejected',
        );
        return sendApiError(
          request,
          reply,
          503,
          'HOME_BASE_PROJECTION_INVALID',
          'Базовые данные главной страницы временно недоступны.',
        );
      }
      if (
        !homeBaseSchema.safeParse(homeBase).success ||
        homeBase.snapshot.source !== 'LOCAL_PROJECTION' ||
        homeBase.snapshot.completeness !== 'PARTIAL' ||
        homeBase.snapshot.version !== projection.snapshotVersion ||
        Date.parse(homeBase.snapshot.generatedAt) !== Date.parse(projection.generatedAt) ||
        homeBase.viewerUserId !== userId
      ) {
        return sendApiError(
          request,
          reply,
          503,
          'HOME_BASE_PROJECTION_INVALID',
          'Базовые данные главной страницы временно недоступны.',
        );
      }
      reply.header('Cache-Control', 'private, no-store');
      return homeBase;
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
