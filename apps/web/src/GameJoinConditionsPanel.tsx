import { useEffect, useState } from 'react';
import type { GameJoinConditions, PadlHubApiClient } from '@phub/api-sdk';

export type GameJoinConditionsClient = Pick<PadlHubApiClient, 'getGameJoinConditions'>;

interface PanelProps {
  readonly gameId: string;
  readonly revision: number;
  readonly subscriptionInstanceId?: string;
  readonly client?: GameJoinConditionsClient;
}
export function GameJoinConditionsPanel(props: PanelProps): React.JSX.Element {
  const [refresh, setRefresh] = useState(0);
  return (
    <ConditionsContent
      key={`${props.gameId}:${props.revision}:${props.subscriptionInstanceId ?? ''}:${refresh}`}
      {...props}
      onRefresh={() => setRefresh((value) => value + 1)}
    />
  );
}
function ConditionsContent(
  props: PanelProps & { readonly onRefresh: () => void },
): React.JSX.Element {
  const { gameId, revision, subscriptionInstanceId, client } = props;
  const [result, setResult] = useState<GameJoinConditions | null>(null);
  const [loading, setLoading] = useState(Boolean(client && subscriptionInstanceId));
  const [error, setError] = useState(false);
  const [expired, setExpired] = useState(false);
  useEffect(() => {
    let disposed = false;
    if (!client || !subscriptionInstanceId) {
      return;
    }
    void client
      .getGameJoinConditions(gameId, { expectedRevision: revision, subscriptionInstanceId })
      .then((quote) => {
        if (disposed) return;
        if (
          quote.gameId !== gameId ||
          quote.revision !== revision ||
          quote.subscriptionInstanceId !== subscriptionInstanceId ||
          !Number.isFinite(Date.parse(quote.expiresAt)) ||
          Date.parse(quote.expiresAt) <= Date.now()
        ) {
          setError(true);
          return;
        }
        setResult(quote);
      })
      .catch(() => {
        if (!disposed) setError(true);
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, [client, gameId, revision, subscriptionInstanceId]);
  useEffect(() => {
    if (!result) return;
    const timer = setTimeout(
      () => setExpired(true),
      Math.max(0, Date.parse(result.expiresAt) - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [result]);
  // Hide a response synchronously when the parent changes selection/revision, before effects run.
  const current =
    result?.gameId === gameId &&
    result.revision === revision &&
    result.subscriptionInstanceId === subscriptionInstanceId &&
    !expired
      ? result
      : null;
  const denialLabels: Readonly<Record<string, string>> = {
    SUBSCRIPTION_EXPIRED: 'Срок действия подписки истёк.',
    SUBSCRIPTION_NOT_OWNED_OR_UNAVAILABLE: 'Выбранная подписка недоступна для этой игры.',
  };
  const money = current?.price.amountMinor;
  const validAmount = typeof money === 'number' && Number.isSafeInteger(money) && money >= 0;
  return (
    <section className="game-detail-card" aria-labelledby="game-join-conditions-title">
      <h2 id="game-join-conditions-title">Мои условия участия</h2>
      <div role="status" aria-live="polite">
        {!client || !subscriptionInstanceId ? (
          <p>Проверка выбранной подписки пока недоступна. Цена не подтверждена.</p>
        ) : loading ? (
          <p>Проверяем подписку…</p>
        ) : error ? (
          <p>Условия и цена не подтверждены. Повторите проверку.</p>
        ) : expired ? (
          <p>Срок проверки истёк. Обновите условия.</p>
        ) : current ? (
          <>
            {current.providerMode === 'MOCK' ? <p>Тестовый контур · provider mock</p> : null}
            <p>
              {current.eligibility === 'AVAILABLE'
                ? current.subscriptionApplied
                  ? 'Подписка применима к этой игре.'
                  : 'Применимость подписки требует подтверждения.'
                : 'Подписка не применяется к этой игре.'}
            </p>
            {current.reasonCode ? (
              <p>
                {denialLabels[current.reasonCode] ??
                  'Сервер не подтвердил применение выбранной подписки.'}
              </p>
            ) : null}
            <p>
              {validAmount
                ? `Предварительная цена: ${new Intl.NumberFormat('ru-RU', {
                    style: 'currency',
                    currency: 'RUB',
                    maximumFractionDigits: 2,
                  }).format(money / 100)}. Цена не подтверждена для оплаты.`
                : 'Цена не подтверждена.'}
            </p>
            <p>
              Бесплатные минуты: {current.freeMinutes}. Платные минуты: {current.paidMinutes}.
            </p>
            <p>Ревизия игры ЛК2: {current.revision}. Ревизия ответа ЛК1 не предоставлена.</p>
            <p>
              Проверка действует до{' '}
              <time dateTime={current.expiresAt}>
                {new Intl.DateTimeFormat('ru-RU', {
                  hour: '2-digit',
                  minute: '2-digit',
                  second: '2-digit',
                  timeZone: 'Europe/Moscow',
                }).format(new Date(current.expiresAt))}{' '}
                МСК
              </time>
              .
            </p>
            <p>Перед записью сервер повторно проверит условия.</p>
          </>
        ) : (
          <p>Цена не подтверждена.</p>
        )}
      </div>
      {client && subscriptionInstanceId ? (
        <button type="button" disabled={loading} onClick={props.onRefresh}>
          Обновить условия
        </button>
      ) : null}
    </section>
  );
}
