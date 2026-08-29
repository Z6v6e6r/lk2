// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import {
  act,
  cleanup,
  configure,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

const realtimeMocks = vi.hoisted(() => ({
  connect: vi.fn(() => ({ stop: vi.fn() })),
}));

vi.mock('./chat-realtime-client.js', () => ({ connectChatRealtime: realtimeMocks.connect }));

import { App } from './App.js';
import { consumeCommunityInviteToken } from './community-invite-token.js';
import { prepareCreateGameAttempt } from './create-game-attempt.js';
import type {
  AuthGateway,
  AuthenticatedSession,
  BookingPreferences,
  BookingRecommendationPage,
  CommunityMembershipPage,
  HomeBase,
  HomeDashboard,
  NotificationInboxPage,
  PlayerProfileView,
  PublicGiftCertificateCatalog,
  UserUpcomingBookings,
} from './auth-gateway.js';

configure({ asyncUtilTimeout: 3_000 });

const session: AuthenticatedSession = {
  context: {
    user: {
      id: '00000000-0000-4000-8000-000000000001',
      displayName: 'Анна Петрова',
      phoneMasked: '+7 *** ***-**-01',
    },
    tenant: {
      id: '00000000-0000-4000-8000-000000000002',
      key: 'padlhub',
      name: 'ПаделХАБ',
    },
    roles: ['client'],
    permissions: ['profile.read'],
  },
};

const homeDashboard: HomeDashboard = {
  snapshot: {
    version: 'home-v1-test',
    generatedAt: '2026-07-15T09:00:00.000Z',
    staleAt: '2026-07-15T09:01:00.000Z',
    source: 'LOCAL_MOCK',
  },
  profile: {
    userId: session.context.user.id,
    displayName: session.context.user.displayName,
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
      startsAt: '2026-07-16T18:00:00.000Z',
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
      validUntil: '2026-09-15T00:00:00.000Z',
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

const homeBase: HomeBase = {
  snapshot: {
    version: 'home-base-v1-test',
    generatedAt: '2026-07-15T09:00:00.000Z',
    source: 'LOCAL_PROJECTION',
    completeness: 'PARTIAL',
  },
  viewerUserId: session.context.user.id,
  quickActions: homeDashboard.quickActions,
  communities: {
    status: 'READY',
    revision: '1',
    observedAt: '2026-07-15T09:00:00.000Z',
    staleAt: '2026-07-15T09:05:00.000Z',
    value: homeDashboard.communities,
  },
  promotions: {
    status: 'READY',
    revision: '1',
    observedAt: '2026-07-15T09:00:00.000Z',
    staleAt: '2026-07-15T09:05:00.000Z',
    value: {
      hero: homeDashboard.promotions,
      standard: homeDashboard.promotions,
    },
  },
  locations: homeDashboard.locations,
  additionalLinks: homeDashboard.additionalLinks,
  capabilities: homeDashboard.capabilities,
};

const userProfile: PlayerProfileView = {
  profile: {
    userId: homeDashboard.profile.userId,
    displayName: homeDashboard.profile.displayName,
    firstName: 'Анна',
    avatarUrl: null,
    level: homeDashboard.profile.level,
  },
  privateAccount: {
    phoneLast4: '0001',
    balanceMinor: homeDashboard.profile.balanceMinor,
    currency: homeDashboard.profile.currency,
  },
  access: {
    audience: 'SELF',
    tier: 'SELF',
    visibleSections: ['BASIC', 'PLAYER_LEVEL', 'PLAYER_RATING', 'PRIVATE_ACCOUNT'],
    contact: { status: 'HIDDEN', reason: 'SELF_PROFILE' },
    chat: { status: 'HIDDEN', reason: 'SELF_PROFILE' },
  },
};
const profilePrivacy = {
  contactPolicy: 'AUTHORIZED' as const,
  chatPolicy: 'AUTHORIZED' as const,
  version: 1,
  updatedAt: '2026-07-17T12:00:00.000Z',
};
const upcomingBookings: UserUpcomingBookings = {
  version: homeDashboard.snapshot.version,
  generatedAt: homeDashboard.snapshot.generatedAt,
  staleAt: homeDashboard.snapshot.staleAt,
  items: homeDashboard.upcoming,
};
const notificationInbox: NotificationInboxPage = {
  unreadCount: 1,
  items: [
    {
      id: '3e0ea679-e151-41ab-8c82-4b5da38a0fd4',
      category: 'BOOKING_REMINDER',
      title: 'Игра уже скоро',
      body: 'Начало сегодня в 18:00.',
      deepLink: '/games/751fe6a8-b0b1-4b2b-873d-a2d785c4e191',
      createdAt: '2026-07-16T15:00:00.000Z',
    },
  ],
};
const communityMemberships: CommunityMembershipPage = {
  items: homeDashboard.communities,
};
const bookingPreferences: BookingPreferences = {
  favoriteStationIds: [],
  preferredTimeWindows: [{ weekday: 'ANY', startsAt: '09:00', endsAt: '22:00' }],
  useHistory: true,
  recommendFriends: true,
  recommendationDisplay: 'CARDS',
  version: 0,
  updatedAt: null,
};
const bookingRecommendations: BookingRecommendationPage = {
  version: 'a'.repeat(64),
  generatedAt: '2026-07-18T09:00:00.000Z',
  staleAt: '2026-07-18T09:05:00.000Z',
  personalization: 'BASIC',
  items: [],
  nextCursor: null,
};
const giftCertificateCatalog: PublicGiftCertificateCatalog = {
  id: '11111111-1111-4111-8111-111111111111',
  catalogNumber: 1,
  title: 'Подарочные сертификаты',
  availableFrom: null,
  availableTo: null,
  flowSteps: ['DESIGN', 'DENOMINATION', 'REVIEW'],
  policy: {
    validityStart: 'ISSUE',
    validityDays: 365,
    activationDeadlineDays: null,
    scheduledDeliveryEnabled: false,
    emailAttachmentEnabled: false,
  },
  designs: [
    {
      id: '22222222-2222-4222-8222-222222222222',
      key: 'classic',
      audience: 'UNIVERSAL',
      title: 'Классический',
      description: null,
      imageUrl: 'https://cdn.padlhub.test/gift/classic.webp',
      alt: 'Сертификат',
      codeXPercent: 5.1,
      codeYPercent: 88,
      amountXPercent: 78.3,
      amountYPercent: 88,
      active: true,
      sortOrder: 10,
    },
  ],
  denominations: [
    {
      id: '33333333-3333-4333-8333-333333333333',
      amountMinor: 500_000,
      currency: 'RUB',
      active: true,
      sortOrder: 10,
    },
  ],
  publishedAt: '2026-07-19T10:00:00.000Z',
};

function createGateway(overrides: Partial<AuthGateway> = {}): AuthGateway {
  return {
    restoreSession: vi.fn().mockResolvedValue(null),
    requestCode: vi.fn().mockResolvedValue({
      challengeId: 'challenge-1',
      maskedPhone: '+7 *** ***-**-01',
      expiresAt: '2026-07-11T12:05:00.000Z',
      resendAt: '2026-07-11T12:01:00.000Z',
    }),
    verifyCode: vi.fn().mockResolvedValue(session),
    startVivaOAuth: vi.fn().mockResolvedValue(undefined),
    getVivaAccessToken: vi.fn().mockReturnValue(undefined),
    refreshVivaAccessToken: vi.fn().mockResolvedValue('viva-access-token'),
    getRoutingPlan: vi.fn().mockResolvedValue({
      revision: '1',
      mode: 'PADLHUB_ONLY',
      issuedAt: '2026-07-15T08:00:00.000Z',
      expiresAt: '2099-07-15T08:01:00.000Z',
      operations: [],
    }),
    getSelfProfile: vi.fn().mockResolvedValue(homeDashboard.profile),
    getUserProfile: vi.fn().mockResolvedValue(homeDashboard.profile),
    getPlayerProfile: vi.fn().mockResolvedValue(userProfile),
    getProfilePrivacy: vi.fn().mockResolvedValue(profilePrivacy),
    updateProfilePrivacy: vi.fn().mockResolvedValue(profilePrivacy),
    listProfileFriends: vi.fn().mockResolvedValue({ items: [] }),
    getProfileFriendship: vi.fn().mockResolvedValue({
      userId: '6a81e965-c508-4321-812c-4be323606a70',
      status: 'NONE',
      createdAt: null,
    }),
    addProfileFriend: vi.fn().mockResolvedValue({
      userId: '6a81e965-c508-4321-812c-4be323606a70',
      status: 'FRIEND',
      createdAt: '2026-07-26T10:00:00.000Z',
    }),
    getBookingPreferences: vi.fn().mockResolvedValue(bookingPreferences),
    updateBookingPreferences: vi.fn().mockResolvedValue(bookingPreferences),
    getUpcomingBookings: vi.fn().mockResolvedValue(upcomingBookings),
    listBookingRecommendations: vi.fn().mockResolvedValue(bookingRecommendations),
    recordPromotionEngagement: vi.fn().mockResolvedValue({ accepted: true }),
    listTrainingSchedule: vi.fn().mockResolvedValue({
      version: 'a'.repeat(64),
      generatedAt: '2026-07-30T09:00:00.000Z',
      staleAt: '2026-07-30T09:01:00.000Z',
      items: [],
    }),
    listEventCatalog: vi.fn().mockResolvedValue({
      state: 'READY',
      snapshotVersion: 'a'.repeat(64),
      generatedAt: '2026-07-30T09:00:00.000Z',
      staleAt: '2026-07-30T09:01:00.000Z',
      items: [],
      nextCursor: null,
      totalMatched: 0,
      facets: { kinds: [], categories: [], stations: [] },
      sourceStatus: [{ source: 'SCHEDULE', localDate: null, state: 'READY', errorCode: null }],
    }),
    continueEventCatalog: vi.fn().mockRejectedValue(new Error('CATALOG_CURSOR_INVALID')),
    getHomeBase: vi.fn().mockResolvedValue(homeBase),
    getHomeDashboard: vi.fn().mockResolvedValue(homeDashboard),
    getPublicGiftCertificateCatalog: vi.fn().mockRejectedValue(new Error('GIFT_CATALOG_MISSING')),
    createPublicGiftCertificateOrder: vi.fn().mockRejectedValue(new Error('GIFT_SALE_DISABLED')),
    createPublicGiftCertificatePaymentIntent: vi
      .fn()
      .mockRejectedValue(new Error('GIFT_SALE_DISABLED')),
    getPublicGiftCertificateOrder: vi.fn().mockRejectedValue(new Error('GIFT_ORDER_NOT_FOUND')),
    downloadPublicGiftCertificate: vi
      .fn()
      .mockRejectedValue(new Error('GIFT_CERTIFICATE_ARTIFACT_NOT_READY')),
    createGiftCertificateOrder: vi.fn().mockRejectedValue(new Error('GIFT_SALE_DISABLED')),
    createGiftCertificatePaymentIntent: vi.fn().mockRejectedValue(new Error('GIFT_SALE_DISABLED')),
    getGiftCertificateOrder: vi.fn().mockRejectedValue(new Error('GIFT_ORDER_NOT_FOUND')),
    downloadGiftCertificate: vi
      .fn()
      .mockRejectedValue(new Error('GIFT_CERTIFICATE_ARTIFACT_NOT_READY')),
    listPublicGames: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    listMyGames: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    getActivityHistory: vi.fn().mockResolvedValue({
      items: [],
      nextCursor: null,
      freshness: 'FRESH',
      coverage: 'COMPLETE',
      generatedAt: '2026-07-21T09:00:00.000Z',
    }),
    getGame: vi.fn().mockRejectedValue(new Error('GAME_NOT_FOUND')),
    createGame: vi.fn().mockRejectedValue(new Error('GAME_COMMAND_NOT_CONFIGURED')),
    cancelGame: vi.fn().mockRejectedValue(new Error('GAME_COMMAND_NOT_CONFIGURED')),
    joinGame: vi.fn().mockRejectedValue(new Error('GAME_COMMAND_NOT_CONFIGURED')),
    leaveGame: vi.fn().mockRejectedValue(new Error('GAME_COMMAND_NOT_CONFIGURED')),
    joinGameWaitlist: vi.fn().mockRejectedValue(new Error('GAME_COMMAND_NOT_CONFIGURED')),
    leaveGameWaitlist: vi.fn().mockRejectedValue(new Error('GAME_COMMAND_NOT_CONFIGURED')),
    submitGameResult: vi.fn().mockRejectedValue(new Error('GAME_COMMAND_NOT_CONFIGURED')),
    confirmGameResult: vi.fn().mockRejectedValue(new Error('GAME_COMMAND_NOT_CONFIGURED')),
    disputeGameResult: vi.fn().mockRejectedValue(new Error('GAME_COMMAND_NOT_CONFIGURED')),
    getGameOperation: vi.fn().mockRejectedValue(new Error('GAME_COMMAND_NOT_CONFIGURED')),
    listLocations: vi.fn<AuthGateway['listLocations']>().mockResolvedValue({ items: [] }),
    getLocation: vi
      .fn<AuthGateway['getLocation']>()
      .mockRejectedValue(new Error('LOCATION_NOT_FOUND')),
    listMyCommunities: vi.fn().mockResolvedValue(communityMemberships),
    getCommunityReadExperienceDetail: vi.fn().mockRejectedValue(new Error('NOT_CONFIGURED')),
    listCommunityReadExperienceFeed: vi.fn().mockRejectedValue(new Error('NOT_CONFIGURED')),
    listCommunityReadExperienceChat: vi.fn().mockRejectedValue(new Error('NOT_CONFIGURED')),
    getCommunityReadExperienceRating: vi.fn().mockRejectedValue(new Error('NOT_CONFIGURED')),
    issueRealtimeTicket: vi.fn().mockResolvedValue({
      ticket: 'one-time-realtime-ticket-that-is-long-enough',
      expiresAt: '2026-08-04T10:00:30.000Z',
    }),
    discoverCommunities: vi.fn().mockResolvedValue({ items: [] }),
    getCommunityDetail: vi.fn().mockRejectedValue(new Error('COMMUNITY_NOT_FOUND')),
    getMyCommunityMembershipState: vi.fn().mockResolvedValue({
      communityId: '11111111-1111-4111-8111-111111111111',
      membershipStatus: 'NONE',
      role: null,
      membershipRevision: 0,
      joinRequest: null,
      joinAction: 'REQUEST_TO_JOIN',
      updatedAt: null,
    }),
    joinOrRequestCommunityMembership: vi
      .fn()
      .mockRejectedValue(new Error('COMMUNITY_COMMAND_UNAVAILABLE')),
    cancelMyCommunityJoinRequest: vi
      .fn()
      .mockRejectedValue(new Error('COMMUNITY_COMMAND_UNAVAILABLE')),
    leaveCommunity: vi.fn().mockRejectedValue(new Error('COMMUNITY_COMMAND_UNAVAILABLE')),
    listCommunityFeed: vi.fn().mockResolvedValue({
      items: [],
      watermark: '2026-08-04T10:00:00.000Z',
    }),
    recoverCommunityEvents: vi.fn().mockResolvedValue({
      items: [],
      afterSequence: 0,
      latestSequence: 0,
      retainedFromSequence: 1,
      hasMore: false,
    }),
    createCommunityPost: vi.fn().mockRejectedValue(new Error('COMMUNITY_COMMAND_UNAVAILABLE')),
    issueCommunityMediaUpload: vi.fn().mockRejectedValue(new Error('COMMUNITY_MEDIA_UNAVAILABLE')),
    finalizeCommunityMediaUpload: vi
      .fn()
      .mockRejectedValue(new Error('COMMUNITY_MEDIA_UNAVAILABLE')),
    getCommunityMediaStatus: vi.fn().mockRejectedValue(new Error('COMMUNITY_MEDIA_UNAVAILABLE')),
    downloadCommunityMediaVariant: vi
      .fn()
      .mockRejectedValue(new Error('COMMUNITY_MEDIA_UNAVAILABLE')),
    previewCommunityDirectInvite: vi
      .fn()
      .mockRejectedValue(new Error('COMMUNITY_DIRECT_INVITE_NOT_FOUND')),
    redeemCommunityDirectInvite: vi
      .fn()
      .mockRejectedValue(new Error('COMMUNITY_DIRECT_INVITE_NOT_FOUND')),
    listCommunityDirectInvites: vi.fn().mockResolvedValue({ items: [] }),
    createCommunityDirectInvite: vi
      .fn()
      .mockRejectedValue(new Error('COMMUNITY_COMMAND_UNAVAILABLE')),
    revokeCommunityDirectInvite: vi
      .fn()
      .mockRejectedValue(new Error('COMMUNITY_COMMAND_UNAVAILABLE')),
    getProfileLevelHistory: vi.fn().mockResolvedValue({
      userId: session.context.user.id,
      items: [
        {
          changedAt: '2026-07-20T12:00:00.000Z',
          levelLabel: 'C',
          levelValue: 3.1,
        },
      ],
    }),
    listConversations: vi.fn().mockResolvedValue({ items: [] }),
    createRealtimeTicket: vi.fn().mockRejectedValue(new Error('REALTIME_MESSAGING_DISABLED')),
    createDirectConversation: vi.fn().mockRejectedValue(new Error('MESSAGING_HTTP_DISABLED')),
    getOrCreateGameConversation: vi
      .fn()
      .mockRejectedValue(new Error('CONTEXTUAL_MESSAGING_DISABLED')),
    listConversationMessages: vi.fn().mockResolvedValue({ messages: [] }),
    sendConversationMessage: vi.fn().mockRejectedValue(new Error('MESSAGING_HTTP_DISABLED')),
    markConversationRead: vi.fn().mockResolvedValue({
      outcome: 'ok',
      readThroughSequence: 0,
      changed: false,
      replayed: false,
    }),
    listNotifications: vi.fn().mockResolvedValue(notificationInbox),
    markNotificationsRead: vi.fn().mockResolvedValue(undefined),
    getWebPushConfiguration: vi.fn().mockResolvedValue({
      enabled: false,
      reason: 'GLOBAL_GATE_DISABLED',
    }),
    registerWebPushEndpoint: vi.fn().mockResolvedValue({
      outcome: 'updated',
      endpointId: 'c3889c99-b0e3-4a3d-b3e8-a5c99af730ea',
      installationId: 'cb728115-fe62-4917-bf8f-dc8d4aa67545',
      status: 'ACTIVE',
      replayed: false,
    }),
    revokeWebPushEndpoint: vi.fn().mockResolvedValue({
      outcome: 'updated',
      endpointId: 'c3889c99-b0e3-4a3d-b3e8-a5c99af730ea',
      installationId: 'cb728115-fe62-4917-bf8f-dc8d4aa67545',
      status: 'REVOKED',
      replayed: false,
    }),
    logout: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  realtimeMocks.connect.mockClear();
  vi.useRealTimers();
  window.localStorage.clear();
  window.history.replaceState({}, '', '/');
});

async function openPhoneLogin(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(await screen.findByRole('button', { name: 'Войти по номеру телефона' }));
  await user.click(screen.getByRole('checkbox', { name: /публичной оферты/i }));
  await user.click(screen.getByRole('checkbox', { name: /обработку персональных данных/i }));
}

describe('PadlHub web authentication', () => {
  it('captures a DIRECT invite from the fragment and immediately removes it from the URL', () => {
    const replaceState = vi.fn();
    const token = 'z'.repeat(43);

    expect(
      consumeCommunityInviteToken(
        { pathname: '/community-invite', search: '?source=share', hash: `#${token}` },
        { state: { test: true }, replaceState },
      ),
    ).toBe(token);
    expect(replaceState).toHaveBeenCalledWith({ test: true }, '', '/community-invite?source=share');
  });

  it('retries an initial Home projection read before showing the unavailable screen', async () => {
    const getHomeBase = vi
      .fn<AuthGateway['getHomeBase']>()
      .mockRejectedValueOnce(new Error('HOME_PROJECTION_NOT_READY'))
      .mockResolvedValueOnce(homeBase);
    const gateway = createGateway({
      restoreSession: vi.fn().mockResolvedValue(session),
      getHomeBase,
    });

    render(<App gateway={gateway} tenantKey="padlhub" />);

    await screen.findByText('Загружаем один актуальный снимок…');
    expect(screen.queryByRole('heading', { name: 'Главная недоступна' })).not.toBeInTheDocument();

    expect(
      await screen.findByRole('heading', { name: 'Анна Петрова' }, { timeout: 3_000 }),
    ).toBeVisible();
    expect(getHomeBase).toHaveBeenCalledTimes(2);
  });

  it('restores an HttpOnly-cookie-backed session before showing protected home', async () => {
    const gateway = createGateway({ restoreSession: vi.fn().mockResolvedValue(session) });

    render(<App gateway={gateway} tenantKey="padlhub" />);

    expect(screen.getByRole('status')).toHaveTextContent('Проверяем сессию');
    expect(await screen.findByRole('heading', { name: 'Анна Петрова' })).toBeVisible();
    expect(screen.getAllByText('ПаделХАБ').length).toBeGreaterThan(0);
    expect(screen.getByRole('region', { name: 'Сообщества' })).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'Сообщества' })).not.toBeInTheDocument();
    const homeActions = screen.getByRole('navigation', { name: 'Разделы клуба' });
    expect(within(homeActions).getAllByRole('link')).toHaveLength(2);
    expect(within(homeActions).getByRole('link', { name: 'Играть' })).toHaveAttribute(
      'href',
      '/games',
    );
    expect(within(homeActions).queryByRole('link', { name: 'Турниры' })).not.toBeInTheDocument();
    expect(within(homeActions).getByRole('link', { name: 'Тренироваться' })).toHaveAttribute(
      'href',
      '/trainings',
    );
    expect(screen.getByRole('tab', { name: 'Мои записи' })).toHaveAttribute(
      'aria-selected',
      'false',
    );
    expect(screen.getByRole('tab', { name: 'Для меня' })).toHaveAttribute('aria-selected', 'true');
    const bottomNavigation = screen.getByRole('navigation', { name: 'Основная навигация' });
    const bottomNavigationLinks = within(bottomNavigation).getAllByRole('link');
    expect(bottomNavigationLinks).toHaveLength(5);
    expect(bottomNavigationLinks[2]).toHaveAccessibleName('Создать игру');
    expect(bottomNavigationLinks[2]).toHaveAttribute('href', '/games/new?new=1');
    expect(bottomNavigationLinks[2]?.querySelector('.fh-create-button svg')).toHaveAttribute(
      'viewBox',
      '0 0 88 72',
    );
    expect(bottomNavigationLinks[2]?.querySelector('.fh-create-button rect')).toHaveAttribute(
      'width',
      '56',
    );
    expect(screen.queryByRole('link', { name: 'Чаты' })).not.toBeInTheDocument();
    const communityCard = screen.getByRole('group', {
      name: 'Padel Friends, непрочитанных сообщений: 2',
    });
    expect(communityCard.querySelector('.fh-community-title')).not.toBeInTheDocument();
    const communitySearchLink = screen.getByRole('link', { name: 'Найти сообщество' });
    expect(communitySearchLink).toHaveAttribute('href', '/communities');
    expect(communitySearchLink.querySelector('small')).not.toBeInTheDocument();
    const levelAvatar = screen.getByRole('img', {
      name: 'Анна Петрова, уровень C+, прогресс 80%',
    });
    expect(levelAvatar).toBeVisible();
    const levelSegments = levelAvatar.querySelectorAll('[data-player-level-segment]');
    expect(levelSegments).toHaveLength(4);
    expect(levelSegments[0]).toHaveAttribute('data-segment-progress', '1');
    expect(levelSegments[1]).toHaveAttribute('data-segment-progress', '1');
    expect(levelSegments[2]).toHaveAttribute('data-segment-progress', '1');
    expect(Number(levelSegments[3]?.getAttribute('data-segment-progress'))).toBeCloseTo(0.2);
    expect(levelSegments[0]?.querySelector('path')?.getAttribute('d')).toContain('A 24 24');
    expect(levelSegments[0]?.querySelector('path')?.getAttribute('d')).toContain('A 22 22');
    expect(levelAvatar.querySelector('[data-player-level-photo]')).toHaveAttribute(
      'data-player-level-photo',
      'fallback',
    );
    expect(levelAvatar.querySelector('[data-player-level-badge]')).toHaveTextContent('C+');
    const notificationsLink = await screen.findByRole('link', {
      name: 'Уведомления, непрочитанных: 1',
    });
    expect(notificationsLink).toHaveAttribute('href', '/notifications');
    expect(notificationsLink).toHaveClass('is-unread');
    expect(notificationsLink.querySelector('.fh-bell-dot')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'VK ID или Mail.ru' })).not.toBeInTheDocument();
    expect(gateway.restoreSession).toHaveBeenCalledOnce();
    expect(gateway.getHomeBase).toHaveBeenCalledOnce();
    expect(gateway.getSelfProfile).toHaveBeenCalledOnce();
    expect(gateway.getUpcomingBookings).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('tab', { name: 'Мои записи' }));
    await vi.waitFor(() => expect(gateway.getUpcomingBookings).toHaveBeenCalledOnce());
    expect(gateway.getHomeDashboard).not.toHaveBeenCalled();
    expect(gateway.listNotifications).toHaveBeenCalledOnce();
  });

  it('opens the real free-game form from the protected /games/new route', async () => {
    window.history.replaceState({}, '', '/games/new');
    const listLocations = vi.fn<AuthGateway['listLocations']>().mockResolvedValue({
      items: [
        {
          id: 'a8df730b-6a67-41a5-8772-48bca84f73bc',
          title: 'Селигерская',
          city: 'Москва',
          courtCount: 3,
          coverImageUrl: null,
          route: '/locations/a8df730b-6a67-41a5-8772-48bca84f73bc',
        },
      ],
    });
    const gateway = createGateway({
      restoreSession: vi.fn().mockResolvedValue(session),
      listLocations,
    });

    render(<App gateway={gateway} tenantKey="padlhub" />);

    expect(await screen.findByRole('heading', { name: 'Создать игру' })).toBeVisible();
    expect(screen.getByText('Стоимость: бесплатно')).toBeVisible();
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: 'Станция' })).toHaveValue(
        'a8df730b-6a67-41a5-8772-48bca84f73bc',
      ),
    );
    expect(listLocations).toHaveBeenCalledOnce();
  });

  it('scopes the create recovery form to the restored tenant and actor', async () => {
    window.history.replaceState({}, '', '/games/new');
    const stationId = 'a8df730b-6a67-41a5-8772-48bca84f73bc';
    await prepareCreateGameAttempt(
      { tenantId: session.context.tenant.id, userId: session.context.user.id },
      {
        title: 'Черновик только Анны',
        kind: 'FRIENDLY',
        visibility: 'PRIVATE',
        stationId,
        startsAt: '2027-08-15T15:00:00.000Z',
        endsAt: '2027-08-15T16:30:00.000Z',
        timezone: 'Europe/Moscow',
        capacity: 4,
        levelRange: null,
        paymentMode: 'NO_PAYMENT',
        waitlistEnabled: true,
      },
      window.localStorage,
      { request: (_name, _options, callback) => Promise.resolve().then(callback) },
      { createIdempotencyKey: () => 'create-logical-attempt-key-0001' },
    );
    const listLocations = vi.fn<AuthGateway['listLocations']>().mockResolvedValue({
      items: [
        {
          id: stationId,
          title: 'Селигерская',
          city: 'Москва',
          courtCount: 3,
          coverImageUrl: null,
          route: `/locations/${stationId}`,
        },
      ],
    });
    const otherSession: AuthenticatedSession = {
      context: {
        ...session.context,
        user: { ...session.context.user, id: '99999999-9999-4999-8999-999999999999' },
      },
    };
    const otherView = render(
      <App
        gateway={createGateway({
          restoreSession: vi.fn().mockResolvedValue(otherSession),
          listLocations,
        })}
        tenantKey="padlhub"
      />,
    );

    expect(await screen.findByDisplayValue('Открытая игра')).toBeVisible();
    expect(screen.queryByDisplayValue('Черновик только Анны')).not.toBeInTheDocument();
    otherView.unmount();

    render(
      <App
        gateway={createGateway({
          restoreSession: vi.fn().mockResolvedValue(session),
          listLocations,
        })}
        tenantKey="padlhub"
      />,
    );
    expect(await screen.findByDisplayValue('Черновик только Анны')).toBeVisible();
    expect(screen.getByText(/Найдена незавершённая попытка/)).toBeVisible();
  });

  it('keeps local Home Base visible when profile and upcoming reads are unavailable', async () => {
    const getSelfProfile = vi
      .fn<AuthGateway['getSelfProfile']>()
      .mockRejectedValue(new Error('PROFILE_SOURCE_UNAVAILABLE'));
    const getUpcomingBookings = vi
      .fn<AuthGateway['getUpcomingBookings']>()
      .mockRejectedValue(new Error('BOOKINGS_SOURCE_UNAVAILABLE'));
    const gateway = createGateway({
      restoreSession: vi.fn().mockResolvedValue(session),
      getSelfProfile,
      getUpcomingBookings,
    });
    const user = userEvent.setup();

    render(<App gateway={gateway} tenantKey="padlhub" />);

    expect(
      await screen.findByRole('heading', { name: session.context.user.displayName }),
    ).toBeVisible();
    expect(screen.getByRole('navigation', { name: 'Разделы клуба' })).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'Главная недоступна' })).not.toBeInTheDocument();
    expect(screen.getByText('Профиль временно недоступен')).toBeVisible();

    await user.click(screen.getByRole('tab', { name: 'Мои записи' }));
    expect(screen.getByText('Мои записи временно недоступны')).toBeVisible();
    expect(screen.queryByText('Ближайших записей нет')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Повторить загрузку профиля' }));
    await vi.waitFor(() => expect(getSelfProfile).toHaveBeenCalledTimes(2));
    await user.click(
      within(screen.getByRole('region', { name: 'Мои записи' })).getByRole('button', {
        name: 'Повторить',
      }),
    );
    await vi.waitFor(() => expect(getUpcomingBookings).toHaveBeenCalledTimes(2));
    expect(gateway.getHomeBase).toHaveBeenCalledOnce();
  });

  it('opens unified activity history over Home without navigating to the fallback route', async () => {
    const getActivityHistory = vi.fn<AuthGateway['getActivityHistory']>().mockResolvedValue({
      items: [],
      nextCursor: null,
      freshness: 'FRESH',
      coverage: 'COMPLETE',
      generatedAt: '2026-07-21T09:00:00.000Z',
    });
    const gateway = createGateway({
      restoreSession: vi.fn().mockResolvedValue(session),
      getActivityHistory,
    });

    render(<App gateway={gateway} tenantKey="padlhub" />);

    await screen.findByRole('heading', { name: 'Анна Петрова' });
    fireEvent.click(screen.getByRole('tab', { name: 'Мои записи' }));
    const historyButton = await screen.findByRole('button', { name: 'История посещений' });
    fireEvent.click(historyButton);

    expect(await screen.findByRole('dialog', { name: 'История' })).toBeVisible();
    expect(window.location.pathname).toBe('/');
    await vi.waitFor(() =>
      expect(getActivityHistory).toHaveBeenCalledWith({ status: 'COMPLETED', limit: 20 }),
    );
  });

  it('revalidates local Home Base on focus without refetching the direct profile', async () => {
    const refreshedHomeBase: HomeBase = {
      ...homeBase,
      snapshot: { ...homeBase.snapshot, version: 'home-base-v1-refreshed' },
      locations: [
        ...homeBase.locations,
        {
          id: '90c31493-c42f-4b9d-b627-8ab8928e89d2',
          title: 'Терехово',
          courtCount: 12,
          imageUrl: null,
          route: '/locations/90c31493-c42f-4b9d-b627-8ab8928e89d2',
        },
      ],
    };
    const getHomeBase = vi
      .fn<AuthGateway['getHomeBase']>()
      .mockResolvedValueOnce(homeBase)
      .mockResolvedValueOnce(refreshedHomeBase);
    const gateway = createGateway({
      restoreSession: vi.fn().mockResolvedValue(session),
      getHomeBase,
    });

    render(<App gateway={gateway} tenantKey="padlhub" />);

    expect(
      await screen.findByRole('img', {
        name: 'Анна Петрова, уровень C+, прогресс 80%',
      }),
    ).toBeVisible();
    fireEvent.click(screen.getByRole('tab', { name: 'Мои записи' }));
    expect(screen.queryByRole('link', { name: /Терехово/ })).not.toBeInTheDocument();

    window.dispatchEvent(new Event('focus'));

    expect(await screen.findByRole('link', { name: /Терехово/ })).toBeVisible();
    expect(
      screen.getByRole('img', {
        name: 'Анна Петрова, уровень C+, прогресс 80%',
      }),
    ).toBeVisible();
    expect(getHomeBase).toHaveBeenCalledTimes(2);
    expect(gateway.getSelfProfile).toHaveBeenCalledOnce();
  });

  it('renders ten Home communities immediately and continues the directory near scroll end', async () => {
    const initialCommunities: CommunityMembershipPage['items'] = [
      ...homeDashboard.communities,
      ...Array.from({ length: 8 }, (_, index) => {
        const suffix = String(index + 3).padStart(12, '0');
        const id = `20000000-0000-4000-8000-${suffix}`;
        return {
          id,
          title: `Сообщество ${index + 3}`,
          logoUrl: null,
          isVerified: false,
          unreadChatCount: 0,
          route: `/communities/${id}`,
        };
      }),
    ];
    const continuedCommunity: CommunityMembershipPage['items'][number] = {
      id: 'f8a797f8-0796-4b83-810a-0b1d2c81e251',
      title: 'После прокрутки',
      logoUrl: null,
      isVerified: false,
      unreadChatCount: 0,
      route: '/communities/f8a797f8-0796-4b83-810a-0b1d2c81e251',
    };
    const initialHomeBase: HomeBase = {
      ...homeBase,
      communities: {
        status: 'READY',
        revision: '2',
        observedAt: '2026-07-15T09:00:00.000Z',
        staleAt: '2026-07-15T09:05:00.000Z',
        value: initialCommunities,
      },
    };
    const listMyCommunities = vi
      .fn<AuthGateway['listMyCommunities']>()
      .mockResolvedValueOnce({
        items: initialCommunities,
        nextCursor: 'opaque-community-cursor',
      })
      .mockResolvedValueOnce({ items: [continuedCommunity] });
    const gateway = createGateway({
      restoreSession: vi.fn().mockResolvedValue(session),
      getHomeBase: vi.fn().mockResolvedValue(initialHomeBase),
      listMyCommunities,
    });

    render(<App gateway={gateway} tenantKey="padlhub" />);

    expect(await screen.findByRole('group', { name: /Padel Friends/ })).toBeVisible();
    expect(screen.getByRole('group', { name: 'Тест' })).toBeVisible();
    await waitFor(() => expect(listMyCommunities).toHaveBeenCalledWith(undefined, 10));

    const carousel = screen.getByRole('region', { name: 'Мои сообщества' });
    expect(carousel).toHaveAttribute('tabindex', '0');
    expect(within(carousel).getAllByRole('group')).toHaveLength(10);
    Object.defineProperties(carousel, {
      scrollWidth: { configurable: true, value: 1_100 },
      clientWidth: { configurable: true, value: 355 },
      scrollLeft: { configurable: true, value: 650, writable: true },
    });

    fireEvent.scroll(carousel);
    expect(await screen.findByRole('group', { name: 'После прокрутки' })).toBeVisible();
    expect(listMyCommunities).toHaveBeenNthCalledWith(2, 'opaque-community-cursor', 10);

    carousel.scrollLeft = 0;
    fireEvent.mouseDown(carousel, { button: 0, clientX: 300 });
    fireEvent.mouseMove(carousel, { buttons: 1, clientX: 180 });
    expect(carousel.scrollLeft).toBe(120);
    expect(carousel).toHaveClass('is-dragging');
    fireEvent.mouseUp(carousel, { button: 0, clientX: 180 });
    expect(carousel).not.toHaveClass('is-dragging');
  });

  it('hydrates communities from the directory when the Home snapshot is unavailable', async () => {
    const unavailableHomeBase: HomeBase = {
      ...homeBase,
      communities: { status: 'UNAVAILABLE' },
    };
    const listMyCommunities = vi.fn<AuthGateway['listMyCommunities']>().mockResolvedValue({
      items: communityMemberships.items,
    });
    const gateway = createGateway({
      restoreSession: vi.fn().mockResolvedValue(session),
      getHomeBase: vi.fn().mockResolvedValue(unavailableHomeBase),
      listMyCommunities,
    });

    render(<App gateway={gateway} tenantKey="padlhub" />);

    expect(
      await screen.findByRole('group', {
        name: 'Padel Friends, непрочитанных сообщений: 2',
      }),
    ).toBeVisible();
    expect(listMyCommunities).toHaveBeenCalledWith(undefined, 10);
    expect(
      screen.queryByRole('alert', { name: 'Сообщества временно недоступны.' }),
    ).not.toBeInTheDocument();
  });

  it('loads the profile route with profile details and active subscriptions', async () => {
    window.history.replaceState({}, '', '/profile');
    const gateway = createGateway({ restoreSession: vi.fn().mockResolvedValue(session) });
    const user = userEvent.setup();

    render(<App gateway={gateway} tenantKey="padlhub" />);

    expect(await screen.findByRole('heading', { name: 'Анна Петрова' })).toBeVisible();
    expect(screen.getByText('540 ₽')).toBeVisible();
    expect(screen.queryByRole('group', { name: 'Рейтинг 3,8' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /редактировать профиль/ })).toBeVisible();
    expect(
      screen.queryByText('Фон профиля зависит от вашего текущего уровня'),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('img', { name: 'Анна Петрова, уровень C+, прогресс 80%' }),
    ).toBeVisible();
    expect(screen.getByRole('region', { name: 'Город и вид спорта' })).toBeVisible();
    expect(screen.getByText('Москва')).toBeVisible();
    expect(screen.getByText('Падел')).toBeVisible();
    expect(await screen.findByRole('heading', { name: 'Подписки и абонементы' })).toBeVisible();
    expect(
      screen.getByText(
        'Подписки и абонементы временно недоступны. Остальные данные профиля загружены.',
      ),
    ).toBeVisible();
    expect(screen.queryByText('Действующих подписок пока нет.')).not.toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Сообщества' })).toBeVisible();
    expect(screen.getByRole('link', { name: 'Padel Friends, вне рейтинга' })).toBeVisible();
    expect(
      screen.queryByRole('heading', { name: 'Когда и где мне удобно' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Кто может связаться' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /^Предпочтения/ }));
    expect(screen.getByRole('dialog', { name: 'Предпочтения' })).toBeVisible();
    expect(await screen.findByRole('heading', { name: 'Когда и где мне удобно' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Закрыть настройки' }));

    await user.click(screen.getByRole('button', { name: /^Видимость профиля/ }));
    expect(screen.getByRole('dialog', { name: 'Видимость профиля' })).toBeVisible();
    expect(await screen.findByRole('heading', { name: 'Кто может связаться' })).toBeVisible();
    expect(screen.getByRole('checkbox', { name: /Запрос на связь/ })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /Личный чат/ })).toBeChecked();
    expect(gateway.getPlayerProfile).toHaveBeenCalledWith(session.context.user.id);
    expect(gateway.getProfilePrivacy).toHaveBeenCalledOnce();
    expect(gateway.listMyCommunities).toHaveBeenCalledOnce();
    expect(gateway.getHomeDashboard).not.toHaveBeenCalled();
    expect(gateway.getHomeBase).not.toHaveBeenCalled();
  });

  it('opens profile level history as a separate protected page', async () => {
    window.history.replaceState({}, '', '/profile/level-history');
    const getProfileLevelHistory = vi.fn().mockResolvedValue({
      userId: session.context.user.id,
      items: [
        {
          changedAt: '2026-05-10T09:00:00.000Z',
          levelLabel: 'D+',
          levelValue: 2.75,
        },
        {
          changedAt: '2026-07-20T12:00:00.000Z',
          levelLabel: 'C',
          levelValue: 3.1,
        },
      ],
    });
    const gateway = createGateway({
      restoreSession: vi.fn().mockResolvedValue(session),
      getProfileLevelHistory,
    });

    render(<App gateway={gateway} tenantKey="padlhub" />);

    expect(await screen.findByRole('heading', { name: 'История уровня' })).toBeVisible();
    expect(
      await screen.findByRole('img', {
        name: 'График изменения уровня: дата по горизонтали, уровень по вертикали',
      }),
    ).toBeVisible();
    expect(getProfileLevelHistory).toHaveBeenCalledOnce();
    expect(gateway.getPlayerProfile).not.toHaveBeenCalled();
  });

  it('saves an optimistic owner privacy command from the profile', async () => {
    window.history.replaceState({}, '', '/profile');
    const updatedPrivacy = {
      ...profilePrivacy,
      chatPolicy: 'NOBODY' as const,
      version: 2,
      updatedAt: '2026-07-17T12:01:00.000Z',
    };
    const updateProfilePrivacy = vi.fn().mockResolvedValue(updatedPrivacy);
    const gateway = createGateway({
      restoreSession: vi.fn().mockResolvedValue(session),
      updateProfilePrivacy,
    });
    const user = userEvent.setup();

    render(<App gateway={gateway} tenantKey="padlhub" />);

    await user.click(await screen.findByRole('button', { name: /^Видимость профиля/ }));
    const chatToggle = await screen.findByRole('checkbox', { name: /Личный чат/ });
    await user.click(chatToggle);
    await user.click(
      within(screen.getByRole('region', { name: 'Кто может связаться' })).getByRole('button', {
        name: 'Сохранить',
      }),
    );

    await waitFor(() =>
      expect(updateProfilePrivacy).toHaveBeenCalledWith({
        expectedVersion: 1,
        contactPolicy: 'AUTHORIZED',
        chatPolicy: 'NOBODY',
      }),
    );
    expect(await screen.findByText('Настройки сохранены')).toBeVisible();
  });

  it('saves the Home V3 presentation, baseline time, and friend recommendation preference', async () => {
    window.history.replaceState({}, '', '/profile');
    const updateBookingPreferences = vi.fn().mockResolvedValue({
      ...bookingPreferences,
      recommendFriends: false,
      recommendationDisplay: 'ROWS' as const,
      version: 1,
      updatedAt: '2026-07-30T12:00:00.000Z',
    });
    const gateway = createGateway({
      restoreSession: vi.fn().mockResolvedValue(session),
      updateBookingPreferences,
    });
    const user = userEvent.setup();

    render(<App gateway={gateway} tenantKey="padlhub" />);

    await user.click(await screen.findByRole('button', { name: /^Предпочтения/ }));
    expect(screen.getByRole('radio', { name: /Карточками/ })).toBeChecked();
    expect(screen.getByRole('radio', { name: /Строками/ })).not.toBeChecked();
    expect(screen.getByRole('combobox', { name: 'День для интервала 1' })).toHaveValue('ANY');
    expect(screen.getByLabelText('Начало интервала 1')).toHaveValue('09:00');
    expect(screen.getByLabelText('Конец интервала 1')).toHaveValue('22:00');
    expect(
      screen.getByRole('checkbox', { name: /Рекомендовать события с друзьями/ }),
    ).toBeChecked();

    await user.click(screen.getByRole('radio', { name: /Строками/ }));
    await user.click(screen.getByRole('checkbox', { name: /Рекомендовать события с друзьями/ }));
    await user.click(screen.getByRole('button', { name: 'Сохранить' }));

    await waitFor(() =>
      expect(updateBookingPreferences).toHaveBeenCalledWith({
        expectedVersion: 0,
        favoriteStationIds: [],
        preferredTimeWindows: [{ weekday: 'ANY', startsAt: '09:00', endsAt: '22:00' }],
        useHistory: true,
        recommendFriends: false,
        recommendationDisplay: 'ROWS',
      }),
    );
  });

  it('loads another player through the viewer-filtered profile route', async () => {
    const targetUserId = '6a81e965-c508-4321-812c-4be323606a70';
    window.history.replaceState({}, '', `/profile/${targetUserId}`);
    const otherProfile: PlayerProfileView = {
      profile: {
        userId: targetUserId,
        displayName: 'Мария Соколова',
        avatarUrl: null,
        level: { label: 'C', assessmentRequired: false },
      },
      access: {
        audience: 'OTHER',
        tier: 'BASIC',
        visibleSections: ['BASIC', 'PLAYER_LEVEL'],
        contact: { status: 'LOCKED', reason: 'ACCESS_REQUIRED' },
        chat: { status: 'LOCKED', reason: 'ACCESS_REQUIRED' },
      },
    };
    const gateway = createGateway({
      restoreSession: vi.fn().mockResolvedValue(session),
      getPlayerProfile: vi.fn().mockResolvedValue(otherProfile),
    });

    render(<App gateway={gateway} tenantKey="padlhub" />);

    expect(await screen.findByRole('heading', { name: 'Мария Соколова' })).toBeVisible();
    expect(screen.getByText('Базовый')).toBeVisible();
    expect(screen.getAllByText('Для этого действия пока нет доступа.')).toHaveLength(2);
    expect(screen.queryByText('540 ₽')).not.toBeInTheDocument();
    expect(screen.queryByText('•••• 0001')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Выйти из аккаунта' })).not.toBeInTheDocument();
    expect(gateway.getPlayerProfile).toHaveBeenCalledWith(targetUserId);
    expect(gateway.getProfilePrivacy).not.toHaveBeenCalled();
    expect(gateway.getHomeBase).not.toHaveBeenCalled();
    expect(gateway.getProfileFriendship).toHaveBeenCalledWith(targetUserId);
  });

  it('adds another player to friends from the viewer-filtered profile', async () => {
    const targetUserId = '6a81e965-c508-4321-812c-4be323606a70';
    window.history.replaceState({}, '', `/profile/${targetUserId}`);
    const gateway = createGateway({
      restoreSession: vi.fn().mockResolvedValue(session),
      getPlayerProfile: vi.fn().mockResolvedValue({
        profile: {
          userId: targetUserId,
          displayName: 'Мария Соколова',
          avatarUrl: null,
          level: { label: 'C', assessmentRequired: false },
        },
        access: {
          audience: 'OTHER',
          tier: 'BASIC',
          visibleSections: ['BASIC', 'PLAYER_LEVEL'],
          contact: { status: 'LOCKED', reason: 'ACCESS_REQUIRED' },
          chat: { status: 'LOCKED', reason: 'ACCESS_REQUIRED' },
        },
      }),
    });

    render(<App gateway={gateway} tenantKey="padlhub" />);

    const addButton = await screen.findByRole('button', { name: 'Добавить' });
    await userEvent.click(addButton);

    await waitFor(() => expect(gateway.addProfileFriend).toHaveBeenCalledWith(targetUserId));
    expect(await screen.findByRole('button', { name: 'Добавлен' })).toBeDisabled();
    expect(screen.getByText('Уже в друзьях')).toBeVisible();
  });

  it('loads the bookings route as a separate PadlHub aggregate without requesting Home', async () => {
    window.history.replaceState({}, '', '/bookings');
    const gateway = createGateway({ restoreSession: vi.fn().mockResolvedValue(session) });

    render(<App gateway={gateway} tenantKey="padlhub" />);

    expect(await screen.findByRole('heading', { name: 'Записи' })).toBeVisible();
    expect(screen.getByText('Американо · уровень C')).toBeVisible();
    expect(screen.getByText('Подтверждено')).toBeVisible();
    expect(gateway.getUpcomingBookings).toHaveBeenCalledOnce();
    expect(gateway.getHomeBase).not.toHaveBeenCalled();
    expect(gateway.getPlayerProfile).not.toHaveBeenCalled();
  });

  it('opens a game booking deep-link as a game card instead of the discovery catalog', async () => {
    const eventId = '8a830ad0-a8c7-479b-a239-5b434c42148f';
    window.history.replaceState({}, '', `/games?event=${eventId}`);
    const gateway = createGateway({
      restoreSession: vi.fn().mockResolvedValue(session),
      getUpcomingBookings: vi.fn().mockResolvedValue({
        ...upcomingBookings,
        items: [
          {
            ...upcomingBookings.items[0]!,
            title: 'Открытая игра',
            route: `/games?event=${eventId}`,
          },
        ],
      }),
    });

    render(<App gateway={gateway} tenantKey="padlhub" />);

    expect(await screen.findByRole('heading', { name: 'Карточка игры' })).toBeVisible();
    expect(await screen.findByRole('article', { name: 'Открытая игра' })).toBeVisible();
    expect(gateway.listEventCatalog).not.toHaveBeenCalled();
  });

  it('loads and continues the communities directory without requesting Home', async () => {
    window.history.replaceState({}, '', '/communities');
    const listMyCommunities = vi
      .fn<AuthGateway['listMyCommunities']>()
      .mockResolvedValueOnce({
        items: homeDashboard.communities,
        nextCursor: 'opaque-community-cursor',
      })
      .mockResolvedValueOnce({
        items: [
          {
            id: 'c522103f-05aa-4ef1-a3a4-645d9a78b397',
            title: 'Команда Север',
            logoUrl: null,
            isVerified: false,
            unreadChatCount: 0,
            route: '/communities/c522103f-05aa-4ef1-a3a4-645d9a78b397',
          },
        ],
      });
    const gateway = createGateway({
      restoreSession: vi.fn().mockResolvedValue({
        ...session,
        context: {
          ...session.context,
          runtimeCapabilities: {
            communityDirectory: true,
            communityReadDetail: true,
            communityReadFeed: false,
            communityReadChat: false,
            communityReadRating: false,
            communityCanonical: false,
            communityDirectInvites: false,
            communityRealtime: false,
          },
        },
      }),
      listMyCommunities,
    });
    const user = userEvent.setup();

    render(<App gateway={gateway} tenantKey="padlhub" />);

    expect(await screen.findByRole('heading', { name: 'Мои сообщества' })).toBeVisible();
    expect(await screen.findByText('Padel Friends')).toBeVisible();
    expect(screen.getByRole('link', { name: /Padel Friends/ })).toHaveAttribute(
      'href',
      '/communities/42c05c91-da23-4dc5-bf97-3d136a2d12bd',
    );
    await user.click(screen.getByRole('button', { name: 'Показать ещё' }));
    expect(await screen.findByText('Команда Север')).toBeVisible();
    expect(listMyCommunities).toHaveBeenNthCalledWith(1);
    expect(listMyCommunities).toHaveBeenNthCalledWith(2, 'opaque-community-cursor');
    expect(gateway.getHomeBase).not.toHaveBeenCalled();
  });

  it('opens the default-denied legacy read-only community route when detail is enabled', async () => {
    const communityId = '11111111-1111-4111-8111-111111111111';
    window.history.replaceState({}, '', `/communities/${communityId}`);
    const getCommunityReadExperienceDetail = vi
      .fn<AuthGateway['getCommunityReadExperienceDetail']>()
      .mockResolvedValue({
        id: communityId,
        title: 'Padel Friends',
        logoUrl: null,
        isVerified: true,
        description: 'Сообщество для просмотра',
        memberCount: 42,
        readOnly: true,
      });
    const gateway = createGateway({
      restoreSession: vi.fn().mockResolvedValue({
        ...session,
        context: {
          ...session.context,
          runtimeCapabilities: {
            communityDirectory: true,
            communityReadDetail: true,
            communityReadFeed: false,
            communityReadChat: false,
            communityReadRating: false,
            communityCanonical: false,
            communityDirectInvites: false,
            communityRealtime: false,
          },
        },
      }),
      getCommunityReadExperienceDetail,
    });

    render(<App gateway={gateway} tenantKey="padlhub" />);

    expect(await screen.findByRole('heading', { name: 'Padel Friends' })).toBeVisible();
    expect(screen.getByText('42 участника')).toBeVisible();
    expect(screen.getByLabelText('Сообщество доступно только для просмотра')).toBeVisible();
    expect(getCommunityReadExperienceDetail).toHaveBeenCalledWith(communityId);
  });

  it('searches the canonical catalog and keeps LISTED_PRIVATE metadata minimal', async () => {
    window.history.replaceState({}, '', '/communities');
    const discoverCommunities = vi.fn<AuthGateway['discoverCommunities']>().mockResolvedValue({
      items: [
        {
          id: '11111111-1111-4111-8111-111111111111',
          title: 'Private Padel',
          logoUrl: null,
          isVerified: true,
          visibility: 'LISTED_PRIVATE',
          joinAction: 'REQUEST_TO_JOIN',
        },
      ],
    });
    const gateway = createGateway({
      restoreSession: vi.fn().mockResolvedValue({
        ...session,
        context: {
          ...session.context,
          runtimeCapabilities: {
            communityDirectory: true,
            communityReadDetail: false,
            communityReadFeed: false,
            communityReadChat: false,
            communityReadRating: false,
            communityCanonical: true,
            communityDirectInvites: false,
            communityRealtime: false,
          },
        },
      }),
      discoverCommunities,
    });
    const user = userEvent.setup();

    render(<App gateway={gateway} tenantKey="padlhub" />);
    await user.type(await screen.findByRole('textbox', { name: 'Название сообщества' }), 'Private');
    await user.click(screen.getByRole('button', { name: 'Найти' }));

    const result = await screen.findByRole('link', { name: /Private Padel/ });
    expect(result).toHaveAttribute('href', '/communities/11111111-1111-4111-8111-111111111111');
    expect(within(result).getByText('Закрытое сообщество')).toBeVisible();
    expect(result).not.toHaveTextContent('участников');
    expect(discoverCommunities).toHaveBeenCalledWith('Private');
  });

  it('opens the canonical viewer-filtered community detail route', async () => {
    const communityId = '11111111-1111-4111-8111-111111111111';
    window.history.replaceState({}, '', `/communities/${communityId}`);
    const getCommunityDetail = vi.fn<AuthGateway['getCommunityDetail']>().mockResolvedValue({
      id: communityId,
      title: 'Padel Friends',
      logoUrl: null,
      isVerified: true,
      visibility: 'PUBLIC',
      joinAction: 'REQUEST_TO_JOIN',
      description: 'Открытое падел-сообщество',
      memberCount: 42,
      joinPolicy: 'MODERATED',
      createdAt: '2026-08-03T10:00:00.000Z',
    });
    const getMyCommunityMembershipState = vi
      .fn<AuthGateway['getMyCommunityMembershipState']>()
      .mockResolvedValue({
        communityId,
        membershipStatus: 'NONE',
        role: null,
        membershipRevision: 0,
        joinRequest: null,
        joinAction: 'REQUEST_TO_JOIN',
        updatedAt: null,
      });
    const gateway = createGateway({
      restoreSession: vi.fn().mockResolvedValue({
        ...session,
        context: {
          ...session.context,
          runtimeCapabilities: {
            communityDirectory: true,
            communityReadDetail: false,
            communityReadFeed: false,
            communityReadChat: false,
            communityReadRating: false,
            communityCanonical: true,
            communityDirectInvites: false,
            communityRealtime: false,
          },
        },
      }),
      getCommunityDetail,
      getMyCommunityMembershipState,
    });

    render(<App gateway={gateway} tenantKey="padlhub" />);

    expect(await screen.findByRole('heading', { name: 'Padel Friends' })).toBeVisible();
    expect(screen.getByText('Открытое падел-сообщество')).toBeVisible();
    expect(screen.getByText('42')).toBeVisible();
    expect(getCommunityDetail).toHaveBeenCalledWith(communityId);
    expect(getMyCommunityMembershipState).toHaveBeenCalledWith(communityId);
    expect(await screen.findByRole('button', { name: 'Подать заявку' })).toBeEnabled();
  });

  it('loads the notification inbox and exposes the tenant Web Push state', async () => {
    window.history.replaceState({}, '', '/notifications');
    const gateway = createGateway({ restoreSession: vi.fn().mockResolvedValue(session) });

    render(<App gateway={gateway} tenantKey="padlhub" />);

    expect(await screen.findByRole('heading', { name: 'Оповещения' })).toBeVisible();
    expect(screen.getByText('Игра уже скоро')).toBeVisible();
    expect(screen.getByText('Push пока не включён для этой организации.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Включить' })).toBeDisabled();
    expect(gateway.listNotifications).toHaveBeenCalledOnce();
    expect(gateway.getWebPushConfiguration).toHaveBeenCalledOnce();
    expect(gateway.getHomeBase).not.toHaveBeenCalled();
  });

  it('refreshes the notification inbox when the browser regains focus', async () => {
    window.history.replaceState({}, '', '/notifications');
    const updatedInbox: NotificationInboxPage = {
      unreadCount: 2,
      items: [
        {
          id: '12859d51-a808-4cd5-b1e8-ad18887b15a3',
          category: 'ADMIN_MESSAGE',
          title: 'Новое сообщение',
          body: 'Появилось без перезагрузки страницы.',
          deepLink: '/notifications',
          createdAt: '2026-07-16T16:30:00.000Z',
        },
        ...notificationInbox.items,
      ],
    };
    const listNotifications = vi
      .fn()
      .mockResolvedValueOnce(notificationInbox)
      .mockResolvedValue(updatedInbox);
    const gateway = createGateway({
      restoreSession: vi.fn().mockResolvedValue(session),
      listNotifications,
    });

    render(<App gateway={gateway} tenantKey="padlhub" />);

    expect(await screen.findByText('Игра уже скоро')).toBeVisible();
    window.dispatchEvent(new Event('focus'));

    expect(await screen.findByText('Новое сообщение')).toBeVisible();
    expect(listNotifications).toHaveBeenCalledTimes(2);
  });

  it('keeps Web Push controls visible when the inbox read is unavailable', async () => {
    window.history.replaceState({}, '', '/notifications');
    const gateway = createGateway({
      restoreSession: vi.fn().mockResolvedValue(session),
      listNotifications: vi.fn().mockRejectedValue(new Error('inbox unavailable')),
      getWebPushConfiguration: vi.fn().mockResolvedValue({
        enabled: true,
        publicKey: 'public-vapid-key-value',
      }),
    });

    render(<App gateway={gateway} tenantKey="padlhub" />);

    expect(await screen.findByRole('heading', { name: 'Оповещения' })).toBeVisible();
    expect(screen.getByText('Лента оповещений временно недоступна.')).toBeVisible();
    expect(
      screen.queryByRole('heading', { name: 'Оповещения недоступны' }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Оповещения на устройстве' })).toBeVisible();
  });

  it('fails closed for an unknown section route instead of showing a placeholder', async () => {
    window.history.replaceState({}, '', '/unpublished-section');
    const gateway = createGateway({ restoreSession: vi.fn().mockResolvedValue(session) });

    render(<App gateway={gateway} tenantKey="padlhub" />);

    expect(await screen.findByRole('heading', { name: 'Страница не найдена' })).toBeVisible();
    expect(screen.queryByText('Раздел подключается к API ПаделХАБ.')).not.toBeInTheDocument();
    expect(gateway.getHomeBase).not.toHaveBeenCalled();
    expect(gateway.getUpcomingBookings).not.toHaveBeenCalled();
    expect(gateway.getPlayerProfile).not.toHaveBeenCalled();
  });

  it('loads the trainings route as a real PadlHub page without requesting Home', async () => {
    window.history.replaceState({}, '', '/trainings');
    const gateway = createGateway({ restoreSession: vi.fn().mockResolvedValue(session) });

    render(<App gateway={gateway} tenantKey="padlhub" />);

    expect(await screen.findByRole('heading', { name: 'Тренировки' })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Групповые тренировки' })).toBeVisible();
    expect(screen.getByRole('link', { name: 'Индивидуальные тренировки' })).toHaveAttribute(
      'href',
      '/coaches',
    );
    expect(screen.queryByText('Раздел подключается к API ПаделХАБ.')).not.toBeInTheDocument();
    await waitFor(() => expect(gateway.listEventCatalog).toHaveBeenCalledTimes(1));
    expect(gateway.getHomeBase).not.toHaveBeenCalled();
  });

  it('keeps the second Home variant available on its own route', async () => {
    window.history.replaceState({}, '', '/home-v2');
    const gateway = createGateway({ restoreSession: vi.fn().mockResolvedValue(session) });
    const { container } = render(<App gateway={gateway} tenantKey="padlhub" />);

    expect(await screen.findByRole('heading', { name: 'Анна Петрова' })).toBeVisible();
    expect(container.querySelector('.fh-hero--v2')).toBeInTheDocument();
    expect(gateway.getHomeBase).toHaveBeenCalledOnce();
  });

  it('opens Home V3 on the primary Home route', async () => {
    window.history.replaceState({}, '', '/');
    const gateway = createGateway({ restoreSession: vi.fn().mockResolvedValue(session) });
    const { container } = render(<App gateway={gateway} tenantKey="padlhub" />);

    expect(await screen.findByRole('heading', { name: 'Анна Петрова' })).toBeVisible();
    expect(container.querySelector('.figma-home-shell')).toHaveClass('is-home-v3');
    expect(container.querySelector('.fh-hero--v3')).toHaveClass('fh-hero--v2');
    expect(gateway.getHomeBase).toHaveBeenCalledOnce();
  });

  it('keeps the former standard Home available on the /home-v3 route', async () => {
    window.history.replaceState({}, '', '/home-v3');
    const gateway = createGateway({ restoreSession: vi.fn().mockResolvedValue(session) });
    const { container } = render(<App gateway={gateway} tenantKey="padlhub" />);

    expect(await screen.findByRole('heading', { name: 'Анна Петрова' })).toBeVisible();
    expect(container.querySelector('.figma-home-shell')).not.toHaveClass(
      'is-home-v3',
      'is-home-v3-rows',
    );
    expect(container.querySelector('.fh-hero--v3')).not.toBeInTheDocument();
    expect(gateway.listBookingRecommendations).toHaveBeenCalledWith({ limit: 6 });
  });

  it('applies the saved row presentation to Home V3 without changing its data request', async () => {
    window.history.replaceState({}, '', '/');
    const gateway = createGateway({
      restoreSession: vi.fn().mockResolvedValue(session),
      getBookingPreferences: vi.fn().mockResolvedValue({
        ...bookingPreferences,
        recommendationDisplay: 'ROWS',
      }),
    });
    const { container } = render(<App gateway={gateway} tenantKey="padlhub" />);

    await screen.findByRole('heading', { name: 'Анна Петрова' });
    await waitFor(() =>
      expect(container.querySelector('.figma-home-shell')).toHaveClass('is-home-v3-rows'),
    );
    expect(gateway.listBookingRecommendations).toHaveBeenCalledWith({ limit: 14 });
  });

  it('waits for saved preferences before opening Home V3', async () => {
    window.history.replaceState({}, '', '/');
    let resolvePreferences: ((settings: BookingPreferences) => void) | undefined;
    const preferencesPromise = new Promise<BookingPreferences>((resolve) => {
      resolvePreferences = resolve;
    });
    const gateway = createGateway({
      restoreSession: vi.fn().mockResolvedValue(session),
      getBookingPreferences: vi.fn().mockReturnValue(preferencesPromise),
    });
    const { container } = render(<App gateway={gateway} tenantKey="padlhub" />);

    await waitFor(() => expect(gateway.getHomeBase).toHaveBeenCalledOnce());
    expect(screen.queryByRole('heading', { name: 'Анна Петрова' })).not.toBeInTheDocument();

    await act(async () => {
      resolvePreferences?.({ ...bookingPreferences, recommendationDisplay: 'ROWS' });
      await preferencesPromise;
    });

    expect(await screen.findByRole('heading', { name: 'Анна Петрова' })).toBeVisible();
    expect(container.querySelector('.figma-home-shell')).toHaveClass('is-home-v3-rows');
  });

  it('shows an honest work-in-progress shell for a restored staged section', async () => {
    window.history.replaceState({}, '', '/promotions');
    const gateway = createGateway({ restoreSession: vi.fn().mockResolvedValue(session) });

    render(<App gateway={gateway} tenantKey="padlhub" />);

    expect(await screen.findByRole('heading', { name: 'Акции' })).toBeVisible();
    expect(screen.getByText('Раздел подключается к API ПаделХАБ.')).toBeVisible();
    expect(gateway.getHomeBase).not.toHaveBeenCalled();
  });

  it('shows a not-found screen for an unknown protected route without requesting Home', async () => {
    window.history.replaceState({}, '', '/unknown');
    const gateway = createGateway({ restoreSession: vi.fn().mockResolvedValue(session) });

    render(<App gateway={gateway} tenantKey="padlhub" />);

    expect(await screen.findByRole('heading', { name: 'Страница не найдена' })).toBeVisible();
    expect(gateway.getHomeBase).not.toHaveBeenCalled();
    expect(gateway.getUpcomingBookings).not.toHaveBeenCalled();
    expect(gateway.getPlayerProfile).not.toHaveBeenCalled();
  });

  it('logs in with a normalized phone and a four-digit code', async () => {
    const gateway = createGateway();
    const user = userEvent.setup();

    render(<App gateway={gateway} tenantKey="padlhub" />);

    await openPhoneLogin(user);
    const phone = await screen.findByRole('textbox', { name: 'Номер телефона' });
    await user.clear(phone);
    await user.type(phone, '+7 999 000-00-01');
    await user.click(screen.getByRole('button', { name: 'Получить код' }));

    expect(gateway.requestCode).toHaveBeenCalledWith('+79990000001');
    const code = await screen.findByRole('textbox', { name: 'Код из СМС' });
    expect(code).toHaveFocus();
    await user.type(code, '0000');
    await user.click(screen.getByRole('button', { name: 'Войти' }));

    expect(gateway.verifyCode).toHaveBeenCalledWith({
      challengeId: 'challenge-1',
      code: '0000',
      acceptance: {
        publicOfferAccepted: true,
        personalDataPolicyAccepted: true,
      },
    });
    expect(await screen.findByRole('heading', { name: 'Анна Петрова' })).toBeVisible();
  });

  it('clears protected UI after logout', async () => {
    const gateway = createGateway({ restoreSession: vi.fn().mockResolvedValue(session) });
    const user = userEvent.setup();

    render(<App gateway={gateway} tenantKey="padlhub" />);

    await screen.findByRole('heading', { name: 'Анна Петрова' });
    await user.click(screen.getByRole('button', { name: 'Выйти' }));

    expect(gateway.logout).toHaveBeenCalledOnce();
    expect(await screen.findByRole('heading', { name: 'Войти в личный кабинет' })).toBeVisible();
    expect(screen.queryByText('Анна Петрова')).not.toBeInTheDocument();
  });

  it('keeps protected UI when server logout fails', async () => {
    const gateway = createGateway({
      restoreSession: vi.fn().mockResolvedValue(session),
      logout: vi.fn().mockRejectedValue(new Error('network unavailable')),
    });
    const user = userEvent.setup();

    render(<App gateway={gateway} tenantKey="padlhub" />);
    await screen.findByRole('heading', { name: 'Анна Петрова' });
    await user.click(screen.getByRole('button', { name: 'Выйти' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('сессия осталась активной');
    expect(screen.getByRole('heading', { name: 'Анна Петрова' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Выйти' })).toBeEnabled();
  });

  it('keeps the OTP screen accessible and explains a rejected code', async () => {
    const gateway = createGateway({
      verifyCode: vi.fn().mockRejectedValue({ code: 'AUTH_CODE_INVALID' }),
    });
    const user = userEvent.setup();

    render(<App gateway={gateway} tenantKey="padlhub" />);

    await openPhoneLogin(user);
    const phone = await screen.findByRole('textbox', { name: 'Номер телефона' });
    await user.clear(phone);
    await user.type(phone, '+79990000001');
    await user.click(screen.getByRole('button', { name: 'Получить код' }));
    const code = await screen.findByRole('textbox', { name: 'Код из СМС' });
    await user.type(code, '1111');
    await user.click(screen.getByRole('button', { name: 'Войти' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Код не подошёл');
    expect(screen.getByRole('heading', { name: 'Введите код' })).toBeVisible();
    expect(code).toHaveValue('');
    expect(code).toHaveAttribute('aria-invalid', 'true');
  });

  it('exposes an explicit direct-chat deep link only when another profile capability is available', async () => {
    const recipientUserId = '11111111-1111-4111-8111-111111111111';
    window.history.replaceState({}, '', `/profile/${recipientUserId}`);
    const otherProfile: PlayerProfileView = {
      profile: {
        userId: recipientUserId,
        displayName: 'Борис',
        firstName: 'Борис',
        avatarUrl: null,
        level: { label: 'C', value: 3.1, assessmentRequired: false },
      },
      access: {
        audience: 'OTHER',
        tier: 'INTERACTION',
        visibleSections: ['BASIC', 'PLAYER_LEVEL'],
        contact: { status: 'LOCKED', reason: 'ACCESS_REQUIRED' },
        chat: {
          status: 'AVAILABLE',
          route: `/chats/new?recipientUserId=${recipientUserId}`,
        },
      },
    };
    const gateway = createGateway({
      restoreSession: vi.fn().mockResolvedValue(session),
      getPlayerProfile: vi.fn().mockResolvedValue(otherProfile),
    });

    render(<App gateway={gateway} tenantKey="padlhub" />);

    expect(await screen.findByRole('link', { name: /Открыть чат/ })).toHaveAttribute(
      'href',
      `/chats/new?recipientUserId=${recipientUserId}`,
    );
  });

  it('creates or reuses a direct conversation from the profile deep link and opens its thread', async () => {
    const recipientUserId = '11111111-1111-4111-8111-111111111111';
    const conversationId = '22222222-2222-4222-8222-222222222222';
    window.history.replaceState({}, '', `/chats/new?recipientUserId=${recipientUserId}`);
    const createDirectConversation = vi
      .fn<AuthGateway['createDirectConversation']>()
      .mockResolvedValue({
        outcome: 'ok',
        conversation: {
          id: conversationId,
          kind: 'DIRECT',
          participant: { userId: recipientUserId, displayName: 'Борис' },
          unreadCount: 0,
          updatedAt: '2026-08-03T10:00:00.000Z',
        },
        created: false,
        replayed: false,
      });
    const listConversationMessages = vi
      .fn<AuthGateway['listConversationMessages']>()
      .mockResolvedValue({ messages: [] });
    const gateway = createGateway({
      restoreSession: vi.fn().mockResolvedValue(session),
      createDirectConversation,
      listConversationMessages,
    });
    const user = userEvent.setup();

    render(<App gateway={gateway} tenantKey="padlhub" />);
    expect(await screen.findByRole('button', { name: 'Начать диалог' })).toBeVisible();
    expect(screen.queryByText(recipientUserId)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Начать диалог' }));

    await waitFor(() => expect(window.location.pathname).toBe(`/chats/${conversationId}`));
    expect(createDirectConversation).toHaveBeenCalledWith(recipientUserId, expect.any(String));
    await waitFor(() => expect(listConversationMessages).toHaveBeenCalledWith(conversationId, 0));
  });

  it('does not request a realtime ticket or socket for a selected GAME conversation', async () => {
    const gameConversation = {
      id: '22222222-2222-4222-8222-222222222222',
      kind: 'GAME' as const,
      contextId: '11111111-1111-4111-8111-111111111111',
      title: 'Игра',
      unreadCount: 0,
      updatedAt: '2026-08-03T10:00:00.000Z',
    };
    window.history.replaceState({}, '', `/chats/${gameConversation.id}`);
    const createRealtimeTicket = vi.fn();
    const gateway = createGateway({
      restoreSession: vi.fn().mockResolvedValue(session),
      listConversations: vi.fn().mockResolvedValue({ items: [gameConversation] }),
      listConversationMessages: vi.fn().mockResolvedValue({ messages: [] }),
      createRealtimeTicket,
    });

    render(<App gateway={gateway} tenantKey="padlhub" realtimeBaseUrl="wss://realtime.example" />);

    await waitFor(() =>
      expect(gateway.listConversationMessages).toHaveBeenCalledWith(gameConversation.id, 0),
    );
    expect(realtimeMocks.connect).not.toHaveBeenCalled();
    expect(createRealtimeTicket).not.toHaveBeenCalled();
  });

  it('keeps GAME polling HTTP-only across timer refreshes', async () => {
    vi.useFakeTimers();
    const gameConversation = {
      id: '22222222-2222-4222-8222-222222222222',
      kind: 'GAME' as const,
      contextId: '11111111-1111-4111-8111-111111111111',
      title: 'Игра',
      unreadCount: 0,
      updatedAt: '2026-08-03T10:00:00.000Z',
    };
    window.history.replaceState({}, '', `/chats/${gameConversation.id}`);
    const createRealtimeTicket = vi.fn();
    const listConversationMessages = vi.fn().mockResolvedValue({ messages: [] });
    const gateway = createGateway({
      restoreSession: vi.fn().mockResolvedValue(session),
      listConversations: vi.fn().mockResolvedValue({ items: [gameConversation] }),
      listConversationMessages,
      createRealtimeTicket,
    });

    render(<App gateway={gateway} tenantKey="padlhub" realtimeBaseUrl="wss://realtime.example" />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(listConversationMessages).toHaveBeenCalledOnce();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });

    expect(listConversationMessages.mock.calls.length).toBeGreaterThan(1);
    expect(realtimeMocks.connect).not.toHaveBeenCalled();
    expect(createRealtimeTicket).not.toHaveBeenCalled();
  });

  it('waits for the initial DIRECT history before opening realtime', async () => {
    const directConversation = {
      id: '22222222-2222-4222-8222-222222222222',
      kind: 'DIRECT' as const,
      participant: { userId: '11111111-1111-4111-8111-111111111111', displayName: 'Борис' },
      unreadCount: 0,
      updatedAt: '2026-08-03T10:00:00.000Z',
    };
    let resolveHistory: ((page: { readonly messages: readonly [] }) => void) | undefined;
    const history = new Promise<{ readonly messages: readonly [] }>((resolve) => {
      resolveHistory = resolve;
    });
    window.history.replaceState({}, '', `/chats/${directConversation.id}`);
    const gateway = createGateway({
      restoreSession: vi.fn().mockResolvedValue(session),
      listConversations: vi.fn().mockResolvedValue({ items: [directConversation] }),
      listConversationMessages: vi.fn().mockReturnValue(history),
    });

    render(<App gateway={gateway} tenantKey="padlhub" realtimeBaseUrl="wss://realtime.example" />);

    await waitFor(() =>
      expect(gateway.listConversationMessages).toHaveBeenCalledWith(directConversation.id, 0),
    );
    expect(realtimeMocks.connect).not.toHaveBeenCalled();
    act(() => resolveHistory?.({ messages: [] }));
    await waitFor(() =>
      expect(realtimeMocks.connect).toHaveBeenCalledWith(
        expect.objectContaining({ conversationId: directConversation.id }),
      ),
    );
  });

  it('keeps realtime closed when the initial DIRECT history fails', async () => {
    const directConversation = {
      id: '22222222-2222-4222-8222-222222222222',
      kind: 'DIRECT' as const,
      participant: { userId: '11111111-1111-4111-8111-111111111111', displayName: 'Борис' },
      unreadCount: 0,
      updatedAt: '2026-08-03T10:00:00.000Z',
    };
    window.history.replaceState({}, '', `/chats/${directConversation.id}`);
    const gateway = createGateway({
      restoreSession: vi.fn().mockResolvedValue(session),
      listConversations: vi.fn().mockResolvedValue({ items: [directConversation] }),
      listConversationMessages: vi.fn().mockRejectedValue(new Error('history unavailable')),
    });

    render(<App gateway={gateway} tenantKey="padlhub" realtimeBaseUrl="wss://realtime.example" />);

    expect(await screen.findByText('Проверьте соединение и повторите запрос.')).toBeVisible();
    expect(realtimeMocks.connect).not.toHaveBeenCalled();
  });

  it('opens realtime only after the selected DIRECT conversation is loaded', async () => {
    const directConversation = {
      id: '22222222-2222-4222-8222-222222222222',
      kind: 'DIRECT' as const,
      participant: { userId: '11111111-1111-4111-8111-111111111111', displayName: 'Борис' },
      unreadCount: 0,
      updatedAt: '2026-08-03T10:00:00.000Z',
    };
    window.history.replaceState({}, '', `/chats/${directConversation.id}`);
    const gateway = createGateway({
      restoreSession: vi.fn().mockResolvedValue(session),
      listConversations: vi.fn().mockResolvedValue({ items: [directConversation] }),
      listConversationMessages: vi.fn().mockResolvedValue({ messages: [] }),
    });

    render(<App gateway={gateway} tenantKey="padlhub" realtimeBaseUrl="wss://realtime.example" />);

    await waitFor(() =>
      expect(realtimeMocks.connect).toHaveBeenCalledWith(
        expect.objectContaining({ conversationId: directConversation.id }),
      ),
    );
  });

  it('keeps an opened DIRECT realtime connection through a later history polling failure', async () => {
    const directConversation = {
      id: '22222222-2222-4222-8222-222222222222',
      kind: 'DIRECT' as const,
      participant: { userId: '11111111-1111-4111-8111-111111111111', displayName: 'Борис' },
      unreadCount: 0,
      updatedAt: '2026-08-03T10:00:00.000Z',
    };
    window.history.replaceState({}, '', `/chats/${directConversation.id}`);
    const gateway = createGateway({
      restoreSession: vi.fn().mockResolvedValue(session),
      listConversations: vi.fn().mockResolvedValue({ items: [directConversation] }),
      listConversationMessages: vi
        .fn()
        .mockResolvedValueOnce({ messages: [] })
        .mockRejectedValueOnce(new Error('history polling unavailable')),
    });

    render(<App gateway={gateway} tenantKey="padlhub" realtimeBaseUrl="wss://realtime.example" />);
    await waitFor(() => expect(realtimeMocks.connect).toHaveBeenCalledOnce());
    const connection = (
      realtimeMocks.connect.mock.calls as unknown as readonly [
        { readonly onRecoveryRequired: (afterSequence: number) => void },
      ][]
    )[0]?.[0];
    expect(connection).toBeDefined();
    act(() => connection?.onRecoveryRequired(0));

    expect(await screen.findByText('Проверьте соединение и повторите запрос.')).toBeVisible();
    expect(realtimeMocks.connect).toHaveBeenCalledOnce();
  });

  it('recovers a DIRECT sequence gap over paged HTTP without duplicate rendering', async () => {
    const conversationId = '22222222-2222-4222-8222-222222222222';
    const directConversation = {
      id: conversationId,
      kind: 'DIRECT' as const,
      participant: { userId: '11111111-1111-4111-8111-111111111111', displayName: 'Борис' },
      unreadCount: 0,
      updatedAt: '2026-08-03T10:00:00.000Z',
    };
    const messages = [
      {
        id: '33333333-3333-4333-8333-333333333331',
        conversationId,
        sequence: 1,
        sender: directConversation.participant,
        messageType: 'TEXT' as const,
        body: 'Первое',
        createdAt: '2026-08-03T10:01:00.000Z',
      },
      {
        id: '33333333-3333-4333-8333-333333333332',
        conversationId,
        sequence: 2,
        sender: directConversation.participant,
        messageType: 'TEXT' as const,
        body: 'Второе',
        createdAt: '2026-08-03T10:02:00.000Z',
      },
      {
        id: '33333333-3333-4333-8333-333333333333',
        conversationId,
        sequence: 3,
        sender: directConversation.participant,
        messageType: 'TEXT' as const,
        body: 'Третье',
        createdAt: '2026-08-03T10:03:00.000Z',
      },
    ];
    window.history.replaceState({}, '', `/chats/${conversationId}`);
    const listConversationMessages = vi
      .fn<AuthGateway['listConversationMessages']>()
      .mockResolvedValueOnce({ messages: [messages[0]!] })
      .mockResolvedValueOnce({ messages: [messages[0]!, messages[1]!], nextAfterSequence: 2 })
      .mockResolvedValueOnce({ messages: [messages[2]!] });
    const markConversationRead = vi.fn<AuthGateway['markConversationRead']>().mockResolvedValue({
      outcome: 'ok',
      readThroughSequence: 3,
      changed: true,
      replayed: false,
    });
    const gateway = createGateway({
      restoreSession: vi.fn().mockResolvedValue(session),
      listConversations: vi.fn().mockResolvedValue({ items: [directConversation] }),
      listConversationMessages,
      markConversationRead,
    });

    render(<App gateway={gateway} tenantKey="padlhub" realtimeBaseUrl="wss://realtime.example" />);
    await waitFor(() => expect(realtimeMocks.connect).toHaveBeenCalledOnce());
    expect(await screen.findAllByText('Первое')).toHaveLength(1);
    const connection = (
      realtimeMocks.connect.mock.calls as unknown as readonly [
        { readonly onRecoveryRequired: (afterSequence: number) => void },
      ][]
    )[0]?.[0];

    act(() => connection?.onRecoveryRequired(0));

    await waitFor(() => expect(listConversationMessages).toHaveBeenCalledTimes(3));
    expect(listConversationMessages.mock.calls).toEqual([
      [conversationId, 0],
      [conversationId, 0],
      [conversationId, 2],
    ]);
    expect(screen.getAllByText('Первое')).toHaveLength(1);
    expect(screen.getAllByText('Второе')).toHaveLength(1);
    expect(screen.getAllByText('Третье')).toHaveLength(1);
    const thread = screen.getByRole('region', { name: 'История сообщений' });
    expect(
      within(thread)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual([
      expect.stringContaining('Первое'),
      expect.stringContaining('Второе'),
      expect.stringContaining('Третье'),
    ]);
    await waitFor(() =>
      expect(markConversationRead).toHaveBeenCalledWith(conversationId, 3, expect.any(String)),
    );
  });

  it('runs one pending recovery after a realtime hint arrives during an HTTP refresh', async () => {
    const conversationId = '22222222-2222-4222-8222-222222222222';
    const directConversation = {
      id: conversationId,
      kind: 'DIRECT' as const,
      participant: { userId: '11111111-1111-4111-8111-111111111111', displayName: 'Борис' },
      unreadCount: 0,
      updatedAt: '2026-08-03T10:00:00.000Z',
    };
    const message = (sequence: number) => ({
      id: `33333333-3333-4333-8333-${String(sequence).padStart(12, '0')}`,
      conversationId,
      sequence,
      sender: directConversation.participant,
      messageType: 'TEXT' as const,
      body: `Сообщение ${sequence}`,
      createdAt: `2026-08-03T10:0${sequence}:00.000Z`,
    });
    let finishPendingHistory:
      ((value: { messages: readonly [ReturnType<typeof message>] }) => void) | undefined;
    const pendingHistory = new Promise<{ messages: readonly [ReturnType<typeof message>] }>(
      (resolve) => {
        finishPendingHistory = resolve;
      },
    );
    const listConversationMessages = vi
      .fn<AuthGateway['listConversationMessages']>()
      .mockResolvedValueOnce({ messages: [message(1)] })
      .mockReturnValueOnce(pendingHistory)
      .mockResolvedValueOnce({ messages: [message(3)] });
    window.history.replaceState({}, '', `/chats/${conversationId}`);
    const gateway = createGateway({
      restoreSession: vi.fn().mockResolvedValue(session),
      listConversations: vi.fn().mockResolvedValue({ items: [directConversation] }),
      listConversationMessages,
    });

    render(<App gateway={gateway} tenantKey="padlhub" realtimeBaseUrl="wss://realtime.example" />);
    await waitFor(() => expect(realtimeMocks.connect).toHaveBeenCalledOnce());
    const connection = (
      realtimeMocks.connect.mock.calls as unknown as readonly [
        { readonly onRecoveryRequired: (afterSequence: number) => void },
      ][]
    )[0]?.[0];

    act(() => connection?.onRecoveryRequired(1));
    await waitFor(() => expect(listConversationMessages).toHaveBeenCalledTimes(2));
    act(() => connection?.onRecoveryRequired(1));
    expect(listConversationMessages).toHaveBeenCalledTimes(2);
    act(() => finishPendingHistory?.({ messages: [message(2)] }));

    await waitFor(() => expect(listConversationMessages).toHaveBeenCalledTimes(3));
    expect(listConversationMessages.mock.calls).toEqual([
      [conversationId, 0],
      [conversationId, 1],
      [conversationId, 2],
    ]);
    expect(screen.getAllByText('Сообщение 1')).toHaveLength(1);
    expect(screen.getAllByText('Сообщение 2')).toHaveLength(1);
    expect(screen.getAllByText('Сообщение 3')).toHaveLength(1);
  });

  it('stops realtime when a loaded DIRECT chat unmounts', async () => {
    const directConversation = {
      id: '22222222-2222-4222-8222-222222222222',
      kind: 'DIRECT' as const,
      participant: { userId: '11111111-1111-4111-8111-111111111111', displayName: 'Борис' },
      unreadCount: 0,
      updatedAt: '2026-08-03T10:00:00.000Z',
    };
    const stop = vi.fn();
    realtimeMocks.connect.mockReturnValueOnce({ stop });
    window.history.replaceState({}, '', `/chats/${directConversation.id}`);
    const gateway = createGateway({
      restoreSession: vi.fn().mockResolvedValue(session),
      listConversations: vi.fn().mockResolvedValue({ items: [directConversation] }),
      listConversationMessages: vi.fn().mockResolvedValue({ messages: [] }),
    });

    const rendered = render(
      <App gateway={gateway} tenantKey="padlhub" realtimeBaseUrl="wss://realtime.example" />,
    );
    await waitFor(() => expect(realtimeMocks.connect).toHaveBeenCalledOnce());
    rendered.unmount();

    expect(stop).toHaveBeenCalledOnce();
  });

  it('retries an unconfirmed message with the same stable clientMessageId', async () => {
    const recipientUserId = '11111111-1111-4111-8111-111111111111';
    const conversationId = '22222222-2222-4222-8222-222222222222';
    window.history.replaceState({}, '', `/chats/${conversationId}`);
    const conversation = {
      id: conversationId,
      kind: 'DIRECT' as const,
      participant: { userId: recipientUserId, displayName: 'Борис' },
      unreadCount: 0,
      updatedAt: '2026-08-03T10:00:00.000Z',
    };
    const sendConversationMessage = vi
      .fn<AuthGateway['sendConversationMessage']>()
      .mockRejectedValueOnce(new TypeError('network interrupted'))
      .mockImplementation((_selectedConversationId, command) =>
        Promise.resolve({
          outcome: 'ok',
          message: {
            id: '33333333-3333-4333-8333-333333333333',
            conversationId,
            sequence: 1,
            sender: { userId: session.context.user.id, displayName: 'Анна' },
            messageType: 'TEXT',
            body: command.body,
            createdAt: '2026-08-03T10:01:00.000Z',
          },
          replayed: true,
        }),
      );
    const gateway = createGateway({
      restoreSession: vi.fn().mockResolvedValue(session),
      listConversations: vi.fn().mockResolvedValue({ items: [conversation] }),
      listConversationMessages: vi.fn().mockResolvedValue({ messages: [] }),
      sendConversationMessage,
    });
    const user = userEvent.setup();

    render(<App gateway={gateway} tenantKey="padlhub" />);
    await user.type(await screen.findByLabelText('Сообщение'), 'Привет');
    await user.click(screen.getByRole('button', { name: 'Отправить' }));
    await user.click(await screen.findByRole('button', { name: 'Повторить отправку' }));

    await waitFor(() => expect(sendConversationMessage).toHaveBeenCalledTimes(2));
    const firstCommand = sendConversationMessage.mock.calls[0]?.[1];
    const retryCommand = sendConversationMessage.mock.calls[1]?.[1];
    expect(firstCommand?.clientMessageId).toEqual(retryCommand?.clientMessageId);
    expect(firstCommand?.body).toBe('Привет');
    expect(retryCommand?.body).toBe('Привет');
  });

  it('falls back to phone login when session restoration is unavailable', async () => {
    const gateway = createGateway({
      restoreSession: vi.fn().mockRejectedValue(new Error('network unavailable')),
    });

    render(<App gateway={gateway} tenantKey="padlhub" />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Не удалось проверить сессию');
    expect(screen.getByRole('heading', { name: 'Войти в личный кабинет' })).toBeVisible();
  });

  it('keeps iPhone browsers on regular OAuth and does not offer SMS login', async () => {
    vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue(
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 Version/26.5 Mobile/23F77 Safari/604.1',
    );
    const gateway = createGateway();
    render(<App gateway={gateway} tenantKey="padlhub" />);

    expect(await screen.findByRole('heading', { name: 'Войти в личный кабинет' })).toBeVisible();
    expect(screen.getByRole('note')).toHaveTextContent('На iPhone откройте сайт в Safari');
    expect(
      screen.queryByRole('button', { name: 'Войти по номеру телефона' }),
    ).not.toBeInTheDocument();
    expect(gateway.startVivaOAuth).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'VK ID или Mail.ru' })).toHaveAttribute(
      'aria-describedby',
      'ios-oauth-guidance',
    );
  });

  it('requires both legal acceptances before beginning Viva OAuth', async () => {
    const gateway = createGateway();
    const user = userEvent.setup();
    render(<App gateway={gateway} tenantKey="padlhub" />);

    const vkButton = await screen.findByRole('button', { name: 'VK ID или Mail.ru' });
    await user.click(vkButton);
    expect(await screen.findByRole('alert')).toHaveTextContent('Подтвердите публичную оферту');
    expect(gateway.startVivaOAuth).not.toHaveBeenCalled();

    await user.click(screen.getByRole('checkbox', { name: /публичной оферты/i }));
    await user.click(screen.getByRole('checkbox', { name: /обработку персональных данных/i }));
    await user.click(vkButton);
    expect(gateway.startVivaOAuth).toHaveBeenCalledWith({
      provider: 'vkid',
      acceptance: { publicOfferAccepted: true, personalDataPolicyAccepted: true },
    });
  });

  it('opens /giftcard through the anonymous sale boundary without restoring a session', async () => {
    window.history.replaceState({}, '', '/giftcard');
    const gateway = createGateway({
      getPublicGiftCertificateCatalog: vi.fn().mockResolvedValue(giftCertificateCatalog),
    });

    render(<App gateway={gateway} tenantKey="padlhub" />);

    expect(
      await screen.findByRole('heading', { name: 'Идеальный подарок без хлопот' }),
    ).toBeVisible();
    expect(gateway.restoreSession).not.toHaveBeenCalled();
    expect(
      screen.queryByRole('heading', { name: 'Войти в личный кабинет' }),
    ).not.toBeInTheDocument();
  });

  it('opens /gift-certificates in LK after restoring the buyer session', async () => {
    window.history.replaceState({}, '', '/gift-certificates');
    const gateway = createGateway({
      restoreSession: vi.fn().mockResolvedValue(session),
      getPublicGiftCertificateCatalog: vi.fn().mockResolvedValue(giftCertificateCatalog),
    });

    render(<App gateway={gateway} tenantKey="padlhub" />);

    expect(await screen.findByRole('heading', { name: 'Подарочная карта' })).toBeVisible();
    expect(gateway.restoreSession).toHaveBeenCalledTimes(1);
  });
});
