import {
  gamePrimaryAction,
  gameStateLabel,
  type GameCardAction,
  type GameCardModel,
} from './game-card-policy.js';

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

const rosterCommandActions = new Set<GameCardAction>([
  'JOIN',
  'JOIN_WAITLIST',
  'LEAVE_WAITLIST',
  'LEAVE',
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

function initials(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
}

function formatDate(game: GameCardModel): { readonly date: string; readonly time: string } {
  const startsAt = new Date(game.startsAt);
  const endsAt = new Date(game.endsAt);
  const options = { timeZone: game.timezone };
  try {
    return {
      date: new Intl.DateTimeFormat('ru-RU', {
        ...options,
        weekday: 'short',
        day: 'numeric',
        month: 'long',
      }).format(startsAt),
      time: `${new Intl.DateTimeFormat('ru-RU', {
        ...options,
        hour: '2-digit',
        minute: '2-digit',
      }).format(startsAt)}–${new Intl.DateTimeFormat('ru-RU', {
        ...options,
        hour: '2-digit',
        minute: '2-digit',
      }).format(endsAt)}`,
    };
  } catch {
    return {
      date: new Intl.DateTimeFormat('ru-RU', {
        weekday: 'short',
        day: 'numeric',
        month: 'long',
      }).format(startsAt),
      time: `${startsAt.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}–${endsAt.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`,
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

function resultSets(
  game: GameCardModel,
): readonly { readonly teamA: number; readonly teamB: number }[] {
  if (!('resultSummary' in game)) return [];
  return game.resultSummary?.sets ?? [];
}

export interface GameCardProps {
  readonly game: GameCardModel;
  readonly busy?: boolean;
  readonly compact?: boolean;
  readonly onAction?: (action: GameCardAction, game: GameCardModel) => void;
  readonly unsupportedActionBehavior?: 'DETAILS' | 'DISABLED';
}

export function GameCard({
  game,
  busy = false,
  compact = false,
  onAction,
  unsupportedActionBehavior = 'DETAILS',
}: GameCardProps) {
  const schedule = formatDate(game);
  const action = gamePrimaryAction(game);
  const openSlots = Math.max(0, Math.min(game.capacity.open, game.capacity.total));
  const visibleParticipants = game.participants.slice(0, game.capacity.total);
  const sets = resultSets(game);
  const detailsUrl = `/games/${encodeURIComponent(game.id)}`;

  return (
    <article
      className={`game-card game-card--${game.displayState.toLowerCase()}${compact ? ' is-compact' : ''}`}
      data-display-state={game.displayState}
    >
      <div className="game-card__header">
        <div className="game-card__heading">
          <span className={`game-kind game-kind--${game.kind.toLowerCase()}`}>
            {game.kind === 'RATING' ? '⚡' : '●'} {gameKindLabel(game.kind)}
          </span>
          <a href={detailsUrl}>{game.title}</a>
        </div>
        {priceLabel(game) ? <strong className="game-card__price">{priceLabel(game)}</strong> : null}
      </div>

      <div className="game-card__meta">
        <span className="game-card__date" aria-label={`${schedule.date}, ${schedule.time}`}>
          <span aria-hidden="true">◷</span>
          <strong>{schedule.date}</strong>
          <span>{schedule.time}</span>
        </span>
        <span>
          <span aria-hidden="true">⌖</span>
          <strong>{game.station.name}</strong>
          {game.station.shortAddress ? <span>{game.station.shortAddress}</span> : null}
        </span>
        <span>
          <span aria-hidden="true">◈</span>
          <strong>{levelLabel(game)}</strong>
        </span>
      </div>

      {sets.length > 0 ? (
        <div className="game-score" aria-label="Счёт по сетам">
          {sets.map((set, index) => (
            <span key={`${set.teamA}-${set.teamB}-${index}`}>
              {set.teamA}:{set.teamB}
            </span>
          ))}
        </div>
      ) : null}

      <div className="game-card__footer">
        <div className="game-participants" aria-label="Участники игры">
          {visibleParticipants.map((participant, index) => (
            <span
              className="game-player"
              key={`${participant.displayName}-${index}`}
              title={`${participant.displayName}${participant.level ? ` · ${participant.level}` : ''}`}
            >
              {participant.avatarUrl ? (
                <img src={participant.avatarUrl} alt="" />
              ) : (
                <span aria-hidden="true">{initials(participant.displayName)}</span>
              )}
              {participant.level ? <small>{participant.level}</small> : null}
            </span>
          ))}
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

        <div className="game-card__actions">
          <span className={`game-state game-state--${game.displayState.toLowerCase()}`}>
            {gameStateLabel(game.displayState)}
          </span>
          {action && actionLabels[action] ? (
            onAction && rosterCommandActions.has(action) ? (
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
              <a className="game-card__button" href={detailsUrl}>
                {actionLabels[action]}
              </a>
            )
          ) : (
            <a className="game-card__details" href={detailsUrl}>
              Подробнее
            </a>
          )}
        </div>
      </div>
    </article>
  );
}
