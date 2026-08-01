import { Fragment, useEffect, useRef, type CSSProperties } from 'react';

import type { HomeRecommendationPromotionDeck } from '@phub/home-projection';

import type { BookingRecommendationPage } from './auth-gateway.js';
import {
  bookingCardBackground,
  type BookingCardBackgroundKind,
} from './booking-card-backgrounds.js';
import {
  isCoachGameActivity,
  type BookingRecommendationActivity,
} from './booking-activity-kind.js';
import { EventCalendarIcon, EventLevelIcon, EventLocationIcon } from './ActivityCardIcons.js';
import { CreateGameButtonIcon } from './CreateGameButtonIcon.js';
import { GameCard } from './GameCard.js';
import { ParticipantAvatarStack } from './ParticipantAvatarStack.js';

type RecommendationItem = BookingRecommendationPage['items'][number];
type RecommendationReason = RecommendationItem['reasons'][number];
type RecommendationReasonTone = 'level' | 'place' | 'social' | 'time';
type CompactActionVariant = 'default' | 'mini-create';
type CompactMetadataVariant = 'default' | 'station-time';
type CompactRosterVariant = 'default' | 'host-slots';

interface RecommendationReasonPresentation {
  readonly chipLabel: string;
  readonly icon: 'level' | 'pin' | 'friends' | 'clock';
  readonly tone: RecommendationReasonTone;
}

const reasonPresentation: Readonly<Record<RecommendationReason, RecommendationReasonPresentation>> =
  {
    LEVEL_MATCH: {
      chipLabel: 'Ровные соперники',
      icon: 'level',
      tone: 'level',
    },
    FRIEND_PLAYING: {
      chipLabel: 'Здесь играют друзья',
      icon: 'friends',
      tone: 'social',
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
  if (icon === 'friends') {
    return (
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <circle cx="5.5" cy="5.5" r="2.5" />
        <circle cx="11.5" cy="6.5" r="2" />
        <path d="M1.8 13c.4-2.5 1.8-3.8 4-3.8s3.6 1.3 4 3.8" />
        <path d="M9.5 10c2.5-.6 4.2.5 4.7 2.6" />
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

function formatActivitySchedule(activity: BookingRecommendationActivity): {
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

function activityLevelLabel(activity: BookingRecommendationActivity): string {
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
  showHostSlots = false,
  footerSupplement,
}: {
  readonly activity: BookingRecommendationActivity;
  readonly compact: boolean;
  readonly compactActionVariant: CompactActionVariant;
  readonly compactMetadataVariant: CompactMetadataVariant;
  readonly compactRosterVariant: CompactRosterVariant;
  readonly showHostSlots?: boolean;
  readonly footerSupplement?: React.ReactNode;
}): React.JSX.Element {
  const schedule = formatActivitySchedule(activity);
  const usesStationTimeMetadata = compact && compactMetadataVariant === 'station-time';
  const actionLabel = activity.capacity.open === 0 ? 'Подробнее' : 'Записаться';
  const usesMiniCreateAction =
    compact && compactActionVariant === 'mini-create' && actionLabel === 'Записаться';
  const usesHostSlots = showHostSlots || (compact && compactRosterVariant === 'host-slots');
  const coachGameActivity = isCoachGameActivity(activity);
  const kindLabel =
    activity.kind === 'TOURNAMENT' ? 'Турнир' : coachGameActivity ? 'Игра + тренер' : 'Тренировка';
  const visibleOpenSlots = Math.min(4, Math.max(0, activity.capacity.open ?? 0));
  const hostParticipants = activity.host
    ? [
        {
          key: `${activity.kind}-${activity.id}-host`,
          displayName: activity.host.displayName,
          avatarUrl: activity.host.avatarUrl,
        },
      ]
    : [];
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
            className={`booking-activity-card__kind booking-activity-card__kind--${activity.kind.toLowerCase()}${coachGameActivity ? ' booking-activity-card__kind--coach-game' : ''}`}
          >
            {activity.kind === 'TRAINING' ? (
              <span className="booking-activity-card__kind-icon" aria-hidden="true">
                <svg viewBox="0 0 10 10" fill="none">
                  <path
                    d="M5.603 1 1.667 5.727h3.206L4.397 9l3.936-4.727H5.127L5.603 1Z"
                    fill="currentColor"
                  />
                </svg>
              </span>
            ) : activity.kind === 'TOURNAMENT' ? (
              <span className="booking-activity-card__kind-icon" aria-hidden="true">
                <svg width="8" height="8" viewBox="0 0 8 8" fill="none">
                  <path
                    d="M5.23438 0C5.88459 0 6.44442 0.368244 6.71191 0.900391H6.94238C7.53498 0.900391 8 1.35255 8 1.92871C7.99995 2.50479 7.74889 2.99711 7.36621 3.40918C7.17696 3.59313 6.93847 3.75743 6.66699 3.85742C6.27576 4.79351 5.38208 5.47261 4.30762 5.58301V6.49902H5.2334C5.68595 6.49918 6.05664 6.85978 6.05664 7.2998V7.39941H6.46777C6.6363 7.39946 6.77609 7.53542 6.77637 7.69922C6.77637 7.86324 6.63646 7.99995 6.46777 8H1.5293C1.36059 7.99997 1.2207 7.86325 1.2207 7.69922C1.22098 7.53541 1.36076 7.39944 1.5293 7.39941H1.94043V7.2998C1.94043 6.85977 2.31111 6.49916 2.76367 6.49902H3.68945V5.58301C2.61632 5.47165 1.72387 4.79265 1.33301 3.85742C1.06154 3.75741 0.823027 3.59313 0.633789 3.40918C0.251107 2.99711 5.17542e-05 2.50479 0 1.92871C0 1.35256 0.465021 0.900396 1.05762 0.900391H1.28809C1.55558 0.368244 2.11541 0 2.76562 0H5.23438ZM4.24316 1.58398C4.10738 1.38014 3.89261 1.38011 3.75684 1.58398L3.53906 1.91211C3.50614 1.96412 3.43185 2.02013 3.37012 2.03613L2.97949 2.13281C2.74083 2.19284 2.67056 2.39701 2.83105 2.58105L3.08691 2.88477C3.12796 2.92885 3.15645 3.01723 3.15234 3.07715L3.12793 3.46875C3.11147 3.7088 3.28812 3.83311 3.51855 3.74512L3.89258 3.60059C3.95019 3.58058 4.04981 3.58058 4.10742 3.60059L4.48145 3.74512C4.7119 3.83314 4.88853 3.70882 4.87207 3.46875L4.84766 3.07715C4.84354 3.01713 4.87291 2.92878 4.91406 2.88477L5.16895 2.58105C5.32944 2.397 5.25919 2.19283 5.02051 2.13281L4.62988 2.03613C4.56815 2.02013 4.49386 1.96412 4.46094 1.91211L4.24316 1.58398Z"
                    fill="currentColor"
                  />
                </svg>
              </span>
            ) : null}
            <span className="booking-activity-card__kind-label">{kindLabel}</span>
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
            <strong>
              {activity.station.name}
              {activity.court?.name ? ` · ${activity.court.name}` : ''}
            </strong>
          </span>
        </span>
        {usesStationTimeMetadata ? (
          <span className="activity-card-metadata-row">
            <EventCalendarIcon />
            <span className="game-card__metadata-text">
              <strong>{schedule.time}</strong>
            </span>
          </span>
        ) : null}
        <span className="game-card__level">
          <span className="game-card__level-icon">
            <EventLevelIcon />
          </span>
          <strong>{activityLevelLabel(activity)}</strong>
        </span>
      </div>
      <div className="game-card__footer">
        {footerSupplement ? (
          <div className="game-card__footer-supplement">{footerSupplement}</div>
        ) : null}
        {usesHostSlots ? (
          <span
            className="booking-activity-card__host-roster"
            aria-label={
              activity.kind === 'TRAINING'
                ? 'Тренер и свободные места'
                : 'Организатор и свободные места'
            }
          >
            {activity.host ? (
              <span className="booking-activity-card__host-avatar">
                <ParticipantAvatarStack
                  ariaLabel={activity.kind === 'TRAINING' ? 'Тренер' : 'Организатор'}
                  capacity={1}
                  participants={hostParticipants}
                  showLevelRing={false}
                />
              </span>
            ) : null}
            <span
              className="booking-activity-card__open-slots"
              aria-label={
                activity.capacity.open === null
                  ? 'Количество свободных мест неизвестно'
                  : `Свободных мест: ${Math.max(0, activity.capacity.open)}`
              }
            >
              <ParticipantAvatarStack
                ariaLabel="Свободные места"
                capacity={visibleOpenSlots}
                participants={[]}
                showLevelRing={false}
              />
            </span>
          </span>
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

export function BookingActivityCard({
  activity,
}: {
  readonly activity: BookingRecommendationActivity;
}): React.JSX.Element {
  return (
    <RecommendationActivityCard
      activity={activity}
      compact={false}
      compactActionVariant="default"
      compactMetadataVariant="default"
      compactRosterVariant="default"
      showHostSlots
    />
  );
}

function recommendationKey(item: RecommendationItem): string {
  return item.kind === 'GAME' ? `game-${item.game.id}` : `${item.kind}-${item.activity.id}`;
}

function recommendationBackgroundKind(item: RecommendationItem): BookingCardBackgroundKind {
  if (item.kind === 'TRAINING' && isCoachGameActivity(item.activity)) {
    return 'COACH_GAME';
  }
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

type RecommendationAdvertisingLayout = 'compact' | 'vertical';
type RecommendationAdvertisingItem = HomeRecommendationPromotionDeck['items'][number];

function repeatedAdvertisingItem(
  deck: HomeRecommendationPromotionDeck | null | undefined,
  recommendationCount: number,
): RecommendationAdvertisingItem | null {
  if (!deck || deck.items.length === 0 || recommendationCount % deck.repeatEveryCards !== 0) {
    return null;
  }
  const occurrence = recommendationCount / deck.repeatEveryCards - 1;
  return deck.items[occurrence % deck.items.length] ?? null;
}

interface RecommendationAdvertisingInsertion {
  readonly cardItem: RecommendationAdvertisingItem | null;
  readonly stripItem: RecommendationAdvertisingItem | null;
}

function recommendationAdvertisingInsertions(input: {
  readonly recommendationCount: number;
  readonly cardDeck: HomeRecommendationPromotionDeck | null | undefined;
  readonly stripDeck: HomeRecommendationPromotionDeck | null | undefined;
  readonly layout: RecommendationAdvertisingLayout;
}): readonly RecommendationAdvertisingInsertion[] {
  let compactCardsSinceStrip = 0;
  let compactStripOccurrence = 0;
  return Array.from({ length: input.recommendationCount }, (_value, index) => {
    const cardItem = repeatedAdvertisingItem(input.cardDeck, index + 1);
    compactCardsSinceStrip += 1 + (cardItem ? 1 : 0);
    const insertCompactStrip =
      input.layout === 'compact' &&
      input.stripDeck &&
      input.stripDeck.items.length > 0 &&
      compactCardsSinceStrip >= input.stripDeck.repeatEveryCards &&
      compactCardsSinceStrip % 2 === 0;
    const stripItem = insertCompactStrip
      ? (input.stripDeck.items[compactStripOccurrence % input.stripDeck.items.length] ?? null)
      : null;
    if (stripItem) {
      compactCardsSinceStrip = 0;
      compactStripOccurrence += 1;
    }
    return { cardItem, stripItem };
  });
}

function RecommendationAdvertisingCard({
  item,
  kind,
  layout,
  onEngagement,
}: {
  readonly item: RecommendationAdvertisingItem;
  readonly kind: 'strip' | 'card';
  readonly layout: RecommendationAdvertisingLayout;
  readonly onEngagement?: (promotionId: string, kind: 'IMPRESSION' | 'CLICK') => unknown;
}): React.JSX.Element {
  const rootRef = useRef<HTMLElement>(null);
  const impressionSentForId = useRef<string | null>(null);
  const cardImageUrl =
    layout === 'compact'
      ? (item.squareImageUrl ?? item.mobileImageUrl ?? item.imageUrl)
      : (item.horizontalImageUrl ?? item.imageUrl ?? item.mobileImageUrl);

  useEffect(() => {
    const element = rootRef.current;
    if (!element || impressionSentForId.current === item.id || !onEngagement) return;
    const recordImpression = (): void => {
      if (impressionSentForId.current === item.id) return;
      impressionSentForId.current = item.id;
      void Promise.resolve(onEngagement(item.id, 'IMPRESSION')).catch(() => undefined);
    };
    if (typeof IntersectionObserver === 'undefined') {
      recordImpression();
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting && entry.intersectionRatio >= 0.5)) {
          recordImpression();
          observer.disconnect();
        }
      },
      { threshold: 0.5 },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [item.id, onEngagement]);

  return (
    <article
      ref={rootRef}
      className={`booking-recommendation-ad is-${kind} is-${layout}`}
      data-recommendation-ad-kind={kind}
    >
      <a
        href={item.route}
        aria-label={`Реклама: ${item.title}`}
        onClick={() => {
          if (onEngagement) {
            void Promise.resolve(onEngagement(item.id, 'CLICK')).catch(() => undefined);
          }
        }}
      >
        <picture aria-hidden="true">
          {kind === 'strip' && item.mobileImageUrl ? (
            <source media="(max-width: 480px)" srcSet={item.mobileImageUrl} />
          ) : null}
          {(kind === 'card' ? cardImageUrl : item.imageUrl) ? (
            <img
              src={kind === 'card' ? (cardImageUrl ?? undefined) : (item.imageUrl ?? undefined)}
              alt=""
            />
          ) : null}
        </picture>
        {kind === 'card' ? (
          <span className="booking-recommendation-ad__content">
            {item.badgeText ? (
              <span className="booking-recommendation-ad__badge">{item.badgeText}</span>
            ) : null}
            {layout === 'compact' ? null : <strong>{item.title}</strong>}
            {item.footerText ? (
              <span className="booking-recommendation-ad__footer">{item.footerText}</span>
            ) : null}
          </span>
        ) : (
          <strong className="booking-recommendation-ad__strip-title">{item.title}</strong>
        )}
      </a>
    </article>
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
  recommendationStripAdvertising,
  recommendationCardAdvertising,
  advertisingLayout = 'vertical',
  onAdvertisingEngagement,
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
  readonly recommendationStripAdvertising?: HomeRecommendationPromotionDeck | null;
  readonly recommendationCardAdvertising?: HomeRecommendationPromotionDeck | null;
  readonly advertisingLayout?: RecommendationAdvertisingLayout;
  readonly onAdvertisingEngagement?: (promotionId: string, kind: 'IMPRESSION' | 'CLICK') => unknown;
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

  const advertisingInsertions = recommendationAdvertisingInsertions({
    recommendationCount: page.items.length,
    cardDeck: recommendationCardAdvertising,
    stripDeck: recommendationStripAdvertising,
    layout: advertisingLayout,
  });

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
      {page.items.map((item, index) => {
        const key = recommendationKey(item);
        const background = bookingCardBackground(recommendationBackgroundKind(item), key);
        const style: BookingRecommendationStyle = {
          '--booking-card-background-image': `url("${background.image}")`,
        };

        const { cardItem, stripItem } = advertisingInsertions[index] ?? {
          cardItem: null,
          stripItem: null,
        };

        return (
          <Fragment key={key}>
            <section
              className="booking-recommendation"
              data-booking-card-background-tone={background.tone}
              data-booking-card-background-variant={background.variant + 1}
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
            {cardItem ? (
              <RecommendationAdvertisingCard
                item={cardItem}
                kind="card"
                layout={advertisingLayout}
                {...(onAdvertisingEngagement ? { onEngagement: onAdvertisingEngagement } : {})}
              />
            ) : null}
            {stripItem ? (
              <RecommendationAdvertisingCard
                item={stripItem}
                kind="strip"
                layout="compact"
                {...(onAdvertisingEngagement ? { onEngagement: onAdvertisingEngagement } : {})}
              />
            ) : null}
          </Fragment>
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
