import { createMonthlyPurchaseRuntime } from './subscriptions/monthly-purchase-runtime.js';
import { createMonthlyPurchaseRepository } from '@phub/database/subscription-purchase';
import { MonthlyPurchaseOwnerClient } from '@phub/subscription-runtime-adapter';
import { createTournamentChatOwner } from './tournaments/tournament-chat-owner-client.js';
import { createOrganizerProfileLookup } from './tournaments/organizer-profile-lookup-runtime.js';
import { createCommunityActorToken } from './communities/community-actor-token.js';
import { createQuarterCreateRepository } from '@phub/database/quarter-create';
import { QuarterCreateOwnerClient } from '@phub/subscription-runtime-adapter';
import { createQuarterCreateRuntime } from './games/game-quarter-create-runtime.js';
import { createTournamentLocalRepository } from '@phub/database';
import { createParticipationLevelGate } from '@phub/database/participation-level-gate';
import { createExternalLevelCheck } from './eligibility/external-level-check.js';
import { TournamentLocalOwnerClient } from '@phub/legacy-games-adapter';
import { createTournamentLocalRuntime } from './tournaments/tournament-local-runtime.js';
import { createStationMembershipTransport } from '@phub/subscription-runtime-adapter';
import { createTrainingCatalogueSource } from './bookings/training-catalogue-source.js';
import { createTrainingRegistrationRepository } from '@phub/database/training-registration';
import { TrainingRegistrationOwnerClient } from '@phub/subscription-runtime-adapter';
import { createTrainingRegistrationRuntime } from './bookings/training-registration-runtime.js';
import { createManagedSelfLeaveRuntime } from './games/game-managed-self-leave.js';
import { createNotificationScenarioRepository } from '@phub/database/notification-scenarios';
import type { IdentityProviderKey, IdentityProviderPort } from '@phub/auth';
import { RedisPasswordLoginLimiter } from './auth/password-login-limiter.js';
import { loadConfig, runtimeContourTargetFingerprint } from '@phub/config';
import {
  createAdminNotificationRepository,
  createActivityHistoryRepository,
  createBookingPreferencesRepository,
  createBookingScreenMappingRepository,
  createClientRoutingPlanRepository,
  createCupPlayerLevelProjectionRepository,
  createCommunityLogoMediaRepository,
  createDatabasePool,
  warmDatabasePool,
  createGameRepository,
  createGameTestCourtRepository,
  createGameResultRepository,
  createGiftCertificateCatalogRepository,
  createGiftCertificateIssuanceRepository,
  createGiftCertificateMediaRepository,
  createGiftCertificateSaleRepository,
  createGameRosterRepository,
  createHomeBaseProjectionRepository,
  createHomeDashboardProjectionRepository,
  linkLegacyViewerPhone,
  readLegacyViewerPhone,
  createLegacyGameImportRepository,
  createLegacyGameRosterBridgeRepository,
  createLocationMediaRepository,
  createLocationRepository,
  createLevelEligibilityPolicyRepository,
  createPlayerLevelRepository,
  MESSAGING_MEDIA_MAX_BYTES,
  createMessagingMediaRepository,
  createMessagingModerationRepository,
  createMessagingRepository,
  createNotificationEndpointRepository,
  createNotificationInboxRepository,
  createNotificationPreferenceRepository,
  createParticipationCommandRepository,
  createProfilePrivacyRepository,
  createProfileFriendshipRepository,
  createProfileReachabilityRepository,
  createProfileLevelHistoryRepository,
  createProfileSummaryRepository,
  createPhoneSubjectLinkRepository,
  createPromotionEngagementRepository,
  createRealtimeAuthorizationRepository,
  createTrainerAvatarRepository,
  createUpcomingBookingsRepository,
  createSubscriptionRuntimeActorContextRepository,
  projectHomeBaseUser,
} from '@phub/database';
import { createProfileProviderObservationRepository } from '@phub/database/profile-provider-observation';
import {
  hasVivaProfileMapping,
  linkVivaProfileByVerifiedPhone,
} from '@phub/database/viva-profile-phone-link';
import {
  readVivaSubscriptionSyncProfile,
  recordVivaSubscriptionMappings,
} from '@phub/database/viva-subscription-mapping';
import { createSupportTicketRepository } from '@phub/database/support-tickets';
import { createVivaSubscriptionMappingSync } from './subscriptions/viva-subscription-mapping-sync.js';
import { createContactReader } from '@phub/database/contacts';
import { createLocalPasswordLoginRepository } from '@phub/database/password-login';
import {
  LegacyGamesMongoAdapter,
  LegacyGamesPublicAdapter,
  LegacyTournamentResultAdapter,
  LegacyTournamentSummaryAdapter,
} from '@phub/legacy-games-adapter';
import { notificationReceiptSecret } from '@phub/notifications';
import { createRuntimeNotificationEndpointCipher } from './notifications/runtime-endpoint-cipher.js';
import { createLogger, recordLevelEligibilityMetrics, startTelemetry } from '@phub/observability';
import {
  VivaHomeSourceAdapter,
  VivaIdentityProvider,
  VivaExerciseRecommendationSourceAdapter,
  VivaClientPhoneLookupAdapter,
  VivaClientSubscriptionMappingError,
  VivaClientSubscriptionMappingSource,
  VivaResidencySourceAdapter,
  VivaClientAdminReadSource,
} from '@phub/viva-adapter';
import {
  ManagedSubscriptionRuntimeQuoteClient,
  SubscriptionPolicyRegistryClient,
} from '@phub/subscription-runtime-adapter';
import Redis from 'ioredis';

import { buildApp } from './app.js';
import { ClientResidencyService } from './residency/client-residency-service.js';
import { createGameJoinConditionsRuntime } from './games/game-join-conditions-runtime.js';
import { createLk1OwnedSubscriptionReader } from './games/lk1-owned-subscription-reader.js';
import { createProviderAccountMappingRepository } from '../../../packages/database/src/provider-account-mapping-repository.js';
import { ProviderAccountOwnerClient } from '../../../packages/subscription-runtime-adapter/src/provider-account-attestation.js';
import { createGameCommercialJoinRuntime } from './games/game-commercial-join-runtime.js';
import { createGameCommercialCreateRuntime } from './games/game-create-commercial-runtime.js';
import { createGameJoinConditionsContextRepository } from '../../../packages/database/src/game-join-conditions-context-repository.js';
import { createResidencyRepository } from '../../../packages/database/src/residency-repository.js';
import { ActivityHistoryProjectionCoordinator } from './bookings/activity-history-refresh.js';
import { ActivityHistoryGameBackfill } from './bookings/activity-history-game-backfill.js';
import { LegacyViewerAssociationProof } from './profile/legacy-viewer-association-proof.js';
import { RedisBookingScreenReadJobStore } from './bookings/booking-screen-read-job-store.js';
import { RedisProfileProviderReadJobStore } from './profile/profile-read-job-store.js';
import { RedisEventCatalogSnapshotStore } from './bookings/event-catalog-snapshot-store.js';
import { RedisRealtimeTicketIssuer } from './messaging/realtime-ticket-issuer.js';
import type { EventCatalogItem } from './bookings/booking-recommendation-routes.js';
import { getViewerGameCardBatch, listViewerGameCards } from './games/game-card-queries.js';
import { CupLegacyLkIdentityVerifier } from './games/legacy-lk-identity-verifier.js';
import { S3GiftCertificateMediaStore } from './gift-certificates/gift-certificate-media-store.js';
import { S3GiftCertificateArtifactReadStore } from './gift-certificates/gift-certificate-artifact-store.js';
import { S3LocationMediaStore } from './locations/location-media-store.js';
import { S3ProfilePhotoMediaStore } from './profile/profile-photo-media-store.js';
import { S3CommunityMediaObjectStore } from './communities/community-media-object-store.js';
import { S3MessagingMediaObjectStore } from './messaging/messaging-media-object-store.js';
import {
  STATION_SUPPORT_MEDIA_MAX_BYTES,
  S3StationSupportMediaStore,
} from './support/station-support-media.js';
import { AuthService } from './auth/auth-service.js';
import { RedisAuthChallengeStore } from './auth/challenge-store.js';
import { RedisSubjectLinkChallengeStore } from './auth/subject-link-challenge-store.js';
import { PhoneSubjectLinkService } from './auth/phone-subject-link-service.js';
import { RedisVivaOAuthStateStore } from './auth/oauth-state-store.js';
import { RedisAndroidOAuthStore } from './auth/android-oauth-store.js';
import {
  createCommunityContentModerationRuntime,
  createCommunityContentRuntime,
  createCommunityCreateRuntime,
  createCommunityDirectInviteRuntime,
  createCommunityDirectoryRuntime,
  createCommunityEventRecoveryRuntime,
  createCommunityMediaRuntime,
  createCommunityMembershipLifecycleRuntime,
  createCommunityMembershipPinRuntime,
  createCommunityOwnershipTransferRuntime,
  createCommunityReadExperienceRuntime,
  createStationMessageRuntime,
  createStationStreamRuntime,
  createCommunityReadRuntime,
} from './communities/community-runtime.js';
import { PostgresAuthRepository } from './auth/postgres-auth-repository.js';
import { LegacyPromotionEngagementSink } from './promotions/legacy-promotion-engagement-sink.js';
import { LegacyStationSupportClient } from './support/station-support-provider.js';
import { createStationSupportRepository } from './support/station-support-repository.js';
import { S3TrainerAvatarMediaStore } from './trainer-avatar-media-store.js';
import { SubscriptionRuntimeActorDelegationIssuer } from './subscriptions/subscription-runtime-actor-delegation-issuer.js';

const config = loadConfig();
const runtimeContourAttestation = config.LOCAL_RUNTIME_CONTOUR_ATTESTATION
  ? {
      database: runtimeContourTargetFingerprint(config.DATABASE_URL),
      redis: runtimeContourTargetFingerprint(config.REDIS_URL),
    }
  : undefined;
const logger = createLogger('api', config.LOG_LEVEL, process.env.RELEASE);
const clientMediaRollbackCapability = 'phub.client-media-rollback.v1';
const communityLogoRollbackCapability = 'phub.community-logo-rollback.v1';
logger.info(
  { capabilities: [clientMediaRollbackCapability, communityLogoRollbackCapability] },
  'API capabilities configured',
);
const telemetry = startTelemetry({
  serviceName: 'api',
  serviceNamespace: config.OTEL_SERVICE_NAMESPACE,
  ...(config.OTEL_EXPORTER_OTLP_ENDPOINT ? { endpoint: config.OTEL_EXPORTER_OTLP_ENDPOINT } : {}),
});
const pool = createDatabasePool(config.DATABASE_URL, { max: config.DATABASE_POOL_MAX });
await warmDatabasePool(pool, config.DATABASE_POOL_WARM_CONNECTIONS, config.DATABASE_POOL_MAX);
logger.info(
  {
    databasePoolMax: config.DATABASE_POOL_MAX,
    databasePoolWarmConnections: config.DATABASE_POOL_WARM_CONNECTIONS,
  },
  'database pool warmed before API readiness',
);
const clientRoutingPlanRepository = createClientRoutingPlanRepository(pool);
const notificationEndpointCipher = createRuntimeNotificationEndpointCipher(config);
// The Worker derives the same value from the same keyring, so a receipt token needs no shared session
// and no new configuration key.
const notificationReceiptKey =
  config.WEB_PUSH_ENABLED && config.NOTIFICATION_ENDPOINT_ENCRYPTION_KEYS
    ? notificationReceiptSecret({
        serializedKeys: config.NOTIFICATION_ENDPOINT_ENCRYPTION_KEYS,
        activeKeyId: config.NOTIFICATION_ENDPOINT_ACTIVE_KEY_ID,
      })
    : undefined;
const redis = new Redis(config.REDIS_URL, {
  enableOfflineQueue: false,
  maxRetriesPerRequest: 1,
});
const vivaIdentityProvider = new VivaIdentityProvider({
  mode: config.VIVA_MODE,
  baseUrl: config.VIVA_AUTH_BASE_URL,
  oauthScopes: config.VIVA_OAUTH_SCOPES,
  realm: config.VIVA_AUTH_REALM,
  clientId: config.VIVA_AUTH_CLIENT_ID,
  channel: config.VIVA_AUTH_CHANNEL,
  timeoutMs: config.VIVA_TIMEOUT_MS,
  devPhoneE164: config.AUTH_DEV_PHONE_E164,
  devExtraPhonesE164: config.AUTH_DEV_EXTRA_PHONES_E164,
  devOtpCode: config.AUTH_DEV_OTP_CODE,
  allowExistingSubjectOAuthBootstrap: config.VIVA_OAUTH_EXISTING_SUBJECT_BOOTSTRAP_ENABLED,
  allowSubjectOAuthProvisioning: config.VIVA_OAUTH_SUBJECT_PROVISIONING_ENABLED,
  onMetric: (metric) => logger.info({ metric }, 'identity provider operation'),
});
const providers = new Map<IdentityProviderKey, IdentityProviderPort>([
  [vivaIdentityProvider.key, vivaIdentityProvider],
]);
const legacyViewerIdentityLink = config.CUP_IDENTITY_PROFILE_LINK_ENABLED
  ? (() => {
      // One adapter per provider tenant key: the end-user profile URL carries the tenant the viewer
      // authenticated against, so a single config default would read the wrong tenant's profile.
      const adapters = new Map<string, VivaHomeSourceAdapter>();
      const adapterFor = (providerTenantKey: string): VivaHomeSourceAdapter => {
        const existing = adapters.get(providerTenantKey);
        if (existing) return existing;
        const created = new VivaHomeSourceAdapter({
          mode: config.VIVA_MODE,
          apiBaseUrl: config.VIVA_END_USER_API_URL,
          tenantKey: providerTenantKey,
          timeoutMs: config.VIVA_TIMEOUT_MS,
          onMetric: (metric) => logger.info({ metric }, 'provider viewer phone read'),
        });
        adapters.set(providerTenantKey, created);
        return created;
      };
      return {
        enabled: true,
        readViewerPhone: (input: {
          readonly accessToken: string;
          readonly correlationId: string;
          readonly providerTenantKey: string;
        }) => adapterFor(input.providerTenantKey).readViewerPhone(input),
        readLinkedPhone: (input: { readonly tenantId: string; readonly userId: string }) =>
          readLegacyViewerPhone({ pool, ...input }),
        refreshDelegation: (input: {
          readonly refreshToken: string;
          readonly correlationId: string;
        }) => vivaIdentityProvider.refreshUserDelegation(input),
        linkPhone: (input: {
          readonly tenantId: string;
          readonly userId: string;
          readonly phoneE164: string | undefined;
          readonly fetchedAt: string;
        }) => linkLegacyViewerPhone({ pool, ...input }),
        onOutcome: (outcome: string) =>
          logger.info({ outcome }, 'legacy viewer identity link completed'),
      };
    })()
  : undefined;
const providerIdentityLink = config.CUP_IDENTITY_CLIENT_PHONE_SYNC_ENABLED
  ? {
      linkProviderPhone: (input: {
        readonly tenantId: string;
        readonly userId: string;
        readonly phoneE164: string;
        readonly fetchedAt: string;
      }) => linkLegacyViewerPhone({ pool, ...input }),
    }
  : undefined;

// ADR 0029 D5: config validation guarantees sandbox/production mode and Admin credentials here.
const vivaProfilePhoneLink = config.VIVA_PROFILE_PHONE_LINK_ENABLED
  ? (() => {
      const lookup = new VivaClientPhoneLookupAdapter({
        mode: config.VIVA_MODE,
        apiBaseUrl: config.VIVA_API_URL as string,
        apiKey: config.VIVA_API_KEY as string,
        // Runs inside the login request: keep each GET short and do not retry.
        timeoutMs: Math.min(config.VIVA_TIMEOUT_MS, 2_000),
        maxAttempts: 1,
        circuitFailureThreshold: 3,
        circuitResetMs: 60_000,
        onMetric: (metric) => logger.info({ metric }, 'Viva client phone lookup'),
      });
      return {
        enabled: true,
        hasMapping: (input: { readonly tenantId: string; readonly userId: string }) =>
          hasVivaProfileMapping({ pool, ...input }),
        lookup: (input: { readonly phoneE164: string; readonly correlationId: string }) =>
          lookup.lookup(input),
        link: (input: {
          readonly tenantId: string;
          readonly userId: string;
          readonly providerClientId: string;
          readonly correlationId: string;
        }) => linkVivaProfileByVerifiedPhone({ pool, ...input }),
        onOutcome: (outcome: string) => logger.info({ outcome }, 'Viva profile phone link'),
      };
    })()
  : undefined;

// ADR 0029 D5: config validation guarantees sandbox/production mode and Admin credentials here.
const vivaSubscriptionMappingSync = config.VIVA_SUBSCRIPTION_MAPPING_SYNC_ENABLED
  ? (() => {
      const source = new VivaClientSubscriptionMappingSource({
        mode: config.VIVA_MODE,
        apiBaseUrl: config.VIVA_API_URL as string,
        apiKey: config.VIVA_API_KEY as string,
        // Runs inside the login request after the profile link: short GETs, one retry at most.
        timeoutMs: Math.min(config.VIVA_TIMEOUT_MS, 2_000),
        maxAttempts: 2,
        circuitFailureThreshold: 3,
        circuitResetMs: 60_000,
        onMetric: (metric) => logger.info({ metric }, 'Viva client subscriptions read'),
      });
      return {
        enabled: true,
        sync: createVivaSubscriptionMappingSync({
          readProfile: (input) => readVivaSubscriptionSyncProfile({ pool, ...input }),
          readSubscriptions: (input) => source.read(input),
          record: (input) => recordVivaSubscriptionMappings({ pool, ...input }),
          isOwnershipConflict: (error) =>
            error instanceof VivaClientSubscriptionMappingError &&
            error.code === 'CLIENT_SUBSCRIPTIONS_OWNERSHIP_CONFLICT',
        }),
        onOutcome: (outcome: string) => logger.info({ outcome }, 'Viva subscription mapping sync'),
      };
    })()
  : undefined;

const authRepository = new PostgresAuthRepository(pool);
const authService = new AuthService({
  config,
  repository: authRepository,
  localPasswordRepository: createLocalPasswordLoginRepository(pool),
  passwordLoginLimiter: new RedisPasswordLoginLimiter(redis, config.JWT_REFRESH_SECRET),
  challengeStore: new RedisAuthChallengeStore(redis),
  vivaOAuthProvider: vivaIdentityProvider,
  vivaOAuthStateStore: new RedisVivaOAuthStateStore(redis),
  androidOAuthStore: new RedisAndroidOAuthStore(redis),
  providers,
  onClientAccessConvergenceFailure: ({ tenantId, userId, correlationId }) =>
    logger.warn(
      { tenantId, userId, correlationId },
      'beta client access convergence could not be written; the token keeps the stored profile',
    ),
  ...(legacyViewerIdentityLink ? { legacyViewerIdentityLink } : {}),
  ...(vivaProfilePhoneLink ? { vivaProfilePhoneLink } : {}),
  ...(vivaSubscriptionMappingSync ? { vivaSubscriptionMappingSync } : {}),
});
// Trusted tenant bindings only; keep circuit state across requests and bound cache cardinality.
const trainingCatalogueAdapters = new Map<string, VivaExerciseRecommendationSourceAdapter>();
const trainingCatalogueSource =
  config.GAMES_READ_ENABLED && ['sandbox', 'production'].includes(config.VIVA_MODE)
    ? createTrainingCatalogueSource({
        access: (actor) => authService.issueTrainingCatalogueAccess(actor),
        adapter: (providerTenantKey) => {
          const existing = trainingCatalogueAdapters.get(providerTenantKey);
          if (existing) return existing;
          if (trainingCatalogueAdapters.size >= 64)
            throw new Error('TRAINING_CATALOGUE_UNAVAILABLE');
          const adapter = new VivaExerciseRecommendationSourceAdapter({
            mode: config.VIVA_MODE,
            apiBaseUrl: config.VIVA_END_USER_API_URL,
            providerTenantKey,
            timeoutMs: Math.min(config.VIVA_TIMEOUT_MS, 2_500),
            maxAttempts: 1,
            onMetric: (metric) => logger.info({ metric }, 'training catalogue provider read'),
          });
          trainingCatalogueAdapters.set(providerTenantKey, adapter);
          return adapter;
        },
      })
    : undefined;
const phoneSubjectLinkService = new PhoneSubjectLinkService({
  config,
  repository: createPhoneSubjectLinkRepository(pool),
  authRepository,
  challengeStore: new RedisSubjectLinkChallengeStore(redis),
  vivaProvider: vivaIdentityProvider,
});
const activityHistoryRepository = config.ACTIVITY_HISTORY_ENABLED
  ? createActivityHistoryRepository(pool)
  : undefined;
const gameRepository =
  config.GAMES_READ_ENABLED || config.GAMES_COMMANDS_ENABLED
    ? createGameRepository(pool, { testCourtsEnabled: config.GAMES_TEST_COURTS_ENABLED })
    : undefined;
const gameReadRepository = config.GAMES_READ_ENABLED ? gameRepository : undefined;
const gameCommandRepository = config.GAMES_COMMANDS_ENABLED ? gameRepository : undefined;
const gameTestCourtRepository = createGameTestCourtRepository(
  pool,
  config.GAMES_TEST_COURTS_ENABLED,
);
const tournamentSummarySource = config.GAMES_READ_ENABLED
  ? new LegacyTournamentSummaryAdapter({
      baseUrl: config.LEGACY_GAMES_PUBLIC_BASE_URL,
      timeoutMs: Math.max(config.VIVA_TIMEOUT_MS, 8_000),
      freshTtlMs: 60_000,
      staleTtlMs: 600_000,
      circuitFailureThreshold: 3,
      circuitResetMs: 30_000,
      onMetric: (metric) => logger.info({ metric }, 'legacy tournament summary read'),
    })
  : undefined;
const profileSummaryRepository = createProfileSummaryRepository(pool);
const residencyRepository = createResidencyRepository(pool);
const residencySource =
  (config.VIVA_MODE === 'sandbox' || config.VIVA_MODE === 'production') &&
  Boolean(config.VIVA_API_URL) &&
  Boolean(config.VIVA_API_KEY)
    ? new VivaResidencySourceAdapter({
        mode: config.VIVA_MODE,
        apiBaseUrl: config.VIVA_API_URL as string,
        apiKey: config.VIVA_API_KEY as string,
        productId: config.VIVA_RESIDENCY_PRODUCT_ID,
        timeoutMs: config.VIVA_TIMEOUT_MS,
        maxAttempts: 2,
        circuitFailureThreshold: 3,
        circuitResetMs: 30_000,
        onMetric: (metric) => logger.info({ metric }, 'Viva residency read'),
      })
    : undefined;
const userVivaAdminSource =
  (config.VIVA_MODE === 'sandbox' || config.VIVA_MODE === 'production') &&
  Boolean(config.VIVA_API_URL) &&
  Boolean(config.VIVA_API_KEY)
    ? new VivaClientAdminReadSource({
        mode: config.VIVA_MODE,
        apiBaseUrl: config.VIVA_API_URL as string,
        apiKey: config.VIVA_API_KEY as string,
        timeoutMs: Math.max(config.VIVA_TIMEOUT_MS, 5_000),
        maxAttempts: 2,
        circuitFailureThreshold: 5,
        circuitResetMs: 30_000,
        onMetric: (metric) => logger.info({ metric }, 'Viva client admin read'),
      })
    : undefined;
const clientResidencyService = new ClientResidencyService({
  productConfigured: Boolean(config.VIVA_RESIDENCY_PRODUCT_ID),
  ...(residencySource
    ? { source: residencySource }
    : {
        sourceUnavailableReason:
          config.VIVA_MODE === 'mock' || config.VIVA_MODE === 'disabled'
            ? ('SOURCE_DISABLED' as const)
            : ('SOURCE_NOT_CONFIGURED' as const),
      }),
  resolveVivaClientId: (input) => residencyRepository.resolveVivaClientId(input),
  profileRepository: profileSummaryRepository,
  photoRepository: profileSummaryRepository,
  onMetric: (metric) => logger.info({ metric }, 'client residency read'),
});
const gameRosterRepository = config.GAMES_COMMANDS_ENABLED
  ? createGameRosterRepository(pool, {
      testCourtsEnabled: config.GAMES_TEST_COURTS_ENABLED,
      onEligibilityDecision: (decision) => {
        recordLevelEligibilityMetrics({
          tenant: decision.tenantId,
          sport: decision.sportId,
          activityType: decision.activityType,
          mode: decision.mode,
          outcome: decision.outcome,
          reasonCode: decision.reasonCode,
          constraintSource: decision.constraintSource,
          action: decision.action,
        });
        logger.info({ eligibility: decision }, 'participation eligibility evaluated');
      },
    })
  : undefined;
const participationCommandRepository = createParticipationCommandRepository(pool, {
  onDecision: (decision) => {
    recordLevelEligibilityMetrics({
      tenant: decision.tenantId,
      sport: decision.sportId,
      activityType: decision.activityType,
      mode: decision.mode,
      outcome: decision.outcome,
      reasonCode: decision.reasonCode,
      constraintSource: decision.constraintSource,
      action: decision.action,
    });
    logger.info({ eligibility: decision }, 'participation command eligibility evaluated');
  },
});
const legacyLkIdentityVerifier = config.LEGACY_GAME_COMMAND_BRIDGE_ENABLED
  ? new CupLegacyLkIdentityVerifier({
      url: config.LEGACY_GAME_IDENTITY_VERIFY_URL as string,
      integrationToken: config.LEGACY_GAME_IDENTITY_VERIFY_TOKEN as string,
      timeoutMs: config.LEGACY_GAME_IDENTITY_VERIFY_TIMEOUT_MS,
    })
  : undefined;
const tournamentResultSource =
  config.GAMES_READ_ENABLED && config.ACTIVITY_HISTORY_SYNC_ENABLED
    ? new LegacyTournamentResultAdapter({
        baseUrl: config.LEGACY_GAMES_PUBLIC_BASE_URL,
        timeoutMs: Math.min(Math.max(config.VIVA_TIMEOUT_MS, 2_000), 5_000),
        maxAttempts: 2,
        freshTtlMs: 60_000,
        staleTtlMs: 600_000,
        circuitFailureThreshold: 3,
        circuitResetMs: 30_000,
        onMetric: (metric) => logger.info({ metric }, 'legacy tournament result read'),
      })
    : undefined;
const bookingScreenMappingRepository = createBookingScreenMappingRepository(pool);
const promotionEngagementSink = config.PROMOTIONS_ENGAGEMENT_SECRET
  ? new LegacyPromotionEngagementSink({
      baseUrl: config.PROMOTIONS_LEGACY_BASE_URL,
      secret: config.PROMOTIONS_ENGAGEMENT_SECRET,
      timeoutMs: config.PROMOTIONS_LEGACY_TIMEOUT_MS,
      maxAttempts: config.PROMOTIONS_LEGACY_MAX_ATTEMPTS,
      circuitFailureThreshold: config.PROMOTIONS_LEGACY_CIRCUIT_FAILURE_THRESHOLD,
      circuitResetMs: config.PROMOTIONS_LEGACY_CIRCUIT_RESET_MS,
      onMetric: (metric) => logger.info({ metric }, 'promotion engagement delivery'),
    })
  : undefined;
const stationSupportProvider =
  config.SUPPORT_STATIONS_ENABLED && config.SUPPORT_LEGACY_BASE_URL
    ? new LegacyStationSupportClient({
        baseUrl: config.SUPPORT_LEGACY_BASE_URL,
        timeoutMs: config.SUPPORT_LEGACY_TIMEOUT_MS,
        maxAttempts: config.SUPPORT_LEGACY_MAX_ATTEMPTS,
        circuitFailureThreshold: config.SUPPORT_LEGACY_CIRCUIT_FAILURE_THRESHOLD,
        circuitResetMs: config.SUPPORT_LEGACY_CIRCUIT_RESET_MS,
        onMetric: (metric) => logger.info({ metric }, 'station support provider operation'),
      })
    : undefined;
const stationSupportRepository = config.SUPPORT_STATIONS_ENABLED
  ? createStationSupportRepository(pool)
  : undefined;
/**
 * Station chat pictures are stored in the same media bucket every other chat contour uses, so they
 * are wired from the shared S3 settings instead of a flag of their own. A deployment without a
 * bucket keeps the station tab text-only.
 */
const stationSupportMediaStore =
  config.SUPPORT_STATIONS_ENABLED &&
  config.S3_ENDPOINT &&
  config.S3_PUBLIC_ENDPOINT &&
  config.S3_BUCKET &&
  config.S3_ACCESS_KEY &&
  config.S3_SECRET_KEY
    ? new S3StationSupportMediaStore({
        endpoint: config.S3_ENDPOINT,
        publicEndpoint: config.S3_PUBLIC_ENDPOINT,
        region: config.S3_REGION,
        bucket: config.S3_BUCKET,
        accessKey: config.S3_ACCESS_KEY,
        secretKey: config.S3_SECRET_KEY,
        forcePathStyle: config.S3_FORCE_PATH_STYLE,
        maxBytes: STATION_SUPPORT_MEDIA_MAX_BYTES,
      })
    : undefined;
/**
 * A provider picture normally arrives inline, but the legacy contour may also link one from its own
 * origin, so that exact host is the only host the bridge is allowed to download from.
 */
const stationSupportMediaAllowedHosts = config.SUPPORT_LEGACY_BASE_URL
  ? [new URL(config.SUPPORT_LEGACY_BASE_URL).hostname]
  : [];
const activityHistoryGameBackfillSource = !config.ACTIVITY_HISTORY_GAME_BACKFILL_ENABLED
  ? undefined
  : config.LEGACY_GAMES_ROSTER_SYNC_SOURCE === 'public'
    ? new LegacyGamesPublicAdapter({
        baseUrl: config.LEGACY_GAMES_PUBLIC_BASE_URL,
        timeoutMs: config.VIVA_TIMEOUT_MS,
      })
    : new LegacyGamesMongoAdapter({
        uri: config.LEGACY_GAMES_MONGODB_URI as string,
        timeoutMs: config.VIVA_TIMEOUT_MS,
        maxAttempts: 2,
        onMetric: (metric) => logger.info({ metric }, 'historical CUP Games read operation'),
      });
const activityHistoryGameBackfill =
  activityHistoryGameBackfillSource && gameReadRepository
    ? new ActivityHistoryGameBackfill({
        tenantKey: config.LEGACY_GAMES_ROSTER_SYNC_TENANT_KEY as string,
        source: activityHistoryGameBackfillSource,
        repository: createLegacyGameImportRepository(pool),
        projectGameCard: (input) => gameReadRepository.projectCardEvent(input),
      })
    : undefined;
/**
 * The provider phone link is the only anchor a client-assisted OAuth account has, so it is also where
 * the saved friend requests addressed to that person's imported legacy rows can be delivered. This
 * proof routes delivery only and never becomes a durable identity binding. It reuses the
 * viewer-scoped legacy read the history backfill capability already enables and stays off with it.
 */
const legacyViewerAssociationProof =
  providerIdentityLink && activityHistoryGameBackfillSource
    ? new LegacyViewerAssociationProof({
        source: activityHistoryGameBackfillSource,
        delivery: createProfileFriendshipRepository(pool),
        legacyTenantKey: config.LEGACY_GAMES_ROSTER_SYNC_TENANT_KEY,
        onOutcome: (outcome, context) =>
          logger.info({ outcome, ...context }, 'legacy viewer association proof completed'),
      })
    : undefined;
const readAllLocalGameHistory = gameReadRepository
  ? async (input: { readonly tenantId: string; readonly userId: string }) => {
      const items: Awaited<ReturnType<typeof listViewerGameCards>>['items'][number][] = [];
      let cursor: string | undefined;
      for (let pageIndex = 0; pageIndex < 100; pageIndex += 1) {
        const page = await listViewerGameCards({
          repository: gameReadRepository,
          photoRepository: profileSummaryRepository,
          tenantId: input.tenantId,
          viewerUserId: input.userId,
          scope: 'HISTORY',
          now: new Date().toISOString(),
          limit: 100,
          ...(cursor ? { cursor } : {}),
        });
        items.push(...page.items);
        if (!page.nextCursor) return items;
        cursor = page.nextCursor;
      }
      throw new Error('ACTIVITY_HISTORY_LOCAL_GAMES_LIMIT_EXCEEDED');
    }
  : undefined;
/**
 * History rows store the game card snapshot taken when they were synced. The list renders the
 * current viewer card instead, so a result submitted after the sync is visible to every roster
 * member without waiting for their own history refresh.
 */
const activityHistoryGameCards = gameReadRepository
  ? async (input: {
      readonly tenantId: string;
      readonly userId: string;
      readonly gameIds: readonly string[];
    }): Promise<ReadonlyMap<string, unknown>> => {
      const cards = await getViewerGameCardBatch({
        repository: gameReadRepository,
        photoRepository: profileSummaryRepository,
        tenantId: input.tenantId,
        viewerUserId: input.userId,
        gameIds: input.gameIds,
        now: new Date().toISOString(),
      });
      return new Map([...cards].map(([gameId, entry]) => [gameId, entry.card]));
    }
  : undefined;
const activityHistoryProjector =
  activityHistoryRepository && config.ACTIVITY_HISTORY_SYNC_ENABLED
    ? new ActivityHistoryProjectionCoordinator({
        repository: activityHistoryRepository,
        freshSeconds: config.ACTIVITY_HISTORY_FRESH_SECONDS,
        ...(activityHistoryGameBackfill
          ? {
              backfillGames: async (input) => {
                const result = await activityHistoryGameBackfill.run(input);
                if (result.matched > 0) {
                  logger.info(
                    {
                      tenantId: input.tenantId,
                      userId: input.userId,
                      correlationId: input.correlationId,
                      ...result,
                    },
                    'historical Games backfill completed before activity projection',
                  );
                }
                return result;
              },
            }
          : {}),
        ...(readAllLocalGameHistory ? { readLocalGames: readAllLocalGameHistory } : {}),
        ...(tournamentResultSource && bookingScreenMappingRepository?.resolveVivaProfileIds
          ? {
              tournamentResultSource,
              resolveTournamentProfileIds: (input: {
                readonly tenantId: string;
                readonly externalClientIds: readonly string[];
              }) => bookingScreenMappingRepository.resolveVivaProfileIds!(input),
            }
          : {}),
      })
    : undefined;
const giftCertificateMediaStore = config.GIFT_CERTIFICATE_MEDIA_ENABLED
  ? new S3GiftCertificateMediaStore({
      endpoint: config.S3_ENDPOINT as string,
      publicEndpoint: config.S3_PUBLIC_ENDPOINT as string,
      region: config.S3_REGION,
      bucket: config.S3_BUCKET as string,
      accessKey: config.S3_ACCESS_KEY as string,
      secretKey: config.S3_SECRET_KEY as string,
      forcePathStyle: config.S3_FORCE_PATH_STYLE,
      autoCreateBucket: config.S3_AUTO_CREATE_BUCKET,
      readUrlTtlSeconds: config.GIFT_CERTIFICATE_MEDIA_URL_TTL_SECONDS,
      timeoutMs: config.GIFT_CERTIFICATE_MEDIA_STORAGE_TIMEOUT_MS,
    })
  : undefined;
const locationMediaStore = config.LOCATION_MEDIA_ENABLED
  ? new S3LocationMediaStore({
      endpoint: config.S3_ENDPOINT as string,
      publicEndpoint: config.S3_PUBLIC_ENDPOINT as string,
      region: config.S3_REGION,
      bucket: config.S3_BUCKET as string,
      accessKey: config.S3_ACCESS_KEY as string,
      secretKey: config.S3_SECRET_KEY as string,
      forcePathStyle: config.S3_FORCE_PATH_STYLE,
      autoCreateBucket: config.S3_AUTO_CREATE_BUCKET,
      readUrlTtlSeconds: config.LOCATION_MEDIA_URL_TTL_SECONDS,
      timeoutMs: config.LOCATION_MEDIA_STORAGE_TIMEOUT_MS,
    })
  : undefined;
const profilePhotoMediaStore =
  config.S3_ENDPOINT && config.S3_BUCKET && config.S3_ACCESS_KEY && config.S3_SECRET_KEY
    ? new S3ProfilePhotoMediaStore({
        endpoint: config.S3_ENDPOINT,
        region: config.S3_REGION,
        bucket: config.S3_BUCKET,
        accessKey: config.S3_ACCESS_KEY,
        secretKey: config.S3_SECRET_KEY,
        forcePathStyle: config.S3_FORCE_PATH_STYLE,
        timeoutMs: config.VIVA_TIMEOUT_MS,
      })
    : undefined;
const trainerAvatarMediaStore =
  config.S3_ENDPOINT && config.S3_BUCKET && config.S3_ACCESS_KEY && config.S3_SECRET_KEY
    ? new S3TrainerAvatarMediaStore({
        endpoint: config.S3_ENDPOINT,
        region: config.S3_REGION,
        bucket: config.S3_BUCKET,
        accessKey: config.S3_ACCESS_KEY,
        secretKey: config.S3_SECRET_KEY,
        forcePathStyle: config.S3_FORCE_PATH_STYLE,
        timeoutMs: config.VIVA_TIMEOUT_MS,
      })
    : undefined;
const giftCertificateArtifactStore = config.GIFT_CERTIFICATE_ISSUANCE_ENABLED
  ? new S3GiftCertificateArtifactReadStore({
      endpoint: config.S3_ENDPOINT as string,
      region: config.S3_REGION,
      bucket: config.S3_BUCKET as string,
      accessKey: config.S3_ACCESS_KEY as string,
      secretKey: config.S3_SECRET_KEY as string,
      forcePathStyle: config.S3_FORCE_PATH_STYLE,
      timeoutMs: config.GIFT_CERTIFICATE_ARTIFACT_STORAGE_TIMEOUT_MS,
    })
  : undefined;
const communityActorToken = createCommunityActorToken(
  async (actor) => (await authService.issueVivaAccessToken(actor)).accessToken,
);
const stationStreamOwner = createStationStreamRuntime({
  config,
  pool,
  token: communityActorToken,
  logger,
});
const tournamentChatOwner = createTournamentChatOwner(config, pool);
const stationMessageOwner = createStationMessageRuntime({
  config,
  pool,
  token: communityActorToken,
});
const communityReadExperienceService = createCommunityReadExperienceRuntime({
  token: communityActorToken,
  config,
  pool,
  logger,
});
const communityMembershipPinService = createCommunityMembershipPinRuntime({ config, pool });
const communityMembershipLifecycleService = createCommunityMembershipLifecycleRuntime({
  config,
  pool,
});
const communityCreateService = createCommunityCreateRuntime({ config, pool });
const communityReadService = createCommunityReadRuntime({ config, pool });
const communityDirectInviteService = createCommunityDirectInviteRuntime({ config, pool });
const communityOwnershipTransferService = createCommunityOwnershipTransferRuntime({ config, pool });
const communityContentService = createCommunityContentRuntime({ config, pool });
const communityContentModerationService = createCommunityContentModerationRuntime({ config, pool });
const communityEventRecoveryService = createCommunityEventRecoveryRuntime({ config, pool });
const chatMediaObjectStore = config.CHAT_MEDIA_ENABLED
  ? new S3MessagingMediaObjectStore({
      endpoint: config.S3_ENDPOINT as string,
      publicEndpoint: config.S3_PUBLIC_ENDPOINT as string,
      region: config.S3_REGION,
      bucket: config.S3_BUCKET as string,
      accessKey: config.S3_ACCESS_KEY as string,
      secretKey: config.S3_SECRET_KEY as string,
      forcePathStyle: config.S3_FORCE_PATH_STYLE,
      autoCreateBucket: config.S3_AUTO_CREATE_BUCKET,
      maxBytes: MESSAGING_MEDIA_MAX_BYTES,
    })
  : undefined;
const communityMediaObjectStore = config.COMMUNITY_MEDIA_ENABLED
  ? new S3CommunityMediaObjectStore({
      endpoint: config.S3_ENDPOINT as string,
      publicEndpoint: config.S3_PUBLIC_ENDPOINT as string,
      region: config.S3_REGION,
      bucket: config.S3_BUCKET as string,
      accessKey: config.S3_ACCESS_KEY as string,
      secretKey: config.S3_SECRET_KEY as string,
      forcePathStyle: config.S3_FORCE_PATH_STYLE,
      autoCreateBucket: config.S3_AUTO_CREATE_BUCKET,
    })
  : undefined;
const communityMediaRuntime = communityMediaObjectStore
  ? createCommunityMediaRuntime({ config, pool, objectStore: communityMediaObjectStore })
  : undefined;
// Independent concrete TRAINING gate: never activates or widens WARN quote/game paths.
const participationLevelGate = createParticipationLevelGate(pool);
const logLevelDecision = (event: Record<string, string>) =>
  logger.info({ eligibility: event }, 'external participation level decision');
const tournamentLevelCheck = createExternalLevelCheck({
  gate: participationLevelGate,
  activityType: 'TOURNAMENT',
  action: 'REGISTER',
  constraintSource: 'LEGACY_TOURNAMENT_SETTINGS',
  // Captured by the fresh registration-date read that immediately precedes this check.
  levelRange: (_actor, id) => Promise.resolve(tournamentSummarySource?.registrationLevelRange(id)),
  onDecision: logLevelDecision,
});
const trainingLevelCheck = createExternalLevelCheck({
  gate: participationLevelGate,
  activityType: 'TRAINING',
  action: 'BOOK',
  constraintSource: 'VIVA_EXERCISE',
  levelRange: async (actor, id, dateHint) => {
    if (!trainingCatalogueSource || !dateHint) return undefined;
    const page = await trainingCatalogueSource.read({
      ...(actor as Parameters<typeof trainingCatalogueSource.read>[0]),
      dates: [dateHint],
    });
    if (!page.completedDates.includes(dateHint)) return undefined;
    const activity = page.activities.find((item) => item.id === id);
    return activity ? activity.levelRange : undefined;
  },
  onDecision: logLevelDecision,
});
const tournamentLocal = createTournamentLocalRuntime({
  enabled: config.TOURNAMENT_LOCAL_COMMANDS_ENABLED,
  repository: createTournamentLocalRepository(pool),
  ...(config.TOURNAMENT_LOCAL_COMMANDS_ENABLED
    ? {
        client: new TournamentLocalOwnerClient({
          identityUrl: config.LEGACY_GAME_IDENTITY_VERIFY_URL!,
          integrationToken: config.LEGACY_GAME_IDENTITY_VERIFY_TOKEN!,
          timeoutMs: config.LEGACY_GAME_IDENTITY_VERIFY_TIMEOUT_MS,
          onMetric: (metric) => logger.info({ metric }, 'CUP local tournament owner operation'),
        }),
        token: async (actor: Parameters<typeof authService.issueVivaAccessToken>[0]) =>
          (await authService.issueVivaAccessToken(actor)).accessToken,
        date: (id: string) => tournamentSummarySource!.resolveRegistrationDate(id),
        levelCheck: tournamentLevelCheck,
      }
    : {}),
});
const trainingRegistration = (() => {
  const repository = createTrainingRegistrationRepository(pool, {
    stationMembershipEnabled:
      config.TRAINING_REGISTRATION_ENABLED && config.LK_STATION_MEMBERSHIP_LIFETIME_ENABLED,
  });
  if (!config.TRAINING_REGISTRATION_ENABLED)
    return createTrainingRegistrationRuntime({ enabled: false, repository });
  const keys = JSON.parse(config.SUBSCRIPTION_RUNTIME_DELEGATION_PRIVATE_KEYS!) as Record<
      string,
      string
    >,
    keyId = config.SUBSCRIPTION_RUNTIME_DELEGATION_ACTIVE_KEY_ID!;
  const issuer = new SubscriptionRuntimeActorDelegationIssuer({
    privateKeyPem: keys[keyId]!,
    keyId,
    issuer: config.SUBSCRIPTION_RUNTIME_DELEGATION_ISSUER!,
    audience: config.SUBSCRIPTION_RUNTIME_DELEGATION_AUDIENCE!,
    ttlSeconds: config.SUBSCRIPTION_RUNTIME_DELEGATION_TTL_SECONDS,
  });
  return createTrainingRegistrationRuntime({
    enabled: true,
    repository,
    issuer,
    client: new TrainingRegistrationOwnerClient({
      baseUrl: config.GAME_COMMERCIAL_JOIN_OWNER_BASE_URL!,
      timeoutMs: config.GAME_COMMERCIAL_JOIN_OWNER_TIMEOUT_MS,
      environment: ['local', 'ci'].includes(config.APP_ENV) ? 'development' : 'production',
    }),
    token: async (actor) => {
      const issued = await authService.issueVivaAccessToken(actor);
      return { token: issued.accessToken, expiresAt: issued.expiresAt };
    },
    stationMembership:
      createStationMembershipTransport(config, (outcome) =>
        logger.info({ outcome }, 'training station membership boundary'),
      ) ?? undefined,
    metric: (outcome) => logger.info({ outcome }, 'training registration boundary'),
    levelCheck: trainingLevelCheck,
  });
})();
const subscriptionRuntimeWarnBoundary = (() => {
  if (config.SUBSCRIPTION_RUNTIME_WARN_MODE !== 'WARN') return undefined;
  const privateKeys = JSON.parse(
    config.SUBSCRIPTION_RUNTIME_DELEGATION_PRIVATE_KEYS as string,
  ) as Record<string, string>;
  const activeKeyId = config.SUBSCRIPTION_RUNTIME_DELEGATION_ACTIVE_KEY_ID as string;
  return {
    actorContextRepository: createSubscriptionRuntimeActorContextRepository(pool),
    delegationIssuer: new SubscriptionRuntimeActorDelegationIssuer({
      privateKeyPem: privateKeys[activeKeyId] as string,
      keyId: activeKeyId,
      issuer: config.SUBSCRIPTION_RUNTIME_DELEGATION_ISSUER as string,
      audience: config.SUBSCRIPTION_RUNTIME_DELEGATION_AUDIENCE as string,
      ttlSeconds: config.SUBSCRIPTION_RUNTIME_DELEGATION_TTL_SECONDS,
    }),
    quoteClient: new ManagedSubscriptionRuntimeQuoteClient({
      enabled: true,
      baseUrl: config.SUBSCRIPTION_RUNTIME_BASE_URL as string,
      integrationToken: config.SUBSCRIPTION_RUNTIME_INTEGRATION_TOKEN as string,
      timeoutMs: config.SUBSCRIPTION_RUNTIME_TIMEOUT_MS,
      circuitFailureThreshold: config.SUBSCRIPTION_RUNTIME_CIRCUIT_FAILURE_THRESHOLD,
      circuitResetMs: config.SUBSCRIPTION_RUNTIME_CIRCUIT_RESET_MS,
      environment: config.APP_ENV === 'local' ? 'development' : 'production',
      onMetric: (metric) =>
        logger.info({ metric }, 'subscription runtime quote boundary operation'),
    }),
  };
})();
const subscriptionPolicyRegistryClient = config.SUBSCRIPTION_POLICY_REGISTRY_ENABLED
  ? new SubscriptionPolicyRegistryClient({
      enabled: true,
      baseUrl: config.SUBSCRIPTION_POLICY_REGISTRY_BASE_URL as string,
      integrationToken: config.SUBSCRIPTION_POLICY_REGISTRY_INTEGRATION_TOKEN as string,
      timeoutMs: config.SUBSCRIPTION_POLICY_REGISTRY_TIMEOUT_MS,
      environment: config.APP_ENV === 'local' ? 'development' : 'production',
      onMetric: (metric) => logger.info({ metric }, 'subscription policy registry read'),
    })
  : undefined;
// ADR 0028: the LK1 owner attests the actor's Viva account; PadlHub egress never reads Viva End
// User data. Composed only with commercial JOIN and the existing actor-delegation key ring.
const providerAccountOwnerClient =
  config.GAME_COMMERCIAL_JOIN_ENABLED &&
  subscriptionRuntimeWarnBoundary &&
  config.GAME_COMMERCIAL_JOIN_OWNER_BASE_URL
    ? new ProviderAccountOwnerClient({
        baseUrl: config.GAME_COMMERCIAL_JOIN_OWNER_BASE_URL,
        timeoutMs: config.GAME_COMMERCIAL_JOIN_OWNER_TIMEOUT_MS,
        environment: ['local', 'ci'].includes(config.APP_ENV) ? 'development' : 'production',
      })
    : undefined;
const providerAccountAttestation =
  providerAccountOwnerClient && subscriptionRuntimeWarnBoundary
    ? {
        client: providerAccountOwnerClient,
        issuer: subscriptionRuntimeWarnBoundary.delegationIssuer,
      }
    : undefined;
const gameJoinConditionsOwner = createGameJoinConditionsRuntime({
  config,
  pool,
  authService,
  ...(providerAccountAttestation
    ? { ownedSubscriptionReader: createLk1OwnedSubscriptionReader(providerAccountAttestation) }
    : {}),
});
// Paid JOIN reaches the existing owner only when the flag, the join-conditions owner and the
// existing actor-delegation material are all composed; otherwise the route keeps GAME_PAYMENT_REQUIRED.
const gameManagedSelfLeave = createManagedSelfLeaveRuntime({
  config,
  pool,
  ...(subscriptionRuntimeWarnBoundary ? { boundary: subscriptionRuntimeWarnBoundary } : {}),
  issueActorToken: async (actor) => {
    const issued = await authService.issueVivaAccessToken(actor);
    return { token: issued.accessToken, expiresAt: issued.expiresAt };
  },
  onMetric: (outcome) => logger.info({ outcome }, 'managed self leave boundary'),
});
const gameCommercialJoin = gameRosterRepository
  ? createGameCommercialJoinRuntime({
      config,
      pool,
      rosterRepository: gameRosterRepository,
      ...(gameJoinConditionsOwner ? { conditionsOwner: gameJoinConditionsOwner } : {}),
      ...(subscriptionRuntimeWarnBoundary
        ? {
            ownerBoundary: {
              delegationIssuer: subscriptionRuntimeWarnBoundary.delegationIssuer,
              actorContextRepository: subscriptionRuntimeWarnBoundary.actorContextRepository,
              // The provider subscription mapping is resolved server-side for the selected product;
              // without it the owner cannot execute and the flow fails closed before dispatch.
              resolveProviderClientSubscriptionId: async (input) => {
                const context = await createGameJoinConditionsContextRepository(
                  pool,
                  config.VIVA_AUTH_TENANT_KEY ?? 'iSkq6G',
                ).resolve({
                  tenantId: input.tenantId,
                  userId: input.userId,
                  sessionId: input.sessionId,
                  gameId: input.gameId,
                  subscriptionInstanceId: input.subscriptionInstanceId,
                });
                return context?.providerSubscriptionId;
              },
            },
          }
        : {}),
      // Short-lived, user-scoped provider credential for exactly one operation. The runtime refuses
      // to execute without it, so an unwired OAuth contour cannot produce an unattributable write.
      issueActorToken: async (actor) => {
        const issued = await authService.issueVivaAccessToken({
          tenantKey: actor.tenantKey,
          tenantId: actor.tenantId,
          userId: actor.userId,
          sessionId: actor.sessionId,
          correlationId: actor.correlationId,
        });
        return { token: issued.accessToken, expiresAt: issued.expiresAt };
      },
    })
  : undefined;
// Managed commercial CREATE (WARN contour). Without the flag the factory returns undefined and the
// create route keeps its byte-identical GAME_PAYMENT_REQUIRED guard; the activatable WARN transport
// is the advisory owner, which never charges, books or calls LK1/Viva.
const gameCommercialCreate =
  gameCommandRepository && config.GAME_COMMERCIAL_CREATE_ENABLED
    ? createGameCommercialCreateRuntime({
        config,
        repository: gameCommandRepository,
        onMetric: (metric) => logger.info({ metric }, 'commercial CREATE boundary operation'),
      })
    : undefined;
const gameQuarterCreate = (() => {
  if (
    !config.GAME_COMMERCIAL_CREATE_ENABLED ||
    config.GAME_COMMERCIAL_CREATE_OWNER_TRANSPORT !== 'QUARTER_OWNER'
  )
    return createQuarterCreateRuntime({
      enabled: false,
      repository: createQuarterCreateRepository(pool),
    });
  const keys = JSON.parse(config.SUBSCRIPTION_RUNTIME_DELEGATION_PRIVATE_KEYS!) as Record<
      string,
      string
    >,
    keyId = config.SUBSCRIPTION_RUNTIME_DELEGATION_ACTIVE_KEY_ID!;
  return createQuarterCreateRuntime({
    enabled: true,
    repository: createQuarterCreateRepository(pool, {
      stationMembershipEnabled: config.LK_STATION_MEMBERSHIP_LIFETIME_ENABLED,
    }),
    stationMembership:
      createStationMembershipTransport(config, (outcome) =>
        logger.info({ outcome }, 'quarter CREATE station membership'),
      ) ?? undefined,
    issuer: new SubscriptionRuntimeActorDelegationIssuer({
      privateKeyPem: keys[keyId]!,
      keyId,
      issuer: config.SUBSCRIPTION_RUNTIME_DELEGATION_ISSUER!,
      audience: config.SUBSCRIPTION_RUNTIME_DELEGATION_AUDIENCE!,
      ttlSeconds: config.SUBSCRIPTION_RUNTIME_DELEGATION_TTL_SECONDS,
    }),
    client: new QuarterCreateOwnerClient({
      onMetric: (metric) => logger.info({ metric }, 'quarter CREATE owner operation'),
      baseUrl: config.GAME_COMMERCIAL_CREATE_OWNER_BASE_URL!,
      timeoutMs: config.GAME_COMMERCIAL_CREATE_OWNER_TIMEOUT_MS,
      environment: ['local', 'ci'].includes(config.APP_ENV) ? 'development' : 'production',
    }),
    token: async (actor) => {
      const issued = await authService.issueVivaAccessToken(actor);
      return { token: issued.accessToken, expiresAt: issued.expiresAt };
    },
  });
})();
const monthlyPurchase = (() => {
  const repository = createMonthlyPurchaseRepository(pool);
  if (!config.MONTHLY_SUBSCRIPTION_PURCHASE_ENABLED)
    return createMonthlyPurchaseRuntime({ enabled: false, repository });
  const keys = JSON.parse(config.SUBSCRIPTION_RUNTIME_DELEGATION_PRIVATE_KEYS!) as Record<
      string,
      string
    >,
    keyId = config.SUBSCRIPTION_RUNTIME_DELEGATION_ACTIVE_KEY_ID!;
  return createMonthlyPurchaseRuntime({
    enabled: true,
    repository,
    issuer: new SubscriptionRuntimeActorDelegationIssuer({
      privateKeyPem: keys[keyId]!,
      keyId,
      issuer: config.SUBSCRIPTION_RUNTIME_DELEGATION_ISSUER!,
      audience: config.SUBSCRIPTION_RUNTIME_DELEGATION_AUDIENCE!,
      ttlSeconds: config.SUBSCRIPTION_RUNTIME_DELEGATION_TTL_SECONDS,
    }),
    client: new MonthlyPurchaseOwnerClient({
      baseUrl: config.MONTHLY_SUBSCRIPTION_OWNER_BASE_URL!,
      timeoutMs: config.MONTHLY_SUBSCRIPTION_OWNER_TIMEOUT_MS,
      environment: ['local', 'ci'].includes(config.APP_ENV) ? 'development' : 'production',
      onMetric: (metric) => logger.info({ metric }, 'monthly subscription owner operation'),
    }),
    token: async (actor) => {
      const issued = await authService.issueVivaAccessToken(actor);
      return { token: issued.accessToken, expiresAt: issued.expiresAt };
    },
  });
})();
const organizerProfileLookup = createOrganizerProfileLookup(config, pool, redis);
const app = await buildApp({
  monthlyPurchase,
  ...(gameQuarterCreate ? { gameQuarterCreate } : {}),
  config,
  logger,
  pool,
  ...(runtimeContourAttestation ? { runtimeContourAttestation } : {}),
  authService,
  phoneSubjectLinkService,
  ...(subscriptionPolicyRegistryClient ? { subscriptionPolicyRegistryClient } : {}),
  ...(gameJoinConditionsOwner ? { gameJoinConditionsOwner } : {}),
  trainingRegistration,
  tournamentLocal,
  gameManagedSelfLeave,
  ...(gameCommercialJoin ? { gameCommercialJoin } : {}),
  ...(providerAccountAttestation
    ? {
        joinableSubscriptions: {
          ...providerAccountAttestation,
          repository: createProviderAccountMappingRepository(pool),
          issueActorToken: async (
            actor: Parameters<typeof authService.issueVivaAccessToken>[0],
          ) => {
            const issued = await authService.issueVivaAccessToken(actor);
            return { token: issued.accessToken, expiresAt: issued.expiresAt };
          },
        },
      }
    : {}),
  ...(gameCommercialCreate ? { gameCommercialCreate } : {}),
  ...(subscriptionRuntimeWarnBoundary
    ? {
        subscriptionRuntimeActorContextRepository:
          subscriptionRuntimeWarnBoundary.actorContextRepository,
        subscriptionRuntimeDelegationIssuer: subscriptionRuntimeWarnBoundary.delegationIssuer,
        subscriptionRuntimeQuoteClient: subscriptionRuntimeWarnBoundary.quoteClient,
      }
    : {}),
  communityDirectory: createCommunityDirectoryRuntime({
    config,
    pool,
    logger,
    token: communityActorToken,
  }),
  ...(stationMessageOwner ? { stationMessageOwner } : {}),
  ...(tournamentChatOwner ? { tournamentChatOwner } : {}),
  ...(stationStreamOwner ? { stationStreamOwner } : {}),
  ...(communityReadExperienceService ? { communityReadExperienceService } : {}),
  ...(communityCreateService ? { communityCreateService } : {}),
  ...(communityMembershipPinService ? { communityMembershipPinService } : {}),
  ...(communityMembershipLifecycleService ? { communityMembershipLifecycleService } : {}),
  ...(communityReadService ? { communityReadService } : {}),
  ...(communityDirectInviteService ? { communityDirectInviteService } : {}),
  ...(communityOwnershipTransferService ? { communityOwnershipTransferService } : {}),
  ...(communityContentService ? { communityContentService } : {}),
  ...(communityContentModerationService ? { communityContentModerationService } : {}),
  ...(communityEventRecoveryService ? { communityEventRecoveryService } : {}),
  ...(communityMediaRuntime && communityMediaObjectStore
    ? {
        communityMediaService: communityMediaRuntime.service,
        communityMediaDeliveryAuthorizer: communityMediaRuntime.deliveryAuthorizer,
        communityMediaModerationAuthorizer: communityMediaRuntime.moderationAuthorizer,
        communityMediaObjectStore,
        communityMediaOperationsRepository: communityMediaRuntime.operationsRepository,
      }
    : {}),
  realtimeAuthorizationRepository: createRealtimeAuthorizationRepository(pool),
  homeDashboardRepository: createHomeDashboardProjectionRepository(pool),
  homeBaseRepository: createHomeBaseProjectionRepository(pool),
  ...(config.HOME_BASE_SYNC_ENABLED
    ? {
        homeBaseProjector: (input: { tenantId: string; userId: string; correlationId: string }) =>
          projectHomeBaseUser({
            pool,
            ...input,
            ttlSeconds: config.HOME_PROJECTION_TTL_SECONDS,
          }),
      }
    : {}),
  clientRoutingPlanRepository,
  notificationRepository: createNotificationInboxRepository(pool),
  notificationPreferenceRepository: createNotificationPreferenceRepository(pool, {
    scenariosEnabled: config.NOTIFICATION_SCENARIOS_ENABLED,
  }),
  messagingRepository: createMessagingRepository(pool),
  messagingModerationRepository: createMessagingModerationRepository(pool),
  ...(chatMediaObjectStore
    ? {
        messagingMediaRepository: createMessagingMediaRepository(pool),
        messagingMediaObjectStore: chatMediaObjectStore,
      }
    : {}),
  realtimeTicketIssuer: new RedisRealtimeTicketIssuer(redis, config),
  notificationEndpointRepository: createNotificationEndpointRepository(pool),
  adminNotificationRepository: createAdminNotificationRepository(pool),
  notificationScenarioRepository: createNotificationScenarioRepository(pool),
  locationRepository: createLocationRepository(pool),
  ...(stationSupportProvider ? { stationSupportProvider } : {}),
  ...(stationSupportRepository ? { stationSupportRepository } : {}),
  supportTicketRepository: createSupportTicketRepository(pool),
  ...(stationSupportMediaStore ? { stationSupportMediaStore } : {}),
  ...(stationSupportMediaAllowedHosts.length > 0 ? { stationSupportMediaAllowedHosts } : {}),
  levelEligibilityPolicyRepository: createLevelEligibilityPolicyRepository(pool),
  playerLevelRepository: createPlayerLevelRepository(pool),
  cupPlayerLevelProjectionRepository: createCupPlayerLevelProjectionRepository(pool),
  ...(organizerProfileLookup ? { organizerProfileLookup } : {}),
  participationCommandRepository,
  locationMediaRepository: createLocationMediaRepository(pool),
  giftCertificateCatalogRepository: createGiftCertificateCatalogRepository(pool),
  giftCertificateMediaRepository: createGiftCertificateMediaRepository(pool),
  giftCertificateSaleRepository: createGiftCertificateSaleRepository(pool),
  ...(config.GIFT_CERTIFICATE_ISSUANCE_ENABLED
    ? { giftCertificateIssuanceRepository: createGiftCertificateIssuanceRepository(pool) }
    : {}),
  ...(giftCertificateMediaStore ? { giftCertificateMediaStore } : {}),
  ...(locationMediaStore ? { locationMediaStore } : {}),
  profilePhotoMediaRepository: profileSummaryRepository,
  communityLogoMediaRepository: createCommunityLogoMediaRepository(pool),
  ...(profilePhotoMediaStore ? { profilePhotoMediaStore } : {}),
  ...(providerIdentityLink ? { providerIdentityLink } : {}),
  ...(legacyViewerAssociationProof ? { legacyViewerAssociationProof } : {}),
  ...(trainerAvatarMediaStore
    ? {
        trainerAvatarRepository: createTrainerAvatarRepository(pool),
        trainerAvatarMediaStore,
      }
    : {}),
  ...(giftCertificateArtifactStore ? { giftCertificateArtifactStore } : {}),
  profileContactReader: createContactReader(pool),
  profilePrivacyRepository: createProfilePrivacyRepository(pool),
  profileFriendshipRepository: createProfileFriendshipRepository(pool),
  profileReachabilityRepository: createProfileReachabilityRepository(pool),
  profileLevelHistoryRepository: createProfileLevelHistoryRepository(pool),
  profileProviderObservationRepository: createProfileProviderObservationRepository(pool),
  profileSummaryRepository,
  clientResidencyService,
  ...(userVivaAdminSource
    ? {
        userVivaAdminSource,
        resolveUserVivaClientId: (input: { readonly tenantId: string; readonly userId: string }) =>
          residencyRepository.resolveVivaClientId(input),
      }
    : {}),
  ...(promotionEngagementSink
    ? {
        promotionEngagementRepository: createPromotionEngagementRepository(pool),
        promotionEngagementSink,
      }
    : {}),
  ...(trainingCatalogueSource ? { trainingCatalogueSource } : {}),
  bookingPreferencesRepository: createBookingPreferencesRepository(pool),
  upcomingBookingsRepository: createUpcomingBookingsRepository(pool),
  // Always mounted: the observation read path is independent of the rollout flag, and the flag
  // itself is enforced when a provider-read job is created.
  profileProviderReadJobStore: new RedisProfileProviderReadJobStore(redis),
  ...(config.VIVA_DIRECT_READ_ENABLED || config.GAMES_READ_ENABLED
    ? {
        bookingScreenReadJobStore: new RedisBookingScreenReadJobStore(redis),
        eventCatalogSnapshotStore: new RedisEventCatalogSnapshotStore<EventCatalogItem>(redis),
        bookingScreenMappingRepository,
      }
    : {}),
  ...(activityHistoryRepository ? { activityHistoryRepository } : {}),
  ...(activityHistoryProjector ? { activityHistoryProjector } : {}),
  ...(activityHistoryGameCards ? { activityHistoryGameCards } : {}),
  ...(gameReadRepository ? { gameReadRepository } : {}),
  ...(gameCommandRepository ? { gameCommandRepository } : {}),
  gameTestCourtRepository,
  ...(tournamentSummarySource ? { tournamentSummarySource } : {}),
  ...(gameRosterRepository
    ? {
        gameRosterRepository,
        ...(config.LEGACY_GAME_COMMAND_BRIDGE_ENABLED && legacyLkIdentityVerifier
          ? {
              legacyGameRosterBridgeRepository: createLegacyGameRosterBridgeRepository(pool),
              legacyLkIdentityVerifier,
            }
          : {}),
        ...(config.GAMES_RESULTS_WRITE_MODE === 'local_primary'
          ? { gameResultRepository: createGameResultRepository(pool) }
          : {}),
      }
    : {}),
  ...(notificationEndpointCipher ? { notificationEndpointCipher } : {}),
  ...(notificationReceiptKey ? { notificationReceiptSecret: notificationReceiptKey } : {}),
  authDependencyReady: async () => (await redis.ping()) === 'PONG',
  rateLimitRedis: redis,
});

const shutdown = async (signal: string): Promise<void> => {
  logger.info({ signal }, 'shutting down');
  await app.close();
  await redis.quit().catch(() => redis.disconnect());
  await pool.end();
  await telemetry?.shutdown();
  process.exit(0);
};

process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ host: config.API_HOST, port: config.API_PORT });
