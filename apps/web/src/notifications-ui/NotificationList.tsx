import type { NotificationInboxPage } from '../auth-gateway.js';
import { NotificationListItem } from './NotificationListItem.js';
import type { NotificationFilter } from './notification-format.js';
import { notificationMatchesFilter, type NotificationItem } from './notification-format.js';
import styles from './NotificationsUi.module.css';

interface NotificationListProps {
  readonly page: NotificationInboxPage;
  readonly filter: NotificationFilter;
  readonly onOpen: (item: NotificationItem, href: string, navigate: boolean) => void;
}

export function NotificationList({
  page,
  filter,
  onOpen,
}: NotificationListProps): React.JSX.Element {
  const items = page.items.filter((item) => notificationMatchesFilter(item, filter));

  if (page.items.length === 0) {
    return (
      <div className={styles.emptyState} role="status">
        <strong>Пока тихо</strong>
        <p>Новые системные события появятся здесь.</p>
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className={styles.emptyState} role="status">
        <strong>В этой категории пусто</strong>
        <p>Все события остаются доступными во вкладке «Все».</p>
      </div>
    );
  }

  return (
    <ul className={styles.list} aria-label="Лента уведомлений">
      {items.map((item) => (
        <NotificationListItem key={item.id} item={item} onOpen={onOpen} />
      ))}
    </ul>
  );
}
