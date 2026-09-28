import type { ConversationSummary } from '../auth-gateway.js';
import { ChatAvatar } from './ChatAvatar.js';
import {
  conversationTitle,
  formatConversationTimestamp,
  formatGameSchedule,
  unreadLabel,
} from './chat-format.js';
import styles from './ChatsUi.module.css';

interface ChatListItemProps {
  readonly conversation: ConversationSummary;
  readonly selected: boolean;
}

export function ChatListItem({ conversation, selected }: ChatListItemProps): React.JSX.Element {
  const title = conversationTitle(conversation);
  const unread = unreadLabel(conversation.unreadCount);
  const activityAt = conversation.lastMessage?.createdAt ?? conversation.updatedAt;
  // A game is identified by place and time, so its row shows the schedule instead of repeating the
  // last message; direct and other group chats keep their message preview.
  const gameSchedule = conversation.kind === 'GAME' ? formatGameSchedule(conversation) : null;
  const preview = gameSchedule ?? conversation.lastMessage?.body ?? 'Новый диалог';
  // The list doubles the roster circles, so a game row gives the stack its own column instead of the
  // shared 48px avatar slot.
  const gameRoster = conversation.kind === 'GAME' ? (conversation.participants ?? []) : [];

  const avatar = (
    <ChatAvatar
      isGame={conversation.kind === 'GAME'}
      title={title}
      photoUrl={conversation.kind === 'DIRECT' ? conversation.participant.avatarUrl : undefined}
      level={conversation.kind === 'DIRECT' ? conversation.participant.level : undefined}
      levelValue={conversation.kind === 'DIRECT' ? conversation.participant.levelValue : undefined}
      fallbackSeed={
        conversation.kind === 'DIRECT' ? conversation.participant.userId : conversation.id
      }
      {...(gameRoster.length > 0 ? { participants: gameRoster, wideStack: true } : {})}
      size={48}
    />
  );

  return (
    <li
      className={`${styles.listItem} ${styles.chatRow} ${
        gameRoster.length > 0 ? styles.rosterChatRow : ''
      } ${selected ? styles.selectedChatRow : ''}`}
    >
      {conversation.kind === 'DIRECT' ? (
        <a
          className={styles.profileAvatarLink}
          href={`/profile/${encodeURIComponent(conversation.participant.userId)}`}
          aria-label={`Профиль игрока ${title}`}
        >
          {avatar}
        </a>
      ) : (
        <a
          className={styles.profileAvatarLink}
          href={`/chats/${encodeURIComponent(conversation.id)}`}
          aria-label={`Открыть чат ${title}`}
        >
          {avatar}
        </a>
      )}
      <a
        className={selected ? styles.selectedListLink : styles.listLink}
        href={`/chats/${encodeURIComponent(conversation.id)}`}
        aria-current={selected ? 'page' : undefined}
      >
        <span className={styles.listCopy}>
          <span
            className={`${styles.listTitle} ${conversation.kind === 'GAME' ? styles.gameTitle : ''}`}
          >
            {title}
          </span>
          <span className={styles.listPreview}>{preview}</span>
        </span>
        <span className={styles.listMeta}>
          <time dateTime={activityAt}>{formatConversationTimestamp(activityAt)}</time>
          {unread ? (
            <span
              className={styles.unreadBadge}
              aria-label={`Непрочитанных сообщений: ${conversation.unreadCount}`}
            >
              {unread}
            </span>
          ) : null}
        </span>
      </a>
    </li>
  );
}
