import './RecommendationGameCard.css';
import { GameTypeBadge } from './GameTypeBadge.js';
import { MoreIcon } from './MoreIcon.js';
import dateIconUrl from './assets/recommendation-cards/date.svg';
import locationIconUrl from './assets/recommendation-cards/location.svg';
import levelIconUrl from './assets/recommendation-cards/level.svg';
import { recommendationCover } from './recommendation-cover.js';
import gameHeroUrl from './assets/recommendation-cards/game-hero.webp';
import tournamentHeroUrl from './assets/recommendation-cards/tournament-hero.webp';
import trainingHeroUrl from './assets/recommendation-cards/training-hero.webp';
import type { BookingRecommendationPage } from './auth-gateway.js';
import { CreateGameButtonIcon } from './CreateGameButtonIcon.js';
import { gamePrimaryAction } from './game-card-policy.js';
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
  readonly actionLabel: string;
  readonly actionDisabled: boolean;
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

function formatPrice(
  priceSummary: { readonly amountMinor: number; readonly currency: string } | null | undefined,
): string | undefined {
  if (!priceSummary) return undefined;
  if (priceSummary.amountMinor === 0) return 'Бесплатно';
  return new Intl.NumberFormat('ru-RU', {
    style: 'currency',
    currency: priceSummary.currency,
    maximumFractionDigits: 0,
  }).format(priceSummary.amountMinor / 100);
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

function gameActionPresentation(item: Extract<RecommendationItem, { kind: 'GAME' }>): {
  readonly label: string;
  readonly disabled: boolean;
} {
  const action = gamePrimaryAction(item.game);
  const open = item.game.capacity.open;
  const soldOutWithoutWaitlist =
    open === 0 && action !== 'JOIN_WAITLIST' && action !== 'LEAVE_WAITLIST';
  if (soldOutWithoutWaitlist) return { label: 'Мест нет', disabled: true };

  const label =
    action === 'JOIN'
      ? 'Вступить'
      : action === 'JOIN_WAITLIST'
        ? 'В лист ожидания'
        : action === 'PAY'
          ? 'Оплатить'
          : action === 'RETRY_PAYMENT'
            ? 'Повторить оплату'
            : 'Открыть';
  const price =
    action === 'JOIN' || action === 'JOIN_WAITLIST' || action === 'PAY'
      ? formatPrice(item.game.priceSummary)
      : undefined;
  return { label: price ? `${label} · ${price}` : label, disabled: false };
}

function gamePresentation(
  item: Extract<RecommendationItem, { kind: 'GAME' }>,
): RecommendationGridPresentation {
  const game = item.game;
  const action = gameActionPresentation(item);
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
    actionLabel: action.label,
    actionDisabled: action.disabled,
  };
}

function activityPresentation(
  item: Exclude<RecommendationItem, { kind: 'GAME' }>,
): RecommendationGridPresentation {
  const activity = item.activity;
  const level = levelRangeLabel(activity.levelRange);
  const host =
    activity.host?.role === 'TRAINER' ? `Тренер ${activity.host.displayName}` : undefined;
  const levelHostLabel = [level, host].filter(Boolean).join(' · ') || undefined;
  const isSoldOut = activity.capacity.open === 0;
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
    title: activity.title,
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
    actionLabel: isSoldOut
      ? 'Мест нет'
      : activity.capacity.open === null
        ? 'Открыть'
        : 'Записаться',
    actionDisabled: isSoldOut,
  };
}

export function RecommendationGridCard({
  item,
}: {
  readonly item: RecommendationItem;
}): React.JSX.Element {
  const presentation = item.kind === 'GAME' ? gamePresentation(item) : activityPresentation(item);
  const isGame = item.kind === 'GAME';
  const actionIcon = isGame ? <MoreIcon /> : <CreateGameButtonIcon fill="#6A5AF9" />;
  const action = presentation.actionDisabled ? (
    <button
      className="recommendation-grid-card__action is-disabled"
      type="button"
      aria-label={presentation.actionLabel}
      disabled
    >
      {actionIcon}
    </button>
  ) : (
    <a
      className="recommendation-grid-card__action"
      href={presentation.route}
      aria-label={presentation.actionLabel}
    >
      {actionIcon}
    </a>
  );
  const titleId = `recommendation-card-title-${presentation.id}`;
  const hasActivityRoster =
    presentation.activityHost !== undefined || presentation.activityOpenSlotCount > 0;
  const hasVisualAvailability = presentation.participantCapacity > 0 || hasActivityRoster;

  return (
    <article
      className="recommendation-grid-card"
      data-recommendation-kind={presentation.kindTone}
      aria-labelledby={titleId}
    >
      <a
        className="recommendation-grid-card__hero"
        href={presentation.route}
        aria-label={`Открыть: ${presentation.title}`}
      >
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
      </a>
      <div className="recommendation-grid-card__body">
        <div className="recommendation-grid-card__header">
          {item.kind === 'GAME' &&
          (item.game.kind === 'FRIENDLY' || item.game.kind === 'RATING') ? (
            <GameTypeBadge type={item.game.kind === 'RATING' ? 'rating' : 'friendly'} />
          ) : (
            <span className="recommendation-grid-card__kind">
              {item.kind === 'GAME' && item.game.kind === 'PRIVATE'
                ? 'Закрытая игра'
                : presentation.kindLabel}
            </span>
          )}
          {isGame ? action : null}
          <a
            className="recommendation-grid-card__title"
            href={presentation.route}
            id={titleId}
            title={presentation.title}
          >
            {presentation.title}
          </a>
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
              <img src={levelIconUrl} width="11" height="11" alt="" />
              <span>{presentation.levelHostLabel}</span>
            </span>
          ) : null}
        </div>
        <div className="recommendation-grid-card__footer">
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
          {!isGame ? action : null}
        </div>
      </div>
    </article>
  );
}
