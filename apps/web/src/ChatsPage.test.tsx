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
  canRetrySend: false,
  onCreateDirect: vi.fn(),
  onSendMessage: vi.fn(),
  onRetrySend: vi.fn(),
  onRefresh: vi.fn(),
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

  it('filters loaded chats and searches Cyrillic titles and previews locally', () => {
    render(
      <ChatsPage
        {...defaultProps}
        mode="list"
        hasExplicitRecipient={false}
        page={{
          items: [
            {
              id: '11111111-1111-4111-8111-111111111111',
              kind: 'DIRECT',
              participant: { userId: conversationId, displayName: 'Мария Петрова' },
              unreadCount: 0,
              updatedAt: '2026-08-29T11:32:00+03:00',
              lastMessage: {
                sequence: 1,
                body: 'Спасибо за игру',
                createdAt: '2026-08-29T11:32:00+03:00',
              },
            },
            {
              id: conversationId,
              kind: 'GAME',
              contextId: '33333333-3333-4333-8333-333333333333',
              title: 'Игра · Хаб Селигерская',
              unreadCount: 4,
              updatedAt: '2026-08-28T10:00:00+03:00',
              lastMessage: {
                sequence: 1,
                body: 'Встречаемся в десять',
                createdAt: '2026-08-28T10:00:00+03:00',
              },
            },
          ],
        }}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Личные' }));
    expect(screen.getByText('Мария Петрова')).toBeVisible();
    expect(screen.queryByText('Игра · Хаб Селигерская')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Все' }));
    fireEvent.change(screen.getByRole('searchbox', { name: 'Поиск по чатам' }), {
      target: { value: 'встречаемся' },
    });
    expect(screen.getByText('Игра · Хаб Селигерская')).toBeVisible();
    expect(screen.queryByText('Мария Петрова')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Очистить' }));
    expect(screen.getByText('Мария Петрова')).toBeVisible();
  });

  it('caps large unread counts, preserves hrefs, and marks the active conversation', () => {
    render(
      <ChatsPage
        {...defaultProps}
        mode="thread"
        selectedConversationId={conversationId}
        hasExplicitRecipient={false}
        page={{
          items: [
            {
              id: conversationId,
              kind: 'DIRECT',
              participant: { userId: '11111111-1111-4111-8111-111111111111', displayName: 'Борис' },
              unreadCount: 100,
              updatedAt: '2026-08-29T11:32:00+03:00',
            },
          ],
        }}
      />,
    );

    const link = screen.getByRole('link', { name: /Борис/u });
    expect(link).toHaveAttribute('href', `/chats/${conversationId}`);
    expect(link).toHaveAttribute('aria-current', 'page');
    expect(screen.getByLabelText('Непрочитанных сообщений: 100')).toHaveTextContent('99+');
  });

  it('renders only known GAME context data and a safe game link', () => {
    render(
      <ChatsPage
        {...defaultProps}
        mode="thread"
        selectedConversationId={conversationId}
        hasExplicitRecipient={false}
        page={{
          items: [
            {
              id: conversationId,
              kind: 'GAME',
              contextId: '33333333-3333-4333-8333-333333333333',
              title: 'Игра на Селигерской',
              unreadCount: 0,
              updatedAt: '2026-08-29T11:32:00+03:00',
            },
          ],
        }}
      />,
    );

    const context = screen.getByRole('complementary', { name: 'Контекст игры' });
    expect(context).toHaveTextContent('Игра на Селигерской');
    expect(within(context).getByRole('link', { name: 'Открыть игру' })).toHaveAttribute(
      'href',
      '/games/33333333-3333-4333-8333-333333333333',
    );
    expect(context).not.toHaveTextContent(/корт|уровень|оплата/iu);
  });

  it('sends with Enter, keeps Shift+Enter, and ignores Enter during IME composition', () => {
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
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect(onSendMessage).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    expect(onSendMessage).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSendMessage).toHaveBeenCalledWith('Первая строка');
    expect(screen.queryByRole('button', { name: /микрофон|реакц|влож/iu })).not.toBeInTheDocument();
  });

  it('distinguishes empty chat pages from no local search results', () => {
    const { rerender } = render(
      <ChatsPage {...defaultProps} mode="list" hasExplicitRecipient={false} page={{ items: [] }} />,
    );
    expect(screen.getByText('Диалогов пока нет')).toBeVisible();

    rerender(
      <ChatsPage
        {...defaultProps}
        mode="list"
        hasExplicitRecipient={false}
        page={{
          items: [
            {
              id: conversationId,
              kind: 'DIRECT',
              participant: { userId: conversationId, displayName: 'Александр' },
              unreadCount: 0,
              updatedAt: '2026-08-29T11:32:00+03:00',
            },
          ],
        }}
      />,
    );
    fireEvent.change(screen.getByRole('searchbox', { name: 'Поиск по чатам' }), {
      target: { value: 'несуществующий' },
    });
    expect(screen.getByText('Ничего не найдено')).toBeVisible();
  });
});
