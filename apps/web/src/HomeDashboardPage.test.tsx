// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  BookingRecommendationPage,
  HomeBase,
  HomeDashboard,
  UserUpcomingBookings,
} from './auth-gateway.js';
import { HomeDashboardPage } from './HomeDashboardPage.js';

const dashboard: HomeDashboard = {
  snapshot: {
    version: 'home-v1-promotions',
    generatedAt: '2026-07-17T12:00:00.000Z',
    staleAt: '2026-07-17T12:05:00.000Z',
    source: 'LOCAL_PROJECTION',
  },
  profile: {
    userId: '49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca',
    displayName: 'Анна Петрова',
    avatarUrl: null,
    balanceMinor: 0,
    currency: 'RUB',
    level: { label: 'C', value: 3, assessmentRequired: false },
  },
  counters: { unreadChats: 0, upcomingEvents: 0, activeSubscriptions: 0 },
  quickActions: [],
  upcoming: [],
  subscriptions: [],
  communities: [],
  promotion: null,
  promotions: {
    rotationEnabled: true,
    intervalSeconds: 6,
    items: [
      {
        id: '11111111-1111-4111-8111-111111111111',
        eyebrow: 'Акция',
        title: 'Первая акция',
        description: 'Первая активная акция.',
        actionLabel: 'Подробнее',
        route: '/promotions/first',
        tone: 'lime',
        imageUrl: 'https://media.padlhub.test/desktop-first.webp',
        mobileImageUrl: 'https://media.padlhub.test/mobile-first.webp',
      },
      {
        id: '22222222-2222-4222-8222-222222222222',
        eyebrow: 'Акция',
        title: 'Вторая акция',
        description: 'Вторая активная акция.',
        actionLabel: 'Подробнее',
        route: 'https://padlhub.ru/promo/second',
        tone: 'lime',
        imageUrl: 'https://media.padlhub.test/desktop-second.webp',
        mobileImageUrl: 'https://media.padlhub.test/mobile-second.webp',
      },
    ],
  },
  locations: [],
  additionalLinks: [],
  capabilities: {
    canCreateGame: false,
    canManageTournaments: false,
    canViewCommunities: false,
  },
};

const homeBase: HomeBase = {
  snapshot: {
    version: 'home-base-v1-promotions',
    generatedAt: dashboard.snapshot.generatedAt,
    source: 'LOCAL_PROJECTION',
    completeness: 'PARTIAL',
  },
  viewerUserId: dashboard.profile.userId,
  quickActions: dashboard.quickActions,
  communities: {
    status: 'READY',
    revision: '1',
    observedAt: dashboard.snapshot.generatedAt,
    staleAt: dashboard.snapshot.staleAt,
    value: dashboard.communities,
  },
  promotions: {
    status: 'READY',
    revision: '1',
    observedAt: dashboard.snapshot.generatedAt,
    staleAt: dashboard.snapshot.staleAt,
    value: {
      hero: dashboard.promotions,
      standard: dashboard.promotions,
    },
  },
  locations: dashboard.locations,
  additionalLinks: dashboard.additionalLinks,
  capabilities: dashboard.capabilities,
};

const defaultUpcoming: UserUpcomingBookings = {
  version: dashboard.snapshot.version,
  generatedAt: dashboard.snapshot.generatedAt,
  staleAt: dashboard.snapshot.staleAt,
  items: dashboard.upcoming,
};

const independentSectionProps = {
  viewerFallback: {
    id: dashboard.profile.userId,
    displayName: dashboard.profile.displayName,
  },
  viewer: { state: 'READY' as const, value: dashboard.profile },
  upcoming: { state: 'READY' as const, value: defaultUpcoming },
  onRetryViewer: vi.fn(),
  onRetryUpcoming: vi.fn(),
};

function readyUpcoming(items: UserUpcomingBookings['items']): {
  readonly state: 'READY';
  readonly value: UserUpcomingBookings;
} {
  return { state: 'READY', value: { ...defaultUpcoming, items } };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Home promotion carousel', () => {
  it('uses the mobile WebP derivative and rotates active CUP promotions', () => {
    vi.useFakeTimers();
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: false }));
    render(
      <HomeDashboardPage
        {...independentSectionProps}
        dashboard={homeBase}
        tenantName="ПадлХАБ"
        notificationUnreadCount={0}
        logoutBusy={false}
        onLogout={vi.fn()}
      />,
    );

    const heroPromotion = screen.getByRole('region', { name: 'Промо в шапке' });
    expect(
      within(heroPromotion).getByRole('link', { name: 'Акция: Первая акция' }),
    ).toHaveAttribute('href', '/promotions/first');
    const lowerPromotions = screen.getByRole('region', { name: 'Акции' });
    const first = within(lowerPromotions).getByRole('link', { name: 'Первая акция' });
    expect(first).toHaveAttribute('href', '/promotions/first');
    expect(first.querySelector('source')).toHaveAttribute(
      'srcset',
      'https://media.padlhub.test/mobile-first.webp',
    );

    act(() => {
      vi.advanceTimersByTime(6_000);
    });

    expect(
      within(heroPromotion).getByRole('link', { name: 'Акция: Вторая акция' }),
    ).toHaveAttribute('href', 'https://padlhub.ru/promo/second');
    const second = within(lowerPromotions).getByRole('link', { name: 'Вторая акция' });
    expect(second).toHaveAttribute('href', 'https://padlhub.ru/promo/second');
    expect(second.querySelector('source')).toHaveAttribute(
      'srcset',
      'https://media.padlhub.test/mobile-second.webp',
    );
    expect(
      within(heroPromotion).getByRole('button', { name: 'Показать акцию «Вторая акция»' }),
    ).toHaveAttribute('aria-current', 'true');
  });
});

describe('Home progressive navigation', () => {
  it('keeps local navigation and locations when optional Base sections are unavailable', () => {
    render(
      <HomeDashboardPage
        {...independentSectionProps}
        dashboard={{
          ...homeBase,
          communities: { status: 'UNAVAILABLE' },
          promotions: { status: 'UNAVAILABLE' },
          capabilities: { ...homeBase.capabilities, canViewCommunities: true },
        }}
        tenantName="ПадлХАБ"
        notificationUnreadCount={0}
        logoutBusy={false}
        onLogout={vi.fn()}
      />,
    );

    expect(screen.getByRole('navigation', { name: 'Разделы клуба' })).toBeVisible();
    expect(screen.getByText('Сообщества временно недоступны.')).toBeVisible();
    const heroPromotion = screen.getByRole('region', { name: 'Промо в шапке' });
    expect(within(heroPromotion).getByRole('img', { name: 'Лето. Падел.' })).toHaveAttribute(
      'width',
      '670',
    );
    expect(screen.getAllByText('Акции временно недоступны.')).toHaveLength(1);
    expect(screen.getByRole('heading', { name: /Локации/ })).toBeVisible();
  });

  it('shows the local hero fallback when the CUP promotion deck is empty', () => {
    render(
      <HomeDashboardPage
        {...independentSectionProps}
        dashboard={{
          ...homeBase,
          promotions: {
            status: 'READY',
            revision: 'empty-promotions',
            observedAt: dashboard.snapshot.generatedAt,
            staleAt: dashboard.snapshot.staleAt,
            value: {
              hero: { rotationEnabled: false, intervalSeconds: 6, items: [] },
              standard: { rotationEnabled: false, intervalSeconds: 6, items: [] },
            },
          },
        }}
        tenantName="ПадлХАБ"
        notificationUnreadCount={0}
        logoutBusy={false}
        onLogout={vi.fn()}
      />,
    );

    const heroPromotion = screen.getByRole('region', { name: 'Промо в шапке' });
    expect(within(heroPromotion).getByRole('img', { name: 'Лето. Падел.' })).toBeVisible();
  });

  it('renders stale communities without the technical freshness notice', () => {
    render(
      <HomeDashboardPage
        {...independentSectionProps}
        dashboard={{
          ...homeBase,
          communities: {
            status: 'STALE',
            revision: '1',
            observedAt: dashboard.snapshot.generatedAt,
            staleAt: dashboard.snapshot.staleAt,
            value: dashboard.communities,
          },
          capabilities: { ...homeBase.capabilities, canViewCommunities: true },
        }}
        tenantName="ПадлХАБ"
        notificationUnreadCount={0}
        logoutBusy={false}
        onLogout={vi.fn()}
      />,
    );

    expect(screen.getByRole('region', { name: 'Мои сообщества' })).toBeVisible();
    expect(screen.queryByText('Показаны последние доступные сообщества.')).not.toBeInTheDocument();
  });

  it('places additional sections after locations and routes certificates to the sale page', () => {
    render(
      <HomeDashboardPage
        {...independentSectionProps}
        dashboard={{
          ...homeBase,
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
        }}
        tenantName="ПадлХАБ"
        notificationUnreadCount={0}
        logoutBusy={false}
        onLogout={vi.fn()}
      />,
    );

    const locations = screen.getByRole('region', { name: /локации/i });
    const additional = screen.getByRole('navigation', { name: 'Дополнительные разделы' });
    expect(locations.nextElementSibling).toBe(additional);
    expect(
      within(additional).getByRole('link', { name: 'Подарочные сертификаты' }),
    ).toHaveAttribute('href', '/gift-certificates');
    expect(within(additional).getByRole('link', { name: 'Все акции' })).toHaveAttribute(
      'href',
      '/promotions',
    );
    expect(within(additional).getByRole('link', { name: 'Предложения' })).toHaveAttribute(
      'href',
      '/offers',
    );
  });

  it('shows the booking recommendations GIF while the personalized feed loads', () => {
    const loadBookingRecommendations = vi.fn(
      () => new Promise<BookingRecommendationPage>(() => undefined),
    );
    render(
      <HomeDashboardPage
        {...independentSectionProps}
        dashboard={homeBase}
        tenantName="ПадлХАБ"
        notificationUnreadCount={0}
        loadBookingRecommendations={loadBookingRecommendations}
        logoutBusy={false}
        onLogout={vi.fn()}
      />,
    );

    const loader = screen.getByRole('status', { name: 'Подбираем игры' });
    expect(loader.querySelector('img')).toHaveAttribute(
      'src',
      expect.stringMatching(/booking-recommendations\.gif$/),
    );
  });

  it('shows only games and trainings and opens recommendations by default', async () => {
    const loadBookingRecommendations = vi.fn().mockResolvedValue({
      version: 'a'.repeat(64),
      generatedAt: '2026-07-18T09:00:00.000Z',
      staleAt: '2026-07-18T09:05:00.000Z',
      personalization: 'BASIC',
      items: [],
      nextCursor: null,
    });
    const { container } = render(
      <HomeDashboardPage
        {...independentSectionProps}
        dashboard={homeBase}
        tenantName="ПадлХАБ"
        notificationUnreadCount={0}
        loadBookingRecommendations={loadBookingRecommendations}
        logoutBusy={false}
        onLogout={vi.fn()}
      />,
    );

    const actions = screen.getByRole('navigation', { name: 'Разделы клуба' });
    expect(within(actions).getByRole('link', { name: 'Играть' })).toHaveAttribute('href', '/games');
    expect(within(actions).queryByRole('link', { name: 'Турниры' })).not.toBeInTheDocument();
    expect(within(actions).getByRole('link', { name: 'Тренироваться' })).toHaveAttribute(
      'href',
      '/trainings',
    );
    expect(
      within(screen.getByRole('tablist', { name: 'Раздел записей' }))
        .getAllByRole('tab')
        .map((tab) => tab.textContent),
    ).toEqual(['Для меня', 'Мои записи']);
    expect(screen.getByRole('tab', { name: 'Мои записи' })).toHaveAttribute(
      'aria-selected',
      'false',
    );
    expect(
      screen.getByRole('tab', { name: 'Мои записи' }).querySelector('.fh-booking-presence-dot'),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Для меня' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('link', { name: 'Настроить предпочтения' })).toHaveAttribute(
      'href',
      '/profile#booking-preferences-title',
    );
    expect(container.querySelector('.figma-home-shell')).toHaveClass(
      'has-recommendations-scroll-peek',
    );
    await vi.waitFor(() => expect(loadBookingRecommendations).toHaveBeenCalledOnce());
    expect(loadBookingRecommendations).toHaveBeenCalledWith({ limit: 6 });
    expect(screen.queryByText('Подходящие игры')).not.toBeInTheDocument();
    const configure = screen.getByRole('link', { name: 'Настроить' });
    expect(configure).toHaveAttribute('href', '/profile#booking-preferences-title');
    expect(container.querySelector('.fh-for-me > header')).not.toBeInTheDocument();
    expect(configure.parentElement).toHaveClass('fh-bookings-footer-action', 'is-split');
    expect(configure.previousElementSibling).toHaveTextContent('Все рекомендации');
  });

  it('keeps the second Home variant independent and puts promotion before communities', () => {
    const { container } = render(
      <HomeDashboardPage
        {...independentSectionProps}
        dashboard={{
          ...homeBase,
          capabilities: { ...homeBase.capabilities, canViewCommunities: true },
        }}
        tenantName="ПадлХАБ"
        layoutVariant="v2"
        notificationUnreadCount={0}
        logoutBusy={false}
        onLogout={vi.fn()}
      />,
    );

    const hero = container.querySelector('.fh-hero--v2');
    const heroChildClasses = [...(hero?.children ?? [])].map((element) => element.className);
    expect(hero).toBeInTheDocument();
    expect(heroChildClasses.indexOf('fh-hero-promotion')).toBeLessThan(
      heroChildClasses.indexOf('fh-hero-communities'),
    );
  });

  it('marks the third Home variant and requests its first 14 recommendations', async () => {
    const loadBookingRecommendations = vi.fn().mockResolvedValue({
      version: 'a'.repeat(64),
      generatedAt: '2026-07-18T09:00:00.000Z',
      staleAt: '2026-07-18T09:05:00.000Z',
      personalization: 'BASIC',
      items: [],
      nextCursor: null,
    });
    const { container } = render(
      <HomeDashboardPage
        {...independentSectionProps}
        dashboard={{
          ...homeBase,
          capabilities: { ...homeBase.capabilities, canViewCommunities: true },
        }}
        tenantName="ПадлХАБ"
        layoutVariant="v3"
        notificationUnreadCount={0}
        loadBookingRecommendations={loadBookingRecommendations}
        logoutBusy={false}
        onLogout={vi.fn()}
      />,
    );

    await vi.waitFor(() => expect(loadBookingRecommendations).toHaveBeenCalledWith({ limit: 14 }));
    expect(container.querySelector('.figma-home-shell')).toHaveClass(
      'is-home-v3',
      'has-recommendations-scroll-peek',
    );
    expect(container.querySelector('.fh-hero--v3')).toHaveClass('fh-hero--v2');
    const hero = container.querySelector('.fh-hero--v3');
    const heroChildClasses = [...(hero?.children ?? [])].map((element) => element.className);
    expect(heroChildClasses.indexOf('fh-hero-communities')).toBeLessThan(
      heroChildClasses.indexOf('fh-hero-promotion'),
    );
    expect(screen.queryByRole('link', { name: 'Все рекомендации' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Настроить' }).parentElement).not.toHaveClass(
      'is-split',
    );
    expect(container.querySelector('.fh-main-box > .fh-promotions')).not.toBeInTheDocument();
    expect(container.querySelector('.fh-main-box > .fh-lower')).not.toBeInTheDocument();
    expect(container.querySelector('.fh-v3-my-extras')).not.toBeInTheDocument();
  });

  it('keeps the Home V3 request unchanged while rendering recommendations as ordinary rows', async () => {
    const loadBookingRecommendations = vi.fn().mockResolvedValue({
      version: 'b'.repeat(64),
      generatedAt: '2026-07-18T09:00:00.000Z',
      staleAt: '2026-07-18T09:05:00.000Z',
      personalization: 'BASIC' as const,
      items: [],
      nextCursor: null,
    });
    const { container } = render(
      <HomeDashboardPage
        {...independentSectionProps}
        dashboard={homeBase}
        tenantName="ПадлХАБ"
        layoutVariant="v3"
        recommendationDisplay="ROWS"
        notificationUnreadCount={0}
        loadBookingRecommendations={loadBookingRecommendations}
        logoutBusy={false}
        onLogout={vi.fn()}
      />,
    );

    await vi.waitFor(() => expect(loadBookingRecommendations).toHaveBeenCalledWith({ limit: 14 }));
    expect(container.querySelector('.figma-home-shell')).toHaveClass(
      'is-home-v3-rows',
      'has-recommendations-scroll-peek',
    );
    expect(container.querySelector('.figma-home-shell')).not.toHaveClass('is-home-v3');
    expect(screen.getByRole('link', { name: 'Все рекомендации' })).toBeVisible();
    expect(screen.getByRole('link', { name: 'Настроить' }).parentElement).toHaveClass('is-split');
  });

  it('places promotion, stations, and three links below History in the V3 My bookings tab', () => {
    const { container } = render(
      <HomeDashboardPage
        {...independentSectionProps}
        dashboard={{
          ...homeBase,
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
        }}
        tenantName="ПадлХАБ"
        layoutVariant="v3"
        notificationUnreadCount={0}
        logoutBusy={false}
        onLogout={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('tab', { name: 'Мои записи' }));

    const history = screen.getByRole('button', { name: 'История посещений' });
    const services = screen.getByRole('region', { name: 'Сервисы клуба' });
    const locations = within(services).getByRole('region', { name: /локации/i });
    const promotion = within(services).getByRole('region', { name: 'Акции' });
    const additional = within(services).getByRole('navigation', {
      name: 'Дополнительные разделы',
    });

    expect(container.querySelector('.figma-home-shell')).toHaveClass('has-v3-my-extras');
    expect(history.compareDocumentPosition(services) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect([...services.children]).toEqual([promotion, locations, additional]);
    expect(within(additional).getAllByRole('link')).toHaveLength(3);
    expect(within(additional).getByRole('link', { name: 'Все акции' })).toHaveAttribute(
      'href',
      '/promotions',
    );
    expect(
      within(additional).getByRole('link', { name: 'Подарочные сертификаты' }),
    ).toHaveAttribute('href', '/gift-certificates');
    expect(within(additional).getByRole('link', { name: 'Предложения' })).toHaveAttribute(
      'href',
      '/offers',
    );

    fireEvent.click(screen.getByRole('tab', { name: 'Для меня' }));
    expect(screen.queryByRole('region', { name: 'Сервисы клуба' })).not.toBeInTheDocument();
  });

  it('expands a sparse initial recommendation slice once and does not reload on the active tab', async () => {
    const loadBookingRecommendations = vi.fn().mockResolvedValue({
      version: 'a'.repeat(64),
      generatedAt: '2026-07-18T09:00:00.000Z',
      staleAt: '2026-07-18T09:05:00.000Z',
      personalization: 'BASIC',
      items: [],
      nextCursor: null,
    });
    render(
      <HomeDashboardPage
        {...independentSectionProps}
        dashboard={homeBase}
        tenantName="ПадлХАБ"
        notificationUnreadCount={0}
        loadBookingRecommendations={loadBookingRecommendations}
        logoutBusy={false}
        onLogout={vi.fn()}
      />,
    );

    await vi.waitFor(() => expect(loadBookingRecommendations).toHaveBeenCalledTimes(2));
    expect(loadBookingRecommendations.mock.calls).toEqual([
      [{ limit: 6 }],
      [{ limit: 6, phase: 'EXPANDED' }],
    ]);
    fireEvent.click(screen.getByRole('tab', { name: 'Для меня' }));
    await vi.waitFor(() => expect(loadBookingRecommendations).toHaveBeenCalledTimes(2));
    await vi.waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('Пока нет подходящих событий'),
    );
    expect(screen.queryByText('Персональная подборка')).not.toBeInTheDocument();
    const allRecommendations = screen.getByRole('link', { name: 'Все рекомендации' });
    expect(allRecommendations).toHaveAttribute('href', '/bookings?view=for-me');
    expect(allRecommendations.parentElement).toHaveClass('fh-bookings-footer-action', 'is-split');
    expect(allRecommendations.nextElementSibling).toHaveTextContent('Настроить');
  });
});

describe('Home upcoming bookings', () => {
  it('keeps an unavailable booking source distinct from a confirmed empty list', () => {
    const onRetryUpcoming = vi.fn();
    render(
      <HomeDashboardPage
        {...independentSectionProps}
        dashboard={homeBase}
        upcoming={{
          state: 'UNAVAILABLE',
          message: 'Источник записей временно недоступен.',
        }}
        tenantName="ПадлХАБ"
        notificationUnreadCount={0}
        logoutBusy={false}
        onRetryUpcoming={onRetryUpcoming}
        onLogout={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('tab', { name: 'Мои записи' }));

    expect(screen.getByText('Мои записи временно недоступны')).toBeVisible();
    expect(screen.queryByText('Ближайших записей нет')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Повторить' }));
    expect(onRetryUpcoming).toHaveBeenCalledOnce();
  });

  it('labels a stale booking envelope without hiding its last valid value', () => {
    const staleItem: UserUpcomingBookings['items'][number] = {
      id: '55555555-5555-4555-8555-555555555555',
      kind: 'training',
      title: 'Последняя доступная тренировка',
      startsAt: '2026-07-20T08:30:00.000Z',
      venue: 'ПаделХАБ · центральный корт',
      status: 'confirmed',
      route: '/trainings/55555555-5555-4555-8555-555555555555',
    };
    render(
      <HomeDashboardPage
        {...independentSectionProps}
        dashboard={homeBase}
        upcoming={{ state: 'STALE', value: { ...defaultUpcoming, items: [staleItem] } }}
        tenantName="ПадлХАБ"
        notificationUnreadCount={0}
        logoutBusy={false}
        onLogout={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('tab', { name: 'Мои записи' }));

    expect(screen.getByText(/Показаны последние доступные записи/)).toBeVisible();
    expect(screen.getByRole('heading', { name: staleItem.title })).toBeVisible();
  });

  it('shows an honest empty state instead of placeholder cards', () => {
    const { container } = render(
      <HomeDashboardPage
        {...independentSectionProps}
        dashboard={homeBase}
        tenantName="ПадлХАБ"
        notificationUnreadCount={0}
        logoutBusy={false}
        onLogout={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('tab', { name: 'Мои записи' }));
    const bookings = screen.getByRole('region', { name: 'Мои записи' });
    expect(within(bookings).getByRole('status')).toHaveTextContent('Ближайших записей нет');
    expect(container.querySelectorAll('.fh-event')).toHaveLength(0);
    expect(screen.queryByText('Название игры')).not.toBeInTheDocument();
    expect(screen.queryByText('Ясенево · Паустовского, 4А')).not.toBeInTheDocument();
  });

  it('renders every card only from the server upcoming fields', () => {
    const upcoming: HomeDashboard['upcoming'] = [
      {
        id: '33333333-3333-4333-8333-333333333333',
        kind: 'training',
        title: 'Тренировка с Марией',
        startsAt: '2026-07-18T10:15:00.000Z',
        venue: 'Селигерская · корт 1',
        status: 'waitlist',
        route: '/trainings/33333333-3333-4333-8333-333333333333',
      },
      {
        id: '44444444-4444-4444-8444-444444444444',
        kind: 'tournament',
        title: 'Кубок выходного дня',
        startsAt: '2026-07-19T08:30:00.000Z',
        venue: 'ПаделХАБ · центральный корт',
        status: 'payment_required',
        route: '/tournaments/44444444-4444-4444-8444-444444444444',
      },
    ];
    const { container } = render(
      <HomeDashboardPage
        {...independentSectionProps}
        dashboard={homeBase}
        upcoming={readyUpcoming(upcoming)}
        tenantName="ПадлХАБ"
        notificationUnreadCount={0}
        logoutBusy={false}
        onLogout={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('tab', { name: 'Мои записи' }));
    const cards = container.querySelectorAll('.fh-event');
    expect(cards).toHaveLength(2);

    const trainingCard = screen.getByRole('article', { name: 'Тренировка с Марией' });
    expect(within(trainingCard).getByText('Тренировка · Лист ожидания')).toBeInTheDocument();
    expect(within(trainingCard).getByText('Селигерская')).toBeInTheDocument();
    expect(trainingCard.querySelector('time')).toHaveAttribute('datetime', upcoming[0]?.startsAt);
    const trainingStartsAt = new Date(upcoming[0]?.startsAt ?? '');
    const trainingWeekday = new Intl.DateTimeFormat('ru-RU', { weekday: 'short' }).format(
      trainingStartsAt,
    );
    expect(trainingCard.querySelector('time')).toHaveTextContent(
      `${new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long' }).format(trainingStartsAt)}, ${trainingWeekday.endsWith('.') ? trainingWeekday : `${trainingWeekday}.`}, с ${new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' }).format(trainingStartsAt)}`,
    );
    expect(within(trainingCard).getByRole('link', { name: 'Открыть' })).toHaveAttribute(
      'href',
      '/bookings',
    );

    const tournamentCard = screen.getByRole('article', { name: 'Кубок выходного дня' });
    expect(within(tournamentCard).getByText('Турнир · Нужна оплата')).toBeInTheDocument();
    expect(within(tournamentCard).getByText('ПаделХАБ')).toBeInTheDocument();
    expect(tournamentCard.querySelector('time')).toHaveAttribute('datetime', upcoming[1]?.startsAt);

    expect(container.querySelectorAll('.fh-event img')).toHaveLength(0);
    expect(container.querySelectorAll('.fh-event[href]')).toHaveLength(0);
    expect(screen.queryByText(/Рейтинговая игра|Френдли игра/)).not.toBeInTheDocument();
  });

  it('expands the Home bookings viewport to preview scrolling when more than two cards remain', () => {
    const upcoming: HomeDashboard['upcoming'] = Array.from({ length: 3 }, (_, index) => ({
      id: `${index + 1}3333333-3333-4333-8333-333333333333`,
      kind: 'game' as const,
      title: `Игра ${index + 1}`,
      startsAt: `2026-07-${18 + index}T10:15:00.000Z`,
      venue: 'Селигерская · корт 1',
      status: 'confirmed' as const,
      route: `/games/${index + 1}`,
    }));
    const { container } = render(
      <HomeDashboardPage
        {...independentSectionProps}
        dashboard={homeBase}
        upcoming={readyUpcoming(upcoming)}
        tenantName="ПадлХАБ"
        notificationUnreadCount={0}
        logoutBusy={false}
        onLogout={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('tab', { name: 'Мои записи' }));
    expect(container.querySelector('.figma-home-shell')).toHaveClass('has-bookings-scroll-peek');
    expect(container.querySelectorAll('.fh-bookings-list > .fh-booking-entry')).toHaveLength(3);
  });

  it('filters real upcoming bookings and swipes the calendar one day up to two weeks ahead', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-18T09:00:00.000Z'));
    const upcoming: HomeDashboard['upcoming'] = [
      {
        id: '33333333-3333-4333-8333-333333333333',
        kind: 'training',
        title: 'Субботняя тренировка',
        startsAt: '2026-07-18T10:15:00.000Z',
        venue: 'Селигерская · корт 1',
        status: 'confirmed',
        route: '/trainings/33333333-3333-4333-8333-333333333333',
      },
      {
        id: '44444444-4444-4444-8444-444444444444',
        kind: 'game',
        title: 'Воскресный турнир',
        startsAt: '2026-07-19T08:30:00.000Z',
        venue: 'ПаделХАБ · центральный корт',
        status: 'waitlist',
        route: '/tournaments/44444444-4444-4444-8444-444444444444',
      },
    ];
    render(
      <HomeDashboardPage
        {...independentSectionProps}
        dashboard={homeBase}
        upcoming={readyUpcoming(upcoming)}
        tenantName="ПадлХАБ"
        notificationUnreadCount={0}
        logoutBusy={false}
        onLogout={vi.fn()}
      />,
    );

    const myBookingsTab = screen.getByRole('tab', { name: 'Мои записи' });
    expect(myBookingsTab.querySelector('.fh-booking-presence-dot')).toBeInTheDocument();
    fireEvent.click(myBookingsTab);
    const filter = screen.getByLabelText('Фильтр записей по дате');
    const allDates = within(filter).getByRole('button', { name: 'Все даты' });
    expect(allDates).toHaveAttribute('aria-pressed', 'true');
    const saturday = within(filter).getByRole('button', { name: /суббота, 18 июля/i });
    expect(saturday.querySelector('.fh-booking-presence-dot')).toBeInTheDocument();

    fireEvent.click(saturday);
    expect(allDates).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('article', { name: 'Субботняя тренировка' })).toBeVisible();
    expect(screen.queryByRole('article', { name: 'Воскресный турнир' })).not.toBeInTheDocument();

    fireEvent.click(within(filter).getByRole('button', { name: /понедельник, 20 июля/i }));
    expect(screen.getByRole('status')).toHaveTextContent('По выбранным фильтрам записей нет');

    fireEvent.click(allDates);
    expect(allDates).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('article', { name: 'Субботняя тренировка' })).toBeVisible();
    expect(screen.getByRole('article', { name: 'Воскресный турнир' })).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'Игры' }));
    expect(screen.queryByRole('article', { name: 'Субботняя тренировка' })).not.toBeInTheDocument();
    expect(screen.getByRole('article', { name: 'Воскресный турнир' })).toBeVisible();

    const calendar = filter.querySelector('.fh-calendar');
    expect(calendar).not.toBeNull();
    fireEvent.pointerDown(calendar as HTMLDivElement, { clientX: 280 });
    fireEvent.pointerUp(calendar as HTMLDivElement, { clientX: 100 });
    expect(
      within(filter).queryByRole('button', { name: /суббота, 18 июля/i }),
    ).not.toBeInTheDocument();
    expect(within(filter).getByRole('button', { name: /суббота, 25 июля/i })).toBeVisible();

    fireEvent.pointerDown(calendar as HTMLDivElement, { clientX: 280 });
    fireEvent.pointerUp(calendar as HTMLDivElement, { clientX: 100 });
    expect(
      within(filter).queryByRole('button', { name: /воскресенье, 19 июля/i }),
    ).not.toBeInTheDocument();
    expect(within(filter).getByRole('button', { name: /воскресенье, 26 июля/i })).toBeVisible();

    for (let index = 0; index < 12; index += 1) {
      fireEvent.pointerDown(calendar as HTMLDivElement, { clientX: 280 });
      fireEvent.pointerUp(calendar as HTMLDivElement, { clientX: 100 });
    }
    expect(within(filter).getByRole('button', { name: /суббота, 1 августа/i })).toBeVisible();

    fireEvent.pointerDown(calendar as HTMLDivElement, { clientX: 280 });
    fireEvent.pointerUp(calendar as HTMLDivElement, { clientX: 100 });
    expect(within(filter).getByRole('button', { name: /суббота, 1 августа/i })).toBeVisible();

    fireEvent.pointerDown(calendar as HTMLDivElement, { clientX: 100 });
    fireEvent.pointerUp(calendar as HTMLDivElement, { clientX: 280 });
    expect(within(filter).getByRole('button', { name: /пятница, 31 июля/i })).toBeVisible();
  });

  it('renders only roster data supplied by the Home projection', () => {
    const upcoming: HomeDashboard['upcoming'] = [
      {
        id: '44444444-4444-4444-8444-444444444444',
        kind: 'game',
        title: 'Игра с составом',
        startsAt: '2026-07-19T08:30:00.000Z',
        venue: 'ПаделХАБ · центральный корт',
        status: 'confirmed',
        route: '/games/44444444-4444-4444-8444-444444444444',
        participants: [
          {
            profileId: 'b1dc7c9c-1aed-448d-987e-3235a839b505',
            displayName: 'Иван Петров',
            firstName: 'Иван',
            lastName: 'Петров',
            nickname: 'ivan_p',
            avatarUrl: null,
            level: 'D+',
            levelValue: 2.86793,
          },
          {
            profileId: 'c4e17ec7-a696-4355-a0b9-7e1a5644a3a6',
            displayName: 'Мария Орлова',
            firstName: 'Мария',
            lastName: 'Орлова',
            nickname: null,
            avatarUrl: null,
            level: 'C',
            levelValue: 3.43844,
          },
        ],
        openSlots: 2,
      },
      {
        id: '55555555-5555-4555-8555-555555555555',
        kind: 'training',
        title: 'Запись без состава',
        startsAt: '2026-07-20T08:30:00.000Z',
        venue: 'ПаделХАБ · центральный корт',
        status: 'confirmed',
        route: '/trainings/55555555-5555-4555-8555-555555555555',
      },
    ];
    const { container } = render(
      <HomeDashboardPage
        {...independentSectionProps}
        dashboard={homeBase}
        upcoming={readyUpcoming(upcoming)}
        tenantName="ПадлХАБ"
        notificationUnreadCount={0}
        logoutBusy={false}
        onLogout={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('tab', { name: 'Мои записи' }));
    const card = screen.getByRole('article', { name: 'Игра с составом' });
    expect(within(card).getByRole('link', { name: 'Открыть' })).toHaveAttribute(
      'href',
      '/games/44444444-4444-4444-8444-444444444444',
    );
    expect(within(card).getByLabelText('Участники записи')).toBeVisible();
    const participantAvatars = within(card).getAllByRole('img');
    expect(participantAvatars).toHaveLength(2);
    expect(participantAvatars[0]).toHaveAccessibleName(
      'Иван Петров · @ivan_p, уровень D+, прогресс 87%',
    );
    expect(participantAvatars[1]).toHaveAccessibleName('Мария Орлова, уровень C, прогресс 44%');
    expect(participantAvatars[0]).toHaveAttribute('data-progress', '87');
    expect(participantAvatars[1]).toHaveAttribute('data-progress', '44');
    expect(participantAvatars[0]).toHaveAttribute('data-size', '48');
    expect(participantAvatars[1]).toHaveAttribute('data-size', '48');
    expect(within(card).getByText('ИП')).toHaveAttribute('data-avatar-initials');
    expect(within(card).getByText('МО')).toHaveAttribute('data-avatar-initials');
    expect(within(card).queryByText('Мария Орлова')).not.toBeInTheDocument();
    expect(within(card).queryByRole('link', { name: /Иван Петров/ })).not.toBeInTheDocument();
    expect(within(card).getAllByLabelText('Свободное место')).toHaveLength(2);
    expect(container.querySelectorAll('.fh-event.has-participants')).toHaveLength(1);
  });
});
