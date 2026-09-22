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
import styles from './ChatsUi.module.css';

export interface StationChatsHandlers {
  readonly onSelectDialog: (dialogId: string) => void;
  readonly onStartDialog: (stationId: string) => void;
  readonly onSendMessage: (text: string) => void;
  readonly onRetry: () => void;
}

interface StationDialogListProps extends StationChatsHandlers {
  readonly stations: readonly StationSupportStation[];
  readonly dialogs: readonly StationSupportDialog[];
  readonly selectedDialogId: string | null;
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
  selectedDialogId,
  busy,
  error,
  onSelectDialog,
  onStartDialog,
  onRetry,
}: StationDialogListProps): React.JSX.Element {
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
      {stations.length > 0 ? (
        <form
          className={styles.stationStart}
          onSubmit={(event) => {
            event.preventDefault();
            const select = event.currentTarget.elements.namedItem('station');
            if (select instanceof HTMLSelectElement && select.value) onStartDialog(select.value);
          }}
        >
          <label className="sr-only" htmlFor="station-support-station">
            Станция
          </label>
          <select id="station-support-station" name="station" defaultValue="">
            <option value="" disabled>
              Выберите станцию
            </option>
            {stations.map((station) => (
              <option key={station.id} value={station.id}>
                {station.name}
              </option>
            ))}
          </select>
          <button type="submit" disabled={busy !== null}>
            Написать
          </button>
        </form>
      ) : null}
      {busy === 'load' && dialogs.length === 0 ? (
        <div className={styles.skeletonList} role="status" aria-label="Загружаем чаты станций">
          {Array.from({ length: 3 }, (_, index) => (
            <span key={index} className={styles.skeletonRow} aria-hidden="true" />
          ))}
        </div>
      ) : null}
      {busy !== 'load' && dialogs.length === 0 ? (
        <div className={styles.emptyState} role="status">
          <span className={styles.emptyIcon} aria-hidden="true">
            <ChatCategoryIcon name="STATION" />
          </span>
          <strong>Обращений к станциям пока нет</strong>
          <p>
            {stations.length > 0
              ? 'Выберите станцию и напишите — сообщение попадёт в ЦУП.'
              : 'Станции появятся после публикации площадок.'}
          </p>
        </div>
      ) : null}
      {dialogs.length > 0 ? (
        <ul className={styles.list} aria-label="Чаты станций">
          {dialogs.map((dialog) => (
            <li key={dialog.id}>
              <button
                type="button"
                className={`${styles.listLink} ${styles.stationListButton} ${
                  dialog.id === selectedDialogId ? styles.selectedListLink : ''
                }`}
                aria-current={dialog.id === selectedDialogId ? 'true' : undefined}
                onClick={() => onSelectDialog(dialog.id)}
              >
                <ChatAvatar isGame={false} title={dialog.stationName} />
                <span className={styles.stationListItemBody}>
                  <strong>{dialog.stationName}</strong>
                  <small>{dialog.lastMessage?.preview ?? 'Новый диалог'}</small>
                </span>
                <span className={styles.stationListItemMeta}>
                  {dialog.updatedAt ? (
                    <time dateTime={dialog.updatedAt}>{formatMessageTime(dialog.updatedAt)}</time>
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
