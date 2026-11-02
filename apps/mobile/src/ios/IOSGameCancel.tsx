import type { NativeJoinRequest } from '../../../web/src/native-game-join-attempt.js';
import { NativeGameJoin } from '../../../web/src/NativeGameJoin.js';
import { NativeSelfLeave } from '../../../web/src/NativeSelfLeave.js';
import { NativeGameChat } from '../../../web/src/NativeGameChat.js';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { GameCard as Game } from '@phub/api-sdk';
import { GameCard } from '../../../web/src/GameCard.js';
import { cancelGameAndRead } from '../../../web/src/game-cancel-readback.js';
import type { IOSSession } from './session.js';

export function IOSGameCancel({ game, session }: { game: Game; session: IOSSession }) {
  const joinGateway = useMemo(
    () => ({
      principal: () => session.quarterCreatePrincipal(),
      getGame: (id: string) => session.read((api) => api.getGame(id)),
      getHomeDashboard: () => session.read((api) => api.getHomeDashboard()),
      request: (request: NativeJoinRequest) => session.gameJoin(request),
    }),
    [session],
  );
  const leaveGateway = useMemo(
    () => ({
      principal: () => session.quarterCreatePrincipal(),
      leaveGame: (id: string, options?: { idempotencyKey?: string }) =>
        session.selfLeave('leave', id, options?.idempotencyKey ?? ''),
      getManagedLeaveOperation: (id: string, key: string) => session.selfLeave('status', id, key),
      reconcileManagedLeaveOperation: (id: string, key: string) =>
        session.selfLeave('reconcile', id, key),
    }),
    [session],
  );
  const snapshot = session.getSnapshot();
  const [currentGame, setGame] = useState(game);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const cancellationAttempted = useRef(false);
  const active = useRef(false);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const run = async (cancel: boolean) => {
    const principal = session.gameCancelPrincipal();
    if (!principal || inFlight.current) return;
    if (
      cancel &&
      (!currentGame.allowedActions.includes('CANCEL') ||
        currentGame.viewerRelation !== 'ORGANIZER' ||
        !window.confirm('Отменить игру для всех участников?'))
    )
      return;
    const current = () => active.current && session.gameCancelPrincipal() === principal;
    if (!current()) return;
    inFlight.current = true;
    setBusy(true);
    try {
      const read = (id: string) => session.read((api) => api.getGame(id));
      if (cancel) cancellationAttempted.current = true;
      const observed = cancel
        ? await cancelGameAndRead({
            gameId: currentGame.id,
            cancel: (id) => session.cancelGame(id),
            read,
            isCurrent: current,
          })
        : await read(currentGame.id);
      if (!current()) return;
      if (observed?.id === currentGame.id) setGame(observed);
      setNotice(
        observed?.displayState === 'CANCELLED'
          ? 'Игра отменена.'
          : cancellationAttempted.current
            ? 'Отмена пока не подтверждена. Обновите статус позже.'
            : 'Статус игры обновлён.',
      );
    } catch {
      if (current()) setNotice('Статус временно недоступен. Повторите обновление.');
    } finally {
      inFlight.current = false;
      if (current()) setBusy(false);
    }
  };
  return (
    <>
      <GameCard game={currentGame} readOnly />
      {snapshot.status === 'signed-in' && (
        <NativeGameJoin
          game={currentGame}
          gateway={joinGateway}
          onCanonicalGame={setGame}
          scope={{
            tenantId: snapshot.session.context.tenantId,
            userId: snapshot.session.context.userId,
          }}
        />
      )}
      {snapshot.status === 'signed-in' && (
        <NativeSelfLeave
          key={`${snapshot.session.context.tenantId}:${snapshot.session.context.userId}:${game.id}:${currentGame.viewerRelation}`}
          game={currentGame}
          gateway={leaveGateway}
          scope={{
            tenantId: snapshot.session.context.tenantId,
            userId: snapshot.session.context.userId,
          }}
        />
      )}
      <NativeGameChat
        key={currentGame.id}
        game={currentGame}
        principal={() => session.quarterCreatePrincipal()}
        open={(id) => session.openGameChat(id)}
      />
      {currentGame.viewerRelation === 'ORGANIZER' &&
        currentGame.allowedActions.includes('CANCEL') && (
          <button
            className="secondary-button"
            type="button"
            disabled={busy}
            onClick={() => void run(true)}
          >
            Отменить игру
          </button>
        )}
      <button
        className="secondary-button"
        type="button"
        disabled={busy}
        onClick={() => void run(false)}
      >
        Обновить статус игры
      </button>
      {notice && <p role="status">{notice}</p>}
    </>
  );
}
