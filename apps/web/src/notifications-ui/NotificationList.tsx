import type { ConversationSummary, NotificationInboxPage } from '../auth-gateway.js';
import { NotificationListItem } from './NotificationListItem.js';
import type { NotificationFilter, NotificationGroup } from './notification-format.js';
import { notificationGroupsForFilter } from './notification-format.js';
import styles from './NotificationsUi.module.css';

interface NotificationListProps {
  readonly page: NotificationInboxPage;
  readonly groups: readonly NotificationGroup[];
  readonly conversations: ReadonlyMap<string, ConversationSummary>;
  readonly filter: NotificationFilter;
  readonly onOpen: (
    item: NotificationInboxPage['items'][number],
    href: string,
    navigate: boolean,
  ) => void;
}

export function NotificationList({
  page,
  groups,
  conversations,
  filter,
  onOpen,
}: NotificationListProps): React.JSX.Element {
  const visible = notificationGroupsForFilter(groups, filter);

  if (page.items.length === 0) {
    return (
      <div className={styles.emptyState} role="status">
        <strong>Пока тихо</strong>
        <p>Новые системные события появятся здесь.</p>
      </div>
    );
  }

  if (visible.length === 0) {
    return (
      <div className={styles.emptyState} role="status">
        <strong>В этой категории пусто</strong>
        <p>Все события остаются доступными во вкладке «Все».</p>
      </div>
    );
  }

  return (
    <ul className={styles.list} aria-label="Лента уведомлений">
      {visible.map((group) => {
        const conversation =
          group.kind === 'conversation' && group.sourceId
            ? conversations.get(group.sourceId)
            : undefined;
        return (
          <NotificationListItem
            key={group.key}
            group={group}
            conversation={conversation}
            onOpen={onOpen}
          />
        );
      })}
    </ul>
  );
}
