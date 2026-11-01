import './TournamentRegistrationPanel.css';
import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react';
import type { TournamentLocalResult } from '@phub/api-contracts';
import type { AuthGateway } from './auth-gateway.js';
import { TournamentLocalAttempts } from './tournament-local-attempt.js';
class Lifetime {
  constructor(
    readonly key: string,
    readonly gateway: AuthGateway,
  ) {}
  active = true;
  start() {
    this.active = true;
  }
  stop() {
    this.active = false;
  }
}
export function TournamentRegistrationPanel({
  gateway,
  principal,
  tournamentId,
}: {
  gateway: AuthGateway;
  principal: { tenantId: string; userId: string };
  tournamentId: string;
}) {
  const life = useMemo(
    () => new Lifetime(`${principal.tenantId}:${principal.userId}:${tournamentId}`, gateway),
    [gateway, principal.tenantId, principal.userId, tournamentId],
  );
  useLayoutEffect(() => {
    life.start();
    return () => life.stop();
  }, [life]);
  const principalToken = gateway.tournamentPrincipal?.() ?? null;
  const attempts = useMemo(
    () =>
      new TournamentLocalAttempts(
        { tenantId: principal.tenantId, userId: principal.userId },
        {
          getItem: (key) => window.localStorage.getItem(key),
          setItem: (key, value) => window.localStorage.setItem(key, value),
          removeItem: (key) => window.localStorage.removeItem(key),
        },
        {
          request: async (name, options, callback) => {
            if (!navigator.locks) throw new Error('TOURNAMENT_LOCK_UNAVAILABLE');
            return navigator.locks.request(name, options, callback);
          },
        },
        gateway,
        () =>
          life.active &&
          Boolean(principalToken) &&
          gateway.tournamentPrincipal?.() === principalToken,
      ),
    [gateway, life, principal.tenantId, principal.userId, principalToken],
  );
  const [result, setResult] = useState<TournamentLocalResult | null>(null),
    [busy, setBusy] = useState(true),
    [error, setError] = useState<string | null>(null),
    [pending, setPending] = useState(false),
    [commandsEnabled, setCommandsEnabled] = useState(false);
  const hasCustody = useCallback(() => {
    try {
      return Boolean(attempts.load(tournamentId));
    } catch {
      return true;
    }
  }, [attempts, tournamentId]);
  const failure = useCallback((e: unknown) => {
    const code = e && typeof e === 'object' && 'code' in e ? String(e.code) : '';
    setError(
      code === 'TOURNAMENT_LOCAL_DISABLED'
        ? 'Запись на этот турнир пока недоступна.'
        : code === 'TOURNAMENT_LOCAL_UNSUPPORTED'
          ? 'Этот турнир пока не поддерживает запись через приложение.'
          : 'Результат не подтверждён. Проверьте исходную операцию; новая запись не отправляется.',
    );
  }, []);
  useEffect(() => {
    let active = true;
    void attempts
      .read(tournamentId)
      .then(
        (r) => {
          if (active && life.active) {
            setResult(r.result);
            setCommandsEnabled(r.commandsEnabled);
            setPending(hasCustody());
          }
        },
        (e) => {
          if (active && life.active) {
            setCommandsEnabled(false);
            failure(e);
            setPending(hasCustody());
          }
        },
      )
      .finally(() => {
        if (active && life.active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [attempts, life, tournamentId, hasCustody, failure]);
  async function run(kind: 'join' | 'leave' | 'retry' | 'read') {
    setBusy(true);
    setError(null);
    try {
      if (kind === 'read') {
        const r = await attempts.read(tournamentId);
        if (life.active) {
          setResult(r.result);
          setCommandsEnabled(r.commandsEnabled);
        }
      } else {
        if (!commandsEnabled) return;
        const r =
          kind === 'retry'
            ? await attempts.retry(tournamentId, result)
            : await attempts.submit(
                tournamentId,
                kind === 'join'
                  ? { action: 'JOIN' }
                  : { action: 'LEAVE', originalJoinOperationId: result!.operation.generation! },
              );
        if (life.active) setResult(r);
      }
    } catch (e) {
      if (life.active) {
        if (kind === 'read') setCommandsEnabled(false);
        failure(e);
      }
    } finally {
      if (life.active) {
        setPending(hasCustody());
        setBusy(false);
      }
    }
  }
  const unknown = pending || result?.operation.status === 'UNKNOWN';
  const registered =
    result?.registration.status === 'REGISTERED' &&
    result.operation.status === 'REGISTERED' &&
    result.operation.generation === result.operation.id;
  return (
    <div className="tournament-registration" aria-live="polite">
      {error ? <p role="alert">{error}</p> : null}
      {!busy && !commandsEnabled && !error ? (
        <p>Запись сейчас недоступна. Можно проверить сохранённую операцию.</p>
      ) : null}
      {unknown ? (
        <p>Операция ожидает подтверждения. Сохранён исходный запрос.</p>
      ) : registered ? (
        <p>Запись подтверждена.</p>
      ) : result?.operation.status === 'LEFT' ? (
        <p>Вы вышли из исходной регистрации.</p>
      ) : result?.operation.status === 'REJECTED' ? (
        <p>
          Запись не выполнена:{' '}
          {result.operation.reason === 'FULL'
            ? 'мест нет'
            : result.operation.reason === 'MEMBERSHIP_EXISTS'
              ? 'существующая запись не принадлежит этой операции'
              : 'исходная регистрация уже изменилась'}
          .
        </p>
      ) : null}
      {unknown ? (
        <button type="button" disabled={busy || !commandsEnabled} onClick={() => void run('retry')}>
          Повторить исходную операцию
        </button>
      ) : registered ? (
        <button type="button" disabled={busy || !commandsEnabled} onClick={() => void run('leave')}>
          Выйти из турнира
        </button>
      ) : (
        <button
          type="button"
          disabled={
            busy || !commandsEnabled || Boolean(result && result.registration.status === 'UNKNOWN')
          }
          onClick={() => void run('join')}
        >
          Записаться на турнир
        </button>
      )}
      <button type="button" disabled={busy} onClick={() => void run('read')}>
        Проверить запись
      </button>
      <small>
        Запись доступна для части турниров без оплаты. Список участников может обновиться с
        задержкой.
      </small>
    </div>
  );
}
