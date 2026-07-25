import type { GameCard, PublicGameCard } from './auth-gateway.js';

export function profileUserIdForParticipant(
  publicGame: PublicGameCard,
  participant: PublicGameCard['participants'][number],
  participantIndex: number,
  viewerGame: GameCard,
): string | undefined {
  const indexedParticipant = viewerGame.participants[participantIndex];
  if (
    viewerGame.revision === publicGame.revision &&
    indexedParticipant?.displayName === participant.displayName
  ) {
    return indexedParticipant.userId;
  }
  const matchingParticipants = viewerGame.participants.filter(
    (candidate) =>
      candidate.displayName === participant.displayName &&
      candidate.avatarUrl === participant.avatarUrl &&
      candidate.level === participant.level,
  );
  return matchingParticipants.length === 1 ? matchingParticipants[0]?.userId : undefined;
}
