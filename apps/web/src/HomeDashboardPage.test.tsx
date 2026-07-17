// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { act, cleanup, render, screen, within } from '@testing-library/react';
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
});
