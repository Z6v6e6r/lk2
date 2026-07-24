import { useMemo, useState } from 'react';

import { GameScoreSummary } from './GameScoreSummary.js';
import { ParticipantAvatarStack } from './ParticipantAvatarStack.js';
import type { GameCard, SubmitGameResultRequest } from './auth-gateway.js';

type SetPairings = readonly (readonly string[])[];

interface EditableSet {
  readonly id: string;
  readonly pairings: SetPairings;
  readonly teamAScore: number;
  readonly teamBScore: number;
}

interface PairingPosition {
  readonly pairIndex: number;
  readonly participantIndex: number;
}

interface PairingPickerState {
  readonly setId: string;
  readonly pairIndex: number;
  readonly participantId?: string;
}

function participantLevelValue(participant: GameCard['participants'][number]): number | null {
  if (!('levelValue' in participant)) return null;
  return typeof participant.levelValue === 'number' ? participant.levelValue : null;
}

function normalizePairings(game: GameCard, pairings: SetPairings | undefined): SetPairings {
  const participantIds = new Set(game.participants.slice(0, 4).map((player) => player.userId));
  const assigned = new Set<string>();
  return Array.from({ length: 2 }, (_, pairIndex) => {
    const pair: string[] = [];
    for (const userId of pairings?.[pairIndex] ?? []) {
      if (!participantIds.has(userId) || assigned.has(userId)) continue;
      pair.push(userId);
      assigned.add(userId);
      if (pair.length === 2) break;
    }
    return pair;
  });
}

function defaultPairings(game: GameCard): SetPairings {
  const playerIds = game.participants.slice(0, 4).map((player) => player.userId);
  return [playerIds.slice(0, 2), playerIds.slice(2, 4)];
}

function newSet(game: GameCard, index: number, pairings?: SetPairings): EditableSet {
  const hasProvidedPairings = (pairings?.flat().length ?? 0) > 0;
  return {
    id: `${Date.now()}-${index}`,
    pairings: normalizePairings(game, hasProvidedPairings ? pairings : defaultPairings(game)),
    teamAScore: 6,
    teamBScore: 0,
  };
}

function findPairingPosition(pairings: SetPairings, userId: string): PairingPosition | null {
  for (const [pairIndex, pair] of pairings.entries()) {
    const participantIndex = pair.indexOf(userId);
    if (participantIndex >= 0) return { pairIndex, participantIndex };
  }
  return null;
}

export function GameResultEditor(props: {
  readonly game: GameCard;
  readonly busy: boolean;
  readonly embedded?: boolean;
  readonly initialPairings?: SetPairings;
  readonly onCancel?: () => void;
  readonly onSubmit: (input: SubmitGameResultRequest) => Promise<void>;
}): React.JSX.Element {
  const [sets, setSets] = useState<readonly EditableSet[]>([
    newSet(props.game, 0, props.initialPairings),
  ]);
  const [pairingPicker, setPairingPicker] = useState<PairingPickerState | null>(null);
  const [validation, setValidation] = useState<string | null>(null);
  const players = useMemo(() => props.game.participants.slice(0, 4), [props.game.participants]);
  const playerById = useMemo(
    () => new Map(players.map((player) => [player.userId, player])),
    [players],
  );

  function updateSet(id: string, patch: Partial<EditableSet>): void {
    setSets((current) => current.map((set) => (set.id === id ? { ...set, ...patch } : set)));
  }

  function updatePairings(
    setId: string,
    update: (currentPairings: SetPairings) => SetPairings,
  ): void {
    setSets((current) =>
      current.map((set) => (set.id === setId ? { ...set, pairings: update(set.pairings) } : set)),
    );
  }

  function assignParticipant(setId: string, pairIndex: number, userId: string): void {
    updatePairings(setId, (currentPairings) => {
      if (currentPairings.flat().includes(userId)) return currentPairings;
      const currentPair = currentPairings[pairIndex] ?? [];
      if (currentPair.length >= 2) return currentPairings;
      return currentPairings.map((pair, index) => (index === pairIndex ? [...pair, userId] : pair));
    });
  }

  function removeParticipant(setId: string, userId: string): void {
    updatePairings(setId, (currentPairings) =>
      currentPairings.map((pair) => pair.filter((participantId) => participantId !== userId)),
    );
  }

  function replaceParticipant(setId: string, currentUserId: string, nextUserId: string): void {
    updatePairings(setId, (currentPairings) => {
      const currentPosition = findPairingPosition(currentPairings, currentUserId);
      if (!currentPosition || currentUserId === nextUserId) return currentPairings;
      const nextPosition = findPairingPosition(currentPairings, nextUserId);
      return currentPairings.map((pair, pairIndex) =>
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

  async function submit(): Promise<void> {
    if (players.length !== 4) {
      setValidation('Для результата нужен подтверждённый состав из четырёх игроков.');
      return;
    }
    const payloadSets = sets.map((set, index) => ({
      setNumber: index + 1,
      teamAUserIds: [...(set.pairings[0] ?? [])],
      teamBUserIds: [...(set.pairings[1] ?? [])],
      teamA: set.teamAScore,
      teamB: set.teamBScore,
    }));
    if (
      payloadSets.some((set) => {
        const allUserIds = [...set.teamAUserIds, ...set.teamBUserIds];
        return (
          set.teamAUserIds.length !== 2 ||
          set.teamBUserIds.length !== 2 ||
          new Set(allUserIds).size !== 4 ||
          set.teamA === set.teamB
        );
      })
    ) {
      setValidation(
        'В каждой паре два разных игрока, а счёт завершённого сета не может быть равным.',
      );
      return;
    }
    setValidation(null);
    await props.onSubmit({ sets: payloadSets });
  }

  return (
    <section className="game-result-editor" aria-label="Внести результат игры">
      <GameScoreSummary
        participants={players}
        sets={sets.map((set) => ({
          teamAUserIds: set.pairings[0],
          teamBUserIds: set.pairings[1],
          teamA: set.teamAScore,
          teamB: set.teamBScore,
        }))}
      />
      <div className="game-result-editor__heading">
        <div>
          <span>Результат игры</span>
          <h2>Пары и счёт по сетам</h2>
        </div>
        {!props.embedded && props.onCancel ? (
          <button type="button" onClick={props.onCancel} disabled={props.busy} aria-label="Закрыть">
            ×
          </button>
        ) : null}
      </div>
      {sets.map((set, index) => {
        const assignedIds = new Set(set.pairings.flat());
        const availablePlayers = players.filter((player) => !assignedIds.has(player.userId));
        const activePicker = pairingPicker?.setId === set.id ? pairingPicker : null;
        const selectedPlayer = activePicker?.participantId
          ? playerById.get(activePicker.participantId)
          : undefined;
        const pickerPlayers = selectedPlayer
          ? players.filter((player) => {
              if (player.userId === selectedPlayer.userId) return false;
              const assignedPosition = findPairingPosition(set.pairings, player.userId);
              return !assignedPosition || assignedPosition.pairIndex !== activePicker?.pairIndex;
            })
          : availablePlayers;
        const activePairLabel = activePicker
          ? `Пара ${String.fromCharCode(65 + activePicker.pairIndex)}`
          : null;

        return (
          <fieldset key={set.id}>
            <legend>Сет {index + 1}</legend>
            <div className="game-detail-format game-result-editor__pairing-editor">
              <div className="game-detail-format__pairs">
                {set.pairings.map((pair, pairIndex) => {
                  const pairPlayers = pair
                    .map((userId) => playerById.get(userId))
                    .filter((player): player is GameCard['participants'][number] =>
                      Boolean(player),
                    );
                  return (
                    <div key={`${set.id}-pair-${pairIndex}`}>
                      <ParticipantAvatarStack
                        ariaLabel={`Сет ${index + 1} · Слоты пары ${pairIndex + 1}`}
                        capacity={2}
                        participants={pairPlayers.map((player) => ({
                          key: player.userId,
                          displayName: player.displayName,
                          avatarUrl: player.avatarUrl,
                          level: player.level,
                          levelValue: participantLevelValue(player),
                        }))}
                        onParticipantClick={(participant) =>
                          setPairingPicker({
                            setId: set.id,
                            pairIndex,
                            participantId: participant.key,
                          })
                        }
                        {...(availablePlayers.length > 0
                          ? {
                              onOpenSlotClick: () => setPairingPicker({ setId: set.id, pairIndex }),
                            }
                          : {})}
                      />
                      <strong>Пара {String.fromCharCode(65 + pairIndex)}</strong>
                    </div>
                  );
                })}
              </div>
              {activePicker && activePairLabel ? (
                <div
                  className="game-detail-lineup-picker"
                  role="dialog"
                  aria-labelledby={`result-pairing-picker-title-${set.id}`}
                >
                  <header>
                    <strong id={`result-pairing-picker-title-${set.id}`}>
                      {selectedPlayer ? 'Управление участником' : 'Выберите участника'} ·{' '}
                      {activePairLabel}
                    </strong>
                    <button
                      type="button"
                      aria-label="Закрыть выбор участника"
                      onClick={() => setPairingPicker(null)}
                    >
                      ×
                    </button>
                  </header>
                  {selectedPlayer ? (
                    <button
                      className="game-detail-lineup-picker__remove"
                      type="button"
                      onClick={() => {
                        removeParticipant(set.id, selectedPlayer.userId);
                        setPairingPicker(null);
                      }}
                    >
                      Убрать {selectedPlayer.displayName} из состава сета
                    </button>
                  ) : null}
                  <div className="game-detail-lineup-picker__list">
                    {pickerPlayers.map((player) => {
                      const assignedPosition = findPairingPosition(set.pairings, player.userId);
                      const actionLabel = selectedPlayer
                        ? assignedPosition
                          ? `Поменять местами с ${player.displayName}`
                          : `Заменить на ${player.displayName}`
                        : `Выбрать ${player.displayName}`;
                      return (
                        <button
                          type="button"
                          key={player.userId}
                          aria-label={actionLabel}
                          onClick={() => {
                            if (selectedPlayer) {
                              replaceParticipant(set.id, selectedPlayer.userId, player.userId);
                            } else {
                              assignParticipant(set.id, activePicker.pairIndex, player.userId);
                            }
                            setPairingPicker(null);
                          }}
                        >
                          <ParticipantAvatarStack
                            ariaLabel={player.displayName}
                            capacity={1}
                            participants={[
                              {
                                key: player.userId,
                                displayName: player.displayName,
                                avatarUrl: player.avatarUrl,
                                level: player.level,
                                levelValue: participantLevelValue(player),
                              },
                            ]}
                          />
                          <span>
                            <strong>{player.displayName}</strong>
                            <small>
                              {selectedPlayer
                                ? assignedPosition
                                  ? `Поменять местами · Пара ${String.fromCharCode(65 + assignedPosition.pairIndex)}`
                                  : 'Заменить выбранного игрока'
                                : player.level
                                  ? `Уровень: ${player.level}`
                                  : 'Уровень не указан'}
                            </small>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ) : null}
            </div>
            <div className="game-result-editor__score">
              <label>
                <input
                  aria-label="Счёт пары A"
                  type="number"
                  inputMode="numeric"
                  min="0"
                  max="99"
                  value={set.teamAScore}
                  onChange={(event) =>
                    updateSet(set.id, { teamAScore: Number(event.target.value) })
                  }
                />
              </label>
              <span>:</span>
              <label>
                <input
                  aria-label="Счёт пары B"
                  type="number"
                  inputMode="numeric"
                  min="0"
                  max="99"
                  value={set.teamBScore}
                  onChange={(event) =>
                    updateSet(set.id, { teamBScore: Number(event.target.value) })
                  }
                />
              </label>
            </div>
            {sets.length > 1 ? (
              <button
                className="game-result-editor__remove"
                type="button"
                aria-label={`Удалить сет ${index + 1}`}
                title="Удалить сет"
                onClick={() => setSets((current) => current.filter((item) => item.id !== set.id))}
              >
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path
                    d="M2.75 4.25H13.25"
                    stroke="currentColor"
                    strokeWidth="1.3"
                    strokeLinecap="round"
                  />
                  <path
                    d="M6 2.75H10"
                    stroke="currentColor"
                    strokeWidth="1.3"
                    strokeLinecap="round"
                  />
                  <path
                    d="M4.25 4.25L4.75 13.25H11.25L11.75 4.25"
                    stroke="currentColor"
                    strokeWidth="1.3"
                    strokeLinejoin="round"
                  />
                  <path
                    d="M6.5 6.5V11M9.5 6.5V11"
                    stroke="currentColor"
                    strokeWidth="1.2"
                    strokeLinecap="round"
                  />
                </svg>
              </button>
            ) : null}
          </fieldset>
        );
      })}
      {sets.length < 9 ? (
        <button
          className="game-result-editor__add"
          type="button"
          onClick={() =>
            setSets((current) => [
              ...current,
              newSet(props.game, current.length, current.at(-1)?.pairings),
            ])
          }
        >
          + Добавить сет
        </button>
      ) : null}
      {validation ? <p role="alert">{validation}</p> : null}
      <button
        className="game-result-editor__submit"
        type="button"
        disabled={props.busy}
        onClick={() => void submit()}
      >
        {props.busy ? 'Отправляем…' : 'Отправить на согласование'}
      </button>
    </section>
  );
}
