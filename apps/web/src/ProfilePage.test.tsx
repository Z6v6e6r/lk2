// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import type { PlayerProfileView } from '@phub/api-sdk';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ProfilePage } from './ProfilePage.js';

afterEach(() => {
  cleanup();
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

  it('shows Back on the left and notifications on the right', () => {
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
    const notificationsLink = toolbar?.querySelector(
      'a[aria-label="Уведомления, непрочитанных: 1"]',
    );

    expect(toolbar).toHaveClass('profile-toolbar');
    expect(toolbar?.firstElementChild).toBe(backButton);
    expect(toolbar?.lastElementChild).toBe(notificationsLink);
    expect(backButton).toHaveClass('profile-toolbar__back');
    expect(notificationsLink).toHaveAttribute('href', '/notifications');
    expect(notificationsLink).toHaveClass('fh-bell', 'is-unread', 'profile-toolbar__bell');
    expect(notificationsLink?.querySelector('.fh-bell-dot')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /^История изменения уровня/ })).toHaveAttribute(
      'href',
      '/profile/level-history',
    );

    backButton.click();
    expect(historyBack).toHaveBeenCalledOnce();
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
    expect(
      screen.getByRole('img', {
        name: `Алексей Максимов, уровень ${level}, прогресс 64%`,
      }),
    ).toBeVisible();
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

    const stats = screen.getByLabelText('Данные профиля');
    expect(within(stats).getByText('—')).toBeVisible();
    expect(within(stats).queryByText('D')).not.toBeInTheDocument();
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

    expect(screen.getByText('SquashHub Player')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Вид спорта: Сквош' })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Отдельный спортивный профиль' })).toBeVisible();
    expect(screen.getByRole('main').getAttribute('style')).toContain('squash-level-a.webp');
    expect(screen.queryByRole('region', { name: 'Подписки и абонементы' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Сообщества' })).not.toBeInTheDocument();
  });

  it('switches to an isolated badminton profile with its own artwork', () => {
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
    fireEvent.click(within(picker).getByRole('button', { name: 'Бадминтон' }));

    expect(screen.getByText('BadmintonHub Player')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Вид спорта: Бадминтон' })).toBeVisible();
    expect(screen.getByText('рекомендации по бадминтону', { exact: false })).toBeVisible();
    expect(screen.getByRole('main').getAttribute('style')).toContain('badminton-level-a.webp');
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

    expect(screen.getByRole('heading', { name: 'Друзья' })).toBeVisible();
    expect(screen.queryByText('ПаделХАБ')).not.toBeInTheDocument();
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

    expect(screen.getByRole('link', { name: 'хАБ Нагатинская, 12 место' })).toHaveAttribute(
      'href',
      '/communities/11111111-1111-4111-8111-111111111111',
    );
    expect(screen.getByText('12 место')).toBeVisible();
  });

  it('marks the player as outside the community rating when no snapshot row exists', () => {
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

    expect(screen.getByRole('link', { name: 'хАБ Терехово, вне рейтинга' })).toBeVisible();
    expect(screen.getByText('вне рейтинга')).toBeVisible();
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
