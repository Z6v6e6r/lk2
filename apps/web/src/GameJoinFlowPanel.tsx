import { useId } from 'react';

import type { GameJoinFlowState } from './game-join-flow.js';

function formatPrice(amountMinor: number): string {
  return new Intl.NumberFormat('ru-RU', {
    style: 'currency',
    currency: 'RUB',
    maximumFractionDigits: 2,
  }).format(amountMinor / 100);
}

/**
 * Consent and recovery states for a paid JOIN. The amount is always the server-owned amount; this
 * component never computes, guesses or stores a price. After an unknown outcome it offers only a
 * status check — never a replacement purchase.
 */
export function GameJoinFlowPanel(props: {
  readonly flow: GameJoinFlowState;
  readonly busy: boolean;
  readonly onConfirmConsent?: (consent: {
    readonly amountMinor: number;
    readonly currency: 'RUB';
  }) => void;
  readonly onCancelConsent?: () => void;
  readonly onCheckStatus?: () => void;
  readonly onRetry?: () => void;
}): React.JSX.Element | null {
  const id = useId();
  const { flow, busy } = props;
  switch (flow.kind) {
    case 'IDLE':
    case 'SUCCEEDED':
      return null;
    case 'CHECKING_CONDITIONS':
      return (
        <section className="game-detail-card game-join-flow" aria-labelledby={`${id}-title`}>
          <h2 id={`${id}-title`}>Проверяем условия</h2>
          <p role="status">
            {flow.reason === 'PRICE_CHANGED'
              ? 'Цена обновилась. Проверяем актуальную стоимость…'
              : 'Проверяем цену и применимость подписки…'}
          </p>
        </section>
      );
    case 'NEEDS_SUBSCRIPTION':
      return (
        <section className="game-detail-card game-join-flow" aria-labelledby={`${id}-title`}>
          <h2 id={`${id}-title`}>Нужна подписка</h2>
          <p role="status">{flow.message}</p>
        </section>
      );
    case 'NEEDS_CONSENT':
      return (
        <section
          className="game-detail-card game-join-flow"
          aria-labelledby={`${id}-title`}
          aria-busy={busy}
        >
          <h2 id={`${id}-title`}>Подтверждение стоимости</h2>
          <p>
            Стоимость участия: <strong>{formatPrice(flow.consent.amountMinor)}</strong>
          </p>
          <p>
            Сервер повторно проверит цену и спишет её только после вашего подтверждения. Если цена
            изменится, потребуется новое подтверждение.
          </p>
          {flow.message ? <p role="alert">{flow.message}</p> : null}
          <div className="game-detail-actions">
            <button
              className="game-detail-primary"
              type="button"
              disabled={busy}
              onClick={() => props.onConfirmConsent?.(flow.consent)}
            >
              Подтвердить {formatPrice(flow.consent.amountMinor)}
            </button>
            <button
              className="game-detail-secondary"
              type="button"
              disabled={busy}
              onClick={() => props.onCancelConsent?.()}
            >
              Отмена
            </button>
          </div>
        </section>
      );
    case 'DISPATCHING':
      return (
        <section className="game-detail-card game-join-flow" aria-labelledby={`${id}-title`}>
          <h2 id={`${id}-title`}>Отправляем запись</h2>
          <p role="status">Не закрывайте страницу. Проверяем ответ сервера…</p>
        </section>
      );
    case 'WAIT_FOR_RECONCILIATION':
      return (
        <section className="game-detail-card game-join-flow" aria-labelledby={`${id}-title`}>
          <h2 id={`${id}-title`}>Проверяем статус оплаты</h2>
          <p role="status">{flow.message}</p>
          <div className="game-detail-actions">
            <button
              className="game-detail-secondary"
              type="button"
              disabled={busy}
              onClick={() => props.onCheckStatus?.()}
            >
              Проверить статус
            </button>
          </div>
        </section>
      );
    case 'SERVICE_BLOCKED':
      return (
        <section
          className="game-detail-card game-join-flow is-blocked"
          aria-labelledby={`${id}-title`}
        >
          <h2 id={`${id}-title`}>Услуга недоступна</h2>
          <p role="alert">{flow.message}</p>
        </section>
      );
    case 'PAYMENT_UNAVAILABLE':
      return (
        <section className="game-detail-card game-join-flow" aria-labelledby={`${id}-title`}>
          <h2 id={`${id}-title`}>Оплата пока недоступна</h2>
          <p role="alert">{flow.message}</p>
        </section>
      );
    case 'FAILED':
      return (
        <section className="game-detail-card game-join-flow" aria-labelledby={`${id}-title`}>
          <h2 id={`${id}-title`}>Не удалось записаться</h2>
          <p role="alert">{flow.message}</p>
          <div className="game-detail-actions">
            <button
              className="game-detail-secondary"
              type="button"
              disabled={busy}
              onClick={() => props.onRetry?.()}
            >
              Повторить проверку
            </button>
          </div>
        </section>
      );
  }
}
