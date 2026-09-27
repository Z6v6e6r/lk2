// Synthetic fixtures for tests and intercepted local browser preview only. No live fallback.
import { PadlHubApiClient } from '@phub/api-sdk';
import type {
  AuthenticatedSession,
  HomeDashboard,
  HomeBase,
  UserUpcomingBookings,
  BookingPreferences,
  BookingRecommendationPage,
  PublicGameCard,
  LocationDetail,
} from '@phub/api-sdk';
import { createIOSFetch, IOSSession } from '../session.js';
import type { IOSSessionPlugin } from '../session.js';

export function nativeResult(body: unknown, status = 200) {
  return {
    status,
    headers: { 'Content-Type': 'application/json' },
    body: status === 204 ? '' : JSON.stringify(body),
  };
}

export function fixtureReply(
  input: Parameters<IOSSessionPlugin['request']>[0],
): ReturnType<typeof nativeResult> {
  if (input.operation === 'refresh' || input.operation === 'verify') return nativeResult(auth);
  if (input.operation === 'challenge')
    return nativeResult({ challengeId: viewerId, expiresAt: '2099-01-01T00:00:00Z' });
  if (input.operation === 'logout') return nativeResult(null, 204);
  if (input.operation !== 'read') throw new Error('Unexpected synthetic operation');
  switch (input.resource) {
    case 'homeBase':
      return nativeResult(homeBase);
    case 'home':
      return nativeResult(homeDashboard);
    case 'profile':
      return nativeResult(homeDashboard.profile);
    case 'preferences':
      return nativeResult(bookingPreferences);
    case 'privacy':
      return nativeResult(profilePrivacy);
    case 'bookings':
      return nativeResult(upcomingBookings);
    case 'recommendations':
      return nativeResult(bookingRecommendations);
    case 'communities':
      return nativeResult({ items: homeDashboard.communities });
    case 'history':
      return nativeResult({ items: [], nextCursor: null });
    case 'publicGames':
      return nativeResult({ items: [game], nextCursor: null });
    case 'game':
      return nativeResult({ game });
    case 'locations':
      return nativeResult({
        items: [
          {
            id: game.station.id,
            title: 'Селигерская',
            city: 'Москва',
            courtCount: 5,
            coverImageUrl: null,
            route: `/locations/${game.station.id}`,
          },
        ],
      });
    case 'location':
      return nativeResult(location);
    default:
      throw new Error('Unexpected synthetic resource');
  }
}

export function syntheticSession(
  request: IOSSessionPlugin['request'] = async (input) =>
    await Promise.resolve(fixtureReply(input)),
): IOSSession {
  const plugin = { configuration: async () => await Promise.resolve(config), request };
  return new IOSSession(
    config,
    new PadlHubApiClient({
      baseUrl: config.apiBaseUrl,
      tenantKey: config.tenantKey,
      platform: 'ios',
      sessionMode: 'cookie',
      appVersion: config.appVersion,
      fetchImplementation: createIOSFetch(config, plugin),
    }),
  );
}

export const viewerId = '00000000-0000-4000-8000-000000000001';
export const config = {
  apiBaseUrl: 'https://lk2.padlhub.su',
  tenantKey: 'local-padel',
  appVersion: '1.0',
  appBuild: '1',
};
export const auth: AuthenticatedSession = {
  accessToken: 'synthetic-short-lived-access',
  tokenType: 'Bearer',
  expiresAt: '2099-01-01T00:00:00Z',
  user: { id: viewerId, displayName: 'Анна Петрова' },
  context: {
    userId: viewerId,
    tenantId: '00000000-0000-4000-8000-000000000002',
    displayName: 'Анна Петрова',
    roles: ['client'],
    permissions: ['profile.read'],
  },
};

export const homeDashboard: HomeDashboard = {
  snapshot: {
    version: 'home-v1-test',
    generatedAt: '2099-10-15T09:00:00.000Z',
    staleAt: '2099-10-15T09:01:00.000Z',
    source: 'LOCAL_MOCK',
  },
  profile: {
    userId: viewerId,
    displayName: 'Анна Петрова',
    firstName: 'Анна',
    avatarUrl: null,
    phoneLast4: '0001',
    balanceMinor: 54000,
    currency: 'RUB',
    level: { label: 'C+', value: 3.8, assessmentRequired: false },
  },
  counters: { unreadChats: 2, upcomingEvents: 1, activeSubscriptions: 1 },
  quickActions: [
    {
      id: 'play',
      title: 'Найти игру',
      subtitle: 'Открытые игры рядом',
      route: '/games',
      tone: 'violet',
    },
  ],
  upcoming: [
    {
      id: '751fe6a8-b0b1-4b2b-873d-a2d785c4e191',
      kind: 'game',
      title: 'Американо · уровень C',
      startsAt: '2099-10-16T18:00:00.000Z',
      venue: 'ПаделХАБ · корт 2',
      status: 'confirmed',
      route: '/games/751fe6a8-b0b1-4b2b-873d-a2d785c4e191',
    },
  ],
  subscriptions: [
    {
      id: '24793a5a-0931-4a76-8600-267015be0ac9',
      title: 'Лето · Падел · Спорт',
      status: 'active',
      remainingUnits: 8,
      validUntil: '2099-12-15T00:00:00.000Z',
      route: '/subscriptions/24793a5a-0931-4a76-8600-267015be0ac9',
    },
  ],
  communities: [
    {
      id: '42c05c91-da23-4dc5-bf97-3d136a2d12bd',
      title: 'Padel Friends',
      logoUrl: null,
      isVerified: true,
      unreadChatCount: 2,
      route: '/communities/42c05c91-da23-4dc5-bf97-3d136a2d12bd',
    },
    {
      id: '2abf4d16-35d5-445b-91ff-75676469ad12',
      title: 'Тест',
      logoUrl: null,
      isVerified: false,
      unreadChatCount: 0,
      route: '/communities/2abf4d16-35d5-445b-91ff-75676469ad12',
    },
  ],
  promotion: null,
  promotions: { rotationEnabled: false, intervalSeconds: 6, items: [] },
  locations: [
    {
      id: 'a8df730b-6a67-41a5-8772-48bca84f73bc',
      title: 'Селигерская',
      courtCount: 5,
      imageUrl: null,
      route: '/locations/a8df730b-6a67-41a5-8772-48bca84f73bc',
    },
  ],
  additionalLinks: [
    { id: 'promotions', title: 'Все акции', route: '/promotions' },
    {
      id: 'gift_certificates',
      title: 'Подарочные сертификаты',
      route: '/gift-certificates',
    },
    { id: 'offers', title: 'Предложения', route: '/offers' },
  ],
  capabilities: {
    canCreateGame: true,
    canManageTournaments: false,
    canViewCommunities: true,
  },
};
export const homeBase: HomeBase = {
  snapshot: {
    version: 'home-base-v1-test',
    generatedAt: '2099-10-15T09:00:00.000Z',
    source: 'LOCAL_PROJECTION',
    completeness: 'PARTIAL',
  },
  viewerUserId: viewerId,
  quickActions: homeDashboard.quickActions,
  communities: {
    status: 'READY',
    revision: '1',
    observedAt: '2099-10-15T09:00:00.000Z',
    staleAt: '2099-10-15T09:05:00.000Z',
    value: homeDashboard.communities,
  },
  promotions: {
    status: 'READY',
    revision: '1',
    observedAt: '2099-10-15T09:00:00.000Z',
    staleAt: '2099-10-15T09:05:00.000Z',
    value: {
      hero: homeDashboard.promotions,
      standard: homeDashboard.promotions,
    },
  },
  locations: homeDashboard.locations,
  additionalLinks: homeDashboard.additionalLinks,
  capabilities: homeDashboard.capabilities,
};
export const profilePrivacy = {
  contactPolicy: 'AUTHORIZED' as const,
  chatPolicy: 'AUTHORIZED' as const,
  version: 1,
  updatedAt: '2099-10-17T12:00:00.000Z',
};
export const upcomingBookings: UserUpcomingBookings = {
  state: 'READY',
  version: homeDashboard.snapshot.version,
  generatedAt: homeDashboard.snapshot.generatedAt,
  staleAt: homeDashboard.snapshot.staleAt,
  items: homeDashboard.upcoming,
};
export const bookingPreferences: BookingPreferences = {
  favoriteStationIds: [],
  preferredTimeWindows: [{ weekday: 'ANY', startsAt: '09:00', endsAt: '22:00' }],
  useHistory: true,
  recommendFriends: true,
  recommendationDisplay: 'CARDS',
  version: 0,
  updatedAt: null,
};
export const bookingRecommendations: BookingRecommendationPage = {
  version: 'a'.repeat(64),
  generatedAt: '2099-10-18T09:00:00.000Z',
  staleAt: '2099-10-18T09:05:00.000Z',
  personalization: 'BASIC',
  items: [],
  nextCursor: null,
};
export const game: PublicGameCard = {
  id: '751fe6a8-b0b1-4b2b-873d-a2d785c4e191',
  revision: 7,
  surface: 'DISCOVER',
  displayState: 'ONE_SPOT_LEFT',
  title: 'Рейтинговая игра вечером',
  kind: 'RATING',
  visibility: 'PUBLIC',
  startsAt: '2099-10-20T15:00:00.000Z',
  endsAt: '2099-10-20T16:00:00.000Z',
  timezone: 'Europe/Moscow',
  station: { id: 'a8df730b-6a67-41a5-8772-48bca84f73bc', name: 'Селигерская' },
  court: { id: 'bd35543d-c565-443a-bd3d-eea68eb2fbe6', name: 'Корт №3' },
  levelRange: { from: 'C', to: 'C+' },
  rosterState: 'LAST_SPOT',
  capacity: { total: 4, occupied: 3, reserved: 0, open: 1, waitlistCount: 0 },
  participants: [
    { displayName: 'Анна', avatarUrl: null, level: 'C', role: 'ORGANIZER' },
    { displayName: 'Борис', avatarUrl: null, level: 'C', role: 'PLAYER' },
    { displayName: 'Вера', avatarUrl: null, level: 'C+', role: 'PLAYER' },
  ],
  priceSummary: null,
  viewerRelation: 'ANONYMOUS',
  viewerPaymentState: 'NOT_REQUIRED',
  badges: ['RATING'],
  allowedActions: ['OPEN_DETAILS', 'JOIN'],
  deepLink: '/games/751fe6a8-b0b1-4b2b-873d-a2d785c4e191',
};

export const location: LocationDetail = {
  id: game.station.id,
  slug: 'seligerskaya',
  title: 'Хаб Селигерская',
  shortTitle: 'Селигерская',
  city: 'Москва',
  courtCount: 5,
  address: 'Тестовая улица, 1',
  coordinates: null,
  timezone: 'Europe/Moscow',
  metro: { name: 'Селигерская', distanceMeters: 400 },
  phoneE164: null,
  gallery: [],
  amenities: [
    {
      key: 'parking',
      icon: 'PARKING',
      title: 'Бесплатная парковка',
      description: null,
      sortOrder: 0,
    },
  ],
  workingHours: [
    { weekday: 'MON', closed: false, intervals: [{ opensAt: '07:00', closesAt: '23:00' }] },
  ],
  openNow: true,
  workingHoursSummary: 'Сегодня, 07:00—23:00',
  navigationUrl: null,
  route: `/locations/${game.station.id}`,
};
