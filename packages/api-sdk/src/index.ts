import type { components, PublicApiComponents } from '@phub/api-contracts';

export type AuthChallengeRequest = components['schemas']['AuthChallengeRequest'];
export type AuthChallenge = components['schemas']['AuthChallenge'];
export type VerifyAuthChallengeRequest = components['schemas']['VerifyAuthChallengeRequest'];
export type AuthenticatedSession = components['schemas']['AuthenticatedSession'];
export type AuthenticatedUser = components['schemas']['AuthenticatedUser'];
export type UserContext = components['schemas']['UserContext'];
export type HomeDashboard = components['schemas']['HomeDashboard'];
export type LocationList = components['schemas']['LocationList'];
export type LocationDetail = components['schemas']['LocationDetail'];
export type CommunityMembershipPage = components['schemas']['CommunityMembershipPage'];
export type ClientRoutingPlan = components['schemas']['ClientRoutingPlan'];
export type UserProfile = components['schemas']['UserProfile'];
export type PlayerProfileView = components['schemas']['PlayerProfileView'];
export type ProfileActionCapability = components['schemas']['ProfileActionCapability'];
export type ProfilePrivacySettings = components['schemas']['ProfilePrivacySettings'];
export type ProfilePrivacyUpdateRequest = components['schemas']['ProfilePrivacyUpdateRequest'];
export type BookingPreferences = components['schemas']['BookingPreferences'];
export type BookingPreferencesUpdateRequest =
  components['schemas']['BookingPreferencesUpdateRequest'];
export type BookingRecommendationPage = components['schemas']['BookingRecommendationPage'];
export type UserUpcomingBookings = components['schemas']['UserUpcomingBookings'];
export type NotificationInboxPage = components['schemas']['NotificationInboxPage'];
export type NotificationReadCursorResult = components['schemas']['NotificationReadCursorResult'];
export type WebPushConfiguration = components['schemas']['WebPushConfiguration'];
export type WebPushEndpointRegistration = components['schemas']['WebPushEndpointRegistration'];
export type WebPushEndpointCommandResult = components['schemas']['WebPushEndpointCommandResult'];
export type GameCard = components['schemas']['GameCardView'];
export type GameCardPage = components['schemas']['GameCardPage'];
export type GameCommandResult = components['schemas']['GameCommandResult'];
export type PublicGameCard = PublicApiComponents['schemas']['PublicGameCard'];
export type PublicGameCardPage = PublicApiComponents['schemas']['PublicGameCardPage'];

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
  ) {
    super(message);
    this.name = 'ApiClientError';
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
  private readonly publicApiRoot: string;
  private accessToken: string | undefined;
  private refreshInFlight: Promise<AuthenticatedSession> | undefined;

  public constructor(private readonly options: ApiClientOptions) {
    this.fetchImplementation =
      options.fetchImplementation ?? ((input, init) => globalThis.fetch(input, init));
    this.apiRoot = `${options.baseUrl.replace(/\/$/, '')}/user/api/v1/${encodeURIComponent(options.tenantKey)}`;
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
  ): Promise<{ readonly accessToken: string; readonly expiresAt: string }> {
    const idempotencyKey = createCorrelationId();
    return this.request<{ readonly accessToken: string; readonly expiresAt: string }>(
      '/auth/viva/access',
      {
        method: 'POST',
        auth: 'required',
        credentials: 'include',
        idempotencyKey,
        body: jsonRequestBody(input),
      },
    );
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

  public getClientRoutingPlan(): Promise<ClientRoutingPlan> {
    return this.request<ClientRoutingPlan>('/routing-plan');
  }

  public getUserProfile(): Promise<UserProfile> {
    return this.request<UserProfile>('/profile');
  }

  public getPlayerProfile(userId: string): Promise<PlayerProfileView> {
    return this.request<PlayerProfileView>(`/profiles/${encodeURIComponent(userId)}`);
  }

  public getProfilePrivacySettings(): Promise<ProfilePrivacySettings> {
    return this.request<ProfilePrivacySettings>('/profile/privacy');
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

  public getBookingPreferences(): Promise<BookingPreferences> {
    return this.request<BookingPreferences>('/profile/booking-preferences');
  }

  public updateBookingPreferences(
    input: BookingPreferencesUpdateRequest,
  ): Promise<BookingPreferences> {
    const idempotencyKey = createCorrelationId();
    return this.retryOnceOnNetworkFailure(() =>
      this.request<BookingPreferences>('/profile/booking-preferences', {
        method: 'PUT',
        idempotencyKey,
        body: jsonRequestBody(input),
      }),
    );
  }

  public getUpcomingBookings(): Promise<UserUpcomingBookings> {
    return this.request<UserUpcomingBookings>('/bookings/upcoming');
  }

  public listBookingRecommendations(limit = 6): Promise<BookingRecommendationPage> {
    const query = new URLSearchParams({ limit: String(limit) });
    return this.request<BookingRecommendationPage>(`/recommendations/bookings?${query.toString()}`);
  }

  public getHomeDashboard(): Promise<HomeDashboard> {
    return this.request<HomeDashboard>('/home');
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

  public joinGame(gameId: string, expectedRevision?: number): Promise<GameCommandResult> {
    return this.gameCommand(gameId, '/join', 'POST', { expectedRevision });
  }

  public leaveGame(gameId: string): Promise<GameCommandResult> {
    return this.gameCommand(gameId, '/participants/me', 'DELETE');
  }

  public joinGameWaitlist(gameId: string): Promise<GameCommandResult> {
    return this.gameCommand(gameId, '/waitlist', 'POST');
  }

  public leaveGameWaitlist(gameId: string): Promise<GameCommandResult> {
    return this.gameCommand(gameId, '/waitlist/me', 'DELETE');
  }

  public getGameOperation(operationId: string): Promise<GameCommandResult> {
    return this.request<GameCommandResult>(`/game-operations/${encodeURIComponent(operationId)}`);
  }

  public listLocations(): Promise<LocationList> {
    return this.request<LocationList>('/locations');
  }

  public getLocation(locationId: string): Promise<LocationDetail> {
    return this.request<LocationDetail>(`/locations/${encodeURIComponent(locationId)}`);
  }

  public listMyCommunities(
    input: { readonly limit?: number; readonly cursor?: string } = {},
  ): Promise<CommunityMembershipPage> {
    const query = new URLSearchParams();
    if (input.limit !== undefined) query.set('limit', String(input.limit));
    if (input.cursor) query.set('cursor', input.cursor);
    const suffix = query.size > 0 ? `?${query.toString()}` : '';
    return this.request<CommunityMembershipPage>(`/communities/mine${suffix}`);
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
  ): Promise<GameCommandResult> {
    const idempotencyKey = createCorrelationId();
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

  private async toApiClientError(
    response: Response,
    fallbackCorrelationId: string,
  ): Promise<ApiClientError> {
    const body = (await response.json().catch(() => undefined)) as
      { code?: string; message?: string; correlationId?: string } | undefined;
    return new ApiClientError(
      body?.message ?? 'Запрос не выполнен.',
      response.status,
      body?.code ?? 'UNEXPECTED_API_ERROR',
      body?.correlationId ?? response.headers.get('X-Correlation-ID') ?? fallbackCorrelationId,
    );
  }
}
