import { useState } from 'react';

import { MainBottomNavigation } from './HomeDashboardPage.js';
import type {
  NotificationInboxPage,
  ProfileFriendRequestSummary,
  WebPushConfiguration,
} from './auth-gateway.js';
import { NotificationFilters } from './notifications-ui/NotificationFilters.js';
import { NotificationList } from './notifications-ui/NotificationList.js';
import {
  type NotificationItem,
  type NotificationFilter,
  notificationFilters,
} from './notifications-ui/notification-format.js';
import styles from './notifications-ui/NotificationsUi.module.css';
import type { WebPushBrowserState } from './web-push-client.js';

interface NotificationsPageProps {
  readonly page: NotificationInboxPage;
  readonly webPush: WebPushConfiguration;
  readonly browserState: WebPushBrowserState;
  readonly busy: boolean;
  readonly error?: string | null;
  readonly inboxUnavailable: boolean;
  readonly friendRequests: readonly ProfileFriendRequestSummary[];
  readonly friendRequestsError?: string | null;
  readonly friendRequestBusyId: string | null;
  readonly onAcceptFriendRequest: (requestId: string) => void;
  readonly onDeclineFriendRequest: (requestId: string) => void;
  readonly onEnableWebPush: () => void;
  readonly onDisableWebPush: () => void;
  readonly onMarkAllRead: () => void;
  readonly onRetryInbox: () => void;
  readonly onOpenNotification: (item: NotificationItem, href: string, navigate: boolean) => void;
}

function pushStatus(
  configuration: WebPushConfiguration,
  browserState: WebPushBrowserState,
): string {
  if (!configuration.enabled) return 'Push пока не включён для этой организации.';
  if (browserState === 'unsupported') return 'Этот браузер не поддерживает Web Push.';
  if (browserState === 'needs_install')
    return 'На iPhone и iPad push работает только из приложения на экране «Домой».';
  if (browserState === 'denied') return 'Уведомления запрещены в настройках браузера.';
  if (browserState === 'subscribed') return 'Push-уведомления включены на этом устройстве.';
  return 'Включите push, чтобы получать события при закрытом кабинете.';
}

export function NotificationsPage({
  page,
  webPush,
  browserState,
  busy,
  error,
  inboxUnavailable,
  friendRequests,
  friendRequestsError,
  friendRequestBusyId,
  onAcceptFriendRequest,
  onDeclineFriendRequest,
  onEnableWebPush,
  onDisableWebPush,
  onMarkAllRead,
  onRetryInbox,
  onOpenNotification,
}: NotificationsPageProps): React.JSX.Element {
  const [filter, setFilter] = useState<NotificationFilter>('ALL');
  const filters = notificationFilters(page.items);
  const selectedFilter = filters.some((item) => item.value === filter) ? filter : 'ALL';
  const canEnable =
    webPush.enabled &&
    browserState !== 'unsupported' &&
    browserState !== 'needs_install' &&
    browserState !== 'denied' &&
    browserState !== 'subscribed';

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
        </header>

        <section className={styles.pushPanel} aria-labelledby="web-push-title">
          <div>
            <h2 id="web-push-title">Уведомления на устройстве</h2>
            <p>{pushStatus(webPush, browserState)}</p>
            {browserState === 'needs_install' ? (
              <p className={styles.pushHint}>
                Откройте PadlHub в Safari, нажмите «Поделиться» → «На экран „Домой“» и включите push
                уже из приложения: только так iOS разрешает уведомления.
              </p>
            ) : null}
          </div>
          {browserState === 'needs_install' ? null : browserState === 'subscribed' ? (
            <button type="button" disabled={busy} onClick={onDisableWebPush}>
              {busy ? 'Отключаем…' : 'Отключить push'}
            </button>
          ) : (
            <button type="button" disabled={busy || !canEnable} onClick={onEnableWebPush}>
              {busy ? 'Включаем…' : 'Включить push'}
            </button>
          )}
        </section>

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
            <NotificationList page={page} filter={selectedFilter} onOpen={onOpenNotification} />
          </>
        )}
      </section>
      <MainBottomNavigation active="notifications" />
    </main>
  );
}
