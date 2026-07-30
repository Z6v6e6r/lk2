import type { CSSProperties } from 'react';

import type { BookingRecommendationPage } from './auth-gateway.js';
import {
  bookingCardBackground,
  type BookingCardBackgroundKind,
} from './booking-card-backgrounds.js';
import { EventCalendarIcon, EventLevelIcon, EventLocationIcon } from './ActivityCardIcons.js';
import { CreateGameButtonIcon } from './CreateGameButtonIcon.js';
import { GameCard } from './GameCard.js';
import { ParticipantAvatarStack } from './ParticipantAvatarStack.js';

type RecommendationItem = BookingRecommendationPage['items'][number];
type RecommendationReason = RecommendationItem['reasons'][number];
type RecommendationReasonTone = 'level' | 'place' | 'time';
type CompactActionVariant = 'default' | 'mini-create';
type CompactMetadataVariant = 'default' | 'station-time';
type CompactRosterVariant = 'default' | 'host-slots';
type RecommendationActivity = Extract<
  RecommendationItem,
  { kind: 'TRAINING' | 'TOURNAMENT' }
>['activity'];

interface RecommendationReasonPresentation {
  readonly chipLabel: string;
  readonly icon: 'level' | 'pin' | 'clock';
  readonly tone: RecommendationReasonTone;
}

const reasonPresentation: Readonly<Record<RecommendationReason, RecommendationReasonPresentation>> =
  {
    LEVEL_MATCH: {
      chipLabel: 'Ровные соперники',
      icon: 'level',
      tone: 'level',
    },
    FAVORITE_STATION: {
      chipLabel: 'Любимая станция',
      icon: 'pin',
      tone: 'place',
    },
    PLAYED_STATION: {
      chipLabel: 'Часто играете здесь',
      icon: 'pin',
      tone: 'place',
    },
    PREFERRED_TIME: {
      chipLabel: 'Ваше удобное время',
      icon: 'clock',
      tone: 'time',
    },
    USUAL_TIME: {
      chipLabel: 'Ваше обычное время',
      icon: 'clock',
      tone: 'time',
    },
    AVAILABLE_SOON: {
      chipLabel: 'Ближайшая игра',
      icon: 'clock',
      tone: 'time',
    },
  };

function RecommendationMarkerIcon({
  icon,
}: {
  readonly icon: RecommendationReasonPresentation['icon'];
}): React.JSX.Element {
  if (icon === 'level') {
    return (
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <rect x="2" y="9" width="3" height="5" rx="1.5" />
        <rect x="6.5" y="5" width="3" height="9" rx="1.5" />
        <rect x="11" y="1" width="3" height="13" rx="1.5" />
      </svg>
    );
  }
  if (icon === 'pin') {
    return (
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path d="M8 14s4.5-4.2 4.5-8A4.5 4.5 0 0 0 3.5 6c0 3.8 4.5 8 4.5 8Z" />
        <circle cx="8" cy="6" r="1.5" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="6" />
      <path d="M8 4.5V8l2.5 1.5" />
    </svg>
  );
}

function RecommendationReasonChip({
  reason,
  iconOnly = false,
}: {
  readonly reason: RecommendationReason;
  readonly iconOnly?: boolean;
}): React.JSX.Element {
  const presentation = reasonPresentation[reason];
  return (
    <span
      className={`booking-recommendation__reason booking-recommendation__reason--${presentation.tone}${
        iconOnly ? ' is-icon-only' : ''
      }`}
      data-recommendation-reason={reason}
      {...(iconOnly ? { 'aria-label': presentation.chipLabel } : {})}
    >
      <RecommendationMarkerIcon icon={presentation.icon} />
      {!iconOnly ? presentation.chipLabel : null}
    </span>
  );
}

export function BookingRecommendationReasonChips({
  reasons,
  compact = false,
  iconOnly = false,
}: {
  readonly reasons: RecommendationItem['reasons'];
  readonly compact?: boolean;
  readonly iconOnly?: boolean;
}): React.JSX.Element {
  const visibleReasons = compact ? reasons.slice(0, 2) : reasons;
  const hiddenReasonCount = reasons.length - visibleReasons.length;
  return (
    <div
      className={`booking-recommendation__reasons${iconOnly ? ' is-icon-only' : ''}`}
      aria-label="Почему игра подходит"
    >
      {visibleReasons.map((reason) => (
        <RecommendationReasonChip iconOnly={iconOnly} key={reason} reason={reason} />
      ))}
      {hiddenReasonCount > 0 && !iconOnly ? (
        <span
          className="booking-recommendation__reason-count"
          aria-label={`Ещё причин: ${hiddenReasonCount}`}
        >
          +{hiddenReasonCount}
        </span>
      ) : null}
    </div>
  );
}

function formatActivitySchedule(activity: RecommendationActivity): {
  readonly day: string;
  readonly weekday: string;
  readonly date: string;
  readonly startTime: string;
  readonly time: string;
} {
  const startsAt = new Date(activity.startsAt);
  const endsAt = new Date(activity.endsAt);
  const timeZone = activity.timezone;
  const startTime = new Intl.DateTimeFormat('ru-RU', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
  }).format(startsAt);
  return {
    day: new Intl.DateTimeFormat('ru-RU', { timeZone, day: 'numeric' }).format(startsAt),
    weekday: new Intl.DateTimeFormat('ru-RU', { timeZone, weekday: 'short' })
      .format(startsAt)
      .replace('.', ''),
    date: new Intl.DateTimeFormat('ru-RU', {
      timeZone,
      weekday: 'short',
      day: 'numeric',
      month: 'long',
    }).format(startsAt),
    startTime,
    time: `${startTime}–${new Intl.DateTimeFormat('ru-RU', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
    }).format(endsAt)}`,
  };
}

function activityLevelLabel(activity: RecommendationActivity): string {
  const from = activity.levelRange?.from;
  const to = activity.levelRange?.to;
  if (!from || !to) return 'Любой уровень';
  return from === to ? `Уровень ${from}` : `от ${from} до ${to}`;
}

function RecommendationActivityCard({
  activity,
  compact,
  compactActionVariant,
  compactMetadataVariant,
  compactRosterVariant,
  footerSupplement,
}: {
  readonly activity: RecommendationActivity;
  readonly compact: boolean;
  readonly compactActionVariant: CompactActionVariant;
  readonly compactMetadataVariant: CompactMetadataVariant;
  readonly compactRosterVariant: CompactRosterVariant;
  readonly footerSupplement?: React.ReactNode;
}): React.JSX.Element {
  const schedule = formatActivitySchedule(activity);
  const usesStationTimeMetadata = compact && compactMetadataVariant === 'station-time';
  const actionLabel = activity.capacity.open === 0 ? 'Подробнее' : 'Записаться';
  const usesMiniCreateAction =
    compact && compactActionVariant === 'mini-create' && actionLabel === 'Записаться';
  const usesHostSlots = compact && compactRosterVariant === 'host-slots';
  const showLevel = activity.kind === 'TOURNAMENT' || !usesStationTimeMetadata;
  const kindLabel = activity.kind === 'TOURNAMENT' ? 'Турнир' : 'Тренировка';
  const availability =
    activity.capacity.open === null
      ? 'Подробнее'
      : activity.capacity.open === 0
        ? 'Мест нет'
        : activity.capacity.open === 1
          ? 'Осталось 1 место'
          : `Свободно мест: ${activity.capacity.open}`;
  return (
    <article
      className={`game-card booking-activity-card${compact ? ' is-compact' : ''}`}
      data-event-kind={activity.kind}
    >
      <div className="game-card__header">
        <div className="game-card__heading">
          <span
            className={`booking-activity-card__kind booking-activity-card__kind--${activity.kind.toLowerCase()}`}
          >
            {kindLabel}
          </span>
          <a href={activity.route}>{activity.title}</a>
        </div>
        {compact ? (
          <time
            className="game-card__date-badge"
            dateTime={activity.startsAt}
            aria-label={`Дата события: ${schedule.date}`}
          >
            <strong>{schedule.day}</strong>
            <span>{schedule.weekday}</span>
          </time>
        ) : null}
      </div>
      <div className="game-card__meta">
        {!usesStationTimeMetadata ? (
          <span className="activity-card-metadata-row">
            <EventCalendarIcon />
            <span className="game-card__metadata-text">
              <strong>{schedule.date}</strong>
              <span>{schedule.time}</span>
            </span>
          </span>
        ) : null}
        <span className="activity-card-metadata-row">
          <EventLocationIcon />
          <span className="game-card__metadata-text">
            <strong>{activity.station.name}</strong>
            {usesStationTimeMetadata ? (
              <span>{schedule.time}</span>
            ) : !compact && activity.station.shortAddress ? (
              <span>{activity.station.shortAddress}</span>
            ) : null}
          </span>
        </span>
        {showLevel ? (
          <span className="game-card__level">
            <span className="game-card__level-icon">
              <EventLevelIcon />
            </span>
            <strong>{activityLevelLabel(activity)}</strong>
          </span>
        ) : null}
      </div>
      <div className="game-card__footer">
        {footerSupplement ? (
          <div className="game-card__footer-supplement">{footerSupplement}</div>
        ) : null}
        {usesHostSlots ? (
          <ParticipantAvatarStack
            ariaLabel={
              activity.kind === 'TRAINING'
                ? 'Тренер и свободные места'
                : 'Организатор и свободные места'
            }
            capacity={Math.min(
              4,
              (activity.host ? 1 : 0) + Math.max(0, activity.capacity.open ?? 0),
            )}
            participants={
              activity.host
                ? [
                    {
                      key: `${activity.kind}-${activity.id}-host`,
                      displayName: activity.host.displayName,
                      avatarUrl: activity.host.avatarUrl,
                    },
                  ]
                : []
            }
            showLevelRing={false}
          />
        ) : (
          <span className="game-state">{availability}</span>
        )}
        <div
          className={`game-card__actions${
            usesMiniCreateAction ? ' game-card__actions--mini-create' : ''
          }`}
        >
          <a
            className={`game-card__button${usesMiniCreateAction ? ' game-card__button--mini-create' : ''}`}
            href={activity.route}
            aria-label={usesMiniCreateAction ? actionLabel : undefined}
          >
            {usesMiniCreateAction ? <CreateGameButtonIcon /> : actionLabel}
          </a>
        </div>
      </div>
    </article>
  );
}

function recommendationKey(item: RecommendationItem): string {
  return item.kind === 'GAME' ? `game-${item.game.id}` : `${item.kind}-${item.activity.id}`;
}

function recommendationBackgroundKind(item: RecommendationItem): BookingCardBackgroundKind {
  if (item.kind !== 'GAME') return item.kind;
  return item.game.kind === 'COACH_GAME' ? 'COACH_GAME' : 'GAME';
}

type BookingRecommendationStyle = CSSProperties & {
  readonly '--booking-card-background-image': string;
};

function RecommendationCard({
  item,
  compact,
  compactActionVariant,
  compactMetadataVariant,
  compactRosterVariant,
  footerSupplement,
}: {
  readonly item: RecommendationItem;
  readonly compact: boolean;
  readonly compactActionVariant: CompactActionVariant;
  readonly compactMetadataVariant: CompactMetadataVariant;
  readonly compactRosterVariant: CompactRosterVariant;
  readonly footerSupplement?: React.ReactNode;
}): React.JSX.Element {
  return item.kind === 'GAME' ? (
    <GameCard
      game={item.game}
      compact={compact}
      footerSupplement={footerSupplement}
      showCompactLevel={compact}
      showCompactMetadata={compact}
      compactMetadataVariant={compactMetadataVariant}
      compactActionVariant={compactActionVariant}
    />
  ) : (
    <RecommendationActivityCard
      activity={item.activity}
      compact={compact}
      compactActionVariant={compactActionVariant}
      compactMetadataVariant={compactMetadataVariant}
      compactRosterVariant={compactRosterVariant}
      footerSupplement={footerSupplement}
    />
  );
}

export function BookingRecommendations({
  page,
  compact = false,
  compactActionVariant = 'default',
  compactMetadataVariant = 'default',
  compactRosterVariant = 'default',
  showCompactReasonBadges = true,
  hasMore = false,
  loadingMore = false,
  onLoadMore,
}: {
  readonly page: BookingRecommendationPage;
  readonly compact?: boolean;
  readonly compactActionVariant?: CompactActionVariant;
  readonly compactMetadataVariant?: CompactMetadataVariant;
  readonly compactRosterVariant?: CompactRosterVariant;
  readonly showCompactReasonBadges?: boolean;
  readonly hasMore?: boolean;
  readonly loadingMore?: boolean;
  readonly onLoadMore?: () => void;
}): React.JSX.Element {
  if (page.items.length === 0) {
    return (
      <div className="booking-recommendations-empty" role="status">
        <strong>Пока нет подходящих событий</strong>
        <p>Настройте любимые станции и удобное время или загляните позже.</p>
        <a href="/profile#booking-preferences-title">Настроить предпочтения</a>
      </div>
    );
  }

  return (
    <div
      className={compact ? 'booking-recommendations is-compact' : 'booking-recommendations'}
      onScroll={
        compact && hasMore && onLoadMore
          ? (event) => {
              const container = event.currentTarget;
              if (container.scrollHeight - container.scrollTop - container.clientHeight <= 240) {
                onLoadMore();
              }
            }
          : undefined
      }
    >
      {page.items.map((item) => {
        const key = recommendationKey(item);
        const background = bookingCardBackground(recommendationBackgroundKind(item), key);
        const style: BookingRecommendationStyle = {
          '--booking-card-background-image': `url("${background.image}")`,
        };

        return (
          <section
            className="booking-recommendation"
            data-booking-card-background-tone={background.tone}
            data-booking-card-background-variant={background.variant + 1}
            key={key}
            style={style}
          >
            {!compact ? <BookingRecommendationReasonChips reasons={item.reasons} /> : null}
            <RecommendationCard
              item={item}
              compact={compact}
              compactActionVariant={compactActionVariant}
              compactMetadataVariant={compactMetadataVariant}
              compactRosterVariant={compactRosterVariant}
              footerSupplement={
                compact && showCompactReasonBadges ? (
                  <BookingRecommendationReasonChips iconOnly reasons={item.reasons} compact />
                ) : null
              }
            />
          </section>
        );
      })}
      {loadingMore ? (
        <p className="booking-recommendations__loading-more" role="status">
          Загружаем рекомендации…
        </p>
      ) : null}
    </div>
  );
}
