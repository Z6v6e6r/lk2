import { useState } from 'react';

import { GameResultEditor } from './GameResultEditor.js';
import { GameScoreSummary } from './GameScoreSummary.js';
import { EventGameTypeIcon } from './GameTypeBadge.js';
import { EventCalendarIcon, EventLocationIcon } from './ActivityCardIcons.js';
import { ChatIcon } from './HomeDashboardPage.js';
import { ParticipantAvatarStack } from './ParticipantAvatarStack.js';
import { avatarBackgroundUrl, playerInitials } from './avatar-backgrounds.js';
import type { GameCard, SubmitGameResultRequest } from './auth-gateway.js';
import { gamePrimaryAction, gameStateLabel, type GameCardAction } from './game-card-policy.js';

export type GameDetailTab = 'GAME' | 'RESULT';

const ACTION_LABELS: Partial<Record<GameCardAction, string>> = {
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

const RESULT_ACTIONS = new Set<GameCardAction>([
  'SUBMIT_RESULT',
  'CONFIRM_RESULT',
  'DISPUTE_RESULT',
  'VIEW_RESULT',
  'OPEN_DISPUTE',
]);

const LINEUP_STORAGE_KEY = 'phub.games.startingLineups.v1';

type GameLineup = readonly (readonly string[])[];
type LineupByGame = Readonly<Record<string, GameLineup>>;

interface LineupPosition {
  readonly pairIndex: number;
  readonly participantIndex: number;
}

interface LineupPickerState {
  readonly pairIndex: number;
  readonly participantId?: string;
}

function loadStoredLineups(): LineupByGame {
  if (typeof window === 'undefined') return {};
  try {
    const stored = window.localStorage.getItem(LINEUP_STORAGE_KEY);
    if (!stored) return {};
    const parsed: unknown = JSON.parse(stored);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).flatMap(([gameId, lineup]) => {
        if (!Array.isArray(lineup)) return [];
        return [
          [
            gameId,
            lineup.map((pair) =>
              Array.isArray(pair)
                ? pair.filter((userId): userId is string => typeof userId === 'string')
                : [],
            ),
          ],
        ];
      }),
    );
  } catch {
    return {};
  }
}

function storeLineups(lineups: LineupByGame): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(LINEUP_STORAGE_KEY, JSON.stringify(lineups));
  } catch {
    // The lineup remains usable in memory if browser storage is unavailable.
  }
}

function normalizeLineup(game: GameCard, lineup: GameLineup | undefined): GameLineup {
  const pairCount = Math.max(1, Math.ceil(game.capacity.total / 2));
  const participantIds = new Set(game.participants.map((participant) => participant.userId));
  const assignedIds = new Set<string>();
  return Array.from({ length: pairCount }, (_, pairIndex) => {
    const pair = lineup?.[pairIndex] ?? [];
    const normalizedPair: string[] = [];
    for (const userId of pair) {
      if (!participantIds.has(userId) || assignedIds.has(userId)) continue;
      normalizedPair.push(userId);
      assignedIds.add(userId);
      if (normalizedPair.length === 2) break;
    }
    return normalizedPair;
  });
}

function findLineupPosition(lineup: GameLineup, userId: string): LineupPosition | null {
  for (const [pairIndex, pair] of lineup.entries()) {
    const participantIndex = pair.indexOf(userId);
    if (participantIndex >= 0) return { pairIndex, participantIndex };
  }
  return null;
}

function schedule(game: GameCard): {
  readonly date: string;
  readonly time: string;
} {
  const startsAt = new Date(game.startsAt);
  const endsAt = new Date(game.endsAt);
  const timeZone = game.timezone;
  const format = (options: Intl.DateTimeFormatOptions, value = startsAt) =>
    new Intl.DateTimeFormat('ru-RU', { ...options, timeZone }).format(value);
  const weekdayValue = format({ weekday: 'short' });
  const weekday = weekdayValue.endsWith('.') ? weekdayValue : `${weekdayValue}.`;
  return {
    date: `${format({ day: 'numeric', month: 'long' })}, ${weekday}`,
    time: `с ${format({ hour: '2-digit', minute: '2-digit' })} до ${format(
      { hour: '2-digit', minute: '2-digit' },
      endsAt,
    )}`,
  };
}

function gameKindLabel(kind: GameCard['kind']): string {
  switch (kind) {
    case 'RATING':
      return 'Игра на рейтинг';
    case 'PRIVATE':
      return 'Закрытая игра';
    case 'COACH_GAME':
      return 'Игра с тренером';
    default:
      return 'Френдли игра';
  }
}

function priceLabel(game: GameCard): string | null {
  if (!game.priceSummary) return null;
  return new Intl.NumberFormat('ru-RU', {
    style: 'currency',
    currency: game.priceSummary.currency,
    maximumFractionDigits: 0,
  }).format(game.priceSummary.amountMinor / 100);
}

function participantName(game: GameCard, userId: string): string {
  return (
    game.participants.find((participant) => participant.userId === userId)?.displayName ?? 'Игрок'
  );
}

function participantShortName(game: GameCard, userId: string): string {
  const displayName = participantName(game, userId);
  return displayName.trim().split(/\s+/u)[0] ?? displayName;
}

function participantLevelValue(participant: GameCard['participants'][number]): number | null {
  if (!('levelValue' in participant)) return null;
  return typeof participant.levelValue === 'number' ? participant.levelValue : null;
}

function scoreStateLabel(game: GameCard): string {
  switch (game.resultSummary?.state) {
    case 'PENDING_CONFIRMATION':
      return 'На согласовании';
    case 'CONFIRMED':
      return 'Согласован';
    case 'DISPUTED':
      return 'Оспорен';
    case 'VOID':
      return 'Аннулирован';
    default:
      return 'Не внесён';
  }
}

function resultSubmissionTimestamp(game: GameCard): string | null {
  const submittedAt = game.resultSummary?.submittedAt;
  if (!submittedAt || !Number.isFinite(Date.parse(submittedAt))) return null;
  return new Intl.DateTimeFormat('ru-RU', {
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: game.timezone,
  })
    .format(new Date(submittedAt))
    .replace(',', ' в');
}

function ResultSetTeam(props: {
  readonly game: GameCard;
  readonly mirrored?: boolean;
  readonly score: number;
  readonly userIds: readonly string[];
  readonly won: boolean;
}): React.JSX.Element {
  const { game, mirrored = false, score, userIds, won } = props;
  const participants = userIds
    .map((userId) => game.participants.find((participant) => participant.userId === userId))
    .filter(
      (participant): participant is GameCard['participants'][number] => participant !== undefined,
    );
  const avatars = (
    <span className="game-detail-result__set-avatars" aria-hidden="true">
      {participants.map((participant) =>
        participant.avatarUrl ? (
          <img key={participant.userId} src={participant.avatarUrl} alt="" loading="lazy" />
        ) : (
          <span
            key={participant.userId}
            style={{ backgroundImage: `url("${avatarBackgroundUrl(participant.userId)}")` }}
            data-avatar-background=""
            data-avatar-initials=""
          >
            {playerInitials(participant.displayName)}
          </span>
        ),
      )}
    </span>
  );
  const names = (
    <span className="game-detail-result__set-names">
      {userIds.map((userId) => (
        <span key={userId}>{participantShortName(game, userId)}</span>
      ))}
    </span>
  );

  return (
    <div
      className={`game-detail-result__set-team${mirrored ? ' is-mirrored' : ''}${won ? ' is-winning' : ''}`}
      aria-label={`${userIds.map((userId) => participantName(game, userId)).join(', ')}: ${score}`}
    >
      {mirrored ? (
        <>
          <strong>{score}</strong>
          {names}
          {avatars}
        </>
      ) : (
        <>
          {avatars}
          {names}
          <strong>{score}</strong>
        </>
      )}
    </div>
  );
}

function GameSummary({ game }: { readonly game: GameCard }): React.JSX.Element {
  const gameSchedule = schedule(game);
  const gameType = game.kind === 'RATING' ? 'rating' : 'friendly';
  const price = priceLabel(game);
  return (
    <section className="game-match-summary" aria-label="Основная информация об игре">
      <span className={`fh-event__tag is-${gameType} game-match-summary__tag`}>
        <EventGameTypeIcon type={gameType} />
        <span className="fh-event__tag-label">{gameKindLabel(game.kind)}</span>
      </span>
      <h2 className="activity-card-title">{game.title}</h2>
      <div className="game-match-summary__metadata">
        <span className="activity-card-metadata-row">
          <EventCalendarIcon />
          <time dateTime={game.startsAt}>
            {gameSchedule.date}, {gameSchedule.time}
          </time>
        </span>
        <span className="activity-card-metadata-row">
          <EventLocationIcon />
          <span>
            {game.station.name}
            {game.court?.name ? ` · ${game.court.name}` : ''}
          </span>
        </span>
        {price ? (
          <span className="activity-card-metadata-row" aria-label={`Стоимость места: ${price}`}>
            <span aria-hidden="true">₽</span>
            <span>
              <strong>Стоимость места:</strong> {price}
            </span>
          </span>
        ) : null}
      </div>
      <span className="game-match-summary__divider" aria-hidden="true" />
    </section>
  );
}

function GameTab(props: {
  readonly busy: boolean;
  readonly game: GameCard;
  readonly lineupUserIdsByPair: readonly (readonly string[])[];
  readonly onAction: (action: GameCardAction) => void;
  readonly onChatOpen: () => void;
  readonly onAssignParticipant: (pairIndex: number, userId: string) => void;
  readonly onRemoveParticipant: (userId: string) => void;
  readonly onReplaceParticipant: (currentUserId: string, nextUserId: string) => void;
  readonly onResultOpen: () => void;
}): React.JSX.Element {
  const {
    busy,
    game,
    lineupUserIdsByPair,
    onAction,
    onChatOpen,
    onAssignParticipant,
    onRemoveParticipant,
    onReplaceParticipant,
    onResultOpen,
  } = props;
  const [lineupPicker, setLineupPicker] = useState<LineupPickerState | null>(null);
  const primaryAction = gamePrimaryAction(game);
  const primaryLabel =
    primaryAction && RESULT_ACTIONS.has(primaryAction) && primaryAction !== 'SUBMIT_RESULT'
      ? 'Посмотреть результат'
      : primaryAction
        ? ACTION_LABELS[primaryAction]
        : undefined;
  const pairCount = Math.max(1, Math.ceil(game.capacity.total / 2));
  const participantById = new Map(
    game.participants.map((participant) => [participant.userId, participant]),
  );
  const assignedUserIds = new Set(lineupUserIdsByPair.flat());
  const availableParticipants = game.participants.filter(
    (participant) => !assignedUserIds.has(participant.userId),
  );
  const selectedParticipant = lineupPicker?.participantId
    ? participantById.get(lineupPicker.participantId)
    : undefined;
  const pickerParticipants = selectedParticipant
    ? game.participants.filter((participant) => participant.userId !== selectedParticipant.userId)
    : availableParticipants;
  const activePairLabel =
    lineupPicker === null ? null : `Пара ${String.fromCharCode(65 + lineupPicker.pairIndex)}`;

  return (
    <div className="game-detail-panel" role="tabpanel" id="game-detail-panel-game">
      <section
        className="game-detail-card game-detail-players"
        aria-labelledby="game-players-title"
      >
        <header>
          <h2 id="game-players-title">Участники игры</h2>
          <span>
            {game.capacity.occupied}/{game.capacity.total}
          </span>
        </header>
        <div className="game-detail-players__list">
          {game.participants.map((participant) => (
            <a href={`/profile/${encodeURIComponent(participant.userId)}`} key={participant.userId}>
              <ParticipantAvatarStack
                ariaLabel={`${participant.displayName}${participant.level ? ` · ${participant.level}` : ''}`}
                capacity={1}
                participants={[
                  {
                    key: participant.userId,
                    displayName: participant.displayName,
                    avatarUrl: participant.avatarUrl,
                    level: participant.level,
                    levelValue: participantLevelValue(participant),
                  },
                ]}
              />
              <span className="game-detail-player__name">
                <strong>{participant.displayName}</strong>
              </span>
              {participant.role === 'ORGANIZER' ? (
                <span className="game-detail-player__role">Организатор</span>
              ) : null}
            </a>
          ))}
          {Array.from({ length: game.capacity.open }, (_, index) => (
            <div className="game-detail-player is-open" key={`open-player-${index}`}>
              <ParticipantAvatarStack ariaLabel="Свободное место" capacity={1} participants={[]} />
              <span className="game-detail-player__name">
                <strong>Свободное место</strong>
                <small>Можно присоединиться</small>
              </span>
            </div>
          ))}
        </div>
      </section>

      <section className="game-detail-card game-detail-format" aria-labelledby="game-format-title">
        <header>
          <h2 id="game-format-title">Стартовый состав</h2>
        </header>
        <div className="game-detail-format__pairs">
          {Array.from({ length: pairCount }, (_, index) => {
            const pairParticipants = (lineupUserIdsByPair[index] ?? [])
              .map((userId) => participantById.get(userId))
              .filter((participant): participant is GameCard['participants'][number] =>
                Boolean(participant),
              );
            return (
              <div key={`pair-${index}`}>
                <ParticipantAvatarStack
                  ariaLabel={`Слоты пары ${index + 1}`}
                  capacity={2}
                  participants={pairParticipants.map((participant) => ({
                    key: participant.userId,
                    displayName: participant.displayName,
                    avatarUrl: participant.avatarUrl,
                    level: participant.level,
                    levelValue: participantLevelValue(participant),
                  }))}
                  onParticipantClick={(participant) =>
                    setLineupPicker({ pairIndex: index, participantId: participant.key })
                  }
                  {...(availableParticipants.length > 0
                    ? { onOpenSlotClick: () => setLineupPicker({ pairIndex: index }) }
                    : {})}
                />
                <strong>Пара {String.fromCharCode(65 + index)}</strong>
              </div>
            );
          })}
        </div>
        {lineupPicker && activePairLabel ? (
          <div
            className="game-detail-lineup-picker"
            role="dialog"
            aria-labelledby="game-detail-lineup-picker-title"
          >
            <header>
              <strong id="game-detail-lineup-picker-title">
                {selectedParticipant ? 'Управление участником' : 'Выберите участника'} ·{' '}
                {activePairLabel}
              </strong>
              <button
                type="button"
                aria-label="Закрыть выбор участника"
                onClick={() => setLineupPicker(null)}
              >
                ×
              </button>
            </header>
            {selectedParticipant ? (
              <button
                className="game-detail-lineup-picker__remove"
                type="button"
                onClick={() => {
                  onRemoveParticipant(selectedParticipant.userId);
                  setLineupPicker(null);
                }}
              >
                Убрать {selectedParticipant.displayName} из состава
              </button>
            ) : null}
            <div className="game-detail-lineup-picker__list">
              {pickerParticipants.map((participant) => {
                const assignedPosition = findLineupPosition(
                  lineupUserIdsByPair,
                  participant.userId,
                );
                const actionLabel = selectedParticipant
                  ? assignedPosition
                    ? `Поменять местами с ${participant.displayName}`
                    : `Заменить на ${participant.displayName}`
                  : `Выбрать ${participant.displayName}`;
                return (
                  <button
                    type="button"
                    key={participant.userId}
                    aria-label={actionLabel}
                    onClick={() => {
                      if (selectedParticipant) {
                        onReplaceParticipant(selectedParticipant.userId, participant.userId);
                      } else {
                        onAssignParticipant(lineupPicker.pairIndex, participant.userId);
                      }
                      setLineupPicker(null);
                    }}
                  >
                    <ParticipantAvatarStack
                      ariaLabel={participant.displayName}
                      capacity={1}
                      participants={[
                        {
                          key: participant.userId,
                          displayName: participant.displayName,
                          avatarUrl: participant.avatarUrl,
                          level: participant.level,
                          levelValue: participantLevelValue(participant),
                        },
                      ]}
                    />
                    <span>
                      <strong>{participant.displayName}</strong>
                      <small>
                        {selectedParticipant
                          ? assignedPosition
                            ? `Поменять местами · Пара ${String.fromCharCode(65 + assignedPosition.pairIndex)}`
                            : 'Заменить выбранного игрока'
                          : participant.level
                            ? `Уровень: ${participant.level}`
                            : 'Уровень не указан'}
                      </small>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        ) : null}
      </section>

      <div className="game-detail-actions">
        {primaryAction && primaryLabel ? (
          <button
            className="game-detail-primary"
            type="button"
            disabled={busy || ['PAY', 'RETRY_PAYMENT'].includes(primaryAction)}
            onClick={() =>
              RESULT_ACTIONS.has(primaryAction) ? onResultOpen() : onAction(primaryAction)
            }
          >
            {busy ? 'Обновляем…' : primaryLabel}
          </button>
        ) : (
          <p className="game-detail-state">{gameStateLabel(game.displayState)}</p>
        )}

        {game.conversation && game.allowedActions.includes('OPEN_CHAT') ? (
          <a
            className="game-detail-chat"
            href={`/chats/${game.conversation.conversationId}`}
            aria-label="Чат игры"
          >
            <ChatIcon />
            {game.conversation.unreadCount ? <span>{game.conversation.unreadCount}</span> : null}
          </a>
        ) : game.viewerRelation === 'ORGANIZER' || game.viewerRelation === 'PARTICIPANT' ? (
          <button
            className="game-detail-chat"
            type="button"
            disabled={busy}
            aria-label={busy ? 'Открываем чат игры…' : 'Открыть чат игры'}
            onClick={onChatOpen}
          >
            <ChatIcon />
          </button>
        ) : null}
      </div>
    </div>
  );
}

function ResultTab(props: {
  readonly busy: boolean;
  readonly game: GameCard;
  readonly initialPairings: readonly (readonly string[])[];
  readonly onAction: (action: GameCardAction) => void;
  readonly onSubmit: (input: SubmitGameResultRequest) => Promise<void>;
}): React.JSX.Element {
  const { busy, game, initialPairings, onAction, onSubmit } = props;
  const canSubmit = game.allowedActions.includes('SUBMIT_RESULT');
  const sets = game.resultSummary?.sets ?? [];
  const submitter = game.participants.find(
    (participant) => participant.userId === game.resultSummary?.submittedByUserId,
  );
  const submittedAt = resultSubmissionTimestamp(game);

  if (canSubmit) {
    return (
      <div className="game-detail-panel" role="tabpanel" id="game-detail-panel-result">
        <GameResultEditor
          game={game}
          busy={busy}
          embedded
          initialPairings={initialPairings}
          onSubmit={onSubmit}
        />
      </div>
    );
  }

  return (
    <div className="game-detail-panel" role="tabpanel" id="game-detail-panel-result">
      <section className="game-detail-card game-detail-result" aria-label="Результат матча">
        <GameScoreSummary participants={game.participants} sets={sets} />

        <span className="fh-event__tag game-detail-result__status">{scoreStateLabel(game)}</span>

        {sets.length > 0 ? (
          <div className="game-detail-result__sets">
            {sets.map((set, index) => (
              <article key={set.setNumber ?? index}>
                <div className="game-detail-result__set-heading">
                  <span>Сет {set.setNumber ?? index + 1}</span>
                </div>
                {set.teamAUserIds && set.teamBUserIds ? (
                  <div className="game-detail-result__teams">
                    <ResultSetTeam
                      game={game}
                      score={set.teamA}
                      userIds={set.teamAUserIds}
                      won={set.teamA > set.teamB}
                    />
                    <span className="game-detail-result__set-score-divider" aria-hidden="true">
                      :
                    </span>
                    <ResultSetTeam
                      game={game}
                      mirrored
                      score={set.teamB}
                      userIds={set.teamBUserIds}
                      won={set.teamB > set.teamA}
                    />
                  </div>
                ) : null}
              </article>
            ))}
          </div>
        ) : (
          <div className="game-detail-result__empty">
            <strong>Результат ещё не внесён</strong>
            <p>После игры участник укажет пары и счёт каждого сета.</p>
          </div>
        )}

        {game.resultSummary?.state === 'PENDING_CONFIRMATION' ? (
          <p className="game-detail-result__notice">
            {submitter && submittedAt && game.resultSummary?.submittedAt ? (
              <>
                Отправитель результата: <strong>{submitter.displayName}</strong> ·{' '}
                <time dateTime={game.resultSummary.submittedAt}>{submittedAt}</time>
              </>
            ) : (
              'Результат сохранён и ждёт согласования другого участника.'
            )}
          </p>
        ) : null}
      </section>

      {game.allowedActions.includes('CONFIRM_RESULT') ? (
        <button
          className="game-detail-primary"
          type="button"
          disabled={busy}
          onClick={() => onAction('CONFIRM_RESULT')}
        >
          {busy ? 'Согласовываем…' : 'Подтвердить результат'}
        </button>
      ) : null}
      {game.allowedActions.includes('DISPUTE_RESULT') ? (
        <button
          className="game-detail-secondary"
          type="button"
          disabled={busy}
          onClick={() => onAction('DISPUTE_RESULT')}
        >
          Оспорить результат
        </button>
      ) : null}
    </div>
  );
}

export function GameDetailView(props: {
  readonly activeTab: GameDetailTab;
  readonly busy: boolean;
  readonly game: GameCard;
  readonly onAction: (action: GameCardAction) => void;
  readonly onChatOpen: () => void;
  readonly onSubmit: (input: SubmitGameResultRequest) => Promise<void>;
  readonly onTabChange: (tab: GameDetailTab) => void;
}): React.JSX.Element {
  const { activeTab, busy, game, onAction, onChatOpen, onSubmit, onTabChange } = props;
  const [lineupByGame, setLineupByGame] = useState<LineupByGame>(loadStoredLineups);
  const lineupUserIdsByPair = normalizeLineup(game, lineupByGame[game.id]);

  function updateLineup(update: (currentLineup: GameLineup) => GameLineup): void {
    setLineupByGame((currentByGame) => {
      const currentLineup = normalizeLineup(game, currentByGame[game.id]);
      const nextByGame = { ...currentByGame, [game.id]: update(currentLineup) };
      storeLineups(nextByGame);
      return nextByGame;
    });
  }

  function assignParticipant(pairIndex: number, userId: string): void {
    updateLineup((currentLineup) => {
      if (currentLineup.flat().includes(userId)) return currentLineup;
      const currentPair = currentLineup[pairIndex] ?? [];
      if (currentPair.length >= 2) return currentLineup;
      return currentLineup.map((pair, index) => (index === pairIndex ? [...pair, userId] : pair));
    });
  }

  function removeParticipant(userId: string): void {
    updateLineup((currentLineup) =>
      currentLineup.map((pair) => pair.filter((participantId) => participantId !== userId)),
    );
  }

  function replaceParticipant(currentUserId: string, nextUserId: string): void {
    updateLineup((currentLineup) => {
      const currentPosition = findLineupPosition(currentLineup, currentUserId);
      if (!currentPosition || currentUserId === nextUserId) return currentLineup;
      const nextPosition = findLineupPosition(currentLineup, nextUserId);
      return currentLineup.map((pair, pairIndex) =>
        pair.map((userId, participantIndex) => {
          if (
            pairIndex === currentPosition.pairIndex &&
            participantIndex === currentPosition.participantIndex
          ) {
            return nextUserId;
          }
          if (
            nextPosition &&
            pairIndex === nextPosition.pairIndex &&
            participantIndex === nextPosition.participantIndex
          ) {
            return currentUserId;
          }
          return userId;
        }),
      );
    });
  }

  return (
    <section className="game-detail" aria-label="Карточка игры">
      <GameSummary game={game} />
      <div className="game-detail-tab-section">
        <div className="game-detail-tabs" role="tablist" aria-label="Разделы матча">
          <button
            className={activeTab === 'GAME' ? 'is-active' : undefined}
            type="button"
            role="tab"
            aria-controls="game-detail-panel-game"
            aria-selected={activeTab === 'GAME'}
            onClick={() => onTabChange('GAME')}
          >
            Игра
          </button>
          <button
            className={activeTab === 'RESULT' ? 'is-active' : undefined}
            type="button"
            role="tab"
            aria-controls="game-detail-panel-result"
            aria-selected={activeTab === 'RESULT'}
            onClick={() => onTabChange('RESULT')}
          >
            Результат
          </button>
        </div>

        {activeTab === 'GAME' ? (
          <GameTab
            busy={busy}
            game={game}
            lineupUserIdsByPair={lineupUserIdsByPair}
            onAction={onAction}
            onChatOpen={onChatOpen}
            onAssignParticipant={assignParticipant}
            onRemoveParticipant={removeParticipant}
            onReplaceParticipant={replaceParticipant}
            onResultOpen={() => onTabChange('RESULT')}
          />
        ) : (
          <ResultTab
            busy={busy}
            game={game}
            initialPairings={lineupUserIdsByPair}
            onAction={onAction}
            onSubmit={onSubmit}
          />
        )}
      </div>
    </section>
  );
}
