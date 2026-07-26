import { useState } from 'react';
import type { FormEvent } from 'react';

import type { ConversationMessagePage, ConversationPage } from './auth-gateway.js';

interface ChatsPageProps {
  readonly page: ConversationPage;
  readonly messages: ConversationMessagePage | null;
  readonly selectedConversationId?: string;
  readonly currentUserId: string;
  readonly busy: boolean;
  readonly error: string | null;
  readonly onCreateDirect: (otherUserId: string) => void;
  readonly onSendMessage: (body: string) => void;
  readonly onRefresh: () => void;
}

type Conversation = ConversationPage['items'][number];

function conversationTitle(conversation: Conversation | undefined): string {
  if (!conversation) return 'Диалог';
  return conversation.kind === 'DIRECT' ? conversation.participant.displayName : conversation.title;
}

function conversationKindLabel(conversation: Conversation | undefined): string {
  return conversation?.kind === 'GAME' ? 'Чат игры' : 'Личный диалог';
}

export function ChatsPage({
  page,
  messages,
  selectedConversationId,
  currentUserId,
  busy,
  error,
  onCreateDirect,
  onSendMessage,
  onRefresh,
}: ChatsPageProps): React.JSX.Element {
  const [otherUserId, setOtherUserId] = useState('');
  const [draft, setDraft] = useState('');
  const selected = page.items.find((conversation) => conversation.id === selectedConversationId);

  function createDirect(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const normalized = otherUserId.trim();
    if (normalized) onCreateDirect(normalized);
  }

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
        <div>
          <a href="/">Главная</a>
          <span aria-hidden="true"> / </span>
          <span>Чаты</span>
        </div>
        <h1>Чаты</h1>
        <p>Личные диалоги и чаты ваших игр с восстановлением истории.</p>
      </header>

      {error ? (
        <p className="chats-error" role="alert">
          {error}
        </p>
      ) : null}

      <section className="chats-layout">
        <aside className="chat-list" aria-label="Диалоги">
          <form className="chat-create-form" onSubmit={createDirect}>
            <label htmlFor="chat-participant-id">PadlHub UUID участника</label>
            <input
              id="chat-participant-id"
              value={otherUserId}
              onChange={(event) => setOtherUserId(event.target.value)}
              placeholder="00000000-0000-4000-8000-000000000000"
              disabled={busy}
            />
            <button type="submit" disabled={busy || !otherUserId.trim()}>
              Начать диалог
            </button>
          </form>

          {page.items.length === 0 ? (
            <p className="chat-empty">Диалогов пока нет.</p>
          ) : (
            <ul>
              {page.items.map((conversation) => (
                <li key={conversation.id}>
                  <a
                    href={`/chats/${conversation.id}`}
                    aria-current={conversation.id === selectedConversationId ? 'page' : undefined}
                  >
                    <strong>{conversationTitle(conversation)}</strong>
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
          {!selectedConversationId ? (
            <div className="chat-empty chat-empty-thread">
              <h2>Выберите диалог</h2>
              <p>Или создайте direct chat по PadlHub UUID тестового пользователя.</p>
            </div>
          ) : (
            <>
              <header>
                <div>
                  <small>{conversationKindLabel(selected)}</small>
                  <h2>{conversationTitle(selected)}</h2>
                </div>
                <button type="button" disabled={busy} onClick={onRefresh}>
                  Обновить
                </button>
              </header>
              <ol className="chat-messages">
                {messages?.messages.length ? (
                  messages.messages.map((message) => (
                    <li
                      key={message.id}
                      className={message.sender.userId === currentUserId ? 'chat-message-own' : ''}
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
                  disabled={busy}
                />
                <button type="submit" disabled={busy || !draft.trim()}>
                  {busy ? 'Отправляем…' : 'Отправить'}
                </button>
              </form>
            </>
          )}
        </section>
      </section>
    </main>
  );
}
