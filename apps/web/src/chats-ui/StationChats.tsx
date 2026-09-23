import { formatMessageDay, formatMessageTime } from './chat-format.js';
import { ChatAvatar } from './ChatAvatar.js';
import { ChatComposer } from './ChatComposer.js';
import { ChatCategoryIcon } from './ChatCategoryIcon.js';
import type { ChatUiError } from '../ChatsPage.js';
import type {
  StationSupportDialog,
  StationSupportMessage,
  StationSupportStation,
} from '../auth-gateway.js';
import { stationChatRows } from './station-chat-rows.js';
import styles from './ChatsUi.module.css';

export interface StationChatsHandlers {
  readonly onSelectDialog: (dialogId: string) => void;
  readonly onSelectStation: (stationId: string) => void;
  readonly onSendMessage: (text: string) => void;
  readonly onRetry: () => void;
}

interface StationDialogListProps extends StationChatsHandlers {
  readonly stations: readonly StationSupportStation[];
  readonly dialogs: readonly StationSupportDialog[];
  readonly query: string;
  readonly selectedDialogId: string | null;
  readonly selectedStationId: string | null;
  readonly busy: 'load' | 'send' | null;
  readonly error: ChatUiError | null;
}

function authorLabel(author: StationSupportMessage['author']): string {
  if (author === 'ME') return 'Вы';
  if (author === 'STATION') return 'Станция';
  return 'Система';
}

export function StationDialogList({
  stations,
  dialogs,
  query,
  selectedDialogId,
  selectedStationId,
  busy,
  error,
  onSelectDialog,
  onSelectStation,
  onRetry,
}: StationDialogListProps): React.JSX.Element {
  const rows = stationChatRows({
    stations,
    dialogs,
    query,
    selectedDialogId,
    selectedStationId,
  });
  const loading = busy === 'load' && stations.length === 0;
  return (
    <div className={styles.stationListPane}>
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
        <div className={styles.skeletonList} role="status" aria-label="Загружаем чаты станций">
          {Array.from({ length: 3 }, (_, index) => (
            <span key={index} className={styles.skeletonRow} aria-hidden="true" />
          ))}
        </div>
      ) : null}
      {!loading && stations.length === 0 ? (
        <div className={styles.emptyState} role="status">
          <span className={styles.emptyIcon} aria-hidden="true">
            <ChatCategoryIcon name="STATION" />
          </span>
          <strong>Станции готовятся к публикации</strong>
          <p>Как только площадки опубликуют, с каждой можно будет начать переписку.</p>
        </div>
      ) : null}
      {!loading && stations.length > 0 && rows.length === 0 ? (
        <div className={styles.emptyState} role="status">
          <strong>Ничего не найдено</strong>
          <p>Измените запрос или выберите другую станцию.</p>
        </div>
      ) : null}
      {rows.length > 0 ? (
        <ul className={styles.list} aria-label="Чаты станций">
          {rows.map((row) => (
            <li key={row.key}>
              <button
                type="button"
                className={`${styles.listLink} ${styles.stationListButton} ${
                  row.selected ? styles.selectedListLink : ''
                }`}
                aria-current={row.selected ? 'true' : undefined}
                onClick={() => {
                  if (row.dialogId) onSelectDialog(row.dialogId);
                  else if (row.stationId) onSelectStation(row.stationId);
                }}
              >
                <ChatAvatar isGame={false} title={row.title} />
                <span className={styles.stationListItemBody}>
                  <strong>{row.title}</strong>
                  <small className={row.hasHistory ? undefined : styles.stationListEmptyPreview}>
                    {row.preview}
                  </small>
                </span>
                <span className={styles.stationListItemMeta}>
                  {row.updatedAt ? (
                    <time dateTime={row.updatedAt}>{formatMessageTime(row.updatedAt)}</time>
                  ) : null}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

interface StationThreadProps {
  readonly dialog: StationSupportDialog | null;
  readonly stationName: string;
  readonly messages: readonly StationSupportMessage[];
  readonly busy: 'load' | 'send' | null;
  readonly error: ChatUiError | null;
  readonly closed: boolean;
  readonly canRetrySend: boolean;
  readonly onSendMessage: (text: string) => void;
  readonly onRetrySend: () => void;
  readonly onRetry: () => void;
}

export function StationThread({
  dialog,
  stationName,
  messages,
  busy,
  error,
  closed,
  canRetrySend,
  onSendMessage,
  onRetrySend,
  onRetry,
}: StationThreadProps): React.JSX.Element {
  const rows = messages.map((message, index) => {
    const day = message.createdAt ? formatMessageDay(message.createdAt) : null;
    const previous = messages[index - 1];
    const previousDay = previous?.createdAt ? formatMessageDay(previous.createdAt) : null;
    return { message, day, startsDay: day !== null && day !== previousDay };
  });
  return (
    <section className={styles.thread} aria-label={`Диалог со станцией ${stationName}`}>
      <header className={styles.threadHeader}>
        <a className={styles.backLink} href="/chats" aria-label="Назад к чатам">
          <span aria-hidden="true">←</span>
        </a>
        <ChatAvatar isGame={false} title={stationName} />
        <div className={styles.threadHeading}>
          <h2>{stationName}</h2>
          <small>Чат со станцией · обращение обрабатывает ЦУП</small>
        </div>
        <button
          type="button"
          className={styles.refreshButton}
          aria-label="Обновить переписку со станцией"
          title="Обновить"
          disabled={busy !== null}
          onClick={onRetry}
        >
          ⟳
        </button>
      </header>
      <div className={styles.threadBody}>
        <ol className={styles.messages}>
          {messages.length === 0 && busy !== 'load' ? (
            <li className={styles.threadEmpty}>
              {dialog ? 'Сообщений пока нет. Напишите первым.' : 'Начните обращение к станции.'}
            </li>
          ) : null}
          {rows.map(({ message, day, startsDay }) => {
            const own = message.author === 'ME';
            return (
              <li key={message.id} role="presentation">
                {startsDay ? (
                  <div className={styles.daySeparator} role="separator">
                    <span>{day}</span>
                  </div>
                ) : null}
                <div className={`${styles.messageRow} ${own ? styles.ownMessageRow : ''}`}>
                  <article
                    className={`${styles.messageBubble} ${styles.messageTail} ${
                      own ? styles.ownMessageBubble : ''
                    }`}
                  >
                    <strong>{authorLabel(message.author)}</strong>
                    <p>{message.body}</p>
                    {message.createdAt ? (
                      <time dateTime={message.createdAt}>
                        {formatMessageTime(message.createdAt)}
                      </time>
                    ) : null}
                  </article>
                </div>
              </li>
            );
          })}
        </ol>
        {error && error.kind !== 'FEATURE_UNAVAILABLE' ? (
          <div className={styles.retryBar} role="status">
            <span>{error.message}</span>
            {error.kind === 'RETRYABLE' ? (
              <button type="button" disabled={busy !== null} onClick={onRetry}>
                Обновить
              </button>
            ) : null}
          </div>
        ) : null}
        {canRetrySend ? (
          <div className={styles.retryBar} role="status">
            <span>Сообщение не подтверждено сервером.</span>
            <button type="button" disabled={busy !== null} onClick={onRetrySend}>
              Повторить отправку
            </button>
          </div>
        ) : null}
        {closed ? (
          <p className={styles.threadEmpty} role="status">
            Обращение закрыто. Начните новое обращение к станции.
          </p>
        ) : null}
      </div>
      <ChatComposer
        busy={busy === 'send'}
        forbidden={closed || error?.kind === 'FEATURE_UNAVAILABLE'}
        attachments={[]}
        attachmentsEnabled={false}
        onAttachFiles={() => undefined}
        onRemoveAttachment={() => undefined}
        onSendMessage={(input) => onSendMessage(input.body)}
      />
    </section>
  );
}
