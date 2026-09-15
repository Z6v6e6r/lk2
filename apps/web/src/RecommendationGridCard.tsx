import { TrainingPeopleIcon } from './TrainingPeopleIcon.js';
import { isCoachGameActivity } from './booking-activity-kind.js';
import trainingStarUrl from './assets/recommendation-cards/training-star.svg';
import coachGameBadgeUrl from './assets/recommendation-cards/coach-game-badge.svg';
import './RecommendationGameCard.css';
import { GameTypeBadge } from './GameTypeBadge.js';
import { PlayerLevelAvatar } from './PlayerLevelAvatar.js';
import { FriendsBadgeIcon } from './FriendsBadgeIcon.js';
import tournamentBadgeUrl from './assets/recommendation-cards/tournament-badge.svg';
import dateIconUrl from './assets/recommendation-cards/date.svg';
import locationIconUrl from './assets/recommendation-cards/location.svg';
import levelIconUrl from './assets/recommendation-cards/level.svg';
import { recommendationCover } from './recommendation-cover.js';
import gameHeroUrl from './assets/recommendation-cards/game-hero.webp';
import tournamentHeroUrl from './assets/recommendation-cards/tournament-hero.webp';
import trainingHeroUrl from './assets/recommendation-cards/training-hero.webp';
import type { BookingRecommendationPage } from './auth-gateway.js';
import {
  ParticipantAvatarStack,
  type ParticipantAvatarStackItem,
} from './ParticipantAvatarStack.js';

type RecommendationItem = BookingRecommendationPage['items'][number];

interface RecommendationSchedule {
  readonly dateLabel: string;
  readonly dayLabel: string;
  readonly weekdayLabel: string;
  readonly dateAccessibleLabel: string;
  readonly timeLabel: string;
}

interface RecommendationGridPresentation {
  readonly id: string;
  readonly title: string;
  readonly route: string;
  readonly startsAt: string;
  readonly schedule: RecommendationSchedule;
  readonly kindLabel: string;
  readonly kindTone: 'game' | 'training' | 'tournament';
  readonly heroUrl: string;
  readonly stationCourtLabel: string;
  readonly levelHostLabel?: string;
  readonly participants: readonly ParticipantAvatarStackItem[];
  readonly participantCapacity: number;
  readonly activityHost?: ParticipantAvatarStackItem;
  readonly activityHostLabel?: 'Тренер' | 'Организатор';
  readonly activityOpenSlotCount: number;
  readonly activityOpenSlotLabel?: string;
  readonly availabilityLabel: string;
}

function formatSchedule(
  startsAtValue: string,
  endsAtValue: string,
  timeZone: string,
): RecommendationSchedule {
  const startsAt = new Date(startsAtValue);
  const endsAt = new Date(endsAtValue);
  try {
    const timeFormatter = new Intl.DateTimeFormat('ru-RU', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
    });
    return {
      dayLabel: new Intl.DateTimeFormat('ru-RU', { timeZone, day: 'numeric' }).format(startsAt),
      weekdayLabel: new Intl.DateTimeFormat('ru-RU', { timeZone, weekday: 'short' }).format(
        startsAt,
      ),
      dateLabel: new Intl.DateTimeFormat('ru-RU', {
        timeZone,
        day: 'numeric',
        month: 'short',
      })
        .format(startsAt)
        .replace('.', ''),
      dateAccessibleLabel: new Intl.DateTimeFormat('ru-RU', {
        timeZone,
        weekday: 'long',
        day: 'numeric',
        month: 'long',
      }).format(startsAt),
      timeLabel: `${timeFormatter.format(startsAt)}–${timeFormatter.format(endsAt)}`,
    };
  } catch {
    const timeOptions = { hour: '2-digit', minute: '2-digit' } as const;
    return {
      dayLabel: new Intl.DateTimeFormat('ru-RU', { day: 'numeric' }).format(startsAt),
      weekdayLabel: new Intl.DateTimeFormat('ru-RU', { weekday: 'short' }).format(startsAt),
      dateLabel: new Intl.DateTimeFormat('ru-RU', {
        day: 'numeric',
        month: 'short',
      })
        .format(startsAt)
        .replace('.', ''),
      dateAccessibleLabel: new Intl.DateTimeFormat('ru-RU', {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
      }).format(startsAt),
      timeLabel: `${startsAt.toLocaleTimeString('ru-RU', timeOptions)}–${endsAt.toLocaleTimeString('ru-RU', timeOptions)}`,
    };
  }
}

function levelRangeLabel(
  levelRange: { readonly from?: string | null; readonly to?: string | null } | null | undefined,
): string | undefined {
  const from = levelRange?.from;
  const to = levelRange?.to;
  if (!from && !to) return undefined;
  if (!from || !to || from === to) return from ?? to ?? undefined;
  return `${from}–${to}`;
}

function occupancyLabel(input: {
  readonly total: number | null;
  readonly open: number | null;
  readonly occupied?: number;
}): string {
  if (input.open === 0) return 'Мест нет';
  if (input.open === 1) return 'Осталось 1 место';
  if (input.total !== null) {
    const occupied = Math.max(0, input.occupied ?? input.total - (input.open ?? input.total));
    return `${occupied} из ${input.total} мест`;
  }
  if (input.open !== null) return `Свободно ${input.open} мест`;
  return 'Места уточняются';
}

function gamePresentation(
  item: Extract<RecommendationItem, { kind: 'GAME' }>,
): RecommendationGridPresentation {
  const game = item.game;
  const level = levelRangeLabel(game.levelRange);
  const participants = game.participants.slice(0, 4).map((participant, index) => ({
    key:
      'userId' in participant && typeof participant.userId === 'string'
        ? participant.userId
        : `${participant.displayName}-${index}`,
    displayName: participant.displayName,
    avatarUrl: participant.avatarUrl,
    level: participant.level,
    ...('levelValue' in participant && typeof participant.levelValue === 'number'
      ? { levelValue: participant.levelValue }
      : {}),
    ...('userId' in participant && typeof participant.userId === 'string'
      ? { href: `/profile/${encodeURIComponent(participant.userId)}` }
      : {}),
  }));
  const participantCapacity = Math.min(
    4,
    participants.length + Math.max(0, game.capacity.open ?? 0),
  );
  return {
    id: `game-${game.id}`,
    title: game.title,
    route: `/games/${encodeURIComponent(game.id)}`,
    startsAt: game.startsAt,
    schedule: formatSchedule(game.startsAt, game.endsAt, game.timezone),
    kindLabel: game.kind === 'COACH_GAME' ? 'Игра с тренером' : 'Игра',
    kindTone: 'game',
    heroUrl: recommendationCover(
      game.station.name,
      game.kind === 'COACH_GAME' ? 'COACH_GAME' : 'GAME',
      game.id,
      gameHeroUrl,
    ),
    stationCourtLabel: `${game.station.name}${game.station.shortAddress ? `, ${game.station.shortAddress}` : game.court?.name ? ` · ${game.court.name}` : ''}`,
    levelHostLabel:
      game.levelRange?.from && game.levelRange?.to && game.levelRange.from !== game.levelRange.to
        ? `от ${game.levelRange.from} до ${game.levelRange.to}`
        : level
          ? `Уровень ${level}`
          : 'Любой уровень',
    participants,
    participantCapacity,
    activityOpenSlotCount: 0,
    availabilityLabel: occupancyLabel({
      total: game.capacity.total,
      open: game.capacity.open,
      occupied: game.capacity.occupied,
    }),
  };
}

function activityPresentation(
  item: Exclude<RecommendationItem, { kind: 'GAME' }>,
): RecommendationGridPresentation {
  const activity = item.activity;
  const levelHostLabel =
    activity.kind === 'TRAINING'
      ? activity.host?.displayName
      : [
          levelRangeLabel(activity.levelRange),
          activity.host?.role === 'TRAINER' ? `Тренер ${activity.host.displayName}` : undefined,
        ]
          .filter(Boolean)
          .join(' · ') || undefined;
  const kindLabel = activity.kind === 'TOURNAMENT' ? 'Турнир' : 'Тренировка';
  const activityHostLabel =
    activity.host?.role === 'TRAINER' ? 'Тренер' : activity.host ? 'Организатор' : undefined;
  const activityHost = activity.host
    ? {
        key: `${activity.kind}-${activity.id}-host`,
        displayName: activity.host.displayName,
        avatarUrl: activity.host.avatarUrl,
      }
    : undefined;
  return {
    id: `${activity.kind.toLowerCase()}-${activity.id}`,
    title:
      activity.kind === 'TRAINING'
        ? activity.title
            .replace(/(?<!\p{L})уровень(?!\p{L})\s*/giu, '')
            .replace(/\s+/gu, ' ')
            .trim()
        : activity.title,
    route: activity.route,
    startsAt: activity.startsAt,
    schedule: formatSchedule(activity.startsAt, activity.endsAt, activity.timezone),
    kindLabel,
    kindTone: activity.kind === 'TOURNAMENT' ? 'tournament' : 'training',
    heroUrl: recommendationCover(
      activity.station.name,
      activity.kind,
      activity.id,
      activity.kind === 'TOURNAMENT' ? tournamentHeroUrl : trainingHeroUrl,
    ),
    stationCourtLabel: `${activity.station.name}${activity.court?.name ? ` · ${activity.court.name}` : ''}`,
    ...(levelHostLabel ? { levelHostLabel } : {}),
    // The recommendation contract exposes an activity host, not its participant roster.
    // Keep the host in metadata and do not present them as a booked participant.
    participants: [],
    participantCapacity: 0,
    ...(activityHost ? { activityHost } : {}),
    ...(activityHostLabel ? { activityHostLabel } : {}),
    activityOpenSlotCount: Math.min(3, Math.max(0, activity.capacity.open ?? 0)),
    activityOpenSlotLabel:
      activity.capacity.open === null
        ? 'Количество свободных мест неизвестно'
        : `Свободных мест: ${Math.max(0, activity.capacity.open)}`,
    availabilityLabel: occupancyLabel({
      total: activity.capacity.total,
      open: activity.capacity.open,
    }),
  };
}

export function RecommendationGridCard({
  item,
}: {
  readonly item: RecommendationItem;
}): React.JSX.Element {
  const presentation = item.kind === 'GAME' ? gamePresentation(item) : activityPresentation(item);
  const isFriends = /время\s+на\s+друзей/iu.test(presentation.title);
  const hasCapacityStrip = item.kind === 'TOURNAMENT' || isFriends;
  const capacity = item.kind === 'GAME' ? item.game.capacity : item.activity.capacity;
  const occupied =
    item.kind === 'GAME'
      ? item.game.capacity.occupied
      : capacity.total !== null && capacity.open !== null
        ? Math.max(0, capacity.total - capacity.open)
        : null;
  const tournamentLabel = /мексикано/iu.test(presentation.title)
    ? 'Мексикано'
    : /американо/iu.test(presentation.title)
      ? 'Американо'
      : 'Турнир';
  const isGame = item.kind === 'GAME';
  const isCoachGame =
    item.kind === 'GAME' ? item.game.kind === 'COACH_GAME' : isCoachGameActivity(item.activity);
  const titleId = `recommendation-card-title-${presentation.id}`;
  const hasActivityRoster =
    presentation.activityHost !== undefined || presentation.activityOpenSlotCount > 0;
  const hasVisualAvailability = presentation.participantCapacity > 0 || hasActivityRoster;

  return (
    <article
      className="recommendation-grid-card"
      data-recommendation-kind={presentation.kindTone}
      data-friends-event={isFriends || undefined}
      aria-labelledby={titleId}
    >
      <div className="recommendation-grid-card__hero">
        <img src={presentation.heroUrl} alt="" />
        <time
          dateTime={presentation.startsAt}
          aria-label={`Дата события: ${presentation.schedule.dateAccessibleLabel}`}
        >
          <span className="recommendation-grid-card__day">{presentation.schedule.dayLabel}</span>
          <span className="recommendation-grid-card__weekday">
            {presentation.schedule.weekdayLabel}
          </span>
        </time>
      </div>
      <div className="recommendation-grid-card__body">
        <div className="recommendation-grid-card__header">
          {isFriends || item.kind === 'TOURNAMENT' ? (
            <span className="recommendation-grid-card__event-badge">
              {isFriends ? (
                <FriendsBadgeIcon />
              ) : (
                <img src={tournamentBadgeUrl} width="8" height="8" alt="" />
              )}
              {isFriends ? 'Время на друзей' : tournamentLabel}
            </span>
          ) : isCoachGame ? (
            <img
              className="recommendation-grid-card__coach-badge"
              src={coachGameBadgeUrl}
              width="96"
              height="14"
              alt="Игра + тренер"
            />
          ) : item.kind === 'GAME' &&
            (item.game.kind === 'FRIENDLY' || item.game.kind === 'RATING') ? (
            <GameTypeBadge type={item.game.kind === 'RATING' ? 'rating' : 'friendly'} />
          ) : (
            <span className="recommendation-grid-card__kind">
              {item.kind === 'TRAINING' ? (
                <img src={trainingStarUrl} width="8" height="8" alt="" />
              ) : null}
              {item.kind === 'GAME' && item.game.kind === 'PRIVATE'
                ? 'Закрытая игра'
                : presentation.kindLabel}
            </span>
          )}
          <div className="recommendation-grid-card__title-slot">
            <a
              className="recommendation-grid-card__title"
              href={presentation.route}
              id={titleId}
              title={presentation.title}
            >
              {presentation.title}
            </a>
          </div>
        </div>
        <div className="recommendation-grid-card__metadata">
          <time className="recommendation-grid-card__time" dateTime={presentation.startsAt}>
            <img src={dateIconUrl} width="11" height="11" alt="" />
            <span>
              {presentation.schedule.dateLabel},{' '}
              <span>
                {isGame
                  ? presentation.schedule.timeLabel.replace('–', '—')
                  : presentation.schedule.timeLabel}
              </span>
            </span>
          </time>
          <span
            className="recommendation-grid-card__info-row"
            title={presentation.stationCourtLabel}
          >
            <img src={locationIconUrl} width="11" height="11" alt="" />
            <span title={presentation.stationCourtLabel}>{presentation.stationCourtLabel}</span>
          </span>
          {presentation.levelHostLabel ? (
            <span
              className="recommendation-grid-card__info-row"
              title={presentation.levelHostLabel}
            >
              {item.kind === 'TRAINING' ? (
                <TrainingPeopleIcon />
              ) : (
                <img src={levelIconUrl} width="11" height="11" alt="" />
              )}
              <span>{presentation.levelHostLabel}</span>
            </span>
          ) : null}
        </div>
        <div className="recommendation-grid-card__footer">
          {hasCapacityStrip ? (
            <div
              className="recommendation-grid-card__capacity"
              aria-label={
                occupied !== null && capacity.total !== null
                  ? `Занято ${occupied} из ${capacity.total} мест. ${capacity.open === 0 ? 'Мест нет' : `Свободных мест: ${capacity.open}`}`
                  : 'Количество мест уточняется'
              }
            >
              <span className="recommendation-grid-card__capacity-avatar">
                {presentation.activityHost ? (
                  <PlayerLevelAvatar
                    alt={presentation.activityHost.displayName}
                    accessibleLabel={presentation.activityHost.displayName}
                    src={presentation.activityHost.avatarUrl ?? null}
                    fallbackSeed={presentation.activityHost.key}
                    size={34}
                    showLevelRing={false}
                  />
                ) : (
                  <span aria-label="Организатор">
                    <img src={tournamentBadgeUrl} width="16" height="16" alt="" />
                  </span>
                )}
              </span>
              <span className="recommendation-grid-card__capacity-count" aria-hidden="true">
                {occupied ?? '—'}
                <span>/{capacity.total ?? '—'}</span>
              </span>
              <span className="recommendation-grid-card__capacity-open">
                {capacity.open === null
                  ? 'Места уточняются'
                  : capacity.open === 0
                    ? 'Мест нет'
                    : `(+${capacity.open} ${capacity.open % 10 === 1 && capacity.open % 100 !== 11 ? 'место' : capacity.open % 10 >= 2 && capacity.open % 10 <= 4 && !(capacity.open % 100 >= 12 && capacity.open % 100 <= 14) ? 'места' : 'мест'})`}
              </span>
            </div>
          ) : (
            <div className="recommendation-grid-card__social">
              {hasActivityRoster ? (
                <span
                  className="booking-activity-card__host-roster"
                  aria-label={`${presentation.activityHostLabel ?? 'Организатор'} и свободные места`}
                >
                  {presentation.activityHost ? (
                    <span className="booking-activity-card__host-avatar">
                      <ParticipantAvatarStack
                        ariaLabel={presentation.activityHostLabel ?? 'Организатор'}
                        capacity={1}
                        participants={[presentation.activityHost]}
                        showLevelRing={false}
                      />
                      {item.kind === 'TRAINING' && item.activity.host?.role === 'TRAINER' ? (
                        <span className="recommendation-grid-card__trainer-mark" aria-hidden="true">
                          <FriendsBadgeIcon />
                        </span>
                      ) : null}
                    </span>
                  ) : null}
                  {presentation.activityOpenSlotCount > 0 ? (
                    <span
                      className="booking-activity-card__open-slots"
                      aria-label={presentation.activityOpenSlotLabel}
                    >
                      <ParticipantAvatarStack
                        ariaLabel="Свободные места"
                        capacity={presentation.activityOpenSlotCount}
                        participants={[]}
                        showLevelRing={false}
                      />
                    </span>
                  ) : null}
                </span>
              ) : presentation.participantCapacity > 0 ? (
                <ParticipantAvatarStack
                  ariaLabel="Участники события"
                  capacity={presentation.participantCapacity}
                  participants={presentation.participants}
                  showLevelRing={false}
                />
              ) : null}
              <span
                className={
                  hasVisualAvailability ? 'sr-only' : 'recommendation-grid-card__availability'
                }
              >
                {presentation.availabilityLabel}
              </span>
            </div>
          )}
        </div>
      </div>
    </article>
  );
}
