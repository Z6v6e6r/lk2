import { ApiClientError } from '@phub/api-sdk';
import type { SupportTicketSummary } from '@phub/api-sdk';
import { useCallback, useEffect, useRef, useState } from 'react';

import type {
  AdminSupportTicketFilters,
  NotificationAdminClient,
  SupportTicket,
  SupportTicketCategory,
  SupportTicketPriority,
  SupportTicketStatus,
} from './notification-admin-client.js';

const categories: readonly SupportTicketCategory[] = [
  'TECHNICAL',
  'ACCOUNT',
  'BOOKING',
  'BILLING',
  'OTHER',
];
const priorities: readonly SupportTicketPriority[] = ['LOW', 'NORMAL', 'HIGH', 'URGENT'];
const statuses: readonly SupportTicketStatus[] = [
  'OPEN',
  'IN_PROGRESS',
  'WAITING_USER',
  'RESOLVED',
  'CLOSED',
];

const categoryLabel: Readonly<Record<SupportTicketCategory, string>> = {
  TECHNICAL: 'Технический',
  ACCOUNT: 'Аккаунт',
  BOOKING: 'Бронирование',
  BILLING: 'Оплата',
  OTHER: 'Другое',
};
const priorityLabel: Readonly<Record<SupportTicketPriority, string>> = {
  LOW: 'Низкий',
  NORMAL: 'Обычный',
  HIGH: 'Высокий',
  URGENT: 'Срочный',
};
const statusLabel: Readonly<Record<SupportTicketStatus, string>> = {
  OPEN: 'Открыт',
  IN_PROGRESS: 'В работе',
  WAITING_USER: 'Ждём пользователя',
  RESOLVED: 'Решён',
  CLOSED: 'Закрыт',
};

function errorText(error: unknown): string {
  if (error instanceof ApiClientError) return error.message;
  if (error instanceof Error) return error.message;
  return 'Не удалось выполнить операцию.';
}

function isDefinitiveCommandError(error: unknown): boolean {
  if (!(error instanceof ApiClientError)) return false;
  if (error.status === 408 || error.status >= 500) return false;
  if (error.status === 429)
    return error.code === 'SUPPORT_RATE_LIMITED' || error.code === 'SUPPORT_TICKET_LIMIT';
  return error.status >= 400 && error.status < 500;
}

function commandKey(prefix: string): string {
  if (typeof globalThis.crypto?.randomUUID === 'function')
    return `${prefix}-${globalThis.crypto.randomUUID()}`;
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function formatDate(value: string | null): string {
  if (!value) return '—';
  return new Intl.DateTimeFormat('ru-RU', { dateStyle: 'short', timeStyle: 'short' }).format(
    new Date(value),
  );
}

function historyLabel(kind: string, description?: string): string {
  if (description) return description;
  return (
    {
      'support.ticket.created.v1': 'Обращение создано',
      'support.ticket.message.v1': 'Добавлен ответ поддержки',
      'support.ticket.internal_note.v1': 'Добавлена внутренняя заметка',
      'support.ticket.updated.v1': 'Параметры обращения изменены',
      'support.ticket.resolved.v1': 'Обращение отмечено решённым',
      'support.ticket.closed.v1': 'Обращение автоматически закрыто',
    }[kind] ?? 'Изменение обращения'
  );
}

// eslint-disable-next-line react-refresh/only-export-components -- pure reconciliation helper has unit coverage.
export function mergeTicketDetail(
  current: SupportTicket | undefined,
  ticket: SupportTicket,
): SupportTicket {
  if (!current || current.id !== ticket.id) return ticket;
  if (current.version > ticket.version) return current;
  const isNewConversationPurge = Boolean(
    conversationPurgedAt(ticket) && conversationPurgedAt(ticket) !== conversationPurgedAt(current),
  );
  const byId = new Map(
    isNewConversationPurge ? [] : current.messages.map((message) => [message.id, message]),
  );
  for (const message of ticket.messages) byId.set(message.id, message);
  const historyById = new Map(current.history.map((event) => [event.id, event]));
  for (const event of ticket.history) historyById.set(event.id, event);
  const containsEarlierPage =
    !isNewConversationPurge &&
    current.messages.some(
      (message) => !ticket.messages.some((canonical) => canonical.id === message.id),
    );
  const { nextMessageCursor: currentCursor, ...currentWithoutCursor } = current;
  const { nextMessageCursor: canonicalCursor, ...ticketWithoutCursor } = ticket;
  const nextMessageCursor = containsEarlierPage ? currentCursor : canonicalCursor;
  return {
    ...currentWithoutCursor,
    ...ticketWithoutCursor,
    messages: [...byId.values()].sort((left, right) =>
      left.createdAt.localeCompare(right.createdAt),
    ),
    history: [...historyById.values()].sort((left, right) =>
      left.createdAt.localeCompare(right.createdAt),
    ),
    ...(nextMessageCursor === undefined ? {} : { nextMessageCursor }),
  };
}

function mergeSummary(
  ticket: SupportTicket,
  current: readonly SupportTicketSummary[],
): readonly SupportTicketSummary[] {
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
  };
  return current.map((item) =>
    item.id === ticket.id && ticket.version >= item.version ? summary : item,
  );
}

function mergeQueueItems(
  current: readonly SupportTicketSummary[],
  incoming: readonly SupportTicketSummary[],
  prepend: boolean,
): readonly SupportTicketSummary[] {
  const currentById = new Map(current.map((ticket) => [ticket.id, ticket]));
  const freshest = (ticket: SupportTicketSummary): SupportTicketSummary => {
    const cached = currentById.get(ticket.id);
    return cached && cached.version > ticket.version ? cached : ticket;
  };
  if (prepend) {
    const incomingIds = new Set(incoming.map((ticket) => ticket.id));
    return [...incoming.map(freshest), ...current.filter((ticket) => !incomingIds.has(ticket.id))];
  }
  const incomingById = new Map(incoming.map((ticket) => [ticket.id, ticket]));
  const mergedCurrent = current.map((ticket) => {
    const refreshed = incomingById.get(ticket.id);
    return refreshed ? freshest(refreshed) : ticket;
  });
  const currentIds = new Set(current.map((ticket) => ticket.id));
  return [...mergedCurrent, ...incoming.filter((ticket) => !currentIds.has(ticket.id))];
}

interface FilterDraft {
  readonly query: string;
  readonly status: SupportTicketStatus | '';
  readonly category: SupportTicketCategory | '';
  readonly priority: SupportTicketPriority | '';
}

function conversationPurgedAt(ticket: SupportTicket): string | null | undefined {
  return ticket.conversationPurgedAt;
}

type PendingRetry =
  | {
      readonly kind: 'update';
      readonly ticketId: string;
      readonly keyName: string;
      readonly key: string;
      readonly input: Parameters<NotificationAdminClient['updateAdminSupportTicket']>[1];
    }
  | {
      readonly kind: 'message';
      readonly ticketId: string;
      readonly keyName: string;
      readonly key: string;
      readonly input: Parameters<NotificationAdminClient['sendAdminSupportTicketMessage']>[1];
    };

export function SupportTicketsPanel(props: {
  readonly client: NotificationAdminClient;
  readonly canManage: boolean;
}): React.JSX.Element {
  const [filters, setFilters] = useState<FilterDraft>({
    query: '',
    status: '',
    category: '',
    priority: '',
  });
  const [items, setItems] = useState<readonly SupportTicketSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string>();
  const [selected, setSelected] = useState<SupportTicket>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [draft, setDraft] = useState('');
  const [internal, setInternal] = useState(false);
  const [showInternal, setShowInternal] = useState(props.canManage);
  const [tagsText, setTagsText] = useState('');
  const [assignedToText, setAssignedToText] = useState('');
  const [pendingRetry, setPendingRetry] = useState<PendingRetry>();
  const selectedTicketId = useRef<string | undefined>(undefined);
  const selectionSequence = useRef(0);
  const queueSequence = useRef(0);
  const updates = useRef(
    new Map<
      string,
      {
        readonly key: string;
        readonly input: Parameters<NotificationAdminClient['updateAdminSupportTicket']>[1];
      }
    >(),
  );
  const messages = useRef(
    new Map<
      string,
      {
        readonly key: string;
        readonly input: Parameters<NotificationAdminClient['sendAdminSupportTicketMessage']>[1];
      }
    >(),
  );

  const load = useCallback(
    async (cursor?: string, append = false, retainLoadedPages = false): Promise<void> => {
      const sequence = ++queueSequence.current;
      setLoading(true);
      setError(undefined);
      try {
        const request: AdminSupportTicketFilters = {
          ...(filters.query ? { query: filters.query } : {}),
          ...(filters.status ? { status: filters.status } : {}),
          ...(filters.category ? { category: filters.category } : {}),
          ...(filters.priority ? { priority: filters.priority } : {}),
          ...(cursor ? { cursor } : {}),
        };
        const page = await props.client.listAdminSupportTickets(request);
        if (sequence !== queueSequence.current) return;
        setItems((current) => {
          if (append) return mergeQueueItems(current, page.items, false);
          if (!retainLoadedPages) return page.items;
          return mergeQueueItems(current, page.items, true);
        });
        setNextCursor((current) => (retainLoadedPages ? current : page.nextCursor));
      } catch (loadError) {
        if (sequence === queueSequence.current) setError(errorText(loadError));
      } finally {
        if (sequence === queueSequence.current) setLoading(false);
      }
    },
    [filters, props.client],
  );

  useEffect(() => {
    const timer = globalThis.setTimeout(() => void load(), 0);
    return () => globalThis.clearTimeout(timer);
  }, [load]);

  async function selectTicket(ticketId: string): Promise<void> {
    if (busy || pendingRetry) return;
    const sequence = ++selectionSequence.current;
    setBusy(`load-${ticketId}`);
    setError(undefined);
    try {
      const ticket = await props.client.getAdminSupportTicket(ticketId);
      if (sequence !== selectionSequence.current) return;
      selectedTicketId.current = ticket.id;
      setSelected(ticket);
      setTagsText(ticket.tags.join(', '));
      setAssignedToText(ticket.assignedTo ?? '');
    } catch (selectError) {
      setError(errorText(selectError));
    } finally {
      setBusy(undefined);
    }
  }

  const refreshSelected = useCallback(
    async (ticketId = selectedTicketId.current, preserveEditableDrafts = false): Promise<void> => {
      if (!ticketId) return;
      const sequence = selectionSequence.current;
      try {
        const fresh = await props.client.getAdminSupportTicket(ticketId);
        if (selectedTicketId.current !== ticketId || sequence !== selectionSequence.current) return;
        setSelected((current) => mergeTicketDetail(current, fresh));
        if (!preserveEditableDrafts) {
          setTagsText(fresh.tags.join(', '));
          setAssignedToText(fresh.assignedTo ?? '');
        }
        setItems((current) => mergeSummary(fresh, current));
      } catch (refreshError) {
        setError(errorText(refreshError));
      }
    },
    [props.client],
  );

  useEffect(() => {
    const isVisible = (): boolean => document.visibilityState === 'visible';
    const selectedTimer = globalThis.setInterval(() => {
      if (isVisible() && !busy && !pendingRetry) void refreshSelected(undefined, true);
    }, 15_000);
    const queueTimer = globalThis.setInterval(() => {
      if (isVisible() && !busy && !pendingRetry) void load(undefined, false, true);
    }, 30_000);
    return () => {
      globalThis.clearInterval(selectedTimer);
      globalThis.clearInterval(queueTimer);
    };
  }, [busy, load, pendingRetry, refreshSelected]);

  async function updateTicket(
    action: string,
    changes: Parameters<NotificationAdminClient['updateAdminSupportTicket']>[1],
  ): Promise<void> {
    if (!selected || busy || !props.canManage) return;
    const previous = selected;
    const keyName = `${selected.id}:${action}`;
    const retained = updates.current.get(keyName);
    const request = retained?.input ?? changes;
    const key = retained?.key ?? commandKey('support-update');
    updates.current.set(keyName, { key, input: request });
    const optimistic = { ...previous, ...request, version: previous.version + 1 } as SupportTicket;
    setSelected(optimistic);
    setBusy(action);
    setError(undefined);
    try {
      const ticket = await props.client.updateAdminSupportTicket(selected.id, request, key);
      updates.current.delete(keyName);
      setPendingRetry(undefined);
      setSelected((current) => mergeTicketDetail(current, ticket));
      setTagsText(ticket.tags.join(', '));
      setAssignedToText(ticket.assignedTo ?? '');
      setItems((current) => mergeSummary(ticket, current));
      await refreshSelected(ticket.id);
    } catch (updateError) {
      setSelected(previous);
      setItems((current) => mergeSummary(previous, current));
      if (isDefinitiveCommandError(updateError)) updates.current.delete(keyName);
      if (!isDefinitiveCommandError(updateError)) {
        setPendingRetry({ kind: 'update', ticketId: selected.id, keyName, key, input: request });
      }
      setError(`${errorText(updateError)} Данные тикета загружены с сервера.`);
      await refreshSelected(selected.id);
    } finally {
      setBusy(undefined);
    }
  }

  async function sendMessage(): Promise<void> {
    if (!selected || !draft.trim() || busy || !props.canManage) return;
    const previous = selected;
    const keyName = `${selected.id}:message:${internal ? 'internal' : 'reply'}`;
    const retained = messages.current.get(keyName);
    const request = retained?.input ?? {
      body: draft.trim(),
      internal,
      expectedVersion: selected.version,
    };
    const key = retained?.key ?? commandKey('support-message');
    messages.current.set(keyName, { key, input: request });
    setBusy('message');
    setError(undefined);
    try {
      const ticket = await props.client.sendAdminSupportTicketMessage(selected.id, request, key);
      messages.current.delete(keyName);
      setPendingRetry(undefined);
      setSelected((current) => mergeTicketDetail(current, ticket));
      setItems((current) => mergeSummary(ticket, current));
      setDraft('');
      setInternal(false);
      await refreshSelected(ticket.id);
    } catch (messageError) {
      if (isDefinitiveCommandError(messageError)) messages.current.delete(keyName);
      if (!isDefinitiveCommandError(messageError)) {
        setPendingRetry({ kind: 'message', ticketId: selected.id, keyName, key, input: request });
      }
      setError(`${errorText(messageError)} История обращения загружена с сервера.`);
      setSelected(previous);
      await refreshSelected(selected.id);
    } finally {
      setBusy(undefined);
    }
  }

  async function retryPendingCommand(): Promise<void> {
    if (!pendingRetry || busy || selectedTicketId.current !== pendingRetry.ticketId) return;
    setBusy('retry');
    setError(undefined);
    try {
      const ticket =
        pendingRetry.kind === 'update'
          ? await props.client.updateAdminSupportTicket(
              pendingRetry.ticketId,
              pendingRetry.input,
              pendingRetry.key,
            )
          : await props.client.sendAdminSupportTicketMessage(
              pendingRetry.ticketId,
              pendingRetry.input,
              pendingRetry.key,
            );
      if (selectedTicketId.current !== pendingRetry.ticketId) return;
      if (pendingRetry.kind === 'update') updates.current.delete(pendingRetry.keyName);
      else messages.current.delete(pendingRetry.keyName);
      setPendingRetry(undefined);
      setSelected((current) => mergeTicketDetail(current, ticket));
      setTagsText(ticket.tags.join(', '));
      setAssignedToText(ticket.assignedTo ?? '');
      setItems((current) => mergeSummary(ticket, current));
      if (pendingRetry.kind === 'message') {
        setDraft('');
        setInternal(false);
      }
      await refreshSelected(ticket.id);
    } catch (retryError) {
      if (isDefinitiveCommandError(retryError)) {
        if (pendingRetry.kind === 'update') updates.current.delete(pendingRetry.keyName);
        else messages.current.delete(pendingRetry.keyName);
        setPendingRetry(undefined);
      }
      setError(`${errorText(retryError)} История обращения загружена с сервера.`);
      await refreshSelected(pendingRetry.ticketId);
    } finally {
      setBusy(undefined);
    }
  }

  const visibleMessages =
    selected?.messages.filter((message) => showInternal || !message.internal) ?? [];

  return (
    <main className="workspace support-workspace">
      <header className="workspace-header">
        <div>
          <p className="eyebrow">Техподдержка</p>
          <h1>Обращения</h1>
          <p className="muted">
            Решённые обращения автоматически закроются через 72 часа без ответа пользователя.
          </p>
        </div>
      </header>

      <section className="panel support-filter-panel" aria-label="Фильтры обращений">
        <label>
          Поиск
          <input
            value={filters.query}
            onChange={(event) =>
              setFilters((current) => ({ ...current, query: event.target.value }))
            }
            placeholder="Тема или ID обращения"
          />
        </label>
        <label>
          Статус
          <select
            value={filters.status}
            onChange={(event) =>
              setFilters((current) => ({
                ...current,
                status: event.target.value as SupportTicketStatus | '',
              }))
            }
          >
            <option value="">Все</option>
            {statuses.map((value) => (
              <option key={value} value={value}>
                {statusLabel[value]}
              </option>
            ))}
          </select>
        </label>
        <label>
          Категория
          <select
            value={filters.category}
            onChange={(event) =>
              setFilters((current) => ({
                ...current,
                category: event.target.value as SupportTicketCategory | '',
              }))
            }
          >
            <option value="">Все</option>
            {categories.map((value) => (
              <option key={value} value={value}>
                {categoryLabel[value]}
              </option>
            ))}
          </select>
        </label>
        <label>
          Приоритет
          <select
            value={filters.priority}
            onChange={(event) =>
              setFilters((current) => ({
                ...current,
                priority: event.target.value as SupportTicketPriority | '',
              }))
            }
          >
            <option value="">Все</option>
            {priorities.map((value) => (
              <option key={value} value={value}>
                {priorityLabel[value]}
              </option>
            ))}
          </select>
        </label>
        <button
          className="secondary-button"
          type="button"
          onClick={() => void load()}
          disabled={loading}
        >
          Обновить очередь
        </button>
      </section>

      {error ? (
        <div className="notice danger" role="alert">
          {error}
        </div>
      ) : null}
      <section className="support-layout">
        <section className="panel support-queue" aria-busy={loading}>
          <header>
            <h2>Очередь</h2>
            <span>{items.length}</span>
          </header>
          {loading && items.length === 0 ? <p className="muted">Загружаем обращения…</p> : null}
          {!loading && items.length === 0 ? (
            <p className="muted">По этому фильтру обращений нет.</p>
          ) : null}
          <div className="support-ticket-list" role="list">
            {items.map((ticket) => (
              <button
                type="button"
                key={ticket.id}
                className={`support-ticket-row ${selected?.id === ticket.id ? 'selected' : ''}`}
                onClick={() => void selectTicket(ticket.id)}
                disabled={Boolean(busy) || Boolean(pendingRetry)}
              >
                <strong>{ticket.subject}</strong>
                <span>
                  {categoryLabel[ticket.category]} · {priorityLabel[ticket.priority]}
                </span>
                <small>
                  {statusLabel[ticket.status]} · {formatDate(ticket.updatedAt)}
                </small>
              </button>
            ))}
          </div>
          {nextCursor ? (
            <button
              type="button"
              className="secondary-button"
              onClick={() => void load(nextCursor, true)}
              disabled={loading || Boolean(busy) || Boolean(pendingRetry)}
            >
              Показать ещё
            </button>
          ) : null}
        </section>

        <section className="panel support-ticket-detail" aria-live="polite">
          {!selected ? (
            <div className="empty-state">
              <span>?</span>
              <p>Выберите обращение из очереди, чтобы открыть диалог.</p>
            </div>
          ) : (
            <>
              {pendingRetry ? (
                <div className="notice warning">
                  Исход предыдущей команды не подтверждён. Повтор отправит тот же запрос с тем же
                  ключом, без новых изменений.
                  <button
                    className="secondary-button"
                    type="button"
                    disabled={Boolean(busy)}
                    onClick={() => void retryPendingCommand()}
                  >
                    Повторить последнюю команду
                  </button>
                </div>
              ) : null}
              <header className="support-ticket-header">
                <div>
                  <p className="eyebrow">{selected.id}</p>
                  <h2>{selected.subject}</h2>
                </div>
                <span className="status-chip">{statusLabel[selected.status]}</span>
              </header>
              <div className="support-fields">
                <label>
                  Статус
                  <select
                    value={selected.status}
                    disabled={Boolean(busy) || Boolean(pendingRetry) || !props.canManage}
                    onChange={(event) =>
                      void updateTicket('status', {
                        expectedVersion: selected.version,
                        status: event.target.value as SupportTicketStatus,
                      })
                    }
                  >
                    {statuses.map((value) => (
                      <option key={value} value={value}>
                        {statusLabel[value]}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Приоритет
                  <select
                    value={selected.priority}
                    disabled={Boolean(busy) || Boolean(pendingRetry) || !props.canManage}
                    onChange={(event) =>
                      void updateTicket('priority', {
                        expectedVersion: selected.version,
                        priority: event.target.value as SupportTicketPriority,
                      })
                    }
                  >
                    {priorities.map((value) => (
                      <option key={value} value={value}>
                        {priorityLabel[value]}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Категория
                  <select
                    value={selected.category}
                    disabled={Boolean(busy) || Boolean(pendingRetry) || !props.canManage}
                    onChange={(event) =>
                      void updateTicket('category', {
                        expectedVersion: selected.version,
                        category: event.target.value as SupportTicketCategory,
                      })
                    }
                  >
                    {categories.map((value) => (
                      <option key={value} value={value}>
                        {categoryLabel[value]}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Ответственный UUID
                  <input
                    value={assignedToText}
                    disabled={Boolean(busy) || Boolean(pendingRetry) || !props.canManage}
                    placeholder="Не назначен"
                    onChange={(event) => setAssignedToText(event.target.value)}
                    onBlur={(event) => {
                      const assignedTo = event.target.value.trim() || null;
                      if (assignedTo !== selected.assignedTo)
                        void updateTicket('assignee', {
                          expectedVersion: selected.version,
                          assignedTo,
                        });
                    }}
                  />
                </label>
                <label className="support-tags">
                  Теги через запятую
                  <input
                    value={tagsText}
                    disabled={Boolean(busy) || Boolean(pendingRetry) || !props.canManage}
                    onChange={(event) => setTagsText(event.target.value)}
                    onBlur={() => {
                      const tags = [
                        ...new Set(
                          tagsText
                            .split(',')
                            .map((tag) => tag.trim())
                            .filter(Boolean),
                        ),
                      ];
                      if (tags.join(',') !== selected.tags.join(','))
                        void updateTicket('tags', { expectedVersion: selected.version, tags });
                    }}
                  />
                </label>
              </div>
              <p className="support-auto-close">
                Решён: {formatDate(selected.resolvedAt)} · Автозакрытие:{' '}
                {formatDate(selected.autoCloseAt)}
              </p>
              {conversationPurgedAt(selected) ? (
                <p className="notice warning">
                  Переписка удалена после 24 месяцев хранения. Новый ответ начнёт переписку в этом
                  обращении.
                </p>
              ) : null}
              {props.canManage ? (
                <label className="support-internal-toggle">
                  <input
                    type="checkbox"
                    checked={showInternal}
                    onChange={(event) => setShowInternal(event.target.checked)}
                  />{' '}
                  Показывать внутренние заметки
                </label>
              ) : null}
              <div className="support-messages" aria-label="История диалога">
                {visibleMessages.map((message) => (
                  <article
                    className={`support-message ${message.authorRole.toLowerCase()} ${message.internal ? 'internal' : ''}`}
                    key={message.id}
                  >
                    <header>
                      <strong>
                        {message.internal
                          ? 'Внутренняя заметка'
                          : message.authorRole === 'USER'
                            ? 'Пользователь'
                            : message.authorRole === 'AGENT'
                              ? 'Поддержка'
                              : 'Система'}
                      </strong>
                      <time dateTime={message.createdAt}>{formatDate(message.createdAt)}</time>
                    </header>
                    <p>{message.body}</p>
                  </article>
                ))}
              </div>
              <section className="support-history">
                <h3>История статусов</h3>
                {selected.history.map((event) => (
                  <p key={event.id}>
                    <time dateTime={event.createdAt}>{formatDate(event.createdAt)}</time> ·{' '}
                    {historyLabel(event.kind, event.description)}
                  </p>
                ))}
              </section>
              {props.canManage ? (
                <>
                  <label>
                    Ответ или заметка
                    <textarea
                      value={draft}
                      disabled={Boolean(busy) || Boolean(pendingRetry)}
                      onChange={(event) => setDraft(event.target.value)}
                      placeholder={
                        internal
                          ? 'Эту заметку пользователь не увидит'
                          : 'Ответ увидит пользователь'
                      }
                    />
                  </label>
                  <label className="support-internal-toggle">
                    <input
                      type="checkbox"
                      checked={internal}
                      disabled={Boolean(busy) || Boolean(pendingRetry)}
                      onChange={(event) => setInternal(event.target.checked)}
                    />{' '}
                    Внутренняя заметка — не видна пользователю
                  </label>
                  <button
                    className="primary-button"
                    type="button"
                    disabled={!draft.trim() || Boolean(busy) || Boolean(pendingRetry)}
                    onClick={() => void sendMessage()}
                  >
                    {busy === 'message'
                      ? 'Отправляем…'
                      : internal
                        ? 'Добавить заметку'
                        : 'Ответить пользователю'}
                  </button>
                </>
              ) : (
                <p className="notice warning">
                  Доступ только на чтение: отвечать и менять параметры обращения нельзя.
                </p>
              )}
            </>
          )}
        </section>
      </section>
    </main>
  );
}
