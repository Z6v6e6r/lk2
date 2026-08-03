import { useState } from 'react';
import type { FormEvent } from 'react';

import type { ConversationMessage, ConversationPage } from './auth-gateway.js';

export type ChatRouteMode = 'list' | 'new' | 'thread';

export interface ChatUiError {
  readonly kind: 'FEATURE_UNAVAILABLE' | 'AUTH' | 'FORBIDDEN' | 'NOT_FOUND' | 'RETRYABLE';
  readonly message: string;
}

interface ChatsPageProps {
  readonly page: ConversationPage | null;
  readonly messages: readonly ConversationMessage[];
  readonly mode: ChatRouteMode;
  readonly selectedConversationId?: string;
  readonly hasExplicitRecipient: boolean;
  readonly currentUserId: string;
  readonly busy: 'create' | 'send' | 'refresh' | null;
  readonly error: ChatUiError | null;
  readonly canRetrySend: boolean;
  readonly onCreateDirect: () => void;
  readonly onSendMessage: (body: string) => void;
  readonly onRetrySend: () => void;
  readonly onRefresh: () => void;
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
  canRetrySend,
  onCreateDirect,
  onSendMessage,
  onRetrySend,
  onRefresh,
}: ChatsPageProps): React.JSX.Element {
  const [draft, setDraft] = useState('');
  const selected = page?.items.find((conversation) => conversation.id === selectedConversationId);
  const orderedMessages = [...messages].sort((left, right) => left.sequence - right.sequence);

  function sendMessage(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const normalized = draft.trim();
    if (!normalized) return;
    onSendMessage(normalized);
    setDraft('');
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
                <ol className="chat-messages">
                  {orderedMessages.length > 0 ? (
                    orderedMessages.map((message) => (
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
                      </li>
                    ))
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
                    placeholder="Напишите сообщение"
                    maxLength={8000}
                    disabled={busy !== null || error?.kind === 'FORBIDDEN'}
                  />
                  <button type="submit" disabled={busy !== null || !draft.trim()}>
                    {busy === 'send' ? 'Отправляем…' : 'Отправить'}
                  </button>
                </form>
              </>
            )}
          </section>
        </section>
      )}
    </main>
  );
}
