// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { setChatsUnreadCount } from './chats-unread.js';
import { MainBottomNavigation } from './HomeDashboardPage.js';

afterEach(() => {
  cleanup();
  setChatsUnreadCount(0);
});

describe('bottom navigation communications entries', () => {
  it('exposes Chats without a separate Notifications entry', () => {
    render(<MainBottomNavigation active="home" />);

    expect(screen.getByRole('link', { name: 'Чаты' })).toHaveAttribute('href', '/chats');
    expect(screen.queryByRole('link', { name: 'Уведомления' })).not.toBeInTheDocument();
  });

  it('marks the active communications section', () => {
    const { unmount } = render(<MainBottomNavigation active="chats" />);
    expect(screen.getByRole('link', { name: 'Чаты' })).toHaveAttribute('aria-current', 'page');
    unmount();

    render(<MainBottomNavigation active="notifications" />);
    expect(screen.getByRole('link', { name: 'Чаты' })).toHaveAttribute('aria-current', 'page');
  });

  it('announces unread chats instead of hiding them behind an icon', () => {
    setChatsUnreadCount(3);
    render(<MainBottomNavigation active="home" />);

    expect(
      screen.getByRole('link', { name: 'Чаты, непрочитанных сообщений: 3' }),
    ).toBeInTheDocument();
  });

  it('caps the visible badge while keeping the exact accessible count', () => {
    setChatsUnreadCount(140);
    render(<MainBottomNavigation active="home" />);

    const link = screen.getByRole('link', { name: 'Чаты, непрочитанных сообщений: 140' });
    expect(link).toHaveTextContent('99+');
  });
});
