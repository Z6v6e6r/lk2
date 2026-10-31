import { useEffect, useLayoutEffect, useMemo, useState } from 'react';
import type { TrainingRegistrationResult } from '@phub/api-contracts';
import type { AuthGateway } from './auth-gateway.js';
import { GameJoinSubscriptionPicker } from './GameJoinSubscriptionPicker.js';
import { TrainingRegistrationAttempts } from './training-registration-attempt.js';
class TrainingPanelLifetime {
  private active = true;
  constructor(private readonly gateway: AuthGateway) {}
  start() {
    this.active = true;
  }
  stop() {
    this.active = false;
  }
  current(gateway: AuthGateway) {
    return this.active && this.gateway === gateway;
  }
}
type TrainingPanelProps = {
  gateway: AuthGateway;
  principal: { tenantId: string; userId: string };
  training: { id: string; title: string; startsAt: string };
  onClose: () => void;
};
export function TrainingRegistrationPanel(props: TrainingPanelProps) {
  return (
    <TrainingRegistrationSession
      key={`${props.principal.tenantId}:${props.principal.userId}:${props.training.id}`}
      {...props}
    />
  );
}
function TrainingRegistrationSession({
  gateway,
  principal,
  training,
  onClose,
}: {
  gateway: AuthGateway;
  principal: { tenantId: string; userId: string };
  training: { id: string; title: string; startsAt: string };
  onClose: () => void;
}) {
  const lifetime = useMemo(() => new TrainingPanelLifetime(gateway), [gateway]);
  useLayoutEffect(() => {
    lifetime.start();
    return () => lifetime.stop();
  }, [lifetime]);
  const attempts = useMemo(
    () =>
      new TrainingRegistrationAttempts(
        { tenantId: principal.tenantId, userId: principal.userId },
        {
          getItem: (key) => window.localStorage.getItem(key),
          setItem: (key, value) => window.localStorage.setItem(key, value),
          removeItem: (key) => window.localStorage.removeItem(key),
        },
        {
          request: async (name, options, callback) => {
            if (!navigator.locks) throw new Error('TRAINING_LOCK_UNAVAILABLE');
            return await navigator.locks.request(name, options, callback);
          },
        },
        gateway,
        () => lifetime.current(gateway),
      ),
    [gateway, principal.tenantId, principal.userId, lifetime],
  );
  const [selected, setSelected] = useState<string | undefined>(),
    [result, setResult] = useState<TrainingRegistrationResult | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null),
    [stored, setStored] = useState(() => {
      try {
        return attempts.load(training.id);
      } catch {
        return null;
      }
    });
  const dateHint = new Date(Date.parse(training.startsAt) + 10800000).toISOString().slice(0, 10);
  const run = async (read: boolean) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const original = attempts.load(training.id);
      const value = read
        ? await attempts.read(training.id)
        : await attempts.submit(training.id, {
            dateHint: original?.dateHint ?? dateHint,
            subscriptionId: original?.subscriptionId ?? selected ?? '',
          });
      if (lifetime.current(gateway)) {
        setResult(value);
        setStored(attempts.load(training.id));
      }
    } catch {
      if (lifetime.current(gateway))
        setError('Не удалось проверить запись. Сохранённый запрос не заменён; повторите проверку.');
    } finally {
      if (lifetime.current(gateway)) setBusy(false);
    }
  };
  useEffect(() => {
    let disposed = false;
    void Promise.resolve().then(async () => {
      try {
        const original = attempts.load(training.id);
        if (disposed || !lifetime.current(gateway)) return;
        setStored(original);
        if (original) {
          const value = await attempts.read(training.id);
          if (!disposed && lifetime.current(gateway)) {
            setResult(value);
            setStored(attempts.load(training.id));
          }
        }
      } catch {
        if (!disposed && lifetime.current(gateway))
          setError('Статус записи пока неизвестен. Повторите проверку.');
      }
    });
    return () => {
      disposed = true;
    };
  }, [attempts, training.id, lifetime, gateway]);
  return (
    <section
      className="game-detail-card"
      aria-labelledby="training-registration-title"
      aria-busy={busy}
    >
      <h2 id="training-registration-title">{training.title}</h2>
      <p>
        {new Date(training.startsAt).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })} ·
        Москва
      </p>
      <p>Запись по доступной подписке. Доплата и покупка здесь не поддерживаются.</p>
      {!stored ? (
        <GameJoinSubscriptionPicker
          gateway={gateway}
          {...(selected ? { value: selected } : {})}
          onChange={setSelected}
        />
      ) : (
        <p>Сохранён исходный запрос. Повторная отправка использует ту же подписку.</p>
      )}
      {result?.registration.status === 'CONFIRMED' ? (
        <p role="status">Запись подтверждена по последней проверке.</p>
      ) : result?.operation.status === 'REJECTED_NOT_DISPATCHED' ? (
        <p role="status">
          Выбранная подписка не поддерживается для этой записи. Запрос не отправлен; можно выбрать
          другую.
        </p>
      ) : result?.operation.status === 'EXPIRED_NOT_DISPATCHED' ? (
        <p role="status">Подготовка истекла до отправки. Можно явно начать новый запрос.</p>
      ) : result ? (
        <p role="status">Текущая запись не подтверждена. Проверка не создаёт новую запись.</p>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
      <div className="games-level-recovery__actions">
        <button
          className="games-level-recovery__primary"
          type="button"
          disabled={busy || (!stored && !selected) || !gateway.registerTraining}
          onClick={() => void run(false)}
        >
          {stored ? 'Продолжить исходный запрос' : 'Записаться по подписке'}
        </button>
        {stored ? (
          <button
            className="games-level-recovery__secondary"
            type="button"
            disabled={busy}
            onClick={() => void run(true)}
          >
            Проверить запись
          </button>
        ) : null}
        <button className="games-level-recovery__back" type="button" onClick={onClose}>
          Закрыть
        </button>
      </div>
    </section>
  );
}
