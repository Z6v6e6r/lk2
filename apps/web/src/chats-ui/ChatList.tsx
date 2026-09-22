import type { ConversationPage } from '../auth-gateway.js';
import { ChatCategoryIcon } from './ChatCategoryIcon.js';
import type { ChatFilter } from './ChatFilters.js';
import { ChatListItem } from './ChatListItem.js';
import { conversationTitle } from './chat-format.js';
import styles from './ChatsUi.module.css';

interface ChatListProps {
  readonly page: ConversationPage | null;
  readonly error: boolean;
  readonly filter: ChatFilter;
  readonly query: string;
  readonly unreadOnly: boolean;
  readonly selectedConversationId?: string;
}

export function ChatList({
  page,
  error,
  filter,
  query,
  unreadOnly,
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

  // These categories are planned UI destinations, not conversation kinds accepted by the API.
  // The station destination is served by the provider-backed `StationDialogList` instead.
  if (filter === 'TOURNAMENT' || filter === 'COMMUNITY') {
    const labels = {
      TOURNAMENT: 'Чаты турниров',
      COMMUNITY: 'Чаты сообществ',
    };
    return (
      <div className={styles.emptyState} role="status">
        <span className={styles.emptyIcon} aria-hidden="true">
          <ChatCategoryIcon name={filter} />
        </span>
        <strong>{labels[filter]}</strong>
        <p>Этот тип чатов ещё не подключён. Здесь появятся обсуждения с участниками.</p>
      </div>
    );
  }

  const normalizedQuery = query.trim().toLocaleLowerCase('ru-RU');
  const conversations = page.items.filter((conversation) => {
    if (unreadOnly && conversation.unreadCount <= 0) return false;
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
        <p>Начните общение из профиля игрока или откройте чат в карточке своей игры.</p>
      </div>
    );
  }

  if (conversations.length === 0 && unreadOnly && !normalizedQuery) {
    return (
      <div className={styles.emptyState} role="status">
        <strong>Нет непрочитанных чатов</strong>
        <p>Все сообщения в этой категории прочитаны.</p>
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
