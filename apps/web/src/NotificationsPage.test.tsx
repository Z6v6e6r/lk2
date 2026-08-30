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
  onEnableWebPush: vi.fn(),
  onDisableWebPush: vi.fn(),
  onMarkAllRead: vi.fn(),
};

describe('NotificationsPage', () => {
  it('renders mapped filters while preserving unknown categories in All', () => {
    render(<NotificationsPage {...defaultProps} />);
    expect(screen.getByRole('heading', { name: 'Уведомления' })).toBeVisible();
    expect(screen.getByText('Неизвестная категория')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Акции' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Игры' }));
    expect(screen.getByText('Новое сообщение в игре')).toBeVisible();
    expect(screen.queryByText('Неизвестная категория')).not.toBeInTheDocument();
    expect(screen.queryByText('Рейтинг обновился')).not.toBeInTheDocument();
  });

  it('preserves safe links, unread semantics, and mark-all-read', () => {
    const onMarkAllRead = vi.fn();
    render(<NotificationsPage {...defaultProps} onMarkAllRead={onMarkAllRead} />);
    expect(screen.getByRole('link', { name: /Новое сообщение в игре/u })).toHaveAttribute(
      'href',
      '/chats/22222222-2222-4222-8222-222222222222',
    );
    expect(screen.getByRole('link', { name: /Неизвестная категория/u })).toHaveAttribute(
      'href',
      '/notifications',
    );
    expect(screen.getAllByLabelText('Непрочитанное уведомление')).toHaveLength(2);
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
});
