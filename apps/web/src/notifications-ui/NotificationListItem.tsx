import type { NotificationItem } from './notification-format.js';
import {
  formatNotificationTime,
  notificationCategory,
  safeNotificationDeepLink,
} from './notification-format.js';
import styles from './NotificationsUi.module.css';

export function NotificationListItem({
  item,
}: {
  readonly item: NotificationItem;
}): React.JSX.Element {
  const presentation = notificationCategory(item.category);
  const href = safeNotificationDeepLink(item.deepLink);

  return (
    <li className={styles.listItem}>
      <a className={item.readAt ? styles.readItem : styles.unreadItem} href={href}>
        <span
          className={`${styles.categoryMarker} ${styles[`tone-${presentation.tone}`] ?? ''}`}
          aria-hidden="true"
        >
          {presentation.marker}
        </span>
        <span className={styles.itemCopy}>
          <span className={styles.itemTitle}>{item.title}</span>
          <span className={styles.itemBody}>{item.body}</span>
          <time dateTime={item.createdAt}>{formatNotificationTime(item.createdAt)}</time>
        </span>
        <span className={styles.itemMeta}>
          <span>{presentation.categoryLabel}</span>
          {!item.readAt ? <i aria-label="Непрочитанное уведомление" /> : null}
        </span>
      </a>
    </li>
  );
}
