import type { ConversationPage } from '../auth-gateway.js';
import type { ChatFilter } from './ChatFilters.js';
import { ChatListItem } from './ChatListItem.js';
import { conversationTitle } from './chat-format.js';
import styles from './ChatsUi.module.css';

interface ChatListProps {
  readonly page: ConversationPage | null;
  readonly error: boolean;
  readonly filter: ChatFilter;
  readonly query: string;
  readonly selectedConversationId?: string;
}

export function ChatList({
  page,
  error,
  filter,
  query,
  selectedConversationId,
}: ChatListProps): React.JSX.Element {
  if (!page && !error) {
    return (
      <div className={styles.skeletonList} role="status" aria-label="Загружаем диалоги">
        {Array.from({ length: 5 }, (_, index) => (
          <span key={index} className={styles.skeletonRow} aria-hidden="true" />
        ))}
      </div>
    );
  }

  if (!page || error) return <div className={styles.listSpacer} />;

  const normalizedQuery = query.trim().toLocaleLowerCase('ru-RU');
  const conversations = page.items.filter((conversation) => {
    if (filter !== 'ALL' && conversation.kind !== filter) return false;
    if (!normalizedQuery) return true;
    return [conversationTitle(conversation), conversation.lastMessage?.body ?? ''].some((value) =>
      value.toLocaleLowerCase('ru-RU').includes(normalizedQuery),
    );
  });

  if (page.items.length === 0) {
    return (
      <div className={styles.emptyState} role="status">
        <strong>Диалогов пока нет</strong>
        <p>Личный чат откроется по безопасной ссылке из профиля или карточки игры.</p>
      </div>
    );
  }

  if (conversations.length === 0) {
    return (
      <div className={styles.emptyState} role="status">
        <strong>Ничего не найдено</strong>
        <p>Измените запрос или выберите другой тип чатов.</p>
      </div>
    );
  }

  return (
    <ul className={styles.list} aria-label="Диалоги">
      {conversations.map((conversation) => (
        <ChatListItem
          key={conversation.id}
          conversation={conversation}
          selected={conversation.id === selectedConversationId}
        />
      ))}
    </ul>
  );
}
