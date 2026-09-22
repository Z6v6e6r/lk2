import { useEffect, useRef } from 'react';

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
  const normalizedQuery = query.trim().toLocaleLowerCase('ru-RU');
  const scrollStorageKey = `lk2:chats:list-scroll:${filter}:${unreadOnly ? 'unread' : 'all'}:${normalizedQuery}`;
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    try {
      const savedScrollTop = Number(window.sessionStorage.getItem(scrollStorageKey));
      if (Number.isFinite(savedScrollTop) && savedScrollTop > 0) list.scrollTop = savedScrollTop;
    } catch {
      // Storage can be unavailable in private browsing and embedded previews.
    }
    return () => {
      if (!list) return;
      try {
        window.sessionStorage.setItem(scrollStorageKey, String(list.scrollTop));
      } catch {
        // Storage can be unavailable in private browsing and embedded previews.
      }
    };
  }, [scrollStorageKey, page?.items.length]);

  const handleScroll = (event: React.UIEvent<HTMLUListElement>): void => {
    try {
      window.sessionStorage.setItem(scrollStorageKey, String(event.currentTarget.scrollTop));
    } catch {
      // Storage can be unavailable in private browsing and embedded previews.
    }
  };

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
        <strong>У вас пока нет чатов</strong>
        <p>Начните общение из профиля игрока или откройте чат в карточке своей игры.</p>
      </div>
    );
  }

  if (conversations.length === 0 && normalizedQuery) {
    return (
      <div className={styles.emptyState} role="status">
        <strong>По запросу ничего не найдено</strong>
        <p>Измените запрос или очистите поле поиска.</p>
      </div>
    );
  }

  if (conversations.length === 0 && unreadOnly) {
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
        <strong>В этой категории пока нет чатов</strong>
        <p>Выберите другую категорию или начните новый диалог из профиля игрока.</p>
      </div>
    );
  }

  return (
    <ul className={styles.list} aria-label="Диалоги" ref={listRef} onScroll={handleScroll}>
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
