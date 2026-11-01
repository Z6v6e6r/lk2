import { useEffect, useRef, useState } from 'react';
import type { CommunityMembershipPage, CommunityReadExperienceChatPage } from '@phub/api-sdk';
import { CommunityChatList, CommunityThread } from '../../../web/src/chats-ui/CommunityChats.js';
import {
  appendCommunityPage,
  communityThreadPage,
  mergeCommunityThreadPage,
} from '../../../web/src/chats-ui/community-chat-rows.js';
import type { ChatUiError } from '../../../web/src/ChatsPage.js';
import type { IOSSession } from './session.js';

/** A station/community-only entry. DIRECT/GAME/support/media are not native capabilities here. */
export function IOSStationChats({ session }: { readonly session: IOSSession }): React.JSX.Element {
  const [principal] = useState(() => session.stationMessagePrincipal());
  const active = useRef(true);
  const [directory, setDirectory] = useState<CommunityMembershipPage>({ items: [] });
  const [directoryBusy, setDirectoryBusy] = useState<'load' | 'more' | null>('load');
  const [directoryError, setDirectoryError] = useState<ChatUiError | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [page, setPage] = useState<CommunityReadExperienceChatPage>({ items: [] });
  const [busy, setBusy] = useState<'load' | 'load-earlier' | null>(null);
  const [error, setError] = useState<ChatUiError | null>(null);
  const [enabled, setEnabled] = useState(false);
  const selectedRef = useRef(selected);
  function select(id: string | null): void {
    selectedRef.current = id;
    setSelected(id);
  }
  function invalidate(): void {
    generation.current++;
  }
  const directoryFlight = useRef(false),
    threadFlight = useRef<{ id: string; token: number } | null>(null),
    generation = useRef(0);
  const current = () =>
    active.current && principal !== null && session.stationMessagePrincipal() === principal;
  const failure = (): ChatUiError => ({
    kind: 'RETRYABLE',
    message: 'Не удалось обновить чат. Попробуйте ещё раз.',
  });
  async function loadDirectory(cursor?: string): Promise<void> {
    if (!current() || directoryFlight.current) return;
    directoryFlight.current = true;
    setDirectoryBusy(cursor ? 'more' : 'load');
    try {
      const context = await session.read((api) => api.getUserContext());
      if (!current()) return;
      const allowed =
        context.runtimeCapabilities?.communityDirectory !== false &&
        context.runtimeCapabilities?.communityReadChat === true;
      setEnabled(allowed);
      if (!allowed) {
        setDirectory({ items: [] });
        select(null);
        setPage({ items: [] });
        return;
      }
      const value = await session.read((api) =>
        api.listMyCommunities({ limit: 50, ...(cursor ? { cursor } : {}) }),
      );
      if (!current()) return;
      setDirectory((previous) => ({
        ...value,
        items: cursor ? Array.from(appendCommunityPage(previous.items, value.items)) : value.items,
      }));
      if (
        !cursor &&
        selectedRef.current &&
        !value.items.some((v) => v.id === selectedRef.current)
      ) {
        select(null);
        setPage({ items: [] });
        invalidate();
      }
      setDirectoryError(null);
    } catch {
      if (current()) {
        setDirectoryError(failure());
        setDirectory({ items: [] });
        setPage({ items: [] });
        select(null);
      }
    } finally {
      directoryFlight.current = false;
      if (current()) setDirectoryBusy(null);
    }
  }
  async function loadThread(id: string, cursor?: string): Promise<void> {
    if (!current() || !enabled || threadFlight.current?.id === id || selectedRef.current !== id)
      return;
    const token = ++generation.current;
    threadFlight.current = { id, token };
    setBusy(cursor ? 'load-earlier' : 'load');
    try {
      const value = await session.stationHistory(id, cursor);
      if (!current() || token !== generation.current || selectedRef.current !== id) return;
      setPage((previous) => ({
        ...value,
        items: Array.from(
          cursor
            ? mergeCommunityThreadPage(previous.items, value).messages
            : communityThreadPage(value),
        ),
      }));
      setError(null);
    } catch (cause) {
      if (!current() || token !== generation.current || selectedRef.current !== id) return;
      const status =
        typeof cause === 'object' && cause !== null && 'status' in cause ? cause.status : null;
      if (status === 401 || status === 403 || status === 404) setPage({ items: [] });
      setError(failure());
    } finally {
      if (threadFlight.current?.token === token) threadFlight.current = null;
      if (current() && token === generation.current) setBusy(null);
    }
  }
  useEffect(() => {
    active.current = true;
    queueMicrotask(() => void loadDirectory());
    const unsubscribe = session.subscribe(() => {
      if (!current()) {
        invalidate();
        setDirectory({ items: [] });
        setPage({ items: [] });
        select(null);
        setEnabled(false);
      }
    });
    return () => {
      unsubscribe();
      active.current = false;
      invalidate();
    };
    // The authenticated cabinet remounts on identity changes; every response also checks its epoch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (!selected) return;
    queueMicrotask(() => void loadThread(selected));
    const refresh = () => {
      if (document.visibilityState === 'visible' && navigator.onLine) void loadThread(selected);
    };
    window.addEventListener('online', refresh);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      invalidate();
      window.removeEventListener('online', refresh);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
    // Only a selected thread starts these GET-only listeners.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, enabled]);
  const community = directory.items.find((v) => v.id === selected);
  const auth = session.getSnapshot();
  const scope =
    auth.status === 'signed-in'
      ? JSON.stringify([session.configuration.tenantKey, auth.session.context.userId])
      : '';
  return (
    <main className="games-page">
      <header className="ios-cabinet-heading">
        <a href="/">На главную</a>
        <h1>Чаты сообществ</h1>
      </header>
      {community ? (
        <>
          <button
            type="button"
            onClick={() => {
              invalidate();
              select(null);
              setPage({ items: [] });
              setError(null);
            }}
          >
            К сообществам
          </button>
          <CommunityThread
            community={community}
            messages={page.items}
            busy={busy}
            error={error}
            refreshing={false}
            hasEarlierMessages={Boolean(page.nextCursor)}
            onRetry={() => void loadThread(community.id)}
            onLoadEarlier={() => {
              if (page.nextCursor) void loadThread(community.id, page.nextCursor);
            }}
            composer={{
              scope,
              communityId: community.id,
              storage: 'native-local',
              isCurrent: current,
              eligible:
                principal !== null &&
                session.stationMessagePrincipal() === principal &&
                page.canRequestStationMessage === true &&
                !error,
              send: (id, input) => session.sendStationMessage(id, input),
              status: (id, idempotency) => session.stationMessageStatus(id, idempotency),
              onConfirmed: (message) => {
                if (!current()) return;
                invalidate();
                setBusy(null);
                setPage((old) => ({
                  ...old,
                  items: Array.from(
                    mergeCommunityThreadPage(old.items, { items: [message] }).messages,
                  ),
                }));
              },
              onAccessDenied: () => {
                if (!current()) return;
                invalidate();
                setBusy(null);
                setPage({ items: [] });
                setError({
                  kind: 'FORBIDDEN',
                  message: 'Чат недоступен. Исходный запрос сохранён.',
                });
              },
            }}
          />
        </>
      ) : (
        <>
          <CommunityChatList
            communities={directory.items}
            query=""
            unreadOnly={false}
            hasMore={Boolean(directory.nextCursor)}
            refreshing={false}
            selectedCommunityId={null}
            busy={directoryBusy}
            error={directoryError}
            onSelectCommunity={(id) => {
              if (!current()) return;
              setPage({ items: [] });
              setError(null);
              select(id);
            }}
            onRetry={() => void loadDirectory()}
            onLoadMore={() => {
              if (directory.nextCursor) void loadDirectory(directory.nextCursor);
            }}
          />
          {!enabled && !directoryBusy && !directoryError ? (
            <p role="status">Чаты сообществ пока недоступны.</p>
          ) : null}
        </>
      )}
    </main>
  );
}
