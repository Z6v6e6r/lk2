import type { GameCard } from './auth-gateway.js';
import { PlayerLevelAvatar } from './PlayerLevelAvatar.js';

export interface GameScoreSummarySet {
  readonly teamAUserIds?: readonly string[] | undefined;
  readonly teamBUserIds?: readonly string[] | undefined;
  readonly teamA: number;
  readonly teamB: number;
}

interface ScoreCell {
  readonly score: number;
  readonly won: boolean;
}

interface SummaryRow {
  readonly key: string;
  readonly participants: readonly GameCard['participants'][number][];
  readonly scores: readonly ScoreCell[];
  readonly wins: number;
  readonly gamesWon: number;
}

function pairKey(userIds: readonly string[]): string {
  return [...userIds].sort().join(':');
}

function playerShortName(displayName: string): string {
  return displayName.trim().split(/\s+/u)[0] ?? displayName;
}

function participantAccent(level: string | null | undefined): string {
  if (level?.startsWith('D')) return '#f0705f';
  if (level?.startsWith('C')) return '#f0925f';
  if (level?.startsWith('B')) return '#697ee8';
  return '#8766eb';
}

function participantLevelProgress(levelValue: number | null | undefined): number {
  if (levelValue === null || levelValue === undefined) return 0;
  const fractionalProgress = levelValue - Math.floor(levelValue);
  return Math.round(fractionalProgress * 100);
}

function scoreForPair(set: GameScoreSummarySet, key: string): ScoreCell | null {
  if (set.teamAUserIds && pairKey(set.teamAUserIds) === key) {
    return { score: set.teamA, won: set.teamA > set.teamB };
  }
  if (set.teamBUserIds && pairKey(set.teamBUserIds) === key) {
    return { score: set.teamB, won: set.teamB > set.teamA };
  }
  return null;
}

function scoreForPlayer(set: GameScoreSummarySet, userId: string): ScoreCell | null {
  if (set.teamAUserIds?.includes(userId)) {
    return { score: set.teamA, won: set.teamA > set.teamB };
  }
  if (set.teamBUserIds?.includes(userId)) {
    return { score: set.teamB, won: set.teamB > set.teamA };
  }
  return null;
}

function sideForPlayer(set: GameScoreSummarySet, userId: string): 'A' | 'B' | null {
  if (set.teamAUserIds?.includes(userId)) return 'A';
  if (set.teamBUserIds?.includes(userId)) return 'B';
  return null;
}

function headToHeadMargin(
  sets: readonly GameScoreSummarySet[],
  firstUserId: string,
  secondUserId: string,
): number {
  return sets.reduce((margin, set) => {
    const firstSide = sideForPlayer(set, firstUserId);
    const secondSide = sideForPlayer(set, secondUserId);
    if (!firstSide || !secondSide || firstSide === secondSide || set.teamA === set.teamB) {
      return margin;
    }
    const winningSide = set.teamA > set.teamB ? 'A' : 'B';
    return margin + (firstSide === winningSide ? 1 : -1);
  }, 0);
}

function PlayerAvatars(props: {
  readonly participants: readonly GameCard['participants'][number][];
}): React.JSX.Element {
  return (
    <span className="game-score-summary__avatars" aria-hidden="true">
      {props.participants.map((participant, index) => (
        <PlayerLevelAvatar
          accentColor={participantAccent(participant.level)}
          alt={participant.displayName}
          className="game-score-summary__avatar"
          fallbackSeed={participant.userId}
          key={participant.userId}
          level={participant.level ?? ''}
          progress={participantLevelProgress(participant.levelValue)}
          size={40}
          src={participant.avatarUrl}
          stackIndex={index}
          variant="participant"
        />
      ))}
    </span>
  );
}

export function GameScoreSummary(props: {
  readonly participants: readonly GameCard['participants'][number][];
  readonly sets: readonly GameScoreSummarySet[];
}): React.JSX.Element | null {
  const participantById = new Map(
    props.participants.map((participant) => [participant.userId, participant]),
  );
  const completeSets = props.sets.filter(
    (set) => set.teamAUserIds?.length === 2 && set.teamBUserIds?.length === 2,
  );
  const firstSet = completeSets[0];
  if (!firstSet?.teamAUserIds || !firstSet.teamBUserIds) return null;

  const firstPairKeys = [pairKey(firstSet.teamAUserIds), pairKey(firstSet.teamBUserIds)];
  const stablePairKeys = [...firstPairKeys].sort().join('|');
  const pairsStayedTogether = completeSets.every((set) => {
    if (!set.teamAUserIds || !set.teamBUserIds) return false;
    return (
      [pairKey(set.teamAUserIds), pairKey(set.teamBUserIds)].sort().join('|') === stablePairKeys
    );
  });

  const rows: readonly SummaryRow[] = pairsStayedTogether
    ? [firstSet.teamAUserIds, firstSet.teamBUserIds].map((userIds) => {
        const key = pairKey(userIds);
        const scores = completeSets
          .map((set) => scoreForPair(set, key))
          .filter((score): score is ScoreCell => score !== null);
        return {
          key,
          participants: userIds
            .map((userId) => participantById.get(userId))
            .filter(
              (participant): participant is GameCard['participants'][number] =>
                participant !== undefined,
            ),
          scores,
          wins: scores.filter((score) => score.won).length,
          gamesWon: scores.reduce((total, score) => total + score.score, 0),
        };
      })
    : props.participants
        .slice(0, 4)
        .map((participant, originalIndex) => {
          const scores = completeSets
            .map((set) => scoreForPlayer(set, participant.userId))
            .filter((score): score is ScoreCell => score !== null);
          return {
            key: participant.userId,
            participants: [participant],
            scores,
            wins: scores.filter((score) => score.won).length,
            gamesWon: scores.reduce((total, score) => total + score.score, 0),
            originalIndex,
          };
        })
        .sort((first, second) => {
          const winsDifference = second.wins - first.wins;
          if (winsDifference !== 0) return winsDifference;
          const gamesDifference = second.gamesWon - first.gamesWon;
          if (gamesDifference !== 0) return gamesDifference;
          const directResult = headToHeadMargin(completeSets, first.key, second.key);
          if (directResult !== 0) return -directResult;
          return first.originalIndex - second.originalIndex;
        });
  const highestWinCount = Math.max(...rows.map((row) => row.wins));
  const hasDifferentWinCounts = rows.some((row) => row.wins !== rows[0]?.wins);

  return (
    <section
      className={`game-score-summary${pairsStayedTogether ? '' : ' game-score-summary--personal'}`}
      aria-label={pairsStayedTogether ? 'Сводка по парам' : 'Личная сводка игроков'}
    >
      <div role="table" aria-label="Счёт по сетам">
        {rows.map((row) => {
          const fullNames = row.participants
            .map((participant) => participant.displayName)
            .join(', ');
          return (
            <div
              className={`game-score-summary__row${hasDifferentWinCounts && row.wins === highestWinCount ? ' game-score-summary__row--leading' : ''}`}
              role="row"
              key={row.key}
            >
              <div className="game-score-summary__players" role="rowheader" aria-label={fullNames}>
                <PlayerAvatars participants={row.participants} />
                <span className="game-score-summary__names">
                  {row.participants.map((participant) => (
                    <strong key={participant.userId}>
                      {playerShortName(participant.displayName)}
                    </strong>
                  ))}
                </span>
              </div>
              <div className="game-score-summary__scores" role="cell" aria-label="Счёт по сетам">
                {row.scores.map((score, index) => (
                  <span
                    className={score.won ? 'game-score-summary__score--won' : undefined}
                    key={index}
                  >
                    {score.score}
                  </span>
                ))}
              </div>
              <strong
                className="game-score-summary__wins"
                role="cell"
                aria-label={`Выиграно сетов: ${row.wins}`}
              >
                {row.wins}
              </strong>
            </div>
          );
        })}
      </div>
    </section>
  );
}
