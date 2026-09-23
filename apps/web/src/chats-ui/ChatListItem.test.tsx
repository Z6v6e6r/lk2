// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ChatListItem } from './ChatListItem.js';

afterEach(cleanup);

const id = '22222222-2222-4222-8222-222222222222';
const userId = '11111111-1111-4111-8111-111111111111';

describe('chat row destinations', () => {
  it('separates the player profile link from the conversation link without nested anchors', () => {
    const { container } = render(
      <ChatListItem
        selected={false}
        conversation={{
          id,
          kind: 'DIRECT',
          participant: { userId, displayName: 'Тестовый Игрок' },
          unreadCount: 3,
          updatedAt: '2026-09-22T10:00:00Z',
        }}
      />,
    );
    expect(screen.getByRole('link', { name: 'Профиль игрока Тестовый Игрок' })).toHaveAttribute(
      'href',
      `/profile/${userId}`,
    );
    expect(screen.getByRole('link', { name: /^Тестовый Игрок/u })).toHaveAttribute(
      'href',
      `/chats/${id}`,
    );
    expect(container.querySelector('a a')).toBeNull();
  });

  it('keeps the group marker linked to its conversation, never a player profile', () => {
    render(
      <ChatListItem
        selected
        conversation={{
          id,
          kind: 'GAME',
          contextId: userId,
          title: 'Тестовая игра',
          unreadCount: 0,
          updatedAt: '2026-09-22T10:00:00Z',
        }}
      />,
    );
    expect(screen.getByRole('link', { name: 'Открыть чат Тестовая игра' })).toHaveAttribute(
      'href',
      `/chats/${id}`,
    );
    expect(screen.queryByRole('link', { name: /Профиль игрока/ })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { current: 'page' })).toHaveAttribute('href', `/chats/${id}`);
  });
});
