import type { PublicTournamentSummary } from './auth-gateway.js';
import { EventCalendarIcon, EventLocationIcon } from './ActivityCardIcons.js';
import { SummaryParticipants } from './SummaryParticipants.js';
import { avatarBackgroundUrl, playerInitials } from './avatar-backgrounds.js';

function schedule(item: PublicTournamentSummary): {
  readonly date: string;
  readonly time: string;
} {
  const startsAt = new Date(item.startsAt);
  const endsAt = new Date(item.endsAt);
  const time = new Intl.DateTimeFormat('ru-RU', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Europe/Moscow',
  });
  return {
    date: new Intl.DateTimeFormat('ru-RU', {
      weekday: 'short',
      day: 'numeric',
      month: 'long',
      timeZone: 'Europe/Moscow',
    }).format(startsAt),
    time: `${time.format(startsAt)}–${time.format(endsAt)}`,
  };
}

function levelLabel(tournament: PublicTournamentSummary): string {
  const from = tournament.levelRange?.from;
  const to = tournament.levelRange?.to;
  if (!from || !to) return 'Любой уровень';
  return from === to ? `Уровень ${from}` : `от ${from} до ${to}`;
}

export function TournamentSummaryCard({
  tournament,
}: {
  readonly tournament: PublicTournamentSummary;
}): React.JSX.Element {
  const eventSchedule = schedule(tournament);
  const organizerAvatarFallback = tournament.organizer
    ? avatarBackgroundUrl(`${tournament.id}:${tournament.organizer.displayName}`)
    : '';
  return (
    <article className="game-card tournament-summary-card" data-event-kind="TOURNAMENT">
      <div className="game-card__header">
        <div className="game-card__heading">
          <span className="fh-event__tag is-tournament">
            <span aria-hidden="true">●</span>
            <span className="fh-event__tag-label">Турнир · {tournament.format}</span>
          </span>
          <a href={tournament.route}>{tournament.title}</a>
        </div>
      </div>
      <div className="game-card__meta">
        <span className="game-card__date activity-card-metadata-row">
          <EventCalendarIcon />
          <span className="game-card__metadata-text">
            <strong>{eventSchedule.date}</strong>
            <span>{eventSchedule.time}</span>
          </span>
        </span>
        <span className="activity-card-metadata-row">
          <EventLocationIcon />
          <span className="game-card__metadata-text">
            <strong>
              {tournament.venue} · {levelLabel(tournament)}
            </strong>
          </span>
        </span>
      </div>
      {tournament.organizer ? (
        <div className="tournament-summary-card__organizer">
          <span
            className="tournament-summary-card__organizer-avatar"
            role="img"
            aria-label={`Организатор: ${tournament.organizer.displayName}`}
          >
            <img
              src={tournament.organizer.avatarUrl ?? organizerAvatarFallback}
              alt=""
              aria-hidden="true"
              loading="lazy"
              decoding="async"
              onError={(event) => {
                event.currentTarget.onerror = null;
                event.currentTarget.src = organizerAvatarFallback;
                const initials = event.currentTarget.nextElementSibling;
                if (initials instanceof HTMLElement) initials.hidden = false;
              }}
            />
            <span aria-hidden="true" hidden={Boolean(tournament.organizer.avatarUrl)}>
              {playerInitials(tournament.organizer.displayName)}
            </span>
          </span>
          <span>
            <small>Организатор</small>
            <strong>{tournament.organizer.displayName}</strong>
          </span>
        </div>
      ) : null}
      <div className="game-card__footer tournament-summary-card__footer">
        <SummaryParticipants
          occupied={tournament.capacity.registered}
          total={tournament.capacity.total}
          action={
            <a className="game-card__button" href={tournament.route}>
              {tournament.capacity.open > 0 ? 'Записаться' : 'Подробнее'}
            </a>
          }
        />
      </div>
    </article>
  );
}
