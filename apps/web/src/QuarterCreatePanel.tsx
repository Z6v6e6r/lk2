import './QuarterCreatePanel.css';
import { useEffect, useLayoutEffect, useMemo, useState } from 'react';
import type { QuarterCreateResult } from '@phub/api-contracts';
import type { AuthGateway } from './auth-gateway.js';
import { GameJoinSubscriptionPicker } from './GameJoinSubscriptionPicker.js';
import {
  browserCreateGameAttemptLockManager,
  type CreateGameAttemptLockManager,
} from './create-game-attempt.js';
import {
  QuarterCreateAttempts,
  quarterCanReplace,
  type QuarterCreateGateway,
} from './quarter-create-attempt.js';
type Gateway = QuarterCreateGateway & Pick<AuthGateway, 'getHomeDashboard'>;
class Lifetime {
  constructor(readonly gateway: Gateway) {}
  active = true;
  start() {
    this.active = true;
  }
  stop() {
    this.active = false;
  }
}
export function QuarterCreatePanel(props: {
  gateway: Gateway;
  principal: { tenantId: string; userId: string };
  attemptStorage?: Storage;
  attemptLockManager?: CreateGameAttemptLockManager;
  navigate?: (url: string) => void;
  gamesHref?: '/' | '/games';
}) {
  return (
    <QuarterCreateSession
      key={props.principal.tenantId + ':' + props.principal.userId}
      {...props}
    />
  );
}
function QuarterCreateSession({
  gateway,
  principal,
  attemptStorage,
  attemptLockManager,
  navigate = (url) => window.location.assign(url),
  gamesHref = '/games',
}: Parameters<typeof QuarterCreatePanel>[0]) {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const localTimeLabel = `Начало — ваше местное время (${timeZone})`;
  const lifetime = useMemo(() => new Lifetime(gateway), [gateway]);
  useLayoutEffect(() => {
    lifetime.start();
    return () => lifetime.stop();
  }, [lifetime]);
  const attempts = useMemo(
    () =>
      new QuarterCreateAttempts(
        { tenantId: principal.tenantId, userId: principal.userId },
        attemptStorage ?? {
          getItem: (k) => window.localStorage.getItem(k),
          setItem: (k, v) => window.localStorage.setItem(k, v),
          removeItem: (k) => window.localStorage.removeItem(k),
          clear: () => {
            throw new Error('UNSUPPORTED');
          },
          key: () => null,
          length: 0,
        },
        attemptLockManager ?? browserCreateGameAttemptLockManager(),
        gateway,
        () => lifetime.active,
      ),
    [principal.tenantId, principal.userId, gateway, lifetime, attemptStorage, attemptLockManager],
  );
  const subscriptionGateway = useMemo(
    () => ({
      async getHomeDashboard() {
        if (!attempts.isCurrent()) throw new Error('AUTH_PRINCIPAL_CHANGED');
        const dashboard = await gateway.getHomeDashboard();
        if (!attempts.isCurrent()) throw new Error('AUTH_PRINCIPAL_CHANGED');
        return dashboard;
      },
    }),
    [attempts, gateway],
  );
  const [available, setAvailable] = useState(false),
    [pairs, setPairs] = useState<
      Awaited<ReturnType<NonNullable<AuthGateway['getQuarterCreateLocations']>>>['items']
    >([]),
    [pair, setPair] = useState(''),
    [start, setStart] = useState(''),
    [subscription, setSubscription] = useState<string>(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null),
    [result, setResult] = useState<QuarterCreateResult | null>(null),
    [stored, setStored] = useState(() => {
      try {
        return attempts.load();
      } catch {
        return null;
      }
    });
  useEffect(() => {
    let disposed = false;
    void (async () => {
      try {
        const original = attempts.load();
        if (original) {
          const v = await attempts.read();
          if (!disposed && attempts.isCurrent()) {
            setResult(v);
            setStored(attempts.load());
          }
          return;
        }
        if (!attempts.isCurrent()) throw new Error('AUTH_PRINCIPAL_CHANGED');
        const cap = await gateway.getQuarterCreateCapability?.();
        if (cap?.contractVersion !== 1 || !cap.available || !gateway.getQuarterCreateLocations)
          throw new Error();
        if (!attempts.isCurrent()) throw new Error('AUTH_PRINCIPAL_CHANGED');
        const locations = await gateway.getQuarterCreateLocations();
        if (!disposed && attempts.isCurrent()) {
          setPairs(locations.items);
          setAvailable(locations.items.length > 0);
        }
      } catch {
        if (!disposed && attempts.isCurrent())
          setError(
            'Создание сейчас недоступно. Исходный запрос сохранён, если он уже был отправлен.',
          );
      }
    })();
    return () => {
      disposed = true;
    };
  }, [attempts, gateway, lifetime]);
  const run = async (mode: 'submit' | 'read' | 'recover' | 'new' | 'another') => {
    if (busy || !attempts.isCurrent()) return;
    setBusy(true);
    setError(null);
    try {
      if (mode === 'new' || mode === 'another') {
        if (!result) throw new Error();
        if (mode === 'another') await attempts.chooseAnother(result);
        else await attempts.chooseNew(result);
        if (attempts.isCurrent()) {
          setStored(null);
          setResult(null);
          setPair('');
          setStart('');
          setSubscription(undefined);
          setAvailable(false);
          const cap = await gateway.getQuarterCreateCapability?.();
          if (cap?.available && gateway.getQuarterCreateLocations) {
            const locations = await gateway.getQuarterCreateLocations();
            if (attempts.isCurrent()) {
              setPairs(locations.items);
              setAvailable(locations.items.length > 0);
            }
          }
        }
        return;
      }
      const selected = pairs.find((x) => x.courtId === pair),
        v =
          mode === 'read'
            ? await attempts.read()
            : mode === 'recover'
              ? await attempts.recover()
              : await attempts.submit({
                  stationId: selected?.stationId ?? '',
                  courtId: selected?.courtId ?? '',
                  startsAt: new Date(start).toISOString(),
                  subscriptionId: subscription ?? '',
                });
      if (attempts.isCurrent()) {
        setResult(v);
        setStored(attempts.load());
      }
    } catch {
      if (attempts.isCurrent()) {
        setError(
          'Не удалось завершить проверку. Не создавайте повторную игру: сохранённый запрос остаётся прежним.',
        );
        try {
          setStored(attempts.load());
        } catch {
          /* Storage remains fail-closed. */
        }
      }
    } finally {
      if (attempts.isCurrent()) setBusy(false);
    }
  };
  return (
    <main className="games-page games-page--create quarter-create-page">
      <header className="games-page-header">
        <a href={gamesHref}>{gamesHref === '/' ? 'На главную' : 'Игры'}</a>
        <h1>Игра по подписке</h1>
      </header>
      <section className="game-create-form" aria-busy={busy}>
        <p>
          60 минут, четыре места. Подписка покрывает вашу четверть корта. Остальные участники
          записываются отдельно.
        </p>
        <p>
          Используются параметры открытой игры площадки. Название, уровни и очередь здесь не
          задаются.
        </p>
        {error ? (
          <p role="alert" className="games-message is-error">
            {error}
          </p>
        ) : null}
        {stored ? (
          <>
            <p>Исходный запрос сохранён. Новая игра повторно не отправляется.</p>
            <p>
              {localTimeLabel}: {new Date(stored.request.startsAt).toLocaleString('ru-RU')}
            </p>
          </>
        ) : (
          <>
            <label>
              Корт
              <select
                value={pair}
                disabled={!available || busy}
                onChange={(e) => setPair(e.currentTarget.value)}
              >
                <option value="">Выберите корт</option>
                {pairs.map((x) => (
                  <option key={x.courtId} value={x.courtId}>
                    {x.stationTitle} · {x.courtName}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {localTimeLabel}
              <input
                type="datetime-local"
                value={start}
                disabled={!available || busy}
                onChange={(e) => setStart(e.currentTarget.value)}
              />
            </label>
            <GameJoinSubscriptionPicker
              gateway={subscriptionGateway}
              {...(subscription ? { value: subscription } : {})}
              onChange={(value) => {
                if (attempts.isCurrent()) setSubscription(value);
              }}
            />
            <button
              className="game-detail-primary"
              type="button"
              disabled={!available || busy || !pair || !start || !subscription}
              onClick={() => void run('submit')}
            >
              Создать игру по подписке
            </button>
          </>
        )}
        {result ? (
          <div className="quarter-create-status" role="status">
            {result.operation.status === 'CONFIRMED' ? (
              <>
                <p>Создание игры подтверждено.</p>
                {result.gameProjection.status === 'PENDING' ? (
                  <p>Игра ещё загружается в каталог. Повторно создавать её не нужно.</p>
                ) : (
                  <button
                    className="game-detail-secondary"
                    type="button"
                    onClick={() => navigate('/games/' + result.gameProjection.gameId)}
                  >
                    Открыть игру
                  </button>
                )}
                <p>
                  {result.registration.status === 'CONFIRMED'
                    ? 'Ваше участие подтверждено последней проверкой.'
                    : 'Текущий статус участия пока не подтверждён.'}
                </p>
              </>
            ) : quarterCanReplace(result) ? (
              <p>Этот запрос завершён без созданной игры. Можно выбрать новые параметры.</p>
            ) : (
              <p>Результат ещё неизвестен. Сохранён исходный запрос.</p>
            )}
          </div>
        ) : null}
        {stored ? (
          <>
            <button
              className="game-detail-secondary"
              type="button"
              disabled={busy}
              onClick={() => void run('read')}
            >
              Проверить статус
            </button>
            {!result || ['PENDING', 'UNKNOWN'].includes(result.operation.status) ? (
              <button
                className="game-detail-secondary"
                type="button"
                disabled={busy}
                onClick={() => void run('recover')}
              >
                Продолжить исходную операцию
              </button>
            ) : null}
            {result?.operation.status === 'CONFIRMED' &&
            result.gameProjection.status === 'AVAILABLE' ? (
              <button
                className="game-detail-secondary"
                type="button"
                disabled={busy}
                onClick={() => void run('another')}
              >
                Создать другую игру
              </button>
            ) : null}
            {result && quarterCanReplace(result) ? (
              <button
                className="game-detail-secondary"
                type="button"
                disabled={busy}
                onClick={() => void run('new')}
              >
                Выбрать новые параметры
              </button>
            ) : null}
          </>
        ) : null}
        <p>Автоматическое вступление организатора в сообщество станции пока недоступно.</p>
      </section>
    </main>
  );
}
