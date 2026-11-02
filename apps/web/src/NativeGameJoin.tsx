import { useEffect, useMemo, useRef, useState } from 'react';
import type { GameCard } from '@phub/api-sdk';
import { GameJoinSubscriptionPicker } from './GameJoinSubscriptionPicker.js';
import {
  browserGameJoinAttemptLockManager,
  browserGameJoinAttemptStorage,
} from './game-join-attempt.js';
import { gameJoinRequiresPaidFlow, type GameJoinConditionsView } from './game-join-flow.js';
import {
  NativeGameJoinAttempts,
  type NativeJoinAttempt,
  type NativeJoinGateway,
} from './native-game-join-attempt.js';
function createLifetime(
  gateway: NativeJoinGateway,
  scope: { tenantId: string; userId: string },
  onCanonicalGame?: (game: GameCard) => void,
) {
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
      principal && storage && locks
        ? new NativeGameJoinAttempts(scope, storage, locks, gateway, current, onCanonicalGame)
        : null,
  };
}
/** Dedicated native participation panel. Every recovery retains the original account, body and key. */
export function NativeGameJoin({
  game,
  gateway,
  scope,
  onCanonicalGame,
}: {
  game: GameCard;
  gateway: NativeJoinGateway;
  scope: { tenantId: string; userId: string };
  onCanonicalGame?: (game: GameCard) => void;
}) {
  const { tenantId, userId } = scope;
  const lifetime = useMemo(
    () => createLifetime(gateway, { tenantId, userId }, onCanonicalGame),
    [gateway, tenantId, userId, onCanonicalGame],
  );
  const [attempt, setAttempt] = useState<NativeJoinAttempt | null>(null),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState('');
  const [subscription, setSubscription] = useState<string | undefined>(),
    [conditions, setConditions] = useState<GameJoinConditionsView | undefined>(),
    [consent, setConsent] = useState(false);
  const inFlight = useRef(false);
  useEffect(() => {
    lifetime.activate();
    void (async () => {
      try {
        const saved = lifetime.attempts?.load(game.id);
        if (saved) {
          setAttempt(saved);
          const result = await lifetime.attempts!.recover(game.id);
          if (lifetime.current()) {
            setAttempt(result);
            if (result.state === 'CONFIRMED' && saved.state !== 'CONFIRMED')
              await lifetime.attempts!.recover(game.id);
          }
        }
      } catch {
        if (lifetime.current())
          setNotice('Статус записи пока недоступен. Исходный запрос сохранён.');
      }
    })();
    return () => lifetime.deactivate();
  }, [lifetime, game.id, game.revision]);
  async function run(action: 'conditions' | 'submit' | 'read' | 'retry') {
    const attempts = lifetime.attempts;
    if (!attempts || !lifetime.current() || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setNotice('');
    try {
      if (action === 'conditions') {
        if (!subscription) return;
        const value = await attempts.conditions(game.id, subscription);
        if (lifetime.current()) {
          setConditions(value);
          setConsent(false);
        }
      } else {
        if (action === 'submit' && gameJoinRequiresPaidFlow(game) && (!consent || !conditions))
          return;
        const value =
          action === 'submit'
            ? await attempts.submit(game.id, conditions)
            : await attempts.recover(game.id, action === 'retry');
        if (!lifetime.current()) return;
        setAttempt(value);
        setConditions(undefined);
        setConsent(false);
        setNotice(
          value.state === 'CONFIRMED'
            ? 'Запись в игру подтверждена.'
            : value.state === 'REJECTED'
              ? 'Запись отклонена. Обновите условия перед новой попыткой.'
              : 'Запись пока не подтверждена. Исходный запрос сохранён.',
        );
        if (value.state === 'CONFIRMED') {
          const observed = await attempts.recover(game.id);
          if (lifetime.current()) setAttempt(observed);
        }
      }
    } catch {
      if (lifetime.current()) {
        setNotice('Не удалось подтвердить запись. Проверьте статус исходного запроса.');
        try {
          setAttempt(attempts.load(game.id));
        } catch {
          setNotice('Хранилище записи недоступно. Новая запись заблокирована.');
        }
      }
    } finally {
      inFlight.current = false;
      if (lifetime.current()) setBusy(false);
    }
  }
  const pending = attempt?.state === 'PENDING',
    paid = gameJoinRequiresPaidFlow(game);
  const freshAllowed =
    attempt?.state !== 'CONFIRMED' ||
    (attempt.membershipRevision !== undefined &&
      game.revision > Math.max(attempt.revision, attempt.membershipRevision));
  if (!game.allowedActions.includes('JOIN') && !attempt && !notice) return null;
  return (
    <section aria-label="Запись в игру" aria-busy={busy}>
      {!pending && freshAllowed && game.allowedActions.includes('JOIN') && (
        <>
          {paid && (
            <>
              <fieldset disabled={busy}>
                <GameJoinSubscriptionPicker
                  gateway={gateway}
                  {...(subscription ? { value: subscription } : {})}
                  onChange={(id) => {
                    setSubscription(id);
                    setConditions(undefined);
                    setConsent(false);
                  }}
                />
              </fieldset>
              <button
                type="button"
                disabled={busy || !subscription || !lifetime.attempts}
                onClick={() => void run('conditions')}
              >
                Проверить условия записи
              </button>
              {conditions && (
                <label>
                  <input
                    type="checkbox"
                    checked={consent}
                    disabled={busy}
                    onChange={(e) => setConsent(e.currentTarget.checked)}
                  />
                  Подтверждаю запись по подписке, стоимость{' '}
                  {(conditions.price.amountMinor ?? 0) / 100} ₽
                </label>
              )}
            </>
          )}
          <button
            type="button"
            disabled={busy || !lifetime.attempts || (paid && (!consent || !conditions))}
            onClick={() => void run('submit')}
          >
            {paid ? 'Записаться по подписке' : 'Присоединиться к игре'}
          </button>
        </>
      )}
      {attempt && (
        <button
          type="button"
          disabled={busy || !lifetime.attempts}
          onClick={() => void run('read')}
        >
          Проверить запись
        </button>
      )}
      {pending && (!attempt.paid || attempt.operationId) && (
        <button
          type="button"
          disabled={busy || !lifetime.attempts}
          onClick={() => void run('retry')}
        >
          {attempt.paid ? 'Сверить исходную запись' : 'Повторить исходный запрос записи'}
        </button>
      )}
      {!lifetime.attempts && <p>Для безопасной записи требуется доступное хранилище приложения.</p>}
      {pending && !notice && <p role="status">Исходная запись ожидает подтверждения.</p>}
      {notice && <p role="status">{notice}</p>}
    </section>
  );
}
