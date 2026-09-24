// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ChatsPage, type StationSupportSource } from './ChatsPage.js';
import type { StationSupportMessage, StationSupportMessagePage } from './auth-gateway.js';
import styles from './chats-ui/ChatsUi.module.css';

const conversationId = '22222222-2222-4222-8222-222222222222';
const currentUserId = '49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca';
const stationUuid = '9b993668-ff54-4cce-8dfd-cad84c4a06fa';
const stationDialogId = '33333333-3333-4333-8333-333333333333';
const otherStationUuid = '11111111-1111-4111-8111-111111111111';
const unmappedDialogId = '44444444-4444-4444-8444-444444444444';

/**
 * `noUncheckedIndexedAccess` widens every CSS module lookup to `string | undefined`, so the lookup
 * is guarded here: a renamed or deleted layout class must fail the test instead of comparing
 * `undefined` against the shell and passing by accident.
 */
function layoutClass(name: string): string {
  const value = styles[name];
  if (!value) throw new Error(`the chats CSS module has no ${name} class`);
  return value;
}

/**
 * One chronological page: the server states whether older messages remain and issues the cursor for
 * them, so a page that claims more history always carries a `nextBefore`.
 */
function stationMessagesPage(
  items: readonly StationSupportMessage[] = [],
  nextBefore?: string,
): StationSupportMessagePage {
  return {
    items,
    hasMore: nextBefore !== undefined,
    ...(nextBefore ? { nextBefore } : {}),
  };
}

function stationSource(overrides: Partial<StationSupportSource> = {}): StationSupportSource {
  return {
    loadStations: vi.fn().mockResolvedValue([]),
    loadDialogs: vi.fn().mockResolvedValue([]),
    loadMessages: vi.fn().mockResolvedValue(stationMessagesPage()),
    sendMessage: vi.fn().mockRejectedValue(new Error('SUPPORT_PROVIDER_UNAVAILABLE')),
    uploadAttachment: vi.fn().mockRejectedValue(new Error('SUPPORT_ATTACHMENTS_UNAVAILABLE')),
    loadAttachment: vi.fn().mockRejectedValue(new Error('SUPPORT_ATTACHMENT_NOT_FOUND')),
    createMessageId: () => 'station-message-000001',
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  try {
    window.sessionStorage.clear();
  } catch {
    // jsdom can expose an opaque storage origin in isolated test runs.
  }
});

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
  policyBusy: false,
  attachments: [],
  attachmentNotice: null,
  loadMedia: () => Promise.resolve(new Blob(['attachment-bytes'])),
  onCreateDirect: vi.fn(),
  onAttachFiles: vi.fn(),
  onRemoveAttachment: vi.fn(),
  onSendMessage: vi.fn(),
  onRetrySend: vi.fn(),
  onRefresh: vi.fn(),
  onLoadEarlier: vi.fn(),
  onSetNotificationPolicy: vi.fn(),
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

    expect(onSendMessage).toHaveBeenCalledWith({ body: 'Новое сообщение', attachmentIds: [] });
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

  it('retries the failed direct start from its own banner instead of reloading chats', () => {
    const onCreateDirect = vi.fn();
    const onRefresh = vi.fn();
    render(
      <ChatsPage
        {...defaultProps}
        mode="new"
        hasExplicitRecipient
        error={{
          kind: 'PARTICIPANT_UNAVAILABLE',
          message: 'У игрока ещё не открыт доступ к личным чатам: он не увидит этот диалог.',
        }}
        onCreateDirect={onCreateDirect}
        onRefresh={onRefresh}
      />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent('Получатель недоступен');
    expect(screen.getByRole('alert')).toHaveTextContent(
      'У игрока ещё не открыт доступ к личным чатам: он не увидит этот диалог.',
    );

    fireEvent.click(screen.getByRole('button', { name: 'Повторить' }));
    expect(onCreateDirect).toHaveBeenCalledOnce();
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it('names a refused recipient on the direct-start screen instead of a missing chat', () => {
    render(
      <ChatsPage
        {...defaultProps}
        mode="new"
        hasExplicitRecipient
        error={{ kind: 'NOT_FOUND', message: 'Получатель недоступен для личного чата.' }}
      />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent('Получатель недоступен');
    expect(screen.getByRole('alert')).not.toHaveTextContent('Чат недоступен');
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
    const search = screen.getByRole('searchbox', { name: 'Поиск по чатам' });
    expect(search).toHaveFocus();
    await user.type(search, 'мария');
    await user.tab();
    expect(screen.getByRole('button', { name: 'Очистить' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Только непрочитанные' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Все' })).toHaveFocus();
    // Станции sits right after "Все" in the rail, so the keyboard order follows the visual order.
    await user.tab();
    expect(screen.getByRole('button', { name: 'Станции' })).toHaveFocus();
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

    const link = screen.getByRole('link', { name: /^Борис/u });
    expect(link).toHaveAttribute('href', `/chats/${conversationId}`);
    expect(link).toHaveAttribute('aria-current', 'page');
    expect(screen.getByLabelText('Непрочитанных сообщений: 100')).toHaveTextContent('99+');
  });

  it('shows the stored participant photo in the list row and the thread header', () => {
    const photoUrl =
      '/public/api/v1/media/profile-photos/86afbe01-0318-4dd2-bc25-303b7bf0d430/f3d1c0e4-1111-4111-8111-111111111111';
    const { container } = render(
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
              participant: {
                userId: '11111111-1111-4111-8111-111111111111',
                displayName: 'Борис',
                avatarUrl: photoUrl,
              },
              unreadCount: 0,
              updatedAt: '2026-08-29T11:32:00+03:00',
            },
          ],
        }}
      />,
    );

    const photos = [...container.querySelectorAll('img')];
    expect(photos).toHaveLength(2);
    for (const photo of photos) {
      expect(photo).toHaveAttribute('src', photoUrl);
      expect(photo).toHaveAttribute('alt', '');
    }
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
    expect(onSendMessage).toHaveBeenCalledWith({ body: 'Первая строка', attachmentIds: [] });
    fireEvent.change(input, { target: { value: 'Вторая строка' } });
    fireEvent.keyDown(input, { key: 'Enter', metaKey: true });
    expect(onSendMessage).toHaveBeenLastCalledWith({ body: 'Вторая строка', attachmentIds: [] });
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
    expect(screen.getByText('У вас пока нет чатов')).toBeVisible();

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
    fireEvent.click(screen.getByRole('button', { name: 'Игры' }));
    expect(screen.getByText('В этой категории пока нет чатов')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Все' }));
    fireEvent.change(screen.getByRole('searchbox', { name: 'Поиск по чатам' }), {
      target: { value: 'несуществующий' },
    });
    expect(screen.getByText('По запросу ничего не найдено')).toBeVisible();
  });

  it('restores the chat view filter and query within the current session', () => {
    const page = {
      items: [
        {
          id: conversationId,
          kind: 'DIRECT' as const,
          participant: { userId: currentUserId, displayName: 'Анна' },
          unreadCount: 0,
          updatedAt: '2026-09-17T09:00:00Z',
        },
      ],
    };
    const first = render(
      <ChatsPage {...defaultProps} mode="list" hasExplicitRecipient={false} page={page} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Личные' }));
    fireEvent.change(screen.getByRole('searchbox', { name: 'Поиск по чатам' }), {
      target: { value: 'Анна' },
    });
    first.unmount();

    render(<ChatsPage {...defaultProps} mode="list" hasExplicitRecipient={false} page={page} />);
    expect(screen.getByRole('button', { name: 'Личные' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('searchbox', { name: 'Поиск по чатам' })).toHaveValue('Анна');
  });
  it.each([
    ['Турниры', 'Чаты турниров'],
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
      expect(screen.getByRole('status')).toHaveTextContent('У вас пока нет чатов');
    },
  );

  it('keeps the station tab unconnected when no station source is wired', () => {
    render(<ChatsPage {...defaultProps} mode="list" hasExplicitRecipient={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'Станции' }));
    expect(screen.getByRole('status')).toHaveTextContent('Чаты станций');
    expect(screen.getByRole('status')).toHaveTextContent('ещё не подключён');
  });

  it('lists station dialogs, opens a thread and sends a message', async () => {
    const sendMessage = vi.fn().mockResolvedValue({
      dialogId: stationDialogId,
      message: {
        id: '99999999-9999-4999-8999-999999999999',
        body: 'Здравствуйте',
        author: 'ME',
        authorName: null,
        createdAt: '2026-09-22T12:00:00.000Z',
        attachments: [],
      },
      replayed: false,
    });
    const source = stationSource({
      loadStations: vi.fn().mockResolvedValue([{ id: stationUuid, name: 'Ясенево' }]),
      loadDialogs: vi.fn().mockResolvedValue([
        {
          id: stationDialogId,
          stationId: stationUuid,
          stationName: 'Ясенево',
          status: 'OPEN',
          updatedAt: '2026-09-22T10:00:00.000Z',
          lastMessage: {
            preview: 'Когда свободен корт?',
            author: 'STATION',
            createdAt: '2026-09-22T10:00:00.000Z',
          },
        },
      ]),
      loadMessages: vi.fn().mockResolvedValue(
        stationMessagesPage([
          {
            id: '88888888-8888-4888-8888-888888888888',
            body: 'Когда свободен корт?',
            author: 'STATION',
            authorName: 'Поддержка ПадлХАБ',
            createdAt: '2026-09-22T10:00:00.000Z',
            attachments: [],
          },
        ]),
      ),
      sendMessage,
    });
    render(
      <ChatsPage
        {...defaultProps}
        mode="list"
        hasExplicitRecipient={false}
        stationSupport={source}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Станции' }));
    expect(await screen.findByRole('list', { name: 'Станции и каналы ПадлХАБ' })).toBeVisible();
    expect(screen.getByText('Когда свободен корт?')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: /Ясенево/ }));
    expect(await screen.findByText('Когда свободен корт?')).toBeVisible();
    const composer = screen.getByLabelText('Сообщение');
    await userEvent.type(composer, 'Здравствуйте');
    fireEvent.submit(composer.closest('form') as HTMLFormElement);
    await waitFor(() =>
      expect(sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ text: 'Здравствуйте', dialogId: stationDialogId }),
      ),
    );
    // The station composer accepts pictures now, and the answer names the operator who wrote it.
    expect(screen.getByRole('button', { name: 'Прикрепить файл' })).toBeVisible();
    expect(screen.getByText('Поддержка ПадлХАБ')).toBeVisible();
  });

  it('shows a station dialog with correspondence in the unfiltered tab and opens it from there', async () => {
    const source = stationSource({
      loadStations: vi.fn().mockResolvedValue([{ id: stationUuid, name: 'Ясенево' }]),
      loadDialogs: vi.fn().mockResolvedValue([
        {
          id: stationDialogId,
          stationId: stationUuid,
          stationName: 'Ясенево',
          status: 'OPEN',
          updatedAt: '2026-09-22T10:00:00.000Z',
          lastMessage: {
            preview: 'Когда свободен корт?',
            author: 'STATION',
            createdAt: '2026-09-22T10:00:00.000Z',
          },
        },
      ]),
      loadMessages: vi.fn().mockResolvedValue(
        stationMessagesPage([
          {
            id: '88888888-8888-4888-8888-888888888888',
            body: 'Корт свободен в 19:00.',
            author: 'STATION',
            authorName: 'Поддержка ПадлХАБ',
            createdAt: '2026-09-22T10:00:00.000Z',
            attachments: [],
          },
        ]),
      ),
    });
    render(
      <ChatsPage
        {...defaultProps}
        mode="list"
        hasExplicitRecipient={false}
        stationSupport={source}
      />,
    );

    const list = await screen.findByRole('list', { name: 'Диалоги' });
    const row = await within(list).findByRole('button', { name: /Ясенево/ });
    expect(within(row).getByText('Когда свободен корт?')).toBeVisible();

    fireEvent.click(row);
    // The thread lives in the station block, so opening the row switches the rail to it.
    expect(screen.getByRole('button', { name: 'Станции' })).toHaveAttribute('aria-pressed', 'true');
    expect(await screen.findByText('Корт свободен в 19:00.')).toBeVisible();
  });

  it('reads a station thread backwards page by page and keeps older messages above the newest', async () => {
    const cursor = '2026-09-22T10:00:00.000Z';
    const loadMessages = vi
      .fn()
      .mockResolvedValueOnce(
        stationMessagesPage(
          [
            {
              id: '88888888-8888-4888-8888-888888888888',
              body: 'Новое сообщение',
              author: 'STATION',
              authorName: null,
              createdAt: '2026-09-22T10:00:00.000Z',
              attachments: [],
            },
          ],
          cursor,
        ),
      )
      .mockResolvedValueOnce(
        stationMessagesPage([
          {
            id: '99999999-9999-4999-8999-999999999999',
            body: 'Старое сообщение',
            author: 'ME',
            authorName: null,
            createdAt: '2026-09-21T10:00:00.000Z',
            attachments: [],
          },
        ]),
      );
    const source = stationSource({
      loadStations: vi.fn().mockResolvedValue([{ id: stationUuid, name: 'Ясенево' }]),
      loadDialogs: vi.fn().mockResolvedValue([
        {
          id: stationDialogId,
          stationId: stationUuid,
          stationName: 'Ясенево',
          status: 'OPEN',
          updatedAt: '2026-09-22T10:00:00.000Z',
          lastMessage: {
            preview: 'Новое сообщение',
            author: 'STATION',
            createdAt: '2026-09-22T10:00:00.000Z',
          },
        },
      ]),
      loadMessages,
    });
    const { container } = render(
      <ChatsPage
        {...defaultProps}
        mode="list"
        hasExplicitRecipient={false}
        stationSupport={source}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Станции' }));
    fireEvent.click(await screen.findByRole('button', { name: /Ясенево/ }));
    expect(await screen.findByText('Новое сообщение')).toBeVisible();
    expect(loadMessages).toHaveBeenNthCalledWith(1, stationDialogId);

    // Reaching the top of the history pulls the page before the oldest message already read, using
    // the cursor the server issued rather than a display timestamp.
    const timeline = container.querySelector('ol');
    expect(timeline).not.toBeNull();
    fireEvent.scroll(timeline as HTMLOListElement);
    await waitFor(() => expect(loadMessages).toHaveBeenNthCalledWith(2, stationDialogId, cursor));

    expect(await screen.findByText('Старое сообщение')).toBeVisible();
    const bodies = [...(timeline as HTMLOListElement).querySelectorAll('p')].map(
      (node) => node.textContent,
    );
    expect(bodies).toEqual(['Старое сообщение', 'Новое сообщение']);
    // A short page ends the walk, so the control disappears instead of promising more history.
    expect(screen.queryByRole('button', { name: 'Показать предыдущие сообщения' })).toBeNull();
  });

  it('stops walking a station history whose page adds nothing new', async () => {
    const repeated = {
      id: '88888888-8888-4888-8888-888888888888',
      body: 'Новое сообщение',
      author: 'STATION' as const,
      authorName: null,
      createdAt: '2026-09-22T10:00:00.000Z',
      attachments: [],
    };
    const loadMessages = vi
      .fn()
      .mockResolvedValueOnce(stationMessagesPage([repeated], '2026-09-22T10:00:00.000Z'))
      .mockResolvedValue(stationMessagesPage([repeated], '2026-09-21T10:00:00.000Z'));
    const source = stationSource({
      loadStations: vi.fn().mockResolvedValue([{ id: stationUuid, name: 'Ясенево' }]),
      loadDialogs: vi.fn().mockResolvedValue([
        {
          id: stationDialogId,
          stationId: stationUuid,
          stationName: 'Ясенево',
          status: 'OPEN',
          updatedAt: '2026-09-22T10:00:00.000Z',
          lastMessage: {
            preview: 'Новое сообщение',
            author: 'STATION',
            createdAt: '2026-09-22T10:00:00.000Z',
          },
        },
      ]),
      loadMessages,
    });
    const { container } = render(
      <ChatsPage
        {...defaultProps}
        mode="list"
        hasExplicitRecipient={false}
        stationSupport={source}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Станции' }));
    fireEvent.click(await screen.findByRole('button', { name: /Ясенево/ }));
    expect(await screen.findByText('Новое сообщение')).toBeVisible();

    const timeline = container.querySelector('ol') as HTMLOListElement;
    fireEvent.scroll(timeline);
    await waitFor(() => expect(loadMessages).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('button', { name: 'Показать предыдущие сообщения' })).toBeNull();
    // The repeated page is not rendered twice: the row preview and the one bubble stay the only ones.
    expect(within(timeline).getAllByText('Новое сообщение')).toHaveLength(1);
  });

  it('uploads a picture, sends it with its id and renders the operator picture', async () => {
    const attachmentId = 'c'.repeat(43);
    const operatorAttachmentId = 'd'.repeat(43);
    const uploadAttachment = vi.fn().mockResolvedValue({
      id: attachmentId,
      fileName: 'корт.png',
      contentType: 'image/webp',
      byteSize: 2048,
      url: `/user/api/v1/tenant/support/attachments/${attachmentId}/content`,
    });
    const loadAttachment = vi
      .fn()
      .mockResolvedValue(new Blob(['webp-bytes'], { type: 'image/webp' }));
    const sendMessage = vi.fn().mockResolvedValue({
      dialogId: stationDialogId,
      message: null,
      replayed: false,
    });
    const source = stationSource({
      loadStations: vi.fn().mockResolvedValue([{ id: stationUuid, name: 'Ясенево' }]),
      loadDialogs: vi.fn().mockResolvedValue([
        {
          id: stationDialogId,
          stationId: stationUuid,
          stationName: 'Ясенево',
          status: 'OPEN',
          updatedAt: '2026-09-22T10:00:00.000Z',
          lastMessage: null,
        },
      ]),
      loadMessages: vi.fn().mockResolvedValue(
        stationMessagesPage([
          {
            id: '88888888-8888-4888-8888-888888888888',
            body: '',
            author: 'STATION',
            authorName: 'ПадлХАБ • Супервайзер',
            createdAt: '2026-09-22T10:00:00.000Z',
            attachments: [
              {
                id: operatorAttachmentId,
                fileName: 'мяч.webp',
                contentType: 'image/webp',
                byteSize: 4096,
                url: `/user/api/v1/tenant/support/attachments/${operatorAttachmentId}/content`,
              },
            ],
          },
        ]),
      ),
      sendMessage,
      uploadAttachment,
      loadAttachment,
    });
    render(
      <ChatsPage
        {...defaultProps}
        mode="list"
        hasExplicitRecipient={false}
        stationSupport={source}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Станции' }));
    fireEvent.click(await screen.findByRole('button', { name: /Ясенево/ }));

    // The picture the operator sent arrives as an authorized blob, never as a raw provider URL.
    const operatorImage = await screen.findByAltText('мяч.webp');
    expect(loadAttachment).toHaveBeenCalledWith(operatorAttachmentId);
    expect(operatorImage.getAttribute('src')).toMatch(/^blob:/u);

    const file = new File([new Uint8Array([1, 2, 3, 4])], 'корт.png', { type: 'image/png' });
    fireEvent.change(screen.getByLabelText('Выбрать файлы для прикрепления'), {
      target: { files: [file] },
    });
    await waitFor(() =>
      expect(uploadAttachment).toHaveBeenCalledWith(
        expect.objectContaining({ fileName: 'корт.png', contentType: 'image/png' }),
      ),
    );
    await screen.findByText('корт.png');

    const composer = screen.getByLabelText('Сообщение');
    await userEvent.type(composer, 'Смотрите корт');
    fireEvent.submit(composer.closest('form') as HTMLFormElement);
    await waitFor(() =>
      expect(sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          text: 'Смотрите корт',
          attachmentIds: [attachmentId],
          dialogId: stationDialogId,
        }),
      ),
    );
  });

  it('retries a failed station send with the same command id instead of a new one', async () => {
    const sendMessage = vi
      .fn()
      .mockRejectedValueOnce(new Error('SUPPORT_PROVIDER_UNAVAILABLE'))
      .mockResolvedValueOnce({ dialogId: stationDialogId, message: null, replayed: true });
    const source = stationSource({
      loadStations: vi.fn().mockResolvedValue([{ id: stationUuid, name: 'Ясенево' }]),
      loadDialogs: vi.fn().mockResolvedValue([
        {
          id: stationDialogId,
          stationId: stationUuid,
          stationName: 'Ясенево',
          status: 'OPEN',
          updatedAt: null,
          lastMessage: null,
        },
      ]),
      loadMessages: vi.fn().mockResolvedValue(stationMessagesPage()),
      sendMessage,
      createMessageId: () => 'station-message-000009',
    });
    render(
      <ChatsPage
        {...defaultProps}
        mode="list"
        hasExplicitRecipient={false}
        stationSupport={source}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Станции' }));
    fireEvent.click(await screen.findByRole('button', { name: /Ясенево/ }));
    const composer = screen.getByLabelText('Сообщение');
    await userEvent.type(composer, 'Здравствуйте');
    fireEvent.submit(composer.closest('form') as HTMLFormElement);
    const retry = await screen.findByRole('button', { name: 'Повторить отправку' });
    fireEvent.click(retry);
    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(2));
    expect(sendMessage.mock.calls[0]?.[0]).toMatchObject({
      clientMessageId: 'station-message-000009',
    });
    expect(sendMessage.mock.calls[1]?.[0]).toMatchObject({
      clientMessageId: 'station-message-000009',
      text: 'Здравствуйте',
    });
  });

  it('closes the composer for a closed dialog and hides a pointless retry', async () => {
    const source = stationSource({
      loadStations: vi.fn().mockResolvedValue([{ id: stationUuid, name: 'Ясенево' }]),
      loadDialogs: vi.fn().mockResolvedValue([
        {
          id: stationDialogId,
          stationId: stationUuid,
          stationName: 'Ясенево',
          status: 'CLOSED',
          updatedAt: null,
          lastMessage: null,
        },
      ]),
    });
    render(
      <ChatsPage
        {...defaultProps}
        mode="list"
        hasExplicitRecipient={false}
        stationSupport={source}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Станции' }));
    fireEvent.click(await screen.findByRole('button', { name: /Ясенево/ }));
    expect(await screen.findByText(/Обращение закрыто/)).toBeVisible();
    expect(screen.getByLabelText('Сообщение')).toBeDisabled();
  });

  it('does not refetch station messages when the parent re-renders with the same source', async () => {
    const loadMessages = vi.fn().mockResolvedValue(stationMessagesPage());
    const source = stationSource({
      loadStations: vi.fn().mockResolvedValue([{ id: stationUuid, name: 'Ясенево' }]),
      loadDialogs: vi.fn().mockResolvedValue([
        {
          id: stationDialogId,
          stationId: stationUuid,
          stationName: 'Ясенево',
          status: 'OPEN',
          updatedAt: null,
          lastMessage: null,
        },
      ]),
      loadMessages,
    });
    const { rerender } = render(
      <ChatsPage
        {...defaultProps}
        mode="list"
        hasExplicitRecipient={false}
        stationSupport={source}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Станции' }));
    fireEvent.click(await screen.findByRole('button', { name: /Ясенево/ }));
    await waitFor(() => expect(loadMessages).toHaveBeenCalledTimes(1));
    rerender(
      <ChatsPage
        {...defaultProps}
        mode="list"
        hasExplicitRecipient={false}
        stationSupport={source}
      />,
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(loadMessages).toHaveBeenCalledTimes(1);
  });

  it('shows a terminal station refusal without a retry action', async () => {
    const source = stationSource({
      loadStations: vi.fn().mockResolvedValue([{ id: stationUuid, name: 'Ясенево' }]),
      loadDialogs: vi.fn().mockResolvedValue([
        {
          id: stationDialogId,
          stationId: stationUuid,
          stationName: 'Ясенево',
          status: 'OPEN',
          updatedAt: null,
          lastMessage: null,
        },
      ]),
      loadMessages: vi.fn().mockResolvedValue(stationMessagesPage()),
      sendMessage: vi.fn().mockRejectedValue(
        Object.assign(new Error('rejected'), {
          status: 422,
          code: 'SUPPORT_MESSAGE_REJECTED',
        }),
      ),
    });
    render(
      <ChatsPage
        {...defaultProps}
        mode="list"
        hasExplicitRecipient={false}
        stationSupport={source}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Станции' }));
    fireEvent.click(await screen.findByRole('button', { name: /Ясенево/ }));
    const composer = screen.getByLabelText('Сообщение');
    await userEvent.type(composer, 'Здравствуйте');
    fireEvent.submit(composer.closest('form') as HTMLFormElement);
    expect(await screen.findByText(/отклонила обращение/)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Повторить отправку' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Обновить' })).not.toBeInTheDocument();
  });

  it('lists every published station and starts a dialog by tapping it', async () => {
    const sendMessage = vi.fn().mockResolvedValue({
      dialogId: stationDialogId,
      message: null,
      replayed: false,
    });
    const loadMessages = vi.fn().mockResolvedValue(stationMessagesPage());
    const source = stationSource({
      loadStations: vi.fn().mockResolvedValue([
        { id: stationUuid, name: 'Ясенево' },
        { id: otherStationUuid, name: 'Нагатинская' },
      ]),
      loadDialogs: vi.fn().mockResolvedValue([]),
      loadMessages,
      sendMessage,
    });
    render(
      <ChatsPage
        {...defaultProps}
        mode="list"
        hasExplicitRecipient={false}
        stationSupport={source}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Станции' }));
    const list = await screen.findByRole('list', { name: 'Станции и каналы ПадлХАБ' });
    expect(within(list).getByText('Ясенево')).toBeVisible();
    expect(within(list).getByText('Нагатинская')).toBeVisible();
    expect(within(list).getAllByText('Начните переписку')).toHaveLength(2);

    fireEvent.click(within(list).getByRole('button', { name: /Ясенево/ }));
    const composer = screen.getByLabelText('Сообщение');
    await userEvent.type(composer, 'Здравствуйте');
    fireEvent.submit(composer.closest('form') as HTMLFormElement);
    await waitFor(() =>
      expect(sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ text: 'Здравствуйте', stationId: stationUuid }),
      ),
    );
    await waitFor(() => expect(loadMessages).toHaveBeenCalledWith(stationDialogId));
  });

  it('swaps the phone shell onto the station thread once a station is picked', async () => {
    const source = stationSource({
      loadStations: vi.fn().mockResolvedValue([{ id: stationUuid, name: 'Ясенево' }]),
      loadDialogs: vi.fn().mockResolvedValue([]),
      loadMessages: vi.fn().mockResolvedValue(stationMessagesPage()),
    });
    render(
      <ChatsPage
        {...defaultProps}
        mode="list"
        hasExplicitRecipient={false}
        stationSupport={source}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Станции' }));
    const shell = screen.getByRole('region', { name: 'Чаты' });
    expect(shell).toHaveClass(layoutClass('listMode'));

    fireEvent.click(await screen.findByRole('button', { name: /Ясенево/ }));

    // On a phone `.listMode .thread` is `display: none`, so a station picked from the list only
    // becomes visible when the shell itself leaves list mode.
    await waitFor(() => expect(shell).toHaveClass(layoutClass('threadMode')));
    expect(shell).not.toHaveClass(layoutClass('listMode'));
    expect(screen.getByRole('region', { name: 'Диалог со станцией Ясенево' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Назад к чатам' })).toBeInTheDocument();
    expect(
      screen.getByRole('region', { name: 'Диалог со станцией Ясенево' }).querySelector('header'),
    ).toHaveClass(layoutClass('stationThreadHeader'));
  });

  it('filters the station list and keeps an unmapped dialog visible', async () => {
    const source = stationSource({
      loadStations: vi.fn().mockResolvedValue([
        { id: stationUuid, name: 'Ясенево' },
        { id: otherStationUuid, name: 'Нагатинская' },
      ]),
      loadDialogs: vi.fn().mockResolvedValue([
        {
          id: stationDialogId,
          stationId: stationUuid,
          stationName: 'Ясенево',
          status: 'OPEN',
          updatedAt: '2026-09-22T10:00:00.000Z',
          lastMessage: {
            preview: 'Когда свободен корт?',
            author: 'STATION',
            createdAt: '2026-09-22T10:00:00.000Z',
          },
        },
        {
          id: unmappedDialogId,
          stationId: null,
          stationName: 'Без станции',
          status: 'OPEN',
          updatedAt: null,
          lastMessage: null,
        },
      ]),
      loadMessages: vi.fn().mockResolvedValue(stationMessagesPage()),
    });
    render(
      <ChatsPage
        {...defaultProps}
        mode="list"
        hasExplicitRecipient={false}
        stationSupport={source}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Станции' }));
    const list = await screen.findByRole('list', { name: 'Станции и каналы ПадлХАБ' });
    expect(within(list).getByText('Когда свободен корт?')).toBeVisible();
    expect(within(list).getByText('Без станции')).toBeVisible();

    fireEvent.change(screen.getByRole('searchbox', { name: 'Поиск по чатам' }), {
      target: { value: 'нагат' },
    });
    expect(within(list).getByText('Нагатинская')).toBeVisible();
    expect(within(list).queryByText('Ясенево')).not.toBeInTheDocument();
    expect(within(list).queryByText('Без станции')).not.toBeInTheDocument();

    fireEvent.change(screen.getByRole('searchbox', { name: 'Поиск по чатам' }), {
      target: { value: 'ничего' },
    });
    expect(screen.getByRole('status')).toHaveTextContent('Ничего не найдено');
  });

  it('reports a disabled station feature with the feature-unavailable copy', async () => {
    const source = stationSource({
      loadDialogs: vi
        .fn()
        .mockRejectedValue(
          Object.assign(new Error('disabled'), { status: 404, code: 'SUPPORT_STATIONS_DISABLED' }),
        ),
    });
    render(
      <ChatsPage
        {...defaultProps}
        mode="list"
        hasExplicitRecipient={false}
        stationSupport={source}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Станции' }));
    expect(await screen.findByText(/ещё не включены для этой организации/)).toBeVisible();
  });

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
    expect(screen.getByRole('status')).toHaveTextContent('По запросу ничего не найдено');
    fireEvent.click(screen.getByRole('button', { name: 'Очистить' }));
    expect(screen.getByText('Вечерняя игра')).toBeVisible();
    fireEvent.click(unread);
    fireEvent.click(screen.getByRole('button', { name: 'Все' }));
    expect(screen.getByText('Анна')).toBeVisible();
    expect(page.items).toHaveLength(2);
    expect(page.items[1]?.unreadCount).toBe(2);
  });

  it('keeps loading and errors distinct from planned category and empty states', () => {
    const source = stationSource({
      loadStations: vi.fn().mockReturnValue(new Promise(() => undefined)),
      loadDialogs: vi.fn().mockReturnValue(new Promise(() => undefined)),
    });
    const { rerender } = render(
      <ChatsPage
        {...defaultProps}
        mode="list"
        hasExplicitRecipient={false}
        page={null}
        stationSupport={source}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Станции' }));
    expect(screen.getByRole('status', { name: 'Загружаем чаты станций' })).toBeVisible();
    expect(screen.queryByText('Обращений к станциям пока нет')).not.toBeInTheDocument();
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
    const bottomNav = within(screen.getByRole('navigation', { name: 'Основная навигация' }));
    expect(bottomNav.queryByRole('link', { name: 'Уведомления' })).not.toBeInTheDocument();
    expect(bottomNav.getAllByRole('link')).toHaveLength(5);
    const filterRail = within(screen.getByRole('navigation', { name: 'Типы чатов' }));
    expect(filterRail.getByRole('link', { name: 'Уведомления' })).toHaveAttribute(
      'href',
      '/notifications',
    );
  });

  it('offers a bounded mute from the thread header and reports the stored policy', () => {
    const onSetNotificationPolicy = vi.fn();
    render(
      <ChatsPage
        {...defaultProps}
        mode="thread"
        selectedConversationId={conversationId}
        hasExplicitRecipient={false}
        onSetNotificationPolicy={onSetNotificationPolicy}
        page={{
          items: [
            {
              id: conversationId,
              kind: 'GAME',
              contextId: '33333333-3333-4333-8333-333333333333',
              title: 'Игра в среду',
              unreadCount: 0,
              updatedAt: '2026-07-26T12:00:00.000Z',
              notificationPolicy: { level: 'ALL', muted: false },
            },
          ],
        }}
      />,
    );

    const bell = screen.getByRole('button', { name: 'Уведомления включены' });
    fireEvent.click(bell);
    const menu = screen.getByRole('menu', { name: 'Уведомления в этом чате' });
    expect(within(menu).getByRole('menuitemradio', { name: 'Включены' })).toHaveAttribute(
      'aria-checked',
      'true',
    );

    const before = Date.now();
    fireEvent.click(within(menu).getByRole('menuitemradio', { name: 'Выключить на 8 часов' }));

    expect(onSetNotificationPolicy).toHaveBeenCalledTimes(1);
    const update = onSetNotificationPolicy.mock.calls[0]?.[0] as {
      readonly level: string;
      readonly mutedUntil: string;
    };
    expect(update.level).toBe('ALL');
    const mutedUntil = Date.parse(update.mutedUntil);
    expect(mutedUntil).toBeGreaterThan(before);
    expect(mutedUntil).toBeLessThanOrEqual(before + 8 * 60 * 60 * 1_000 + 1_000);
    // The menu closes after a choice so the thread stays usable.
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('shows a muted thread and lets the member turn notifications back on', () => {
    const onSetNotificationPolicy = vi.fn();
    render(
      <ChatsPage
        {...defaultProps}
        mode="thread"
        selectedConversationId={conversationId}
        hasExplicitRecipient={false}
        onSetNotificationPolicy={onSetNotificationPolicy}
        page={{
          items: [
            {
              id: conversationId,
              kind: 'DIRECT',
              participant: { userId: '11111111-1111-4111-8111-111111111111', displayName: 'Борис' },
              unreadCount: 2,
              updatedAt: '2026-07-26T12:00:00.000Z',
              notificationPolicy: {
                level: 'ALL',
                muted: true,
                mutedUntil: '2026-07-27T04:00:00.000Z',
              },
            },
          ],
        }}
      />,
    );

    expect(screen.getByText(/уведомления выключены/)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Уведомления выключены' }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Включены' }));

    expect(onSetNotificationPolicy).toHaveBeenCalledWith({ level: 'ALL' });
  });

  it('disables the notification control while an HTTP policy is still unknown', () => {
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
              title: 'Игра в среду',
              unreadCount: 0,
              updatedAt: '2026-07-26T12:00:00.000Z',
            },
          ],
        }}
      />,
    );

    expect(
      screen.getByRole('button', { name: 'Уведомления в этом чате ещё не загружены' }),
    ).toBeDisabled();
  });
});
