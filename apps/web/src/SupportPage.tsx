import { ApiClientError } from '@phub/api-sdk';
import type { SupportTicket, SupportTicketPage, SupportTicketSummary } from '@phub/api-sdk';
import { useEffect, useRef, useState } from 'react';

import type { AuthGateway } from './auth-gateway.js';
import { createMessagingCommandId } from './auth-gateway.js';
import './SupportPage.css';

const supportStatusLabels = {
  OPEN: 'Новое',
  IN_PROGRESS: 'В работе',
  WAITING_USER: 'Нужен ваш ответ',
  RESOLVED: 'Решено',
  CLOSED: 'Закрыто',
} as const;
const categoryLabels = {
  TECHNICAL: 'Техническая проблема',
  ACCOUNT: 'Аккаунт',
  BOOKING: 'Бронирование',
  BILLING: 'Оплата',
  OTHER: 'Другое',
} as const;

function errorText(error: unknown): string {
  return error instanceof ApiClientError
    ? error.message
    : 'Не удалось связаться с поддержкой. Повторите попытку.';
}
function dateLabel(value: string): string {
  return new Date(value).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' });
}

// Canonical reads retain pages the user already loaded, including after a compact command receipt.
function refreshTicket(previous: SupportTicket | null, next: SupportTicket): SupportTicket {
  if (!previous || previous.id !== next.id) return next;
  if (previous.version > next.version) return previous;
  if (next.conversationPurgedAt && next.conversationPurgedAt !== previous.conversationPurgedAt)
    return next;
  const nextIds = new Set(next.messages.map((message) => message.id));
  const hasEarlierMessages = previous.messages.some((message) => !nextIds.has(message.id));
  const messages = new Map(
    [...previous.messages, ...next.messages].map((message) => [message.id, message]),
  );
  const history = new Map([...previous.history, ...next.history].map((event) => [event.id, event]));
  const { nextMessageCursor: nextCursor, ...summary } = next;
  const cursor = hasEarlierMessages ? previous.nextMessageCursor : nextCursor;
  return {
    ...summary,
    messages: [...messages.values()].sort(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
    ),
    history: [...history.values()],
    ...(cursor ? { nextMessageCursor: cursor } : {}),
  };
}

function refreshQueue(
  page: SupportTicketPage | null,
  ticket: SupportTicket,
): SupportTicketPage | null {
  if (!page) return page;
  const summary: SupportTicketSummary = {
    id: ticket.id,
    subject: ticket.subject,
    category: ticket.category,
    status: ticket.status,
    priority: ticket.priority,
    assignedTo: ticket.assignedTo,
    tags: ticket.tags,
    createdAt: ticket.createdAt,
    updatedAt: ticket.updatedAt,
    resolvedAt: ticket.resolvedAt,
    autoCloseAt: ticket.autoCloseAt,
    version: ticket.version,
    ...(ticket.closedAt !== undefined ? { closedAt: ticket.closedAt } : {}),
    ...(ticket.conversationPurgedAt !== undefined
      ? { conversationPurgedAt: ticket.conversationPurgedAt }
      : {}),
  };
  return {
    ...page,
    items: page.items.map((item) =>
      item.id === ticket.id && item.version <= ticket.version ? summary : item,
    ),
  };
}

type PendingCommand =
  | {
      kind: 'create';
      key: string;
      input: { subject: string; category: SupportTicketSummary['category']; body: string };
    }
  | {
      kind: 'message';
      key: string;
      ticketId: string;
      input: { body: string; expectedVersion: number };
    };

export function SupportPage({
  gateway,
  initialTicketId,
  readOnly = false,
}: {
  readonly gateway: AuthGateway;
  readonly initialTicketId?: string;
  readonly readOnly?: boolean;
}): React.JSX.Element {
  const [list, setList] = useState<SupportTicketPage | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(initialTicketId ?? null);
  const [ticket, setTicket] = useState<SupportTicket | null>(null);
  const [creating, setCreating] = useState(false);
  const [subject, setSubject] = useState('');
  const [category, setCategory] = useState<SupportTicketSummary['category']>('TECHNICAL');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [listBusy, setListBusy] = useState(false);
  const [loadingTicket, setLoadingTicket] = useState(Boolean(initialTicketId));
  const [error, setError] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingCommand | null>(null);
  const [reload, setReload] = useState(0);
  const active = useRef(false);
  const listRequest = useRef(false);
  const commandInFlight = useRef(false);
  const currentSelection = useRef(selectedId);
  useEffect(() => {
    currentSelection.current = selectedId;
  }, [selectedId]);
  const available = !!(
    gateway.listSupportTickets &&
    gateway.getSupportTicket &&
    gateway.createSupportTicket &&
    gateway.sendSupportTicketMessage
  );

  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);

  useEffect(() => {
    if (!gateway.listSupportTickets) return;
    let current = true;
    void gateway.listSupportTickets().then(
      (page) => {
        if (current) {
          setList(page);
          setListError(null);
        }
      },
      (reason: unknown) => {
        if (current) setListError(errorText(reason));
      },
    );
    return () => {
      current = false;
    };
  }, [gateway, reload]);

  useEffect(() => {
    if (!selectedId || !gateway.getSupportTicket) return;
    let current = true;
    void gateway.getSupportTicket(selectedId).then(
      (next) => {
        if (current) {
          setTicket((previous) => refreshTicket(previous, next));
          setList((page) => refreshQueue(page, next));
          setError(null);
          setLoadingTicket(false);
        }
      },
      (reason: unknown) => {
        if (current) {
          setError(errorText(reason));
          setLoadingTicket(false);
        }
      },
    );
    return () => {
      current = false;
    };
  }, [gateway, selectedId, reload]);

  // Only canonical reads refresh the dialog; unsent/uncertain commands keep their immutable body.
  useEffect(() => {
    if (!selectedId || !gateway.getSupportTicket || pending || busy) return;
    let current = true;
    let reading = false;
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'hidden' || reading) return;
      reading = true;
      void gateway.getSupportTicket!(selectedId)
        .then(
          (next) => {
            if (current) {
              setTicket((previous) => refreshTicket(previous, next));
              setList((page) => refreshQueue(page, next));
            }
          },
          () => undefined,
        )
        .finally(() => {
          reading = false;
        });
    }, 15_000);
    return () => {
      current = false;
      window.clearInterval(interval);
    };
  }, [gateway, selectedId, pending, busy]);

  async function execute(command: PendingCommand): Promise<void> {
    if (readOnly || commandInFlight.current) return;
    commandInFlight.current = true;
    setPending(command);
    setBusy(true);
    setError(null);
    try {
      const next =
        command.kind === 'create'
          ? await gateway.createSupportTicket!(command.input, command.key)
          : await gateway.sendSupportTicketMessage!(command.ticketId, command.input, command.key);
      if (!active.current) return;
      setSelectedId(next.id);
      setTicket((previous) => refreshTicket(previous, next));
      setCreating(false);
      setBody('');
      setSubject('');
      setPending(null);
      // The command is complete. A failed refresh may retry GET, never the successful POST.
      setReload((value) => value + 1);
      setList((previous) => ({
        ...previous,
        items: [next, ...(previous?.items ?? []).filter((item) => item.id !== next.id)],
      }));
      window.history.replaceState({}, '', `/support/${encodeURIComponent(next.id)}`);
    } catch (reason) {
      if (!active.current) return;
      const definitive =
        reason instanceof ApiClientError &&
        reason.status >= 400 &&
        reason.status < 500 &&
        reason.status !== 408 &&
        (reason.status !== 429 ||
          reason.code === 'SUPPORT_RATE_LIMITED' ||
          reason.code === 'SUPPORT_TICKET_LIMIT');
      if (definitive) {
        setPending(null);
        if (reason.status === 409 || reason.status === 410) setReload((value) => value + 1);
      }
      setError(errorText(reason));
    } finally {
      commandInFlight.current = false;
      if (active.current) setBusy(false);
    }
  }

  function loadMore(): void {
    if (!list?.nextCursor || !gateway.listSupportTickets || listRequest.current) return;
    listRequest.current = true;
    setListBusy(true);
    setListError(null);
    void gateway
      .listSupportTickets({ cursor: list.nextCursor })
      .then(
        (next) => {
          if (!active.current) return;
          setList((previous) => {
            const items = new Map((previous?.items ?? []).map((item) => [item.id, item]));
            next.items.forEach((item) => items.set(item.id, item));
            return {
              items: [...items.values()],
              ...(next.nextCursor ? { nextCursor: next.nextCursor } : {}),
            };
          });
        },
        (reason: unknown) => {
          if (active.current) setListError(errorText(reason));
        },
      )
      .finally(() => {
        listRequest.current = false;
        if (active.current) setListBusy(false);
      });
  }

  async function loadEarlier(): Promise<void> {
    if (!ticket?.nextMessageCursor || !gateway.getSupportTicket || listRequest.current) return;
    listRequest.current = true;
    setListBusy(true);
    const id = ticket.id;
    try {
      const previousPage = await gateway.getSupportTicket(id, ticket.nextMessageCursor);
      if (!active.current || currentSelection.current !== id) return;
      setTicket((current) => {
        if (!current || current.id !== id) return current;
        const messages = new Map(
          [...previousPage.messages, ...current.messages].map((item) => [item.id, item]),
        );
        const { nextMessageCursor: oldCursor, ...rest } = current;
        // Drop the previous page cursor after advancing it.
        if (oldCursor === previousPage.nextMessageCursor)
          return { ...current, messages: [...messages.values()] };
        return {
          ...rest,
          messages: [...messages.values()],
          ...(previousPage.nextMessageCursor
            ? { nextMessageCursor: previousPage.nextMessageCursor }
            : {}),
        };
      });
    } catch (reason) {
      if (active.current) setError(errorText(reason));
    } finally {
      listRequest.current = false;
      if (active.current) setListBusy(false);
    }
  }

  return (
    <main className="support-page">
      <header className="support-header">
        <a href="/profile" aria-label="Вернуться в профиль">
          ‹
        </a>
        <div>
          <h1>Техническая поддержка</h1>
          <p>Все ваши обращения и ответы в одном месте</p>
        </div>
      </header>
      {!available ? (
        <p role="alert">Поддержка временно недоступна.</p>
      ) : (
        <div className="support-layout">
          <aside className="support-queue" aria-label="Мои обращения">
            <button
              type="button"
              disabled={readOnly || busy || pending !== null}
              onClick={() => {
                setCreating(true);
                setSelectedId(null);
                setTicket(null);
                setBody('');
                setError(null);
              }}
            >
              Новое обращение
            </button>
            {listError ? (
              <>
                <p role="alert">{listError}</p>
                <button type="button" onClick={() => setReload((value) => value + 1)}>
                  Обновить обращения
                </button>
              </>
            ) : null}
            {!list && !listError ? <p role="status">Загружаем обращения…</p> : null}
            {list?.items.length === 0 ? (
              <p>Обращений пока нет. Напишите нам, если нужна помощь.</p>
            ) : null}
            {list?.items.map((item) => (
              <button
                type="button"
                key={item.id}
                disabled={busy || pending !== null}
                aria-current={selectedId === item.id ? 'true' : undefined}
                onClick={() => {
                  setCreating(false);
                  setLoadingTicket(true);
                  setTicket(null);
                  setError(null);
                  if (selectedId === item.id) setReload((value) => value + 1);
                  else setSelectedId(item.id);
                  setBody('');
                  window.history.replaceState({}, '', `/support/${encodeURIComponent(item.id)}`);
                }}
              >
                <strong>{item.subject}</strong>
                <span>{supportStatusLabels[item.status]}</span>
                <small>{dateLabel(item.updatedAt)}</small>
              </button>
            ))}
            {list?.nextCursor ? (
              <button type="button" disabled={listBusy} onClick={loadMore}>
                {listBusy ? 'Загружаем…' : 'Ещё обращения'}
              </button>
            ) : null}
          </aside>
          <section
            className="support-dialog"
            aria-label={creating ? 'Новое обращение' : 'Диалог поддержки'}
          >
            {creating ? (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  if (!pending)
                    void execute({
                      kind: 'create',
                      key: createMessagingCommandId(),
                      input: { subject: subject.trim(), category, body: body.trim() },
                    });
                }}
              >
                <h2>Новое обращение</h2>
                <label>
                  Тема
                  <input
                    required
                    minLength={3}
                    maxLength={160}
                    value={subject}
                    disabled={readOnly || busy || pending !== null}
                    onChange={(event) => setSubject(event.currentTarget.value)}
                  />
                </label>
                <label>
                  Категория
                  <select
                    value={category}
                    disabled={readOnly || busy || pending !== null}
                    onChange={(event) =>
                      setCategory(event.currentTarget.value as SupportTicketSummary['category'])
                    }
                  >
                    {Object.entries(categoryLabels).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Сообщение
                  <textarea
                    required
                    maxLength={4000}
                    value={body}
                    disabled={readOnly || busy || pending !== null}
                    onChange={(event) => setBody(event.currentTarget.value)}
                  />
                </label>
                <button
                  type="submit"
                  disabled={
                    readOnly ||
                    busy ||
                    pending !== null ||
                    subject.trim().length < 3 ||
                    !body.trim()
                  }
                >
                  {busy ? 'Отправляем…' : 'Отправить обращение'}
                </button>
              </form>
            ) : loadingTicket ? (
              <p role="status">Загружаем диалог…</p>
            ) : ticket ? (
              <>
                <header>
                  <h2>{ticket.subject}</h2>
                  <span className="support-status">{supportStatusLabels[ticket.status]}</span>
                  <small>{categoryLabels[ticket.category]}</small>
                </header>
                {ticket.status === 'RESOLVED' && ticket.autoCloseAt ? (
                  <p className="support-closure">
                    Обращение закроется {dateLabel(ticket.autoCloseAt)}, если не будет нового
                    ответа. Новый ответ переоткроет его.
                  </p>
                ) : ticket.status === 'CLOSED' ? (
                  <p className="support-closure">
                    Обращение закрыто. Напишите сообщение, чтобы переоткрыть его.
                  </p>
                ) : null}
                {ticket.conversationPurgedAt ? (
                  <p className="support-closure">
                    Переписка удалена после 24 месяцев хранения. Новый ответ начнёт переписку в этом
                    обращении.
                  </p>
                ) : null}
                {ticket.nextMessageCursor ? (
                  <button type="button" disabled={listBusy} onClick={() => void loadEarlier()}>
                    Ранние сообщения
                  </button>
                ) : null}
                <ol className="support-messages" aria-label="Сообщения поддержки">
                  {ticket.messages
                    .filter((message) => !message.internal)
                    .map((message) => (
                      <li
                        className={message.authorRole === 'USER' ? 'is-user' : 'is-agent'}
                        key={message.id}
                      >
                        <strong>
                          {message.authorRole === 'USER'
                            ? 'Вы'
                            : message.authorRole === 'AGENT'
                              ? 'Поддержка'
                              : 'Система'}
                        </strong>
                        <p>{message.body}</p>
                        <time dateTime={message.createdAt}>{dateLabel(message.createdAt)}</time>
                      </li>
                    ))}
                </ol>
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (!pending)
                      void execute({
                        kind: 'message',
                        key: createMessagingCommandId(),
                        ticketId: ticket.id,
                        input: { body: body.trim(), expectedVersion: ticket.version },
                      });
                  }}
                >
                  <label>
                    Ваш ответ
                    <textarea
                      required
                      maxLength={4000}
                      value={body}
                      disabled={readOnly || busy || pending !== null}
                      onChange={(event) => setBody(event.currentTarget.value)}
                    />
                  </label>
                  <button
                    type="submit"
                    disabled={readOnly || busy || pending !== null || !body.trim()}
                  >
                    {busy ? 'Отправляем…' : 'Отправить'}
                  </button>
                </form>
                <details>
                  <summary>История обращения</summary>
                  <ol>
                    {ticket.history.map((event) => (
                      <li key={event.id}>
                        {event.description ?? 'Обращение обновлено'} · {dateLabel(event.createdAt)}
                      </li>
                    ))}
                  </ol>
                </details>
              </>
            ) : !error ? (
              <p>Выберите обращение или создайте новое.</p>
            ) : null}
            {error ? <p role="alert">{error}</p> : null}
            {pending && !busy ? (
              <div className="support-retry">
                <p>
                  Результат отправки пока неизвестен. Повторная попытка проверит то же обращение и
                  не создаст копию.
                </p>
                <button type="button" onClick={() => void execute(pending)}>
                  Повторить отправку
                </button>
              </div>
            ) : null}
            {error && !pending && selectedId ? (
              <button type="button" onClick={() => setReload((value) => value + 1)}>
                Обновить диалог
              </button>
            ) : null}
          </section>
        </div>
      )}
    </main>
  );
}
