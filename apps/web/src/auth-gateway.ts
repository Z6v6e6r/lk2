import { ApiClientError, PadlHubApiClient } from '@phub/api-sdk';
import type {
  AuthenticatedSession as ApiAuthenticatedSession,
  ActivityHistoryFilters,
  ActivityHistoryPage,
  BookingPreferences,
  BookingPreferencesUpdateRequest,
  BookingRecommendationFilters,
  BookingRecommendationPage,
  BookingScreenReadJob,
  BookingScreenActivityHistoryReadCommand,
  BookingScreenScheduleReadCommand,
  EventCatalogPage,
  EventCatalogQuery,
  TrainingSchedulePage,
  ClientRoutingPlan,
  CommunityMembershipPage,
  CommunityDiscoveryPage,
  CommunityDetailView,
  CommunityFeedPage,
  CommunityRealtimeEventPage,
  CommunityPost,
  CommunityPostCreateRequest,
  CommunityMediaUploadIssueRequest,
  CommunityMediaUploadIssued,
  CommunityMediaStatus,
  CommunityMediaVariantName,
  CommunityDirectInvitePreview,
  CommunityDirectInviteCreated,
  CommunityDirectInvitePage,
  CommunityDirectInviteState,
  CommunityOwnMembershipState,
  GameCard,
  GameCardPage,
  GameCommandResult,
  GetOrCreateGameConversationResult,
  SubmitGameResultRequest,
  DisputeGameResultRequest,
  HomeBase,
  HomeDashboard,
  GiftCertificateOrderCommandResult,
  GiftCertificateOrder,
  GiftCertificatePaymentIntent,
  LocationDetail,
  LocationList,
  NotificationInboxPage,
  MessagingRealtimeTicket,
  RealtimeTicket,
  PlayerProfileView,
  PublicGameCardPage,
  PublicGameFilters,
  PublicCoachGameFilters,
  PublicCoachGameSummaryPage,
  PublicTournamentFilters,
  PublicTournamentSummary,
  PublicTournamentSummaryRange,
  PublicTournamentSummaryPage,
  TournamentParticipantRoster,
  PublicGiftCertificateCatalog,
  CreateGiftCertificateOrderRequest,
  ProfilePrivacySettings,
  ProfilePrivacyUpdateRequest,
  ProfileLevelHistory,
  ProfileFriendPage,
  ProfileFriendship,
  UserProfile,
  UserUpcomingBookings,
  UserContext as ApiUserContext,
  WebPushConfiguration,
  WebPushEndpointCommandResult,
  WebPushEndpointRegistration,
} from '@phub/api-sdk';
export type {
  ActivityHistoryFilters,
  ActivityHistoryPage,
  BookingPreferences,
  BookingPreferencesUpdateRequest,
  BookingRecommendationFilters,
  BookingRecommendationPage,
  EventCatalogItem,
  EventCatalogPage,
  EventCatalogQuery,
  TrainingSchedulePage,
  ClientRoutingPlan,
  CommunityMembershipPage,
  CommunityDiscoveryPage,
  CommunityDetailView,
  CommunityFeedPage,
  CommunityRealtimeEventPage,
  CommunityPost,
  CommunityPostCreateRequest,
  CommunityMediaUploadIssueRequest,
  CommunityMediaUploadIssued,
  CommunityMediaStatus,
  CommunityMediaVariantName,
  CommunityDirectInvitePreview,
  CommunityDirectInviteCreated,
  CommunityDirectInvitePage,
  CommunityDirectInviteState,
  CommunityOwnMembershipState,
  GameCard,
  GameCardPage,
  GameCommandResult,
  GetOrCreateGameConversationResult,
  SubmitGameResultRequest,
  DisputeGameResultRequest,
  HomeBase,
  HomeDashboard,
  GiftCertificateOrderCommandResult,
  GiftCertificateOrder,
  GiftCertificatePaymentIntent,
  LocationDetail,
  LocationList,
  NotificationInboxPage,
  RealtimeTicket,
  PlayerProfileView,
  PublicGameCard,
  PublicGameCardPage,
  PublicGameFilters,
  PublicCoachGameFilters,
  PublicCoachGameSummary,
  PublicCoachGameSummaryPage,
  PublicTournamentFilters,
  PublicTournamentSummaryRange,
  PublicTournamentSummary,
  PublicTournamentSummaryPage,
  TournamentParticipantRoster,
  PublicGiftCertificateCatalog,
  CreateGiftCertificateOrderRequest,
  ProfilePrivacySettings,
  ProfilePrivacyUpdateRequest,
  ProfileLevelHistory,
  ProfileFriendPage,
  ProfileFriendship,
  UserProfile,
  UserUpcomingBookings,
  WebPushConfiguration,
  WebPushEndpointCommandResult,
  WebPushEndpointRegistration,
} from '@phub/api-sdk';
export type {
  ActivityHistoryItem,
  ActivityHistoryKind,
  ActivityHistoryStatus,
} from '@phub/api-sdk';
import { maskPhone } from '@phub/auth';
import {
  createClientTransportExecutor,
  normalizePadlHubUserProfile,
} from '@phub/viva-client-adapter';

export interface NormalizedUser {
  readonly id: string;
  readonly displayName: string;
  readonly phoneMasked?: string;
}

export interface NormalizedTenant {
  readonly id: string;
  readonly key: string;
  readonly name: string;
}

export interface UserContext {
  readonly user: NormalizedUser;
  readonly tenant: NormalizedTenant;
  readonly roles: readonly string[];
  readonly permissions: readonly string[];
  readonly runtimeCapabilities?: {
    readonly communityDirectInvites: boolean;
    readonly communityRealtime: boolean;
  };
}

export interface AuthenticatedSession {
  readonly context: UserContext;
}

export interface MessagingParticipant {
  readonly userId: string;
  readonly displayName: string;
}

export interface ConversationLastMessage {
  readonly sequence: number;
  readonly body: string;
  readonly createdAt: string;
}

export interface DirectConversationSummary {
  readonly id: string;
  readonly kind: 'DIRECT';
  readonly participant: MessagingParticipant;
  readonly unreadCount: number;
  readonly updatedAt: string;
  readonly lastMessage?: ConversationLastMessage;
}

export interface GameConversationSummary {
  readonly id: string;
  readonly kind: 'GAME';
  readonly contextId: string;
  readonly title: string;
  readonly unreadCount: number;
  readonly updatedAt: string;
  readonly lastMessage?: ConversationLastMessage;
}

export type ConversationSummary = DirectConversationSummary | GameConversationSummary;

export interface ConversationPage {
  readonly items: readonly ConversationSummary[];
}

export interface ConversationMessage {
  readonly id: string;
  readonly conversationId: string;
  readonly sequence: number;
  readonly sender: MessagingParticipant;
  readonly messageType: 'TEXT';
  readonly body: string;
  readonly createdAt: string;
}

export interface ConversationMessagePage {
  readonly messages: readonly ConversationMessage[];
  readonly nextAfterSequence?: number;
}

export interface CreateDirectConversationResult {
  readonly outcome: 'ok';
  readonly conversation: DirectConversationSummary;
  readonly created: boolean;
  readonly replayed: boolean;
}

export interface SendConversationMessageResult {
  readonly outcome: 'ok';
  readonly message: ConversationMessage;
  readonly replayed: boolean;
}

export interface ConversationReadCursorResult {
  readonly outcome: 'ok';
  readonly readThroughSequence: number;
  readonly changed: boolean;
  readonly replayed: boolean;
}

export interface SendConversationMessageCommand {
  readonly clientMessageId: string;
  readonly body: string;
}

export type ActivityHistoryQuery = ActivityHistoryFilters;

export interface HomeBookingRecommendationFilters extends BookingRecommendationFilters {
  readonly phase?: 'INITIAL' | 'TOURNAMENTS' | 'EXPANDED';
}

export interface PhoneChallenge {
  readonly challengeId: string;
  readonly maskedPhone: string;
  readonly expiresAt: string;
  readonly resendAt: string;
}

export type VivaOAuthProvider = 'vkid' | 'yandex';

export interface LegalAcceptance {
  readonly publicOfferAccepted: boolean;
  readonly personalDataPolicyAccepted: boolean;
}

export interface AuthGateway {
  readonly restoreSession: () => Promise<AuthenticatedSession | null>;
  readonly requestCode: (phoneE164: string) => Promise<PhoneChallenge>;
  readonly verifyCode: (input: {
    readonly challengeId: string;
    readonly code: string;
    readonly acceptance: LegalAcceptance;
  }) => Promise<AuthenticatedSession>;
  /**
   * Starts a server-owned OAuth Authorization Code + PKCE flow. The redirect
   * URL is deliberately obtained from PadlHub rather than constructed in the
   * browser: state, PKCE verifier and legal-acceptance intent are server-side.
   */
  readonly startVivaOAuth: (input: {
    readonly provider: VivaOAuthProvider;
    readonly acceptance: LegalAcceptance;
  }) => Promise<void>;
  readonly getVivaAccessToken: () => string | undefined;
  readonly refreshVivaAccessToken: () => Promise<string>;
  readonly issueRealtimeTicket: () => Promise<RealtimeTicket>;
  readonly getRoutingPlan: (forceRefresh?: boolean) => Promise<ClientRoutingPlan>;
  readonly getSelfProfile: () => Promise<UserProfile>;
  readonly getUserProfile: (userId: string) => Promise<UserProfile>;
  readonly getPlayerProfile: (userId: string) => Promise<PlayerProfileView>;
  readonly getProfilePrivacy: () => Promise<ProfilePrivacySettings>;
  readonly updateProfilePrivacy: (
    input: ProfilePrivacyUpdateRequest,
  ) => Promise<ProfilePrivacySettings>;
  readonly listProfileFriends: (limit?: number) => Promise<ProfileFriendPage>;
  readonly getProfileFriendship: (userId: string) => Promise<ProfileFriendship>;
  readonly addProfileFriend: (userId: string) => Promise<ProfileFriendship>;
  readonly getBookingPreferences: () => Promise<BookingPreferences>;
  readonly updateBookingPreferences: (
    input: BookingPreferencesUpdateRequest,
  ) => Promise<BookingPreferences>;
  readonly getUpcomingBookings: () => Promise<UserUpcomingBookings>;
  readonly listBookingRecommendations: (
    input?: BookingRecommendationFilters,
  ) => Promise<BookingRecommendationPage>;
  readonly listHomeBookingRecommendations?: (
    input?: HomeBookingRecommendationFilters,
  ) => Promise<BookingRecommendationPage>;
  readonly recordPromotionEngagement: (
    promotionId: string,
    kind: 'IMPRESSION' | 'CLICK',
  ) => Promise<{ readonly accepted: boolean }>;
  readonly listTrainingSchedule: () => Promise<TrainingSchedulePage>;
  readonly listEventCatalog: (query: EventCatalogQuery) => Promise<EventCatalogPage>;
  readonly continueEventCatalog: (cursor: string, limit?: number) => Promise<EventCatalogPage>;
  readonly getHomeBase: () => Promise<HomeBase>;
  readonly getHomeDashboard: () => Promise<HomeDashboard>;
  readonly getPublicGiftCertificateCatalog: () => Promise<PublicGiftCertificateCatalog>;
  readonly createPublicGiftCertificateOrder: (
    input: CreateGiftCertificateOrderRequest,
  ) => Promise<GiftCertificateOrderCommandResult>;
  readonly createPublicGiftCertificatePaymentIntent: (
    orderId: string,
  ) => Promise<GiftCertificatePaymentIntent>;
  readonly getPublicGiftCertificateOrder: (orderId: string) => Promise<GiftCertificateOrder>;
  readonly downloadPublicGiftCertificate: (orderId: string) => Promise<Blob>;
  readonly createGiftCertificateOrder: (
    input: CreateGiftCertificateOrderRequest,
  ) => Promise<GiftCertificateOrderCommandResult>;
  readonly createGiftCertificatePaymentIntent: (
    orderId: string,
  ) => Promise<GiftCertificatePaymentIntent>;
  readonly getGiftCertificateOrder: (orderId: string) => Promise<GiftCertificateOrder>;
  readonly downloadGiftCertificate: (orderId: string) => Promise<Blob>;
  readonly listPublicGames: (input?: PublicGameFilters) => Promise<PublicGameCardPage>;
  readonly listPublicTournamentSummaries?: (
    input: PublicTournamentFilters,
  ) => Promise<PublicTournamentSummaryPage>;
  readonly getPublicTournamentSummary?: (
    summaryId: string,
    input: PublicTournamentSummaryRange,
  ) => Promise<PublicTournamentSummary>;
  readonly getTournamentParticipants?: (
    tournamentId: string,
  ) => Promise<TournamentParticipantRoster>;
  readonly listPublicCoachGameSummaries?: (
    input: PublicCoachGameFilters,
  ) => Promise<PublicCoachGameSummaryPage>;
  readonly listMyGames: (input?: {
    readonly scope?: 'UPCOMING' | 'HISTORY';
    readonly limit?: number;
    readonly cursor?: string;
  }) => Promise<GameCardPage>;
  readonly getActivityHistory: (input?: ActivityHistoryQuery) => Promise<ActivityHistoryPage>;
  readonly getGame: (gameId: string) => Promise<GameCard>;
  readonly joinGame: (gameId: string, expectedRevision?: number) => Promise<GameCommandResult>;
  readonly leaveGame: (gameId: string) => Promise<GameCommandResult>;
  readonly joinGameWaitlist: (gameId: string) => Promise<GameCommandResult>;
  readonly leaveGameWaitlist: (gameId: string) => Promise<GameCommandResult>;
  readonly submitGameResult: (
    gameId: string,
    input: SubmitGameResultRequest,
  ) => Promise<GameCommandResult>;
  readonly confirmGameResult: (gameId: string, submissionId: string) => Promise<GameCommandResult>;
  readonly disputeGameResult: (
    gameId: string,
    submissionId: string,
    input: DisputeGameResultRequest,
  ) => Promise<GameCommandResult>;
  readonly getGameOperation: (operationId: string) => Promise<GameCommandResult>;
  readonly listLocations: () => Promise<LocationList>;
  readonly getLocation: (locationId: string) => Promise<LocationDetail>;
  readonly listMyCommunities: (cursor?: string, limit?: number) => Promise<CommunityMembershipPage>;
  readonly discoverCommunities: (
    query?: string,
    cursor?: string,
    limit?: number,
  ) => Promise<CommunityDiscoveryPage>;
  readonly getCommunityDetail: (communityId: string) => Promise<CommunityDetailView>;
  readonly getMyCommunityMembershipState: (
    communityId: string,
  ) => Promise<CommunityOwnMembershipState>;
  readonly joinOrRequestCommunityMembership: (
    communityId: string,
    expectedMembershipRevision: number,
  ) => Promise<CommunityOwnMembershipState>;
  readonly cancelMyCommunityJoinRequest: (
    communityId: string,
    requestId: string,
    expectedMembershipRevision: number,
    expectedRequestRevision: number,
  ) => Promise<CommunityOwnMembershipState>;
  readonly leaveCommunity: (
    communityId: string,
    expectedMembershipRevision: number,
  ) => Promise<CommunityOwnMembershipState>;
  readonly listCommunityFeed: (communityId: string, cursor?: string) => Promise<CommunityFeedPage>;
  readonly recoverCommunityEvents: (
    communityId: string,
    input: { readonly afterSequence: number; readonly limit: number },
  ) => Promise<CommunityRealtimeEventPage>;
  readonly createCommunityPost: (
    communityId: string,
    input: CommunityPostCreateRequest,
  ) => Promise<CommunityPost>;
  readonly issueCommunityMediaUpload: (
    communityId: string,
    input: CommunityMediaUploadIssueRequest,
  ) => Promise<CommunityMediaUploadIssued>;
  readonly finalizeCommunityMediaUpload: (
    communityId: string,
    mediaId: string,
    expectedRevision: number,
  ) => Promise<CommunityMediaStatus>;
  readonly getCommunityMediaStatus: (
    communityId: string,
    mediaId: string,
  ) => Promise<CommunityMediaStatus>;
  readonly downloadCommunityMediaVariant: (
    communityId: string,
    mediaId: string,
    variant: CommunityMediaVariantName,
  ) => Promise<Blob>;
  readonly previewCommunityDirectInvite: (token: string) => Promise<CommunityDirectInvitePreview>;
  readonly redeemCommunityDirectInvite: (
    token: string,
    expectedInviteRevision: number,
    expectedMembershipRevision: number,
  ) => Promise<CommunityOwnMembershipState>;
  readonly listCommunityDirectInvites: (
    communityId: string,
    cursor?: string,
  ) => Promise<CommunityDirectInvitePage>;
  readonly createCommunityDirectInvite: (
    communityId: string,
    expectedIssuerMembershipRevision: number,
  ) => Promise<CommunityDirectInviteCreated>;
  readonly revokeCommunityDirectInvite: (
    inviteId: string,
    expectedInviteRevision: number,
  ) => Promise<CommunityDirectInviteState>;
  readonly getProfileLevelHistory: () => Promise<ProfileLevelHistory>;
  readonly listConversations: () => Promise<ConversationPage>;
  readonly createRealtimeTicket: () => Promise<MessagingRealtimeTicket>;
  readonly createDirectConversation: (
    otherUserId: string,
    idempotencyKey: string,
  ) => Promise<CreateDirectConversationResult>;
  readonly getOrCreateGameConversation: (
    gameId: string,
  ) => Promise<GetOrCreateGameConversationResult>;
  readonly listConversationMessages: (
    conversationId: string,
    afterSequence?: number,
  ) => Promise<ConversationMessagePage>;
  readonly sendConversationMessage: (
    conversationId: string,
    command: SendConversationMessageCommand,
  ) => Promise<SendConversationMessageResult>;
  readonly markConversationRead: (
    conversationId: string,
    throughSequence: number,
    idempotencyKey: string,
  ) => Promise<ConversationReadCursorResult>;
  readonly listNotifications: () => Promise<NotificationInboxPage>;
  readonly markNotificationsRead: (throughId: string) => Promise<void>;
  readonly getWebPushConfiguration: () => Promise<WebPushConfiguration>;
  readonly registerWebPushEndpoint: (
    input: WebPushEndpointRegistration,
  ) => Promise<WebPushEndpointCommandResult>;
  readonly revokeWebPushEndpoint: (installationId: string) => Promise<WebPushEndpointCommandResult>;
  readonly logout: () => Promise<void>;
}

interface BrowserAuthGatewayOptions {
  readonly baseUrl: string;
  readonly tenantKey: string;
  readonly appVersion: string;
  readonly appBuild?: string;
  readonly fetchImplementation?: typeof fetch;
}

const HOME_INITIAL_SCHEDULE_DAYS = 3;
const NOTIFICATION_CACHE_TTL_MS = 2_000;

export function createMessagingCommandId(): string {
  const webCrypto = typeof globalThis === 'object' ? globalThis.crypto : undefined;
  if (typeof webCrypto?.randomUUID === 'function') return webCrypto.randomUUID();
  const bytes = new Uint8Array(16);
  if (typeof webCrypto?.getRandomValues === 'function') webCrypto.getRandomValues(bytes);
  else for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.random() * 256;
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function normalizeContext(payload: ApiUserContext, tenantKey: string): UserContext {
  return {
    user: {
      id: payload.userId,
      displayName: payload.displayName,
      phoneMasked: `•••• ${payload.phoneLast4}`,
    },
    tenant: {
      id: payload.tenantId,
      key: tenantKey,
      name: tenantKey === 'local-padel' ? 'ПаделХАБ' : tenantKey,
    },
    roles: payload.roles,
    permissions: payload.permissions,
    runtimeCapabilities: {
      communityDirectInvites: payload.runtimeCapabilities?.communityDirectInvites === true,
      communityRealtime: payload.runtimeCapabilities?.communityRealtime === true,
    },
  };
}

function isUnauthorized(error: unknown): boolean {
  return error instanceof ApiClientError && error.status === 401;
}

function buildSelfPlayerProfileView(profile: UserProfile): PlayerProfileView {
  return {
    profile: {
      userId: profile.userId,
      displayName: profile.displayName,
      ...(profile.firstName !== undefined ? { firstName: profile.firstName } : {}),
      ...(profile.avatarUrl !== undefined ? { avatarUrl: profile.avatarUrl } : {}),
      level: {
        label: profile.level.label,
        value: profile.level.value,
        assessmentRequired: profile.level.assessmentRequired,
      },
    },
    privateAccount: {
      ...(profile.phoneLast4 ? { phoneLast4: profile.phoneLast4 } : {}),
      balanceMinor: profile.balanceMinor,
      currency: profile.currency,
    },
    access: {
      audience: 'SELF',
      tier: 'SELF',
      visibleSections: ['BASIC', 'PLAYER_LEVEL', 'PLAYER_RATING', 'PRIVATE_ACCOUNT'],
      contact: { status: 'HIDDEN', reason: 'SELF_PROFILE' },
      chat: { status: 'HIDDEN', reason: 'SELF_PROFILE' },
    },
  };
}

/**
 * Browser auth talks only to the public PadlHub API. The refresh credential is
 * an HttpOnly cookie; only the short-lived PadlHub access token reaches JS and
 * it remains in memory for the lifetime of this gateway instance.
 */
export function createBrowserAuthGateway(options: BrowserAuthGatewayOptions): AuthGateway {
  const clientOptions = {
    baseUrl: options.baseUrl.replace(/\/$/, ''),
    tenantKey: options.tenantKey,
    platform: 'web' as const,
    appVersion: options.appVersion,
    ...(options.appBuild ? { appBuild: options.appBuild } : {}),
    ...(options.fetchImplementation ? { fetchImplementation: options.fetchImplementation } : {}),
  };
  const client = new PadlHubApiClient(clientOptions);
  let vivaAccessToken: string | undefined;
  let vivaAccessExpiresAt = 0;
  let homeBasePromise: Promise<HomeBase> | undefined;
  let homeDashboardPromise: Promise<HomeDashboard> | undefined;
  let locationsPromise: Promise<LocationList> | undefined;
  const communityMembershipPagePromises = new Map<number, Promise<CommunityMembershipPage>>();
  let routingPlan: ClientRoutingPlan | undefined;
  let routingPlanPromise: Promise<ClientRoutingPlan> | undefined;
  let selfProfilePromise: Promise<UserProfile> | undefined;
  let currentUserId: string | undefined;
  const playerProfilePromises = new Map<string, Promise<PlayerProfileView>>();
  let profilePrivacyPromise: Promise<ProfilePrivacySettings> | undefined;
  let bookingPreferencesPromise: Promise<BookingPreferences> | undefined;
  let upcomingBookingsPromise: Promise<UserUpcomingBookings> | undefined;
  let vivaAccessPromise: Promise<string> | undefined;
  const bookingRecommendationPromises = new Map<number, Promise<BookingRecommendationPage>>();
  const bookingRecommendationCache = new Map<
    number,
    { readonly page: BookingRecommendationPage; readonly expiresAt: number }
  >();
  const homeBookingRecommendationPromises = new Map<string, Promise<BookingRecommendationPage>>();
  const homeBookingRecommendationCache = new Map<
    number,
    { readonly page: BookingRecommendationPage; readonly expiresAt: number }
  >();
  const homeBookingRecommendationExpansions = new Map<
    number,
    {
      readonly job: BookingScreenReadJob;
      readonly commands: readonly BookingScreenScheduleReadCommand[];
    }
  >();
  let trainingSchedulePromise: Promise<TrainingSchedulePage> | undefined;
  let trainingScheduleCache:
    { readonly page: TrainingSchedulePage; readonly expiresAt: number } | undefined;
  let notificationsPromise: Promise<NotificationInboxPage> | undefined;
  let notificationsCache:
    { readonly page: NotificationInboxPage; readonly expiresAt: number } | undefined;
  let notificationsCacheRevision = 0;
  const publicTournamentSummaryPromises = new Map<string, Promise<PublicTournamentSummary>>();

  function resolvePaymentIntent(
    intent: GiftCertificatePaymentIntent,
  ): GiftCertificatePaymentIntent {
    return {
      ...intent,
      nextAction: {
        ...intent.nextAction,
        url: new URL(intent.nextAction.url, `${clientOptions.baseUrl}/`).toString(),
      },
    };
  }

  function applyVivaAccess(handoffCode?: string): Promise<string> {
    if (!handoffCode && vivaAccessPromise) return vivaAccessPromise;
    const request = client
      .issueVivaAccessToken(handoffCode ? { handoffCode } : {})
      .then((access) => {
        vivaAccessToken = access.accessToken;
        vivaAccessExpiresAt = Date.parse(access.expiresAt);
        return access.accessToken;
      });
    if (handoffCode) return request;
    const coalesced = request.finally(() => {
      if (vivaAccessPromise === coalesced) vivaAccessPromise = undefined;
    });
    vivaAccessPromise = coalesced;
    return coalesced;
  }

  async function consumeVivaHandoff(): Promise<void> {
    if (typeof window === 'undefined') return;
    const currentUrl = new URL(window.location.href);
    const fragment = new URLSearchParams(currentUrl.hash.replace(/^#/, ''));
    const handoffCode = fragment.get('viva_handoff');
    if (!handoffCode) return;
    try {
      await applyVivaAccess(handoffCode);
    } finally {
      fragment.delete('viva_handoff');
      currentUrl.hash = fragment.toString();
      window.history.replaceState({}, '', currentUrl.toString());
    }
  }

  function normalizeSession(session: ApiAuthenticatedSession): AuthenticatedSession {
    currentUserId = session.context.userId;
    return { context: normalizeContext(session.context, options.tenantKey) };
  }

  function loadRoutingPlan(forceRefresh = false): Promise<ClientRoutingPlan> {
    if (!forceRefresh && routingPlan && Date.parse(routingPlan.expiresAt) > Date.now() + 5_000) {
      return Promise.resolve(routingPlan);
    }
    if (!forceRefresh && routingPlanPromise) return routingPlanPromise;
    const request = client
      .getClientRoutingPlan()
      .then((result) => {
        routingPlan = result;
        return result;
      })
      .finally(() => {
        if (routingPlanPromise === request) routingPlanPromise = undefined;
      });
    routingPlanPromise = request;
    return request;
  }

  function loadSelfProfile(): Promise<UserProfile> {
    if (!currentUserId) return Promise.reject(new Error('AUTH_REQUIRED'));
    selfProfilePromise ??= client
      .getUserProfile()
      .then(normalizePadlHubUserProfile)
      .catch((error: unknown) => {
        selfProfilePromise = undefined;
        throw error;
      });
    return selfProfilePromise;
  }

  const clientTransport = createClientTransportExecutor({
    getRoutingPlan: loadRoutingPlan,
    getVivaAccessToken: () =>
      vivaAccessToken && vivaAccessExpiresAt > Date.now() + 30_000 ? vivaAccessToken : undefined,
    refreshVivaAccessToken: applyVivaAccess,
    executePadlHub: () => Promise.reject(new Error('CLIENT_ASSISTED_READ_HAS_NO_DIRECT_FALLBACK')),
    ...(options.fetchImplementation ? { fetchImplementation: options.fetchImplementation } : {}),
  });

  async function executeScheduleCommands(
    job: BookingScreenReadJob,
    commands: readonly BookingScreenScheduleReadCommand[],
  ): Promise<void> {
    let nextIndex = 0;
    const worker = async (): Promise<void> => {
      while (nextIndex < commands.length) {
        const command = commands[nextIndex];
        nextIndex += 1;
        if (!command) return;
        try {
          const payload = await clientTransport.executeClientAssistedScheduleRead({
            operation: command.operation,
            date: command.date,
          });
          await client.submitBookingScreenReadResult(job.jobId, command.commandId, payload);
        } catch {
          // Completion reports PARTIAL and still returns eligible local games.
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.max(1, Math.min(job.concurrency, commands.length)) }, () =>
        worker(),
      ),
    );
  }

  async function completeRecommendationJob(
    job: BookingScreenReadJob,
    limit: number,
    phase?: 'HOME_INITIAL' | 'HOME_TOURNAMENTS' | 'FULL',
  ): Promise<BookingRecommendationPage> {
    const completion = await client.completeBookingScreenReadJob(job.jobId, limit, phase);
    if (completion.screen !== 'FOR_ME') throw new Error('BOOKING_SCREEN_READ_JOB_MISMATCH');
    return completion.page;
  }

  async function loadClientAssistedRecommendations(
    input: BookingRecommendationFilters,
  ): Promise<BookingRecommendationPage> {
    const limit = input.limit ?? 6;
    if (input.cursor) return client.listBookingRecommendations(input);

    const job = await client.startBookingScreenReadJob('FOR_ME');
    const commands = job.commands.filter(
      (command): command is BookingScreenScheduleReadCommand =>
        command.operation === 'schedule.read',
    );
    await executeScheduleCommands(job, commands);
    return completeRecommendationJob(job, limit);
  }

  async function loadInitialHomeRecommendations(limit: number): Promise<BookingRecommendationPage> {
    const job = await client.startBookingScreenReadJob('FOR_ME');
    const commands = job.commands.filter(
      (command): command is BookingScreenScheduleReadCommand =>
        command.operation === 'schedule.read',
    );
    const initialCommands = commands.slice(0, HOME_INITIAL_SCHEDULE_DAYS);
    await executeScheduleCommands(job, initialCommands);
    const page = await completeRecommendationJob(job, limit, 'HOME_INITIAL');
    const remainingCommands = commands.slice(HOME_INITIAL_SCHEDULE_DAYS);
    if (remainingCommands.length > 0) {
      homeBookingRecommendationExpansions.set(limit, { job, commands: remainingCommands });
    }
    return page;
  }

  async function loadExpandedHomeRecommendations(
    limit: number,
  ): Promise<BookingRecommendationPage> {
    const expansion = homeBookingRecommendationExpansions.get(limit);
    if (!expansion) return loadClientAssistedRecommendations({ limit });
    try {
      await executeScheduleCommands(expansion.job, expansion.commands);
      return await completeRecommendationJob(expansion.job, limit, 'FULL');
    } finally {
      homeBookingRecommendationExpansions.delete(limit);
    }
  }

  async function loadHomeTournamentRecommendations(
    limit: number,
  ): Promise<BookingRecommendationPage> {
    const expansion = homeBookingRecommendationExpansions.get(limit);
    if (!expansion) return loadClientAssistedRecommendations({ limit });
    return completeRecommendationJob(expansion.job, limit, 'HOME_TOURNAMENTS');
  }

  async function loadClientAssistedTrainingSchedule(): Promise<TrainingSchedulePage> {
    const job = await client.startBookingScreenReadJob('GROUP_TRAININGS');
    const commands = job.commands.filter(
      (command): command is BookingScreenScheduleReadCommand =>
        command.operation === 'schedule.read',
    );
    await executeScheduleCommands(job, commands);
    const completion = await client.completeBookingScreenReadJob(job.jobId, 500);
    if (completion.screen !== 'GROUP_TRAININGS') {
      throw new Error('BOOKING_SCREEN_READ_JOB_MISMATCH');
    }
    return completion.trainings;
  }

  async function loadClientAssistedEventCatalog(
    query: EventCatalogQuery,
  ): Promise<EventCatalogPage> {
    const job = await client.startEventCatalogReadJob(query);
    const commands = job.commands.filter(
      (command): command is BookingScreenScheduleReadCommand =>
        command.operation === 'schedule.read',
    );
    await executeScheduleCommands(job, commands);
    const completion = await client.completeBookingScreenReadJob(job.jobId, query.limit);
    if (completion.screen !== 'EVENT_CATALOG') {
      throw new Error('BOOKING_SCREEN_READ_JOB_MISMATCH');
    }
    return completion.catalog;
  }

  async function loadClientAssistedUpcomingBookings(): Promise<UserUpcomingBookings> {
    let staleProjection: UserUpcomingBookings | undefined;
    try {
      const current = await client.getUpcomingBookings();
      if (Date.parse(current.staleAt) > Date.now()) return current;
      staleProjection = current;
    } catch {
      // An absent projection is prepared through the client-assisted job below.
    }
    try {
      const job = await client.startBookingScreenReadJob('MY_BOOKINGS');
      const command = job.commands.find((item) => item.operation === 'bookings.read');
      if (!command) throw new Error('BOOKING_SCREEN_READ_COMMAND_MISSING');
      try {
        const payload = await clientTransport.executeClientAssistedUpcomingBookingsRead({
          operation: command.operation,
          detailsOperation: command.detailsOperation,
          page: command.page,
          size: command.size,
        });
        await client.submitBookingScreenReadResult(job.jobId, command.commandId, payload);
      } catch {
        // Completion keeps an existing stale projection readable when Viva is unavailable.
      }
      await client.completeBookingScreenReadJob(job.jobId, 50);
      return await client.getUpcomingBookings();
    } catch (error) {
      if (staleProjection) return staleProjection;
      throw error;
    }
  }

  async function loadClientAssistedActivityHistory(
    input: ActivityHistoryQuery,
  ): Promise<ActivityHistoryPage> {
    let staleProjection: ActivityHistoryPage | undefined;
    if (!input.cursor) {
      try {
        const current = await client.listActivityHistory(input);
        if (current.freshness === 'FRESH') return current;
        staleProjection = current;
      } catch {
        // An uncovered projection must be prepared through the client-assisted job below.
      }
    }
    try {
      const job = await client.startActivityHistoryReadJob(input);
      const command = job.commands.find(
        (item): item is BookingScreenActivityHistoryReadCommand =>
          item.operation === 'bookings.history.read',
      );
      if (command) {
        try {
          const payload = await clientTransport.executeClientAssistedActivityHistoryRead({
            operation: command.operation,
            page: command.page,
            size: command.size,
          });
          await client.submitActivityHistoryReadResult(job.jobId, command.commandId, payload);
        } catch {
          // Completion records the missing provider page and keeps stale local data readable.
        }
      }
      await client.completeActivityHistoryReadJob(job.jobId);
    } catch {
      if (staleProjection) return staleProjection;
    }
    return client.listActivityHistory(input);
  }

  async function restore(): Promise<AuthenticatedSession | null> {
    try {
      const session = normalizeSession(await client.refreshSession());
      await consumeVivaHandoff().catch(() => undefined);
      return session;
    } catch (error) {
      client.clearAccessToken();
      if (isUnauthorized(error)) return null;
      throw error;
    }
  }

  async function retryMessagingCommand<TResult>(
    operation: () => Promise<TResult>,
  ): Promise<TResult> {
    try {
      return await operation();
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      return operation();
    }
  }

  // React StrictMode may subscribe twice during development. Coalescing keeps a
  // rotating refresh cookie from being exchanged twice at startup.
  let restorePromise: Promise<AuthenticatedSession | null> | undefined;

  return {
    restoreSession() {
      restorePromise ??= restore();
      return restorePromise;
    },

    async requestCode(phoneE164) {
      const challenge = await client.createAuthChallenge({ method: 'phone_otp', phone: phoneE164 });
      return {
        challengeId: challenge.challengeId,
        maskedPhone: maskPhone(phoneE164),
        expiresAt: challenge.expiresAt,
        resendAt: new Date(Date.now() + challenge.resendAfterSeconds * 1_000).toISOString(),
      };
    },

    async verifyCode(input) {
      if (!input.acceptance.publicOfferAccepted || !input.acceptance.personalDataPolicyAccepted) {
        throw new Error('Required legal acceptance is missing');
      }
      const session = await client.verifyAuthChallenge(input.challengeId, {
        code: input.code,
        acceptance: {
          publicOfferAccepted: true,
          personalDataPolicyAccepted: true,
        },
      });
      return normalizeSession(session);
    },

    async startVivaOAuth(input) {
      if (!input.acceptance.publicOfferAccepted || !input.acceptance.personalDataPolicyAccepted) {
        throw new Error('Required legal acceptance is missing');
      }
      const response = await client.createVivaOAuthAuthorization({
        provider: input.provider,
        acceptance: { publicOfferAccepted: true, personalDataPolicyAccepted: true },
      });
      if (!response.redirectUrl) throw new Error('Viva OAuth redirect is unavailable');
      window.location.assign(response.redirectUrl);
    },

    getVivaAccessToken() {
      return vivaAccessToken && vivaAccessExpiresAt > Date.now() + 30_000
        ? vivaAccessToken
        : undefined;
    },

    async refreshVivaAccessToken() {
      return applyVivaAccess();
    },

    issueRealtimeTicket() {
      return client.issueRealtimeTicket();
    },

    getRoutingPlan(forceRefresh = false) {
      return loadRoutingPlan(forceRefresh);
    },

    getSelfProfile() {
      return loadSelfProfile();
    },

    getUserProfile(userId) {
      if (userId !== currentUserId) return Promise.reject(new Error('PROFILE_SELF_REQUIRED'));
      return loadSelfProfile();
    },

    getPlayerProfile(userId) {
      if (userId === currentUserId) {
        return loadSelfProfile().then(buildSelfPlayerProfileView);
      }
      const cached = playerProfilePromises.get(userId);
      if (cached) return cached;
      const request = client.getPlayerProfile(userId);
      const guardedRequest = request.catch((error: unknown) => {
        if (playerProfilePromises.get(userId) === guardedRequest) {
          playerProfilePromises.delete(userId);
        }
        throw error;
      });
      playerProfilePromises.set(userId, guardedRequest);
      return guardedRequest;
    },

    getProfilePrivacy() {
      profilePrivacyPromise ??= client.getProfilePrivacySettings().catch((error: unknown) => {
        profilePrivacyPromise = undefined;
        throw error;
      });
      return profilePrivacyPromise;
    },

    async updateProfilePrivacy(input) {
      const settings = await client.updateProfilePrivacySettings(input);
      profilePrivacyPromise = Promise.resolve(settings);
      return settings;
    },

    listProfileFriends(limit) {
      return client.listProfileFriends(limit);
    },

    getProfileFriendship(userId) {
      return client.getProfileFriendship(userId);
    },

    addProfileFriend(userId) {
      return client.addProfileFriend(userId);
    },

    getBookingPreferences() {
      bookingPreferencesPromise ??= client.getBookingPreferences().catch((error: unknown) => {
        bookingPreferencesPromise = undefined;
        throw error;
      });
      return bookingPreferencesPromise;
    },

    async updateBookingPreferences(input) {
      const settings = await client.updateBookingPreferences(input);
      bookingPreferencesPromise = Promise.resolve(settings);
      return settings;
    },

    getUpcomingBookings() {
      if (upcomingBookingsPromise) return upcomingBookingsPromise;
      const request = loadClientAssistedUpcomingBookings().finally(() => {
        if (upcomingBookingsPromise === request) upcomingBookingsPromise = undefined;
      });
      upcomingBookingsPromise = request;
      return request;
    },

    listBookingRecommendations(input = {}) {
      if (input.cursor) return loadClientAssistedRecommendations(input);
      const limit = input.limit ?? 6;
      const cached = bookingRecommendationCache.get(limit);
      if (cached && cached.expiresAt > Date.now()) return Promise.resolve(cached.page);
      const pending = bookingRecommendationPromises.get(limit);
      if (pending) return pending;
      const request = loadClientAssistedRecommendations({ ...input, limit })
        .then((page) => {
          const staleAt = Date.parse(page.staleAt);
          if (Number.isFinite(staleAt) && staleAt > Date.now()) {
            bookingRecommendationCache.set(limit, {
              page,
              expiresAt: Math.min(staleAt, Date.now() + 60_000),
            });
          }
          return page;
        })
        .finally(() => {
          if (bookingRecommendationPromises.get(limit) === request) {
            bookingRecommendationPromises.delete(limit);
          }
        });
      bookingRecommendationPromises.set(limit, request);
      return request;
    },

    listHomeBookingRecommendations(input = {}) {
      if (input.cursor) return client.listBookingRecommendations(input);
      const limit = input.limit ?? 6;
      const phase = input.phase ?? 'INITIAL';
      const promiseKey = `${phase}:${limit}`;
      if (phase === 'INITIAL') {
        const cached = homeBookingRecommendationCache.get(limit);
        if (cached && cached.expiresAt > Date.now()) return Promise.resolve(cached.page);
      }
      const pending = homeBookingRecommendationPromises.get(promiseKey);
      if (pending) return pending;
      const request = (
        phase === 'EXPANDED'
          ? loadExpandedHomeRecommendations(limit)
          : phase === 'TOURNAMENTS'
            ? loadHomeTournamentRecommendations(limit)
            : loadInitialHomeRecommendations(limit)
      )
        .then((page) => {
          const staleAt = Date.parse(page.staleAt);
          if (Number.isFinite(staleAt) && staleAt > Date.now()) {
            homeBookingRecommendationCache.set(limit, {
              page,
              expiresAt: Math.min(staleAt, Date.now() + 60_000),
            });
          }
          return page;
        })
        .finally(() => {
          if (homeBookingRecommendationPromises.get(promiseKey) === request) {
            homeBookingRecommendationPromises.delete(promiseKey);
          }
        });
      homeBookingRecommendationPromises.set(promiseKey, request);
      return request;
    },

    recordPromotionEngagement(promotionId, kind) {
      return client.recordPromotionEngagement(promotionId, kind);
    },

    listTrainingSchedule() {
      if (trainingScheduleCache && trainingScheduleCache.expiresAt > Date.now()) {
        return Promise.resolve(trainingScheduleCache.page);
      }
      if (trainingSchedulePromise) return trainingSchedulePromise;
      const request = loadClientAssistedTrainingSchedule()
        .then((page) => {
          const staleAt = Date.parse(page.staleAt);
          if (Number.isFinite(staleAt) && staleAt > Date.now()) {
            trainingScheduleCache = {
              page,
              expiresAt: Math.min(staleAt, Date.now() + 60_000),
            };
          }
          return page;
        })
        .finally(() => {
          if (trainingSchedulePromise === request) trainingSchedulePromise = undefined;
        });
      trainingSchedulePromise = request;
      return request;
    },

    listEventCatalog(query) {
      return loadClientAssistedEventCatalog(query);
    },

    continueEventCatalog(cursor, limit) {
      return client.continueEventCatalog(cursor, limit);
    },

    getHomeBase() {
      if (homeBasePromise) return homeBasePromise;
      const request = client
        .getHomeBase()
        .then((homeBase) => {
          if (!currentUserId || homeBase.viewerUserId !== currentUserId) {
            throw new Error('HOME_BASE_VIEWER_MISMATCH');
          }
          return homeBase;
        })
        .finally(() => {
          if (homeBasePromise === request) homeBasePromise = undefined;
        });
      homeBasePromise = request;
      return request;
    },

    getHomeDashboard() {
      if (homeDashboardPromise) return homeDashboardPromise;
      const request = client.getHomeDashboard().finally(() => {
        if (homeDashboardPromise === request) homeDashboardPromise = undefined;
      });
      homeDashboardPromise = request;
      return request;
    },

    getPublicGiftCertificateCatalog() {
      return client.getPublicGiftCertificateCatalog();
    },

    createPublicGiftCertificateOrder(input) {
      return client.createPublicGiftCertificateOrder(input);
    },

    async createPublicGiftCertificatePaymentIntent(orderId) {
      return resolvePaymentIntent(await client.createPublicGiftCertificatePaymentIntent(orderId));
    },

    getPublicGiftCertificateOrder(orderId) {
      return client.getPublicGiftCertificateOrder(orderId);
    },

    downloadPublicGiftCertificate(orderId) {
      return client.downloadPublicGiftCertificate(orderId);
    },

    createGiftCertificateOrder(input) {
      return client.createGiftCertificateOrder(input);
    },

    async createGiftCertificatePaymentIntent(orderId) {
      return resolvePaymentIntent(await client.createGiftCertificatePaymentIntent(orderId));
    },

    getGiftCertificateOrder(orderId) {
      return client.getGiftCertificateOrder(orderId);
    },

    downloadGiftCertificate(orderId) {
      return client.downloadGiftCertificate(orderId);
    },

    listPublicGames(input = {}) {
      return client.listPublicGames(input);
    },

    listPublicTournamentSummaries(input) {
      return client.listPublicTournamentSummaries(input);
    },

    getPublicTournamentSummary(summaryId, input) {
      const promiseKey = `${summaryId}:${input.dateFrom}:${input.dateTo}`;
      const pending = publicTournamentSummaryPromises.get(promiseKey);
      if (pending) return pending;
      const request = client.getPublicTournamentSummary(summaryId, input).finally(() => {
        if (publicTournamentSummaryPromises.get(promiseKey) === request) {
          publicTournamentSummaryPromises.delete(promiseKey);
        }
      });
      publicTournamentSummaryPromises.set(promiseKey, request);
      return request;
    },

    getTournamentParticipants(tournamentId) {
      return client.getTournamentParticipants(tournamentId);
    },

    listPublicCoachGameSummaries(input) {
      return client.listPublicCoachGameSummaries(input);
    },

    listMyGames(input = {}) {
      return client.listMyGames(input);
    },

    getActivityHistory(input = {}) {
      return loadClientAssistedActivityHistory(input);
    },

    getGame(gameId) {
      return client.getGame(gameId);
    },

    joinGame(gameId, expectedRevision) {
      return client.joinGame(gameId, expectedRevision);
    },

    leaveGame(gameId) {
      return client.leaveGame(gameId);
    },

    joinGameWaitlist(gameId) {
      return client.joinGameWaitlist(gameId);
    },

    leaveGameWaitlist(gameId) {
      return client.leaveGameWaitlist(gameId);
    },

    submitGameResult(gameId, input) {
      return client.submitGameResult(gameId, input);
    },

    confirmGameResult(gameId, submissionId) {
      return client.confirmGameResult(gameId, submissionId);
    },

    disputeGameResult(gameId, submissionId, input) {
      return client.disputeGameResult(gameId, submissionId, input);
    },

    getGameOperation(operationId) {
      return client.getGameOperation(operationId);
    },

    listLocations() {
      if (locationsPromise) return locationsPromise;
      const request = client.listLocations().finally(() => {
        if (locationsPromise === request) locationsPromise = undefined;
      });
      locationsPromise = request;
      return request;
    },

    getLocation(locationId) {
      return client.getLocation(locationId);
    },

    listMyCommunities(cursor, limit = 20) {
      if (cursor) return client.listMyCommunities({ limit, cursor });
      const pending = communityMembershipPagePromises.get(limit);
      if (pending) return pending;
      const request = client.listMyCommunities({ limit }).finally(() => {
        if (communityMembershipPagePromises.get(limit) === request) {
          communityMembershipPagePromises.delete(limit);
        }
      });
      communityMembershipPagePromises.set(limit, request);
      return request;
    },

    discoverCommunities(query, cursor, limit = 20) {
      return client.discoverCommunities({
        limit,
        ...(query ? { query } : {}),
        ...(cursor ? { cursor } : {}),
      });
    },

    getCommunityDetail(communityId) {
      return client.getCommunityDetail(communityId);
    },

    getMyCommunityMembershipState(communityId) {
      return client.getMyCommunityMembershipState(communityId);
    },

    joinOrRequestCommunityMembership(communityId, expectedMembershipRevision) {
      return client.joinOrRequestCommunityMembership(communityId, {
        expectedMembershipRevision,
      });
    },

    cancelMyCommunityJoinRequest(
      communityId,
      requestId,
      expectedMembershipRevision,
      expectedRequestRevision,
    ) {
      return client.cancelMyCommunityJoinRequest(communityId, requestId, {
        expectedMembershipRevision,
        expectedRequestRevision,
      });
    },

    leaveCommunity(communityId, expectedMembershipRevision) {
      return client.leaveCommunity(communityId, { expectedMembershipRevision });
    },

    listCommunityFeed(communityId, cursor) {
      return client.listCommunityFeed(communityId, {
        limit: 20,
        ...(cursor ? { cursor } : {}),
      });
    },

    recoverCommunityEvents(communityId, input) {
      return client.recoverCommunityEvents(communityId, input);
    },

    createCommunityPost(communityId, input) {
      return client.createCommunityPost(communityId, input);
    },

    issueCommunityMediaUpload(communityId, input) {
      return client.issueCommunityMediaUpload(communityId, input);
    },

    finalizeCommunityMediaUpload(communityId, mediaId, expectedRevision) {
      return client.finalizeCommunityMediaUpload(communityId, mediaId, { expectedRevision });
    },

    getCommunityMediaStatus(communityId, mediaId) {
      return client.getCommunityMediaStatus(communityId, mediaId);
    },

    downloadCommunityMediaVariant(communityId, mediaId, variant) {
      return client.downloadCommunityMediaVariant(communityId, mediaId, variant);
    },

    previewCommunityDirectInvite(token) {
      return client.previewCommunityDirectInvite({ token });
    },

    redeemCommunityDirectInvite(token, expectedInviteRevision, expectedMembershipRevision) {
      return client.redeemCommunityDirectInvite({
        token,
        expectedInviteRevision,
        expectedMembershipRevision,
      });
    },

    listCommunityDirectInvites(communityId, cursor) {
      return client.listCommunityDirectInvites(communityId, {
        limit: 20,
        ...(cursor ? { cursor } : {}),
      });
    },

    createCommunityDirectInvite(communityId, expectedIssuerMembershipRevision) {
      return client.createCommunityDirectInvite(communityId, {
        expectedIssuerMembershipRevision,
      });
    },

    revokeCommunityDirectInvite(inviteId, expectedInviteRevision) {
      return client.revokeCommunityDirectInvite(inviteId, { expectedInviteRevision });
    },

    getProfileLevelHistory() {
      return client.getProfileLevelHistory();
    },

    listConversations() {
      return client.request<ConversationPage>('/conversations?limit=50');
    },

    createRealtimeTicket() {
      return client.issueMessagingRealtimeTicket();
    },

    createDirectConversation(otherUserId, idempotencyKey) {
      return retryMessagingCommand(() =>
        client.request<CreateDirectConversationResult>('/conversations/direct', {
          method: 'POST',
          idempotencyKey,
          body: JSON.stringify({ otherUserId }),
        }),
      );
    },

    getOrCreateGameConversation(gameId) {
      return client.getOrCreateGameConversation(gameId);
    },

    listConversationMessages(conversationId, afterSequence = 0) {
      const query = new URLSearchParams({
        afterSequence: String(afterSequence),
        limit: '100',
      });
      return client.request<ConversationMessagePage>(
        `/conversations/${encodeURIComponent(conversationId)}/messages?${query.toString()}`,
      );
    },

    sendConversationMessage(conversationId, command) {
      return retryMessagingCommand(() =>
        client.request<SendConversationMessageResult>(
          `/conversations/${encodeURIComponent(conversationId)}/messages`,
          {
            method: 'POST',
            idempotencyKey: command.clientMessageId,
            body: JSON.stringify(command),
          },
        ),
      );
    },

    markConversationRead(conversationId, throughSequence, idempotencyKey) {
      return retryMessagingCommand(() =>
        client.request<ConversationReadCursorResult>(
          `/conversations/${encodeURIComponent(conversationId)}/read-cursor`,
          {
            method: 'PUT',
            idempotencyKey,
            body: JSON.stringify({ throughSequence }),
          },
        ),
      );
    },

    listNotifications() {
      if (notificationsCache && notificationsCache.expiresAt > Date.now()) {
        return Promise.resolve(notificationsCache.page);
      }
      if (notificationsPromise) return notificationsPromise;
      const revision = notificationsCacheRevision;
      const request = client
        .listNotifications({ limit: 50 })
        .then((page) => {
          if (notificationsCacheRevision === revision) {
            notificationsCache = {
              page,
              expiresAt: Date.now() + NOTIFICATION_CACHE_TTL_MS,
            };
          }
          return page;
        })
        .finally(() => {
          if (notificationsPromise === request) notificationsPromise = undefined;
        });
      notificationsPromise = request;
      return request;
    },

    async markNotificationsRead(throughId) {
      await client.markNotificationsRead(throughId);
      notificationsCacheRevision += 1;
      notificationsCache = undefined;
      notificationsPromise = undefined;
    },

    getWebPushConfiguration() {
      return client.getWebPushConfiguration();
    },

    registerWebPushEndpoint(input) {
      return client.registerWebPushEndpoint(input);
    },

    revokeWebPushEndpoint(installationId) {
      return client.revokeWebPushEndpoint(installationId);
    },

    async logout() {
      await client.revokeSession();
      vivaAccessToken = undefined;
      vivaAccessExpiresAt = 0;
      homeBasePromise = undefined;
      homeDashboardPromise = undefined;
      locationsPromise = undefined;
      communityMembershipPagePromises.clear();
      routingPlan = undefined;
      routingPlanPromise = undefined;
      selfProfilePromise = undefined;
      currentUserId = undefined;
      playerProfilePromises.clear();
      profilePrivacyPromise = undefined;
      bookingPreferencesPromise = undefined;
      upcomingBookingsPromise = undefined;
      bookingRecommendationPromises.clear();
      bookingRecommendationCache.clear();
      homeBookingRecommendationPromises.clear();
      homeBookingRecommendationCache.clear();
      homeBookingRecommendationExpansions.clear();
      trainingSchedulePromise = undefined;
      trainingScheduleCache = undefined;
      notificationsCacheRevision += 1;
      notificationsPromise = undefined;
      notificationsCache = undefined;
    },
  };
}
