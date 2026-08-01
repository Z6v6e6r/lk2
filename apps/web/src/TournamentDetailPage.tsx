import { useEffect, useMemo, useState } from 'react';

import { EventCalendarIcon, EventLevelIcon, EventLocationIcon } from './ActivityCardIcons.js';
import type {
  AuthGateway,
  PublicTournamentSummary,
  TournamentParticipantRoster,
} from './auth-gateway.js';
import { avatarBackgroundUrl, playerInitials } from './avatar-backgrounds.js';
import { tournamentDetailRange } from './tournament-detail-range.js';

type TournamentTab = 'participants' | 'rules' | 'results';

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
  roster,
  rosterLoading,
  rosterError,
}: {
  readonly tournament: PublicTournamentSummary;
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

  return (
    <main className="tournament-detail" aria-labelledby="tournament-title">
      <header className="tournament-detail__header">
        <a className="tournament-detail__round-button" href="/games" aria-label="Назад к событиям">
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
        <button type="button" disabled={tournament.status === 'FULL'}>
          {tournament.status === 'FULL' ? 'Мест нет' : 'Записаться на турнир'}
        </button>
        <small>Запись будет подключена отдельным безопасным действием</small>
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
  const [tournament, setTournament] = useState<PublicTournamentSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [roster, setRoster] = useState<TournamentParticipantRoster | null>(null);
  const [rosterError, setRosterError] = useState(false);
  const range = useMemo(() => tournamentDetailRange(), []);
  const unavailable = !tournamentId || !gateway.getPublicTournamentSummary;

  useEffect(() => {
    let active = true;
    if (unavailable || !tournamentId || !gateway.getPublicTournamentSummary) {
      return () => {
        active = false;
      };
    }
    void gateway.getPublicTournamentSummary(tournamentId, range).then(
      (item) => {
        if (!active) return;
        setTournament(item);
      },
      () => {
        if (active) setError('Не удалось загрузить карточку турнира.');
      },
    );
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
        setRoster(value);
      },
      () => {
        if (!active) return;
        setRosterError(true);
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
        roster={roster}
        rosterLoading={Boolean(gateway.getTournamentParticipants) && !roster && !rosterError}
        rosterError={rosterError}
      />
    );
  }
  const stateError = unavailable ? 'Карточка турнира недоступна.' : error;
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
