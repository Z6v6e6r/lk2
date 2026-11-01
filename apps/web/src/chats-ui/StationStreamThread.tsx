import styles from './ChatsUi.module.css';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  validateStationReadRequest,
  type StationReadRequest,
  type StationReadReceipt,
  type StationStreamPage,
  type StationStreamSummaries,
} from '@phub/api-sdk';
import type { CommunityChatsSource } from '../ChatsPage.js';
import { CommunityThread } from './CommunityChats.js';
import type { CommunityChatMessage, CommunityRow } from './community-chat-rows.js';
import {
  acceptStationStreamPage,
  sameStationStream,
  stationReadableThrough,
  type AvailableStationStream,
  type StationStreamView,
} from './station-stream-state.js';
export interface StationStreamSource {
  readonly scope: string;
  readonly principal: string;
  readonly isCurrent: () => boolean;
  readonly summaries: (ids: readonly string[]) => Promise<StationStreamSummaries>;
  readonly page: (id: string, cursor?: string) => Promise<StationStreamPage>;
  readonly read: (id: string, input: StationReadRequest) => Promise<StationReadReceipt>;
  readonly status: (id: string, requestId: string) => Promise<StationReadReceipt>;
}
function initial(position: AvailableStationStream): StationStreamView {
  return {
    position,
    rows: [],
    archive: [],
    forward: null,
    older: null,
    archiveCursor: null,
    allowed: false,
  };
}
export function StationStreamThread({
  community,
  summary,
  source,
  chat,
  onPosition,
}: {
  readonly community: CommunityRow;
  readonly summary: AvailableStationStream;
  readonly source: StationStreamSource;
  readonly chat: CommunityChatsSource;
  readonly onPosition: (value: AvailableStationStream) => void;
}): React.JSX.Element {
  const [view, setView] = useState(() => initial(summary));
  const viewRef = useRef(view);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null),
    [notice, setNotice] = useState<string | null>(null);
  const [overlay, setOverlay] = useState<readonly CommunityChatMessage[]>([]);
  const [pending, setPending] = useState<StationReadRequest | null>(null);
  const life = useRef({ active: true, flight: false });
  const displayed = useRef(0);
  const key = `lk2:station-read:v1:${source.scope}:${community.id}`;
  const current = () => life.current.active && source.isCurrent();
  const persist = (request: StationReadRequest | null) => {
    if (!current()) throw new Error('AUTH_PRINCIPAL_CHANGED');
    if (request) {
      const encoded = JSON.stringify(request);
      window.sessionStorage.setItem(key, encoded);
      if (window.sessionStorage.getItem(key) !== encoded) throw new Error('READ_CUSTODY_UNPROVEN');
    } else {
      window.sessionStorage.removeItem(key);
      if (window.sessionStorage.getItem(key) !== null) throw new Error('READ_CUSTODY_UNPROVEN');
    }
    if (!current()) throw new Error('AUTH_PRINCIPAL_CHANGED');
    setPending(request);
  };
  const accept = (
    page: StationStreamPage,
    purpose: 'initial' | 'forward' | 'older' | 'archive',
  ) => {
    if (!current()) throw new Error('AUTH_PRINCIPAL_CHANGED');
    const next = acceptStationStreamPage(viewRef.current, page, purpose);
    viewRef.current = next;
    setView(next);
    onPosition(next.position);
    setOverlay((items) =>
      items.filter((item) => ![...next.rows, ...next.archive].some((row) => row.id === item.id)),
    );
  };
  async function load(purpose: 'initial' | 'forward' | 'older' | 'archive'): Promise<void> {
    if (!current() || life.current.flight) return;
    const lifetime = life.current;
    const valid = () => life.current === lifetime && lifetime.active && source.isCurrent();
    lifetime.flight = true;
    setBusy(true);
    setError(null);
    let cursor =
      purpose === 'initial'
        ? undefined
        : purpose === 'forward'
          ? viewRef.current.forward
          : purpose === 'older'
            ? viewRef.current.older
            : viewRef.current.archiveCursor;
    try {
      if (purpose !== 'initial' && !cursor) return;
      // At most ten pages per wake-up; a longer backlog retains its exact next cursor for explicit continuation.
      for (let count = 0; count < 10; count++) {
        if (!valid()) return;
        const page = await source.page(community.id, cursor ?? undefined);
        if (!valid()) return;
        accept(page, purpose);
        if (purpose !== 'forward' || !page.nextCursor) break;
        if (page.nextCursor === cursor) throw new Error('STATION_STREAM_CURSOR_STUCK');
        cursor = page.nextCursor;
      }
    } catch {
      if (valid()) {
        // An adopted stream never silently falls back or keeps private stale rows after denied/unproven reads.
        setError('Не удалось подтвердить доступ к истории. Повторите обновление.');
        const held = initial(viewRef.current.position);
        viewRef.current = held;
        setView(held);
        setOverlay([]);
      }
    } finally {
      lifetime.flight = false;
      if (valid()) setBusy(false);
    }
  }
  async function readReceipt(request: StationReadRequest, dispatch: boolean): Promise<void> {
    if (!current() || life.current.flight) return;
    const lifetime = life.current;
    const valid = () => life.current === lifetime && lifetime.active && source.isCurrent();
    lifetime.flight = true;
    setBusy(true);
    setNotice(null);
    let custodySaved = !dispatch;
    try {
      if (dispatch) {
        persist(request);
        custodySaved = true;
        if (!valid()) return;
      }
      const receipt = await (dispatch
        ? source.read(community.id, request)
        : source.status(community.id, request.requestId));
      if (!valid()) return;
      if (receipt.outcome !== 'CONFIRMED') {
        if (receipt.code === 'READ_ACCESS_DENIED') {
          const empty = initial(viewRef.current.position);
          viewRef.current = empty;
          setView(empty);
          setOverlay([]);
          setError('Доступ к чату не подтверждён.');
        }
        setNotice('Прочтение пока не подтверждено. Проверьте статус позже.');
        return;
      }
      if (
        receipt.requestId !== request.requestId ||
        !sameStationStream(receipt, request) ||
        receipt.throughSequence !== request.throughSequence
      )
        throw new Error('READ_RECEIPT_CONFLICT');
      // Storage is removed only for the exact original receipt. An epoch change cannot adopt it.
      const stored = window.sessionStorage.getItem(key);
      if (
        !stored ||
        JSON.stringify(validateStationReadRequest(JSON.parse(stored))) !== JSON.stringify(request)
      )
        throw new Error('READ_CUSTODY_CHANGED');
      persist(null);
      setNotice('Прочтение подтверждено. Обновите историю для текущего счётчика.');
    } catch (error) {
      if (
        valid() &&
        error &&
        typeof error === 'object' &&
        'status' in error &&
        (error.status === 401 || error.status === 403)
      ) {
        const empty = initial(viewRef.current.position);
        viewRef.current = empty;
        setView(empty);
        setOverlay([]);
        setError('Доступ к чату не подтверждён.');
      }
      if (valid())
        setNotice(
          custodySaved
            ? 'Статус прочтения пока недоступен. Исходный запрос сохранён.'
            : 'Запрос прочтения не отправлен: не удалось сохранить его идентификатор.',
        );
    } finally {
      lifetime.flight = false;
      if (valid()) setBusy(false);
    }
  }
  useEffect(() => {
    const lifetime = { active: true, flight: false };
    life.current = lifetime;
    const wake = () => {
      if (document.visibilityState === 'visible' && navigator.onLine)
        void load(viewRef.current.forward ? 'forward' : 'initial');
    };
    const begin = async () => {
      try {
        const raw = window.sessionStorage.getItem(key);
        if (raw) {
          const request = validateStationReadRequest(JSON.parse(raw));
          setPending(request);
          await readReceipt(request, false);
        }
      } catch {
        if (current())
          setNotice('Хранилище статуса прочтения недоступно. Отметка прочтения отключена.');
      }
      if (current()) await load('initial');
    };
    void begin();
    window.addEventListener('online', wake);
    window.addEventListener('focus', wake);
    document.addEventListener('visibilitychange', wake);
    return () => {
      lifetime.active = false;
      window.removeEventListener('online', wake);
      window.removeEventListener('focus', wake);
      document.removeEventListener('visibilitychange', wake);
    };
    // The parent keys the component by original principal, community, stream and epoch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, community.id, key]);
  useLayoutEffect(() => {
    displayed.current = stationReadableThrough(view);
  }, [view]);
  const through = stationReadableThrough(view),
    gap = through < view.position.publishedThroughSequence;
  const read = () => {
    if (!current() || busy || error || document.visibilityState !== 'visible') return;
    try {
      const raw = window.sessionStorage.getItem(key);
      if (raw) {
        void readReceipt(validateStationReadRequest(JSON.parse(raw)), false);
        return;
      }
      if (through <= view.position.readThroughSequence || displayed.current !== through) return;
      void readReceipt(
        {
          requestId: crypto.randomUUID(),
          streamId: view.position.streamId,
          membershipEpoch: view.position.membershipEpoch,
          throughSequence: through,
        },
        true,
      );
    } catch {
      setNotice('Хранилище статуса прочтения недоступно. Запрос не отправлен.');
    }
  };
  return (
    <div
      className={styles.thread}
      style={{ display: 'grid', gridTemplateRows: 'auto minmax(0, 1fr)', height: '100%' }}
    >
      <div>
        <p className={styles.refreshNotice} role="status">
          Непрочитанных сообщений: {error ? 'недоступно' : view.position.unreadCount}
        </p>
        {notice ? (
          <p className={styles.refreshNotice} role="status">
            {notice}
          </p>
        ) : null}
        <div
          className={styles.loadEarlierRow}
          style={{ flexWrap: 'wrap', gap: 8, padding: '8px 12px', boxSizing: 'border-box' }}
        >
          <button
            type="button"
            disabled={busy || !source.isCurrent()}
            onClick={() => void load(viewRef.current.forward ? 'forward' : 'initial')}
          >
            Обновить историю
          </button>
          {gap && view.older ? (
            <button type="button" disabled={busy} onClick={() => void load('older')}>
              Загрузить пропущенные сообщения
            </button>
          ) : null}
          <button
            type="button"
            disabled={
              busy ||
              Boolean(error) ||
              !source.isCurrent() ||
              (!pending && through <= view.position.readThroughSequence)
            }
            onClick={read}
          >
            {pending ? 'Проверить прочтение' : 'Отметить показанное прочитанным'}
          </button>
        </div>
      </div>
      <CommunityThread
        community={community}
        messages={[...view.archive, ...view.rows, ...overlay]}
        busy={busy ? 'load' : null}
        error={error ? { kind: 'RETRYABLE', message: error } : null}
        refreshing={busy}
        hasEarlierMessages={Boolean(view.older || view.archiveCursor)}
        onRetry={() => void load(viewRef.current.forward ? 'forward' : 'initial')}
        onLoadEarlier={() => void load(view.older ? 'older' : 'archive')}
        composer={
          chat.sendMessage && chat.getMessageRequest
            ? {
                scope: source.scope,
                communityId: community.id,
                isCurrent: current,
                eligible: view.allowed && !error,
                send: chat.sendMessage,
                status: chat.getMessageRequest,
                onConfirmed: (message) => {
                  if (!current()) return;
                  const alreadyPublished = [
                    ...viewRef.current.rows,
                    ...viewRef.current.archive,
                  ].some((item) => item.id === message.id);
                  setOverlay((items) =>
                    alreadyPublished || items.some((item) => item.id === message.id)
                      ? items
                      : [...items, message],
                  );
                  void load(viewRef.current.forward ? 'forward' : 'initial');
                },
                onAccessDenied: () => {
                  if (!current()) return;
                  setError('Доступ к чату не подтверждён.');
                  const empty = initial(viewRef.current.position);
                  viewRef.current = empty;
                  setView(empty);
                  setOverlay([]);
                },
              }
            : undefined
        }
      />
    </div>
  );
}
