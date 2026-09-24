// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { NotificationsPage } from './NotificationsPage.js';
import type {
  ConversationSummary,
  NotificationInboxPage,
  NotificationPreferencesView,
} from './auth-gateway.js';

afterEach(cleanup);

const conversationId = '22222222-2222-4222-8222-222222222222';
const conversationAvatarUrl =
  '/public/api/v1/media/profile-photos/86afbe01-0318-4dd2-bc25-303b7bf0d430/f3d1c0e4-1111-4111-8111-111111111111';

const conversations: readonly ConversationSummary[] = [
  {
    id: conversationId,
    kind: 'DIRECT',
    participant: {
      userId: '77777777-7777-4777-8777-777777777777',
      displayName: 'Мария Соколова',
      avatarUrl: conversationAvatarUrl,
      level: 'C',
      levelValue: 3.44,
    },
    unreadCount: 3,
    updatedAt: '2026-08-29T10:05:00+03:00',
    lastMessage: {
      sequence: 12,
      body: 'Кто идёт на выходных?',
      createdAt: '2026-08-29T10:05:00+03:00',
    },
  },
];

const items: NotificationInboxPage['items'] = [
  {
    id: '11111111-1111-4111-8111-111111111111',
    category: 'MESSAGING',
    title: 'Новое сообщение',
    body: 'Откройте чат в ПадлХАБ, чтобы прочитать сообщение.',
    deepLink: `/chats/${conversationId}`,
    createdAt: '2026-08-29T10:00:00+03:00',
  },
  {
    id: '22222222-2222-4222-8222-222222222229',
    category: 'MESSAGING',
    title: 'Новое сообщение',
    body: 'Откройте чат в ПадлХАБ, чтобы прочитать сообщение.',
    deepLink: `/chats/${conversationId}`,
    createdAt: '2026-08-29T09:00:00+03:00',
    readAt: '2026-08-29T09:10:00+03:00',
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

const notificationPreferences: NotificationPreferencesView = {
  categories: [
    {
      category: 'MESSAGING',
      channels: [
        {
          channel: 'IN_APP',
          enabled: true,
          timezone: 'Europe/Moscow',
          available: true,
        },
        {
          channel: 'PUSH',
          enabled: true,
          timezone: 'Europe/Moscow',
          available: true,
          quietFrom: '23:00',
          quietUntil: '08:00',
        },
      ],
    },
    {
      category: 'ADMIN_MESSAGE',
      channels: [
        { channel: 'IN_APP', enabled: true, timezone: 'Europe/Moscow', available: true },
        { channel: 'PUSH', enabled: true, timezone: 'Europe/Moscow', available: false },
      ],
    },
    {
      category: 'FRIENDSHIP',
      channels: [
        { channel: 'IN_APP', enabled: true, timezone: 'Europe/Moscow', available: true },
        { channel: 'PUSH', enabled: true, timezone: 'Europe/Moscow', available: true },
      ],
    },
  ],
};

const defaultProps = {
  page: { unreadCount: 2, items },
  webPush: { enabled: true, publicKey: 'public-vapid-key-value' },
  browserState: 'ready' as const,
  conversations,
  busy: false,
  error: null,
  inboxUnavailable: false,
  preferences: notificationPreferences,
  preferencesBusy: false,
  preferencesError: null,
  friendRequests: [],
  friendRequestsError: null,
  outgoingFriendRequests: [],
  friendRequestBusyId: null,
  onAcceptFriendRequest: vi.fn(),
  onDeclineFriendRequest: vi.fn(),
  onEnableWebPush: vi.fn(),
  onDisableWebPush: vi.fn(),
  onSavePreferences: vi.fn(),
  onMarkAllRead: vi.fn(),
  onRetryInbox: vi.fn(),
  onOpenNotification: vi.fn(),
};

describe('NotificationsPage inbox', () => {
  it('collapses every event of one chat into a single row named after the conversation', () => {
    render(<NotificationsPage {...defaultProps} />);

    const chatRow = screen.getByRole('link', { name: /^Мария Соколова/u });
    expect(chatRow).toHaveAttribute('href', `/chats/${conversationId}`);
    expect(chatRow).toHaveTextContent('3 новых сообщения');
    expect(chatRow).toHaveTextContent('Кто идёт на выходных?');
    expect(screen.getByLabelText('Непрочитанных событий: 3')).toHaveTextContent('3');
    // The picture is a second, profile-bound link next to the row itself.
    expect(screen.getByRole('link', { name: 'Профиль игрока Мария Соколова' })).toHaveAttribute(
      'href',
      '/profile/77777777-7777-4777-8777-777777777777',
    );
    // The second message of the same chat is part of the first row, not a row of its own.
    expect(screen.getAllByRole('link', { name: /^Мария Соколова/u })).toHaveLength(1);
    expect(document.querySelector('[data-player-level-photo="source"]')).toHaveAttribute(
      'src',
      conversationAvatarUrl,
    );
    expect(document.querySelector('[data-player-level-badge]')).toHaveTextContent('C');
  });

  it('renders mapped filters while preserving unknown categories in All', () => {
    render(<NotificationsPage {...defaultProps} />);
    expect(screen.getByRole('heading', { name: 'Уведомления' })).toBeVisible();
    expect(screen.getByRole('link', { name: 'Чаты', current: 'page' })).toBeVisible();
    expect(screen.getByText('Неизвестная категория')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Игры' })).not.toBeInTheDocument();
    expect(document.querySelector('img[src*="padlhub-logo"]')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Системные' }));
    expect(screen.getByText('Рейтинг обновился')).toBeVisible();
    expect(screen.queryByRole('link', { name: /^Мария Соколова/u })).not.toBeInTheDocument();
    expect(screen.queryByText('Неизвестная категория')).not.toBeInTheDocument();
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
    expect(screen.getByRole('link', { name: /Неизвестная категория/u })).toHaveAttribute(
      'href',
      '/notifications',
    );
    expect(screen.getAllByLabelText('Непрочитанное уведомление')).toHaveLength(1);

    fireEvent.click(screen.getByRole('link', { name: /^Мария Соколова/u }));
    expect(onOpenNotification).toHaveBeenCalledWith(items[0], `/chats/${conversationId}`, true);

    fireEvent.click(screen.getByRole('button', { name: 'Прочитать все' }));
    expect(onMarkAllRead).toHaveBeenCalledOnce();
  });

  it('keeps the push call to action only while the device is not subscribed', () => {
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

    rerender(<NotificationsPage {...defaultProps} browserState="subscribed" />);
    expect(screen.queryByRole('button', { name: 'Включить push' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Отключить push' })).not.toBeInTheDocument();
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

  it('groups a chat without a matching conversation summary under the category label', () => {
    render(<NotificationsPage {...defaultProps} conversations={[]} />);

    const chatRow = screen
      .getAllByRole('link')
      .find((link) => link.getAttribute('href') === `/chats/${conversationId}`);
    expect(chatRow).toBeDefined();
    expect(chatRow).toHaveTextContent('Чат');
    expect(chatRow).toHaveTextContent('1 новое сообщение');
  });
});

describe('NotificationsPage friend requests', () => {
  const incoming = {
    requestId: '18f7c9a6-8a1b-4c27-9d0e-3e34bb4c2b91',
    userId: '6a81e965-c508-4321-812c-4be323606a70',
    displayName: 'Ирина Кузнецова',
    avatarUrl: null,
    levelLabel: 'C',
    createdAt: '2026-08-29T10:00:00+03:00',
    route: '/profile/6a81e965-c508-4321-812c-4be323606a70',
  } as const;
  const outgoing = {
    requestId: 'd0a3bd8e-1d4a-4d3a-9d21-2a1a8f9c4b77',
    userId: 'b7f0d3a2-5c6e-4c1f-9a0e-1d2c3b4a5f60',
    displayName: 'Пётр Волков',
    avatarUrl: null,
    levelLabel: 'B',
    createdAt: '2026-08-30T09:00:00+03:00',
    route: '/profile/b7f0d3a2-5c6e-4c1f-9a0e-1d2c3b4a5f60',
  } as const;

  it('shows an incoming request inside the shared feed with both commands', () => {
    const onAcceptFriendRequest = vi.fn();
    const onDeclineFriendRequest = vi.fn();
    render(
      <NotificationsPage
        {...defaultProps}
        friendRequests={[incoming]}
        onAcceptFriendRequest={onAcceptFriendRequest}
        onDeclineFriendRequest={onDeclineFriendRequest}
      />,
    );

    // One list, not a block of its own: the request sits under the same heading as the inbox rows.
    expect(screen.getByRole('heading', { name: 'Последние события' })).toBeVisible();
    expect(screen.getByText('Этот игрок хочет добавить вас в друзья.')).toBeVisible();
    expect(screen.getByText('Заявка в друзья')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Профиль игрока Ирина Кузнецова' })).toHaveAttribute(
      'href',
      '/profile/6a81e965-c508-4321-812c-4be323606a70',
    );

    fireEvent.click(screen.getByRole('button', { name: 'Добавить' }));
    expect(onAcceptFriendRequest).toHaveBeenCalledWith('18f7c9a6-8a1b-4c27-9d0e-3e34bb4c2b91');

    fireEvent.click(screen.getByRole('button', { name: 'Отказаться' }));
    expect(onDeclineFriendRequest).toHaveBeenCalledWith('18f7c9a6-8a1b-4c27-9d0e-3e34bb4c2b91');
  });

  it('replaces the projector prompt of the same request instead of showing it twice', () => {
    render(
      <NotificationsPage
        {...defaultProps}
        page={{
          unreadCount: 1,
          items: [
            {
              id: '55555555-5555-4555-8555-555555555555',
              category: 'FRIENDSHIP',
              title: 'Заявка в друзья',
              body: 'Откройте ПадлХАБ, чтобы ответить.',
              deepLink: '/notifications',
              createdAt: '2026-08-29T10:00:00+03:00',
            },
            ...items,
          ],
        }}
        friendRequests={[incoming]}
      />,
    );

    expect(screen.getByText('Ирина Кузнецова')).toBeVisible();
    expect(screen.queryByText('Откройте ПадлХАБ, чтобы ответить.')).not.toBeInTheDocument();
    // The tab stays reachable even though the only friend-request row is not an inbox item.
    expect(screen.getByRole('button', { name: 'Друзья' })).toBeVisible();
  });

  it('keeps the accepted-request notification, which is not a prompt to answer', () => {
    render(
      <NotificationsPage
        {...defaultProps}
        page={{
          unreadCount: 1,
          items: [
            {
              id: '66666666-6666-4666-8666-666666666666',
              category: 'FRIENDSHIP',
              title: 'Заявка принята',
              body: 'Теперь вы друзья в ПадлХАБ.',
              deepLink: '/profile/6a81e965-c508-4321-812c-4be323606a70',
              createdAt: '2026-08-30T10:00:00+03:00',
            },
            ...items,
          ],
        }}
      />,
    );

    expect(screen.getByText('Заявка принята')).toBeVisible();
    expect(screen.getByText('Теперь вы друзья в ПадлХАБ.')).toBeVisible();
  });

  it('renders nothing request-shaped when there is nothing to answer', () => {
    render(<NotificationsPage {...defaultProps} />);
    expect(screen.queryByRole('button', { name: 'Добавить' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Отказаться' })).not.toBeInTheDocument();
  });

  it('shows a sent request as a read-only feed row addressed to the peer', () => {
    render(<NotificationsPage {...defaultProps} outgoingFriendRequests={[outgoing]} />);

    expect(screen.getByText('Отправленная заявка')).toBeVisible();
    expect(screen.getByText('Ожидает ответа игрока.')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Профиль игрока Пётр Волков' })).toHaveAttribute(
      'href',
      '/profile/b7f0d3a2-5c6e-4c1f-9a0e-1d2c3b4a5f60',
    );
    expect(screen.queryByRole('button', { name: 'Отказаться' })).not.toBeInTheDocument();
  });
});

describe('NotificationsPage settings', () => {
  it('opens settings directly from the chats overflow menu link', () => {
    window.history.replaceState({}, '', '/notifications?view=settings');
    render(<NotificationsPage {...defaultProps} />);

    expect(screen.getByRole('heading', { name: 'Настройки уведомлений' })).toBeVisible();

    window.history.replaceState({}, '', '/notifications');
  });

  it('opens the dedicated settings screen with a switch per notification type', () => {
    render(<NotificationsPage {...defaultProps} />);

    fireEvent.click(screen.getByRole('button', { name: 'Настройки уведомлений' }));

    expect(screen.getByRole('heading', { name: 'Настройки уведомлений' })).toBeVisible();
    expect(screen.getByRole('switch', { name: 'Чаты: push-уведомления' })).toBeChecked();
    expect(screen.getByRole('switch', { name: 'Чаты: показывать в приложении' })).toBeChecked();
    // The tenant gate, not the recipient, decides whether a channel can be chosen.
    expect(
      screen.getByRole('switch', { name: 'Сообщения клуба: push-уведомления' }),
    ).toBeDisabled();
    expect(screen.getByText('23:00 – 08:00')).toBeVisible();
  });

  it('applies a push switch immediately through the replace-preferences command', () => {
    const onSavePreferences = vi.fn();
    render(<NotificationsPage {...defaultProps} onSavePreferences={onSavePreferences} />);

    fireEvent.click(screen.getByRole('button', { name: 'Настройки уведомлений' }));
    fireEvent.click(screen.getByRole('switch', { name: 'Чаты: push-уведомления' }));

    expect(onSavePreferences).toHaveBeenCalledTimes(1);
    const update = onSavePreferences.mock.calls[0]?.[0] as {
      readonly categories: readonly {
        readonly category: string;
        readonly channels: readonly {
          readonly channel: string;
          readonly enabled: boolean;
          readonly quietFrom?: string;
        }[];
      }[];
    };
    const messaging = update.categories.find((category) => category.category === 'MESSAGING');
    expect(messaging?.channels.find((channel) => channel.channel === 'PUSH')).toMatchObject({
      enabled: false,
    });
    expect(messaging?.channels.find((channel) => channel.channel === 'IN_APP')).toMatchObject({
      enabled: true,
    });
  });

  it('keeps the in-app channel as a secondary control', () => {
    const onSavePreferences = vi.fn();
    render(<NotificationsPage {...defaultProps} onSavePreferences={onSavePreferences} />);

    fireEvent.click(screen.getByRole('button', { name: 'Настройки уведомлений' }));
    fireEvent.click(screen.getByRole('switch', { name: 'Друзья: показывать в приложении' }));

    const update = onSavePreferences.mock.calls[0]?.[0] as {
      readonly categories: readonly {
        readonly category: string;
        readonly channels: readonly {
          readonly channel: string;
          readonly enabled: boolean;
          readonly quietFrom?: string;
        }[];
      }[];
    };
    const friendship = update.categories.find((category) => category.category === 'FRIENDSHIP');
    expect(friendship?.channels.find((channel) => channel.channel === 'IN_APP')).toMatchObject({
      enabled: false,
    });
    // Quiet hours belong to the push channel and must not leak into the inbox channel.
    expect(friendship?.channels.find((channel) => channel.channel === 'IN_APP')?.quietFrom).toBe(
      undefined,
    );
    expect(friendship?.channels.find((channel) => channel.channel === 'PUSH')).toMatchObject({
      quietFrom: '23:00',
      quietUntil: '08:00',
    });
  });

  it('edits the quiet window on its own screen and applies it to every push channel', () => {
    const onSavePreferences = vi.fn();
    render(<NotificationsPage {...defaultProps} onSavePreferences={onSavePreferences} />);

    fireEvent.click(screen.getByRole('button', { name: 'Настройки уведомлений' }));
    fireEvent.click(screen.getByRole('button', { name: /Тихие часы/u }));
    expect(screen.getByRole('heading', { name: 'Тихие часы' })).toBeVisible();

    fireEvent.change(screen.getByLabelText('С', { selector: 'input' }), {
      target: { value: '22:30' },
    });

    const update = onSavePreferences.mock.calls.at(-1)?.[0] as {
      readonly categories: readonly {
        readonly category: string;
        readonly channels: readonly {
          readonly channel: string;
          readonly quietFrom?: string;
          readonly quietUntil?: string;
        }[];
      }[];
    };
    for (const category of update.categories) {
      const push = category.channels.find((channel) => channel.channel === 'PUSH');
      if (push) {
        expect(push).toMatchObject({ quietFrom: '22:30', quietUntil: '08:00' });
      }
      expect(category.channels.find((channel) => channel.channel === 'IN_APP')?.quietFrom).toBe(
        undefined,
      );
    }
  });

  it('drives the device push switch from the settings screen', () => {
    const onEnableWebPush = vi.fn();
    const onDisableWebPush = vi.fn();
    const { rerender } = render(
      <NotificationsPage
        {...defaultProps}
        onEnableWebPush={onEnableWebPush}
        onDisableWebPush={onDisableWebPush}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Настройки уведомлений' }));
    fireEvent.click(screen.getByRole('switch', { name: 'Получать push-уведомления' }));
    expect(onEnableWebPush).toHaveBeenCalledOnce();

    rerender(
      <NotificationsPage
        {...defaultProps}
        browserState="subscribed"
        onEnableWebPush={onEnableWebPush}
        onDisableWebPush={onDisableWebPush}
      />,
    );
    // The settings screen stays open across the rerender, so the switch is already on screen.
    fireEvent.click(screen.getByRole('switch', { name: 'Получать push-уведомления' }));
    expect(onDisableWebPush).toHaveBeenCalledOnce();
  });

  it('keeps the settings screen usable when the preference request failed', () => {
    render(
      <NotificationsPage
        {...defaultProps}
        preferences={null}
        preferencesError="Настройки недоступны."
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Настройки уведомлений' }));
    expect(screen.getByText('Настройки недоступны.')).toBeVisible();
    expect(
      screen.queryByRole('switch', { name: 'Чаты: push-уведомления' }),
    ).not.toBeInTheDocument();
  });
});
