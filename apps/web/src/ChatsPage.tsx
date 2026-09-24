import { useCallback, useEffect, useRef, useState } from 'react';

import { MainBottomNavigation } from './HomeDashboardPage.js';
import type {
  ConversationMessage,
  ConversationNotificationPolicyUpdate,
  ConversationPage,
  StationSupportAttachment,
  StationSupportDialog,
  StationSupportMessage,
  StationSupportMessagePage,
  StationSupportSendResult,
  StationSupportStation,
} from './auth-gateway.js';
import { ChatCategoryIcon } from './chats-ui/ChatCategoryIcon.js';
import {
  ChatFilterHeading,
  ChatFilters,
  ChatSearch,
  type ChatFilter,
} from './chats-ui/ChatFilters.js';
import { ChatList } from './chats-ui/ChatList.js';
import { ChatThread } from './chats-ui/ChatThread.js';
import { StationDialogList, StationThread } from './chats-ui/StationChats.js';
import { stationHistoryRows } from './chats-ui/station-chat-rows.js';
import { type ChatComposerSend } from './chats-ui/ChatComposer.js';
import {
  describeStationAttachmentRejections,
  normalizeAttachmentContentType,
  normalizeAttachmentFileName,
  readFileAsBase64,
  validateStationAttachmentSelection,
  type ChatAttachmentDraft,
} from './chats-ui/chat-attachments.js';
import styles from './chats-ui/ChatsUi.module.css';

/**
 * Station support dialogs are backed by the legacy provider through PadlHub, so the Chats screen
 * loads them lazily on that tab instead of joining the 5-second LK2 conversation refresh. The loader
 * is injected so this component stays usable with a fake source in tests.
 */
export interface StationSupportSource {
  readonly loadStations: () => Promise<readonly StationSupportStation[]>;
  readonly loadDialogs: () => Promise<readonly StationSupportDialog[]>;
  /** One chronological page; `before` walks the thread backwards from an already read timestamp. */
  readonly loadMessages: (dialogId: string, before?: string) => Promise<StationSupportMessagePage>;
  readonly sendMessage: (command: {
    readonly text: string;
    readonly clientMessageId: string;
    readonly stationId?: string;
    readonly dialogId?: string;
    readonly attachmentIds?: readonly string[];
  }) => Promise<StationSupportSendResult>;
  /** Stores one picture in the PadlHub media bucket before the message exists. */
  readonly uploadAttachment: (input: {
    readonly fileName: string;
    readonly contentType: string;
    readonly data: string;
  }) => Promise<StationSupportAttachment>;
  readonly loadAttachment: (attachmentId: string) => Promise<Blob>;
  readonly createMessageId: () => string;
}

export type ChatRouteMode = 'list' | 'new' | 'thread';

export interface ChatUiError {
  readonly kind:
    | 'FEATURE_UNAVAILABLE'
    | 'AUTH'
    | 'FORBIDDEN'
    | 'NOT_FOUND'
    | 'RETRYABLE'
    /** The peer of a new or existing direct chat cannot use chats at all: retrying cannot help. */
    | 'PARTICIPANT_UNAVAILABLE'
    /** A terminal server refusal: retrying the same command cannot succeed. */
    | 'REJECTED';
  readonly message: string;
}

export interface PendingChatMessage {
  readonly clientMessageId: string;
  readonly body: string;
  readonly attachmentIds?: readonly string[];
  readonly state: 'sending' | 'failed';
}

export type ChatRealtimeUiState = 'connecting' | 'connected' | 'reconnecting' | 'polling';

const CHAT_FILTERS: readonly ChatFilter[] = [
  'ALL',
  'DIRECT',
  'GAME',
  'TOURNAMENT',
  'STATION',
  'COMMUNITY',
];

interface ChatViewState {
  readonly filter: ChatFilter;
  readonly query: string;
  readonly unreadOnly: boolean;
}

function chatViewStateKey(userId: string): string {
  return `lk2:chats:view-state:${userId}`;
}

function readChatViewState(userId: string): Partial<ChatViewState> {
  try {
    const stored = window.sessionStorage.getItem(chatViewStateKey(userId));
    if (!stored) return {};
    const parsed: unknown = JSON.parse(stored);
    if (!parsed || typeof parsed !== 'object') return {};
    const candidate = parsed as Record<string, unknown>;
    return {
      ...(typeof candidate.filter === 'string' &&
      CHAT_FILTERS.includes(candidate.filter as ChatFilter)
        ? { filter: candidate.filter as ChatFilter }
        : {}),
      ...(typeof candidate.query === 'string' ? { query: candidate.query.slice(0, 120) } : {}),
      ...(typeof candidate.unreadOnly === 'boolean' ? { unreadOnly: candidate.unreadOnly } : {}),
    };
  } catch {
    // Storage can be unavailable in private browsing and embedded previews.
    return {};
  }
}

/** The single busy slot of the chats screen, shared by the page and its error banner. */
type ChatBusy = 'create' | 'send' | 'refresh' | 'load-earlier' | null;

interface ChatsPageProps {
  readonly page: ConversationPage | null;
  readonly messages: readonly ConversationMessage[];
  readonly mode: ChatRouteMode;
  readonly selectedConversationId?: string;
  readonly hasExplicitRecipient: boolean;
  /** The `/chats/new?open=1` deep link from a profile: create the conversation without a second tap. */
  readonly autoOpenDirect?: boolean | undefined;
  readonly currentUserId: string;
  readonly busy: ChatBusy;
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
  /** Absent means the station tab is not wired in this runtime and keeps its "not connected" copy. */
  readonly stationSupport?: StationSupportSource | null | undefined;
}

interface StationSupportState {
  readonly status: 'idle' | 'ready';
  readonly stations: readonly StationSupportStation[];
  readonly dialogs: readonly StationSupportDialog[];
  readonly messages: readonly StationSupportMessage[];
  readonly selectedDialogId: string | null;
  /** Which dialog the loaded `messages` belong to; a mismatch means the thread is still loading. */
  readonly messagesDialogId: string | null;
  /** True while the server says older pages are still unread. */
  readonly hasEarlierMessages: boolean;
  readonly loadingEarlier: boolean;
  /** The server-issued cursor of the page before the oldest message on screen. */
  readonly olderCursor: string | null;
  readonly pendingStationId: string | null;
  readonly pendingStationName: string | null;
  readonly sending: boolean;
  readonly error: ChatUiError | null;
  /** A failed send keeps its command id so the retry replays the same command. */
  readonly failedMessage: {
    readonly clientMessageId: string;
    readonly text: string;
    readonly attachmentIds: readonly string[];
  } | null;
}

const EMPTY_STATION_STATE: StationSupportState = {
  status: 'idle',
  stations: [],
  dialogs: [],
  messages: [],
  selectedDialogId: null,
  messagesDialogId: null,
  hasEarlierMessages: false,
  loadingEarlier: false,
  olderCursor: null,
  pendingStationId: null,
  pendingStationName: null,
  sending: false,
  error: null,
  failedMessage: null,
};

/**
 * The cursor of the next older page is issued by the server (`nextBefore`), never derived here from
 * a message timestamp: the provider pages on its own ordering instant, and a message may carry no
 * readable timestamp at all. A page that claims more history without a cursor is not paginable, so
 * the control is not offered for it.
 */
function stationPageCursor(page: StationSupportMessagePage): {
  readonly hasEarlierMessages: boolean;
  readonly olderCursor: string | null;
} {
  const olderCursor = page.nextBefore ?? null;
  return { hasEarlierMessages: page.hasMore && olderCursor !== null, olderCursor };
}

function stationAttachmentsUnavailable(error: unknown): boolean {
  const record =
    typeof error === 'object' && error !== null ? (error as { readonly code?: unknown }) : null;
  return record?.code === 'SUPPORT_ATTACHMENTS_UNAVAILABLE';
}

function stationSupportError(error: unknown): ChatUiError {
  const record =
    typeof error === 'object' && error !== null
      ? (error as { readonly status?: unknown; readonly code?: unknown })
      : {};
  const status = typeof record.status === 'number' ? record.status : undefined;
  const code = typeof record.code === 'string' ? record.code : undefined;
  if (code === 'SUPPORT_STATIONS_DISABLED') {
    return {
      kind: 'FEATURE_UNAVAILABLE',
      message: 'Чаты со станциями ещё не включены для этой организации.',
    };
  }
  if (code === 'SUPPORT_DIALOG_NOT_FOUND' || code === 'SUPPORT_STATION_UNKNOWN') {
    return { kind: 'NOT_FOUND', message: 'Диалог со станцией не найден.' };
  }
  if (code === 'SUPPORT_DIALOG_CLOSED') {
    return {
      kind: 'REJECTED',
      message: 'Обращение закрыто. Начните новое обращение к станции.',
    };
  }
  if (code === 'SUPPORT_MESSAGE_REJECTED') {
    return {
      kind: 'REJECTED',
      message: 'Станция отклонила обращение. Проверьте текст и попробуйте снова.',
    };
  }
  if (code === 'IDEMPOTENCY_KEY_REUSED') {
    return {
      kind: 'REJECTED',
      message: 'Сообщение уже отправлялось с другим текстом. Обновите переписку.',
    };
  }
  if (status === 404) {
    // An unknown 404 means the route itself is not published in this runtime.
    return {
      kind: 'FEATURE_UNAVAILABLE',
      message: 'Чаты со станциями ещё не включены для этой организации.',
    };
  }
  if (status === 401) return { kind: 'AUTH', message: 'Нужно войти снова.' };
  if (code === 'SUPPORT_IDENTITY_NOT_LINKED') {
    return {
      kind: 'FORBIDDEN',
      message: 'Чтобы написать станции, привяжите номер телефона в профиле.',
    };
  }
  if (status === 403) return { kind: 'FORBIDDEN', message: 'Нет доступа к обращениям в станции.' };
  if (status === 409) {
    return { kind: 'RETRYABLE', message: 'Обращение к станции сейчас недоступно.' };
  }
  return {
    kind: 'RETRYABLE',
    message: 'Сервис обращений к станциям временно недоступен. Попробуйте ещё раз.',
  };
}

/**
 * The title names the failed operation: opening a new chat and refreshing the inbox fail for
 * different reasons and the same code must not be described as "could not update chats" when the
 * person was starting a dialog.
 */
function errorTitle(kind: ChatUiError['kind'], creating: boolean): string {
  if (kind === 'FEATURE_UNAVAILABLE') return 'Чаты пока недоступны';
  if (kind === 'AUTH') return 'Нужно войти снова';
  if (kind === 'FORBIDDEN') return 'Нет доступа к диалогу';
  if (kind === 'PARTICIPANT_UNAVAILABLE' || (creating && kind === 'NOT_FOUND')) {
    return 'Получатель недоступен';
  }
  if (kind === 'NOT_FOUND') return 'Чат недоступен';
  if (kind === 'REJECTED') return 'Обращение отклонено';
  return creating ? 'Не удалось открыть чат' : 'Не удалось обновить чаты';
}

/**
 * The same refusal is reachable from the list, the thread and the "new chat" screen, so it renders in
 * both layouts. A silent failure is not an option here: a refused peer or a switched-off contour only
 * ever retries into the same answer, and the person needs to know that. `onRefresh` is the action that
 * failed, so "Повторить" repeats that action instead of an unrelated reload.
 */
function ChatErrorBanner({
  error,
  creating = false,
  busy,
  onRefresh,
}: {
  readonly error: ChatUiError | null;
  readonly creating?: boolean;
  readonly busy: ChatBusy;
  readonly onRefresh: () => void;
}): React.JSX.Element | null {
  if (!error) return null;
  return (
    <section className={styles.errorBanner} role="alert">
      <span>
        <strong>{errorTitle(error.kind, creating)}</strong>
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
  );
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
  autoOpenDirect,
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
  stationSupport,
}: ChatsPageProps): React.JSX.Element {
  const [filter, setFilter] = useState<ChatFilter>(
    () => readChatViewState(currentUserId).filter ?? 'ALL',
  );
  const [query, setQuery] = useState(() => readChatViewState(currentUserId).query ?? '');
  const [unreadOnly, setUnreadOnly] = useState(
    () => readChatViewState(currentUserId).unreadOnly ?? false,
  );
  const [stationState, setStationState] = useState<StationSupportState>(EMPTY_STATION_STATE);
  const [stationReloadToken, setStationReloadToken] = useState(0);
  const [stationAttachments, setStationAttachments] = useState<readonly ChatAttachmentDraft[]>([]);
  const [stationAttachmentNotice, setStationAttachmentNotice] = useState<string | null>(null);
  /** A deployment without a media bucket keeps the composer text-only instead of failing sends. */
  const [stationAttachmentsEnabled, setStationAttachmentsEnabled] = useState(true);
  const stationRequestRef = useRef(0);
  const selected = page?.items.find((conversation) => conversation.id === selectedConversationId);
  const stationSource = stationSupport ?? null;
  const stationDialogs = stationState.dialogs;
  const stationSelectedDialog =
    stationDialogs.find((dialog) => dialog.id === stationState.selectedDialogId) ?? null;

  // Loading state is derived from the data, so the effect never sets state synchronously: `idle`
  // means "not loaded yet" and a dialog/messages id mismatch means "this thread is still loading".
  const loadStationSupport = useCallback((): void => {
    if (!stationSource) return;
    const generation = stationRequestRef.current + 1;
    stationRequestRef.current = generation;
    void Promise.all([stationSource.loadStations(), stationSource.loadDialogs()]).then(
      ([stations, dialogs]) => {
        if (stationRequestRef.current !== generation) return;
        setStationState((current) => ({
          ...current,
          status: 'ready',
          stations,
          dialogs,
          error: null,
        }));
      },
      (error: unknown) => {
        if (stationRequestRef.current !== generation) return;
        setStationState((current) => ({
          ...current,
          status: 'ready',
          error: stationSupportError(error),
        }));
      },
    );
  }, [stationSource]);

  // The unfiltered tab shows the station dialogs that already have correspondence next to the LK2
  // conversations, so the provider read belongs to "Все" as well as to the station tab. It stays a
  // single read per screen: both effects are gated on the `idle` status.
  useEffect(() => {
    if (filter !== 'STATION' && filter !== 'ALL') return;
    if (!stationSource || stationState.status !== 'idle') return;
    loadStationSupport();
  }, [filter, stationSource, stationState.status, loadStationSupport]);

  useEffect(() => {
    const dialogId = stationState.selectedDialogId;
    if (filter !== 'STATION' || !stationSource || !dialogId) return;
    let active = true;
    void stationSource.loadMessages(dialogId).then(
      (page) => {
        if (!active) return;
        setStationState((current) => ({
          ...current,
          status: 'ready',
          messages: page.items,
          messagesDialogId: dialogId,
          ...stationPageCursor(page),
          loadingEarlier: false,
          error: null,
        }));
      },
      (error: unknown) => {
        if (!active) return;
        setStationState((current) => ({
          ...current,
          status: 'ready',
          messagesDialogId: dialogId,
          hasEarlierMessages: false,
          olderCursor: null,
          loadingEarlier: false,
          error: stationSupportError(error),
        }));
      },
    );
    return () => {
      active = false;
    };
  }, [filter, stationSource, stationState.selectedDialogId, stationReloadToken]);

  /**
   * Walking the thread backwards is the only read that is appended above the current view, so a page
   * that repeats what is already on screen ends the walk instead of leaving a "load more" control
   * that can never make progress.
   */
  function loadOlderStationMessages(): void {
    const dialogId = stationState.selectedDialogId;
    const before = stationState.olderCursor;
    if (!stationSource || !dialogId || !before || stationState.loadingEarlier) return;
    const generation = stationRequestRef.current;
    setStationState((current) => ({ ...current, loadingEarlier: true, error: null }));
    void stationSource.loadMessages(dialogId, before).then(
      (page) => {
        setStationState((current) => {
          if (current.selectedDialogId !== dialogId || stationRequestRef.current !== generation) {
            // The thread moved on; the page is dropped, but the flag must not stay stuck true or the
            // control would never be usable again.
            return current.loadingEarlier ? { ...current, loadingEarlier: false } : current;
          }
          const known = new Set(current.messages.map((message) => message.id));
          const older = page.items.filter((message) => !known.has(message.id));
          const cursor = older.length > 0 ? stationPageCursor(page) : null;
          return {
            ...current,
            loadingEarlier: false,
            hasEarlierMessages: cursor?.hasEarlierMessages ?? false,
            olderCursor: cursor?.olderCursor ?? null,
            messages: older.length > 0 ? [...older, ...current.messages] : current.messages,
          };
        });
      },
      (error: unknown) => {
        setStationState((current) =>
          current.selectedDialogId === dialogId
            ? { ...current, loadingEarlier: false, error: stationSupportError(error) }
            : current,
        );
      },
    );
  }

  const stationThreadLoading =
    stationState.selectedDialogId !== null &&
    stationState.messagesDialogId !== stationState.selectedDialogId;
  const stationListBusy: 'load' | 'send' | null = stationState.sending
    ? 'send'
    : stationState.status === 'idle' && stationDialogs.length === 0
      ? 'load'
      : null;
  const stationThreadBusy: 'load' | 'load-earlier' | 'send' | null = stationState.sending
    ? 'send'
    : stationThreadLoading
      ? 'load'
      : stationState.loadingEarlier
        ? 'load-earlier'
        : null;
  // A station thread opens in place instead of navigating to `/chats/<id>`, so a phone has no route
  // change to swap panes with: the shell itself must leave list mode or the thread stays hidden.
  const stationThreadOpen =
    filter === 'STATION' &&
    stationSource !== null &&
    (stationSelectedDialog !== null || stationState.pendingStationId !== null);

  function retryStationMessage(): void {
    const failed = stationState.failedMessage;
    if (!failed) return;
    sendStationMessage(
      { body: failed.text, attachmentIds: failed.attachmentIds },
      failed.clientMessageId,
    );
  }

  /**
   * Each picture is stored by PadlHub before the message exists, so a rejected upload can be
   * retried on its own and a sent command only carries ids.
   */
  function handleAttachStationFiles(files: readonly File[]): void {
    if (!stationSource || files.length === 0) return;
    const selection = validateStationAttachmentSelection(stationAttachments.length, files);
    setStationAttachmentNotice(describeStationAttachmentRejections(selection.rejections));
    if (selection.accepted.length === 0) return;
    const drafts: readonly ChatAttachmentDraft[] = selection.accepted.map((file) => {
      const contentType = normalizeAttachmentContentType(file.type);
      return {
        localId: stationSource.createMessageId(),
        fileName: normalizeAttachmentFileName(file.name),
        contentType,
        byteSize: file.size,
        mediaType: 'IMAGE' as const,
        state: 'UPLOADING' as const,
        progress: 0,
      };
    });
    setStationAttachments((current) => [...current, ...drafts]);
    selection.accepted.forEach((file, index) => {
      const draft = drafts[index];
      if (!draft) return;
      void readFileAsBase64(file)
        .then((data) =>
          stationSource.uploadAttachment({
            fileName: draft.fileName,
            contentType: draft.contentType,
            data,
          }),
        )
        .then(
          (attachment) => {
            setStationAttachments((current) =>
              current.map((item) =>
                item.localId === draft.localId
                  ? {
                      ...item,
                      state: 'READY' as const,
                      progress: 100,
                      mediaId: attachment.id,
                      fileName: attachment.fileName,
                      contentType: attachment.contentType,
                      byteSize: attachment.byteSize,
                    }
                  : item,
              ),
            );
          },
          (error: unknown) => {
            if (stationAttachmentsUnavailable(error)) {
              setStationAttachmentsEnabled(false);
              setStationAttachmentNotice('Фотографии временно недоступны.');
            } else {
              setStationAttachmentNotice('Фото не загрузилось. Попробуйте ещё раз.');
            }
            setStationAttachments((current) =>
              current.map((item) =>
                item.localId === draft.localId
                  ? { ...item, state: 'FAILED' as const, errorMessage: 'не загрузилось' }
                  : item,
              ),
            );
          },
        );
    });
  }

  function handleRemoveStationAttachment(localId: string): void {
    setStationAttachments((current) =>
      current.filter((attachment) => attachment.localId !== localId),
    );
    setStationAttachmentNotice(null);
  }

  function reloadStationThread(): void {
    setStationState((current) => ({ ...current, error: null }));
    setStationReloadToken((token) => token + 1);
  }

  function selectStationDialog(dialogId: string): void {
    setStationState((current) => ({
      ...current,
      selectedDialogId: dialogId,
      messagesDialogId: null,
      hasEarlierMessages: false,
      loadingEarlier: false,
      olderCursor: null,
      pendingStationId: null,
      pendingStationName: null,
      messages: [],
      error: null,
    }));
  }

  /**
   * "Все" carries the station dialogs that already have correspondence, but their thread is rendered
   * by the station block. Opening one from the unfiltered list therefore switches to that block
   * instead of keeping a second copy of the same thread alive.
   */
  function openStationDialogFromList(dialogId: string): void {
    selectStationDialog(dialogId);
    setFilter('STATION');
  }

  function startStationDialog(stationId: string): void {
    const station = stationState.stations.find((item) => item.id === stationId);
    const existing = stationDialogs.find((dialog) => dialog.stationId === stationId);
    if (existing) {
      selectStationDialog(existing.id);
      return;
    }
    setStationState((current) => ({
      ...current,
      selectedDialogId: null,
      messagesDialogId: null,
      hasEarlierMessages: false,
      loadingEarlier: false,
      olderCursor: null,
      pendingStationId: stationId,
      pendingStationName: station?.name ?? 'Станция',
      messages: [],
      error: null,
    }));
  }

  function sendStationMessage(input: ChatComposerSend, retryClientMessageId?: string): void {
    if (!stationSource || stationState.sending) return;
    const dialogId = stationState.selectedDialogId;
    const stationId = stationState.pendingStationId;
    if (!dialogId && !stationId) return;
    const text = input.body;
    const attachmentIds = [...input.attachmentIds];
    if (text.length === 0 && attachmentIds.length === 0) return;
    // A retry reuses the original command id so the provider replays instead of duplicating.
    const clientMessageId = retryClientMessageId ?? stationSource.createMessageId();
    // The upload already stored every picture, so the optimistic bubble can load it back through
    // the same authorized route the history uses.
    const optimisticAttachments: readonly StationSupportAttachment[] = stationAttachments
      .filter(
        (draft): draft is ChatAttachmentDraft & { mediaId: string } =>
          typeof draft.mediaId === 'string' && attachmentIds.includes(draft.mediaId),
      )
      .map((draft) => ({
        id: draft.mediaId,
        fileName: draft.fileName,
        contentType: draft.contentType,
        byteSize: draft.byteSize,
        url: '',
      }));
    const optimistic: StationSupportMessage = {
      id: `pending:${clientMessageId}`,
      body: text,
      author: 'ME',
      authorName: null,
      createdAt: new Date().toISOString(),
      attachments: optimisticAttachments,
    };
    // The drafts survive a failed send: the retry has to show the same pictures again, and the
    // stored uploads are still addressable by the same ids.
    setStationState((current) => ({
      ...current,
      sending: true,
      error: null,
      failedMessage: null,
      messages: [...current.messages, optimistic],
    }));
    void stationSource
      .sendMessage({
        text,
        clientMessageId,
        ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
        ...(dialogId ? { dialogId } : { stationId: stationId as string }),
      })
      .then(
        (result) => {
          setStationAttachments([]);
          setStationAttachmentNotice(null);
          setStationState((current) => ({
            ...current,
            sending: false,
            selectedDialogId: result.dialogId,
            pendingStationId: null,
            pendingStationName: null,
          }));
          void Promise.all([
            stationSource.loadDialogs(),
            stationSource.loadMessages(result.dialogId),
          ]).then(
            ([dialogs, page]) => {
              setStationState((current) => ({
                ...current,
                status: 'ready',
                dialogs,
                messages: page.items,
                messagesDialogId: result.dialogId,
                ...stationPageCursor(page),
                loadingEarlier: false,
                error: null,
              }));
            },
            (error: unknown) => {
              setStationState((current) => ({ ...current, error: stationSupportError(error) }));
            },
          );
        },
        (error: unknown) => {
          setStationState((current) => ({
            ...current,
            sending: false,
            messages: current.messages.filter((message) => message.id !== optimistic.id),
            error: stationSupportError(error),
            failedMessage: { clientMessageId, text, attachmentIds },
          }));
        },
      );
  }

  useEffect(() => {
    try {
      window.sessionStorage.setItem(
        chatViewStateKey(currentUserId),
        JSON.stringify({ filter, query: query.slice(0, 120), unreadOnly } satisfies ChatViewState),
      );
    } catch {
      // Storage can be unavailable in private browsing and embedded previews.
    }
  }, [currentUserId, filter, query, unreadOnly]);

  /**
   * A profile link carries `open=1`, so the conversation is created as soon as the screen mounts.
   * The ref keeps the command single-shot across the re-renders the create call itself causes; the
   * page keeps the idempotency key in `App`, so a retry after a failure replays the same command.
   */
  const autoOpenStarted = useRef(false);
  useEffect(() => {
    if (!autoOpenDirect || mode !== 'new' || !hasExplicitRecipient) return;
    if (autoOpenStarted.current) return;
    autoOpenStarted.current = true;
    onCreateDirect();
  }, [autoOpenDirect, mode, hasExplicitRecipient, onCreateDirect]);

  if (mode === 'new') {
    return (
      <main className={styles.page}>
        <ChatErrorBanner
          error={error}
          creating
          busy={busy}
          onRefresh={hasExplicitRecipient ? onCreateDirect : onRefresh}
        />
        {autoOpenDirect && hasExplicitRecipient && !error ? (
          <section className={styles.directStart} role="status" aria-live="polite">
            <h1>Открываем диалог…</h1>
            <p>Создаём личный чат ПадлХАБ с выбранным игроком.</p>
          </section>
        ) : (
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
        )}
        <MainBottomNavigation active="chats" />
      </main>
    );
  }

  return (
    <main className={`${styles.page} ${mode === 'thread' ? styles.threadPage : ''}`}>
      <ChatErrorBanner error={error} busy={busy} onRefresh={onRefresh} />
      <section
        className={`${styles.shell} ${
          mode === 'thread' || stationThreadOpen ? styles.threadMode : styles.listMode
        }`}
        aria-label="Чаты"
      >
        <aside className={styles.listPane} aria-label="Список чатов">
          <header className={styles.listHeader}>
            <ChatFilterHeading filter={filter} />
            <ChatSearch query={query} onQueryChange={setQuery} />
            {/* One tap on the marker itself is the whole filter: the previous three-dot panel hid the
                only unread control behind a menu and needed two taps for the same result. */}
            <button
              type="button"
              className={`${styles.unreadToggle} ${unreadOnly ? styles.unreadToggleOn : ''}`}
              aria-pressed={unreadOnly}
              aria-label="Только непрочитанные"
              title="Только непрочитанные"
              onClick={() => setUnreadOnly(!unreadOnly)}
            >
              <ChatCategoryIcon name="UNREAD" />
            </button>
          </header>
          <ChatFilters filter={filter} onFilterChange={setFilter} />
          {filter === 'STATION' ? (
            stationSource ? (
              <StationDialogList
                stations={stationState.stations}
                dialogs={stationDialogs}
                query={query}
                selectedDialogId={stationState.selectedDialogId}
                selectedStationId={stationState.pendingStationId}
                busy={stationListBusy}
                error={
                  stationSelectedDialog || stationState.pendingStationId ? null : stationState.error
                }
                onSelectDialog={selectStationDialog}
                onSelectStation={startStationDialog}
                onRetry={loadStationSupport}
              />
            ) : (
              <div className={styles.emptyState} role="status">
                <span className={styles.emptyIcon} aria-hidden="true">
                  <ChatCategoryIcon name="STATION" />
                </span>
                <strong>Чаты станций</strong>
                <p>Этот тип чатов ещё не подключён. Здесь появятся обсуждения с участниками.</p>
              </div>
            )
          ) : (
            <ChatList
              page={page}
              error={Boolean(error)}
              unreadOnly={unreadOnly}
              filter={filter}
              query={query}
              stationRows={stationHistoryRows({ dialogs: stationDialogs, query })}
              onOpenStation={openStationDialogFromList}
              {...(selectedConversationId ? { selectedConversationId } : {})}
            />
          )}
        </aside>
        {filter === 'STATION' && stationSource ? (
          stationSelectedDialog || stationState.pendingStationId ? (
            <StationThread
              dialog={stationSelectedDialog}
              stationName={
                stationSelectedDialog?.stationName ?? stationState.pendingStationName ?? 'Станция'
              }
              messages={stationState.messages}
              busy={stationThreadBusy}
              error={stationState.error}
              closed={stationSelectedDialog?.status.toUpperCase() === 'CLOSED'}
              canRetrySend={
                stationState.failedMessage !== null && stationState.error?.kind === 'RETRYABLE'
              }
              attachments={stationAttachments}
              attachmentNotice={stationAttachmentNotice}
              attachmentsEnabled={stationAttachmentsEnabled}
              onAttachFiles={handleAttachStationFiles}
              onRemoveAttachment={handleRemoveStationAttachment}
              onSendMessage={sendStationMessage}
              onRetrySend={retryStationMessage}
              onRetry={reloadStationThread}
              hasEarlierMessages={stationState.hasEarlierMessages}
              onLoadEarlier={loadOlderStationMessages}
              loadAttachment={stationSource.loadAttachment}
            />
          ) : (
            <section className={styles.threadPlaceholder} aria-label="Обращения к станциям">
              <span className={styles.placeholderIcon} aria-hidden="true">
                <ChatCategoryIcon name="STATION" />
              </span>
              <h2>Напишите станции</h2>
              <p>
                Выберите станцию и задайте вопрос — обращение попадёт в ЦУП.
                <br />
                Ответ появится здесь.
              </p>
            </section>
          )
        ) : mode === 'thread' && selectedConversationId ? (
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
