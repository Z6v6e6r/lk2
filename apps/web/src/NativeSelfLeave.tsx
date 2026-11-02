import { nativeJoinLeaveAdmission } from './native-game-join-attempt.js';
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { GameCard, GameCommandResult } from '@phub/api-sdk';
import type { AuthGateway } from './auth-gateway.js';
import { GameSelfLeaveAttempts } from './game-self-leave-attempt.js';
import {
  browserGameJoinAttemptLockManager,
  browserGameJoinAttemptStorage,
} from './game-join-attempt.js';
export type NativeSelfLeaveGateway = Pick<
  AuthGateway,
  'leaveGame' | 'getManagedLeaveOperation' | 'reconcileManagedLeaveOperation'
> & { principal(): string | null };
function createLeaveLifetime(gateway: NativeSelfLeaveGateway, tenantId: string, userId: string) {
  let active = false;
  const principal = gateway.principal(),
    storage = browserGameJoinAttemptStorage(),
    locks = browserGameJoinAttemptLockManager();
  const current = () => active && principal !== null && gateway.principal() === principal;
  return {
    current,
    activate: () => {
      active = true;
    },
    deactivate: () => {
      active = false;
    },
    attempts:
      principal &&
      storage &&
      locks &&
      gateway.getManagedLeaveOperation &&
      gateway.reconcileManagedLeaveOperation
        ? new GameSelfLeaveAttempts(
            { tenantId, userId },
            storage,
            locks,
            gateway,
            current,
            nativeJoinLeaveAdmission(storage, { tenantId, userId }),
          )
        : null,
  };
}
/** A detail-only action. No waitlist, other-member, payment or organizer controls. */
export function NativeSelfLeave({
  game,
  gateway,
  scope,
}: {
  game: GameCard;
  gateway: NativeSelfLeaveGateway;
  scope: { tenantId: string; userId: string };
}) {
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false),
    [pending, setPending] = useState(false),
    [notice, setNotice] = useState(''),
    [completed, setCompleted] = useState(false);
  const { tenantId, userId } = scope;
  const lifetime = useMemo(
    () => createLeaveLifetime(gateway, tenantId, userId),
    [gateway, tenantId, userId],
  );
  const observed = useCallback(
    (result: GameCommandResult | null) => {
      if (!lifetime.current()) return;
      const done = result?.operation.status === 'SUCCEEDED';
      setCompleted(done);
      setPending(Boolean(lifetime.attempts?.load(game.id)));
      setNotice(
        done
          ? 'Выход из игры подтверждён.'
          : result?.operation.noDispatch?.outcome === 'NOT_DISPATCHED'
            ? 'Исходный выход не отправлялся.'
            : 'Выход пока не подтверждён. Исходный запрос сохранён.',
      );
    },
    [lifetime, game.id],
  );
  // Activate and retire the command lifetime before a visible action can receive a click.
  useLayoutEffect(() => {
    lifetime.activate();
    const attempts = lifetime.attempts;
    void (async () => {
      try {
        if (attempts?.load(game.id)) {
          setPending(true);
          observed(await attempts.read(game.id));
        }
      } catch {
        if (lifetime.current()) setNotice('Статус выхода недоступен. Исходный запрос сохранён.');
      }
    })();
    return () => {
      lifetime.deactivate();
    };
  }, [lifetime, game.id, observed]);
  async function run(read: boolean) {
    if (!lifetime.attempts || !lifetime.current() || inFlight.current) return;
    if (!read && !pending && !game.allowedActions.includes('LEAVE')) return;
    inFlight.current = true;
    setBusy(true);
    try {
      observed(await (read ? lifetime.attempts.read(game.id) : lifetime.attempts.submit(game.id)));
    } catch {
      if (lifetime.current()) {
        setNotice('Выход не подтверждён. Проверьте состояние исходного запроса.');
        try {
          setPending(Boolean(lifetime.attempts.load(game.id)));
        } catch {
          setPending(true);
        }
      }
    } finally {
      inFlight.current = false;
      if (lifetime.current()) setBusy(false);
    }
  }
  if (!pending && !game.allowedActions.includes('LEAVE') && !notice) return null;
  // Waitlist membership has its own unsupported command; never reinterpret it as a seat departure.
  const waitlisted = String(game.viewerRelation).includes('WAITLIST');
  return (
    <section aria-label="Выход из игры">
      {!pending && !completed && game.allowedActions.includes('LEAVE') && !waitlisted && (
        <button
          type="button"
          className="secondary-button"
          disabled={busy || !lifetime.attempts}
          onClick={() => void run(false)}
        >
          Выйти из игры
        </button>
      )}
      {pending && (
        <>
          <button type="button" disabled={busy} onClick={() => void run(true)}>
            Проверить выход
          </button>
          <button type="button" disabled={busy} onClick={() => void run(false)}>
            Повторить исходный запрос выхода
          </button>
        </>
      )}
      {!lifetime.attempts && (
        <p>Для безопасного выхода требуется доступное хранилище приложения.</p>
      )}
      {notice && <p role="status">{notice}</p>}
    </section>
  );
}
