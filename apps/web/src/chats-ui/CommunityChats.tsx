import { useLayoutEffect, useRef } from 'react';

import { ChatCategoryIcon } from './ChatCategoryIcon.js';
import { CommunityAvatar } from './CommunityAvatar.js';
import { LinkedMessageText } from './LinkedMessageText.js';
import { formatMessageDay, formatMessageTime, unreadLabel } from './chat-format.js';
import {
  COMMUNITY_CHAT_PREVIEW,
  communityMessageKey,
  communityRows,
  type CommunityChatMessage,
  type CommunityRow,
} from './community-chat-rows.js';
import type { ChatUiError } from '../ChatsPage.js';
import styles from './ChatsUi.module.css';

interface CommunityChatListProps {
  readonly communities: readonly CommunityRow[];
  readonly query: string;
  readonly unreadOnly: boolean;
  /** True while the directory says that a further page of member communities exists. */
  readonly hasMore: boolean;
  /** True while a fresh directory read is replacing the rows that are already on screen. */
  readonly refreshing: boolean;
  readonly selectedCommunityId: string | null;
  readonly busy: 'load' | 'more' | null;
  readonly error: ChatUiError | null;
  readonly onSelectCommunity: (communityId: string) => void;
  readonly onRetry: () => void;
  readonly onLoadMore: () => void;
}

/**
 * The Сообщества tab lists every community the viewer was added to, because the chat of a community
 * is only reachable through that membership. A community the directory could not deliver is not
 * invented here: the row set is exactly one page chain of the member directory.
 */
export function CommunityChatList({
  communities,
  query,
  unreadOnly,
  hasMore,
  refreshing,
  selectedCommunityId,
  busy,
  error,
  onSelectCommunity,
  onRetry,
  onLoadMore,
}: CommunityChatListProps): React.JSX.Element {
  const rows = communityRows({ communities, query, unreadOnly });
  const loading = busy === 'load' && communities.length === 0;
  const searching = query.trim().length > 0;

  return (
    <div className={styles.communityListPane}>
      {refreshing ? (
        // The cached rows stay readable while the fresh directory read runs; the status line is the
        // only visible sign that they may still change.
        <p className={styles.refreshNotice} role="status">
          Обновляем список…
        </p>
      ) : null}
      {error ? (
        <div className={styles.retryBar} role="status">
          <span>{error.message}</span>
          {error.kind === 'FEATURE_UNAVAILABLE' ? null : (
            <button type="button" disabled={busy !== null} onClick={onRetry}>
              Повторить
            </button>
          )}
        </div>
      ) : null}
      {loading ? (
        <div className={styles.skeletonList} role="status" aria-label="Загружаем чаты сообществ">
          {Array.from({ length: 3 }, (_, index) => (
            <span key={index} className={styles.skeletonRow} aria-hidden="true" />
          ))}
        </div>
      ) : null}
      {!loading && !error && communities.length === 0 ? (
        <div className={styles.emptyState} role="status">
          <span className={styles.emptyIcon} aria-hidden="true">
            <ChatCategoryIcon name="COMMUNITY" />
          </span>
          <strong>Вы пока не вступили ни в одно сообщество</strong>
          <p>Чаты сообществ появятся здесь, когда вы вступите в сообщество.</p>
        </div>
      ) : null}
      {!loading && communities.length > 0 && rows.length === 0 && !hasMore ? (
        <div className={styles.emptyState} role="status">
          <strong>
            {searching ? 'По запросу ничего не найдено' : 'Нет непрочитанных чатов сообществ'}
          </strong>
          <p>
            {searching
              ? 'Измените запрос или очистите поле поиска.'
              : 'Все сообщения в чатах сообществ прочитаны.'}
          </p>
        </div>
      ) : null}
      {rows.length > 0 || (hasMore && !loading) ? (
        <ul className={styles.list} aria-label="Чаты сообществ">
          {rows.map((community) => (
            <CommunityChatRow
              key={community.id}
              community={community}
              selected={community.id === selectedCommunityId}
              onOpen={() => onSelectCommunity(community.id)}
            />
          ))}
          {hasMore ? (
            <li className={styles.loadEarlierRow} role="presentation">
              <button type="button" disabled={busy !== null} onClick={onLoadMore}>
                {busy === 'more' ? 'Загружаем…' : 'Показать ещё сообщества'}
              </button>
            </li>
          ) : null}
        </ul>
      ) : null}
    </div>
  );
}

function CommunityChatRow({
  community,
  selected,
  onOpen,
}: {
  readonly community: CommunityRow;
  readonly selected: boolean;
  readonly onOpen: () => void;
}): React.JSX.Element {
  const unread = unreadLabel(community.unreadChatCount);
  return (
    <li className={styles.listItem}>
      <button
        type="button"
        className={`${styles.listLink} ${styles.communityListButton} ${
          selected ? styles.selectedListLink : ''
        }`}
        aria-current={selected ? 'true' : undefined}
        onClick={onOpen}
      >
        <CommunityAvatar title={community.title} logoUrl={community.logoUrl} />
        <span className={styles.communityListItemBody}>
          <strong>{community.title}</strong>
          <small className={styles.communityListEmptyPreview}>{COMMUNITY_CHAT_PREVIEW}</small>
        </span>
        <span className={styles.communityListItemMeta}>
          {unread ? (
            <span
              className={styles.unreadBadge}
              aria-label={`Непрочитанных сообщений: ${community.unreadChatCount}`}
            >
              {unread}
            </span>
          ) : null}
        </span>
      </button>
    </li>
  );
}

interface CommunityThreadProps {
  readonly community: CommunityRow;
  readonly messages: readonly CommunityChatMessage[];
  readonly busy: 'load' | 'load-earlier' | null;
  readonly error: ChatUiError | null;
  /** Buffered messages are on screen while a fresh page is replacing them. */
  readonly refreshing: boolean;
  readonly hasEarlierMessages: boolean;
  readonly onRetry: () => void;
  readonly onLoadEarlier: () => void;
}

/** How close to the top edge counts as "the person wants the rest of the history". */
const EARLIER_PAGE_TRIGGER_PX = 96;

/**
 * A community chat is a read-only projection: the block shows the history it can read and says so,
 * instead of offering a composer that no published command could accept.
 */
export function CommunityThread({
  community,
  messages,
  busy,
  error,
  refreshing,
  hasEarlierMessages,
  onRetry,
  onLoadEarlier,
}: CommunityThreadProps): React.JSX.Element {
  // The projection exposes no message id, so a row is identified by what it does state — instant,
  // author and body — plus its occurrence among identical messages. Counting occurrences instead of
  // using the row index keeps a row the same React node when an older page is prepended above it.
  const occurrences = new Map<string, number>();
  const rows = messages.map((message, index) => {
    const base = communityMessageKey(message);
    const occurrence = occurrences.get(base) ?? 0;
    occurrences.set(base, occurrence + 1);
    const day = formatMessageDay(message.sentAt);
    const previous = messages[index - 1];
    const previousDay = previous ? formatMessageDay(previous.sentAt) : null;
    return {
      message,
      key: `${base}:${occurrence}`,
      day,
      startsDay: day !== '' && day !== previousDay,
    };
  });
  const listRef = useRef<HTMLOListElement>(null);
  const communityKey = community.id;
  /**
   * The scroll position is measured against the previous render, because an older page arrives above
   * the current view and must not throw the reader to the top of the thread.
   */
  const snapshotRef = useRef<{
    readonly communityKey: string;
    readonly oldestKey: string | null;
    readonly newestKey: string | null;
    readonly scrollHeight: number;
    readonly nearBottom: boolean;
  } | null>(null);
  /** One request per gesture: a scroll stream must not fire a page per scroll event. */
  const requestedEarlierRef = useRef(false);

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const oldestKey = messages[0] ? communityMessageKey(messages[0]) : null;
    const newest = messages.at(-1);
    const newestKey = newest ? communityMessageKey(newest) : null;
    const previous = snapshotRef.current;
    const sameCommunity = previous?.communityKey === communityKey;
    if (!previous || !sameCommunity) {
      // A community chat opens at its end: the newest message is why the person came back, and the
      // rest of the history is pulled in only when they scroll up.
      list.scrollTop = list.scrollHeight;
    } else if (oldestKey !== previous.oldestKey && previous.oldestKey !== null) {
      list.scrollTop += list.scrollHeight - previous.scrollHeight;
    } else if (newestKey !== previous.newestKey && previous.nearBottom) {
      list.scrollTop = list.scrollHeight;
    }
    snapshotRef.current = {
      communityKey,
      oldestKey,
      newestKey,
      scrollHeight: list.scrollHeight,
      nearBottom: list.scrollHeight - list.scrollTop - list.clientHeight < 72,
    };
  }, [communityKey, messages]);

  useLayoutEffect(() => {
    requestedEarlierRef.current = false;
  }, [busy, hasEarlierMessages, messages]);

  function handleScroll(): void {
    const list = listRef.current;
    if (!list || !snapshotRef.current) return;
    const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 72;
    snapshotRef.current = { ...snapshotRef.current, nearBottom };
    if (
      list.scrollTop > EARLIER_PAGE_TRIGGER_PX ||
      !hasEarlierMessages ||
      busy !== null ||
      requestedEarlierRef.current
    ) {
      return;
    }
    requestedEarlierRef.current = true;
    onLoadEarlier();
  }

  return (
    <section className={styles.thread} aria-label={`Чат сообщества ${community.title}`}>
      <header className={`${styles.threadHeader} ${styles.communityThreadHeader}`}>
        <a className={styles.backLink} href="/chats" aria-label="Назад к чатам">
          <span aria-hidden="true">←</span>
        </a>
        <CommunityAvatar title={community.title} logoUrl={community.logoUrl} />
        <div className={styles.threadHeading}>
          <h2>{community.title}</h2>
          <small>Чат сообщества · только для чтения</small>
        </div>
        <button
          type="button"
          className={styles.refreshButton}
          aria-label="Обновить чат сообщества"
          title="Обновить"
          disabled={busy !== null}
          onClick={onRetry}
        >
          ⟳
        </button>
      </header>
      <div className={styles.threadBody}>
        {refreshing ? (
          // The buffered history stays readable while the fresh page replaces it.
          <p className={styles.refreshNotice} role="status">
            Обновляем переписку…
          </p>
        ) : null}
        <ol className={styles.messages} ref={listRef} onScroll={handleScroll}>
          {hasEarlierMessages ? (
            <li className={styles.loadEarlierRow} role="presentation">
              <button type="button" disabled={busy !== null} onClick={onLoadEarlier}>
                {busy === 'load-earlier' ? 'Загружаем…' : 'Показать предыдущие сообщения'}
              </button>
            </li>
          ) : null}
          {messages.length === 0 && busy !== 'load' && !error ? (
            <li className={styles.threadEmpty}>В чате сообщества пока нет сообщений.</li>
          ) : null}
          {rows.map(({ message, key, day, startsDay }) => (
            <li key={key} role="presentation">
              {startsDay ? (
                <div className={styles.daySeparator} role="separator">
                  <span>{day}</span>
                </div>
              ) : null}
              <div
                className={`${styles.messageRow} ${message.isViewer ? styles.ownMessageRow : ''}`}
              >
                <article
                  className={`${styles.messageBubble} ${styles.messageTail} ${
                    message.isViewer ? styles.ownMessageBubble : ''
                  }`}
                >
                  <strong>{message.isViewer ? 'Вы' : message.author.displayName}</strong>
                  <p>
                    <LinkedMessageText text={message.body} linkClassName={styles.messageLink} />
                  </p>
                  <time dateTime={message.sentAt}>{formatMessageTime(message.sentAt)}</time>
                </article>
              </div>
            </li>
          ))}
        </ol>
        {error ? (
          <div className={styles.retryBar} role="status">
            <span>{error.message}</span>
            {error.kind === 'FEATURE_UNAVAILABLE' ? null : (
              <button type="button" disabled={busy !== null} onClick={onRetry}>
                Обновить
              </button>
            )}
          </div>
        ) : null}
        <p className={styles.threadReadOnlyNote}>Чат сообщества доступен только для чтения.</p>
      </div>
    </section>
  );
}
