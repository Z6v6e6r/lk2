import {
  gameHistoryPrimaryAction,
  gameHistoryStateLabel,
  gamePrimaryAction,
  gameStateLabel,
  type GameCardAction,
  type GameCardModel,
} from './game-card-policy.js';
import { EventCalendarIcon, EventLevelIcon, EventLocationIcon } from './ActivityCardIcons.js';
import { CreateGameButtonIcon } from './CreateGameButtonIcon.js';
import { GameScoreSummary, type GameScoreSummarySet } from './GameScoreSummary.js';
import { GameTypeBadge } from './GameTypeBadge.js';
import { ParticipantAvatarStack } from './ParticipantAvatarStack.js';
import { avatarBackgroundUrl, playerInitials } from './avatar-backgrounds.js';

export type { GameCardAction, GameCardModel } from './game-card-policy.js';

const actionLabels: Partial<Record<GameCardAction, string>> = {
  JOIN: 'Вступить в игру',
  JOIN_WAITLIST: 'В лист ожидания',
  LEAVE_WAITLIST: 'Покинуть лист ожидания',
  LEAVE: 'Выйти из игры',
  PAY: 'Оплатить место',
  RETRY_PAYMENT: 'Повторить оплату',
  SUBMIT_RESULT: 'Внести результат',
  CONFIRM_RESULT: 'Подтвердить результат',
  DISPUTE_RESULT: 'Оспорить результат',
  VIEW_RESULT: 'Посмотреть результат',
  OPEN_DISPUTE: 'Открыть спор',
};

const commandActions = new Set<GameCardAction>([
  'JOIN',
  'JOIN_WAITLIST',
  'LEAVE_WAITLIST',
  'LEAVE',
  'SUBMIT_RESULT',
  'CONFIRM_RESULT',
  'DISPUTE_RESULT',
]);

function gameKindLabel(kind: GameCardModel['kind']): string {
  switch (kind) {
    case 'RATING':
      return 'Рейтинговая игра';
    case 'PRIVATE':
      return 'Закрытая игра';
    case 'COACH_GAME':
      return 'Игра с тренером';
    default:
      return 'Френдли игра';
  }
}

function formatDate(game: GameCardModel): {
  readonly date: string;
  readonly startTime: string;
  readonly time: string;
} {
  const startsAt = new Date(game.startsAt);
  const endsAt = new Date(game.endsAt);
  const options = { timeZone: game.timezone };
  try {
    const timeFormatter = new Intl.DateTimeFormat('ru-RU', {
      ...options,
      hour: '2-digit',
      minute: '2-digit',
    });
    const startTime = timeFormatter.format(startsAt);
    return {
      date: new Intl.DateTimeFormat('ru-RU', {
        ...options,
        weekday: 'short',
        day: 'numeric',
        month: 'long',
      }).format(startsAt),
      startTime,
      time: `${startTime}–${timeFormatter.format(endsAt)}`,
    };
  } catch {
    const startTime = startsAt.toLocaleTimeString('ru-RU', {
      hour: '2-digit',
      minute: '2-digit',
    });
    return {
      date: new Intl.DateTimeFormat('ru-RU', {
        weekday: 'short',
        day: 'numeric',
        month: 'long',
      }).format(startsAt),
      startTime,
      time: `${startTime}–${endsAt.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`,
    };
  }
}

function formatDateBadge(game: GameCardModel): {
  readonly day: string;
  readonly weekday: string;
} {
  const startsAt = new Date(game.startsAt);
  const options = { timeZone: game.timezone };
  try {
    return {
      day: new Intl.DateTimeFormat('ru-RU', { ...options, day: 'numeric' }).format(startsAt),
      weekday: new Intl.DateTimeFormat('ru-RU', { ...options, weekday: 'short' })
        .format(startsAt)
        .replace('.', ''),
    };
  } catch {
    return {
      day: new Intl.DateTimeFormat('ru-RU', { day: 'numeric' }).format(startsAt),
      weekday: new Intl.DateTimeFormat('ru-RU', { weekday: 'short' })
        .format(startsAt)
        .replace('.', ''),
    };
  }
}

function priceLabel(game: GameCardModel): string | undefined {
  if (!game.priceSummary) return undefined;
  return new Intl.NumberFormat('ru-RU', {
    style: 'currency',
    currency: game.priceSummary.currency,
    maximumFractionDigits: 0,
  }).format(game.priceSummary.amountMinor / 100);
}

function levelLabel(game: GameCardModel): string {
  const from = game.levelRange?.from;
  const to = game.levelRange?.to;
  if (!from && !to) return 'Любой уровень';
  if (from === to) return `Уровень ${from}`;
  return `от ${from ?? 'D'} до ${to ?? 'A'}`;
}

function resultSets(game: GameCardModel): readonly GameScoreSummarySet[] {
  if (!('resultSummary' in game)) return [];
  return game.resultSummary?.sets ?? [];
}

export interface GameCardProps {
  readonly game: GameCardModel;
  readonly busy?: boolean;
  readonly compact?: boolean;
  readonly compactActionVariant?: 'default' | 'mini-create';
  readonly compactMetadataVariant?: 'default' | 'station-time';
  readonly footerSupplement?: React.ReactNode;
  readonly showCompactMetadata?: boolean;
  readonly showCompactLevel?: boolean;
  readonly onAction?: (action: GameCardAction, game: GameCardModel) => void;
  readonly onParticipantProfileRequest?: (
    game: GameCardModel,
    participant: GameCardModel['participants'][number],
    participantIndex: number,
  ) => void;
  readonly unsupportedActionBehavior?: 'DETAILS' | 'DISABLED';
}

export function GameCard({
  game,
  busy = false,
  compact = false,
  compactActionVariant = 'default',
  compactMetadataVariant = 'default',
  footerSupplement,
  showCompactMetadata = false,
  showCompactLevel = false,
  onAction,
  onParticipantProfileRequest,
  unsupportedActionBehavior = 'DETAILS',
}: GameCardProps) {
  const schedule = formatDate(game);
  const dateBadge = formatDateBadge(game);
  const usesStationTimeMetadata =
    compact && showCompactMetadata && compactMetadataVariant === 'station-time';
  const action =
    compact && compactActionVariant === 'default'
      ? gameHistoryPrimaryAction(game)
      : gamePrimaryAction(game);
  const usesMiniCreateAction =
    compact &&
    compactActionVariant === 'mini-create' &&
    (action === 'JOIN' || action === 'JOIN_WAITLIST');
  const openSlots = Math.max(0, Math.min(game.capacity.open, game.capacity.total));
  const visibleParticipants = game.participants.slice(0, game.capacity.total);
  const sets = resultSets(game);
  const scoreParticipants = visibleParticipants.filter(
    (
      participant,
    ): participant is typeof participant & {
      readonly userId: string;
    } => 'userId' in participant && typeof participant.userId === 'string',
  );
  const participantIds = new Set(scoreParticipants.map((participant) => participant.userId));
  const hasStructuredResult =
    compact &&
    sets.some(
      (set) =>
        set.teamAUserIds?.length === 2 &&
        set.teamBUserIds?.length === 2 &&
        [...set.teamAUserIds, ...set.teamBUserIds].every((userId) => participantIds.has(userId)),
    );
  const hasConfirmedResult =
    compact && 'resultSummary' in game && game.resultSummary?.state === 'CONFIRMED';
  const showFooterParticipants = !hasStructuredResult;
  const showFooterActions = !hasConfirmedResult;
  const showFooter = showFooterParticipants || showFooterActions;
  const detailsUrl = `/games/${encodeURIComponent(game.id)}`;

  return (
    <article
      className={`game-card game-card--${game.displayState.toLowerCase()}${compact ? ' is-compact' : ''}`}
      data-display-state={game.displayState}
    >
      <div className="game-card__header">
        <div className="game-card__heading">
          {game.kind === 'RATING' || game.kind === 'FRIENDLY' ? (
            <GameTypeBadge type={game.kind === 'RATING' ? 'rating' : 'friendly'} />
          ) : (
            <span className={`game-kind game-kind--${game.kind.toLowerCase()}`}>
              ● {gameKindLabel(game.kind)}
            </span>
          )}
          <a className={compact ? 'activity-card-title' : undefined} href={detailsUrl}>
            {game.title}
          </a>
          {compact && !showCompactMetadata ? (
            <span className="game-card__history-meta">
              {game.station.name} · {schedule.startTime}
            </span>
          ) : null}
        </div>
        {compact ? (
          <time
            className="game-card__date-badge"
            dateTime={game.startsAt}
            aria-label={`Дата игры: ${schedule.date}`}
          >
            <strong>{dateBadge.day}</strong>
            <span>{dateBadge.weekday}</span>
          </time>
        ) : priceLabel(game) ? (
          <strong className="game-card__price">{priceLabel(game)}</strong>
        ) : null}
      </div>

      {compact && showCompactLevel && !showCompactMetadata ? (
        <span className="game-card__compact-level">
          <EventLevelIcon />
          {levelLabel(game)}
        </span>
      ) : null}

      {compact && !showCompactMetadata ? null : (
        <div className="game-card__meta">
          {!usesStationTimeMetadata ? (
            <span
              className="game-card__date activity-card-metadata-row"
              aria-label={`${schedule.date}, ${schedule.time}`}
            >
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
                {game.station.name}
                {!usesStationTimeMetadata && game.court?.name ? ` · ${game.court.name}` : ''}
              </strong>
              {!usesStationTimeMetadata && game.station.shortAddress ? (
                <span>{game.station.shortAddress}</span>
              ) : null}
            </span>
          </span>
          {usesStationTimeMetadata ? (
            <span className="game-card__time activity-card-metadata-row">
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
            <strong>{levelLabel(game)}</strong>
          </span>
        </div>
      )}

      {hasStructuredResult ? (
        <GameScoreSummary participants={scoreParticipants} sets={sets} />
      ) : sets.length > 0 ? (
        <div className="game-score" aria-label="Счёт по сетам">
          {sets.map((set, index) => (
            <span key={`${set.teamA}-${set.teamB}-${index}`}>
              {set.teamA}:{set.teamB}
            </span>
          ))}
        </div>
      ) : null}

      {showFooter ? (
        <div className={`game-card__footer${hasStructuredResult ? ' has-structured-result' : ''}`}>
          {footerSupplement ? (
            <div className="game-card__footer-supplement">{footerSupplement}</div>
          ) : null}
          {showFooterParticipants ? (
            sets.length === 0 ? (
              <ParticipantAvatarStack
                ariaLabel="Участники игры"
                capacity={game.capacity.total}
                showLevelRing={!(compact && compactActionVariant === 'mini-create')}
                participants={visibleParticipants.map((participant, index) => ({
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
                }))}
                {...(onParticipantProfileRequest &&
                visibleParticipants.some(
                  (participant) =>
                    !('userId' in participant) || typeof participant.userId !== 'string',
                )
                  ? {
                      onParticipantClick: (_participant, participantIndex) => {
                        const participant = visibleParticipants[participantIndex];
                        if (participant) {
                          onParticipantProfileRequest(game, participant, participantIndex);
                        }
                      },
                      participantActionLabel: 'Открыть профиль',
                    }
                  : {})}
              />
            ) : (
              <div className="game-participants" aria-label="Участники игры">
                {visibleParticipants.map((participant, index) => {
                  const content = (
                    <>
                      {participant.avatarUrl ? (
                        <img src={participant.avatarUrl} alt="" />
                      ) : (
                        <img
                          src={avatarBackgroundUrl(
                            'userId' in participant && typeof participant.userId === 'string'
                              ? participant.userId
                              : `${participant.displayName}-${index}`,
                          )}
                          alt=""
                          aria-hidden="true"
                          data-avatar-background=""
                        />
                      )}
                      {!participant.avatarUrl ? (
                        <span
                          className="game-player__initials"
                          aria-hidden="true"
                          data-avatar-initials=""
                        >
                          {playerInitials(participant.displayName)}
                        </span>
                      ) : null}
                      {participant.level ? <small>{participant.level}</small> : null}
                    </>
                  );
                  const className = 'game-player';
                  const title = `${participant.displayName}${participant.level ? ` · ${participant.level}` : ''}`;
                  return 'userId' in participant && typeof participant.userId === 'string' ? (
                    <a
                      className={className}
                      href={`/profile/${encodeURIComponent(participant.userId)}`}
                      key={participant.userId}
                      title={title}
                      aria-label={title}
                    >
                      {content}
                    </a>
                  ) : (
                    <span
                      className="game-player"
                      key={`${participant.displayName}-${index}`}
                      title={title}
                    >
                      {content}
                    </span>
                  );
                })}
                {Array.from({ length: openSlots }, (_, index) => (
                  <span
                    className="game-player is-open"
                    key={`open-${index}`}
                    aria-label="Свободное место"
                  >
                    +
                  </span>
                ))}
              </div>
            )
          ) : null}

          {showFooterActions ? (
            <div
              className={`game-card__actions${
                usesMiniCreateAction ? ' game-card__actions--mini-create' : ''
              }`}
            >
              {!action ? (
                <span className={`game-state game-state--${game.displayState.toLowerCase()}`}>
                  {compact ? gameHistoryStateLabel(game) : gameStateLabel(game.displayState)}
                </span>
              ) : null}
              {action && actionLabels[action] ? (
                onAction && commandActions.has(action) ? (
                  <button type="button" disabled={busy} onClick={() => onAction(action, game)}>
                    {busy ? 'Обновляем…' : actionLabels[action]}
                  </button>
                ) : unsupportedActionBehavior === 'DISABLED' ? (
                  <button
                    type="button"
                    disabled
                    title="Для этого действия нужен отдельный серверный сценарий"
                  >
                    {actionLabels[action]}
                  </button>
                ) : (
                  <a
                    className={`game-card__button${
                      usesMiniCreateAction
                        ? ' game-card__button--mini-create game-card__button--static'
                        : ''
                    }`}
                    href={detailsUrl}
                    aria-label={usesMiniCreateAction ? actionLabels[action] : undefined}
                  >
                    {usesMiniCreateAction ? <CreateGameButtonIcon /> : actionLabels[action]}
                  </a>
                )
              ) : !compact ? (
                <a className="game-card__details" href={detailsUrl}>
                  Подробнее
                </a>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}
