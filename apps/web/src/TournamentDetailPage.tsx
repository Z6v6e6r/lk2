import { useEffect, useMemo, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';

import { EventCalendarIcon, EventLevelIcon, EventLocationIcon } from './ActivityCardIcons.js';
import type {
  AuthGateway,
  PublicTournamentSummary,
  TournamentParticipantRoster,
} from './auth-gateway.js';
import { avatarBackgroundUrl, playerInitials } from './avatar-backgrounds.js';
import { UpcomingBookingCard, type HomeUpcomingItem } from './HomeDashboardPage.js';
import { tournamentDetailRange } from './tournament-detail-range.js';

type TournamentTab = 'participants' | 'rules' | 'results';

function returnToPreviousPage(event: ReactMouseEvent<HTMLAnchorElement>): void {
  if (typeof window === 'undefined' || window.history.length <= 1) return;
  event.preventDefault();
  window.history.back();
}

function routeEventId(route: string): string | null {
  const query = route.split('?')[1];
  return query ? new URLSearchParams(query).get('event') : null;
}

function TournamentBookingView({
  booking,
}: {
  readonly booking: HomeUpcomingItem;
}): React.JSX.Element {
  return (
    <main
      className="tournament-detail tournament-detail--booking"
      aria-labelledby="tournament-title"
    >
      <header className="tournament-detail__header">
        <a
          className="tournament-detail__round-button"
          href="/"
          aria-label="Назад к моим записям"
          onClick={returnToPreviousPage}
        >
          <BackIcon />
        </a>
        <strong>Карточка турнира</strong>
        <span aria-hidden="true" />
      </header>
      <section className="tournament-detail__booking-card" aria-label="Турнир из моих записей">
        <div>
          <span>МОЯ ЗАПИСЬ</span>
          <h1 id="tournament-title">{booking.title}</h1>
          <p role="status">Показаны подтверждённые данные из вашей записи.</p>
        </div>
        <UpcomingBookingCard item={booking} showAction={false} />
      </section>
    </main>
  );
}

function schedule(tournament: PublicTournamentSummary): {
  readonly day: string;
  readonly weekday: string;
  readonly dateTime: string;
} {
  const startsAt = new Date(tournament.startsAt);
  const endsAt = new Date(tournament.endsAt);
  const format = (options: Intl.DateTimeFormatOptions, date = startsAt) =>
    new Intl.DateTimeFormat('ru-RU', { ...options, timeZone: 'Europe/Moscow' }).format(date);
  return {
    day: format({ day: 'numeric' }),
    weekday: format({ weekday: 'short' }).replace('.', ''),
    dateTime: `${format({ day: 'numeric', month: 'long' })}, ${format({
      hour: '2-digit',
      minute: '2-digit',
    })}—${format({ hour: '2-digit', minute: '2-digit' }, endsAt)}`,
  };
}

function levelLabel(tournament: PublicTournamentSummary): string {
  const range = tournament.levelRange;
  if (!range) return 'Любой уровень';
  return range.from === range.to ? range.from : `от ${range.from} до ${range.to}`;
}

const TOURNAMENT_LEAVE_CUTOFF_MS = 24 * 60 * 60 * 1_000;

function tournamentParticipationAction(
  tournament: PublicTournamentSummary,
  booking: HomeUpcomingItem | null,
  now = Date.now(),
): { readonly label: string; readonly disabled: boolean; readonly hint: string } {
  if (booking?.status === 'confirmed') {
    const canLeave = Date.parse(tournament.startsAt) - now > TOURNAMENT_LEAVE_CUTOFF_MS;
    return canLeave
      ? {
          label: 'Покинуть турнир',
          disabled: false,
          hint: 'Выход из турнира будет подключён отдельным безопасным действием',
        }
      : {
          label: 'Вы записаны',
          disabled: true,
          hint: 'Покинуть турнир можно не позднее чем за 24 часа до начала',
        };
  }
  if (booking?.status === 'waitlist') {
    return {
      label: 'Вы в листе ожидания',
      disabled: true,
      hint: 'Управление листом ожидания будет подключено отдельным безопасным действием',
    };
  }
  if (booking?.status === 'payment_required') {
    return {
      label: 'Нужна оплата',
      disabled: true,
      hint: 'Оплата участия будет подключена отдельным безопасным действием',
    };
  }
  return tournament.status === 'FULL'
    ? { label: 'Мест нет', disabled: true, hint: 'Регистрация на турнир завершена' }
    : {
        label: 'Записаться на турнир',
        disabled: false,
        hint: 'Запись будет подключена отдельным безопасным действием',
      };
}

function BackIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="m14.5 6-6 6 6 6"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2.4"
      />
    </svg>
  );
}

function MoreIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="5" cy="12" r="1.7" fill="currentColor" />
      <circle cx="12" cy="12" r="1.7" fill="currentColor" />
      <circle cx="19" cy="12" r="1.7" fill="currentColor" />
    </svg>
  );
}

function PeopleIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="9" cy="8" r="3" fill="currentColor" />
      <circle cx="16.5" cy="9.5" r="2.4" fill="currentColor" opacity=".72" />
      <path d="M3.7 18c.5-3.3 2.3-5 5.3-5s4.9 1.7 5.4 5H3.7Z" fill="currentColor" />
      <path
        d="M13.3 17.7c.2-2.2 1.4-3.5 3.6-3.5 2.1 0 3.3 1.2 3.6 3.5h-7.2Z"
        fill="currentColor"
        opacity=".72"
      />
    </svg>
  );
}

function TournamentView({
  tournament,
  booking,
  roster,
  rosterLoading,
  rosterError,
}: {
  readonly tournament: PublicTournamentSummary;
  readonly booking: HomeUpcomingItem | null;
  readonly roster: TournamentParticipantRoster | null;
  readonly rosterLoading: boolean;
  readonly rosterError: boolean;
}): React.JSX.Element {
  const [tab, setTab] = useState<TournamentTab>('participants');
  const [showAllParticipants, setShowAllParticipants] = useState(false);
  const eventSchedule = schedule(tournament);
  const organizer = tournament.organizer;
  const organizerFallback = organizer
    ? avatarBackgroundUrl(`${tournament.id}:${organizer.displayName}`)
    : avatarBackgroundUrl(tournament.id);
  const participationAction = tournamentParticipationAction(tournament, booking);

  return (
    <main className="tournament-detail" aria-labelledby="tournament-title">
      <header className="tournament-detail__header">
        <a
          className="tournament-detail__round-button"
          href="/games"
          aria-label="Назад к событиям"
          onClick={returnToPreviousPage}
        >
          <BackIcon />
        </a>
        <strong>{tournament.title}</strong>
        <button className="tournament-detail__round-button" type="button" aria-label="Ещё">
          <MoreIcon />
        </button>
      </header>

      <section className="tournament-detail__hero">
        <span
          className="tournament-detail__ball tournament-detail__ball--left"
          aria-hidden="true"
        />
        <span
          className="tournament-detail__ball tournament-detail__ball--right"
          aria-hidden="true"
        />
        <span className="tournament-detail__glass" aria-hidden="true" />
        <div className="tournament-detail__hero-copy">
          <span className="tournament-detail__format">● {tournament.format}</span>
          <h1 id="tournament-title">{tournament.title}</h1>
        </div>
      </section>

      <section className="tournament-detail__summary" aria-label="Информация о турнире">
        <div className="tournament-detail__summary-list">
          <span>
            <EventCalendarIcon />
            <strong>{eventSchedule.dateTime}</strong>
          </span>
          <span>
            <EventLocationIcon />
            <strong>{tournament.venue}</strong>
          </span>
          <span className="tournament-detail__level-icon">
            <EventLevelIcon />
          </span>
          <strong>{levelLabel(tournament)}</strong>
          <span>
            <PeopleIcon />
            <strong>Микст</strong>
          </span>
        </div>
        <time dateTime={tournament.startsAt}>
          <strong>{eventSchedule.day}</strong>
          <small>{eventSchedule.weekday}</small>
        </time>
      </section>

      <section className="tournament-detail__organizer" aria-label="Организатор">
        <span className="tournament-detail__organizer-avatar" aria-hidden="true">
          <img src={organizer?.avatarUrl ?? organizerFallback} alt="" />
          <span>
            {playerInitials(organizer?.displayName ?? tournament.trainerName ?? 'ПадлХАБ')}
          </span>
        </span>
        <span>
          <strong>{organizer?.displayName ?? tournament.trainerName ?? 'ПадлХАБ'}</strong>
          <small>@НИКНЭЙМ</small>
        </span>
        <em>ОРГАНИЗАТОР</em>
      </section>

      <section className="tournament-detail__content">
        <div className="tournament-detail__tabs" role="tablist" aria-label="Разделы турнира">
          {(
            [
              ['participants', 'Участники'],
              ['rules', 'Регламент'],
              ['results', 'Результаты'],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={tab === value}
              onClick={() => setTab(value)}
            >
              {label}
            </button>
          ))}
        </div>

        {tab === 'participants' ? (
          <div className="tournament-detail__participants" role="tabpanel">
            <div className="tournament-detail__capacity-line" aria-hidden="true">
              {Array.from({ length: Math.min(12, tournament.capacity.total) }, (_, index) => (
                <span
                  key={index}
                  className={
                    index < Math.min(tournament.capacity.registered, 12) ? 'is-filled' : undefined
                  }
                />
              ))}
            </div>
            <div className="tournament-detail__capacity">
              <span>
                <PeopleIcon />
                <strong>{tournament.capacity.registered}</strong> / {tournament.capacity.total}
              </span>
              <small>Уровень</small>
            </div>
            <div className="tournament-detail__empty-roster">
              {roster?.items.length ? (
                <>
                  <div className="tournament-detail__roster">
                    {roster.items
                      .slice(0, showAllParticipants ? roster.items.length : 5)
                      .map((participant) => (
                        <div key={participant.id} className="tournament-detail__participant">
                          <i
                            aria-hidden="true"
                            style={{
                              backgroundImage: `url("${avatarBackgroundUrl(participant.id)}")`,
                            }}
                          />
                          <span>
                            <strong>{participant.displayName}</strong>
                            <small>@НИКНЭЙМ</small>
                          </span>
                          <em>{participant.level ?? tournament.levelRange?.from ?? '—'}</em>
                        </div>
                      ))}
                  </div>
                  {roster.items.length > 5 ? (
                    <button
                      className="tournament-detail__show-more"
                      type="button"
                      onClick={() => setShowAllParticipants((value) => !value)}
                    >
                      {showAllParticipants ? 'Свернуть' : 'Показать больше'}
                    </button>
                  ) : null}
                </>
              ) : rosterLoading ? (
                <p role="status">Актуализируем список участников…</p>
              ) : rosterError ? (
                <p role="status">Не удалось обновить список. Количество участников актуально.</p>
              ) : (
                <p>Участники пока не добавлены.</p>
              )}
            </div>
          </div>
        ) : tab === 'rules' ? (
          <div className="tournament-detail__placeholder" role="tabpanel">
            <strong>Регламент турнира</strong>
            <p>Организатор пока не опубликовал регламент.</p>
          </div>
        ) : (
          <div className="tournament-detail__placeholder" role="tabpanel">
            <strong>Результаты</strong>
            <p>Результаты появятся после завершения турнира.</p>
          </div>
        )}
      </section>

      <footer className="tournament-detail__action">
        <button type="button" disabled={participationAction.disabled}>
          {participationAction.label}
        </button>
        <small>{participationAction.hint}</small>
      </footer>
    </main>
  );
}

export function TournamentDetailPage({
  gateway,
  tournamentId,
}: {
  readonly gateway: AuthGateway;
  readonly tournamentId: string | null;
}): React.JSX.Element {
  const [detail, setDetail] = useState<
    | {
        readonly requestId: string;
        readonly source: 'PUBLIC';
        readonly tournament: PublicTournamentSummary;
      }
    | { readonly requestId: string; readonly source: 'BOOKING'; readonly booking: HomeUpcomingItem }
    | null
  >(null);
  const [publicReadDoneFor, setPublicReadDoneFor] = useState<string | null>(null);
  const [bookingReadDoneFor, setBookingReadDoneFor] = useState<string | null>(null);
  const [bookingResult, setBookingResult] = useState<{
    readonly requestId: string;
    readonly booking: HomeUpcomingItem | null;
  } | null>(null);
  const [rosterResult, setRosterResult] = useState<{
    readonly tournamentId: string;
    readonly roster: TournamentParticipantRoster;
  } | null>(null);
  const [rosterErrorFor, setRosterErrorFor] = useState<string | null>(null);
  const range = useMemo(() => tournamentDetailRange(), []);
  const currentDetail = detail?.requestId === tournamentId ? detail : null;
  const tournament = currentDetail?.source === 'PUBLIC' ? currentDetail.tournament : null;
  const booking = bookingResult?.requestId === tournamentId ? bookingResult.booking : null;
  const roster =
    rosterResult && rosterResult.tournamentId === tournament?.id ? rosterResult.roster : null;
  const rosterError = rosterErrorFor === tournament?.id;
  const unavailable = !tournamentId;

  useEffect(() => {
    let active = true;
    if (unavailable || !tournamentId) {
      return () => {
        active = false;
      };
    }
    if (gateway.getPublicTournamentSummary) {
      void gateway.getPublicTournamentSummary(tournamentId, range).then(
        (item) => {
          if (!active) return;
          setDetail({ requestId: tournamentId, source: 'PUBLIC', tournament: item });
          setPublicReadDoneFor(tournamentId);
        },
        () => {
          if (active) setPublicReadDoneFor(tournamentId);
        },
      );
    } else {
      void Promise.resolve().then(() => {
        if (active) setPublicReadDoneFor(tournamentId);
      });
    }
    if (typeof gateway.getUpcomingBookings === 'function') {
      void gateway.getUpcomingBookings().then(
        (bookings) => {
          if (!active) return;
          const booking = bookings.items.find(
            (item) => item.kind === 'tournament' && routeEventId(item.route) === tournamentId,
          );
          setBookingResult({ requestId: tournamentId, booking: booking ?? null });
          if (booking) {
            setDetail((current) =>
              current?.requestId === tournamentId
                ? current
                : { requestId: tournamentId, source: 'BOOKING', booking },
            );
          }
          setBookingReadDoneFor(tournamentId);
        },
        () => {
          if (active) setBookingReadDoneFor(tournamentId);
        },
      );
    } else {
      void Promise.resolve().then(() => {
        if (active) setBookingReadDoneFor(tournamentId);
      });
    }
    return () => {
      active = false;
    };
  }, [gateway, range, tournamentId, unavailable]);

  useEffect(() => {
    let active = true;
    if (!tournament || !gateway.getTournamentParticipants) return () => undefined;
    void gateway.getTournamentParticipants(tournament.id).then(
      (value) => {
        if (!active) return;
        setRosterResult({ tournamentId: tournament.id, roster: value });
      },
      () => {
        if (!active) return;
        setRosterErrorFor(tournament.id);
      },
    );
    return () => {
      active = false;
    };
  }, [gateway, tournament]);

  if (tournament) {
    return (
      <TournamentView
        tournament={tournament}
        booking={booking}
        roster={roster}
        rosterLoading={Boolean(gateway.getTournamentParticipants) && !roster && !rosterError}
        rosterError={rosterError}
      />
    );
  }
  if (currentDetail?.source === 'BOOKING') {
    return <TournamentBookingView booking={currentDetail.booking} />;
  }
  const stateError = unavailable
    ? 'Карточка турнира недоступна.'
    : publicReadDoneFor === tournamentId && bookingReadDoneFor === tournamentId
      ? 'Не удалось загрузить карточку турнира.'
      : null;
  return (
    <main className="tournament-detail tournament-detail--state">
      <span className={stateError ? undefined : 'loader'} aria-hidden="true" />
      <h1>{stateError ? 'Карточка недоступна' : 'Открываем турнир'}</h1>
      <p role={stateError ? 'alert' : 'status'}>
        {stateError ?? 'Получаем актуальные данные ПадлХАБ…'}
      </p>
      {stateError ? <a href="/games">К событиям</a> : null}
    </main>
  );
}
