import type {
  ConversationSummary,
  NotificationInboxPage,
  ProfileFriendRequestSummary,
} from '../auth-gateway.js';
import { FriendRequestListItem } from './FriendRequestListItem.js';
import { NotificationListItem } from './NotificationListItem.js';
import type {
  NotificationFeedEntry,
  NotificationFilter,
  NotificationGroup,
} from './notification-format.js';
import { notificationFeedEntries, notificationFeedMatchesFilter } from './notification-format.js';
import styles from './NotificationsUi.module.css';

interface NotificationListProps {
  readonly groups: readonly NotificationGroup[];
  readonly conversations: ReadonlyMap<string, ConversationSummary>;
  readonly filter: NotificationFilter;
  readonly incomingFriendRequests: readonly ProfileFriendRequestSummary[];
  readonly outgoingFriendRequests: readonly ProfileFriendRequestSummary[];
  readonly friendRequestBusyId: string | null;
  readonly busy: boolean;
  readonly onAcceptFriendRequest: (requestId: string) => void;
  readonly onDeclineFriendRequest: (requestId: string) => void;
  readonly onOpen: (
    item: NotificationInboxPage['items'][number],
    href: string,
    navigate: boolean,
  ) => void;
}

export function NotificationList({
  groups,
  conversations,
  filter,
  incomingFriendRequests,
  outgoingFriendRequests,
  friendRequestBusyId,
  busy,
  onAcceptFriendRequest,
  onDeclineFriendRequest,
  onOpen,
}: NotificationListProps): React.JSX.Element {
  const allEntries: readonly NotificationFeedEntry[] = notificationFeedEntries({
    groups,
    incomingFriendRequests,
    outgoingFriendRequests,
  });
  const visible = allEntries.filter((entry) => notificationFeedMatchesFilter(entry, filter));

  if (allEntries.length === 0) {
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
      {visible.map((entry) => {
        if (entry.kind === 'friend-request') {
          return (
            <FriendRequestListItem
              key={entry.key}
              request={entry.request}
              direction={entry.direction}
              busyRequestId={friendRequestBusyId}
              busy={busy}
              onAccept={onAcceptFriendRequest}
              onDecline={onDeclineFriendRequest}
            />
          );
        }
        const conversation =
          entry.group.kind === 'conversation' && entry.group.sourceId
            ? conversations.get(entry.group.sourceId)
            : undefined;
        return (
          <NotificationListItem
            key={entry.key}
            group={entry.group}
            conversation={conversation}
            onOpen={onOpen}
          />
        );
      })}
    </ul>
  );
}
