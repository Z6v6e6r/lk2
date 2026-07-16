import type { UserUpcomingBookings } from './auth-gateway.js';

interface BookingsPageProps {
  readonly bookings: UserUpcomingBookings;
  readonly tenantName: string;
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

export function BookingsPage({ bookings, tenantName }: BookingsPageProps): React.JSX.Element {
  return (
    <main className="bookings-page">
      <header className="bookings-header">
        <a className="bookings-back" href="/" aria-label="Вернуться на Главную">
          ‹
        </a>
        <span>{tenantName}</span>
        <h1>Мои записи</h1>
        <p>Предстоящие игры и тренировки</p>
      </header>

      <section className="bookings-list" aria-label="Предстоящие записи">
        {bookings.items.length === 0 ? (
          <div className="bookings-empty">
            <strong>Пока нет предстоящих записей</strong>
            <p>Новая игра или тренировка появится здесь после записи.</p>
            <a href="/">Вернуться на Главную</a>
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
    </main>
  );
}
