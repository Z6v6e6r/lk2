import type { components, PublicApiComponents, UserApiV2Components } from '@phub/api-contracts';

export type AuthChallengeRequest = components['schemas']['AuthChallengeRequest'];
export type AuthChallenge = components['schemas']['AuthChallenge'];
export type VerifyAuthChallengeRequest = components['schemas']['VerifyAuthChallengeRequest'];
export type AuthenticatedSession = components['schemas']['AuthenticatedSession'];
export type AuthenticatedUser = components['schemas']['AuthenticatedUser'];
export type UserContext = components['schemas']['UserContext'];
export type UserRuntimeCapabilities = components['schemas']['UserRuntimeCapabilities'];
export type RealtimeTicket = components['schemas']['RealtimeTicket'];
export type HomeDashboard = components['schemas']['HomeDashboard'];
export type HomeBase = components['schemas']['HomeBase'];
export type LocationList = components['schemas']['LocationList'];
export type LocationDetail = components['schemas']['LocationDetail'];
export type CommunityMembershipPage = components['schemas']['CommunityMembershipPage'];
export type CommunityReadExperienceDetail = components['schemas']['CommunityReadExperienceDetail'];
export type CommunityReadExperienceFeedPage =
  components['schemas']['CommunityReadExperienceFeedPage'];
export type CommunityReadExperienceChatPage =
  components['schemas']['CommunityReadExperienceChatPage'];
export type CommunityReadExperienceRating = components['schemas']['CommunityReadExperienceRating'];
export type CommunityCreateRequest = components['schemas']['CommunityCreateRequest'];
export type CommunityCreatedState = components['schemas']['CommunityCreatedState'];
export type CommunityDiscoveryPage = components['schemas']['CommunityDiscoveryPage'];
export type CommunityDiscoveryItem = components['schemas']['CommunityDiscoveryItem'];
export type CommunityDetailView = components['schemas']['CommunityDetailView'];
export type CommunityJoinAction = components['schemas']['CommunityJoinAction'];
export type CommunityJoinRequestState = components['schemas']['CommunityJoinRequestState'];
export type CommunityOwnMembershipState = components['schemas']['CommunityOwnMembershipState'];
export type CommunityMembershipRevisionRequest =
  components['schemas']['CommunityMembershipRevisionRequest'];
export type CommunityJoinRequestCancelRequest =
  components['schemas']['CommunityJoinRequestCancelRequest'];
export type CommunityDirectInviteCreateRequest =
  components['schemas']['CommunityDirectInviteCreateRequest'];
export type CommunityDirectInviteTokenRequest =
  components['schemas']['CommunityDirectInviteTokenRequest'];
export type CommunityDirectInviteRedeemRequest =
  components['schemas']['CommunityDirectInviteRedeemRequest'];
export type CommunityDirectInviteRevokeRequest =
  components['schemas']['CommunityDirectInviteRevokeRequest'];
export type CommunityDirectInviteCreated = components['schemas']['CommunityDirectInviteCreated'];
export type CommunityDirectInviteState = components['schemas']['CommunityDirectInviteState'];
export type CommunityDirectInvitePage = components['schemas']['CommunityDirectInvitePage'];
export type CommunityDirectInvitePreview = components['schemas']['CommunityDirectInvitePreview'];
export type CommunityMembershipPinRequest = components['schemas']['CommunityMembershipPinRequest'];
export type CommunityMembershipPinState = components['schemas']['CommunityMembershipPinState'];
export type CommunityOwnershipTransferRequest =
  components['schemas']['CommunityOwnershipTransferRequest'];
export type CommunityOwnershipTransferState =
  components['schemas']['CommunityOwnershipTransferState'];
export type CommunityPost = components['schemas']['CommunityPost'];
export type CommunityFeedPage = components['schemas']['CommunityFeedPage'];
export type CommunityRealtimeEvent = components['schemas']['CommunityRealtimeEvent'];
export type CommunityRealtimeEventPage = components['schemas']['CommunityRealtimeEventPage'];
export type CommunityPostCreateRequest = components['schemas']['CommunityPostCreateRequest'];
export type CommunityPostEditRequest = components['schemas']['CommunityPostEditRequest'];
export type CommunityContentRevisionRequest =
  components['schemas']['CommunityContentRevisionRequest'];
export type CommunityComment = components['schemas']['CommunityComment'];
export type CommunityCommentPage = components['schemas']['CommunityCommentPage'];
export type CommunityCommentCreateRequest = components['schemas']['CommunityCommentCreateRequest'];
export type CommunityCommentEditRequest = components['schemas']['CommunityCommentEditRequest'];
export type CommunityReactionRequest = components['schemas']['CommunityReactionRequest'];
export type CommunityReactionState = components['schemas']['CommunityReactionState'];
export type CommunityMediaContentType = components['schemas']['CommunityMediaContentType'];
export type CommunityMediaState = components['schemas']['CommunityMediaState'];
export type CommunityMediaVariantName = components['schemas']['CommunityMediaVariantName'];
export type CommunityMediaVariant = components['schemas']['CommunityMediaVariant'];
export type CommunityPostMedia = components['schemas']['CommunityPostMedia'];
export type CommunityMediaUploadIssueRequest =
  components['schemas']['CommunityMediaUploadIssueRequest'];
export type CommunityMediaUploadIssued = components['schemas']['CommunityMediaUploadIssued'];
export type CommunityMediaFinalizeRequest = components['schemas']['CommunityMediaFinalizeRequest'];
export type CommunityMediaStatus = components['schemas']['CommunityMediaStatus'];
export type ClientRoutingPlan = components['schemas']['ClientRoutingPlan'];
export type UserProfile = components['schemas']['UserProfile'];
export type PlayerProfileView = components['schemas']['PlayerProfileView'];
export type ProfileActionCapability = components['schemas']['ProfileActionCapability'];
export type ProfilePrivacySettings = components['schemas']['ProfilePrivacySettings'];
export type ProfilePrivacyUpdateRequest = components['schemas']['ProfilePrivacyUpdateRequest'];
export type ProfileFriendship = components['schemas']['ProfileFriendship'];
export type ProfileFriendSummary = components['schemas']['ProfileFriendSummary'];
export type ProfileFriendPage = components['schemas']['ProfileFriendPage'];
export type ProfileLevelHistory = components['schemas']['ProfileLevelHistory'];
export type ProfileLevelHistoryPoint = components['schemas']['ProfileLevelHistoryPoint'];
export interface CanonicalProfileLevel {
  readonly id: string;
  readonly sportCode: string;
  readonly code: string;
  readonly title: string;
  readonly rank: number;
  readonly sortOrder: number;
  readonly aliases: readonly string[];
  readonly active: boolean;
  readonly scaleVersion: number;
}
export interface PlayerSportLevel {
  readonly playerId: string;
  readonly sportCode: string;
  readonly levelId: string;
  readonly code: string;
  readonly title: string;
  readonly rank: number;
  readonly source: 'SELF_DECLARED' | 'ONBOARDING' | 'MANUAL' | 'CALCULATED' | 'VIVA' | 'MIGRATED';
  readonly numericValue: number | null;
  readonly scaleVersion: number;
  readonly updatedAt: string;
}
export interface PlayerLevelState {
  readonly sportCode: string;
  readonly scaleVersion: number | null;
  readonly levels: readonly CanonicalProfileLevel[];
  readonly currentLevel: PlayerSportLevel | null;
}
export interface LevelAssessmentOption {
  readonly id: string;
  readonly label: string;
}
export interface LevelAssessmentQuestion {
  readonly id: string;
  readonly text: string;
  readonly type: 'single' | 'multi';
  readonly options: readonly LevelAssessmentOption[];
}
export interface LevelAssessmentDefinition {
  readonly version: 'padel-self-assessment-v1';
  readonly sportCode: 'PADEL';
  readonly baseQuestionId: string;
  readonly questions: readonly LevelAssessmentQuestion[];
  readonly branches: Readonly<Record<string, readonly string[]>>;
}
export interface CompleteLevelAssessmentResponse {
  readonly assessment: {
    readonly version: string;
    readonly numericScore: number;
    readonly levelCode: string;
  };
  readonly level: PlayerSportLevel;
}
export type BookingPreferences = components['schemas']['BookingPreferences'];
export type BookingPreferencesUpdateRequest =
  components['schemas']['BookingPreferencesUpdateRequest'];
export type BookingRecommendationPage = components['schemas']['BookingRecommendationPage'];
export type TrainingSchedulePage = components['schemas']['TrainingSchedulePage'];
export type EventCatalogQuery = components['schemas']['EventCatalogQuery'];
export type EventCatalogPage = UserApiV2Components['schemas']['EventCatalogPage'];
export type EventCatalogItem = EventCatalogPage['items'][number];
export type EventCatalogFacets = NonNullable<EventCatalogPage['facets']>;
export type EventCatalogSourceStatus = EventCatalogPage['sourceStatus'][number];
export type UserUpcomingBookings = components['schemas']['UserUpcomingBookings'];
export type ActivityHistoryKind = components['schemas']['ActivityHistoryKind'];
export type ActivityHistoryStatus = components['schemas']['ActivityHistoryStatus'];
export type ActivityHistoryItem = components['schemas']['ActivityHistoryItem'];
export type ActivityHistoryPage = components['schemas']['ActivityHistoryPage'];
export type ConversationPage = components['schemas']['ConversationPage'];
export type ConversationSummary = components['schemas']['ConversationSummary'];
export type ConversationMessagePage = components['schemas']['ConversationMessagePage'];
export type ConversationMessage = components['schemas']['ConversationMessage'];
export type CreateDirectConversationResult =
  components['schemas']['CreateDirectConversationResult'];
export type GameConversationSummary = components['schemas']['GameConversationSummary'];
export type GetOrCreateGameConversationResult =
  components['schemas']['GetOrCreateGameConversationResult'];
export type SendConversationMessageResult = components['schemas']['SendConversationMessageResult'];
export type ConversationReadCursorResult = components['schemas']['ConversationReadCursorResult'];
export type MessagingRealtimeTicket = components['schemas']['MessagingRealtimeTicket'];
export type NotificationInboxPage = components['schemas']['NotificationInboxPage'];
export type NotificationReadCursorResult = components['schemas']['NotificationReadCursorResult'];
export type WebPushConfiguration = components['schemas']['WebPushConfiguration'];
export type WebPushEndpointRegistration = components['schemas']['WebPushEndpointRegistration'];
export type WebPushEndpointCommandResult = components['schemas']['WebPushEndpointCommandResult'];
export type GameCard = components['schemas']['GameCardView'];
export type GameCardPage = components['schemas']['GameCardPage'];
export type GameCommandResult = components['schemas']['GameCommandResult'];
export type ParticipationDecision = components['schemas']['ParticipationDecision'];
export type SubmitGameResultRequest = components['schemas']['SubmitGameResultRequest'];
export type DisputeGameResultRequest = components['schemas']['DisputeGameResultRequest'];
export type PublicGameCard = PublicApiComponents['schemas']['PublicGameCard'];
export type PublicGameCardPage = PublicApiComponents['schemas']['PublicGameCardPage'];
export type PublicTournamentSummary = PublicApiComponents['schemas']['PublicTournamentSummary'];
export type PublicTournamentSummaryPage =
  PublicApiComponents['schemas']['PublicTournamentSummaryPage'];
export type TournamentParticipant = components['schemas']['TournamentParticipant'];
export type TournamentParticipantRoster = components['schemas']['TournamentParticipantRoster'];
export type PublicGiftCertificateCatalog =
  PublicApiComponents['schemas']['PublicGiftCertificateCatalog'];
export type CreateGiftCertificateOrderRequest =
  PublicApiComponents['schemas']['CreateGiftCertificateOrderRequest'];
export type GiftCertificateOrder = PublicApiComponents['schemas']['GiftCertificateOrder'];
export type GiftCertificateOrderCommandResult =
  PublicApiComponents['schemas']['GiftCertificateOrderCommandResult'];
export type GiftCertificatePaymentIntent =
  PublicApiComponents['schemas']['GiftCertificatePaymentIntent'];
export type GiftCertificatePaymentConfirmation =
  PublicApiComponents['schemas']['GiftCertificatePaymentConfirmation'];

export interface PublicGameFilters {
  readonly stationId?: string;
  readonly startsFrom?: string;
  readonly startsTo?: string;
  readonly kind?: components['schemas']['GameKind'];
  readonly levelFrom?: components['schemas']['GamePlayerLevel'];
  readonly levelTo?: components['schemas']['GamePlayerLevel'];
  readonly availability?: 'JOINABLE' | 'INCLUDE_FULL';
  readonly limit?: number;
  readonly cursor?: string;
}

export interface PublicTournamentFilters {
  readonly dateFrom: string;
  readonly dateTo: string;
  readonly availability?: 'JOINABLE' | 'INCLUDE_FULL';
  readonly limit?: number;
}

export interface PublicTournamentSummaryRange {
  readonly dateFrom: string;
  readonly dateTo: string;
}

export interface ActivityHistoryFilters {
  readonly kind?: ActivityHistoryKind;
  readonly status?: ActivityHistoryStatus;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface BookingRecommendationFilters {
  readonly limit?: number;
  readonly cursor?: string;
}

export interface ProfilePhotoSyncResult {
  readonly avatarUrl: string;
  readonly replayed: boolean;
}

export interface ProfilePhotoRemoveResult {
  readonly removed: boolean;
  readonly replayed: boolean;
}

export interface VivaDelegatedAccess {
  readonly accessToken: string;
  readonly expiresAt: string;
  readonly profilePhotoGrant: string;
  readonly profilePhoto?: {
    readonly avatarUrl: string;
    readonly syncedAt: string;
  } | null;
}

export interface CommunityDiscoveryFilters {
  readonly query?: string;
  readonly limit?: number;
  readonly cursor?: string;
}

function normalizeBookingPreferences(settings: BookingPreferences): BookingPreferences {
  const candidate = settings as Partial<BookingPreferences>;
  return {
    ...settings,
    recommendFriends:
      typeof candidate.recommendFriends === 'boolean' ? candidate.recommendFriends : true,
    recommendationDisplay:
      candidate.recommendationDisplay === 'ROWS' ? candidate.recommendationDisplay : 'CARDS',
  };
}

export interface BookingScreenScheduleReadCommand {
  readonly commandId: string;
  readonly operation: 'schedule.read';
  readonly date: string;
}

export interface BookingScreenUpcomingReadCommand {
  readonly commandId: string;
  readonly operation: 'bookings.read';
  readonly detailsOperation: 'bookings.details.read';
  readonly page: 0;
  readonly size: 50;
}

export interface BookingScreenActivityHistoryReadCommand {
  readonly commandId: string;
  readonly operation: 'bookings.history.read';
  readonly page: number;
  readonly size: number;
}

export type BookingScreenReadCommand =
  | BookingScreenScheduleReadCommand
  | BookingScreenUpcomingReadCommand
  | BookingScreenActivityHistoryReadCommand;

export interface BookingScreenReadJob {
  readonly jobId: string;
  readonly screen:
    'FOR_ME' | 'GROUP_TRAININGS' | 'MY_BOOKINGS' | 'EVENT_CATALOG' | 'ACTIVITY_HISTORY';
  readonly expiresAt: string;
  readonly commands: readonly BookingScreenReadCommand[];
  readonly concurrency: number;
}

export interface BookingScreenRecommendationReadCompletion {
  readonly screen: 'FOR_ME';
  readonly state: 'READY' | 'PARTIAL';
  readonly completedCommands: number;
  readonly totalCommands: number;
  readonly page: BookingRecommendationPage;
}

export interface BookingScreenUpcomingReadCompletion {
  readonly screen: 'MY_BOOKINGS';
  readonly state: 'READY' | 'PARTIAL';
  readonly completedCommands: number;
  readonly totalCommands: number;
  readonly bookings: UserUpcomingBookings;
}

export interface BookingScreenTrainingScheduleReadCompletion {
  readonly screen: 'GROUP_TRAININGS';
  readonly state: 'READY' | 'PARTIAL';
  readonly completedCommands: number;
  readonly totalCommands: number;
  readonly trainings: TrainingSchedulePage;
}

export interface BookingScreenEventCatalogReadCompletion {
  readonly screen: 'EVENT_CATALOG';
  readonly state: 'READY' | 'PARTIAL';
  readonly completedCommands: number;
  readonly totalCommands: number;
  readonly catalog: EventCatalogPage;
}

export interface ActivityHistoryReadCompletion {
  readonly screen: 'ACTIVITY_HISTORY';
  readonly state: 'READY' | 'PARTIAL';
  readonly completedCommands: number;
  readonly totalCommands: number;
}

export type BookingScreenReadCompletion =
  | BookingScreenRecommendationReadCompletion
  | BookingScreenTrainingScheduleReadCompletion
  | BookingScreenEventCatalogReadCompletion
  | BookingScreenUpcomingReadCompletion;

export type RequestAuthMode = 'none' | 'required';
export type SessionIntent = 'refresh' | 'logout';

export type VivaOAuthProvider = 'vkid' | 'yandex';

export type ApiRequestInit = RequestInit & {
  readonly auth?: RequestAuthMode;
  readonly idempotencyKey?: string;
  readonly retryOnUnauthorized?: boolean;
  readonly sessionIntent?: SessionIntent;
};

export interface ApiClientOptions {
  readonly baseUrl: string;
  readonly tenantKey: string;
  readonly initialAccessToken?: string;
  readonly platform: 'web' | 'ios' | 'android' | 'cup-admin';
  readonly appVersion: string;
  readonly appBuild?: string;
  readonly fetchImplementation?: typeof fetch;
}

export class ApiClientError extends Error {
  public constructor(
    message: string,
    public readonly status: number,
    public readonly code: string,
    public readonly correlationId: string,
    public readonly eligibility?: ParticipationDecision,
  ) {
    super(message);
    this.name = 'ApiClientError';
  }
}

export class CommunityEventGapExpiredError extends ApiClientError {
  public readonly recoveryAction = 'FULL_CANONICAL_RELOAD' as const;

  public constructor(
    message: string,
    correlationId: string,
    public readonly latestSequence: number,
    public readonly retainedFromSequence: number,
  ) {
    super(message, 409, 'COMMUNITY_EVENT_GAP_EXPIRED', correlationId);
    this.name = 'CommunityEventGapExpiredError';
  }
}

interface RequestPolicy {
  readonly auth: RequestAuthMode;
  readonly idempotencyKey?: string;
  readonly retryOnUnauthorized: boolean;
  readonly sessionIntent?: SessionIntent;
  readonly requestInit: RequestInit;
}

type HeaderRecord = Record<string, string>;

let fallbackRequestSequence = 0;

function createCorrelationId(): string {
  const webCrypto = typeof globalThis === 'object' ? globalThis.crypto : undefined;
  if (typeof webCrypto?.randomUUID === 'function') return webCrypto.randomUUID();

  // Correlation and idempotency keys are opaque operation identifiers, not
  // credentials. Some embedded browsers expose fetch but omit Web Crypto, so
  // retain retry safety instead of failing before the request can be sent.
  fallbackRequestSequence = (fallbackRequestSequence + 1) % Number.MAX_SAFE_INTEGER;
  return `phub-${Date.now().toString(36)}-${fallbackRequestSequence.toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 14)}`;
}

function createHeaderRecord(init: HeadersInit | undefined): HeaderRecord {
  if (!init) return {};
  if (Array.isArray(init)) {
    return Object.fromEntries(init.map(([name, value]) => [name, String(value)]));
  }

  const possibleHeaders = init as { readonly forEach?: unknown };
  if (typeof possibleHeaders.forEach === 'function') {
    const values: HeaderRecord = {};
    (possibleHeaders as { forEach(callback: (value: string, name: string) => void): void }).forEach(
      (value, name) => {
        values[name] = value;
      },
    );
    return values;
  }

  return Object.fromEntries(
    Object.entries(init as Record<string, string>).map(([name, value]) => [name, String(value)]),
  );
}

function findHeaderName(headers: HeaderRecord, name: string): string | undefined {
  const normalizedName = name.toLowerCase();
  return Object.keys(headers).find((candidate) => candidate.toLowerCase() === normalizedName);
}

function setHeader(headers: HeaderRecord, name: string, value: string): void {
  const existingName = findHeaderName(headers, name);
  if (existingName) delete headers[existingName];
  headers[name] = value;
}

function deleteHeader(headers: HeaderRecord, name: string): void {
  const existingName = findHeaderName(headers, name);
  if (existingName) delete headers[existingName];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isAuthenticatedSession(value: unknown): value is AuthenticatedSession {
  if (!isRecord(value) || !isRecord(value.user) || !isRecord(value.context)) return false;
  return (
    typeof value.accessToken === 'string' &&
    value.accessToken.length > 0 &&
    value.tokenType === 'Bearer' &&
    typeof value.expiresAt === 'string' &&
    typeof value.user.id === 'string' &&
    typeof value.user.displayName === 'string' &&
    typeof value.context.tenantId === 'string' &&
    typeof value.context.userId === 'string'
  );
}

function jsonRequestBody(value: unknown): string {
  return JSON.stringify(value);
}

export class PadlHubApiClient {
  private readonly fetchImplementation: typeof fetch;
  private readonly apiRoot: string;
  private readonly apiV2Root: string;
  private readonly publicApiRoot: string;
  private accessToken: string | undefined;
  private refreshInFlight: Promise<AuthenticatedSession> | undefined;

  public constructor(private readonly options: ApiClientOptions) {
    this.fetchImplementation =
      options.fetchImplementation ?? ((input, init) => globalThis.fetch(input, init));
    this.apiRoot = `${options.baseUrl.replace(/\/$/, '')}/user/api/v1/${encodeURIComponent(options.tenantKey)}`;
    this.apiV2Root = `${options.baseUrl.replace(/\/$/, '')}/user/api/v2/${encodeURIComponent(options.tenantKey)}`;
    this.publicApiRoot = `${options.baseUrl.replace(/\/$/, '')}/public/api/v1/${encodeURIComponent(options.tenantKey)}`;
    this.accessToken = options.initialAccessToken?.trim() || undefined;
  }

  public setAccessToken(accessToken: string | undefined): void {
    const normalized = accessToken?.trim();
    this.accessToken = normalized ? normalized : undefined;
  }

  public clearAccessToken(): void {
    this.setAccessToken(undefined);
  }

  public getAccessToken(): string | undefined {
    return this.accessToken;
  }

  private resolveApiMediaUrl(url: string): string {
    return url.startsWith('/')
      ? new URL(url, `${this.options.baseUrl.replace(/\/$/, '')}/`).toString()
      : url;
  }

  public async request<TResponse>(path: string, init: ApiRequestInit = {}): Promise<TResponse> {
    const {
      auth = 'required',
      idempotencyKey,
      retryOnUnauthorized = true,
      sessionIntent,
      ...requestInit
    } = init;
    const policy: RequestPolicy = {
      auth,
      retryOnUnauthorized,
      requestInit,
      ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
      ...(sessionIntent === undefined ? {} : { sessionIntent }),
    };
    return this.requestWithPolicy<TResponse>(path, policy, createCorrelationId(), true);
  }

  public createAuthChallenge(input: AuthChallengeRequest): Promise<AuthChallenge> {
    const idempotencyKey = createCorrelationId();
    return this.retryOnceOnNetworkFailure(() =>
      this.request<AuthChallenge>('/auth/challenges', {
        method: 'POST',
        auth: 'none',
        credentials: 'include',
        idempotencyKey,
        body: jsonRequestBody(input),
      }),
    );
  }

  public async verifyAuthChallenge(
    challengeId: string,
    input: VerifyAuthChallengeRequest,
  ): Promise<AuthenticatedSession> {
    const idempotencyKey = createCorrelationId();
    const session = await this.retryOnceOnNetworkFailure(() =>
      this.request<AuthenticatedSession>(
        `/auth/challenges/${encodeURIComponent(challengeId)}/verify`,
        {
          method: 'POST',
          auth: 'none',
          credentials: 'include',
          idempotencyKey,
          body: jsonRequestBody(input),
        },
      ),
    );
    this.applyAuthenticatedSession(session);
    return session;
  }

  public createVivaOAuthAuthorization(input: {
    readonly provider: VivaOAuthProvider;
    readonly acceptance: {
      readonly publicOfferAccepted: true;
      readonly personalDataPolicyAccepted: true;
    };
  }): Promise<{ readonly redirectUrl: string }> {
    const idempotencyKey = createCorrelationId();
    return this.request<{ readonly redirectUrl: string }>('/auth/viva/authorize', {
      method: 'POST',
      auth: 'none',
      credentials: 'include',
      idempotencyKey,
      body: jsonRequestBody(input),
    });
  }

  public issueVivaAccessToken(
    input: {
      readonly handoffCode?: string;
    } = {},
  ): Promise<VivaDelegatedAccess> {
    const idempotencyKey = createCorrelationId();
    return this.request<VivaDelegatedAccess>('/auth/viva/access', {
      method: 'POST',
      auth: 'required',
      credentials: 'include',
      idempotencyKey,
      body: jsonRequestBody(input),
    });
  }

  public refreshSession(): Promise<AuthenticatedSession> {
    if (this.refreshInFlight) return this.refreshInFlight;

    const refresh = this.performSessionRefresh().finally(() => {
      if (this.refreshInFlight === refresh) this.refreshInFlight = undefined;
    });
    this.refreshInFlight = refresh;
    return refresh;
  }

  public async revokeSession(): Promise<void> {
    const idempotencyKey = createCorrelationId();
    await this.retryOnceOnNetworkFailure(() =>
      this.request<void>('/auth/session', {
        method: 'DELETE',
        auth: 'none',
        credentials: 'include',
        retryOnUnauthorized: false,
        sessionIntent: 'logout',
        idempotencyKey,
      }),
    );
    this.clearAccessToken();
  }

  public getUserContext(): Promise<UserContext> {
    return this.request<UserContext>('/context');
  }

  public createVivaOAuthRecovery(): Promise<{ readonly redirectUrl: string }> {
    const idempotencyKey = createCorrelationId();
    return this.retryOnceOnNetworkFailure(() =>
      this.request<{ readonly redirectUrl: string }>('/auth/viva/reauthorize', {
        method: 'POST',
        credentials: 'include',
        idempotencyKey,
        body: jsonRequestBody({ provider: 'yandex' }),
      }),
    );
  }

  public issueRealtimeTicket(): Promise<RealtimeTicket> {
    return this.request<RealtimeTicket>('/realtime/tickets', {
      method: 'POST',
      auth: 'required',
      cache: 'no-store',
    });
  }

  public getClientRoutingPlan(): Promise<ClientRoutingPlan> {
    return this.request<ClientRoutingPlan>('/routing-plan');
  }

  public recordDirectVivaReadMetric(input: {
    readonly operation: string;
    readonly routingRevision: string;
    readonly outcome: string;
    readonly statusClass?: string;
    readonly durationMs: number;
  }): Promise<void> {
    return this.request<void>('/routing-outcomes', {
      method: 'POST',
      retryOnUnauthorized: false,
      body: jsonRequestBody(input),
    });
  }

  public getUserProfile(): Promise<UserProfile> {
    return this.request<UserProfile>('/profile');
  }

  public async syncUserProfilePhoto(input: {
    readonly body: ArrayBuffer;
    readonly contentType: string;
    readonly grant: string;
    readonly idempotencyKey?: string;
  }): Promise<ProfilePhotoSyncResult> {
    const idempotencyKey = input.idempotencyKey ?? createCorrelationId();
    const result = await this.request<ProfilePhotoSyncResult>('/profile/photo', {
      method: 'POST',
      idempotencyKey,
      retryOnUnauthorized: false,
      headers: {
        'Content-Type': input.contentType,
        'X-Profile-Photo-Grant': input.grant,
      },
      body: input.body,
    });
    return { ...result, avatarUrl: this.resolveApiMediaUrl(result.avatarUrl) };
  }

  public removeUserProfilePhoto(input: {
    readonly grant: string;
    readonly idempotencyKey?: string;
  }): Promise<ProfilePhotoRemoveResult> {
    return this.request<ProfilePhotoRemoveResult>('/profile/photo', {
      method: 'DELETE',
      idempotencyKey: input.idempotencyKey ?? createCorrelationId(),
      retryOnUnauthorized: false,
      headers: { 'X-Profile-Photo-Grant': input.grant },
    });
  }

  public getPlayerProfile(userId: string): Promise<PlayerProfileView> {
    return this.request<PlayerProfileView>(`/profiles/${encodeURIComponent(userId)}`);
  }

  public getProfilePrivacySettings(): Promise<ProfilePrivacySettings> {
    return this.request<ProfilePrivacySettings>('/profile/privacy');
  }

  public listProfileFriends(limit = 8): Promise<ProfileFriendPage> {
    return this.request<ProfileFriendPage>(`/profile/friends?limit=${encodeURIComponent(limit)}`);
  }

  public getProfileFriendship(userId: string): Promise<ProfileFriendship> {
    return this.request<ProfileFriendship>(`/profile/friends/${encodeURIComponent(userId)}`);
  }

  public addProfileFriend(userId: string): Promise<ProfileFriendship> {
    const idempotencyKey = createCorrelationId();
    return this.retryOnceOnNetworkFailure(() =>
      this.request<ProfileFriendship>(`/profile/friends/${encodeURIComponent(userId)}`, {
        method: 'POST',
        idempotencyKey,
      }),
    );
  }

  public getProfileLevelHistory(limit = 100): Promise<ProfileLevelHistory> {
    return this.request<ProfileLevelHistory>(
      `/profile/level-history?limit=${encodeURIComponent(limit)}`,
    );
  }

  public getOwnPlayerLevel(sportCode = 'PADEL'): Promise<PlayerLevelState> {
    return this.request<PlayerLevelState>(
      `/profile/level?sportCode=${encodeURIComponent(sportCode)}`,
      { cache: 'no-store' },
    );
  }

  public setOwnPlayerLevel(levelId: string, sportCode = 'PADEL'): Promise<PlayerSportLevel> {
    const idempotencyKey = createCorrelationId();
    return this.retryOnceOnNetworkFailure(() =>
      this.request<PlayerSportLevel>('/profile/level', {
        method: 'PUT',
        idempotencyKey,
        body: jsonRequestBody({ sportCode, levelId }),
      }),
    );
  }

  public getOwnLevelAssessment(): Promise<LevelAssessmentDefinition> {
    return this.request<LevelAssessmentDefinition>('/profile/level-assessment', {
      cache: 'no-store',
    });
  }

  public completeOwnLevelAssessment(
    assessmentVersion: LevelAssessmentDefinition['version'],
    answers: Readonly<Record<string, readonly string[]>>,
  ): Promise<CompleteLevelAssessmentResponse> {
    const idempotencyKey = createCorrelationId();
    return this.retryOnceOnNetworkFailure(() =>
      this.request<CompleteLevelAssessmentResponse>('/profile/level-assessment', {
        method: 'POST',
        idempotencyKey,
        body: jsonRequestBody({ sportCode: 'PADEL', assessmentVersion, answers }),
      }),
    );
  }

  public updateProfilePrivacySettings(
    input: ProfilePrivacyUpdateRequest,
  ): Promise<ProfilePrivacySettings> {
    const idempotencyKey = createCorrelationId();
    return this.retryOnceOnNetworkFailure(() =>
      this.request<ProfilePrivacySettings>('/profile/privacy', {
        method: 'PUT',
        idempotencyKey,
        body: jsonRequestBody(input),
      }),
    );
  }

  public async getBookingPreferences(): Promise<BookingPreferences> {
    return normalizeBookingPreferences(
      await this.request<BookingPreferences>('/profile/booking-preferences'),
    );
  }

  public async updateBookingPreferences(
    input: BookingPreferencesUpdateRequest,
  ): Promise<BookingPreferences> {
    const idempotencyKey = createCorrelationId();
    return normalizeBookingPreferences(
      await this.retryOnceOnNetworkFailure(() =>
        this.request<BookingPreferences>('/profile/booking-preferences', {
          method: 'PUT',
          idempotencyKey,
          body: jsonRequestBody(input),
        }),
      ),
    );
  }

  public getUpcomingBookings(): Promise<UserUpcomingBookings> {
    return this.request<UserUpcomingBookings>('/bookings/upcoming');
  }

  public listActivityHistory(input: ActivityHistoryFilters = {}): Promise<ActivityHistoryPage> {
    const query = new URLSearchParams();
    if (input.kind) query.set('kind', input.kind);
    if (input.status) query.set('status', input.status);
    if (input.cursor) query.set('cursor', input.cursor);
    if (input.limit !== undefined) query.set('limit', String(input.limit));
    const suffix = query.size > 0 ? `?${query.toString()}` : '';
    return this.request<ActivityHistoryPage>(`/bookings/history${suffix}`);
  }

  public startActivityHistoryReadJob(
    input: ActivityHistoryFilters = {},
  ): Promise<BookingScreenReadJob> {
    return this.request<BookingScreenReadJob>('/activity-history-read-jobs', {
      method: 'POST',
      idempotencyKey: createCorrelationId(),
      body: jsonRequestBody(input),
    });
  }

  public submitActivityHistoryReadResult(
    jobId: string,
    commandId: string,
    payload: unknown,
  ): Promise<{
    readonly accepted: boolean;
    readonly replayed: boolean;
    readonly itemCount: number;
  }> {
    return this.request(
      `/activity-history-read-jobs/${encodeURIComponent(jobId)}/results/${encodeURIComponent(commandId)}`,
      {
        method: 'POST',
        idempotencyKey: createCorrelationId(),
        body: jsonRequestBody({ payload }),
      },
    );
  }

  public completeActivityHistoryReadJob(jobId: string): Promise<ActivityHistoryReadCompletion> {
    return this.request<ActivityHistoryReadCompletion>(
      `/activity-history-read-jobs/${encodeURIComponent(jobId)}/complete`,
      {
        method: 'POST',
        idempotencyKey: createCorrelationId(),
        body: jsonRequestBody({}),
      },
    );
  }

  public listBookingRecommendations(
    input: BookingRecommendationFilters = {},
  ): Promise<BookingRecommendationPage> {
    const query = new URLSearchParams({ limit: String(input.limit ?? 6) });
    if (input.cursor) query.set('cursor', input.cursor);
    return this.request<BookingRecommendationPage>(`/recommendations/bookings?${query.toString()}`);
  }

  public recordPromotionEngagement(
    promotionId: string,
    kind: 'IMPRESSION' | 'CLICK',
  ): Promise<{ readonly accepted: boolean }> {
    return this.request<{ readonly accepted: boolean }>(
      `/promotions/${encodeURIComponent(promotionId)}/engagements`,
      {
        method: 'POST',
        idempotencyKey: createCorrelationId(),
        keepalive: true,
        body: jsonRequestBody({ kind }),
      },
    );
  }

  public startBookingScreenReadJob(
    screen: 'FOR_ME' | 'GROUP_TRAININGS' | 'MY_BOOKINGS',
  ): Promise<BookingScreenReadJob> {
    return this.request<BookingScreenReadJob>('/booking-screen-read-jobs', {
      method: 'POST',
      idempotencyKey: createCorrelationId(),
      body: jsonRequestBody({ screen }),
    });
  }

  public startEventCatalogReadJob(query: EventCatalogQuery): Promise<BookingScreenReadJob> {
    return this.request<BookingScreenReadJob>('/booking-screen-read-jobs', {
      method: 'POST',
      idempotencyKey: createCorrelationId(),
      body: jsonRequestBody({ screen: 'EVENT_CATALOG', query }),
    });
  }

  public continueEventCatalog(cursor: string, limit = 20): Promise<EventCatalogPage> {
    const query = new URLSearchParams({ cursor, limit: String(limit) });
    return this.requestFromRoot<EventCatalogPage>(
      this.apiV2Root,
      `/event-catalog?${query.toString()}`,
    );
  }

  public submitBookingScreenReadResult(
    jobId: string,
    commandId: string,
    payload: unknown,
  ): Promise<{
    readonly accepted: boolean;
    readonly replayed: boolean;
    readonly itemCount: number;
  }> {
    return this.request(
      `/booking-screen-read-jobs/${encodeURIComponent(jobId)}/results/${encodeURIComponent(commandId)}`,
      {
        method: 'POST',
        idempotencyKey: createCorrelationId(),
        body: jsonRequestBody({ payload }),
      },
    );
  }

  public completeBookingScreenReadJob(
    jobId: string,
    limit: number,
    phase?: 'HOME_INITIAL' | 'HOME_TOURNAMENTS' | 'FULL',
  ): Promise<BookingScreenReadCompletion> {
    return this.request<BookingScreenReadCompletion>(
      `/booking-screen-read-jobs/${encodeURIComponent(jobId)}/complete`,
      {
        method: 'POST',
        idempotencyKey: createCorrelationId(),
        body: jsonRequestBody({ limit, ...(phase ? { phase } : {}) }),
      },
    );
  }

  public async getHomeDashboard(): Promise<HomeDashboard> {
    const dashboard = await this.request<HomeDashboard>('/home');
    return {
      ...dashboard,
      ...(Array.isArray(dashboard.locations)
        ? {
            locations: dashboard.locations.map((location) => ({
              ...location,
              imageUrl: location.imageUrl ? this.resolveApiMediaUrl(location.imageUrl) : null,
            })),
          }
        : {}),
      ...(Array.isArray(dashboard.communities)
        ? {
            communities: dashboard.communities.map((community) => ({
              ...community,
              logoUrl: community.logoUrl ? this.resolveApiMediaUrl(community.logoUrl) : null,
            })),
          }
        : {}),
    };
  }

  public async getHomeBase(): Promise<HomeBase> {
    const homeBase = await this.request<HomeBase>('/home/base');
    return {
      ...homeBase,
      communities:
        homeBase.communities.status === 'UNAVAILABLE'
          ? homeBase.communities
          : {
              ...homeBase.communities,
              value: homeBase.communities.value.map((community) => ({
                ...community,
                logoUrl: community.logoUrl ? this.resolveApiMediaUrl(community.logoUrl) : null,
              })),
            },
      locations: homeBase.locations.map((location) => ({
        ...location,
        imageUrl: location.imageUrl ? this.resolveApiMediaUrl(location.imageUrl) : null,
      })),
    };
  }

  public listPublicGames(input: PublicGameFilters = {}): Promise<PublicGameCardPage> {
    const query = new URLSearchParams();
    if (input.stationId) query.set('stationId', input.stationId);
    if (input.startsFrom) query.set('startsFrom', input.startsFrom);
    if (input.startsTo) query.set('startsTo', input.startsTo);
    if (input.kind) query.set('kind', input.kind);
    if (input.levelFrom) query.set('levelFrom', input.levelFrom);
    if (input.levelTo) query.set('levelTo', input.levelTo);
    if (input.availability) query.set('availability', input.availability);
    if (input.limit !== undefined) query.set('limit', String(input.limit));
    if (input.cursor) query.set('cursor', input.cursor);
    const suffix = query.size > 0 ? `?${query.toString()}` : '';
    return this.requestFromRoot<PublicGameCardPage>(this.publicApiRoot, `/games${suffix}`, {
      auth: 'none',
    });
  }

  public listPublicTournamentSummaries(
    input: PublicTournamentFilters,
  ): Promise<PublicTournamentSummaryPage> {
    const query = new URLSearchParams({
      dateFrom: input.dateFrom,
      dateTo: input.dateTo,
    });
    if (input.availability) query.set('availability', input.availability);
    if (input.limit !== undefined) query.set('limit', String(input.limit));
    return this.requestFromRoot<PublicTournamentSummaryPage>(
      this.publicApiRoot,
      `/tournaments?${query.toString()}`,
      { auth: 'none' },
    );
  }

  public getPublicTournamentSummary(
    summaryId: string,
    input: PublicTournamentSummaryRange,
  ): Promise<PublicTournamentSummary> {
    const query = new URLSearchParams({
      dateFrom: input.dateFrom,
      dateTo: input.dateTo,
    });
    return this.requestFromRoot<PublicTournamentSummary>(
      this.publicApiRoot,
      `/tournaments/${encodeURIComponent(summaryId)}?${query.toString()}`,
      { auth: 'none' },
    );
  }

  public getTournamentParticipants(tournamentId: string): Promise<TournamentParticipantRoster> {
    return this.request<TournamentParticipantRoster>(
      `/tournaments/${encodeURIComponent(tournamentId)}/participants`,
    );
  }

  public getPublicGiftCertificateCatalog(): Promise<PublicGiftCertificateCatalog> {
    return this.requestFromRoot<PublicGiftCertificateCatalog>(
      this.publicApiRoot,
      '/gift-certificate-catalog',
      { auth: 'none' },
    );
  }

  public createPublicGiftCertificateOrder(
    input: CreateGiftCertificateOrderRequest,
  ): Promise<GiftCertificateOrderCommandResult> {
    const idempotencyKey = createCorrelationId();
    return this.retryOnceOnNetworkFailure(() =>
      this.requestFromRoot<GiftCertificateOrderCommandResult>(
        this.publicApiRoot,
        '/gift-certificate-orders',
        {
          method: 'POST',
          auth: 'none',
          credentials: 'include',
          idempotencyKey,
          body: jsonRequestBody(input),
        },
      ),
    );
  }

  public getPublicGiftCertificateOrder(orderId: string): Promise<GiftCertificateOrder> {
    return this.requestFromRoot<GiftCertificateOrder>(
      this.publicApiRoot,
      `/gift-certificate-orders/${encodeURIComponent(orderId)}`,
      { auth: 'none', credentials: 'include' },
    );
  }

  public downloadPublicGiftCertificate(orderId: string): Promise<Blob> {
    return this.downloadFromRoot(
      this.publicApiRoot,
      `/gift-certificate-orders/${encodeURIComponent(orderId)}/certificate.pdf`,
      'none',
      'include',
    );
  }

  public createPublicGiftCertificatePaymentIntent(
    orderId: string,
  ): Promise<GiftCertificatePaymentIntent> {
    const idempotencyKey = createCorrelationId();
    return this.retryOnceOnNetworkFailure(() =>
      this.requestFromRoot<GiftCertificatePaymentIntent>(
        this.publicApiRoot,
        `/gift-certificate-orders/${encodeURIComponent(orderId)}/payment-intents`,
        { method: 'POST', auth: 'none', credentials: 'include', idempotencyKey },
      ),
    );
  }

  public confirmPublicGiftCertificateSandboxPayment(
    paymentId: string,
  ): Promise<GiftCertificatePaymentConfirmation> {
    const idempotencyKey = createCorrelationId();
    return this.retryOnceOnNetworkFailure(() =>
      this.requestFromRoot<GiftCertificatePaymentConfirmation>(
        this.publicApiRoot,
        `/gift-certificate-payments/${encodeURIComponent(paymentId)}/sandbox-confirm`,
        { method: 'POST', auth: 'none', credentials: 'include', idempotencyKey, body: '{}' },
      ),
    );
  }

  public createGiftCertificateOrder(
    input: CreateGiftCertificateOrderRequest,
  ): Promise<GiftCertificateOrderCommandResult> {
    const idempotencyKey = createCorrelationId();
    return this.retryOnceOnNetworkFailure(() =>
      this.request<GiftCertificateOrderCommandResult>('/gift-certificate-orders', {
        method: 'POST',
        idempotencyKey,
        body: jsonRequestBody(input),
      }),
    );
  }

  public getGiftCertificateOrder(orderId: string): Promise<GiftCertificateOrder> {
    return this.request<GiftCertificateOrder>(
      `/gift-certificate-orders/${encodeURIComponent(orderId)}`,
    );
  }

  public downloadGiftCertificate(orderId: string): Promise<Blob> {
    return this.downloadFromRoot(
      this.apiRoot,
      `/gift-certificate-orders/${encodeURIComponent(orderId)}/certificate.pdf`,
      'required',
      'same-origin',
    );
  }

  public createGiftCertificatePaymentIntent(
    orderId: string,
  ): Promise<GiftCertificatePaymentIntent> {
    const idempotencyKey = createCorrelationId();
    return this.retryOnceOnNetworkFailure(() =>
      this.request<GiftCertificatePaymentIntent>(
        `/gift-certificate-orders/${encodeURIComponent(orderId)}/payment-intents`,
        { method: 'POST', idempotencyKey },
      ),
    );
  }

  public confirmGiftCertificateSandboxPayment(
    paymentId: string,
  ): Promise<GiftCertificatePaymentConfirmation> {
    const idempotencyKey = createCorrelationId();
    return this.retryOnceOnNetworkFailure(() =>
      this.request<GiftCertificatePaymentConfirmation>(
        `/gift-certificate-payments/${encodeURIComponent(paymentId)}/sandbox-confirm`,
        { method: 'POST', idempotencyKey, body: '{}' },
      ),
    );
  }

  public listMyGames(
    input: {
      readonly scope?: 'UPCOMING' | 'HISTORY';
      readonly limit?: number;
      readonly cursor?: string;
    } = {},
  ): Promise<GameCardPage> {
    const query = new URLSearchParams();
    if (input.scope) query.set('scope', input.scope);
    if (input.limit !== undefined) query.set('limit', String(input.limit));
    if (input.cursor) query.set('cursor', input.cursor);
    const suffix = query.size > 0 ? `?${query.toString()}` : '';
    return this.request<GameCardPage>(`/games${suffix}`);
  }

  public getGame(gameId: string): Promise<GameCard> {
    return this.request<{ readonly game: GameCard }>(`/games/${encodeURIComponent(gameId)}`).then(
      ({ game }) => game,
    );
  }

  public joinGame(
    gameId: string,
    expectedRevision?: number,
    invitationId?: string,
    idempotencyKey?: string,
  ): Promise<GameCommandResult> {
    return this.gameCommand(
      gameId,
      '/join',
      'POST',
      { expectedRevision, invitationId },
      idempotencyKey,
    );
  }

  public leaveGame(gameId: string): Promise<GameCommandResult> {
    return this.gameCommand(gameId, '/participants/me', 'DELETE');
  }

  public joinGameWaitlist(gameId: string, invitationId?: string): Promise<GameCommandResult> {
    return this.gameCommand(gameId, '/waitlist', 'POST', { invitationId });
  }

  public leaveGameWaitlist(gameId: string): Promise<GameCommandResult> {
    return this.gameCommand(gameId, '/waitlist/me', 'DELETE');
  }

  public submitGameResult(
    gameId: string,
    input: SubmitGameResultRequest,
  ): Promise<GameCommandResult> {
    return this.gameCommand(gameId, '/result-submissions', 'POST', input);
  }

  public confirmGameResult(gameId: string, submissionId: string): Promise<GameCommandResult> {
    return this.gameCommand(
      gameId,
      `/result-submissions/${encodeURIComponent(submissionId)}/confirm`,
      'POST',
    );
  }

  public disputeGameResult(
    gameId: string,
    submissionId: string,
    input: DisputeGameResultRequest,
  ): Promise<GameCommandResult> {
    return this.gameCommand(
      gameId,
      `/result-submissions/${encodeURIComponent(submissionId)}/dispute`,
      'POST',
      input,
    );
  }

  public getGameOperation(operationId: string): Promise<GameCommandResult> {
    return this.request<GameCommandResult>(`/game-operations/${encodeURIComponent(operationId)}`);
  }

  public async listLocations(): Promise<LocationList> {
    const locations = await this.request<LocationList>('/locations');
    return {
      ...locations,
      items: locations.items.map((location) => ({
        ...location,
        coverImageUrl: location.coverImageUrl
          ? this.resolveApiMediaUrl(location.coverImageUrl)
          : null,
      })),
    };
  }

  public async getLocation(locationId: string): Promise<LocationDetail> {
    const location = await this.request<LocationDetail>(
      `/locations/${encodeURIComponent(locationId)}`,
    );
    return {
      ...location,
      gallery: location.gallery.map((image) => ({
        ...image,
        url: this.resolveApiMediaUrl(image.url),
      })),
    };
  }

  public async listMyCommunities(
    input: { readonly limit?: number; readonly cursor?: string } = {},
  ): Promise<CommunityMembershipPage> {
    const query = new URLSearchParams();
    if (input.limit !== undefined) query.set('limit', String(input.limit));
    if (input.cursor) query.set('cursor', input.cursor);
    const suffix = query.size > 0 ? `?${query.toString()}` : '';
    const page = await this.request<CommunityMembershipPage>(`/communities/mine${suffix}`);
    return {
      ...page,
      items: page.items.map((community) => ({
        ...community,
        logoUrl: community.logoUrl ? this.resolveApiMediaUrl(community.logoUrl) : null,
      })),
    };
  }

  public listConversations(limit = 50): Promise<ConversationPage> {
    const query = new URLSearchParams({ limit: String(limit) });
    return this.request<ConversationPage>(`/conversations?${query.toString()}`);
  }

  public issueMessagingRealtimeTicket(): Promise<MessagingRealtimeTicket> {
    return this.request<MessagingRealtimeTicket>('/messaging/realtime-ticket', {
      method: 'POST',
    });
  }

  public createDirectConversation(otherUserId: string): Promise<CreateDirectConversationResult> {
    const idempotencyKey = createCorrelationId();
    return this.retryOnceOnNetworkFailure(() =>
      this.request<CreateDirectConversationResult>('/conversations/direct', {
        method: 'POST',
        idempotencyKey,
        body: jsonRequestBody({ otherUserId }),
      }),
    );
  }

  public discoverCommunities(
    input: CommunityDiscoveryFilters = {},
  ): Promise<CommunityDiscoveryPage> {
    const query = new URLSearchParams();
    if (input.query) query.set('query', input.query);
    if (input.limit !== undefined) query.set('limit', String(input.limit));
    if (input.cursor) query.set('cursor', input.cursor);
    const suffix = query.size > 0 ? `?${query.toString()}` : '';
    return this.request<CommunityDiscoveryPage>(`/communities${suffix}`);
  }

  public getCommunityDetail(communityId: string): Promise<CommunityDetailView> {
    return this.request<CommunityDetailView>(`/communities/${encodeURIComponent(communityId)}`);
  }

  public getMyCommunityMembershipState(communityId: string): Promise<CommunityOwnMembershipState> {
    return this.request<CommunityOwnMembershipState>(
      `/communities/${encodeURIComponent(communityId)}/members/me`,
    );
  }

  public joinOrRequestCommunityMembership(
    communityId: string,
    input: CommunityMembershipRevisionRequest,
  ): Promise<CommunityOwnMembershipState> {
    const idempotencyKey = createCorrelationId();
    return this.retryOnceOnNetworkFailure(() =>
      this.request<CommunityOwnMembershipState>(
        `/communities/${encodeURIComponent(communityId)}/members/me/join`,
        {
          method: 'POST',
          idempotencyKey,
          body: jsonRequestBody(input),
        },
      ),
    );
  }

  public cancelMyCommunityJoinRequest(
    communityId: string,
    requestId: string,
    input: CommunityJoinRequestCancelRequest,
  ): Promise<CommunityOwnMembershipState> {
    const idempotencyKey = createCorrelationId();
    return this.retryOnceOnNetworkFailure(() =>
      this.request<CommunityOwnMembershipState>(
        `/communities/${encodeURIComponent(communityId)}/join-requests/${encodeURIComponent(requestId)}/cancel`,
        {
          method: 'POST',
          idempotencyKey,
          body: jsonRequestBody(input),
        },
      ),
    );
  }

  public leaveCommunity(
    communityId: string,
    input: CommunityMembershipRevisionRequest,
  ): Promise<CommunityOwnMembershipState> {
    const idempotencyKey = createCorrelationId();
    return this.retryOnceOnNetworkFailure(() =>
      this.request<CommunityOwnMembershipState>(
        `/communities/${encodeURIComponent(communityId)}/members/me/leave`,
        {
          method: 'POST',
          idempotencyKey,
          body: jsonRequestBody(input),
        },
      ),
    );
  }

  public transferCommunityOwnership(
    communityId: string,
    input: CommunityOwnershipTransferRequest,
  ): Promise<CommunityOwnershipTransferState> {
    const idempotencyKey = createCorrelationId();
    return this.retryOnceOnNetworkFailure(() =>
      this.request<CommunityOwnershipTransferState>(
        `/communities/${encodeURIComponent(communityId)}/ownership-transfers`,
        {
          method: 'POST',
          idempotencyKey,
          body: jsonRequestBody(input),
        },
      ),
    );
  }

  public listCommunityFeed(
    communityId: string,
    input: { readonly limit?: number; readonly cursor?: string } = {},
  ): Promise<CommunityFeedPage> {
    const query = new URLSearchParams();
    if (input.limit !== undefined) query.set('limit', String(input.limit));
    if (input.cursor) query.set('cursor', input.cursor);
    const suffix = query.size > 0 ? `?${query.toString()}` : '';
    return this.request<CommunityFeedPage>(
      `/communities/${encodeURIComponent(communityId)}/feed${suffix}`,
      { cache: 'no-store' },
    );
  }

  public recoverCommunityEvents(
    communityId: string,
    input: { readonly afterSequence?: number; readonly limit?: number } = {},
  ): Promise<CommunityRealtimeEventPage> {
    const query = new URLSearchParams();
    if (input.afterSequence !== undefined) {
      query.set('afterSequence', String(input.afterSequence));
    }
    if (input.limit !== undefined) query.set('limit', String(input.limit));
    const suffix = query.size > 0 ? `?${query.toString()}` : '';
    return this.request<CommunityRealtimeEventPage>(
      `/communities/${encodeURIComponent(communityId)}/events${suffix}`,
      { cache: 'no-store' },
    );
  }

  public createCommunityPost(
    communityId: string,
    input: CommunityPostCreateRequest,
  ): Promise<CommunityPost> {
    return this.communityContentCommand(
      `/communities/${encodeURIComponent(communityId)}/posts`,
      'POST',
      input,
    );
  }

  public issueCommunityMediaUpload(
    communityId: string,
    input: CommunityMediaUploadIssueRequest,
  ): Promise<CommunityMediaUploadIssued> {
    return this.communityContentCommand(
      `/communities/${encodeURIComponent(communityId)}/media/uploads`,
      'POST',
      input,
    );
  }

  public finalizeCommunityMediaUpload(
    communityId: string,
    mediaId: string,
    input: CommunityMediaFinalizeRequest,
  ): Promise<CommunityMediaStatus> {
    return this.communityContentCommand(
      `/communities/${encodeURIComponent(communityId)}/media/${encodeURIComponent(mediaId)}/finalize`,
      'POST',
      input,
    );
  }

  public getCommunityMediaStatus(
    communityId: string,
    mediaId: string,
  ): Promise<CommunityMediaStatus> {
    return this.request<CommunityMediaStatus>(
      `/communities/${encodeURIComponent(communityId)}/media/${encodeURIComponent(mediaId)}`,
      { cache: 'no-store' },
    );
  }

  public downloadCommunityMediaVariant(
    communityId: string,
    mediaId: string,
    variant: CommunityMediaVariantName,
  ): Promise<Blob> {
    return this.downloadFromRoot(
      this.apiRoot,
      `/communities/${encodeURIComponent(communityId)}/media/${encodeURIComponent(mediaId)}/variants/${encodeURIComponent(variant)}`,
      'required',
      'same-origin',
      createCorrelationId(),
      true,
      'image/webp',
    );
  }

  public editCommunityPost(
    communityId: string,
    postId: string,
    input: CommunityPostEditRequest,
  ): Promise<CommunityPost> {
    return this.communityContentCommand(
      `/communities/${encodeURIComponent(communityId)}/posts/${encodeURIComponent(postId)}`,
      'PATCH',
      input,
    );
  }

  public archiveCommunityPost(
    communityId: string,
    postId: string,
    input: CommunityContentRevisionRequest,
  ): Promise<CommunityPost> {
    return this.communityContentCommand(
      `/communities/${encodeURIComponent(communityId)}/posts/${encodeURIComponent(postId)}/archive`,
      'POST',
      input,
    );
  }

  public restoreCommunityPost(
    communityId: string,
    postId: string,
    input: CommunityContentRevisionRequest,
  ): Promise<CommunityPost> {
    return this.communityContentCommand(
      `/communities/${encodeURIComponent(communityId)}/posts/${encodeURIComponent(postId)}/restore`,
      'POST',
      input,
    );
  }

  public listCommunityComments(
    communityId: string,
    postId: string,
    input: { readonly limit?: number; readonly cursor?: string } = {},
  ): Promise<CommunityCommentPage> {
    const query = new URLSearchParams();
    if (input.limit !== undefined) query.set('limit', String(input.limit));
    if (input.cursor) query.set('cursor', input.cursor);
    const suffix = query.size > 0 ? `?${query.toString()}` : '';
    return this.request<CommunityCommentPage>(
      `/communities/${encodeURIComponent(communityId)}/posts/${encodeURIComponent(postId)}/comments${suffix}`,
      { cache: 'no-store' },
    );
  }

  public createCommunityComment(
    communityId: string,
    postId: string,
    input: CommunityCommentCreateRequest,
  ): Promise<CommunityComment> {
    return this.communityContentCommand(
      `/communities/${encodeURIComponent(communityId)}/posts/${encodeURIComponent(postId)}/comments`,
      'POST',
      input,
    );
  }

  public editCommunityComment(
    communityId: string,
    postId: string,
    commentId: string,
    input: CommunityCommentEditRequest,
  ): Promise<CommunityComment> {
    return this.communityContentCommand(
      `/communities/${encodeURIComponent(communityId)}/posts/${encodeURIComponent(postId)}/comments/${encodeURIComponent(commentId)}`,
      'PATCH',
      input,
    );
  }

  public archiveCommunityComment(
    communityId: string,
    postId: string,
    commentId: string,
    input: CommunityContentRevisionRequest,
  ): Promise<CommunityComment> {
    return this.communityContentCommand(
      `/communities/${encodeURIComponent(communityId)}/posts/${encodeURIComponent(postId)}/comments/${encodeURIComponent(commentId)}/archive`,
      'POST',
      input,
    );
  }

  public restoreCommunityComment(
    communityId: string,
    postId: string,
    commentId: string,
    input: CommunityContentRevisionRequest,
  ): Promise<CommunityComment> {
    return this.communityContentCommand(
      `/communities/${encodeURIComponent(communityId)}/posts/${encodeURIComponent(postId)}/comments/${encodeURIComponent(commentId)}/restore`,
      'POST',
      input,
    );
  }

  public setCommunityReaction(
    communityId: string,
    targetType: 'POST' | 'COMMENT',
    targetId: string,
    input: CommunityReactionRequest,
  ): Promise<CommunityReactionState> {
    const segment = targetType === 'POST' ? 'posts' : 'comments';
    return this.communityContentCommand(
      `/communities/${encodeURIComponent(communityId)}/${segment}/${encodeURIComponent(targetId)}/reaction`,
      'PUT',
      input,
    );
  }

  public removeCommunityReaction(
    communityId: string,
    targetType: 'POST' | 'COMMENT',
    targetId: string,
  ): Promise<CommunityReactionState> {
    const segment = targetType === 'POST' ? 'posts' : 'comments';
    return this.communityContentCommand(
      `/communities/${encodeURIComponent(communityId)}/${segment}/${encodeURIComponent(targetId)}/reaction`,
      'DELETE',
    );
  }

  private communityContentCommand<TResult>(
    path: string,
    method: 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    input?: unknown,
  ): Promise<TResult> {
    const idempotencyKey = createCorrelationId();
    return this.retryOnceOnNetworkFailure(() =>
      this.request<TResult>(path, {
        method,
        cache: 'no-store',
        idempotencyKey,
        ...(input === undefined ? {} : { body: jsonRequestBody(input) }),
      }),
    );
  }

  public listCommunityDirectInvites(
    communityId: string,
    input: { readonly limit?: number; readonly cursor?: string } = {},
  ): Promise<CommunityDirectInvitePage> {
    const query = new URLSearchParams();
    if (input.limit !== undefined) query.set('limit', String(input.limit));
    if (input.cursor) query.set('cursor', input.cursor);
    const suffix = query.size > 0 ? `?${query.toString()}` : '';
    return this.request<CommunityDirectInvitePage>(
      `/communities/${encodeURIComponent(communityId)}/direct-invites${suffix}`,
      { cache: 'no-store' },
    );
  }

  public createCommunityDirectInvite(
    communityId: string,
    input: CommunityDirectInviteCreateRequest,
  ): Promise<CommunityDirectInviteCreated> {
    const idempotencyKey = createCorrelationId();
    return this.retryOnceOnNetworkFailure(() =>
      this.request<CommunityDirectInviteCreated>(
        `/communities/${encodeURIComponent(communityId)}/direct-invites`,
        {
          method: 'POST',
          cache: 'no-store',
          idempotencyKey,
          body: jsonRequestBody(input),
        },
      ),
    );
  }

  public previewCommunityDirectInvite(
    input: CommunityDirectInviteTokenRequest,
  ): Promise<CommunityDirectInvitePreview> {
    return this.request<CommunityDirectInvitePreview>('/community-direct-invites/preview', {
      method: 'POST',
      cache: 'no-store',
      body: jsonRequestBody(input),
    });
  }

  public redeemCommunityDirectInvite(
    input: CommunityDirectInviteRedeemRequest,
  ): Promise<CommunityOwnMembershipState> {
    const idempotencyKey = createCorrelationId();
    return this.retryOnceOnNetworkFailure(() =>
      this.request<CommunityOwnMembershipState>('/community-direct-invites/redeem', {
        method: 'POST',
        cache: 'no-store',
        idempotencyKey,
        body: jsonRequestBody(input),
      }),
    );
  }

  public getOrCreateGameConversation(gameId: string): Promise<GetOrCreateGameConversationResult> {
    const idempotencyKey = createCorrelationId();
    return this.retryOnceOnNetworkFailure(() =>
      this.request<GetOrCreateGameConversationResult>('/conversations/game', {
        method: 'POST',
        idempotencyKey,
        body: jsonRequestBody({ gameId }),
      }),
    );
  }

  public listConversationMessages(
    conversationId: string,
    input: { readonly afterSequence?: number; readonly limit?: number } = {},
  ): Promise<ConversationMessagePage> {
    const query = new URLSearchParams();
    if (input.afterSequence !== undefined) query.set('afterSequence', String(input.afterSequence));
    if (input.limit !== undefined) query.set('limit', String(input.limit));
    const suffix = query.size > 0 ? `?${query.toString()}` : '';
    return this.request<ConversationMessagePage>(
      `/conversations/${encodeURIComponent(conversationId)}/messages${suffix}`,
    );
  }

  public sendConversationMessage(
    conversationId: string,
    body: string,
  ): Promise<SendConversationMessageResult> {
    const commandId = createCorrelationId();
    return this.retryOnceOnNetworkFailure(() =>
      this.request<SendConversationMessageResult>(
        `/conversations/${encodeURIComponent(conversationId)}/messages`,
        {
          method: 'POST',
          idempotencyKey: commandId,
          body: jsonRequestBody({ clientMessageId: commandId, body }),
        },
      ),
    );
  }

  public revokeCommunityDirectInvite(
    inviteId: string,
    input: CommunityDirectInviteRevokeRequest,
  ): Promise<CommunityDirectInviteState> {
    const idempotencyKey = createCorrelationId();
    return this.retryOnceOnNetworkFailure(() =>
      this.request<CommunityDirectInviteState>(
        `/community-direct-invites/${encodeURIComponent(inviteId)}/revoke`,
        {
          method: 'POST',
          cache: 'no-store',
          idempotencyKey,
          body: jsonRequestBody(input),
        },
      ),
    );
  }

  public markConversationRead(
    conversationId: string,
    throughSequence: number,
  ): Promise<ConversationReadCursorResult> {
    const idempotencyKey = createCorrelationId();
    return this.retryOnceOnNetworkFailure(() =>
      this.request<ConversationReadCursorResult>(
        `/conversations/${encodeURIComponent(conversationId)}/read-cursor`,
        {
          method: 'PUT',
          idempotencyKey,
          body: jsonRequestBody({ throughSequence }),
        },
      ),
    );
  }

  public async getCommunityReadExperienceDetail(
    communityId: string,
  ): Promise<CommunityReadExperienceDetail> {
    const detail = await this.request<CommunityReadExperienceDetail>(
      `/community-views/${encodeURIComponent(communityId)}`,
      { cache: 'no-store' },
    );
    return {
      ...detail,
      logoUrl: detail.logoUrl ? this.resolveApiMediaUrl(detail.logoUrl) : null,
    };
  }

  public listCommunityReadExperienceFeed(
    communityId: string,
    input: { readonly limit?: number; readonly cursor?: string } = {},
  ): Promise<CommunityReadExperienceFeedPage> {
    return this.communityReadExperiencePage<CommunityReadExperienceFeedPage>(
      communityId,
      '/feed',
      input,
    );
  }

  public listCommunityReadExperienceChat(
    communityId: string,
    input: { readonly limit?: number; readonly cursor?: string } = {},
  ): Promise<CommunityReadExperienceChatPage> {
    return this.communityReadExperiencePage<CommunityReadExperienceChatPage>(
      communityId,
      '/chat',
      input,
    );
  }

  public getCommunityReadExperienceRating(
    communityId: string,
    input: {
      readonly period?: 'all' | '30d';
      readonly tab?: 'overall' | 'dynamics' | 'games' | 'tournaments';
    } = {},
  ): Promise<CommunityReadExperienceRating> {
    const query = new URLSearchParams();
    if (input.period) query.set('period', input.period);
    if (input.tab) query.set('tab', input.tab);
    const suffix = query.size > 0 ? `?${query.toString()}` : '';
    return this.request<CommunityReadExperienceRating>(
      `/community-views/${encodeURIComponent(communityId)}/rating${suffix}`,
      { cache: 'no-store' },
    );
  }

  private communityReadExperiencePage<T>(
    communityId: string,
    suffix: '/feed' | '/chat',
    input: { readonly limit?: number; readonly cursor?: string },
  ): Promise<T> {
    const query = new URLSearchParams();
    if (input.limit !== undefined) query.set('limit', String(input.limit));
    if (input.cursor) query.set('cursor', input.cursor);
    const querySuffix = query.size > 0 ? `?${query.toString()}` : '';
    return this.request<T>(
      `/community-views/${encodeURIComponent(communityId)}${suffix}${querySuffix}`,
      { cache: 'no-store' },
    );
  }

  public createCommunity(input: CommunityCreateRequest): Promise<CommunityCreatedState> {
    const idempotencyKey = createCorrelationId();
    return this.retryOnceOnNetworkFailure(() =>
      this.request<CommunityCreatedState>('/communities', {
        method: 'POST',
        idempotencyKey,
        body: jsonRequestBody(input),
      }),
    );
  }

  public setMyCommunityMembershipPin(
    communityId: string,
    input: CommunityMembershipPinRequest,
  ): Promise<CommunityMembershipPinState> {
    const idempotencyKey = createCorrelationId();
    return this.retryOnceOnNetworkFailure(() =>
      this.request<CommunityMembershipPinState>(
        `/communities/${encodeURIComponent(communityId)}/members/me/pin`,
        {
          method: 'PUT',
          idempotencyKey,
          body: jsonRequestBody(input),
        },
      ),
    );
  }

  public listNotifications(
    input: {
      readonly limit?: number;
      readonly unreadOnly?: boolean;
      readonly cursor?: string;
    } = {},
  ): Promise<NotificationInboxPage> {
    const query = new URLSearchParams();
    if (input.limit !== undefined) query.set('limit', String(input.limit));
    if (input.unreadOnly !== undefined) query.set('unreadOnly', String(input.unreadOnly));
    if (input.cursor) query.set('cursor', input.cursor);
    const suffix = query.size > 0 ? `?${query.toString()}` : '';
    return this.request<NotificationInboxPage>(`/notifications${suffix}`);
  }

  public markNotificationsRead(throughId: string): Promise<NotificationReadCursorResult> {
    const idempotencyKey = createCorrelationId();
    return this.retryOnceOnNetworkFailure(() =>
      this.request<NotificationReadCursorResult>('/notifications/read-cursor', {
        method: 'PUT',
        idempotencyKey,
        body: jsonRequestBody({ throughId }),
      }),
    );
  }

  public getWebPushConfiguration(): Promise<WebPushConfiguration> {
    return this.request<WebPushConfiguration>('/notification-endpoints/web/config');
  }

  public registerWebPushEndpoint(
    input: WebPushEndpointRegistration,
  ): Promise<WebPushEndpointCommandResult> {
    const idempotencyKey = createCorrelationId();
    return this.retryOnceOnNetworkFailure(() =>
      this.request<WebPushEndpointCommandResult>('/notification-endpoints/web', {
        method: 'POST',
        idempotencyKey,
        body: jsonRequestBody(input),
      }),
    );
  }

  public revokeWebPushEndpoint(installationId: string): Promise<WebPushEndpointCommandResult> {
    const idempotencyKey = createCorrelationId();
    return this.retryOnceOnNetworkFailure(() =>
      this.request<WebPushEndpointCommandResult>(
        `/notification-endpoints/web/${encodeURIComponent(installationId)}`,
        {
          method: 'DELETE',
          idempotencyKey,
        },
      ),
    );
  }

  private async performSessionRefresh(): Promise<AuthenticatedSession> {
    try {
      const idempotencyKey = createCorrelationId();
      let session: AuthenticatedSession;
      try {
        session = await this.retryOnceOnNetworkFailure(() =>
          this.requestSessionRefresh(idempotencyKey),
        );
      } catch (error) {
        if (!(error instanceof ApiClientError) || error.code !== 'AUTH_REFRESH_RACE') throw error;
        await new Promise((resolve) => setTimeout(resolve, 150));
        session = await this.retryOnceOnNetworkFailure(() =>
          this.requestSessionRefresh(idempotencyKey),
        );
      }
      this.applyAuthenticatedSession(session);
      return session;
    } catch (error) {
      this.clearAccessToken();
      throw error;
    }
  }

  private requestSessionRefresh(idempotencyKey: string): Promise<AuthenticatedSession> {
    return this.request<AuthenticatedSession>('/auth/session/refresh', {
      method: 'POST',
      auth: 'none',
      credentials: 'include',
      retryOnUnauthorized: false,
      sessionIntent: 'refresh',
      idempotencyKey,
    });
  }

  private async retryOnceOnNetworkFailure<TResult>(
    operation: () => Promise<TResult>,
  ): Promise<TResult> {
    try {
      return await operation();
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      return operation();
    }
  }

  private gameCommand(
    gameId: string,
    suffix: string,
    method: 'POST' | 'DELETE',
    body?: unknown,
    requestedIdempotencyKey?: string,
  ): Promise<GameCommandResult> {
    const idempotencyKey = requestedIdempotencyKey ?? createCorrelationId();
    return this.retryOnceOnNetworkFailure(() =>
      this.request<GameCommandResult>(`/games/${encodeURIComponent(gameId)}${suffix}`, {
        method,
        idempotencyKey,
        ...(body === undefined ? {} : { body: jsonRequestBody(body) }),
      }),
    );
  }

  private applyAuthenticatedSession(session: AuthenticatedSession): void {
    if (!isAuthenticatedSession(session)) {
      this.clearAccessToken();
      throw new Error('PadlHub authentication response is invalid');
    }
    this.setAccessToken(session.accessToken);
  }

  private async requestWithPolicy<TResponse>(
    path: string,
    policy: RequestPolicy,
    correlationId: string,
    allowRefresh: boolean,
    apiRoot = this.apiRoot,
  ): Promise<TResponse> {
    const headers = createHeaderRecord(policy.requestInit.headers);
    setHeader(headers, 'Accept', 'application/json');
    setHeader(headers, 'X-Correlation-ID', correlationId);
    setHeader(headers, 'X-App-Platform', this.options.platform);
    setHeader(headers, 'X-App-Version', this.options.appVersion);
    if (this.options.appBuild) setHeader(headers, 'X-App-Build', this.options.appBuild);
    if (policy.idempotencyKey) setHeader(headers, 'Idempotency-Key', policy.idempotencyKey);
    if (policy.sessionIntent) setHeader(headers, 'X-Session-Intent', policy.sessionIntent);
    if (policy.requestInit.body && !findHeaderName(headers, 'Content-Type')) {
      setHeader(headers, 'Content-Type', 'application/json');
    }

    if (policy.auth === 'required') {
      const accessToken = this.getAccessToken();
      if (accessToken) setHeader(headers, 'Authorization', `Bearer ${accessToken}`);
      else deleteHeader(headers, 'Authorization');
    } else {
      deleteHeader(headers, 'Authorization');
    }

    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    const response = await this.fetchImplementation(`${apiRoot}${normalizedPath}`, {
      ...policy.requestInit,
      credentials: policy.requestInit.credentials ?? 'same-origin',
      headers,
    });

    if (
      response.status === 401 &&
      policy.auth === 'required' &&
      policy.retryOnUnauthorized &&
      allowRefresh
    ) {
      await this.refreshSession();
      return this.requestWithPolicy<TResponse>(path, policy, correlationId, false, apiRoot);
    }

    if (!response.ok) throw await this.toApiClientError(response, correlationId);
    if (response.status === 204) return undefined as TResponse;
    return (await response.json()) as TResponse;
  }

  private requestFromRoot<TResponse>(
    apiRoot: string,
    path: string,
    init: ApiRequestInit = {},
  ): Promise<TResponse> {
    const {
      auth = 'required',
      idempotencyKey,
      retryOnUnauthorized = true,
      sessionIntent,
      ...requestInit
    } = init;
    const policy: RequestPolicy = {
      auth,
      retryOnUnauthorized,
      requestInit,
      ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
      ...(sessionIntent === undefined ? {} : { sessionIntent }),
    };
    return this.requestWithPolicy<TResponse>(path, policy, createCorrelationId(), true, apiRoot);
  }

  private async downloadFromRoot(
    apiRoot: string,
    path: string,
    auth: RequestAuthMode,
    credentials: RequestCredentials,
    correlationId = createCorrelationId(),
    allowRefresh = true,
    accept = 'application/pdf',
  ): Promise<Blob> {
    const headers: HeaderRecord = {};
    setHeader(headers, 'Accept', accept);
    setHeader(headers, 'X-Correlation-ID', correlationId);
    setHeader(headers, 'X-App-Platform', this.options.platform);
    setHeader(headers, 'X-App-Version', this.options.appVersion);
    if (this.options.appBuild) setHeader(headers, 'X-App-Build', this.options.appBuild);
    if (auth === 'required' && this.accessToken) {
      setHeader(headers, 'Authorization', `Bearer ${this.accessToken}`);
    }
    const response = await this.fetchImplementation(`${apiRoot}${path}`, {
      method: 'GET',
      credentials,
      headers,
    });
    if (response.status === 401 && auth === 'required' && allowRefresh) {
      await this.refreshSession();
      return this.downloadFromRoot(apiRoot, path, auth, credentials, correlationId, false, accept);
    }
    if (!response.ok) throw await this.toApiClientError(response, correlationId);
    return response.blob();
  }

  private async toApiClientError(
    response: Response,
    fallbackCorrelationId: string,
  ): Promise<ApiClientError> {
    const body = (await response.json().catch(() => undefined)) as
      | {
          code?: string;
          message?: string;
          correlationId?: string;
          recoveryAction?: string;
          latestSequence?: number;
          retainedFromSequence?: number;
          eligibility?: ParticipationDecision;
        }
      | undefined;
    const correlationId =
      body?.correlationId ?? response.headers.get('X-Correlation-ID') ?? fallbackCorrelationId;
    if (
      response.status === 409 &&
      body?.code === 'COMMUNITY_EVENT_GAP_EXPIRED' &&
      body.recoveryAction === 'FULL_CANONICAL_RELOAD' &&
      Number.isSafeInteger(body.latestSequence) &&
      Number.isSafeInteger(body.retainedFromSequence) &&
      (body.latestSequence as number) >= 0 &&
      (body.retainedFromSequence as number) > 0
    ) {
      return new CommunityEventGapExpiredError(
        body.message ?? 'Каноническое состояние нужно загрузить заново.',
        correlationId,
        body.latestSequence as number,
        body.retainedFromSequence as number,
      );
    }
    return new ApiClientError(
      body?.message ?? 'Запрос не выполнен.',
      response.status,
      body?.code ?? 'UNEXPECTED_API_ERROR',
      correlationId,
      body?.eligibility,
    );
  }
}
