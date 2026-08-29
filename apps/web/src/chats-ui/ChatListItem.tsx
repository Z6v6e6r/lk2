import { ChatIcon } from '../HomeDashboardPage.js';
import type { ConversationSummary } from '../auth-gateway.js';
import {
  conversationTitle,
  formatConversationTimestamp,
  initials,
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

  return (
    <li className={styles.listItem}>
      <a
        className={selected ? styles.selectedListLink : styles.listLink}
        href={`/chats/${encodeURIComponent(conversation.id)}`}
        aria-current={selected ? 'page' : undefined}
      >
        <span
          className={`${styles.avatar} ${conversation.kind === 'GAME' ? styles.gameAvatar : ''}`}
          aria-hidden="true"
        >
          {conversation.kind === 'GAME' ? <ChatIcon /> : initials(title)}
        </span>
        <span className={styles.listCopy}>
          <span className={styles.listTitle}>{title}</span>
          <span className={styles.listPreview}>
            {conversation.lastMessage?.body ?? 'Новый диалог'}
          </span>
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
