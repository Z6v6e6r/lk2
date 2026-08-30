import { useState } from 'react';

import { MainBottomNavigation } from './HomeDashboardPage.js';
import type { NotificationInboxPage, WebPushConfiguration } from './auth-gateway.js';
import { NotificationFilters } from './notifications-ui/NotificationFilters.js';
import { NotificationList } from './notifications-ui/NotificationList.js';
import {
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
  readonly onEnableWebPush: () => void;
  readonly onDisableWebPush: () => void;
  readonly onMarkAllRead: () => void;
}

function pushStatus(
  configuration: WebPushConfiguration,
  browserState: WebPushBrowserState,
): string {
  if (!configuration.enabled) return 'Push пока не включён для этой организации.';
  if (browserState === 'unsupported') return 'Этот браузер не поддерживает Web Push.';
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
  onEnableWebPush,
  onDisableWebPush,
  onMarkAllRead,
}: NotificationsPageProps): React.JSX.Element {
  const [filter, setFilter] = useState<NotificationFilter>('ALL');
  const filters = notificationFilters(page.items);
  const selectedFilter = filters.some((item) => item.value === filter) ? filter : 'ALL';
  const canEnable =
    webPush.enabled &&
    browserState !== 'unsupported' &&
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
          </div>
          {browserState === 'subscribed' ? (
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
        <NotificationList page={page} filter={selectedFilter} />
      </section>
      <MainBottomNavigation active="notifications" />
    </main>
  );
}
