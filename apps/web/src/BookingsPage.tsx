import { useState } from 'react';

import type {
  ActivityHistoryPage,
  ActivityHistoryQuery,
  BookingRecommendationPage,
  UserUpcomingBookings,
} from './auth-gateway.js';
import { ActivityHistoryPanel } from './ActivityHistory.js';
import { BookingRecommendations } from './BookingRecommendations.js';
import { MainBottomNavigation } from './HomeDashboardPage.js';

interface BookingsPageProps {
  readonly bookings: UserUpcomingBookings;
  readonly tenantName: string;
  readonly loadHistory: (input?: ActivityHistoryQuery) => Promise<ActivityHistoryPage>;
  readonly loadRecommendations: () => Promise<BookingRecommendationPage>;
}

const statusLabels = {
  confirmed: 'Подтверждено',
  waitlist: 'Лист ожидания',
  payment_required: 'Требуется оплата',
} as const;

function eventDate(value: string): string {
  return new Intl.DateTimeFormat('ru-RU', {
    weekday: 'short',
    day: '2-digit',
    month: 'long',
  }).format(new Date(value));
}

function eventTime(value: string): string {
  return new Intl.DateTimeFormat('ru-RU', {
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

export function BookingsPage({
  bookings,
  tenantName,
  loadHistory,
  loadRecommendations,
}: BookingsPageProps): React.JSX.Element {
  const initialView =
    typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).get('view') === 'for-me'
      ? 'FOR_ME'
      : 'MY';
  const initialScope =
    typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).get('scope') === 'history'
      ? 'HISTORY'
      : 'UPCOMING';
  const [view, setView] = useState<'MY' | 'FOR_ME'>(initialView);
  const [scope, setScope] = useState<'UPCOMING' | 'HISTORY'>(initialScope);
  const [recommendations, setRecommendations] = useState<BookingRecommendationPage | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function showRecommendations(): void {
    setView('FOR_ME');
    setError(null);
    if (recommendations || loading) return;
    setLoading(true);
    void loadRecommendations().then(
      (page) => {
        setRecommendations(page);
        setLoading(false);
      },
      () => {
        setError('Не удалось загрузить рекомендации.');
        setLoading(false);
      },
    );
  }

  return (
    <main className="bookings-page">
      <header className="bookings-header">
        <a className="bookings-back" href="/" aria-label="Вернуться на Главную">
          ‹
        </a>
        <span>{tenantName}</span>
        <h1>Записи</h1>
        <p>Предстоящие активности и персональная подборка</p>
      </header>

      <div className="bookings-main-tabs" role="tablist" aria-label="Раздел записей">
        <button
          type="button"
          role="tab"
          aria-selected={view === 'MY'}
          onClick={() => {
            setView('MY');
            setError(null);
          }}
        >
          Мои записи
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={view === 'FOR_ME'}
          onClick={showRecommendations}
        >
          Для меня
        </button>
      </div>

      {view === 'MY' ? (
        <>
          <div className="bookings-scope-tabs" role="tablist" aria-label="Период записей">
            <button
              type="button"
              role="tab"
              aria-selected={scope === 'UPCOMING'}
              onClick={() => {
                setScope('UPCOMING');
                setError(null);
              }}
            >
              Предстоящие
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={scope === 'HISTORY'}
              onClick={() => {
                setScope('HISTORY');
                setError(null);
              }}
            >
              История
            </button>
          </div>

          {scope === 'UPCOMING' ? (
            <section className="bookings-list" aria-label="Предстоящие записи">
              {bookings.items.length === 0 ? (
                <div className="bookings-empty">
                  <strong>Пока нет предстоящих записей</strong>
                  <p>Новая игра или тренировка появится здесь после записи.</p>
                  <a href="/games">Найти игру</a>
                </div>
              ) : (
                bookings.items.map((item) => (
                  <a className="bookings-item" href={item.route} key={item.id}>
                    <time dateTime={item.startsAt}>
                      <strong>{eventTime(item.startsAt)}</strong>
                      <span>{eventDate(item.startsAt)}</span>
                    </time>
                    <span className="bookings-item-main">
                      <small className={`bookings-status bookings-status--${item.status}`}>
                        {statusLabels[item.status]}
                      </small>
                      <strong>{item.title}</strong>
                      <span>{item.venue}</span>
                    </span>
                    <span className="bookings-chevron" aria-hidden="true">
                      ›
                    </span>
                  </a>
                ))
              )}
            </section>
          ) : (
            <section className="bookings-history" aria-label="История записей">
              <ActivityHistoryPanel active={scope === 'HISTORY'} loadHistory={loadHistory} />
            </section>
          )}
        </>
      ) : (
        <section className="bookings-for-me" aria-label="Рекомендации для меня">
          <header>
            <div>
              <span>Персональная подборка</span>
              <h2>Подходящие игры</h2>
            </div>
            <a href="/profile#booking-preferences-title">Настроить</a>
          </header>
          {loading && !recommendations ? <p role="status">Подбираем игры…</p> : null}
          {recommendations ? <BookingRecommendations page={recommendations} /> : null}
        </section>
      )}

      {error ? (
        <p className="bookings-page-error" role="alert">
          {error}
        </p>
      ) : null}
      <MainBottomNavigation active="games" />
    </main>
  );
}
