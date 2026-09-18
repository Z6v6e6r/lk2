// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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
    const messageArticles = within(history).getAllByRole('article');
    expect(within(messageArticles[0]!).getByText('Отправитель: Борис')).toHaveClass('sr-only');
    expect(within(messageArticles[1]!).getByText('Отправитель: Вы')).toHaveClass('sr-only');
    fireEvent.change(screen.getByLabelText('Сообщение'), {
      target: { value: '  Новое сообщение  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Отправить' }));

    expect(onSendMessage).toHaveBeenCalledWith('Новое сообщение');
  });

  it('groups consecutive sender messages only within a day and retains sender labels', () => {
    const messages = [
      { sender: 'Борис', userId: 'boris', day: '01', body: 'Первая реплика' },
      { sender: 'Борис', userId: 'boris', day: '01', body: 'Продолжение' },
      { sender: 'Борис', userId: 'boris', day: '02', body: 'На следующий день' },
      { sender: 'Анна', userId: currentUserId, day: '02', body: 'Ответ' },
      { sender: 'Борис', userId: 'boris', day: '02', body: 'Новая группа' },
    ].map((item, index) => ({
      id: `message-${index}`,
      conversationId,
      sequence: index + 1,
      sender: { userId: item.userId, displayName: item.sender },
      messageType: 'TEXT' as const,
      body: item.body,
      createdAt: `2026-04-${item.day}T12:00:00.000Z`,
    }));
    render(
      <ChatsPage
        {...defaultProps}
        mode="thread"
        selectedConversationId={conversationId}
        hasExplicitRecipient={false}
        messages={messages}
      />,
    );
    const history = within(screen.getByRole('region', { name: 'История сообщений' }));
    const articles = history.getAllByRole('article');
    expect(articles.map((article) => article.querySelector('strong')?.textContent ?? null)).toEqual(
      ['Борис', null, 'Борис', null, 'Борис'],
    );
    expect(history.getAllByText('Отправитель: Борис')).toHaveLength(4);
    expect(history.getByLabelText('Отправлено')).toBeInTheDocument();
    expect(history.queryByText('Прочитано')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Чаты', current: 'page' })).toBeInTheDocument();
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

    rerender(
      <ChatsPage
        {...defaultProps}
        mode="new"
        hasExplicitRecipient
        error={{ kind: 'FEATURE_UNAVAILABLE', message: 'Контур выключен.' }}
        onCreateDirect={onCreateDirect}
      />,
    );
    expect(screen.getByRole('button', { name: 'Начать диалог' })).toBeDisabled();
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

    expect(screen.getByRole('heading', { name: 'Все' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Личные' }));
    expect(screen.getByRole('heading', { name: 'Личные' })).toBeInTheDocument();
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

  it('keeps search and type filters reachable in a keyboard-only flow', async () => {
    const user = userEvent.setup();
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
            },
            {
              id: conversationId,
              kind: 'GAME',
              contextId: '33333333-3333-4333-8333-333333333333',
              title: 'Игра · Хаб Селигерская',
              unreadCount: 0,
              updatedAt: '2026-08-29T11:32:00+03:00',
            },
          ],
        }}
      />,
    );

    await user.tab();
    expect(screen.getByRole('button', { name: 'Только непрочитанные' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('link', { name: 'События' })).toHaveFocus();
    await user.tab();
    const search = screen.getByRole('searchbox', { name: 'Поиск по чатам' });
    expect(search).toHaveFocus();
    await user.type(search, 'мария');
    await user.tab();
    expect(screen.getByRole('button', { name: 'Очистить' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Все' })).toHaveFocus();
    await user.tab();
    const directFilter = screen.getByRole('button', { name: 'Личные' });
    expect(directFilter).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(screen.getByText('Мария Петрова')).toBeVisible();
    expect(screen.queryByText('Игра · Хаб Селигерская')).not.toBeInTheDocument();
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

  it('uses Ctrl/Cmd+Enter to send, keeps plain Enter for a newline, and ignores IME composition', () => {
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
    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true, isComposing: true });
    expect(onSendMessage).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true });
    expect(onSendMessage).toHaveBeenCalledWith('Первая строка');
    fireEvent.change(input, { target: { value: 'Вторая строка' } });
    fireEvent.keyDown(input, { key: 'Enter', metaKey: true });
    expect(onSendMessage).toHaveBeenLastCalledWith('Вторая строка');
    expect(onSendMessage).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('button', { name: /микрофон|реакц|влож/iu })).not.toBeInTheDocument();
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
    expect(screen.getByText('История обновляется', { exact: false })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Показать предыдущие сообщения' }));
    expect(onLoadEarlier).toHaveBeenCalledOnce();
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
  it.each([
    ['Турниры', 'Чаты турниров'],
    ['Станции', 'Чаты станций'],
    ['Сообщества', 'Чаты сообществ'],
  ])(
    'exposes %s without inventing conversations or an unsupported write action',
    (label, heading) => {
      const onCreateDirect = vi.fn();
      render(
        <ChatsPage
          {...defaultProps}
          mode="list"
          hasExplicitRecipient={false}
          onCreateDirect={onCreateDirect}
        />,
      );
      const filter = screen.getByRole('button', { name: label });
      fireEvent.click(filter);
      expect(filter).toHaveAttribute('aria-pressed', 'true');
      expect(screen.getByRole('status')).toHaveTextContent(heading);
      expect(screen.getByRole('status')).toHaveTextContent('ещё не подключён');
      expect(screen.queryByRole('list', { name: 'Диалоги' })).not.toBeInTheDocument();
      expect(onCreateDirect).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole('button', { name: 'Все' }));
      expect(screen.getByRole('status')).toHaveTextContent('Диалогов пока нет');
    },
  );

  it('combines unread, type and search filters without altering the supplied conversation list', () => {
    const page = {
      items: [
        {
          id: conversationId,
          kind: 'DIRECT' as const,
          participant: { userId: currentUserId, displayName: 'Анна' },
          unreadCount: 0,
          updatedAt: '2026-09-17T09:00:00Z',
        },
        {
          id: '11111111-1111-4111-8111-111111111111',
          kind: 'GAME' as const,
          contextId: '33333333-3333-4333-8333-333333333333',
          title: 'Вечерняя игра',
          unreadCount: 2,
          updatedAt: '2026-09-17T10:00:00Z',
        },
      ],
    };
    render(<ChatsPage {...defaultProps} mode="list" hasExplicitRecipient={false} page={page} />);
    const unread = screen.getByRole('button', { name: 'Только непрочитанные' });
    fireEvent.click(unread);
    expect(unread).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByText('Анна')).not.toBeInTheDocument();
    expect(screen.getByText('Вечерняя игра')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Личные' }));
    expect(screen.getByRole('status')).toHaveTextContent('Нет непрочитанных чатов');
    fireEvent.click(screen.getByRole('button', { name: 'Игры' }));
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'утро' } });
    expect(screen.getByRole('status')).toHaveTextContent('Ничего не найдено');
    fireEvent.click(screen.getByRole('button', { name: 'Очистить' }));
    expect(screen.getByText('Вечерняя игра')).toBeVisible();
    fireEvent.click(unread);
    fireEvent.click(screen.getByRole('button', { name: 'Все' }));
    expect(screen.getByText('Анна')).toBeVisible();
    expect(page.items).toHaveLength(2);
    expect(page.items[1]?.unreadCount).toBe(2);
  });

  it('keeps loading and errors distinct from planned category and empty states', () => {
    const { rerender } = render(
      <ChatsPage {...defaultProps} mode="list" hasExplicitRecipient={false} page={null} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Станции' }));
    expect(screen.getByRole('status', { name: 'Загружаем диалоги' })).toBeVisible();
    expect(screen.queryByText('Чаты станций')).not.toBeInTheDocument();
    rerender(
      <ChatsPage
        {...defaultProps}
        mode="list"
        hasExplicitRecipient={false}
        page={null}
        error={{ kind: 'RETRYABLE', message: 'Нет связи' }}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Нет связи');
    expect(screen.queryByText('Чаты станций')).not.toBeInTheDocument();
    const bottomNav = within(screen.getByRole('navigation', { name: 'Основная навигация' }));
    expect(bottomNav.queryByRole('link', { name: 'Уведомления' })).not.toBeInTheDocument();
    expect(bottomNav.getAllByRole('link')).toHaveLength(5);
    const filterRail = within(screen.getByRole('navigation', { name: 'Типы чатов' }));
    expect(filterRail.getByRole('link', { name: 'Уведомления' })).toHaveAttribute(
      'href',
      '/notifications',
    );
  });
});
