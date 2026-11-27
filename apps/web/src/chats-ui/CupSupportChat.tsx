import { type FormEvent, useEffect, useLayoutEffect, useRef, useState } from 'react';
import styles from './ChatsUi.module.css';

export type CupReplyCursor = { at: string; id: string };
type CupReply = {
  id: string;
  ticketId: string;
  number: string;
  status: 'OPEN' | 'IN_PROGRESS' | 'WAITING_USER' | 'WAITING_DEVELOPMENT' | 'RESOLVED' | 'CLOSED';
  kind: 'CUSTOMER' | 'STAFF_REPLY';
  body: string;
  createdAt: string;
};
export type CupReplyPage = { messages: CupReply[]; next: CupReplyCursor | null };
export type CupReplySource = {
  load: (before?: CupReplyCursor, signal?: AbortSignal) => Promise<CupReplyPage>;
  send: (ticketId: string, body: string, idempotencyKey: string) => Promise<{ id: string }>;
  createMessageId: () => string;
};

function mergeMessages(first: CupReply[], second: CupReply[]) {
  const seen = new Set(first.map((message) => message.id));
  return [...first, ...second.filter((message) => !seen.has(message.id))];
}

export function CupSupportChat({ source, close }: { source: CupReplySource; close: () => void }) {
  const { load, send, createMessageId } = source;
  const [history, setHistory] = useState<CupReplyPage>();
  const [before, setBefore] = useState<CupReplyCursor>();
  const [retry, setRetry] = useState(0);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [ticketId, setTicketId] = useState('');
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [sending, setSending] = useState(false);
  const [sendStatus, setSendStatus] = useState<'failed' | 'sent'>();
  const messageList = useRef<HTMLDivElement>(null);
  const followLatest = useRef(true);
  const olderPageAnchor = useRef<{ top: number; height: number }>(undefined);
  const sendInFlight = useRef(false);
  const commands = useRef(new Map<string, { body: string; key: string }>());

  useEffect(() => {
    const controller = new AbortController();
    void load(before, controller.signal)
      .then((page) => {
        if (controller.signal.aborted) return;
        setHistory((old) =>
          before && old
            ? { messages: mergeMessages(old.messages, page.messages), next: page.next }
            : page,
        );
        setFailed(false);
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [load, before, retry]);

  useEffect(() => {
    if (loading || failed) return;
    const controller = new AbortController();
    let refreshing = false;
    const refreshTimer = window.setInterval(() => {
      if (refreshing || document.visibilityState === 'hidden') return;
      refreshing = true;
      void load(undefined, controller.signal)
        .then((page) => {
          if (controller.signal.aborted) return;
          setHistory((old) =>
            old && old.messages.length > 40
              ? { messages: mergeMessages(page.messages, old.messages), next: old.next }
              : page,
          );
        })
        .catch(() => {
          // Keep the displayed history. The next poll or explicit refresh can retry.
        })
        .finally(() => {
          refreshing = false;
        });
    }, 12_000);
    return () => {
      controller.abort();
      window.clearInterval(refreshTimer);
    };
  }, [load, loading, failed]);

  useLayoutEffect(() => {
    const list = messageList.current;
    if (!list || !history) return;
    if (olderPageAnchor.current) {
      const { top, height } = olderPageAnchor.current;
      list.scrollTop = top + list.scrollHeight - height;
      olderPageAnchor.current = undefined;
    } else if (followLatest.current) {
      list.scrollTop = list.scrollHeight;
    }
  }, [history]);

  const tickets = new Map<string, CupReply>();
  for (const message of history?.messages ?? []) {
    if (!tickets.has(message.ticketId)) tickets.set(message.ticketId, message);
  }
  const openTickets = [...tickets.values()].filter((message) => message.status !== 'CLOSED');
  const selected =
    openTickets.find((ticket) => ticket.ticketId === ticketId) ??
    (ticketId === '' && openTickets.length === 1 ? openTickets[0] : undefined);
  const text = selected ? (drafts[selected.ticketId] ?? '') : '';

  function refresh() {
    setLoading(true);
    setBefore(undefined);
    setRetry((value) => value + 1);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const body = text.trim();
    if (!selected || !body || sendInFlight.current) return;
    const id = selected.ticketId;
    const previous = commands.current.get(id);
    const command = previous?.body === body ? previous : { body, key: createMessageId() };
    commands.current.set(id, command);
    sendInFlight.current = true;
    setSending(true);
    setSendStatus(undefined);
    try {
      await send(id, command.body, command.key);
      commands.current.delete(id);
      setDrafts((old) => ({ ...old, [id]: '' }));
      setSendStatus('sent');
      followLatest.current = true;
      refresh();
    } catch {
      setSendStatus('failed');
    } finally {
      sendInFlight.current = false;
      setSending(false);
    }
  }

  return (
    <section className={styles.thread} aria-label="Поддержка CUP" aria-busy={loading}>
      <header className={styles.threadHeader}>
        <button
          type="button"
          className={styles.cupReplyButton}
          onClick={close}
          aria-label="К списку чатов"
        >
          ←
        </button>
        <h2>Поддержка CUP</h2>
      </header>
      <div
        className={styles.cupReplies}
        ref={messageList}
        onScroll={(event) => {
          const list = event.currentTarget;
          followLatest.current = list.scrollHeight - list.scrollTop - list.clientHeight <= 40;
        }}
      >
        {failed && <p role="alert">Не удалось загрузить переписку CUP.</p>}
        {loading && <p role="status">Загружаем переписку…</p>}
        {history?.messages.length === 0 && !failed && (
          <p>Здесь появится переписка по обращениям, подтверждённым через ЛК2.</p>
        )}
        {history?.next && !failed && (
          <button
            type="button"
            className={styles.cupReplyButton}
            disabled={loading}
            onClick={() => {
              const list = messageList.current;
              if (list)
                olderPageAnchor.current = { top: list.scrollTop, height: list.scrollHeight };
              setLoading(true);
              setBefore(history.next ?? undefined);
            }}
          >
            Загрузить более ранние
          </button>
        )}
        {history?.messages.length ? (
          <ol className={styles.cupReplyList}>
            {[...history.messages].reverse().map((message) => (
              <li key={message.id}>
                <strong>{message.number}</strong>
                <span> · {message.kind === 'CUSTOMER' ? 'Вы' : 'Поддержка'}</span>
                <time dateTime={message.createdAt}>
                  {new Date(message.createdAt).toLocaleString('ru-RU')}
                </time>
                <p>{message.body}</p>
              </li>
            ))}
          </ol>
        ) : null}
        <button
          type="button"
          className={styles.cupReplyButton}
          disabled={loading}
          onClick={() => {
            if (failed) {
              setLoading(true);
              setRetry((value) => value + 1);
            } else refresh();
          }}
        >
          {failed ? 'Повторить' : 'Обновить'}
        </button>{' '}
        <a href="https://stg-support.tsup.space/">Создать обращение</a>
      </div>
      {openTickets.length > 0 && (
        <form
          className={styles.cupComposer}
          onSubmit={(event) => {
            void submit(event);
          }}
        >
          <label>
            Обращение
            <select
              value={selected?.ticketId ?? ''}
              disabled={sending}
              onChange={(event) => {
                setTicketId(event.target.value);
                setSendStatus(undefined);
              }}
            >
              <option value="">Выберите обращение</option>
              {openTickets.map((ticket) => (
                <option key={ticket.ticketId} value={ticket.ticketId}>
                  {ticket.number}
                </option>
              ))}
            </select>
          </label>
          <label>
            Сообщение
            <textarea
              rows={3}
              maxLength={4000}
              value={text}
              disabled={!selected || sending}
              onChange={(event) => {
                if (!selected) return;
                setTicketId(selected.ticketId);
                setDrafts((old) => ({ ...old, [selected.ticketId]: event.target.value }));
                setSendStatus(undefined);
              }}
            />
          </label>
          {sendStatus === 'failed' && (
            <p role="alert">Не удалось отправить. Проверьте статус обращения и повторите.</p>
          )}
          <button
            type="submit"
            className={styles.cupReplyButton}
            disabled={!text.trim() || sending}
          >
            {sending ? 'Отправляем…' : 'Отправить'}
          </button>
        </form>
      )}
      {sendStatus === 'sent' && (
        <p className={styles.cupSendStatus} role="status">
          Сообщение отправлено.
        </p>
      )}
    </section>
  );
}
