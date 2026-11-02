import { useEffect, useRef, useState } from 'react';
import type { GetOrCreateGameConversationResult } from '@phub/api-sdk';
import { gameChatEntry, type GameCardModel } from './game-card-policy.js';

/** Chat-only native detail entry. Booking and payment actions retain their own owners. */
export function NativeGameChat({
  game,
  principal,
  open,
}: {
  readonly game: GameCardModel;
  readonly principal: () => string | null;
  readonly open: (gameId: string) => Promise<GetOrCreateGameConversationResult>;
}) {
  const active = useRef(false);
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const entry = gameChatEntry(game);
  if (entry === 'NONE') return null;
  if (entry === 'OPEN' && 'conversation' in game && game.conversation)
    return <a href={`/chats/${game.conversation.conversationId}`}>Чат игры</a>;
  const run = async () => {
    const original = principal();
    if (!original || pending.current) return;
    const current = () => active.current && principal() === original;
    pending.current = true;
    setBusy(true);
    setError(false);
    try {
      const result = await open(game.id);
      if (!current()) return;
      window.history.pushState(null, '', `/chats/${result.conversation.id}`);
      window.dispatchEvent(new PopStateEvent('popstate'));
    } catch {
      if (current()) setError(true);
    } finally {
      pending.current = false;
      if (current()) setBusy(false);
    }
  };
  return (
    <>
      <button type="button" disabled={busy} onClick={() => void run()}>
        Чат игры
      </button>
      {error && <p role="alert">Не удалось открыть чат игры. Повторите открытие.</p>}
    </>
  );
}
