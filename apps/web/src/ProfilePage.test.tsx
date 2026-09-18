// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import type { PlayerProfileView } from '@phub/api-sdk';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ProfilePage } from './ProfilePage.js';

afterEach(cleanup);

function selfProfile(level: string): PlayerProfileView {
  return {
    profile: {
      userId: '14f15c0a-b6b6-4701-86a6-0c789c81a815',
      displayName: 'Алексей Максимов',
      avatarUrl: null,
      level: { label: level, value: 3.64, assessmentRequired: false },
    },
    privateAccount: { phoneLast4: '5826', balanceMinor: 54000, currency: 'RUB' },
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
});
