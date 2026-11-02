import type { GameCard, PadlHubApiClient } from '@phub/api-sdk';

/** CANCEL is aggregate-idempotent. An ambiguous ACK is resolved only by the existing GET. */
export async function cancelGameAndRead(input: {
  gameId: string;
  cancel: PadlHubApiClient['cancelGame'];
  read: PadlHubApiClient['getGame'];
  isCurrent: () => boolean;
}): Promise<GameCard | null> {
  const current = (): void => {
    if (!input.isCurrent()) throw new DOMException('Session changed', 'AbortError');
  };
  current();
  try {
    await input.cancel(input.gameId, { reasonCode: 'ORGANIZER_REQUEST' });
  } catch {
    // No second command here. Even a rejection may race an already-completed cancellation.
    current();
  }
  current();
  try {
    const game = await input.read(input.gameId);
    current();
    return game.id === input.gameId ? game : null;
  } catch {
    current();
    return null;
  }
}
