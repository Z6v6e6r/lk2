import { useState } from 'react';

import { MainBottomNavigation } from './HomeDashboardPage.js';
import type { ConversationMessage, ConversationPage } from './auth-gateway.js';
import { ChatFilters, type ChatFilter } from './chats-ui/ChatFilters.js';
import { ChatList } from './chats-ui/ChatList.js';
import { ChatThread } from './chats-ui/ChatThread.js';
import styles from './chats-ui/ChatsUi.module.css';

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
  readonly canRetrySend: boolean;
  readonly pendingMessage?: PendingChatMessage | null;
  readonly realtimeState?: ChatRealtimeUiState | null;
  readonly hasEarlierMessages?: boolean;
  readonly onCreateDirect: () => void;
  readonly onSendMessage: (body: string) => void;
  readonly onRetrySend: () => void;
  readonly onRefresh: () => void;
  readonly onLoadEarlier?: () => void;
}

function errorTitle(kind: ChatUiError['kind']): string {
  if (kind === 'FEATURE_UNAVAILABLE') return 'Чаты пока недоступны';
  if (kind === 'AUTH') return 'Нужно войти снова';
  if (kind === 'FORBIDDEN') return 'Нет доступа к диалогу';
  if (kind === 'NOT_FOUND') return 'Диалог не найден';
  return 'Не удалось обновить чаты';
}

function realtimeLabel(state: ChatRealtimeUiState | null | undefined): string | null {
  if (state === 'connecting') return 'Подключаем онлайн-доставку…';
  if (state === 'reconnecting') return 'Связь восстанавливается · HTTP-история доступна';
  if (state === 'polling') return 'Обновляется через защищённый HTTP';
  return null;
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
  pendingMessage,
  realtimeState,
  hasEarlierMessages,
  onCreateDirect,
  onSendMessage,
  onRetrySend,
  onRefresh,
  onLoadEarlier,
}: ChatsPageProps): React.JSX.Element {
  const [filter, setFilter] = useState<ChatFilter>('ALL');
  const [query, setQuery] = useState('');
  const selected = page?.items.find((conversation) => conversation.id === selectedConversationId);

  if (mode === 'new') {
    return (
      <main className={styles.page}>
        <section className={styles.directStart} aria-labelledby="chat-direct-start-title">
          <a href="/chats">← К диалогам</a>
          <h1 id="chat-direct-start-title">Новый личный чат</h1>
          {hasExplicitRecipient ? (
            <>
              <p>
                Получатель выбран безопасной ссылкой ПадлХАБ. Контактные идентификаторы остаются
                скрыты.
              </p>
              <button type="button" disabled={busy !== null} onClick={onCreateDirect}>
                {busy === 'create' ? 'Открываем диалог…' : 'Начать диалог'}
              </button>
            </>
          ) : (
            <div role="note">
              <strong>Получатель не выбран</strong>
              <p>Откройте чат из профиля игрока по поддерживаемой безопасной ссылке.</p>
            </div>
          )}
        </section>
        <MainBottomNavigation communicationsDestination="chats" active="chats" />
      </main>
    );
  }

  return (
    <main className={styles.page}>
      {error ? (
        <section className={styles.errorBanner} role="alert">
          <span>
            <strong>{errorTitle(error.kind)}</strong>
            <small>{error.message}</small>
          </span>
          {error.kind === 'AUTH' ? (
            <a href="/">Перейти ко входу</a>
          ) : error.kind === 'FEATURE_UNAVAILABLE' ? null : (
            <button type="button" disabled={busy !== null} onClick={onRefresh}>
              Повторить
            </button>
          )}
        </section>
      ) : null}
      <section
        className={`${styles.shell} ${mode === 'thread' ? styles.threadMode : styles.listMode}`}
        aria-label="Чаты"
      >
        <aside className={styles.listPane} aria-label="Список чатов">
          <header className={styles.listHeader}>
            <h1>Чаты</h1>
            <a className={styles.notificationsShortcut} href="/notifications">
              События
            </a>
          </header>
          <ChatFilters
            filter={filter}
            query={query}
            onFilterChange={setFilter}
            onQueryChange={setQuery}
          />
          <ChatList
            page={page}
            error={Boolean(error)}
            filter={filter}
            query={query}
            {...(selectedConversationId ? { selectedConversationId } : {})}
          />
        </aside>
        {mode === 'thread' && selectedConversationId ? (
          <ChatThread
            conversation={selected}
            messages={messages}
            currentUserId={currentUserId}
            busy={busy}
            forbidden={error?.kind === 'FORBIDDEN'}
            pendingMessage={pendingMessage}
            connectionStatus={realtimeLabel(realtimeState)}
            hasEarlierMessages={hasEarlierMessages}
            canRetrySend={canRetrySend}
            onSendMessage={onSendMessage}
            onRetrySend={onRetrySend}
            onRefresh={onRefresh}
            onLoadEarlier={onLoadEarlier}
          />
        ) : (
          <section className={styles.threadPlaceholder} aria-label="История сообщений">
            <h2>Выберите диалог</h2>
            <p>История откроется здесь, а на мобильном — на отдельном экране.</p>
          </section>
        )}
      </section>
      <MainBottomNavigation communicationsDestination="chats" active="chats" />
    </main>
  );
}
