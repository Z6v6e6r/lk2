import {
  parseTournamentChatPage,
  type TournamentChatPage,
  type TournamentChatMessage,
} from '@phub/api-sdk';
export interface TournamentThread {
  readonly streamId: string | null;
  readonly headSequence: number;
  readonly olderThrough: number;
  readonly olderCursor: string | null;
  readonly messages: readonly TournamentChatMessage[];
}
export const tournamentThread = (p: TournamentChatPage): TournamentThread => ({
  streamId: p.streamId,
  headSequence: p.throughSequence,
  olderThrough: p.throughSequence,
  olderCursor: p.nextCursor,
  messages: p.messages,
});
export async function refreshTournamentThread(
  id: string,
  old: TournamentThread | null,
  load: (id: string, limit: number, cursor?: string) => Promise<TournamentChatPage>,
  current: () => boolean,
): Promise<TournamentThread> {
  const first = parseTournamentChatPage(await load(id, 50), id, 50);
  if (!current()) throw new Error('AUTH_PRINCIPAL_CHANGED');
  if (!old || !old.messages.length) return tournamentThread(first);
  if (first.streamId !== old.streamId || first.throughSequence < old.headSequence)
    throw new Error('TOURNAMENT_CHAT_STREAM_CHANGED');
  let page = first;
  const prefix: TournamentChatMessage[] = [];
  const seenIds = new Set(old.messages.map((message) => message.messageId));
  for (let batch = 0; batch < 4; batch++) {
    for (const m of page.messages) {
      if (m.sequence > old.headSequence) {
        if (seenIds.has(m.messageId)) throw new Error('TOURNAMENT_CHAT_STREAM_CHANGED');
        seenIds.add(m.messageId);
        prefix.push(m);
      } else if (m.sequence === old.headSequence) {
        if (m.messageId !== old.messages[0]?.messageId)
          throw new Error('TOURNAMENT_CHAT_STREAM_CHANGED');
        return {
          ...old,
          headSequence: first.throughSequence,
          messages: [...prefix, ...old.messages],
        };
      }
    }
    if (!page.nextCursor || batch === 3) break;
    const cursor = page.nextCursor;
    page = parseTournamentChatPage(await load(id, 50, cursor), id, 50, cursor);
    if (!current()) throw new Error('AUTH_PRINCIPAL_CHANGED');
  }
  throw new Error('TOURNAMENT_CHAT_HISTORY_GAP');
}
