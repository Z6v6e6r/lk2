// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { act, render, screen } from '@testing-library/react';
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
