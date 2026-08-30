// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ChatsPage } from './ChatsPage.js';

const conversationId = '22222222-2222-4222-8222-222222222222';
const currentUserId = '49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca';

afterEach(cleanup);

const defaultProps = {
  page: { items: [] },
  messages: [],
  currentUserId,
  busy: null,
  error: null,
  pendingMessage: null,
  realtimeState: null,
  hasEarlierMessages: false,
  canRetrySend: false,
  onCreateDirect: vi.fn(),
  onSendMessage: vi.fn(),
  onRetrySend: vi.fn(),
  onRefresh: vi.fn(),
  onLoadEarlier: vi.fn(),
} as const;

describe('ChatsPage', () => {
  it('renders history in sequence order and sends a normalized draft', () => {
    const onSendMessage = vi.fn();
    render(
      <ChatsPage
        {...defaultProps}
        mode="thread"
        selectedConversationId={conversationId}
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
            },
          ],
        }}
        messages={[
          {
            id: '44444444-4444-4444-8444-444444444444',
            conversationId,
            sequence: 2,
            sender: { userId: currentUserId, displayName: 'Анна' },
            messageType: 'TEXT',
            body: 'Второе',
            createdAt: '2026-07-26T12:01:00.000Z',
          },
          {
            id: '33333333-3333-4333-8333-333333333333',
            conversationId,
            sequence: 1,
            sender: { userId: '11111111-1111-4111-8111-111111111111', displayName: 'Борис' },
            messageType: 'TEXT',
            body: 'Первое',
            createdAt: '2026-07-26T12:00:00.000Z',
          },
        ]}
        hasExplicitRecipient={false}
        onSendMessage={onSendMessage}
      />,
    );

    const history = within(screen.getByRole('region', { name: 'История сообщений' })).getByRole(
      'list',
    );
    expect(history).toHaveTextContent(/Первое.*Второе/s);
    fireEvent.change(screen.getByLabelText('Сообщение'), {
      target: { value: '  Новое сообщение  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Отправить' }));

    expect(onSendMessage).toHaveBeenCalledWith('Новое сообщение');
  });

  it('starts a direct chat only from an explicit profile deep link without a UUID field', () => {
    const onCreateDirect = vi.fn();
    const { rerender } = render(
      <ChatsPage
        {...defaultProps}
        mode="new"
        hasExplicitRecipient={false}
        onCreateDirect={onCreateDirect}
      />,
    );

    expect(screen.getByRole('note')).toHaveTextContent('Получатель не выбран');
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Начать диалог' })).not.toBeInTheDocument();

    rerender(
      <ChatsPage
        {...defaultProps}
        mode="new"
        hasExplicitRecipient
        onCreateDirect={onCreateDirect}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Начать диалог' }));
    expect(onCreateDirect).toHaveBeenCalledOnce();
    expect(screen.queryByText('11111111-1111-4111-8111-111111111111')).not.toBeInTheDocument();
  });

  it('keeps feature-unavailable and retryable failures distinct', () => {
    const { rerender } = render(
      <ChatsPage
        {...defaultProps}
        mode="list"
        hasExplicitRecipient={false}
        error={{ kind: 'FEATURE_UNAVAILABLE', message: 'Контур выключен.' }}
      />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent('Чаты пока недоступны');
    expect(screen.queryByRole('button', { name: 'Повторить' })).not.toBeInTheDocument();

    rerender(
      <ChatsPage
        {...defaultProps}
        mode="list"
        hasExplicitRecipient={false}
        error={{ kind: 'RETRYABLE', message: 'Сбой сети.' }}
      />,
    );
    expect(screen.getByRole('button', { name: 'Повторить' })).toBeEnabled();
  });

  it('shows one optimistic item through sending and failed states without rendering HTML', () => {
    const { rerender } = render(
      <ChatsPage
        {...defaultProps}
        mode="thread"
        selectedConversationId={conversationId}
        hasExplicitRecipient={false}
        pendingMessage={{
          clientMessageId: 'client-message-0001',
          body: '<script>alert(1)</script>\nдлинная строка',
          state: 'sending',
        }}
      />,
    );

    expect(screen.getByText('<script>alert(1)</script>', { exact: false })).toBeVisible();
    expect(document.querySelector('script')).not.toBeInTheDocument();
    expect(screen.getByText('Отправляется…')).toBeVisible();

    rerender(
      <ChatsPage
        {...defaultProps}
        mode="thread"
        selectedConversationId={conversationId}
        hasExplicitRecipient={false}
        pendingMessage={{
          clientMessageId: 'client-message-0001',
          body: '<script>alert(1)</script>\nдлинная строка',
          state: 'failed',
        }}
        canRetrySend
      />,
    );
    expect(screen.getAllByText('<script>alert(1)</script>', { exact: false })).toHaveLength(1);
    expect(screen.getByText('Не отправлено')).toBeVisible();
  });

  it('uses Ctrl+Enter to send and keeps plain Enter for a newline', () => {
    const onSendMessage = vi.fn();
    render(
      <ChatsPage
        {...defaultProps}
        mode="thread"
        selectedConversationId={conversationId}
        hasExplicitRecipient={false}
        onSendMessage={onSendMessage}
      />,
    );
    const input = screen.getByLabelText('Сообщение');
    fireEvent.change(input, { target: { value: 'Первая строка' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSendMessage).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true });
    expect(onSendMessage).toHaveBeenCalledWith('Первая строка');
  });

  it('exposes earlier history loading and reconnect fallback status', () => {
    const onLoadEarlier = vi.fn();
    render(
      <ChatsPage
        {...defaultProps}
        mode="thread"
        selectedConversationId={conversationId}
        hasExplicitRecipient={false}
        hasEarlierMessages
        realtimeState="reconnecting"
        onLoadEarlier={onLoadEarlier}
      />,
    );
    expect(screen.getByRole('status')).toHaveTextContent('История обновляется');
    fireEvent.click(screen.getByRole('button', { name: 'Показать предыдущие сообщения' }));
    expect(onLoadEarlier).toHaveBeenCalledOnce();
  });
});
