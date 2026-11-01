import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  parseTournamentChatPage,
  type TournamentChatReceipt,
  type TournamentChatRequest,
  type TournamentChatPage as HistoryPage,
} from '@phub/api-sdk';
import { TournamentChatCustody, type TournamentChatLocks } from './tournament-chat-custody.js';
import { refreshTournamentThread, type TournamentThread } from './tournament-chat-history.js';
import './TournamentChatPage.css';
export interface TournamentChatGateway {
  tournamentChatPrincipal: () => string | null;
  sendTournamentChatMessage: (
    id: string,
    request: TournamentChatRequest,
  ) => Promise<TournamentChatReceipt>;
  getTournamentChatRequest: (id: string, requestId: string) => Promise<TournamentChatReceipt>;
  getTournamentChatHistory: (id: string, limit?: number, cursor?: string) => Promise<HistoryPage>;
}
export function TournamentChatPage({
  tournamentId,
  principal,
  gateway,
}: {
  readonly tournamentId: string;
  readonly principal: { tenantId: string; userId: string };
  readonly gateway: TournamentChatGateway;
}): React.JSX.Element {
  const [thread, setThread] = useState<TournamentThread | null>(null),
    [draft, setDraft] = useState(''),
    [notice, setNotice] = useState(''),
    [pending, setPending] = useState(0),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(false),
    [denied, setDenied] = useState(false),
    [gap, setGap] = useState(false);
  const historyBusy = useRef(false),
    commandBusy = useRef(false),
    threadRef = useRef<TournamentThread | null>(null),
    draftRevision = useRef(0);
  const lifetime = useRef({
    active: true,
    epoch: 0,
    accessEpoch: 0,
    original: gateway.tournamentChatPrincipal(),
    gateway,
  });
  useLayoutEffect(() => {
    lifetime.current.gateway = gateway;
  }, [gateway, lifetime]);
  const refreshQueued = useRef(false);
  const current = () =>
    lifetime.current.active &&
    lifetime.current.original !== null &&
    lifetime.current.gateway.tournamentChatPrincipal() === lifetime.current.original;
  // Constructor stores the callback; it does not call it or read any React ref.
  // eslint-disable-next-line react-hooks/refs
  const [custody] = useState(() => {
    try {
      const locks: TournamentChatLocks = {
        request: async (name, options, callback) => {
          if (!navigator.locks) throw new Error('TOURNAMENT_CHAT_LOCK_UNAVAILABLE');
          return await navigator.locks.request(name, options, callback);
        },
      };
      return new TournamentChatCustody(
        tournamentId,
        principal,
        window.localStorage,
        locks,
        current,
      );
    } catch {
      return null;
    }
  });
  function pendingCount() {
    try {
      setPending(custody?.pending().length ?? 0);
    } catch {
      setNotice('Не удалось прочитать исходные запросы. Новая отправка недоступна.');
    }
  }
  function failure(error: unknown) {
    if (!current()) return;
    const status =
      typeof error === 'object' && error !== null && 'status' in error ? Number(error.status) : 0;
    if ([401, 403, 404].includes(status)) {
      lifetime.current.epoch++;
      lifetime.current.accessEpoch++;
      setDenied(true);
      setThread(null);
      threadRef.current = null;
      setDraft('');
      draftRevision.current++;
      setNotice('Доступ к чату сейчас недоступен. Исходные запросы сохранены.');
    } else if (
      error instanceof Error &&
      ['TOURNAMENT_CHAT_HISTORY_GAP', 'TOURNAMENT_CHAT_STREAM_CHANGED'].includes(error.message)
    ) {
      setGap(true);
      setNotice('Не удалось загрузить все новые сообщения. Откройте историю заново.');
    } else setNotice('Не удалось подтвердить состояние чата. Проверьте статус сообщения.');
  }
  async function refresh(reset = false) {
    if (!current()) return;
    if (historyBusy.current) {
      refreshQueued.current = true;
      return;
    }
    historyBusy.current = true;
    setLoading(true);
    const id = ++lifetime.current.epoch;
    try {
      const next = await refreshTournamentThread(
        tournamentId,
        reset ? null : threadRef.current,
        gateway.getTournamentChatHistory,
        () => current() && id === lifetime.current.epoch,
      );
      if (!current() || id !== lifetime.current.epoch) return;
      threadRef.current = next;
      setThread(next);
      setDenied(false);
      setGap(false);
    } catch (error) {
      if (id === lifetime.current.epoch) failure(error);
    } finally {
      historyBusy.current = false;
      if (current()) {
        setLoading(false);
        if (refreshQueued.current) {
          refreshQueued.current = false;
          void refresh();
        }
      }
    }
  }
  async function restore() {
    if (!current() || !custody || commandBusy.current) return;
    commandBusy.current = true;
    const accessEpoch = lifetime.current.accessEpoch;
    const commandCurrent = () => current() && accessEpoch === lifetime.current.accessEpoch;
    setBusy(true);
    try {
      for (const original of custody.pending()) {
        const receipt = await gateway.getTournamentChatRequest(tournamentId, original.requestId);
        if (!commandCurrent()) return;
        if (await custody.accept(receipt, original.requestId, commandCurrent)) {
          pendingCount();
          if (current()) {
            setNotice('Сообщение сохранено. Это не подтверждение доставки или прочтения.');
            void refresh();
          }
        } else setNotice('Не удалось подтвердить отправку. Проверьте статус сообщения.');
      }
    } catch (error) {
      if (commandCurrent()) failure(error);
    } finally {
      commandBusy.current = false;
      if (current()) {
        setBusy(false);
        pendingCount();
      }
    }
  }
  useEffect(() => {
    const mounted = lifetime.current;
    mounted.active = true;
    queueMicrotask(() => {
      if (current()) {
        pendingCount();
        void refresh();
        void restore();
      }
    });
    const reconnect = () => {
      if (document.visibilityState !== 'hidden') void refresh();
    };
    window.addEventListener('focus', reconnect);
    window.addEventListener('online', reconnect);
    document.addEventListener('visibilitychange', reconnect);
    return () => {
      mounted.active = false;
      mounted.epoch++;
      window.removeEventListener('focus', reconnect);
      window.removeEventListener('online', reconnect);
      document.removeEventListener('visibilitychange', reconnect);
    };
    // The parent keys this component by principal + tournament; captured gateway identity is fenced.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  async function send() {
    if (!current() || !custody || commandBusy.current || denied || !thread) return;
    commandBusy.current = true;
    const accessEpoch = lifetime.current.accessEpoch;
    const commandCurrent = () => current() && accessEpoch === lifetime.current.accessEpoch;
    setBusy(true);
    const text = draft,
      revision = draftRevision.current;
    try {
      const original = await custody.original(text);
      pendingCount();
      if (!commandCurrent()) return;
      const receipt = await gateway.sendTournamentChatMessage(tournamentId, {
        requestId: original.requestId,
        text,
      });
      if (!commandCurrent()) return;
      if (await custody.accept(receipt, original.requestId, commandCurrent)) {
        if (current() && draftRevision.current === revision) {
          setDraft('');
          draftRevision.current++;
        }
        setNotice('Сообщение сохранено. Это не подтверждение доставки или прочтения.');
        void refresh();
      } else setNotice('Не удалось подтвердить отправку. Проверьте статус сообщения.');
    } catch (error) {
      if (commandCurrent()) failure(error);
    } finally {
      commandBusy.current = false;
      if (current()) {
        setBusy(false);
        pendingCount();
      }
    }
  }
  async function older() {
    const old = threadRef.current;
    if (!current() || !old?.olderCursor || historyBusy.current) return;
    historyBusy.current = true;
    setLoading(true);
    const id = ++lifetime.current.epoch;
    try {
      const p = parseTournamentChatPage(
        await gateway.getTournamentChatHistory(tournamentId, 50, old.olderCursor),
        tournamentId,
        50,
        old.olderCursor,
      );
      if (!current() || id !== lifetime.current.epoch) return;
      if (p.streamId !== old.streamId || p.throughSequence !== old.olderThrough)
        throw new Error('TOURNAMENT_CHAT_STREAM_CHANGED');
      const seen = new Set(old.messages.map((m) => m.messageId));
      if (p.messages.some((m) => seen.has(m.messageId)))
        throw new Error('TOURNAMENT_CHAT_STREAM_CHANGED');
      const next = {
        ...old,
        olderCursor: p.nextCursor,
        messages: [...old.messages, ...p.messages],
      };
      threadRef.current = next;
      setThread(next);
    } catch (error) {
      if (id === lifetime.current.epoch) failure(error);
    } finally {
      historyBusy.current = false;
      if (current()) {
        setLoading(false);
        if (refreshQueued.current) {
          refreshQueued.current = false;
          void refresh();
        }
      }
    }
  }
  return (
    <main className="tournament-chat" aria-labelledby="tournament-chat-heading">
      <header>
        <a href={`/tournaments?event=${encodeURIComponent(tournamentId)}`}>← К турниру</a>
        <h1 id="tournament-chat-heading">Чат турнира</h1>
        <p>Для текущих участников и назначенного организатора</p>
      </header>
      <div className="tournament-chat__actions">
        <button type="button" disabled={loading} onClick={() => void refresh()}>
          Обновить
        </button>
        {gap && (
          <button type="button" disabled={loading} onClick={() => void refresh(true)}>
            Открыть историю заново
          </button>
        )}
      </div>
      {loading && <p role="status">Загружаем сообщения…</p>}
      {notice && <p role="status">{notice}</p>}
      {!denied && thread && (
        <>
          <ol aria-label="Сообщения турнира">
            {[...thread.messages].reverse().map((m) => (
              <li key={m.messageId}>
                <strong>{m.authorUserId === principal.userId ? 'Вы' : 'Участник'}</strong>
                <p>{m.text}</p>
                <time dateTime={m.acceptedAt}>
                  {new Date(m.acceptedAt).toLocaleTimeString('ru-RU', {
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </time>
              </li>
            ))}
          </ol>
          {!thread.messages.length && <p>Сообщений пока нет</p>}
          {thread.olderCursor && (
            <button disabled={loading} onClick={() => void older()}>
              Более ранние сообщения
            </button>
          )}
        </>
      )}
      {!denied && thread && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <label htmlFor="tournament-message">Сообщение</label>
          <textarea
            id="tournament-message"
            value={draft}
            maxLength={8000}
            onChange={(e) => {
              draftRevision.current++;
              setDraft(e.target.value);
            }}
          />
          <button type="submit" disabled={busy || !custody || !draft.trim()}>
            Отправить
          </button>
          <p>Текст черновика не сохраняется после перезагрузки.</p>
        </form>
      )}
      <section aria-label="Проверка отправки">
        <p>Ожидают подтверждения: {pending}</p>
        <button
          type="button"
          disabled={busy || !custody || pending === 0}
          onClick={() => void restore()}
        >
          Проверить статус
        </button>
      </section>
    </main>
  );
}
