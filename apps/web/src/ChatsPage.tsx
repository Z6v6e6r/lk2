import { useLayoutEffect, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent } from 'react';

import type { ConversationMessage, ConversationPage } from './auth-gateway.js';

export type ChatRouteMode = 'list' | 'new' | 'thread';

export interface ChatUiError {
  readonly kind: 'FEATURE_UNAVAILABLE' | 'AUTH' | 'FORBIDDEN' | 'NOT_FOUND' | 'RETRYABLE';
  readonly message: string;
}

export interface PendingChatMessage {
  readonly clientMessageId: string;
  readonly body: string;
  readonly state: 'sending' | 'failed';
}

export type ChatRealtimeUiState = 'connecting' | 'connected' | 'reconnecting' | 'polling';

interface ChatsPageProps {
  readonly page: ConversationPage | null;
  readonly messages: readonly ConversationMessage[];
  readonly mode: ChatRouteMode;
  readonly selectedConversationId?: string;
  readonly hasExplicitRecipient: boolean;
  readonly currentUserId: string;
  readonly busy: 'create' | 'send' | 'refresh' | 'load-earlier' | null;
  readonly error: ChatUiError | null;
  readonly pendingMessage: PendingChatMessage | null;
  readonly realtimeState: ChatRealtimeUiState | null;
  readonly hasEarlierMessages: boolean;
  readonly canRetrySend: boolean;
  readonly onCreateDirect: () => void;
  readonly onSendMessage: (body: string) => void;
  readonly onRetrySend: () => void;
  readonly onRefresh: () => void;
  readonly onLoadEarlier: () => void;
}

export function ChatsPage({
  page,
  messages,
  mode,
  selectedConversationId,
  hasExplicitRecipient,
  currentUserId,
  busy,
  error,
  pendingMessage,
  realtimeState,
  hasEarlierMessages,
  canRetrySend,
  onCreateDirect,
  onSendMessage,
  onRetrySend,
  onRefresh,
  onLoadEarlier,
}: ChatsPageProps): React.JSX.Element {
  const [draft, setDraft] = useState('');
  const messageListRef = useRef<HTMLOListElement>(null);
  const scrollSnapshotRef = useRef<{
    readonly firstSequence: number;
    readonly lastSequence: number;
    readonly scrollHeight: number;
  } | null>(null);
  const selected = page?.items.find((conversation) => conversation.id === selectedConversationId);
  const orderedMessages = [...messages].sort((left, right) => left.sequence - right.sequence);

  useLayoutEffect(() => {
    const list = messageListRef.current;
    if (!list) return;
    const firstSequence = orderedMessages[0]?.sequence ?? 0;
    const lastSequence = orderedMessages.at(-1)?.sequence ?? 0;
    const previous = scrollSnapshotRef.current;
    if (previous && firstSequence > 0 && firstSequence < previous.firstSequence) {
      list.scrollTop += list.scrollHeight - previous.scrollHeight;
    } else if (!previous || lastSequence > previous.lastSequence || pendingMessage) {
      list.scrollTop = list.scrollHeight;
    }
    scrollSnapshotRef.current = {
      firstSequence,
      lastSequence,
      scrollHeight: list.scrollHeight,
    };
  }, [orderedMessages, pendingMessage]);

  function sendMessage(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const normalized = draft.trim();
    if (!normalized) return;
    onSendMessage(normalized);
    setDraft('');
  }

  function handleMessageKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key !== 'Enter' || (!event.metaKey && !event.ctrlKey)) return;
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  }

  return (
    <main className="chats-page">
      <header className="chats-toolbar">
        <a href="/">Главная</a>
        <h1>Чаты</h1>
        <p>Сообщения ПадлХАБ · защищённая HTTP-история</p>
      </header>

      {error ? (
        <section className={`chats-error is-${error.kind.toLowerCase()}`} role="alert">
          <strong>
            {error.kind === 'FEATURE_UNAVAILABLE'
              ? 'Чаты пока недоступны'
              : error.kind === 'AUTH'
                ? 'Нужно войти снова'
                : error.kind === 'FORBIDDEN'
                  ? 'Нет доступа к диалогу'
                  : error.kind === 'NOT_FOUND'
                    ? 'Диалог не найден'
                    : 'Не удалось обновить чаты'}
          </strong>
          <span>{error.message}</span>
          {error.kind === 'AUTH' ? (
            <a href="/">Перейти ко входу</a>
          ) : error.kind === 'FEATURE_UNAVAILABLE' ? null : (
            <button type="button" disabled={busy !== null} onClick={onRefresh}>
              Повторить
            </button>
          )}
        </section>
      ) : null}

      {mode === 'new' ? (
        <section className="chat-direct-start" aria-labelledby="chat-direct-start-title">
          <a href="/chats">← К диалогам</a>
          <h2 id="chat-direct-start-title">Новый личный чат</h2>
          {hasExplicitRecipient ? (
            <>
              <p>
                Получатель выбран безопасной ссылкой ПадлХАБ. Его внутренние и внешние контактные
                идентификаторы не показываются.
              </p>
              <button
                type="button"
                disabled={busy !== null || error?.kind === 'FEATURE_UNAVAILABLE'}
                onClick={onCreateDirect}
              >
                {busy === 'create' ? 'Открываем диалог…' : 'Начать диалог'}
              </button>
            </>
          ) : (
            <div className="chat-product-blocker" role="note">
              <strong>Получатель не выбран</strong>
              <p>
                В M1 чат создаётся только по явной ссылке с PadlHub UUID. Каталог или поиск игроков
                ещё не определён продуктом, поэтому ввод произвольного идентификатора здесь закрыт.
              </p>
              <a href="/chats">Вернуться к диалогам</a>
            </div>
          )}
        </section>
      ) : (
        <section className="chats-layout">
          <aside className="chat-list" aria-label="Диалоги">
            <div className="chat-list-heading">
              <strong>Диалоги</strong>
              <small>Direct и Game</small>
            </div>
            {!page && !error ? (
              <p className="chat-empty" role="status">
                Загружаем диалоги…
              </p>
            ) : page?.items.length === 0 ? (
              <div className="chat-empty">
                <strong>Диалогов пока нет</strong>
                <p>Новый чат откроется по безопасной ссылке из поддерживаемого профиля.</p>
              </div>
            ) : (
              <ul>
                {page?.items.map((conversation) => (
                  <li key={conversation.id}>
                    <a
                      href={`/chats/${conversation.id}`}
                      aria-current={conversation.id === selectedConversationId ? 'page' : undefined}
                    >
                      <strong>
                        {conversation.kind === 'DIRECT'
                          ? conversation.participant.displayName
                          : conversation.title}
                      </strong>
                      <span>{conversation.lastMessage?.body ?? 'Новый диалог'}</span>
                      {conversation.unreadCount > 0 ? (
                        <small aria-label={`Непрочитанных: ${conversation.unreadCount}`}>
                          {conversation.unreadCount}
                        </small>
                      ) : null}
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </aside>

          <section className="chat-thread" aria-label="История сообщений">
            {mode !== 'thread' || !selectedConversationId ? (
              <div className="chat-empty chat-empty-thread">
                <h2>Выберите диалог</h2>
                <p>Здесь появится упорядоченная история сообщений.</p>
              </div>
            ) : (
              <>
                <header>
                  <div>
                    <small>{selected?.kind === 'GAME' ? 'Чат игры' : 'Личный чат'}</small>
                    <h2>
                      {selected?.kind === 'DIRECT'
                        ? selected.participant.displayName
                        : (selected?.title ?? 'Диалог')}
                    </h2>
                  </div>
                  <button type="button" disabled={busy !== null} onClick={onRefresh}>
                    {busy === 'refresh' ? 'Обновляем…' : 'Обновить'}
                  </button>
                </header>
                <p
                  className={`chat-connection-state is-${realtimeState ?? 'connected'}`}
                  {...(realtimeState && realtimeState !== 'connected'
                    ? { role: 'status' as const }
                    : { 'aria-hidden': true })}
                >
                  {realtimeState === 'connecting'
                    ? 'Подключаем онлайн-доставку…'
                    : realtimeState === 'reconnecting'
                      ? 'Связь восстанавливается. История обновляется через защищённый HTTP.'
                      : realtimeState === 'polling'
                        ? 'Онлайн-доставка недоступна. История обновляется автоматически.'
                        : ''}
                </p>
                <ol className="chat-messages" ref={messageListRef}>
                  {hasEarlierMessages ? (
                    <li className="chat-history-control">
                      <button type="button" disabled={busy !== null} onClick={onLoadEarlier}>
                        {busy === 'load-earlier' ? 'Загружаем…' : 'Показать предыдущие сообщения'}
                      </button>
                    </li>
                  ) : null}
                  {orderedMessages.length > 0 || pendingMessage ? (
                    <>
                      {orderedMessages.map((message) => (
                        <li
                          key={message.id}
                          className={
                            message.sender.userId === currentUserId ? 'chat-message-own' : ''
                          }
                        >
                          <strong>{message.sender.displayName}</strong>
                          <p>{message.body}</p>
                          <time dateTime={message.createdAt}>
                            {new Intl.DateTimeFormat('ru-RU', {
                              hour: '2-digit',
                              minute: '2-digit',
                            }).format(new Date(message.createdAt))}
                          </time>
                          {message.sender.userId === currentUserId ? (
                            <span className="chat-message-status">Отправлено</span>
                          ) : null}
                        </li>
                      ))}
                      {pendingMessage ? (
                        <li
                          key={pendingMessage.clientMessageId}
                          className={`chat-message-own chat-message-pending is-${pendingMessage.state}`}
                        >
                          <strong>Вы</strong>
                          <p>{pendingMessage.body}</p>
                          <span className="chat-message-status" role="status">
                            {pendingMessage.state === 'sending' ? 'Отправляется…' : 'Не отправлено'}
                          </span>
                        </li>
                      ) : null}
                    </>
                  ) : (
                    <li className="chat-empty">Сообщений пока нет.</li>
                  )}
                </ol>
                {canRetrySend ? (
                  <div className="chat-send-retry" role="status">
                    <span>Сообщение не подтверждено сервером.</span>
                    <button type="button" disabled={busy !== null} onClick={onRetrySend}>
                      Повторить отправку
                    </button>
                  </div>
                ) : null}
                <form className="chat-send-form" onSubmit={sendMessage}>
                  <label className="sr-only" htmlFor="chat-message-body">
                    Сообщение
                  </label>
                  <textarea
                    id="chat-message-body"
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={handleMessageKeyDown}
                    placeholder="Напишите сообщение"
                    maxLength={8000}
                    aria-describedby="chat-message-hint"
                    disabled={busy !== null || error?.kind === 'FORBIDDEN'}
                  />
                  <button type="submit" disabled={busy !== null || !draft.trim()}>
                    {busy === 'send' ? 'Отправляем…' : 'Отправить'}
                  </button>
                  <small id="chat-message-hint">
                    Enter — новая строка, Ctrl/⌘+Enter — отправить
                  </small>
                </form>
              </>
            )}
          </section>
        </section>
      )}
    </main>
  );
}
