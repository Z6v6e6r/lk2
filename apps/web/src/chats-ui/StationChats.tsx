import { useCallback, useLayoutEffect, useRef, useState } from 'react';

import { formatMessageDay, formatMessageTime } from './chat-format.js';
import { ChatComposer, type ChatComposerSend } from './ChatComposer.js';
import { ChatCategoryIcon } from './ChatCategoryIcon.js';
import { ChatImageViewer } from './ChatImageViewer.js';
import { ExternalChatListItem } from './ExternalChatListItem.js';
import { StationChatRowItem } from './StationChatRowItem.js';
import { StationAvatar } from './StationAvatar.js';
import type { ChatAttachmentDraft } from './chat-attachments.js';
import { externalChatRows } from './external-chats.js';
import type { ChatUiError } from '../ChatsPage.js';
import type {
  StationSupportAttachment,
  StationSupportDialog,
  StationSupportMessage,
  StationSupportStation,
} from '../auth-gateway.js';
import { stationChatRows } from './station-chat-rows.js';
import styles from './ChatsUi.module.css';
import { useAttachmentObjectUrl } from './useAttachmentObjectUrl.js';

export interface StationChatsHandlers {
  readonly onSelectDialog: (dialogId: string) => void;
  readonly onSelectStation: (stationId: string) => void;
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

/**
 * The station answer belongs to the CUP operator who wrote it, so the thread shows that name and
 * only falls back to the station when the provider stored none.
 */
function authorLabel(message: StationSupportMessage): string {
  if (message.author === 'ME') return 'Вы';
  if (message.author === 'STATION') return message.authorName?.trim() || 'Станция';
  return 'Система';
}

function StationAttachmentImage({
  attachment,
  loadAttachment,
}: {
  readonly attachment: StationSupportAttachment;
  readonly loadAttachment: (attachmentId: string) => Promise<Blob>;
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const load = useCallback(() => loadAttachment(attachment.id), [attachment.id, loadAttachment]);
  const { url, failed } = useAttachmentObjectUrl(`station:${attachment.id}`, load);

  if (failed) return <span className={styles.attachmentUnavailable}>Изображение недоступно</span>;
  if (!url) {
    return (
      <span className={styles.attachmentPending} aria-live="polite">
        Загружаем изображение…
      </span>
    );
  }
  return (
    <>
      <button
        type="button"
        className={styles.attachmentImageButton}
        aria-label={`Открыть изображение ${attachment.fileName}`}
        onClick={() => setExpanded(true)}
      >
        <img src={url} alt={attachment.fileName} loading="lazy" />
      </button>
      {expanded ? (
        <ChatImageViewer src={url} alt={attachment.fileName} onClose={() => setExpanded(false)} />
      ) : null}
    </>
  );
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
  // The outbound channels are not station dialogs, but they are the same kind of destination: one
  // fixed set of PadlHub addresses a player reaches from the community. They close the block so the
  // station list keeps the top of the screen and the channels stay a stable, expected last stop.
  const externalChats = externalChatRows(query);
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
      {!loading && stations.length > 0 && rows.length === 0 && externalChats.length === 0 ? (
        <div className={styles.emptyState} role="status">
          <strong>Ничего не найдено</strong>
          <p>Измените запрос или выберите другую станцию.</p>
        </div>
      ) : null}
      {rows.length > 0 || externalChats.length > 0 ? (
        <ul className={styles.list} aria-label="Станции и каналы ПадлХАБ">
          {rows.map((row) => (
            <StationChatRowItem
              key={row.key}
              row={row}
              onOpen={() => {
                if (row.dialogId) onSelectDialog(row.dialogId);
                else if (row.stationId) onSelectStation(row.stationId);
              }}
            />
          ))}
          {externalChats.map((destination) => (
            <ExternalChatListItem key={destination.key} destination={destination} />
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
  readonly busy: 'load' | 'load-earlier' | 'send' | null;
  readonly error: ChatUiError | null;
  readonly closed: boolean;
  readonly canRetrySend: boolean;
  readonly hasEarlierMessages: boolean;
  readonly attachments: readonly ChatAttachmentDraft[];
  readonly attachmentNotice?: string | null | undefined;
  /** Absent when the deployment has no media bucket: the composer then stays text-only. */
  readonly attachmentsEnabled: boolean;
  readonly onAttachFiles: (files: readonly File[]) => void;
  readonly onRemoveAttachment: (localId: string) => void;
  readonly onSendMessage: (input: ChatComposerSend) => void;
  readonly onRetrySend: () => void;
  readonly onRetry: () => void;
  readonly onLoadEarlier: () => void;
  readonly loadAttachment: (attachmentId: string) => Promise<Blob>;
}

/** How close to the top edge counts as "the person wants the rest of the history". */
const EARLIER_PAGE_TRIGGER_PX = 96;

export function StationThread({
  dialog,
  stationName,
  messages,
  busy,
  error,
  closed,
  canRetrySend,
  hasEarlierMessages,
  attachments,
  attachmentNotice,
  attachmentsEnabled,
  onAttachFiles,
  onRemoveAttachment,
  onSendMessage,
  onRetrySend,
  onRetry,
  onLoadEarlier,
  loadAttachment,
}: StationThreadProps): React.JSX.Element {
  const rows = messages.map((message, index) => {
    const day = message.createdAt ? formatMessageDay(message.createdAt) : null;
    const previous = messages[index - 1];
    const previousDay = previous?.createdAt ? formatMessageDay(previous.createdAt) : null;
    return { message, day, startsDay: day !== null && day !== previousDay };
  });
  const listRef = useRef<HTMLOListElement>(null);
  const dialogKey = dialog?.id ?? null;
  /**
   * The scroll position is measured against the previous render, because an older page arrives above
   * the current view and must not throw the reader to the top of the thread.
   */
  const snapshotRef = useRef<{
    readonly dialogKey: string | null;
    readonly oldestId: string | null;
    readonly newestId: string | null;
    readonly scrollHeight: number;
    readonly nearBottom: boolean;
  } | null>(null);
  /** One request per gesture: a scroll stream must not fire a page per scroll event. */
  const requestedEarlierRef = useRef(false);

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const oldestId = messages[0]?.id ?? null;
    const newestId = messages.at(-1)?.id ?? null;
    const previous = snapshotRef.current;
    const sameDialog = previous?.dialogKey === dialogKey;
    if (!previous || !sameDialog) {
      // A station thread is opened at its end: the newest answer is why the person came back, and
      // the rest of the history is pulled in only when they scroll up.
      list.scrollTop = list.scrollHeight;
    } else if (oldestId !== previous.oldestId && previous.oldestId !== null) {
      list.scrollTop += list.scrollHeight - previous.scrollHeight;
    } else if (newestId !== previous.newestId && previous.nearBottom) {
      list.scrollTop = list.scrollHeight;
    }
    snapshotRef.current = {
      dialogKey,
      oldestId,
      newestId,
      scrollHeight: list.scrollHeight,
      nearBottom: list.scrollHeight - list.scrollTop - list.clientHeight < 72,
    };
  }, [dialogKey, messages]);

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
    <section className={styles.thread} aria-label={`Диалог со станцией ${stationName}`}>
      <header className={`${styles.threadHeader} ${styles.stationThreadHeader}`}>
        <a className={styles.backLink} href="/chats" aria-label="Назад к чатам">
          <span aria-hidden="true">←</span>
        </a>
        <StationAvatar title={stationName} />
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
        <ol className={styles.messages} ref={listRef} onScroll={handleScroll}>
          {hasEarlierMessages ? (
            <li className={styles.loadEarlierRow} role="presentation">
              <button type="button" disabled={busy !== null} onClick={onLoadEarlier}>
                {busy === 'load-earlier' ? 'Загружаем…' : 'Показать предыдущие сообщения'}
              </button>
            </li>
          ) : null}
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
                    <strong>{authorLabel(message)}</strong>
                    {message.attachments.length > 0 ? (
                      <ul
                        className={`${styles.attachmentImages} ${
                          message.attachments.length === 1 ? styles.singleAttachmentImage : ''
                        }`}
                        aria-label="Изображения в сообщении"
                      >
                        {message.attachments.map((attachment) => (
                          <li key={attachment.id}>
                            <StationAttachmentImage
                              attachment={attachment}
                              loadAttachment={loadAttachment}
                            />
                          </li>
                        ))}
                      </ul>
                    ) : null}
                    {message.body ? <p>{message.body}</p> : null}
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
        attachments={attachments}
        attachmentNotice={attachmentNotice}
        attachmentsEnabled={attachmentsEnabled}
        onAttachFiles={onAttachFiles}
        onRemoveAttachment={onRemoveAttachment}
        onSendMessage={onSendMessage}
      />
    </section>
  );
}
