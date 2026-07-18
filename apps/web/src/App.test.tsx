// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { App } from './App.js';
import type {
  AuthGateway,
  AuthenticatedSession,
  CommunityMembershipPage,
  HomeDashboard,
  NotificationInboxPage,
  PlayerProfileView,
  UserUpcomingBookings,
} from './auth-gateway.js';

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
    getUserProfile: vi.fn().mockResolvedValue(homeDashboard.profile),
    getPlayerProfile: vi.fn().mockResolvedValue(userProfile),
    getProfilePrivacy: vi.fn().mockResolvedValue(profilePrivacy),
    updateProfilePrivacy: vi.fn().mockResolvedValue(profilePrivacy),
    getUpcomingBookings: vi.fn().mockResolvedValue(upcomingBookings),
    getHomeDashboard: vi.fn().mockResolvedValue(homeDashboard),
    listLocations: vi.fn<AuthGateway['listLocations']>().mockResolvedValue({ items: [] }),
    getLocation: vi
      .fn<AuthGateway['getLocation']>()
      .mockRejectedValue(new Error('LOCATION_NOT_FOUND')),
    listMyCommunities: vi.fn().mockResolvedValue(communityMemberships),
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
  window.history.replaceState({}, '', '/');
});

async function openPhoneLogin(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(await screen.findByRole('button', { name: 'Войти по номеру телефона' }));
  await user.click(screen.getByRole('checkbox', { name: /публичной оферты/i }));
  await user.click(screen.getByRole('checkbox', { name: /обработку персональных данных/i }));
}

describe('PadlHub web authentication', () => {
  it('restores an HttpOnly-cookie-backed session before showing protected home', async () => {
    const gateway = createGateway({ restoreSession: vi.fn().mockResolvedValue(session) });

    render(<App gateway={gateway} tenantKey="padlhub" />);

    expect(screen.getByRole('status')).toHaveTextContent('Проверяем сессию');
    expect(await screen.findByRole('heading', { name: 'Анна Петрова' })).toBeVisible();
    expect(screen.getAllByText('ПаделХАБ').length).toBeGreaterThan(0);
    expect(screen.getByRole('heading', { name: 'Сообщества' })).toBeVisible();
    const homeActions = screen.getByRole('navigation', { name: 'Разделы клуба' });
    expect(within(homeActions).getAllByRole('link')).toHaveLength(3);
    expect(within(homeActions).getByRole('link', { name: 'Игры' })).toHaveAttribute(
      'href',
      '/games',
    );
    expect(within(homeActions).getByRole('link', { name: 'Турниры' })).toHaveAttribute(
      'href',
      '/tournaments',
    );
    expect(within(homeActions).getByRole('link', { name: 'Тренировки' })).toHaveAttribute(
      'href',
      '/trainings',
    );
    expect(screen.getByRole('tab', { name: 'Мои записи' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByRole('tab', { name: 'Абонементы' })).toHaveAttribute(
      'aria-selected',
      'false',
    );
    expect(screen.queryByRole('link', { name: 'Создать игру' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Чаты' })).not.toBeInTheDocument();
    const twoLineCommunity = screen
      .getByRole('group', { name: 'Padel Friends, непрочитанных сообщений: 2' })
      .querySelector('.fh-community-title');
    expect(twoLineCommunity).toHaveClass('is-two-lines');
    expect(twoLineCommunity).toHaveAttribute('data-title-lines', '2');
    expect(twoLineCommunity?.children).toHaveLength(2);
    const centeredCommunity = screen
      .getByRole('group', { name: 'Тест' })
      .querySelector('.fh-community-title');
    expect(centeredCommunity).toHaveClass('is-single-word');
    expect(centeredCommunity).toHaveAttribute('data-title-lines', '1');
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
    expect(gateway.getHomeDashboard).toHaveBeenCalledOnce();
    expect(gateway.listNotifications).toHaveBeenCalledOnce();
  });

  it('revalidates Home on focus and replaces a fallback avatar with the projection photo', async () => {
    const avatarUrl = 'http://127.0.0.1:9000/phub-local/profile-photo.webp';
    const refreshedDashboard: HomeDashboard = {
      ...homeDashboard,
      snapshot: { ...homeDashboard.snapshot, version: 'home-v1-refreshed' },
      profile: {
        ...homeDashboard.profile,
        avatarUrl,
        balanceMinor: 2_100,
        level: { label: 'C', value: 3.15, assessmentRequired: false },
      },
    };
    const getHomeDashboard = vi
      .fn<AuthGateway['getHomeDashboard']>()
      .mockResolvedValueOnce(homeDashboard)
      .mockResolvedValueOnce(refreshedDashboard);
    const gateway = createGateway({
      restoreSession: vi.fn().mockResolvedValue(session),
      getHomeDashboard,
    });

    render(<App gateway={gateway} tenantKey="padlhub" />);

    const initialAvatar = await screen.findByRole('img', {
      name: 'Анна Петрова, уровень C+, прогресс 80%',
    });
    expect(initialAvatar.querySelector('[data-player-level-photo]')).toHaveAttribute(
      'data-player-level-photo',
      'fallback',
    );

    window.dispatchEvent(new Event('focus'));

    await waitFor(() => {
      const refreshedAvatar = screen.getByRole('img', {
        name: 'Анна Петрова, уровень C, прогресс 15%',
      });
      expect(refreshedAvatar.querySelector('[data-player-level-photo]')).toHaveAttribute(
        'src',
        avatarUrl,
      );
      expect(refreshedAvatar.querySelector('[data-player-level-photo]')).toHaveAttribute(
        'data-player-level-photo',
        'source',
      );
    });
    expect(screen.getByText('21 ₽')).toBeVisible();
    expect(getHomeDashboard).toHaveBeenCalledTimes(2);
  });

  it('hydrates the Home carousel from the community directory and continues near the swipe end', async () => {
    const directoryItems: CommunityMembershipPage['items'] = [
      ...homeDashboard.communities,
      {
        id: 'c522103f-05aa-4ef1-a3a4-645d9a78b397',
        title: 'Команда Север',
        logoUrl: null,
        isVerified: false,
        unreadChatCount: 0,
        route: '/communities/c522103f-05aa-4ef1-a3a4-645d9a78b397',
      },
      {
        id: '92e25178-32e4-4fed-8964-5e758f858b0e',
        title: 'Турнирный клуб',
        logoUrl: null,
        isVerified: true,
        unreadChatCount: 0,
        route: '/communities/92e25178-32e4-4fed-8964-5e758f858b0e',
      },
      {
        id: 'd12694bc-59cc-4b69-bcdf-42ef4ad821bb',
        title: 'Игроки Юга',
        logoUrl: null,
        isVerified: false,
        unreadChatCount: 0,
        route: '/communities/d12694bc-59cc-4b69-bcdf-42ef4ad821bb',
      },
      {
        id: 'e734fcec-b70f-4a9a-8e77-668fb98cf4ce',
        title: 'Шестое сообщество',
        logoUrl: null,
        isVerified: false,
        unreadChatCount: 0,
        route: '/communities/e734fcec-b70f-4a9a-8e77-668fb98cf4ce',
      },
    ];
    const continuedCommunity: CommunityMembershipPage['items'][number] = {
      id: 'f8a797f8-0796-4b83-810a-0b1d2c81e251',
      title: 'После свайпа',
      logoUrl: null,
      isVerified: false,
      unreadChatCount: 0,
      route: '/communities/f8a797f8-0796-4b83-810a-0b1d2c81e251',
    };
    const listMyCommunities = vi
      .fn<AuthGateway['listMyCommunities']>()
      .mockResolvedValueOnce({ items: directoryItems, nextCursor: 'opaque-community-cursor' })
      .mockResolvedValueOnce({ items: [continuedCommunity] });
    const gateway = createGateway({
      restoreSession: vi.fn().mockResolvedValue(session),
      listMyCommunities,
    });

    render(<App gateway={gateway} tenantKey="padlhub" />);

    expect(await screen.findByRole('group', { name: 'Шестое сообщество' })).toBeVisible();
    const carousel = screen.getByRole('region', { name: 'Мои сообщества' });
    expect(carousel).toHaveAttribute('tabindex', '0');
    Object.defineProperties(carousel, {
      scrollWidth: { configurable: true, value: 800 },
      clientWidth: { configurable: true, value: 355 },
      scrollLeft: { configurable: true, value: 0, writable: true },
    });

    fireEvent.mouseDown(carousel, { button: 0, clientX: 300 });
    fireEvent.mouseMove(carousel, { buttons: 1, clientX: 180 });
    expect(carousel.scrollLeft).toBe(120);
    expect(carousel).toHaveClass('is-dragging');
    fireEvent.mouseUp(carousel, { button: 0, clientX: 180 });
    expect(carousel).not.toHaveClass('is-dragging');
    expect(screen.queryByRole('link', { name: 'Шестое сообщество' })).not.toBeInTheDocument();

    carousel.scrollLeft = 350;
    fireEvent.scroll(carousel);

    expect(await screen.findByRole('group', { name: 'После свайпа' })).toBeVisible();
    expect(listMyCommunities).toHaveBeenNthCalledWith(1);
    expect(listMyCommunities).toHaveBeenNthCalledWith(2, 'opaque-community-cursor');
  });

  it('loads the profile route through the profile gateway without requesting Home', async () => {
    window.history.replaceState({}, '', '/profile');
    const gateway = createGateway({ restoreSession: vi.fn().mockResolvedValue(session) });

    render(<App gateway={gateway} tenantKey="padlhub" />);

    expect(await screen.findByRole('heading', { name: 'Анна Петрова' })).toBeVisible();
    expect(screen.getByText('540 ₽')).toBeVisible();
    expect(screen.getByText('Рейтинг 3,8')).toBeVisible();
    expect(await screen.findByRole('heading', { name: 'Кто может связаться' })).toBeVisible();
    expect(screen.getByRole('checkbox', { name: /Запрос на связь/ })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /Личный чат/ })).toBeChecked();
    expect(gateway.getPlayerProfile).toHaveBeenCalledWith(session.context.user.id);
    expect(gateway.getProfilePrivacy).toHaveBeenCalledOnce();
    expect(gateway.getHomeDashboard).not.toHaveBeenCalled();
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

    const chatToggle = await screen.findByRole('checkbox', { name: /Личный чат/ });
    await user.click(chatToggle);
    await user.click(screen.getByRole('button', { name: 'Сохранить' }));

    await waitFor(() =>
      expect(updateProfilePrivacy).toHaveBeenCalledWith({
        expectedVersion: 1,
        contactPolicy: 'AUTHORIZED',
        chatPolicy: 'NOBODY',
      }),
    );
    expect(await screen.findByText('Настройки сохранены')).toBeVisible();
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
    expect(gateway.getHomeDashboard).not.toHaveBeenCalled();
  });

  it('loads the bookings route as a separate PadlHub aggregate without requesting Home', async () => {
    window.history.replaceState({}, '', '/bookings');
    const gateway = createGateway({ restoreSession: vi.fn().mockResolvedValue(session) });

    render(<App gateway={gateway} tenantKey="padlhub" />);

    expect(await screen.findByRole('heading', { name: 'Мои записи' })).toBeVisible();
    expect(screen.getByText('Американо · уровень C')).toBeVisible();
    expect(screen.getByText('Подтверждено')).toBeVisible();
    expect(gateway.getUpcomingBookings).toHaveBeenCalledOnce();
    expect(gateway.getHomeDashboard).not.toHaveBeenCalled();
    expect(gateway.getPlayerProfile).not.toHaveBeenCalled();
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
      restoreSession: vi.fn().mockResolvedValue(session),
      listMyCommunities,
    });
    const user = userEvent.setup();

    render(<App gateway={gateway} tenantKey="padlhub" />);

    expect(await screen.findByRole('heading', { name: 'Мои сообщества' })).toBeVisible();
    expect(await screen.findByText('Padel Friends')).toBeVisible();
    expect(screen.queryByRole('link', { name: /Padel Friends/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Показать ещё' }));
    expect(await screen.findByText('Команда Север')).toBeVisible();
    expect(listMyCommunities).toHaveBeenNthCalledWith(1);
    expect(listMyCommunities).toHaveBeenNthCalledWith(2, 'opaque-community-cursor');
    expect(gateway.getHomeDashboard).not.toHaveBeenCalled();
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
    expect(gateway.getHomeDashboard).not.toHaveBeenCalled();
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

  it('fails closed for an unfinished section route instead of showing a placeholder', async () => {
    window.history.replaceState({}, '', '/promotions');
    const gateway = createGateway({ restoreSession: vi.fn().mockResolvedValue(session) });

    render(<App gateway={gateway} tenantKey="padlhub" />);

    expect(await screen.findByRole('heading', { name: 'Страница не найдена' })).toBeVisible();
    expect(screen.queryByText('Раздел подключается к API ПаделХАБ.')).not.toBeInTheDocument();
    expect(gateway.getHomeDashboard).not.toHaveBeenCalled();
    expect(gateway.getUpcomingBookings).not.toHaveBeenCalled();
    expect(gateway.getPlayerProfile).not.toHaveBeenCalled();
  });

  it('shows an honest work-in-progress shell for a restored staged section', async () => {
    window.history.replaceState({}, '', '/subscriptions');
    const gateway = createGateway({ restoreSession: vi.fn().mockResolvedValue(session) });

    render(<App gateway={gateway} tenantKey="padlhub" />);

    expect(await screen.findByRole('heading', { name: 'Абонементы' })).toBeVisible();
    expect(screen.getByText('Раздел подключается к API ПаделХАБ.')).toBeVisible();
    expect(gateway.getHomeDashboard).not.toHaveBeenCalled();
  });

  it('shows a not-found screen for an unknown protected route without requesting Home', async () => {
    window.history.replaceState({}, '', '/unknown');
    const gateway = createGateway({ restoreSession: vi.fn().mockResolvedValue(session) });

    render(<App gateway={gateway} tenantKey="padlhub" />);

    expect(await screen.findByRole('heading', { name: 'Страница не найдена' })).toBeVisible();
    expect(gateway.getHomeDashboard).not.toHaveBeenCalled();
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

  it('falls back to phone login when session restoration is unavailable', async () => {
    const gateway = createGateway({
      restoreSession: vi.fn().mockRejectedValue(new Error('network unavailable')),
    });

    render(<App gateway={gateway} tenantKey="padlhub" />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Не удалось проверить сессию');
    expect(screen.getByRole('heading', { name: 'Войти в личный кабинет' })).toBeVisible();
  });

  it('defaults iPhone browsers to phone login and warns before external Viva OAuth', async () => {
    vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue(
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 Version/26.5 Mobile/23F77 Safari/604.1',
    );
    const gateway = createGateway();
    const user = userEvent.setup();

    render(<App gateway={gateway} tenantKey="padlhub" />);

    expect(await screen.findByRole('heading', { name: 'Вход по номеру' })).toBeVisible();
    expect(screen.getByRole('note')).toHaveTextContent('Для iPhone выбран надёжный способ входа');
    expect(screen.getByRole('note')).toHaveTextContent('откройте исходную страницу в Safari');
    expect(gateway.startVivaOAuth).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: /Войти через Viva/ }));

    expect(screen.getByRole('heading', { name: 'Войти в личный кабинет' })).toBeVisible();
    expect(screen.getByRole('note')).toHaveTextContent('Во встроенном браузере Telegram');
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
});
