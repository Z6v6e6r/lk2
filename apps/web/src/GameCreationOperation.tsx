import { parseBookedGameNonFinalOperation } from '../../../packages/games/src/booked-game-consumer-contract.js';

type Original = Parameters<typeof parseBookedGameNonFinalOperation>[1];

// The commercial reader is not wired yet. This component consumes only the pinned
// owner's nonfinal contract and cannot grant success or select financial rules.
export function GameCreationOperation({
  status,
  booked,
}: {
  readonly status?: 'ACCEPTED' | 'PROCESSING' | 'FAILED' | 'UNKNOWN';
  readonly booked?: { readonly value: unknown; readonly original: Original };
}): React.JSX.Element {
  let operation;
  let invalid = false;
  if (booked) {
    try {
      operation = parseBookedGameNonFinalOperation(booked.value, booked.original);
    } catch {
      invalid = true;
    }
  }
  const processing = operation?.status ?? status ?? 'UNKNOWN';
  const message = {
    ACCEPTED: 'Запрос принят. Создание ещё не завершено; бронь корта не подтверждена.',
    PROCESSING: 'Операция обрабатывается. Бронь корта не подтверждена.',
    FAILED:
      'Операция завершилась с ошибкой. Бронь корта не подтверждена. Проверьте исходную операцию.',
    UNKNOWN:
      'Результат операции пока неизвестен. Бронь корта не подтверждена. Проверьте прежнюю операцию.',
    SUCCEEDED: 'Результат операции пока неизвестен.',
  }[processing];
  const booking = {
    NONE: 'Не подтверждено',
    UNKNOWN: 'Неизвестно',
    PENDING_CONFIRMATION: 'Ожидает подтверждения',
    FAILED: 'Ошибка',
    CONFIRMED: 'Подтверждено',
  }[operation?.booking.status ?? 'UNKNOWN'];
  const benefit = {
    UNKNOWN: 'Неизвестно',
    RESERVED: 'Зарезервирована',
    REJECTED: 'Отклонена',
    APPLIED: 'Применена',
  }[operation?.benefit?.status ?? 'UNKNOWN'];
  const settlement = {
    UNKNOWN: 'Неизвестно',
    REJECTED: 'Отклонён',
    CONFIRMED: 'Подтверждён',
    PAYMENT_REQUIRED: 'Требуется оплата',
  }[operation?.settlement?.status ?? 'UNKNOWN'];
  return (
    <section className="games-message" aria-label="Состояние исходной операции" role="status">
      <p>
        {invalid
          ? 'Ответ операции не подтверждён. Исходная связь сохранена; результат неизвестен.'
          : operation
            ? 'Операция не завершена. Ниже — раздельные сведения исходной операции.'
            : message}
      </p>
      <dl>
        <dt>Обработка операции</dt>
        <dd>{processing}</dd>
        <dt>Бронирование</dt>
        <dd>{booking}</dd>
        <dt>Применение льготы</dt>
        <dd>{benefit}</dd>
        <dt>Расчёт</dt>
        <dd>{settlement}</dd>
      </dl>
      {operation?.gameId ? (
        <p>Связанная игра: {operation.gameId}. Наличие игры не подтверждает завершение операции.</p>
      ) : null}
    </section>
  );
}
