import type { ConversationSummary } from '../auth-gateway.js';
import { ChatAvatar } from './ChatAvatar.js';
import { conversationTitle, formatConversationTimestamp, unreadLabel } from './chat-format.js';
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
        <ChatAvatar
          isGame={conversation.kind === 'GAME'}
          title={title}
          photoUrl={conversation.kind === 'DIRECT' ? conversation.participant.avatarUrl : undefined}
          level={conversation.kind === 'DIRECT' ? conversation.participant.level : undefined}
          levelValue={
            conversation.kind === 'DIRECT' ? conversation.participant.levelValue : undefined
          }
          fallbackSeed={
            conversation.kind === 'DIRECT' ? conversation.participant.userId : conversation.id
          }
          size={48}
        />
        <span className={styles.listCopy}>
          <span
            className={`${styles.listTitle} ${conversation.kind === 'GAME' ? styles.gameTitle : ''}`}
          >
            {title}
          </span>
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
