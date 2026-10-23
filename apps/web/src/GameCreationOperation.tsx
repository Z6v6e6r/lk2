export function GameCreationOperation({
  status,
}: {
  readonly status: 'ACCEPTED' | 'PROCESSING' | 'FAILED' | 'UNKNOWN';
}): React.JSX.Element {
  const message = {
    ACCEPTED: 'Запрос принят. Создание ещё не завершено; бронь корта не подтверждена.',
    PROCESSING: 'Операция обрабатывается. Бронь корта не подтверждена.',
    FAILED:
      'Операция завершилась с ошибкой. Бронь корта не подтверждена. Не создавайте новую попытку до проверки прежней.',
    UNKNOWN:
      'Результат операции пока неизвестен. Бронь корта не подтверждена. Проверьте прежнюю операцию.',
  }[status];
  return (
    <p className="games-message" role="status">
      {message}
    </p>
  );
}
