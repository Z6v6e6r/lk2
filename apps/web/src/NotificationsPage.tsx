import { useMemo, useState } from 'react';

import { MainBottomNavigation } from './HomeDashboardPage.js';
import type {
  ConversationSummary,
  NotificationInboxPage,
  NotificationPreferencesUpdateRequest,
  NotificationPreferencesView,
  ProfileFriendRequestSummary,
  WebPushConfiguration,
} from './auth-gateway.js';
import { NotificationFilters } from './notifications-ui/NotificationFilters.js';
import { NotificationIcon } from './notifications-ui/NotificationIcon.js';
import { NotificationList } from './notifications-ui/NotificationList.js';
import { NotificationQuietHoursScreen } from './notifications-ui/NotificationQuietHoursScreen.js';
import { NotificationSettingsScreen } from './notifications-ui/NotificationSettingsScreen.js';
import {
  notificationConversationIndex,
  notificationFilters,
  groupNotifications,
  type NotificationItem,
  type NotificationFilter,
} from './notifications-ui/notification-format.js';
import {
  canToggleNotificationPush,
  draftFromView,
  notificationPushStatus,
  requestFromDraft,
  type PreferenceDraft,
} from './notifications-ui/notification-preferences.js';
import styles from './notifications-ui/NotificationsUi.module.css';
import type { WebPushBrowserState } from './web-push-client.js';

interface NotificationsPageProps {
  readonly page: NotificationInboxPage;
  readonly webPush: WebPushConfiguration;
  readonly browserState: WebPushBrowserState;
  readonly conversations: readonly ConversationSummary[];
  readonly busy: boolean;
  readonly error?: string | null;
  readonly inboxUnavailable: boolean;
  readonly preferences: NotificationPreferencesView | null;
  readonly preferencesBusy: boolean;
  readonly preferencesError?: string | null;
  readonly friendRequests: readonly ProfileFriendRequestSummary[];
  readonly friendRequestsError?: string | null;
  readonly outgoingFriendRequests: readonly ProfileFriendRequestSummary[];
  readonly friendRequestBusyId: string | null;
  readonly onAcceptFriendRequest: (requestId: string) => void;
  readonly onDeclineFriendRequest: (requestId: string) => void;
  readonly onEnableWebPush: () => void;
  readonly onDisableWebPush: () => void;
  readonly onSavePreferences: (update: NotificationPreferencesUpdateRequest) => void;
  readonly onMarkAllRead: () => void;
  readonly onRetryInbox: () => void;
  readonly onOpenNotification: (item: NotificationItem, href: string, navigate: boolean) => void;
}

type NotificationView = 'inbox' | 'settings' | 'quiet-hours';

export function NotificationsPage({
  page,
  webPush,
  browserState,
  conversations,
  busy,
  error,
  inboxUnavailable,
  preferences,
  preferencesBusy,
  preferencesError,
  friendRequests,
  friendRequestsError,
  outgoingFriendRequests,
  friendRequestBusyId,
  onAcceptFriendRequest,
  onDeclineFriendRequest,
  onEnableWebPush,
  onDisableWebPush,
  onSavePreferences,
  onMarkAllRead,
  onRetryInbox,
  onOpenNotification,
}: NotificationsPageProps): React.JSX.Element {
  const [view, setView] = useState<NotificationView>('inbox');
  const [filter, setFilter] = useState<NotificationFilter>('ALL');

  // The draft follows the stored server view. React re-renders before committing the render-phase
  // update, so every stored answer — including one that repeats the previous values — resets the
  // switches without a state-syncing effect. The identity of the stored view is the trigger, so a
  // repeated answer still counts as a new answer.
  const [draftState, setDraftState] = useState<{
    readonly signature: NotificationPreferencesView | null;
    readonly draft: PreferenceDraft | null;
  }>(() => ({
    signature: preferences,
    draft: preferences ? draftFromView(preferences) : null,
  }));
  if (draftState.signature !== preferences) {
    setDraftState({
      signature: preferences,
      draft: preferences ? draftFromView(preferences) : null,
    });
  }
  const draft = draftState.draft;

  const groups = useMemo(() => groupNotifications(page.items), [page.items]);
  const conversationIndex = useMemo(
    () => notificationConversationIndex(conversations),
    [conversations],
  );
  const filters = notificationFilters(page.items);
  const selectedFilter = filters.some((item) => item.value === filter) ? filter : 'ALL';
  const subscribed = browserState === 'subscribed';
  const canEnablePush = canToggleNotificationPush(webPush, browserState);
  // The inbox keeps the call to action only while it is still actionable; a subscribed device
  // manages push from the settings screen.
  const showPushPanel = !subscribed || !webPush.enabled;

  function applyDraft(next: PreferenceDraft): void {
    setDraftState({ signature: preferences, draft: next });
    onSavePreferences(requestFromDraft(next));
  }

  if (view === 'settings') {
    return (
      <main className={styles.page}>
        <NotificationSettingsScreen
          draft={draft}
          busy={preferencesBusy}
          error={preferencesError}
          webPush={webPush}
          browserState={browserState}
          onEnableWebPush={onEnableWebPush}
          onDisableWebPush={onDisableWebPush}
          onOpenQuietHours={() => setView('quiet-hours')}
          onApplyDraft={applyDraft}
          onBack={() => setView('inbox')}
        />
        <MainBottomNavigation active="notifications" />
      </main>
    );
  }

  if (view === 'quiet-hours' && draft) {
    return (
      <main className={styles.page}>
        <NotificationQuietHoursScreen
          draft={draft}
          busy={preferencesBusy}
          onApplyDraft={applyDraft}
          onBack={() => setView('settings')}
        />
        <MainBottomNavigation active="notifications" />
      </main>
    );
  }

  return (
    <main className={styles.page}>
      <section className={styles.shell}>
        <header className={styles.header}>
          <a href="/chats" aria-label="Назад к чатам">
            <span aria-hidden="true">←</span>
          </a>
          <h1>Уведомления</h1>
          <span aria-label={`Непрочитанных уведомлений: ${page.unreadCount}`}>
            {page.unreadCount > 99 ? '99+' : page.unreadCount}
          </span>
          <button
            type="button"
            className={styles.headerAction}
            aria-label="Настройки уведомлений"
            onClick={() => setView('settings')}
          >
            <NotificationIcon name="gear" />
          </button>
        </header>

        {showPushPanel ? (
          <section className={styles.pushPanel} aria-labelledby="web-push-title">
            <div>
              <h2 id="web-push-title">Уведомления на устройстве</h2>
              <p>{notificationPushStatus(webPush, browserState)}</p>
              {browserState === 'needs_install' ? (
                <p className={styles.pushHint}>
                  Откройте PadlHub в Safari, нажмите «Поделиться» → «На экран „Домой“» и включите
                  push уже из приложения: только так iOS разрешает уведомления.
                </p>
              ) : null}
            </div>
            {browserState === 'needs_install' ? null : subscribed ? (
              <button type="button" disabled={busy} onClick={onDisableWebPush}>
                {busy ? 'Отключаем…' : 'Отключить push'}
              </button>
            ) : (
              <button type="button" disabled={busy || !canEnablePush} onClick={onEnableWebPush}>
                {busy ? 'Включаем…' : 'Включить push'}
              </button>
            )}
          </section>
        ) : null}

        {error ? (
          <p className={styles.error} role="alert">
            {error}
          </p>
        ) : null}

        {friendRequestsError ? (
          <p className={styles.error} role="alert">
            {friendRequestsError}
          </p>
        ) : null}

        {friendRequests.length > 0 ? (
          <section className={styles.friendRequests} aria-labelledby="friend-requests-title">
            <header className={styles.listHeader}>
              <h2 id="friend-requests-title">Заявки в друзья</h2>
              <span className={styles.friendRequestCount}>{friendRequests.length}</span>
            </header>
            <ul className={styles.friendRequestList}>
              {friendRequests.map((request) => (
                <li className={styles.friendRequestCard} key={request.requestId}>
                  <a className={styles.friendRequestPerson} href={request.route}>
                    <strong>{request.displayName}</strong>
                    <small>хочет добавить вас в друзья</small>
                  </a>
                  <div className={styles.friendRequestActions}>
                    <button
                      type="button"
                      disabled={busy || friendRequestBusyId !== null}
                      onClick={() => onAcceptFriendRequest(request.requestId)}
                    >
                      {friendRequestBusyId === request.requestId ? 'Добавляем…' : 'Добавить'}
                    </button>
                    <button
                      type="button"
                      className={styles.friendRequestDecline}
                      disabled={busy || friendRequestBusyId !== null}
                      onClick={() => onDeclineFriendRequest(request.requestId)}
                    >
                      Отказаться
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {outgoingFriendRequests.length > 0 ? (
          <section
            className={styles.friendRequests}
            aria-labelledby="outgoing-friend-requests-title"
          >
            <header className={styles.listHeader}>
              <h2 id="outgoing-friend-requests-title">Отправленные заявки</h2>
              <span className={styles.friendRequestCount}>{outgoingFriendRequests.length}</span>
            </header>
            <ul className={styles.friendRequestList}>
              {outgoingFriendRequests.map((request) => (
                <li className={styles.friendRequestCard} key={request.requestId}>
                  <a className={styles.friendRequestPerson} href={request.route}>
                    <strong>{request.displayName}</strong>
                    <small>ожидает ответа</small>
                  </a>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {inboxUnavailable ? (
          <div className={styles.emptyState} role="status">
            <strong>Лента недоступна</strong>
            <p>Не удалось получить события. Проверьте соединение и повторите загрузку.</p>
            <button
              type="button"
              className={styles.markAllButton}
              disabled={busy}
              onClick={onRetryInbox}
            >
              {busy ? 'Повторяем…' : 'Повторить'}
            </button>
          </div>
        ) : (
          <>
            <NotificationFilters filters={filters} selected={selectedFilter} onChange={setFilter} />
            <header className={styles.listHeader}>
              <h2>Последние события</h2>
              {page.unreadCount > 0 && page.items.length > 0 ? (
                <button
                  type="button"
                  className={styles.markAllButton}
                  disabled={busy}
                  onClick={onMarkAllRead}
                >
                  Прочитать все
                </button>
              ) : null}
            </header>
            <NotificationList
              page={page}
              groups={groups}
              conversations={conversationIndex}
              filter={selectedFilter}
              onOpen={onOpenNotification}
            />
          </>
        )}
      </section>
      <MainBottomNavigation active="notifications" />
    </main>
  );
}
