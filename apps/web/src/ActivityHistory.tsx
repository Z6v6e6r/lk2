import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import type {
  ActivityHistoryItem,
  ActivityHistoryKind,
  ActivityHistoryPage,
  ActivityHistoryQuery,
  ActivityHistoryStatus,
} from './auth-gateway.js';
import { GameCard } from './GameCard.js';

export type ActivityHistoryLoader = (input?: ActivityHistoryQuery) => Promise<ActivityHistoryPage>;

interface ActivityHistoryPanelProps {
  readonly active: boolean;
  readonly loadHistory: ActivityHistoryLoader;
}

interface ActivityHistoryModalProps {
  readonly open: boolean;
  readonly loadHistory: ActivityHistoryLoader;
  readonly onClose: () => void;
}

const kindFilters: readonly [ActivityHistoryKind | 'ALL', string][] = [
  ['ALL', 'Все'],
  ['GAME', 'Игры'],
  ['TRAINING', 'Тренировки'],
  ['TOURNAMENT', 'Турниры'],
];

const statusFilters: readonly [ActivityHistoryStatus, string][] = [
  ['COMPLETED', 'Посещённые'],
  ['CANCELLED', 'Отменённые'],
];

const kindLabels: Record<ActivityHistoryKind, string> = {
  GAME: 'Игра',
  TRAINING: 'Тренировка',
  TOURNAMENT: 'Турнир',
};

function eventDate(value: string): string {
  return new Intl.DateTimeFormat('ru-RU', {
    weekday: 'short',
    day: 'numeric',
    month: 'long',
  }).format(new Date(value));
}

function eventTime(startsAt: string, endsAt?: string | null): string {
  const formatter = new Intl.DateTimeFormat('ru-RU', {
    hour: '2-digit',
    minute: '2-digit',
  });
  const start = formatter.format(new Date(startsAt));
  return endsAt ? `${start}–${formatter.format(new Date(endsAt))}` : start;
}

function GenericHistoryCard({ item }: { readonly item: ActivityHistoryItem }): React.JSX.Element {
  const title = item.route ? <a href={item.route}>{item.title}</a> : <strong>{item.title}</strong>;
  return (
    <article
      className={`activity-history-card activity-history-card--${item.kind.toLowerCase()}`}
      data-history-kind={item.kind}
    >
      <header>
        <span>{kindLabels[item.kind]}</span>
        {item.status === 'CANCELLED' ? <small>Отменено</small> : null}
      </header>
      <h3>{title}</h3>
      {item.kind !== 'GAME' && item.subtitle ? <p>{item.subtitle}</p> : null}
      <dl>
        <div>
          <dt>Дата</dt>
          <dd>
            {eventDate(item.startsAt)}, {eventTime(item.startsAt, item.endsAt)}
          </dd>
        </div>
        <div>
          <dt>Место</dt>
          <dd>{item.venue}</dd>
        </div>
        {item.kind === 'TRAINING' && item.trainerName ? (
          <div>
            <dt>Тренер</dt>
            <dd>{item.trainerName}</dd>
          </div>
        ) : null}
        {(item.kind === 'TOURNAMENT' || item.kind === 'GAME') && item.result ? (
          <div>
            <dt>Результат</dt>
            <dd>{item.result}</dd>
          </div>
        ) : null}
      </dl>
    </article>
  );
}

function HistoryItem({ item }: { readonly item: ActivityHistoryItem }): React.JSX.Element {
  if (item.kind === 'GAME' && item.game) {
    return <GameCard game={item.game} compact />;
  }
  return <GenericHistoryCard item={item} />;
}

export function ActivityHistoryPanel({
  active,
  loadHistory,
}: ActivityHistoryPanelProps): React.JSX.Element {
  const [kind, setKind] = useState<ActivityHistoryKind | 'ALL'>('ALL');
  const [status, setStatus] = useState<ActivityHistoryStatus>('COMPLETED');
  const [page, setPage] = useState<ActivityHistoryPage | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestSequence = useRef(0);
  const autoLoadedFilter = useRef<string | null>(null);

  function query(cursor?: string): ActivityHistoryQuery {
    return {
      ...(kind === 'ALL' ? {} : { kind }),
      status,
      ...(cursor ? { cursor } : {}),
      limit: 20,
    };
  }

  function loadFirstPage(): void {
    const requestId = ++requestSequence.current;
    setLoading(true);
    setError(null);
    void loadHistory(query()).then(
      (nextPage) => {
        if (requestSequence.current !== requestId) return;
        setPage(nextPage);
        setLoading(false);
      },
      () => {
        if (requestSequence.current !== requestId) return;
        setError('Не удалось загрузить историю.');
        setLoading(false);
      },
    );
  }

  useEffect(() => {
    if (!active) return;
    const filterKey = `${kind}:${status}`;
    if (autoLoadedFilter.current === filterKey) return;
    const timer = window.setTimeout(() => {
      autoLoadedFilter.current = filterKey;
      const requestId = ++requestSequence.current;
      setLoading(true);
      setError(null);
      void loadHistory({
        ...(kind === 'ALL' ? {} : { kind }),
        status,
        limit: 20,
      }).then(
        (nextPage) => {
          if (requestSequence.current !== requestId) return;
          setPage(nextPage);
          setLoading(false);
        },
        () => {
          if (requestSequence.current !== requestId) return;
          setError('Не удалось загрузить историю.');
          setLoading(false);
        },
      );
    }, 0);
    // A closed overlay keeps its current page and does not refetch on every opening.
    return () => window.clearTimeout(timer);
  }, [active, kind, loadHistory, status]);

  function selectKind(nextKind: ActivityHistoryKind | 'ALL'): void {
    if (nextKind === kind) return;
    requestSequence.current += 1;
    setKind(nextKind);
    setPage(null);
    setError(null);
    setLoading(false);
    setLoadingMore(false);
  }

  function selectStatus(nextStatus: ActivityHistoryStatus): void {
    if (nextStatus === status) return;
    requestSequence.current += 1;
    setStatus(nextStatus);
    setPage(null);
    setError(null);
    setLoading(false);
    setLoadingMore(false);
  }

  function loadMore(): void {
    const cursor = page?.nextCursor;
    if (!cursor || loadingMore) return;
    const requestId = ++requestSequence.current;
    setLoadingMore(true);
    setError(null);
    void loadHistory(query(cursor)).then(
      (nextPage) => {
        if (requestSequence.current !== requestId) return;
        setPage({
          ...nextPage,
          items: [...(page?.items ?? []), ...nextPage.items],
        });
        setLoadingMore(false);
      },
      () => {
        if (requestSequence.current !== requestId) return;
        setError('Не удалось загрузить следующую страницу.');
        setLoadingMore(false);
      },
    );
  }

  return (
    <div className="activity-history-panel">
      <div className="activity-history-kind-filters" aria-label="Тип записи">
        {kindFilters.map(([value, label]) => (
          <button
            type="button"
            key={value}
            aria-pressed={kind === value}
            onClick={() => selectKind(value)}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="activity-history-status-filters" role="tablist" aria-label="Статус записи">
        {statusFilters.map(([value, label]) => (
          <button
            type="button"
            role="tab"
            key={value}
            aria-selected={status === value}
            onClick={() => selectStatus(value)}
          >
            {label}
          </button>
        ))}
      </div>

      {loading && !page ? (
        <p className="activity-history-state" role="status">
          Загружаем историю…
        </p>
      ) : null}
      {error ? (
        <div className="activity-history-error" role="alert">
          <p>{error}</p>
          <button type="button" onClick={page ? loadMore : loadFirstPage}>
            Повторить
          </button>
        </div>
      ) : null}
      {!loading && page?.items.length === 0 ? (
        <div className="activity-history-empty" role="status">
          <strong>История пока пуста</strong>
          <p>Записи с выбранными фильтрами здесь не найдены.</p>
        </div>
      ) : null}
      {page?.items.length ? (
        <div className="activity-history-list">
          {page.items.map((item) => (
            <HistoryItem item={item} key={item.id} />
          ))}
        </div>
      ) : null}
      {page?.nextCursor ? (
        <button
          className="activity-history-more"
          type="button"
          disabled={loadingMore}
          onClick={loadMore}
        >
          {loadingMore ? 'Загружаем…' : 'Показать ещё'}
        </button>
      ) : null}
    </div>
  );
}

export function ActivityHistoryModal({
  open,
  loadHistory,
  onClose,
}: ActivityHistoryModalProps): React.JSX.Element | null {
  const titleId = useId();
  const dialogRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    openerRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeButtonRef.current?.focus();

    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (!focusable?.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    }

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = previousOverflow;
      openerRef.current?.focus();
    };
  }, [open, onClose]);

  if (!open || typeof document === 'undefined') return null;

  return createPortal(
    <div
      className="activity-history-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={dialogRef}
        className="activity-history-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <header className="activity-history-modal__header">
          <div>
            <span>Мои записи</span>
            <h2 id={titleId}>История</h2>
          </div>
          <button ref={closeButtonRef} type="button" aria-label="Закрыть историю" onClick={onClose}>
            ×
          </button>
        </header>
        <ActivityHistoryPanel active={open} loadHistory={loadHistory} />
      </section>
    </div>,
    document.body,
  );
}
