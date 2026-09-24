import type { ProfileFriendRequestSummary } from '../auth-gateway.js';
import { ChatAvatar } from '../chats-ui/ChatAvatar.js';
import { formatNotificationTime } from './notification-format.js';
import styles from './NotificationsUi.module.css';

interface FriendRequestListItemProps {
  readonly request: ProfileFriendRequestSummary;
  readonly direction: 'incoming' | 'outgoing';
  /** One answer at a time: the page holds the request id of the command in flight. */
  readonly busyRequestId: string | null;
  readonly busy: boolean;
  readonly onAccept: (requestId: string) => void;
  readonly onDecline: (requestId: string) => void;
}

/**
 * A friend request rendered as a chat row in the shared feed: same avatar, same title/subtitle/body
 * rhythm as a conversation row, plus the two commands a request needs. The avatar opens the sender's
 * profile exactly like a direct conversation row.
 */
export function FriendRequestListItem({
  request,
  direction,
  busyRequestId,
  busy,
  onAccept,
  onDecline,
}: FriendRequestListItemProps): React.JSX.Element {
  const answered = busyRequestId === request.requestId;
  const disabled = busy || busyRequestId !== null;
  const subtitle = direction === 'incoming' ? 'Заявка в друзья' : 'Отправленная заявка';
  const body =
    direction === 'incoming' ? 'Этот игрок хочет добавить вас в друзья.' : 'Ожидает ответа игрока.';

  return (
    <li className={styles.listItem}>
      <article className={styles.friendRequestRow}>
        <a
          className={styles.friendRequestAvatarLink}
          href={request.route}
          aria-label={`Профиль игрока ${request.displayName}`}
        >
          <ChatAvatar
            isGame={false}
            title={request.displayName}
            photoUrl={request.avatarUrl}
            level={request.levelLabel}
            fallbackSeed={request.userId}
            size={48}
            className={styles.notificationAvatar}
          />
        </a>
        <div className={styles.itemCopy}>
          <span className={styles.itemTitle}>{request.displayName}</span>
          <span className={styles.itemSubtitle}>{subtitle}</span>
          <span className={styles.itemBody}>{body}</span>
          <time dateTime={request.createdAt}>{formatNotificationTime(request.createdAt)}</time>
          {direction === 'incoming' ? (
            <div className={styles.friendRequestActions}>
              <button type="button" disabled={disabled} onClick={() => onAccept(request.requestId)}>
                {answered ? 'Добавляем…' : 'Добавить'}
              </button>
              <button
                type="button"
                className={styles.friendRequestDecline}
                disabled={disabled}
                onClick={() => onDecline(request.requestId)}
              >
                Отказаться
              </button>
            </div>
          ) : null}
        </div>
      </article>
    </li>
  );
}
