import { ApiClientError, PadlHubApiClient } from '@phub/api-sdk';
import type {
  AuthenticatedSession as ApiAuthenticatedSession,
  BookingPreferences,
  BookingPreferencesUpdateRequest,
  BookingRecommendationPage,
  ClientRoutingPlan,
  CommunityMembershipPage,
  GameCard,
  GameCardPage,
  GameCommandResult,
  HomeDashboard,
  LocationDetail,
  LocationList,
  NotificationInboxPage,
  PlayerProfileView,
  PublicGameCardPage,
  PublicGameFilters,
  ProfilePrivacySettings,
  ProfilePrivacyUpdateRequest,
  UserProfile,
  UserUpcomingBookings,
  UserContext as ApiUserContext,
  WebPushConfiguration,
  WebPushEndpointCommandResult,
  WebPushEndpointRegistration,
} from '@phub/api-sdk';
export type {
  BookingPreferences,
  BookingPreferencesUpdateRequest,
  BookingRecommendationPage,
  ClientRoutingPlan,
  CommunityMembershipPage,
  GameCard,
  GameCardPage,
  GameCommandResult,
  HomeDashboard,
  LocationDetail,
  LocationList,
  NotificationInboxPage,
  PlayerProfileView,
  PublicGameCard,
  PublicGameCardPage,
  PublicGameFilters,
  ProfilePrivacySettings,
  ProfilePrivacyUpdateRequest,
  UserProfile,
  UserUpcomingBookings,
  WebPushConfiguration,
  WebPushEndpointCommandResult,
  WebPushEndpointRegistration,
} from '@phub/api-sdk';
import { maskPhone } from '@phub/auth';
import {
  createClientTransportExecutor,
  normalizePadlHubUpcomingBookings,
  normalizePadlHubUserProfile,
  normalizeVivaUserProfile,
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
}

export interface AuthenticatedSession {
  readonly context: UserContext;
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
  readonly getRoutingPlan: (forceRefresh?: boolean) => Promise<ClientRoutingPlan>;
  readonly getUserProfile: (userId: string) => Promise<UserProfile>;
  readonly getPlayerProfile: (userId: string) => Promise<PlayerProfileView>;
  readonly getProfilePrivacy: () => Promise<ProfilePrivacySettings>;
  readonly updateProfilePrivacy: (
    input: ProfilePrivacyUpdateRequest,
  ) => Promise<ProfilePrivacySettings>;
  readonly getBookingPreferences: () => Promise<BookingPreferences>;
  readonly updateBookingPreferences: (
    input: BookingPreferencesUpdateRequest,
  ) => Promise<BookingPreferences>;
  readonly getUpcomingBookings: () => Promise<UserUpcomingBookings>;
  readonly listBookingRecommendations: (limit?: number) => Promise<BookingRecommendationPage>;
  readonly getHomeDashboard: () => Promise<HomeDashboard>;
  readonly listPublicGames: (input?: PublicGameFilters) => Promise<PublicGameCardPage>;
  readonly listMyGames: (input?: {
    readonly scope?: 'UPCOMING' | 'HISTORY';
    readonly limit?: number;
    readonly cursor?: string;
  }) => Promise<GameCardPage>;
  readonly getGame: (gameId: string) => Promise<GameCard>;
  readonly joinGame: (gameId: string, expectedRevision?: number) => Promise<GameCommandResult>;
  readonly leaveGame: (gameId: string) => Promise<GameCommandResult>;
  readonly joinGameWaitlist: (gameId: string) => Promise<GameCommandResult>;
  readonly leaveGameWaitlist: (gameId: string) => Promise<GameCommandResult>;
  readonly getGameOperation: (operationId: string) => Promise<GameCommandResult>;
  readonly listLocations: () => Promise<LocationList>;
  readonly getLocation: (locationId: string) => Promise<LocationDetail>;
  readonly listMyCommunities: (cursor?: string) => Promise<CommunityMembershipPage>;
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
  };
}

function isUnauthorized(error: unknown): boolean {
  return error instanceof ApiClientError && error.status === 401;
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
  let homeDashboardPromise: Promise<HomeDashboard> | undefined;
  let locationsPromise: Promise<LocationList> | undefined;
  let communityMembershipsPromise: Promise<CommunityMembershipPage> | undefined;
  let routingPlan: ClientRoutingPlan | undefined;
  let routingPlanPromise: Promise<ClientRoutingPlan> | undefined;
  let userProfilePromise: Promise<UserProfile> | undefined;
  const playerProfilePromises = new Map<string, Promise<PlayerProfileView>>();
  let profilePrivacyPromise: Promise<ProfilePrivacySettings> | undefined;
  let bookingPreferencesPromise: Promise<BookingPreferences> | undefined;
  let upcomingBookingsPromise: Promise<UserUpcomingBookings> | undefined;

  async function applyVivaAccess(handoffCode?: string): Promise<string> {
    const access = await client.issueVivaAccessToken(handoffCode ? { handoffCode } : {});
    vivaAccessToken = access.accessToken;
    vivaAccessExpiresAt = Date.parse(access.expiresAt);
    return access.accessToken;
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

  const transportExecutor = createClientTransportExecutor({
    getRoutingPlan: loadRoutingPlan,
    getVivaAccessToken: () =>
      vivaAccessToken && vivaAccessExpiresAt > Date.now() + 30_000 ? vivaAccessToken : undefined,
    refreshVivaAccessToken: () => applyVivaAccess(),
    executePadlHub: (request) => {
      if (request.operation === 'profile.read') {
        return client.getUserProfile();
      }
      if (request.operation === 'bookings.read') {
        return client.getUpcomingBookings();
      }
      return Promise.reject(new Error(`PadlHub operation ${request.operation} is not connected`));
    },
    ...(options.fetchImplementation ? { fetchImplementation: options.fetchImplementation } : {}),
  });

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

    getRoutingPlan(forceRefresh = false) {
      return loadRoutingPlan(forceRefresh);
    },

    getUserProfile(userId) {
      userProfilePromise ??= transportExecutor
        .executeRead({
          request: { operation: 'profile.read' },
          normalizePadlHub: normalizePadlHubUserProfile,
          normalizeViva: (payload) => normalizeVivaUserProfile(payload, userId),
        })
        .catch((error: unknown) => {
          userProfilePromise = undefined;
          throw error;
        });
      return userProfilePromise;
    },

    getPlayerProfile(userId) {
      const cached = playerProfilePromises.get(userId);
      if (cached) return cached;
      const request = client.getPlayerProfile(userId).catch((error: unknown) => {
        if (playerProfilePromises.get(userId) === request) playerProfilePromises.delete(userId);
        throw error;
      });
      playerProfilePromises.set(userId, request);
      return request;
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
      upcomingBookingsPromise ??= transportExecutor
        .executeRead({
          request: { operation: 'bookings.read', page: 0, size: 6 },
          normalizePadlHub: normalizePadlHubUpcomingBookings,
          normalizeViva: () => {
            throw new Error('DIRECT_VIVA_BOOKINGS_CONTRACT_NOT_READY');
          },
        })
        .catch((error: unknown) => {
          upcomingBookingsPromise = undefined;
          throw error;
        });
      return upcomingBookingsPromise;
    },

    listBookingRecommendations(limit = 6) {
      return client.listBookingRecommendations(limit);
    },

    getHomeDashboard() {
      if (homeDashboardPromise) return homeDashboardPromise;
      const request = client.getHomeDashboard().finally(() => {
        if (homeDashboardPromise === request) homeDashboardPromise = undefined;
      });
      homeDashboardPromise = request;
      return request;
    },

    listPublicGames(input = {}) {
      return client.listPublicGames(input);
    },

    listMyGames(input = {}) {
      return client.listMyGames(input);
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

    listMyCommunities(cursor) {
      if (cursor) return client.listMyCommunities({ limit: 20, cursor });
      if (communityMembershipsPromise) return communityMembershipsPromise;
      const request = client.listMyCommunities({ limit: 20 }).finally(() => {
        if (communityMembershipsPromise === request) communityMembershipsPromise = undefined;
      });
      communityMembershipsPromise = request;
      return request;
    },

    listNotifications() {
      return client.listNotifications({ limit: 50 });
    },

    async markNotificationsRead(throughId) {
      await client.markNotificationsRead(throughId);
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
      homeDashboardPromise = undefined;
      locationsPromise = undefined;
      communityMembershipsPromise = undefined;
      routingPlan = undefined;
      routingPlanPromise = undefined;
      userProfilePromise = undefined;
      playerProfilePromises.clear();
      profilePrivacyPromise = undefined;
      bookingPreferencesPromise = undefined;
      upcomingBookingsPromise = undefined;
    },
  };
}
