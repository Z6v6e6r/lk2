import { useState } from 'react';

import { MainBottomNavigation } from './HomeDashboardPage.js';
import type {
  ConversationMessage,
  ConversationNotificationPolicyUpdate,
  ConversationPage,
} from './auth-gateway.js';
import { ChatCategoryIcon } from './chats-ui/ChatCategoryIcon.js';
import { ChatFilterHeading, ChatFilters, type ChatFilter } from './chats-ui/ChatFilters.js';
import { ChatList } from './chats-ui/ChatList.js';
import { ChatThread } from './chats-ui/ChatThread.js';
import { type ChatComposerSend } from './chats-ui/ChatComposer.js';
import type { ChatAttachmentDraft } from './chats-ui/chat-attachments.js';
import styles from './chats-ui/ChatsUi.module.css';

export type ChatRouteMode = 'list' | 'new' | 'thread';

export interface ChatUiError {
  readonly kind: 'FEATURE_UNAVAILABLE' | 'AUTH' | 'FORBIDDEN' | 'NOT_FOUND' | 'RETRYABLE';
  readonly message: string;
}

export interface PendingChatMessage {
  readonly clientMessageId: string;
  readonly body: string;
  readonly attachmentIds?: readonly string[];
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
  readonly policyBusy: boolean;
  readonly attachments: readonly ChatAttachmentDraft[];
  readonly attachmentNotice: string | null;
  readonly loadMedia: (conversationId: string, mediaId: string) => Promise<Blob>;
  readonly onCreateDirect: () => void;
  readonly onAttachFiles: (files: readonly File[]) => void;
  readonly onRemoveAttachment: (localId: string) => void;
  readonly onSendMessage: (input: ChatComposerSend) => void;
  readonly onRetrySend: () => void;
  readonly onRefresh: () => void;
  readonly onLoadEarlier: () => void;
  readonly onSetNotificationPolicy: (update: ConversationNotificationPolicyUpdate) => void;
}

function errorTitle(kind: ChatUiError['kind']): string {
  if (kind === 'FEATURE_UNAVAILABLE') return 'Чаты пока недоступны';
  if (kind === 'AUTH') return 'Нужно войти снова';
  if (kind === 'FORBIDDEN') return 'Нет доступа к диалогу';
  if (kind === 'NOT_FOUND') return 'Диалог не найден';
  return 'Не удалось обновить чаты';
}

function realtimeLabel(state: ChatRealtimeUiState | null): string | null {
  if (state === 'connecting') return 'Подключаем онлайн-доставку…';
  if (state === 'reconnecting') {
    return 'Связь восстанавливается · История обновляется через защищённый HTTP';
  }
  if (state === 'polling') return 'Онлайн-доставка недоступна · История обновляется автоматически';
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
  pendingMessage,
  realtimeState,
  hasEarlierMessages,
  canRetrySend,
  policyBusy,
  attachments,
  attachmentNotice,
  loadMedia,
  onCreateDirect,
  onAttachFiles,
  onRemoveAttachment,
  onSendMessage,
  onRetrySend,
  onRefresh,
  onLoadEarlier,
  onSetNotificationPolicy,
}: ChatsPageProps): React.JSX.Element {
  const [filter, setFilter] = useState<ChatFilter>('ALL');
  const [query, setQuery] = useState('');
  const [unreadOnly, setUnreadOnly] = useState(false);
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
              <button
                type="button"
                disabled={busy !== null || error?.kind === 'FEATURE_UNAVAILABLE'}
                onClick={onCreateDirect}
              >
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
        <MainBottomNavigation active="chats" />
      </main>
    );
  }

  return (
    <main className={`${styles.page} ${mode === 'thread' ? styles.threadPage : ''}`}>
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
            <ChatFilterHeading filter={filter} />
            <div className={styles.headerActions}>
              <button
                type="button"
                className={`${styles.unreadToggle} ${unreadOnly ? styles.unreadToggleActive : ''}`}
                aria-label="Только непрочитанные"
                title="Только непрочитанные"
                aria-pressed={unreadOnly}
                onClick={() => setUnreadOnly(!unreadOnly)}
              >
                <ChatCategoryIcon name="UNREAD" />
              </button>
              <a className={styles.notificationsShortcut} href="/notifications">
                <ChatCategoryIcon name="NOTIFICATIONS" />
                <span className="sr-only">События</span>
              </a>
            </div>
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
            unreadOnly={unreadOnly}
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
            policyBusy={policyBusy}
            attachments={attachments}
            attachmentNotice={attachmentNotice}
            loadMedia={loadMedia}
            onAttachFiles={onAttachFiles}
            onRemoveAttachment={onRemoveAttachment}
            onSendMessage={onSendMessage}
            onRetrySend={onRetrySend}
            onRefresh={onRefresh}
            onLoadEarlier={onLoadEarlier}
            onSetNotificationPolicy={onSetNotificationPolicy}
          />
        ) : (
          <section className={styles.threadPlaceholder} aria-label="История сообщений">
            <span className={styles.placeholderIcon} aria-hidden="true">
              <ChatCategoryIcon name="ALL" />
            </span>
            <h2>Будьте на связи</h2>
            <p>
              Обсуждайте игры и договаривайтесь о встречах.
              <br />
              Выберите чат, чтобы начать общение.
            </p>
          </section>
        )}
      </section>
      <MainBottomNavigation active="chats" />
    </main>
  );
}
