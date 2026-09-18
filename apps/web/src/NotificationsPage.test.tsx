// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { NotificationsPage } from './NotificationsPage.js';
import type { NotificationInboxPage } from './auth-gateway.js';

afterEach(cleanup);

const items: NotificationInboxPage['items'] = [
  {
    id: '11111111-1111-4111-8111-111111111111',
    category: 'GAME',
    title: 'Новое сообщение в игре',
    body: 'Хаб Селигерская',
    deepLink: '/chats/22222222-2222-4222-8222-222222222222',
    createdAt: '2026-08-29T10:00:00+03:00',
  },
  {
    id: '33333333-3333-4333-8333-333333333333',
    category: 'ADMIN_MESSAGE',
    title: 'Рейтинг обновился',
    body: 'Вы поднялись на две позиции',
    deepLink: '/profile',
    createdAt: '2026-08-28T10:00:00+03:00',
    readAt: '2026-08-28T11:00:00+03:00',
  },
  {
    id: '44444444-4444-4444-8444-444444444444',
    category: 'FUTURE_CATEGORY',
    title: 'Неизвестная категория',
    body: 'Остаётся во вкладке Все',
    deepLink: 'https://evil.example/path',
    createdAt: '2026-08-27T10:00:00+03:00',
  },
];

const defaultProps = {
  page: { unreadCount: 2, items },
  webPush: { enabled: true, publicKey: 'public-vapid-key-value' },
  browserState: 'ready' as const,
  busy: false,
  error: null,
  inboxUnavailable: false,
  friendRequests: [],
  friendRequestsError: null,
  outgoingFriendRequests: [],
  friendRequestBusyId: null,
  onAcceptFriendRequest: vi.fn(),
  onDeclineFriendRequest: vi.fn(),
  onEnableWebPush: vi.fn(),
  onDisableWebPush: vi.fn(),
  onMarkAllRead: vi.fn(),
  onRetryInbox: vi.fn(),
  onOpenNotification: vi.fn(),
};

describe('NotificationsPage', () => {
  it('renders mapped filters while preserving unknown categories in All', () => {
    render(<NotificationsPage {...defaultProps} />);
    expect(screen.getByRole('heading', { name: 'Уведомления' })).toBeVisible();
    expect(screen.getByRole('link', { name: 'Чаты', current: 'page' })).toBeVisible();
    expect(screen.getByText('Неизвестная категория')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Акции' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Игры' }));
    expect(screen.getByText('Новое сообщение в игре')).toBeVisible();
    expect(screen.queryByText('Неизвестная категория')).not.toBeInTheDocument();
    expect(screen.queryByText('Рейтинг обновился')).not.toBeInTheDocument();
  });

  it('preserves safe links, unread semantics, and mark-all-read', () => {
    const onMarkAllRead = vi.fn();
    const onOpenNotification = vi.fn();
    render(
      <NotificationsPage
        {...defaultProps}
        onMarkAllRead={onMarkAllRead}
        onOpenNotification={onOpenNotification}
      />,
    );
    expect(screen.getByRole('link', { name: /Новое сообщение в игре/u })).toHaveAttribute(
      'href',
      '/chats/22222222-2222-4222-8222-222222222222',
    );
    expect(screen.getByRole('link', { name: /Неизвестная категория/u })).toHaveAttribute(
      'href',
      '/notifications',
    );
    expect(screen.getAllByLabelText('Непрочитанное уведомление')).toHaveLength(2);
    fireEvent.click(screen.getByRole('link', { name: /Новое сообщение в игре/u }));
    expect(onOpenNotification).toHaveBeenCalledWith(
      items[0],
      '/chats/22222222-2222-4222-8222-222222222222',
      true,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Прочитать все' }));
    expect(onMarkAllRead).toHaveBeenCalledOnce();
  });

  it('keeps Web Push controls and error state discoverable', () => {
    const onEnableWebPush = vi.fn();
    const { rerender } = render(
      <NotificationsPage
        {...defaultProps}
        onEnableWebPush={onEnableWebPush}
        error="Лента временно недоступна"
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Лента временно недоступна');
    fireEvent.click(screen.getByRole('button', { name: 'Включить push' }));
    expect(onEnableWebPush).toHaveBeenCalledOnce();

    const onDisableWebPush = vi.fn();
    rerender(
      <NotificationsPage
        {...defaultProps}
        browserState="subscribed"
        onDisableWebPush={onDisableWebPush}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Отключить push' }));
    expect(onDisableWebPush).toHaveBeenCalledOnce();
  });

  it('sends an iOS tab to the Home Screen instead of offering a button that cannot work', () => {
    render(<NotificationsPage {...defaultProps} browserState="needs_install" />);

    expect(
      screen.getByText('На iPhone и iPad push работает только из приложения на экране «Домой».'),
    ).toBeVisible();
    expect(
      screen.getByText(/Откройте PadlHub в Safari, нажмите «Поделиться» → «На экран/),
    ).toBeVisible();
    // No enable control: an iOS tab cannot subscribe, so offering the button would only burn the
    // one-time permission decision.
    expect(screen.queryByRole('button', { name: 'Включить push' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Отключить push' })).not.toBeInTheDocument();
  });

  it('renders an empty state without hiding the disabled push control', () => {
    render(
      <NotificationsPage
        {...defaultProps}
        page={{ unreadCount: 0, items: [] }}
        webPush={{ enabled: false, reason: 'GLOBAL_GATE_DISABLED' }}
        browserState="default"
      />,
    );
    expect(screen.getByText('Пока тихо')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Включить push' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Прочитать все' })).not.toBeInTheDocument();
  });

  it('keeps an unavailable inbox distinct from a successful empty state and exposes retry', () => {
    const onRetryInbox = vi.fn();
    render(
      <NotificationsPage
        {...defaultProps}
        page={{ unreadCount: 0, items: [] }}
        error="Лента оповещений временно недоступна."
        inboxUnavailable
        onRetryInbox={onRetryInbox}
      />,
    );
    expect(screen.getByText('Лента недоступна')).toBeVisible();
    expect(screen.queryByText('Пока тихо')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Повторить' }));
    expect(onRetryInbox).toHaveBeenCalledOnce();
  });

  it('renders an incoming friend request with accept and decline commands', () => {
    const onAcceptFriendRequest = vi.fn();
    const onDeclineFriendRequest = vi.fn();
    render(
      <NotificationsPage
        {...defaultProps}
        friendRequests={[
          {
            requestId: '18f7c9a6-8a1b-4c27-9d0e-3e34bb4c2b91',
            userId: '6a81e965-c508-4321-812c-4be323606a70',
            displayName: 'Мария Соколова',
            avatarUrl: null,
            levelLabel: 'C',
            createdAt: '2026-08-29T10:00:00+03:00',
            route: '/profile/6a81e965-c508-4321-812c-4be323606a70',
          },
        ]}
        onAcceptFriendRequest={onAcceptFriendRequest}
        onDeclineFriendRequest={onDeclineFriendRequest}
      />,
    );

    expect(screen.getByRole('heading', { name: 'Заявки в друзья' })).toBeVisible();
    expect(screen.getByText('хочет добавить вас в друзья')).toBeVisible();
    expect(screen.getByRole('link', { name: /Мария Соколова/ })).toHaveAttribute(
      'href',
      '/profile/6a81e965-c508-4321-812c-4be323606a70',
    );

    fireEvent.click(screen.getByRole('button', { name: 'Добавить' }));
    expect(onAcceptFriendRequest).toHaveBeenCalledWith('18f7c9a6-8a1b-4c27-9d0e-3e34bb4c2b91');

    fireEvent.click(screen.getByRole('button', { name: 'Отказаться' }));
    expect(onDeclineFriendRequest).toHaveBeenCalledWith('18f7c9a6-8a1b-4c27-9d0e-3e34bb4c2b91');
  });

  it('hides the friend request section when there is nothing to answer', () => {
    render(<NotificationsPage {...defaultProps} />);
    expect(screen.queryByRole('heading', { name: 'Заявки в друзья' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Отправленные заявки' })).not.toBeInTheDocument();
  });

  it('shows sent requests as read-only cards with the addressed peer', () => {
    render(
      <NotificationsPage
        {...defaultProps}
        outgoingFriendRequests={[
          {
            requestId: 'd0a3bd8e-1d4a-4d3a-9d21-2a1a8f9c4b77',
            userId: 'b7f0d3a2-5c6e-4c1f-9a0e-1d2c3b4a5f60',
            displayName: 'Пётр Волков',
            avatarUrl: null,
            levelLabel: 'B',
            createdAt: '2026-08-30T09:00:00+03:00',
            route: '/profile/b7f0d3a2-5c6e-4c1f-9a0e-1d2c3b4a5f60',
          },
        ]}
      />,
    );

    expect(screen.getByRole('heading', { name: 'Отправленные заявки' })).toBeVisible();
    expect(screen.getByText('ожидает ответа')).toBeVisible();
    expect(screen.getByRole('link', { name: /Пётр Волков/ })).toHaveAttribute(
      'href',
      '/profile/b7f0d3a2-5c6e-4c1f-9a0e-1d2c3b4a5f60',
    );
    expect(screen.queryByRole('button', { name: 'Отказаться' })).not.toBeInTheDocument();
  });
});
