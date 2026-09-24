import { useEffect, useRef } from 'react';

import type { ConversationPage } from '../auth-gateway.js';
import { ChatCategoryIcon } from './ChatCategoryIcon.js';
import type { ChatFilter } from './ChatFilters.js';
import { ChatListItem } from './ChatListItem.js';
import { StationChatRowItem } from './StationChatRowItem.js';
import { conversationTitle } from './chat-format.js';
import type { StationHistoryRow } from './station-chat-rows.js';
import styles from './ChatsUi.module.css';

interface ChatListProps {
  readonly page: ConversationPage | null;
  readonly error: boolean;
  readonly filter: ChatFilter;
  readonly query: string;
  readonly unreadOnly: boolean;
  /**
   * Station dialogs that already carry correspondence. They belong to the unfiltered tab, because a
   * waiting station answer is a chat like any other; the station block still owns their thread.
   */
  readonly stationRows: readonly StationHistoryRow[];
  readonly onOpenStation: (dialogId: string) => void;
  readonly selectedConversationId?: string;
}

/** An unreadable or absent timestamp sorts last instead of jumping the row to the top. */
function recency(value: string | null | undefined): number {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

export function ChatList({
  page,
  error,
  filter,
  query,
  unreadOnly,
  stationRows,
  onOpenStation,
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
  // A station dialog carries no unread marker of its own, so a read-state filter cannot judge it.
  const stationHistory = filter === 'ALL' && !unreadOnly ? stationRows : [];

  if (conversations.length === 0 && stationHistory.length === 0) {
    if (page.items.length === 0) {
      return (
        <div className={styles.emptyState} role="status">
          <strong>У вас пока нет чатов</strong>
          <p>Начните общение из профиля игрока или откройте чат в карточке своей игры.</p>
        </div>
      );
    }
    if (normalizedQuery) {
      return (
        <div className={styles.emptyState} role="status">
          <strong>По запросу ничего не найдено</strong>
          <p>Измените запрос или очистите поле поиска.</p>
        </div>
      );
    }
    if (unreadOnly) {
      return (
        <div className={styles.emptyState} role="status">
          <strong>Нет непрочитанных чатов</strong>
          <p>Все сообщения в этой категории прочитаны.</p>
        </div>
      );
    }
    return (
      <div className={styles.emptyState} role="status">
        <strong>В этой категории пока нет чатов</strong>
        <p>Выберите другую категорию или начните новый диалог из профиля игрока.</p>
      </div>
    );
  }

  // A brand-new account has no dialogs yet, so the explanation is the first row of the same list
  // instead of replacing it.
  const showNoChatsNotice = conversations.length === 0 && page.items.length === 0;

  // One list, one reading order: a station answer that arrived five minutes ago belongs above a
  // conversation from yesterday. Ties keep the LK2 order the server already decided.
  const entries = [
    ...conversations.map((conversation) => ({
      sortAt: recency(conversation.lastMessage?.createdAt ?? conversation.updatedAt),
      node: (
        <ChatListItem
          key={conversation.id}
          conversation={conversation}
          selected={conversation.id === selectedConversationId}
        />
      ),
    })),
    ...stationHistory.map((row) => ({
      sortAt: recency(row.updatedAt),
      node: (
        <StationChatRowItem
          key={`station:${row.key}`}
          row={{ ...row, hasHistory: true, selected: false }}
          relativeTime
          onOpen={() => onOpenStation(row.dialogId)}
        />
      ),
    })),
  ].sort((left, right) => right.sortAt - left.sortAt);

  return (
    <ul className={styles.list} aria-label="Диалоги" ref={listRef} onScroll={handleScroll}>
      {showNoChatsNotice ? (
        <li className={styles.emptyState} role="status">
          <strong>У вас пока нет чатов</strong>
          <p>Начните общение из профиля игрока или откройте чат в карточке своей игры.</p>
        </li>
      ) : null}
      {entries.map((entry) => entry.node)}
    </ul>
  );
}
