import { useState } from 'react';
import type { GameCard } from './auth-gateway.js';

/** Sharing a public link never grants membership or creates a personal invitation. */
export function GameInviteButton({
  game,
  busy,
  publicGameOrigin,
}: {
  readonly game: GameCard;
  readonly busy: boolean;
  readonly publicGameOrigin?: string | null;
}): React.JSX.Element {
  const [sharing, setSharing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [manualLink, setManualLink] = useState<string | null>(null);

  async function invite(): Promise<void> {
    if (busy || sharing) return;
    if (publicGameOrigin === null) {
      setNotice('Ссылка на игру пока недоступна');
      return;
    }
    if (!['https:', 'http:'].includes(window.location.protocol)) {
      setNotice('В локальном предпросмотре ссылка не отправляется.');
      return;
    }
    let url: string;
    try {
      const origin = new URL(publicGameOrigin ?? window.location.origin);
      if (!['https:', 'http:'].includes(origin.protocol) || origin.username || origin.password) {
        throw new Error('PUBLIC_GAME_ORIGIN_INVALID');
      }
      url = new URL(`/games/${encodeURIComponent(game.id)}`, origin.origin).toString();
    } catch {
      setNotice('Ссылка на игру пока недоступна');
      return;
    }
    setSharing(true);
    setNotice(null);
    setManualLink(null);
    try {
      if (navigator.share) {
        try {
          await navigator.share({ title: game.title, url });
          return;
        } catch (cause: unknown) {
          if (cause instanceof DOMException && cause.name === 'AbortError') return;
        }
      }
      if (navigator.clipboard?.writeText) {
        try {
          await navigator.clipboard.writeText(url);
          setNotice('Ссылка на игру скопирована');
          return;
        } catch {
          // A selectable link remains available when clipboard access is denied.
        }
      }
      setManualLink(url);
    } finally {
      setSharing(false);
    }
  }

  return (
    <div className="game-detail-players__invite">
      <button
        className="game-detail-invite"
        type="button"
        disabled={busy || sharing}
        aria-busy={sharing}
        onClick={() => void invite()}
      >
        <span className="game-detail-invite__icon" aria-hidden="true">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </span>
        <span>Пригласить в игру</span>
      </button>
      {notice ? (
        <p className="game-detail-invite__notice" role="status">
          {notice}
        </p>
      ) : null}
      {manualLink ? (
        <label className="game-detail-invite__link">
          <span role="status">Скопируйте ссылку на игру:</span>
          <input
            aria-label="Ссылка на игру"
            readOnly
            value={manualLink}
            onFocus={(event) => event.currentTarget.select()}
          />
        </label>
      ) : null}
    </div>
  );
}
