// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ChatsPage } from './ChatsPage.js';

const conversationId = '22222222-2222-4222-8222-222222222222';
const currentUserId = '49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca';

afterEach(cleanup);

describe('ChatsPage', () => {
  it('renders ordered history and sends a normalized draft', () => {
    const onSendMessage = vi.fn();
    render(
      <ChatsPage
        page={{
          items: [
            {
              id: conversationId,
              kind: 'DIRECT',
              participant: {
                userId: '11111111-1111-4111-8111-111111111111',
                displayName: 'Борис',
              },
              unreadCount: 1,
              updatedAt: '2026-07-26T12:00:00.000Z',
              lastMessage: {
                sequence: 1,
                body: 'Привет',
                createdAt: '2026-07-26T12:00:00.000Z',
              },
            },
          ],
        }}
        messages={{
          messages: [
            {
              id: '33333333-3333-4333-8333-333333333333',
              conversationId,
              sequence: 1,
              sender: { userId: currentUserId, displayName: 'Анна' },
              messageType: 'TEXT',
              body: 'Привет',
              createdAt: '2026-07-26T12:00:00.000Z',
            },
          ],
        }}
        selectedConversationId={conversationId}
        currentUserId={currentUserId}
        busy={false}
        error={null}
        onCreateDirect={vi.fn()}
        onSendMessage={onSendMessage}
        onRefresh={vi.fn()}
      />,
    );

    expect(screen.getByRole('link', { name: /Борис/ })).toHaveAttribute(
      'href',
      `/chats/${conversationId}`,
    );
    fireEvent.change(screen.getByLabelText('Сообщение'), {
      target: { value: '  Новое сообщение  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Отправить' }));

    expect(onSendMessage).toHaveBeenCalledWith('Новое сообщение');
  });

  it('starts a direct conversation only from a non-empty PadlHub UUID field', () => {
    const onCreateDirect = vi.fn();
    render(
      <ChatsPage
        page={{ items: [] }}
        messages={null}
        currentUserId={currentUserId}
        busy={false}
        error={null}
        onCreateDirect={onCreateDirect}
        onSendMessage={vi.fn()}
        onRefresh={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText('PadlHub UUID участника'), {
      target: { value: ' 11111111-1111-4111-8111-111111111111 ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Начать диалог' }));

    expect(onCreateDirect).toHaveBeenCalledWith('11111111-1111-4111-8111-111111111111');
  });

  it('renders a GAME conversation by its canonical title and context', () => {
    render(
      <ChatsPage
        page={{
          items: [
            {
              id: conversationId,
              kind: 'GAME',
              context: {
                type: 'GAME',
                id: '44444444-4444-4444-8444-444444444444',
              },
              title: 'Игра в Сколково',
              unreadCount: 2,
              updatedAt: '2026-07-26T12:00:00.000Z',
            },
          ],
        }}
        messages={{ messages: [] }}
        selectedConversationId={conversationId}
        currentUserId={currentUserId}
        busy={false}
        error={null}
        onCreateDirect={vi.fn()}
        onSendMessage={vi.fn()}
        onRefresh={vi.fn()}
      />,
    );

    expect(screen.getByRole('link', { name: /Игра в Сколково/ })).toHaveAttribute(
      'href',
      `/chats/${conversationId}`,
    );
    expect(screen.getByText('Чат игры')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Игра в Сколково' })).toBeInTheDocument();
  });
});
