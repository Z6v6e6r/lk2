import { ApiClientError } from '@phub/api-sdk';
import type {
  PadlHubApiClient,
  PlayerProfileView,
  PublicGameFilters,
  UserProfile,
} from '@phub/api-sdk';
import type {
  ActivityHistoryQuery,
  HomeBookingRecommendationFilters,
} from '../../../web/src/auth-gateway.js';
import type { IOSSession } from './session.js';
import { resolveCabinetMedia } from './cabinet-media.js';

function requireViewer(actual: string, expected: string): void {
  if (actual !== expected)
    throw new ApiClientError('Account does not match', 403, 'NATIVE_ACCOUNT_MISMATCH', 'native');
}

export function selfProfile(profile: UserProfile): PlayerProfileView {
  return {
    profile: {
      userId: profile.userId,
      displayName: profile.displayName,
      ...(profile.firstName === undefined ? {} : { firstName: profile.firstName }),
      ...(profile.avatarUrl === undefined ? {} : { avatarUrl: profile.avatarUrl }),
      ...(profile.level === undefined ? {} : { level: profile.level }),
    },
    reachable: true,
    privateAccount: {
      ...(profile.phoneLast4 ? { phoneLast4: profile.phoneLast4 } : {}),
      ...(profile.balanceMinor === undefined ? {} : { balanceMinor: profile.balanceMinor }),
      ...(profile.currency === undefined ? {} : { currency: profile.currency }),
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

/** Only existing SDK reads. No browser gateway, provider delegation, or command fallback. */
export function createCabinetData(session: IOSSession, viewerId: string) {
  const read = async <T>(load: (api: PadlHubApiClient) => Promise<T>): Promise<T> =>
    resolveCabinetMedia(await session.read(load), session.configuration.apiBaseUrl);
  const profile = () =>
    read(async (api) => {
      const value = await api.getUserProfile();
      requireViewer(value.userId, viewerId);
      return value;
    });
  const dashboard = () =>
    read(async (api) => {
      const value = await api.getHomeDashboard();
      requireViewer(value.profile.userId, viewerId);
      return value;
    });
  return {
    profile,
    dashboard,
    home: () =>
      read(async (api) => {
        const value = await api.getHomeBase();
        requireViewer(value.viewerUserId, viewerId);
        return value;
      }),
    bookings: () =>
      read(async (api) => {
        const bookings = await api.getUpcomingBookings();
        if (bookings.state === 'UNAVAILABLE') throw new Error('Bookings unavailable');
        return bookings;
      }),
    preferences: () => read((api) => api.getBookingPreferences()),
    privacy: () => read((api) => api.getProfilePrivacySettings()),
    locations: () => read((api) => api.listLocations()),
    location: (id: string) => read((api) => api.getLocation(id)),
    game: (id: string) => read((api) => api.getGame(id)),
    games: (input: PublicGameFilters = {}) => read((api) => api.listPublicGames(input)),
    communities: (cursor?: string, limit = 20) =>
      read((api) =>
        api.listMyCommunities({
          limit,
          ...(cursor ? { cursor } : {}),
        }),
      ),
    recommendations: (input: HomeBookingRecommendationFilters = {}) =>
      read((api) => {
        // This GET contract has no selected-day field; never pretend an unfiltered page is filtered.
        if (input.localDate) throw new Error('Selected-day recommendations are unavailable');
        return api.listBookingRecommendations({
          limit: Math.min(input.limit ?? 6, 20),
          ...(input.cursor ? { cursor: input.cursor } : {}),
        });
      }),
    history: (input: ActivityHistoryQuery = {}) => read((api) => api.listActivityHistory(input)),
  };
}

export type CabinetData = ReturnType<typeof createCabinetData>;
