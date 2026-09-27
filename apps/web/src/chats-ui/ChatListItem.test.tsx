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

  it('identifies a game chat by its roster, station and date instead of the last message', () => {
    const { container } = render(
      <ChatListItem
        selected={false}
        conversation={{
          id,
          kind: 'GAME',
          contextId: userId,
          title: 'Пятничная игра',
          unreadCount: 2,
          updatedAt: '2026-09-22T10:00:00Z',
          lastMessage: {
            sequence: 4,
            body: 'Я возьму мячи',
            createdAt: '2026-09-22T09:59:00Z',
          },
          stationName: 'Терехово',
          startsAt: '2026-09-28T06:00:00.000Z',
          timezone: 'Europe/Moscow',
          participants: [
            {
              userId,
              displayName: 'Анна',
              role: 'ORGANIZER',
              avatarUrl: '/public/api/v1/media/profile-photos/tenant/photo',
              level: 'C+',
              levelValue: 3.44,
            },
            { userId: id, displayName: 'Борис', role: 'PLAYER' },
          ],
        }}
      />,
    );

    // Four overlapping roster circles, never an open "join" slot.
    expect(
      container.querySelectorAll('.chat-game-stack .participant-avatar-stack__item'),
    ).toHaveLength(2);
    expect(container.querySelector('.participant-avatar-stack__open-slot')).toBeNull();
    expect(screen.getByText('Терехово · 28 сентября, 09:00')).toBeInTheDocument();
    expect(screen.queryByText('Я возьму мячи')).not.toBeInTheDocument();
  });

  it('keeps the last message preview for a game chat without schedule data', () => {
    render(
      <ChatListItem
        selected={false}
        conversation={{
          id,
          kind: 'GAME',
          contextId: userId,
          title: 'Игра без проекции',
          unreadCount: 0,
          updatedAt: '2026-09-22T10:00:00Z',
          lastMessage: {
            sequence: 2,
            body: 'Плюс один',
            createdAt: '2026-09-22T09:30:00Z',
          },
        }}
      />,
    );

    expect(screen.getByText('Плюс один')).toBeInTheDocument();
  });
});
