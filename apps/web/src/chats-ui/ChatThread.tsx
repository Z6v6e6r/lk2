import { Fragment, useLayoutEffect, useRef, useState } from 'react';

import type { ConversationMessage, ConversationSummary } from '../auth-gateway.js';
import type { PendingChatMessage } from '../ChatsPage.js';
import { ChatComposer } from './ChatComposer.js';
import { ChatContextCard } from './ChatContextCard.js';
import { ChatMessageBubble } from './ChatMessageBubble.js';
import { ChatThreadHeader } from './ChatThreadHeader.js';
import { formatMessageDay, messageDayKey } from './chat-format.js';
import styles from './ChatsUi.module.css';

interface ChatThreadProps {
  readonly conversation: ConversationSummary | undefined;
  readonly messages: readonly ConversationMessage[];
  readonly currentUserId: string;
  readonly busy: string | null;
  readonly forbidden: boolean;
  readonly pendingMessage?: PendingChatMessage | null | undefined;
  readonly connectionStatus?: string | null | undefined;
  readonly hasEarlierMessages?: boolean | undefined;
  readonly canRetrySend: boolean;
  readonly onSendMessage: (body: string) => void;
  readonly onRetrySend: () => void;
  readonly onRefresh: () => void;
  readonly onLoadEarlier?: (() => void) | undefined;
}

type ClientMessage = ConversationMessage & { readonly clientMessageId?: string };

export function ChatThread({
  conversation,
  messages,
  currentUserId,
  busy,
  forbidden,
  pendingMessage,
  connectionStatus,
  hasEarlierMessages,
  canRetrySend,
  onSendMessage,
  onRetrySend,
  onRefresh,
  onLoadEarlier,
}: ChatThreadProps): React.JSX.Element {
  const listRef = useRef<HTMLOListElement>(null);
  const snapshotRef = useRef<{
    readonly firstSequence: number;
    readonly lastSequence: number;
    readonly scrollHeight: number;
    readonly nearBottom: boolean;
  } | null>(null);
  const [hasNewMessages, setHasNewMessages] = useState(false);
  const orderedMessages = [...messages].sort((left, right) => left.sequence - right.sequence);
  const durablePendingExists = Boolean(
    pendingMessage &&
    orderedMessages.some(
      (message) => (message as ClientMessage).clientMessageId === pendingMessage.clientMessageId,
    ),
  );

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const firstSequence = orderedMessages[0]?.sequence ?? 0;
    const lastMessage = orderedMessages.at(-1);
    const lastSequence = lastMessage?.sequence ?? 0;
    const previous = snapshotRef.current;
    const hasPrependedHistory = Boolean(
      previous && firstSequence > 0 && firstSequence < previous.firstSequence,
    );
    const ownMessageArrived = Boolean(
      lastMessage &&
      previous &&
      lastSequence > previous.lastSequence &&
      lastMessage.sender.userId === currentUserId,
    );

    if (!previous) {
      list.scrollTop = list.scrollHeight;
    } else if (hasPrependedHistory) {
      list.scrollTop += list.scrollHeight - previous.scrollHeight;
    } else if (lastSequence > previous.lastSequence || pendingMessage) {
      if (previous.nearBottom || ownMessageArrived || pendingMessage?.state === 'sending') {
        list.scrollTop = list.scrollHeight;
        setHasNewMessages(false);
      } else {
        setHasNewMessages(true);
      }
    }

    snapshotRef.current = {
      firstSequence,
      lastSequence,
      scrollHeight: list.scrollHeight,
      nearBottom: list.scrollHeight - list.scrollTop - list.clientHeight < 72,
    };
  }, [currentUserId, orderedMessages, pendingMessage]);

  function handleScroll(): void {
    const list = listRef.current;
    if (!list || !snapshotRef.current) return;
    const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 72;
    snapshotRef.current = { ...snapshotRef.current, nearBottom };
    if (nearBottom) setHasNewMessages(false);
  }

  function scrollToLatest(): void {
    const list = listRef.current;
    if (!list) return;
    list.scrollTo({ top: list.scrollHeight, behavior: 'smooth' });
    setHasNewMessages(false);
  }

  return (
    <section className={styles.thread} aria-label="История сообщений">
      <ChatThreadHeader
        conversation={conversation}
        busy={busy === 'refresh'}
        onRefresh={onRefresh}
        connectionStatus={connectionStatus}
      />
      <ol className={styles.messages} ref={listRef} onScroll={handleScroll}>
        {hasEarlierMessages && onLoadEarlier ? (
          <li className={styles.loadEarlierRow} role="presentation">
            <button type="button" disabled={busy !== null} onClick={onLoadEarlier}>
              {busy === 'load-earlier' ? 'Загружаем…' : 'Показать предыдущие сообщения'}
            </button>
          </li>
        ) : null}
        {conversation?.kind === 'GAME' ? (
          <li className={styles.contextRow} role="presentation">
            <ChatContextCard conversation={conversation} />
          </li>
        ) : null}
        {orderedMessages.length === 0 && !pendingMessage ? (
          <li className={styles.threadEmpty}>Сообщений пока нет. Начните разговор.</li>
        ) : (
          orderedMessages.map((message, index) => {
            const previous = orderedMessages[index - 1];
            const startsDay =
              !previous || messageDayKey(previous.createdAt) !== messageDayKey(message.createdAt);
            return (
              <Fragment key={message.id}>
                {startsDay ? (
                  <li className={styles.daySeparator} role="separator">
                    <span>{formatMessageDay(message.createdAt)}</span>
                  </li>
                ) : null}
                <ChatMessageBubble
                  message={message}
                  own={message.sender.userId === currentUserId}
                  showSender={conversation?.kind === 'GAME'}
                />
              </Fragment>
            );
          })
        )}
        {pendingMessage && !durablePendingExists ? (
          <li className={`${styles.messageRow} ${styles.ownMessageRow}`}>
            <article
              className={`${styles.messageBubble} ${styles.ownMessageBubble} ${styles.pendingBubble} ${
                pendingMessage.state === 'failed' ? styles.failedBubble : ''
              }`}
            >
              <p>{pendingMessage.body}</p>
              <span role="status">
                {pendingMessage.state === 'sending' ? 'Отправляется…' : 'Не отправлено'}
              </span>
            </article>
          </li>
        ) : null}
      </ol>
      {hasNewMessages ? (
        <button type="button" className={styles.newMessagesButton} onClick={scrollToLatest}>
          Новые сообщения
        </button>
      ) : null}
      {canRetrySend ? (
        <div className={styles.retryBar} role="status">
          <span>Сообщение не подтверждено сервером.</span>
          <button type="button" disabled={busy !== null} onClick={onRetrySend}>
            Повторить отправку
          </button>
        </div>
      ) : null}
      <ChatComposer busy={busy === 'send'} forbidden={forbidden} onSendMessage={onSendMessage} />
    </section>
  );
}
