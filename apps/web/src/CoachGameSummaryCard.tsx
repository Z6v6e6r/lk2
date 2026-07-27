import type { PublicCoachGameSummary } from './auth-gateway.js';
import { EventCalendarIcon, EventLevelIcon, EventLocationIcon } from './ActivityCardIcons.js';
import { SummaryParticipants } from './SummaryParticipants.js';
import { avatarBackgroundUrl, playerInitials } from './avatar-backgrounds.js';

function schedule(item: PublicCoachGameSummary): {
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

export function CoachGameSummaryCard({
  coachGame,
}: {
  readonly coachGame: PublicCoachGameSummary;
}): React.JSX.Element {
  const eventSchedule = schedule(coachGame);
  const trainerAvatarFallback = coachGame.trainer
    ? avatarBackgroundUrl(`${coachGame.id}:${coachGame.trainer.displayName}`)
    : '';
  return (
    <article className="game-card coach-game-summary-card" data-event-kind="COACH_GAME">
      <div className="game-card__header">
        <div className="game-card__heading">
          <span className="fh-event__tag is-coach-game">
            <span aria-hidden="true">●</span>
            <span className="fh-event__tag-label">Игра с тренером</span>
          </span>
          <strong className="coach-game-summary-card__title">{coachGame.title}</strong>
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
              {coachGame.stationName}
              {coachGame.courtName ? ` · ${coachGame.courtName}` : ''}
            </strong>
          </span>
        </span>
        <span className="game-card__level">
          <span className="game-card__level-icon">
            <EventLevelIcon />
          </span>
          <strong>{coachGame.level ? `Уровень ${coachGame.level}` : 'Любой уровень'}</strong>
        </span>
      </div>

      {coachGame.trainer ? (
        <div className="coach-game-summary-card__trainer">
          <span
            className="coach-game-summary-card__trainer-avatar"
            role="img"
            aria-label={`Тренер: ${coachGame.trainer.displayName}`}
          >
            <img
              src={coachGame.trainer.avatarUrl ?? trainerAvatarFallback}
              alt=""
              aria-hidden="true"
              loading="lazy"
              decoding="async"
              onError={(event) => {
                event.currentTarget.onerror = null;
                event.currentTarget.src = trainerAvatarFallback;
                const initials = event.currentTarget.nextElementSibling;
                if (initials instanceof HTMLElement) initials.hidden = false;
              }}
            />
            <span aria-hidden="true" hidden={Boolean(coachGame.trainer.avatarUrl)}>
              {playerInitials(coachGame.trainer.displayName)}
            </span>
          </span>
          <span>
            <small>Тренер</small>
            <strong>{coachGame.trainer.displayName}</strong>
          </span>
        </div>
      ) : null}

      <div className="game-card__footer coach-game-summary-card__footer">
        <SummaryParticipants
          occupied={coachGame.capacity.occupied}
          total={coachGame.capacity.total}
        />
      </div>
    </article>
  );
}
