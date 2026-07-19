// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { HomeDashboard } from './auth-gateway.js';
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
        dashboard={dashboard}
        tenantName="ПадлХАБ"
        notificationUnreadCount={0}
        loadCommunityPage={() => Promise.resolve({ items: [] })}
        logoutBusy={false}
        onLogout={vi.fn()}
      />,
    );

    const first = screen.getByRole('link', { name: 'Первая акция' });
    expect(first).toHaveAttribute('href', '/promotions/first');
    expect(first.querySelector('source')).toHaveAttribute(
      'srcset',
      'https://media.padlhub.test/mobile-first.webp',
    );

    act(() => {
      vi.advanceTimersByTime(6_000);
    });

    const second = screen.getByRole('link', { name: 'Вторая акция' });
    expect(second).toHaveAttribute('href', 'https://padlhub.ru/promo/second');
    expect(second.querySelector('source')).toHaveAttribute(
      'srcset',
      'https://media.padlhub.test/mobile-second.webp',
    );
    expect(screen.getByRole('button', { name: 'Показать акцию «Вторая акция»' })).toHaveAttribute(
      'aria-current',
      'true',
    );
  });
});

describe('Home progressive navigation', () => {
  it('places additional sections after locations and routes certificates to the sale page', () => {
    render(
      <HomeDashboardPage
        dashboard={{
          ...dashboard,
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
        loadCommunityPage={() => Promise.resolve({ items: [] })}
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

  it('keeps the quick-action block and the bookings/recommendations tabs visible', () => {
    render(
      <HomeDashboardPage
        dashboard={dashboard}
        tenantName="ПадлХАБ"
        notificationUnreadCount={0}
        loadCommunityPage={() => Promise.resolve({ items: [] })}
        logoutBusy={false}
        onLogout={vi.fn()}
      />,
    );

    const actions = screen.getByRole('navigation', { name: 'Разделы клуба' });
    expect(within(actions).getByRole('link', { name: 'Игры' })).toHaveAttribute('href', '/games');
    expect(within(actions).getByRole('link', { name: 'Турниры' })).toHaveAttribute(
      'href',
      '/tournaments',
    );
    expect(within(actions).getByRole('link', { name: 'Тренировки' })).toHaveAttribute(
      'href',
      '/trainings',
    );
    expect(screen.getByRole('tab', { name: 'Мои записи' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByRole('tab', { name: 'Для меня' })).toHaveAttribute('aria-selected', 'false');
  });

  it('loads recommendations only after the user opens the For me tab', async () => {
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
        dashboard={dashboard}
        tenantName="ПадлХАБ"
        notificationUnreadCount={0}
        loadCommunityPage={() => Promise.resolve({ items: [] })}
        loadBookingRecommendations={loadBookingRecommendations}
        logoutBusy={false}
        onLogout={vi.fn()}
      />,
    );

    expect(loadBookingRecommendations).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('tab', { name: 'Для меня' }));
    await vi.waitFor(() => expect(loadBookingRecommendations).toHaveBeenCalledOnce());
    await vi.waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('Пока нет подходящих игр'),
    );
  });
});

describe('Home upcoming bookings', () => {
  it('shows an honest empty state instead of placeholder cards', () => {
    const { container } = render(
      <HomeDashboardPage
        dashboard={dashboard}
        tenantName="ПадлХАБ"
        notificationUnreadCount={0}
        loadCommunityPage={() => Promise.resolve({ items: [] })}
        logoutBusy={false}
        onLogout={vi.fn()}
      />,
    );

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
        dashboard={{ ...dashboard, upcoming }}
        tenantName="ПадлХАБ"
        notificationUnreadCount={0}
        loadCommunityPage={() => Promise.resolve({ items: [] })}
        logoutBusy={false}
        onLogout={vi.fn()}
      />,
    );

    const cards = container.querySelectorAll('.fh-event');
    expect(cards).toHaveLength(2);

    const trainingCard = screen.getByRole('article', { name: 'Тренировка с Марией' });
    expect(within(trainingCard).getByText('Тренировка · Лист ожидания')).toBeInTheDocument();
    expect(within(trainingCard).getByText('Селигерская · корт 1')).toBeInTheDocument();
    expect(trainingCard.querySelector('time')).toHaveAttribute('datetime', upcoming[0]?.startsAt);
    expect(
      within(trainingCard).getByText(
        new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' }).format(
          new Date(upcoming[0]?.startsAt ?? ''),
        ),
      ),
    ).toBeInTheDocument();

    const tournamentCard = screen.getByRole('article', { name: 'Кубок выходного дня' });
    expect(within(tournamentCard).getByText('Турнир · Нужна оплата')).toBeInTheDocument();
    expect(within(tournamentCard).getByText('ПаделХАБ · центральный корт')).toBeInTheDocument();
    expect(tournamentCard.querySelector('time')).toHaveAttribute('datetime', upcoming[1]?.startsAt);

    expect(container.querySelectorAll('.fh-event img')).toHaveLength(0);
    expect(container.querySelectorAll('.fh-event[href]')).toHaveLength(0);
    expect(screen.queryByText(/Рейтинговая игра|Френдли игра/)).not.toBeInTheDocument();
  });

  it('filters real upcoming bookings by date and type, and swipes through the next two weeks', () => {
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
        dashboard={{ ...dashboard, upcoming }}
        tenantName="ПадлХАБ"
        notificationUnreadCount={0}
        loadCommunityPage={() => Promise.resolve({ items: [] })}
        logoutBusy={false}
        onLogout={vi.fn()}
      />,
    );

    const filter = screen.getByLabelText('Фильтр записей по дате');
    const saturday = within(filter).getByRole('button', { name: /суббота, 18 июля/i });
    expect(saturday.querySelector('i')).toBeInTheDocument();

    fireEvent.click(saturday);
    expect(screen.getByRole('article', { name: 'Субботняя тренировка' })).toBeVisible();
    expect(screen.queryByRole('article', { name: 'Воскресный турнир' })).not.toBeInTheDocument();

    fireEvent.click(within(filter).getByRole('button', { name: /понедельник, 20 июля/i }));
    expect(screen.getByRole('status')).toHaveTextContent('По выбранным фильтрам записей нет');

    fireEvent.click(within(filter).getByRole('button', { name: /понедельник, 20 июля/i }));
    expect(screen.getByRole('article', { name: 'Субботняя тренировка' })).toBeVisible();
    expect(screen.getByRole('article', { name: 'Воскресный турнир' })).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'Игры' }));
    expect(screen.queryByRole('article', { name: 'Субботняя тренировка' })).not.toBeInTheDocument();
    expect(screen.getByRole('article', { name: 'Воскресный турнир' })).toBeVisible();

    const calendar = filter.querySelector('.fh-calendar');
    expect(calendar).not.toBeNull();
    fireEvent.pointerDown(calendar as HTMLDivElement, { clientX: 280 });
    fireEvent.pointerUp(calendar as HTMLDivElement, { clientX: 100 });
    expect(within(filter).getByRole('button', { name: /суббота, 25 июля/i })).toBeVisible();

    fireEvent.pointerDown(calendar as HTMLDivElement, { clientX: 280 });
    fireEvent.pointerUp(calendar as HTMLDivElement, { clientX: 100 });
    expect(within(filter).getByRole('button', { name: /суббота, 1 августа/i })).toBeVisible();

    fireEvent.pointerDown(calendar as HTMLDivElement, { clientX: 100 });
    fireEvent.pointerUp(calendar as HTMLDivElement, { clientX: 280 });
    expect(within(filter).getByRole('button', { name: /суббота, 25 июля/i })).toBeVisible();
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
          },
          {
            profileId: 'c4e17ec7-a696-4355-a0b9-7e1a5644a3a6',
            displayName: 'Мария Орлова',
            firstName: 'Мария',
            lastName: 'Орлова',
            nickname: null,
            avatarUrl: null,
            level: 'C',
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
        dashboard={{ ...dashboard, upcoming }}
        tenantName="ПадлХАБ"
        notificationUnreadCount={0}
        loadCommunityPage={() => Promise.resolve({ items: [] })}
        logoutBusy={false}
        onLogout={vi.fn()}
      />,
    );

    const card = screen.getByRole('article', { name: 'Игра с составом' });
    expect(within(card).getByLabelText('Участники записи')).toBeVisible();
    expect(within(card).getAllByRole('img')).toHaveLength(2);
    expect(within(card).queryByText('Мария Орлова')).not.toBeInTheDocument();
    expect(within(card).queryByRole('link', { name: /Иван Петров/ })).not.toBeInTheDocument();
    expect(within(card).getAllByLabelText('Свободное место')).toHaveLength(2);
    expect(container.querySelectorAll('.fh-event.has-participants')).toHaveLength(1);
  });
});
