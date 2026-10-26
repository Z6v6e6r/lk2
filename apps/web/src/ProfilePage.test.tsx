// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import type { PlayerProfileView } from '@phub/api-sdk';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ProfilePage } from './ProfilePage.js';
import friendshipArtwork from './assets/subscriptions/friendship-badge.png';
import raArtwork from './assets/subscriptions/ra-badge.png';
import academyArtwork from './assets/subscriptions/academy-badge.png';

beforeEach(() => {
  const values = new Map<string, string>();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
      clear: () => values.clear(),
    },
  });
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  Reflect.deleteProperty(window.navigator, 'share');
  Reflect.deleteProperty(window.navigator, 'clipboard');
});

function selfProfile(level: string): PlayerProfileView {
  return {
    profile: {
      userId: '14f15c0a-b6b6-4701-86a6-0c789c81a815',
      displayName: 'Алексей Максимов',
      avatarUrl: null,
      level: { label: level, value: 3.64, assessmentRequired: false },
    },
    privateAccount: { phoneLast4: '5826', balanceMinor: 54000, currency: 'RUB' },
    reachable: true,
    access: {
      audience: 'SELF',
      tier: 'SELF',
      visibleSections: ['BASIC', 'PLAYER_LEVEL', 'PLAYER_RATING', 'PRIVATE_ACCOUNT'],
      contact: { status: 'HIDDEN', reason: 'SELF_PROFILE' },
      chat: { status: 'HIDDEN', reason: 'SELF_PROFILE' },
    },
  };
}

describe('ProfilePage', () => {
  it.each([
    ['Дружба', friendshipArtwork],
    ['РА', raArtwork],
    ['Академия', academyArtwork],
  ])('uses the supplied %s badge while preserving subscription details', (title, artwork) => {
    render(
      <ProfilePage
        profile={selfProfile('D+')}
        logoutBusy={false}
        communities={{ items: [] }}
        subscriptions={[
          {
            id: '11111111-1111-4111-8111-111111111111',
            title,
            status: 'active',
            remainingUnits: 8,
            validUntil: null,
            route: '/subscriptions/11111111-1111-4111-8111-111111111111',
          },
        ]}
        onLogout={() => undefined}
      />,
    );
    const card = screen.getByRole('region', { name: 'Подписки и абонементы' });
    expect(within(card).getByRole('img', { name: title })).toHaveAttribute('src', artwork);
    expect(within(card).getByText(/Остаток: 8 · единица не указана/)).toBeVisible();
    expect(within(card).getByText('активна')).toBeVisible();
    expect(within(card).getByRole('link', { name: `Открыть подписку: ${title}` })).toHaveAttribute(
      'href',
      '/subscriptions/11111111-1111-4111-8111-111111111111',
    );
  });

  it.each(['Индивидуальный абонемент', 'Дружба Плюс'])(
    'keeps the original fallback for an unidentified plan: %s',
    (title) => {
      render(
        <ProfilePage
          profile={selfProfile('D+')}
          logoutBusy={false}
          communities={{ items: [] }}
          subscriptions={[
            {
              id: '11111111-1111-4111-8111-111111111111',
              title,
              status: 'active',
              remainingUnits: 8,
              validUntil: null,
              route: '/subscriptions/11111111-1111-4111-8111-111111111111',
            },
          ]}
          onLogout={() => undefined}
        />,
      );
      const card = screen.getByRole('region', { name: 'Подписки и абонементы' });
      expect(within(card).queryByRole('img')).not.toBeInTheDocument();
      expect(within(card).getByText(title)).toBeVisible();
      expect(within(card).getByText(/Остаток: 8 · единица не указана/)).toBeVisible();
    },
  );

  it('does not infer visits, exhaustion or expiry from an unknown profile subscription remainder', () => {
    render(
      <ProfilePage
        profile={selfProfile('C+')}
        logoutBusy={false}
        onLogout={() => undefined}
        subscriptions={[
          {
            id: '11111111-1111-4111-8111-111111111111',
            title: 'Дружба',
            status: 'active',
            remainingUnits: 0,
            validUntil: null,
            route: '/subscriptions/11111111-1111-4111-8111-111111111111',
          },
        ]}
      />,
    );
    expect(screen.getByText('Остаток не подтверждён · срок не указан')).toBeVisible();
    expect(screen.queryByText(/закончились|посещений/)).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Мои абонементы' })).toHaveAttribute(
      'href',
      '/subscriptions',
    );
    expect(screen.getByText('Неполная подборка с Главной: до 6 абонементов.')).toBeVisible();
  });

  it('opens recommendation preferences from the Home deep link', () => {
    window.history.replaceState({}, '', '/profile#booking-preferences-title');

    render(
      <ProfilePage
        profile={selfProfile('D+')}
        bookingPreferences={{
          favoriteStationIds: [],
          preferredTimeWindows: [],
          useHistory: true,
          recommendFriends: true,
          recommendationDisplay: 'CARDS',
          version: 0,
          updatedAt: '2026-08-01T00:00:00.000Z',
        }}
        stationChoices={[]}
        logoutBusy={false}
        communities={{ items: [] }}
        onLogout={() => undefined}
      />,
    );

    expect(screen.getByRole('dialog', { name: 'Предпочтения' })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Когда и где мне удобно' })).toBeVisible();
  });

  it('shows Back and keeps notifications and support in the v2 settings menu', () => {
    const historyBack = vi.spyOn(window.history, 'back').mockImplementation(() => undefined);

    render(
      <ProfilePage
        profile={selfProfile('D+')}
        logoutBusy={false}
        notificationUnreadCount={1}
        communities={{ items: [] }}
        onLogout={() => undefined}
      />,
    );

    const backButton = screen.getByRole('button', { name: 'Назад' });
    const toolbar = backButton.closest('header');

    expect(toolbar).toHaveClass('profile-toolbar');
    expect(toolbar?.firstElementChild).toBe(backButton);
    expect(toolbar?.lastElementChild).toHaveClass('profile-v2-toolbar-actions');
    expect(within(toolbar!).getByRole('button', { name: 'поделиться' })).toBeVisible();
    fireEvent.click(screen.getByLabelText('Настройки профиля'));
    const notificationsLink = toolbar?.querySelector(
      'a[aria-label="Уведомления, непрочитанных: 1"]',
    );
    expect(notificationsLink?.nextElementSibling).toBe(
      screen.getByRole('link', { name: 'Техническая поддержка' }),
    );
    expect(screen.getByRole('link', { name: 'Техническая поддержка' })).toHaveAttribute(
      'href',
      '/support',
    );
    const heading = screen.getByRole('heading', { name: 'Алексей Максимов' });
    expect(heading.closest('header')).toBeNull();
    const identity = heading.closest('section');
    expect(identity).toHaveClass('profile-identity');
    const avatar = within(identity!).getByRole('img', {
      name: 'Алексей Максимов, уровень D+, прогресс 64%',
    });
    expect(avatar.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(
      within(screen.getByLabelText('Данные профиля')).queryByText('уровень'),
    ).not.toBeInTheDocument();
    expect(screen.queryByText('PadelHub Player')).not.toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'редактировать профиль' }).querySelector('svg'),
    ).toBeInTheDocument();
    expect(backButton).toHaveClass('profile-toolbar__back');
    expect(notificationsLink).toHaveAttribute('href', '/notifications');
    expect(notificationsLink).toHaveClass('is-unread');
    expect(within(notificationsLink as HTMLElement).getByText('1')).toBeVisible();
    expect(screen.getByRole('link', { name: /^История изменения уровня/ })).toHaveAttribute(
      'href',
      '/profile/level-history',
    );

    backButton.click();
    expect(historyBack).toHaveBeenCalledOnce();
  });

  it('shares the self profile directly from the toolbar without opening settings', async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window.navigator, 'share', { configurable: true, value: share });
    const profile = selfProfile('D+');
    render(<ProfilePage profile={profile} logoutBusy={false} onLogout={() => undefined} />);

    fireEvent.click(screen.getByRole('button', { name: 'поделиться' }));

    expect(share).toHaveBeenCalledExactlyOnceWith({
      title: profile.profile.displayName,
      url: new URL(`/profile/${profile.profile.userId}`, window.location.origin).toString(),
    });
    expect(await screen.findByText('Профиль отправлен')).toBeVisible();
  });

  it.each([
    ['A', 'level-a.jpg'],
    ['B+', 'level-b-plus.jpg'],
    ['B', 'level-b.jpg'],
    ['C+', 'level-c-plus.jpg'],
    ['C', 'level-c.jpg'],
    ['D+', 'level-d-plus.jpg'],
    ['D', 'level-d.jpg'],
  ])('uses the supplied %s level artwork', (level, filename) => {
    render(
      <ProfilePage
        profile={selfProfile(level)}
        logoutBusy={false}
        communities={{ items: [] }}
        onLogout={() => undefined}
      />,
    );

    expect(screen.getByRole('main').getAttribute('style')).toContain(filename);
    expect(screen.getByRole('main')).toHaveAttribute('data-profile-level-theme', level);
    expect(
      screen.getByRole('img', {
        name: `Алексей Максимов, уровень ${level}, прогресс 64%`,
      }),
    ).toBeVisible();
  });

  it.each([
    ['A', true],
    ['unsupported', false],
  ])(
    'keeps the level theme neutral for %s with assessmentRequired=%s',
    (label, assessmentRequired) => {
      const view = selfProfile(label);
      render(
        <ProfilePage
          profile={{
            ...view,
            profile: { ...view.profile, level: { label, value: 3.64, assessmentRequired } },
          }}
          logoutBusy={false}
          onLogout={() => undefined}
        />,
      );
      expect(screen.getByRole('main')).toHaveAttribute('data-profile-level-theme', 'unrated');
    },
  );

  it('keeps unavailable v2 statistics and sections explicit without invented data', () => {
    render(
      <ProfilePage profile={selfProfile('D+')} logoutBusy={false} onLogout={() => undefined} />,
    );
    const metrics = screen.getByRole('region', { name: 'Показатели игрока' });
    expect(within(metrics).getAllByText('—')).toHaveLength(4);
    expect(metrics.children).toHaveLength(4);
    expect(
      within(metrics).getByRole('button', { name: 'Открыть друзей: число неизвестно' }),
    ).toBeVisible();
    expect(
      within(metrics).getByRole('button', { name: 'Открыть мои сообщества: число неизвестно' }),
    ).toBeVisible();
    expect(within(metrics).queryByText('уровень')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('navigation', { name: 'Быстрые переходы профиля' }),
    ).not.toBeInTheDocument();
    expect(within(metrics).getByRole('link', { name: /Турниры/ })).toHaveAttribute(
      'href',
      '/bookings?scope=history&kind=TOURNAMENT',
    );
    expect(within(metrics).getByRole('link', { name: /Мои игры/ })).toHaveAttribute(
      'href',
      '/bookings',
    );
    expect(screen.getByRole('button', { name: 'О себе — пока недоступно' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Достижения — пока недоступно' })).toBeDisabled();
    expect(screen.getByRole('link', { name: 'Мои абонементы' })).toHaveAttribute(
      'href',
      '/subscriptions',
    );
  });

  it('opens a v2 directory from the unified metrics row and restores focus after Escape', () => {
    render(
      <ProfilePage
        profile={selfProfile('D+')}
        friends={{ items: [] }}
        logoutBusy={false}
        onLogout={() => undefined}
      />,
    );
    const trigger = screen.getByRole('button', { name: /^Открыть друзей/ });
    trigger.focus();
    fireEvent.click(trigger);
    const sheet = screen.getByRole('dialog', { name: 'Друзья' });
    const close = within(sheet).getByRole('button', { name: 'Закрыть: Друзья' });
    expect(close).toHaveFocus();
    expect(
      within(sheet).getByText('Добавляйте игроков из их профилей — они появятся здесь.'),
    ).toBeVisible();
    fireEvent.keyDown(close, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Друзья' })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('respects unavailable friends and notifications in the v2 client', () => {
    render(
      <ProfilePage
        profile={selfProfile('D+')}
        friendsAvailable={false}
        notificationsAvailable={false}
        logoutBusy={false}
        onLogout={() => undefined}
      />,
    );
    expect(screen.getByRole('button', { name: /^Открыть друзей/ })).toBeDisabled();
    fireEvent.click(screen.getByLabelText('Настройки профиля'));
    expect(screen.queryByRole('link', { name: /Уведомления/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'QR-код' })).toBeVisible();
  });

  it('shows balance below the identity with top-up availability and information', () => {
    render(
      <ProfilePage profile={selfProfile('D+')} logoutBusy={false} onLogout={() => undefined} />,
    );
    const card = screen.getByRole('region', { name: 'Баланс' });
    const identity = screen.getByRole('heading', { name: 'Алексей Максимов' }).closest('section');
    expect(within(identity!).queryByText(/540/)).not.toBeInTheDocument();
    expect(within(card).getByText(/540/)).toBeVisible();
    expect(identity!.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(
      within(card).getByRole('button', { name: 'Пополнить баланс — пока недоступно' }),
    ).toBeDisabled();
    const information = within(card).getByRole('button', { name: 'Информация о балансе' });
    expect(information).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(information);
    expect(information).toHaveAttribute('aria-expanded', 'true');
    expect(within(card).getByText('Текущий баланс вашего счёта в ПадлхАБ.')).toBeVisible();
    fireEvent.click(information);
    expect(within(card).getByText('Текущий баланс вашего счёта в ПадлхАБ.')).not.toBeVisible();
  });

  it('renders a placeholder for a balance the local read did not observe', () => {
    const profile = selfProfile('D+');
    render(
      <ProfilePage
        profile={{ ...profile, privateAccount: { phoneLast4: '5826' } }}
        logoutBusy={false}
        communities={{ items: [] }}
        onLogout={() => undefined}
      />,
    );

    const stats = screen.getByLabelText('Данные профиля');
    expect(within(stats).getByText('—')).toBeVisible();
    expect(within(stats).queryByText(/0\s*₽/)).not.toBeInTheDocument();
  });

  it('renders a placeholder instead of claiming level D when no assessment exists', () => {
    const profile = selfProfile('D+');
    render(
      <ProfilePage
        profile={{
          ...profile,
          profile: {
            userId: profile.profile.userId,
            displayName: profile.profile.displayName,
            avatarUrl: null,
          },
        }}
        logoutBusy={false}
        communities={{ items: [] }}
        onLogout={() => undefined}
      />,
    );

    expect(
      screen.getByRole('img', { name: 'Алексей Максимов, уровень —, прогресс 0%' }),
    ).toBeVisible();
    expect(screen.getByRole('main')).toHaveAttribute('data-profile-level-theme', 'unrated');
    const stats = screen.getByLabelText('Данные профиля');
    expect(within(stats).queryByText('уровень')).not.toBeInTheDocument();
    expect(within(stats).queryByText('D')).not.toBeInTheDocument();
  });

  it('offers three active sports and prevents selecting unavailable sports', () => {
    render(
      <ProfilePage profile={selfProfile('D+')} logoutBusy={false} onLogout={() => undefined} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Вид спорта: Падел' }));
    const picker = screen.getByRole('dialog', { name: 'Выберите вид спорта' });
    for (const title of ['Падел', 'Сквош', 'Теннис']) {
      expect(within(picker).getByRole('button', { name: title })).toBeEnabled();
    }
    for (const title of ['Бокс', 'Баскетбол', 'Бег']) {
      const option = within(picker).getByRole('button', { name: `${title} — пока недоступен` });
      expect(option).toBeDisabled();
      fireEvent.click(option);
      expect(screen.getByRole('dialog', { name: 'Выберите вид спорта' })).toBeVisible();
      expect(screen.getByRole('button', { name: 'Вид спорта: Падел' })).toBeVisible();
    }
    expect(within(picker).queryByRole('button', { name: 'Бадминтон' })).not.toBeInTheDocument();
    fireEvent.click(within(picker).getByRole('button', { name: 'Теннис' }));
    expect(screen.queryByRole('dialog', { name: 'Выберите вид спорта' })).not.toBeInTheDocument();
    expect(screen.getByRole('main')).toHaveAttribute('data-profile-level-theme', 'unrated');
    fireEvent.click(screen.getByRole('button', { name: 'Вид спорта: Теннис' }));
    fireEvent.click(
      within(screen.getByRole('dialog', { name: 'Выберите вид спорта' })).getByRole('button', {
        name: 'Падел',
      }),
    );
    expect(
      screen.getByRole('img', { name: 'Алексей Максимов, уровень D+, прогресс 64%' }),
    ).toBeVisible();
  });

  it('keeps keyboard focus in the sport picker and restores it after Escape', () => {
    render(
      <ProfilePage profile={selfProfile('D+')} logoutBusy={false} onLogout={() => undefined} />,
    );
    const trigger = screen.getByRole('button', { name: 'Вид спорта: Падел' });
    trigger.focus();
    fireEvent.click(trigger);
    const picker = screen.getByRole('dialog', { name: 'Выберите вид спорта' });
    const close = within(picker).getByRole('button', { name: 'Закрыть выбор спорта' });
    const tennis = within(picker).getByRole('button', { name: 'Теннис' });
    expect(close).toHaveFocus();
    fireEvent.keyDown(close, { key: 'Tab', shiftKey: true });
    expect(tennis).toHaveFocus();
    fireEvent.keyDown(tennis, { key: 'Tab' });
    expect(close).toHaveFocus();
    fireEvent.keyDown(close, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Выберите вид спорта' })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('switches to an isolated squash profile without showing padel memberships or communities', () => {
    render(
      <ProfilePage
        profile={selfProfile('D+')}
        logoutBusy={false}
        communities={{ items: [] }}
        subscriptions={[]}
        onLogout={() => undefined}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Вид спорта: Падел' }));

    const picker = screen.getByRole('dialog', { name: 'Выберите вид спорта' });
    fireEvent.click(within(picker).getByRole('button', { name: 'Сквош' }));

    expect(screen.queryByText('SquashHub Player')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Вид спорта: Сквош' })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Отдельный спортивный профиль' })).toBeVisible();
    expect(screen.getByRole('main').getAttribute('style')).toContain('squash-level-a.webp');
    expect(screen.queryByRole('region', { name: 'Подписки и абонементы' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Сообщества' })).not.toBeInTheDocument();
  });

  it('switches to an isolated tennis profile without reusing padel data', () => {
    render(
      <ProfilePage
        profile={selfProfile('D+')}
        logoutBusy={false}
        communities={{ items: [] }}
        subscriptions={[]}
        onLogout={() => undefined}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Вид спорта: Падел' }));

    const picker = screen.getByRole('dialog', { name: 'Выберите вид спорта' });
    fireEvent.click(within(picker).getByRole('button', { name: 'Теннис' }));

    expect(screen.queryByText('TennisHub Player')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Вид спорта: Теннис' })).toBeVisible();
    expect(screen.getByText('рекомендации по теннису', { exact: false })).toBeVisible();
    expect(screen.queryByRole('region', { name: 'Подписки и абонементы' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Сообщества' })).not.toBeInTheDocument();
  });

  it('renders friends as links to PadlHub player profiles', () => {
    render(
      <ProfilePage
        profile={selfProfile('D+')}
        logoutBusy={false}
        communities={{ items: [] }}
        friends={{
          items: [
            {
              userId: '6a81e965-c508-4321-812c-4be323606a70',
              displayName: 'Мария Соколова',
              avatarUrl: null,
              levelLabel: 'C',
              addedAt: '2026-07-26T10:00:00.000Z',
              route: '/profile/6a81e965-c508-4321-812c-4be323606a70',
            },
          ],
        }}
        onLogout={() => undefined}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /^Открыть друзей/ }));
    expect(
      within(screen.getByRole('region', { name: 'Друзья' })).getByRole('heading', {
        name: 'Друзья',
      }),
    ).toBeVisible();
    expect(screen.queryByText('ПадлхАБ')).not.toBeInTheDocument();
    expect(screen.queryByText('•••• 5826')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Мария Соколова · C' })).toHaveAttribute(
      'href',
      '/profile/6a81e965-c508-4321-812c-4be323606a70',
    );
    expect(screen.getByText('Мария')).toBeVisible();
    expect(screen.getByText('Соколова')).toBeVisible();
  });

  it('keeps every friend in the swipeable row instead of truncating it at four', () => {
    const items = Array.from({ length: 6 }, (_, index) => ({
      userId: `6a81e965-c508-4321-812c-4be323606a7${index}`,
      displayName: `Друг ${index + 1}`,
      avatarUrl: null,
      levelLabel: 'C',
      addedAt: '2026-07-26T10:00:00.000Z',
      route: `/profile/6a81e965-c508-4321-812c-4be323606a7${index}`,
    }));

    render(
      <ProfilePage
        profile={selfProfile('D+')}
        logoutBusy={false}
        communities={{ items: [] }}
        friends={{ items }}
        onLogout={() => undefined}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /^Открыть друзей/ }));
    for (const friend of items) {
      expect(screen.getByRole('link', { name: `${friend.displayName} · C` })).toHaveAttribute(
        'href',
        friend.route,
      );
    }
  });

  it('shows the authenticated player position on a community card', () => {
    render(
      <ProfilePage
        profile={selfProfile('D+')}
        logoutBusy={false}
        communities={{
          items: [
            {
              id: '11111111-1111-4111-8111-111111111111',
              title: 'хАБ Нагатинская',
              logoUrl: null,
              isVerified: true,
              unreadChatCount: 0,
              memberRank: 12,
              route: '/communities/11111111-1111-4111-8111-111111111111',
            },
          ],
        }}
        onLogout={() => undefined}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /^Открыть мои сообщества/ }));
    expect(screen.getByRole('link', { name: 'хАБ Нагатинская, 12 место' })).toHaveAttribute(
      'href',
      '/communities/11111111-1111-4111-8111-111111111111',
    );
    expect(screen.getByText('12 место')).toBeVisible();
  });

  it('omits the place when the ranking source published none for the community', () => {
    render(
      <ProfilePage
        profile={selfProfile('D+')}
        logoutBusy={false}
        communities={{
          items: [
            {
              id: '11111111-1111-4111-8111-111111111111',
              title: 'хАБ Терехово',
              logoUrl: null,
              isVerified: true,
              unreadChatCount: 0,
              route: '/communities/11111111-1111-4111-8111-111111111111',
            },
          ],
        }}
        onLogout={() => undefined}
      />,
    );

    // The preview never triggers a per-community ranking read, so absence is "unknown", not a place.
    fireEvent.click(screen.getByRole('button', { name: /^Открыть мои сообщества/ }));
    expect(screen.getByRole('link', { name: 'хАБ Терехово' })).toBeVisible();
    expect(screen.queryByText('вне рейтинга')).not.toBeInTheDocument();
  });

  const otherProfile: PlayerProfileView = {
    profile: {
      userId: '6a81e965-c508-4321-812c-4be323606a70',
      displayName: 'Мария Соколова',
      avatarUrl: null,
      level: { label: 'C', assessmentRequired: false },
    },
    reachable: true,
    access: {
      audience: 'OTHER',
      tier: 'INTERACTION',
      visibleSections: ['BASIC', 'PLAYER_LEVEL'],
      contact: { status: 'LOCKED', reason: 'FEATURE_UNAVAILABLE' },
      chat: { status: 'LOCKED', reason: 'FEATURE_UNAVAILABLE' },
    },
  };

  it('offers removal only for an existing friendship and keeps pending/error state visible', () => {
    const onRemoveFriend = vi.fn();
    const props = {
      profile: otherProfile,
      friendship: {
        userId: otherProfile.profile.userId,
        status: 'FRIEND' as const,
        createdAt: '2026-09-17T10:00:00.000Z',
        requestId: null,
      },
      onRemoveFriend,
      logoutBusy: false,
      onLogout: () => undefined,
    };
    const { rerender } = render(<ProfilePage {...props} />);
    expect(screen.queryByText('Приватность и доступ')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Удалить из друзей' }));
    expect(onRemoveFriend).toHaveBeenCalledOnce();
    rerender(<ProfilePage {...props} friendsBusy />);
    expect(screen.getByRole('button', { name: 'Удалить из друзей' })).toBeDisabled();
    expect(screen.getByText('Удаляем…')).toBeVisible();
    rerender(<ProfilePage {...props} friendsError="Не удалось удалить игрока" />);
    expect(screen.getByRole('alert')).toHaveTextContent('Не удалось удалить игрока');
    expect(screen.getByText('Уже в друзьях')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Удалить из друзей' })).toBeEnabled();
  });

  it('shows a pending outgoing request without offering a duplicate command', () => {
    render(
      <ProfilePage
        profile={otherProfile}
        friendship={{
          userId: otherProfile.profile.userId,
          status: 'PENDING_OUTGOING',
          createdAt: '2026-08-29T10:00:00.000Z',
          requestId: '18f7c9a6-8a1b-4c27-9d0e-3e34bb4c2b91',
        }}
        onAddFriend={() => undefined}
        logoutBusy={false}
        onLogout={() => undefined}
      />,
    );

    expect(screen.getByText('Заявка отправлена')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Ожидает ответа' })).toBeDisabled();
  });

  it('lets the addressed player accept an incoming request from the profile', () => {
    const onAcceptFriendRequest = vi.fn();
    render(
      <ProfilePage
        profile={otherProfile}
        friendship={{
          userId: otherProfile.profile.userId,
          status: 'PENDING_INCOMING',
          createdAt: '2026-08-29T10:00:00.000Z',
          requestId: '18f7c9a6-8a1b-4c27-9d0e-3e34bb4c2b91',
        }}
        onAcceptFriendRequest={onAcceptFriendRequest}
        logoutBusy={false}
        onLogout={() => undefined}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Принять заявку' }));
    expect(onAcceptFriendRequest).toHaveBeenCalledWith('18f7c9a6-8a1b-4c27-9d0e-3e34bb4c2b91');
  });

  it('shows incoming friend requests inside the friends block with answer buttons', () => {
    const onAcceptRequest = vi.fn();
    const onDeclineRequest = vi.fn();
    render(
      <ProfilePage
        profile={selfProfile('D+')}
        friends={{
          items: [
            {
              userId: '6a81e965-c508-4321-812c-4be323606a70',
              displayName: 'Мария Соколова',
              avatarUrl: null,
              levelLabel: 'C',
              addedAt: '2026-07-26T10:00:00.000Z',
              route: '/profile/6a81e965-c508-4321-812c-4be323606a70',
            },
          ],
        }}
        friendRequests={[
          {
            requestId: '18f7c9a6-8a1b-4c27-9d0e-3e34bb4c2b91',
            userId: '3f2f0f0e-9c1e-4a2f-9c1e-9c1e9c1e9c1e',
            displayName: 'Анна Шубина',
            avatarUrl: null,
            levelLabel: 'D+',
            createdAt: '2026-09-17T15:57:25.000Z',
            route: '/profile/3f2f0f0e-9c1e-4a2f-9c1e-9c1e9c1e9c1e',
          },
        ]}
        onAcceptFriendRequest={onAcceptRequest}
        onDeclineFriendRequest={onDeclineRequest}
        logoutBusy={false}
        onLogout={() => undefined}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /^Открыть друзей/ }));
    const requestsBlock = screen.getByRole('region', { name: 'Заявки в друзья' });
    expect(within(requestsBlock).getByText('Анна Шубина')).toBeVisible();
    expect(within(requestsBlock).getByText('хочет добавить вас в друзья')).toBeVisible();
    expect(within(requestsBlock).getByRole('link', { name: /Анна Шубина/ })).toHaveAttribute(
      'href',
      '/profile/3f2f0f0e-9c1e-4a2f-9c1e-9c1e9c1e9c1e',
    );

    fireEvent.click(within(requestsBlock).getByRole('button', { name: 'Добавить' }));
    expect(onAcceptRequest).toHaveBeenCalledWith('18f7c9a6-8a1b-4c27-9d0e-3e34bb4c2b91');
    fireEvent.click(within(requestsBlock).getByRole('button', { name: 'Отказаться' }));
    expect(onDeclineRequest).toHaveBeenCalledWith('18f7c9a6-8a1b-4c27-9d0e-3e34bb4c2b91');
  });

  it('keeps the friends block unchanged when no request is pending', () => {
    render(
      <ProfilePage
        profile={selfProfile('D+')}
        friends={{ items: [] }}
        friendRequests={[]}
        logoutBusy={false}
        onLogout={() => undefined}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /^Открыть друзей/ }));
    expect(screen.queryByRole('region', { name: 'Заявки в друзья' })).not.toBeInTheDocument();
    expect(
      screen.getByText('Добавляйте игроков из их профилей — они появятся здесь.'),
    ).toBeVisible();
  });

  it('keeps the invite actionable for an imported account and explains the deferred delivery', () => {
    const onAddFriend = vi.fn();
    render(
      <ProfilePage
        profile={{
          ...otherProfile,
          reachable: false,
          access: {
            ...otherProfile.access,
            contact: { status: 'LOCKED', reason: 'TARGET_UNREACHABLE' },
            chat: { status: 'LOCKED', reason: 'TARGET_UNREACHABLE' },
          },
        }}
        friendship={{
          userId: otherProfile.profile.userId,
          status: 'NONE',
          createdAt: null,
          requestId: null,
        }}
        onAddFriend={onAddFriend}
        logoutBusy={false}
        onLogout={() => undefined}
      />,
    );

    expect(
      screen.getByText(
        'Игрок ещё не входил в приложение: заявку сохраним и отправим, когда он войдёт',
      ),
    ).toBeVisible();
    const addButton = screen.getByRole('button', { name: 'Добавить' });
    expect(addButton).toBeEnabled();
    fireEvent.click(addButton);
    expect(onAddFriend).toHaveBeenCalledTimes(1);
    // Both the contact and the chat action explain the same server-derived reason.
    expect(
      screen.getAllByText('Игрок ещё не входил в приложение — заявка и сообщения не дойдут.'),
    ).toHaveLength(2);
  });

  it('shows a stored deferred request without offering the command again', () => {
    render(
      <ProfilePage
        profile={{ ...otherProfile, reachable: false }}
        friendship={{
          userId: otherProfile.profile.userId,
          status: 'PENDING_DEFERRED',
          createdAt: '2026-09-18T09:00:00.000Z',
          requestId: null,
        }}
        onAddFriend={() => undefined}
        logoutBusy={false}
        onLogout={() => undefined}
      />,
    );

    expect(screen.getByText('Заявка сохранена')).toBeVisible();
    expect(screen.getByText('Отправим заявку, когда игрок войдёт в приложение')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Ожидает входа игрока' })).toBeDisabled();
  });

  it('does not show the private balance card on another player profile', () => {
    render(<ProfilePage profile={otherProfile} logoutBusy={false} onLogout={() => undefined} />);
    expect(screen.queryByRole('region', { name: 'Баланс' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Информация о балансе' })).not.toBeInTheDocument();
  });

  it('shares the canonical profile deep link instead of the current address bar', async () => {
    const share = vi.fn<(data: ShareData) => Promise<void>>().mockResolvedValue(undefined);
    Object.defineProperty(window.navigator, 'share', { configurable: true, value: share });
    window.history.replaceState(
      {},
      '',
      `/profile/${otherProfile.profile.userId}#booking-preferences-title`,
    );

    render(<ProfilePage profile={otherProfile} logoutBusy={false} onLogout={() => undefined} />);

    fireEvent.click(screen.getByRole('button', { name: 'поделиться' }));

    expect(share).toHaveBeenCalledWith({
      title: 'Мария Соколова',
      url: new URL(`/profile/${otherProfile.profile.userId}`, window.location.origin).toString(),
    });
    expect(await screen.findByText('Профиль отправлен')).toBeVisible();
    window.history.replaceState({}, '', '/');
  });

  it('opens a QR sheet for the same link and copies it', async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
    Object.defineProperty(window.navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    const link = new URL(
      `/profile/${otherProfile.profile.userId}`,
      window.location.origin,
    ).toString();

    render(<ProfilePage profile={otherProfile} logoutBusy={false} onLogout={() => undefined} />);

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'QR-код' }));

    const sheet = screen.getByRole('dialog', { name: 'QR-код профиля' });
    expect(
      within(sheet).getByRole('img', { name: `QR-код ссылки на профиль: ${link}` }),
    ).toBeVisible();
    expect(within(sheet).getByText(link)).toBeVisible();

    fireEvent.click(within(sheet).getByRole('button', { name: 'скопировать ссылку' }));
    expect(writeText).toHaveBeenCalledWith(link);
    expect(await within(sheet).findByText('Ссылка на профиль скопирована')).toBeVisible();

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('closes the QR sheet from its own close control', () => {
    render(<ProfilePage profile={otherProfile} logoutBusy={false} onLogout={() => undefined} />);

    fireEvent.click(screen.getByRole('button', { name: 'QR-код' }));
    fireEvent.click(screen.getByRole('button', { name: 'Закрыть QR-код' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

describe('Profile city and community rail', () => {
  it('offers the four cities, restores selection for the same player and isolates another player', () => {
    const props = {
      profile: selfProfile('D+'),
      logoutBusy: false,
      communities: { items: [] },
      onLogout: () => undefined,
    };
    const { unmount } = render(<ProfilePage {...props} />);
    const city = screen.getByRole('button', { name: 'Город: Москва' });
    city.focus();
    expect(city).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(city);
    const picker = screen.getByRole('dialog', { name: 'Выберите город' });
    expect(city).toHaveAttribute('aria-expanded', 'true');
    expect(city).toHaveAttribute('aria-controls', picker.id);
    expect(
      within(picker)
        .getAllByRole('button')
        .slice(1)
        .map((item) => item.getAttribute('aria-label')),
    ).toEqual(['Москва', 'Питер', 'Сочи', 'Завидово']);
    expect(within(picker).getByRole('button', { name: 'Москва' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    fireEvent.click(within(picker).getByRole('button', { name: 'Сочи' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Город: Сочи' })).toHaveFocus();
    expect(screen.getByRole('button', { name: 'Вид спорта: Падел' })).toBeVisible();
    expect(window.localStorage.getItem(`lk2:profile:city:${props.profile.profile.userId}`)).toBe(
      'Сочи',
    );
    unmount();
    const second = render(<ProfilePage {...props} />);
    expect(screen.getByRole('button', { name: 'Город: Сочи' })).toBeVisible();
    second.unmount();
    render(
      <ProfilePage
        {...props}
        profile={{
          ...props.profile,
          profile: { ...props.profile.profile, userId: '24f15c0a-b6b6-4701-86a6-0c789c81a815' },
        }}
      />,
    );
    expect(screen.getByRole('button', { name: 'Город: Москва' })).toBeVisible();
  });

  it('traps city choices and restores the trigger after Escape, backdrop or close', () => {
    render(
      <ProfilePage profile={selfProfile('C+')} logoutBusy={false} onLogout={() => undefined} />,
    );
    const trigger = screen.getByRole('button', { name: 'Город: Москва' });
    trigger.focus();
    fireEvent.click(trigger);
    const picker = screen.getByRole('dialog', { name: 'Выберите город' });
    const close = within(picker).getByRole('button', { name: 'Закрыть выбор города' });
    const last = within(picker).getByRole('button', { name: 'Завидово' });
    expect(close).toHaveFocus();
    fireEvent.keyDown(close, { key: 'Tab', shiftKey: true });
    expect(last).toHaveFocus();
    fireEvent.keyDown(last, { key: 'Tab' });
    expect(close).toHaveFocus();
    fireEvent.keyDown(close, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(trigger);
    fireEvent.mouseDown(screen.getByRole('dialog', { name: 'Выберите город' }).parentElement!);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('button', { name: 'Закрыть выбор города' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('closes an open city choice on profile changes and does not resurrect it on return', () => {
    const first = selfProfile('D+');
    const second = {
      ...first,
      profile: { ...first.profile, userId: '24f15c0a-b6b6-4701-86a6-0c789c81a815' },
    };
    window.localStorage.setItem(`lk2:profile:city:${second.profile.userId}`, 'Сочи');
    const { rerender } = render(
      <ProfilePage profile={first} logoutBusy={false} onLogout={() => undefined} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Город: Москва' }));
    rerender(<ProfilePage profile={second} logoutBusy={false} onLogout={() => undefined} />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Город: Сочи' })).toBeVisible();
    expect(window.localStorage.getItem(`lk2:profile:city:${first.profile.userId}`)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Город: Сочи' }));
    rerender(
      <ProfilePage
        profile={{
          profile: second.profile,
          reachable: true,
          access: {
            audience: 'OTHER',
            tier: 'INTERACTION',
            visibleSections: ['BASIC', 'PLAYER_LEVEL'],
            contact: { status: 'LOCKED', reason: 'FEATURE_UNAVAILABLE' },
            chat: { status: 'LOCKED', reason: 'FEATURE_UNAVAILABLE' },
          },
        }}
        logoutBusy={false}
        onLogout={() => undefined}
      />,
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Город:/ })).not.toBeInTheDocument();
    rerender(<ProfilePage profile={first} logoutBusy={false} onLogout={() => undefined} />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Город: Москва' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });

  it('keeps the selected city usable when browser storage cannot be written', () => {
    const setItem = vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
      throw new Error('storage unavailable');
    });
    try {
      render(
        <ProfilePage profile={selfProfile('D+')} logoutBusy={false} onLogout={() => undefined} />,
      );
      fireEvent.click(screen.getByRole('button', { name: 'Город: Москва' }));
      fireEvent.click(screen.getByRole('button', { name: 'Питер' }));
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Город: Питер' })).toBeVisible();
    } finally {
      setItem.mockRestore();
    }
  });

  it('loads on sideways scroll once, merges duplicates and keeps the existing cards after a failed page', async () => {
    const items = Array.from({ length: 6 }, (_, index) => ({
      id: `11111111-1111-4111-8111-11111111111${index}`,
      title: `Сообщество ${index + 1}`,
      logoUrl: null,
      isVerified: false,
      unreadChatCount: 0,
      route: `/communities/11111111-1111-4111-8111-11111111111${index}`,
    }));
    let finish!: (page: { items: typeof items; nextCursor?: string }) => void;
    const loadPage = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      )
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ items: [], nextCursor: undefined });
    render(
      <ProfilePage
        profile={selfProfile('D+')}
        logoutBusy={false}
        communities={{ items, nextCursor: 'page-2' }}
        loadCommunityPage={loadPage}
        onLogout={() => undefined}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /^Открыть мои сообщества/ }));
    const rail = screen.getByRole('region', { name: 'Мои сообщества' });
    expect(within(rail).getAllByRole('link')).toHaveLength(6);
    Object.defineProperties(rail, {
      clientWidth: { value: 300 },
      scrollWidth: { value: 600 },
      scrollLeft: { value: 280, writable: true },
    });
    fireEvent.scroll(rail);
    fireEvent.scroll(rail);
    expect(loadPage).toHaveBeenCalledTimes(1);
    expect(loadPage).toHaveBeenLastCalledWith('page-2');
    await act(async () => {
      finish({
        items: [
          items[0]!,
          { ...items[1]!, id: '21111111-1111-4111-8111-111111111111', title: 'Новое сообщество' },
        ],
        nextCursor: 'page-3',
      });
      await Promise.resolve();
    });
    expect(within(rail).getAllByRole('link')).toHaveLength(7);
    fireEvent.scroll(rail);
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('Не удалось догрузить сообщества'),
    );
    expect(within(rail).getAllByRole('link')).toHaveLength(7);
    fireEvent.scroll(rail);
    expect(loadPage).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole('button', { name: 'Повторить' }));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Показать ещё' })).not.toBeInTheDocument(),
    );
    expect(loadPage).toHaveBeenCalledTimes(3);
  });
});
