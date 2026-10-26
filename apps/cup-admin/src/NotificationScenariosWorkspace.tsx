import { ApiClientError } from '@phub/api-sdk';
import type {
  NotificationScenarioInput,
  NotificationScenarioView,
  NotificationScenarioRunView,
} from '@phub/domain/notification-scenarios';
import { useCallback, useEffect, useRef, useState } from 'react';

import type { NotificationAdminClient } from './notification-admin-client.js';

const labels: Record<string, string> = {
  BOOKING_CONFIRMED: 'Запись подтверждена',
  BOOKING_CHANGED: 'Запись изменена',
  BOOKING_CANCELLED: 'Запись отменена',
  BOOKING_STARTS: 'Относительно начала занятия',
  GAME_STARTS: 'Относительно начала игры',
  FRIEND_GAME_PUBLISHED: 'Друг опубликовал игру',
  FIRST_ATTENDANCE: 'Первое посещение',
  TRAINING_ATTENDED: 'Подтверждено посещение тренировки',
  SUBSCRIPTION_ENDS: 'Окончание подписки',
  BIRTHDAY: 'День рождения',
  MATCHING_GAME: 'Подходящая игра',
};
const states: Record<string, string> = {
  PENDING: 'Ожидает',
  EXTENDED_PENDING: 'Ожидает',
  CREATED: 'Создано',
  QUEUED: 'Передано в доставку',
  SUPPRESSED: 'Пропущено',
  CANCELLED: 'Отменено',
  EXPIRED: 'Срок истёк',
  NONE: 'Без цели',
  WAITING: 'Ожидаем действие',
  ACHIEVED: 'Цель достигнута',
  DELIVERED: 'Доставлено',
  SENT: 'Принято провайдером',
  SENDING: 'Отправляется',
  FAILED: 'Ошибка',
  DEAD: 'Доставка прекращена',
};
const reasons: Record<string, string> = {
  SCENARIO_REVISED: 'Сценарий изменён или приостановлен',
  SOURCE_CHANGED: 'Запись изменилась',
  GAME_CANCELLED: 'Игра отменена',
  GAME_UNAVAILABLE: 'Игра больше недоступна',
  SOURCE_STALE: 'Источник участников игры временно не подтверждён',
  RECIPIENT_NOT_PARTICIPATING: 'Участник больше не состоит в игре',
  RECIPIENT_UNBOUND: 'Не подтверждена связь участника с аккаунтом',
  AUDIENCE_CHANGED: 'Получатель больше не подходит',
  GOAL_ACHIEVED: 'Пользователь присоединился',
  MESSAGE_EXPIRED: 'Сообщение устарело',
  RECIPIENT_INACTIVE: 'Аккаунт неактивен',
  FREQUENCY_LIMIT: 'Достигнут лимит частоты',
  DUPLICATE_INVITATION: 'Приглашение уже отправлено',
  OPTED_OUT: 'Пользователь отключил канал',
  QUIET_HOURS: 'Тихие часы',
  QUIET_HOURS_DEFERRED: 'Push отложен до окончания тихих часов',
  NO_ALLOWED_CHANNEL: 'Нет доступного разрешённого канала',
  IN_APP_ONLY: 'Сообщение в центре уведомлений',
  SCENARIO_RUNTIME_DISABLED: 'Автоматическая отправка выключена',
};
const channelLabels = {
  IN_APP: 'Центр уведомлений',
  WEB_PUSH: 'Web Push',
  ANDROID_PUSH: 'Android Push',
  IOS_PUSH: 'iOS Push',
  EMAIL: 'Email',
  STAFF_TASK: 'Обращение сотруднику в ЦУП',
  SMS: 'SMS — заглушка',
  TELEGRAM: 'Telegram — заглушка',
} as const;
function blank(gameStartAvailable = false): NotificationScenarioInput {
  if (gameStartAvailable)
    return {
      name: 'Напоминание участнику о предстоящей игре',
      trigger: 'GAME_STARTS',
      delayMinutes: -60,
      ttlMinutes: 60,
      title: 'Скоро игра',
      body: '{{serviceTitle}} начнётся {{startsAt}}, {{locationName}}',
      channels: ['IN_APP'],
      quietHours: 'DEFER',
      dailyLimit: 10,
      goal: 'NONE',
      goalWindowMinutes: 1440,
      active: false,
    };
  return {
    name: '',
    trigger: 'BOOKING_STARTS',
    delayMinutes: -120,
    ttlMinutes: 120,
    title: 'Скоро тренировка',
    body: '{{serviceTitle}} начнётся {{startsAt}}, {{locationName}}',
    channels: ['IN_APP', 'WEB_PUSH', 'ANDROID_PUSH'],
    quietHours: 'DEFER',
    dailyLimit: 1,
    goal: 'NONE',
    goalWindowMinutes: 1440,
    active: false,
  };
}
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : 'Не удалось загрузить сценарии.';
}
function date(value: string): string {
  return new Intl.DateTimeFormat('ru-RU', { dateStyle: 'short', timeStyle: 'short' }).format(
    new Date(value),
  );
}
function preview(text: string): string {
  return text.replace(
    /\{\{\s*(serviceTitle|startsAt|locationName|gameId)\s*\}\}/g,
    (_match, key: string) =>
      ({
        serviceTitle: 'Групповая тренировка',
        startsAt: '22 октября, 19:00',
        locationName: 'Клуб',
        gameId: 'пример-игры',
      })[key] ?? '',
  );
}

type Client = Pick<
  NotificationAdminClient,
  'listNotificationScenarios' | 'saveNotificationScenario' | 'listNotificationScenarioRuns'
>;
export function NotificationScenariosWorkspace({
  client,
}: {
  readonly client: Client;
}): React.JSX.Element {
  const [items, setItems] = useState<readonly NotificationScenarioView[]>([]);
  const [catalog, setCatalog] = useState<
    readonly { type: string; available: boolean; reason: string | null }[]
  >([]);
  const [runtime, setRuntime] = useState(false);
  const [runs, setRuns] = useState<readonly NotificationScenarioRunView[]>([]);
  const [selected, setSelected] = useState<NotificationScenarioView>();
  const [definition, setDefinition] = useState<NotificationScenarioInput>(blank);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [uncertain, setUncertain] = useState(false);
  const [message, setMessage] = useState<string>();
  const pending = useRef<Parameters<Client['saveNotificationScenario']>[0] | undefined>(undefined);
  const reload = useCallback(async () => {
    const [state, journal] = await Promise.all([
      client.listNotificationScenarios(),
      client.listNotificationScenarioRuns(),
    ]);
    setItems(state.items);
    setCatalog(state.catalog);
    setRuntime(state.runtimeEnabled);
    setRuns(journal.items);
  }, [client]);
  useEffect(() => {
    let current = true;
    Promise.all([client.listNotificationScenarios(), client.listNotificationScenarioRuns()])
      .then(([state, journal]) => {
        if (current) {
          setItems(state.items);
          setCatalog(state.catalog);
          setRuntime(state.runtimeEnabled);
          setRuns(journal.items);
        }
      })
      .catch((error) => {
        if (current) setError(errorText(error));
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [client]);
  function change<K extends keyof NotificationScenarioInput>(
    field: K,
    value: NotificationScenarioInput[K],
  ): void {
    setDefinition((current) => ({ ...current, [field]: value }));
    setMessage(undefined);
  }
  async function save(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    setMessage(undefined);
    pending.current ??= {
      ...(selected ? { id: selected.id } : {}),
      expectedVersion: selected?.version ?? 0,
      definition,
      idempotencyKey: crypto.randomUUID(),
    };
    try {
      const saved = await client.saveNotificationScenario(pending.current);
      pending.current = undefined;
      setUncertain(false);
      setSelected(saved);
      setDefinition(saved.definition);
      setMessage(`Сохранена версия ${saved.version}.`);
      // A failed journal refresh must not turn an accepted command into an uncertain write.
      try {
        await reload();
      } catch (error) {
        setError(`Сценарий сохранён. ${errorText(error)}`);
      }
    } catch (error) {
      const definitive =
        error instanceof ApiClientError &&
        error.status >= 400 &&
        error.status < 500 &&
        error.status !== 408 &&
        error.status !== 429;
      if (definitive) {
        pending.current = undefined;
        setUncertain(false);
      } else setUncertain(true);
      setError(errorText(error));
    } finally {
      setBusy(false);
    }
  }
  function select(item?: NotificationScenarioView): void {
    if (busy || uncertain) return;
    setSelected(item);
    setDefinition(
      item?.definition ??
        blank(catalog.some((entry) => entry.type === 'GAME_STARTS' && entry.available)),
    );
    setError(undefined);
    setMessage(undefined);
  }
  return (
    <main className="workspace scenario-workspace">
      <header className="workspace-header">
        <div>
          <p className="eyebrow">Оповещения</p>
          <h1>Триггерные рассылки</h1>
          <p className="muted">Настройте событие, время, сообщение и ожидаемое действие.</p>
        </div>
      </header>
      {!runtime ? (
        <p className="notice">
          Автоматическая отправка выключена. Сценарии можно подготовить и сохранить.
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="notice danger">
          {error}
        </p>
      ) : null}
      {message ? (
        <p role="status" className="notice">
          {message}
        </p>
      ) : null}
      {loading ? (
        <p role="status">Загружаем сценарии…</p>
      ) : (
        <div className="scenario-grid">
          <section className="panel">
            <div className="section-heading">
              <h2>Сценарии</h2>
              <button type="button" disabled={busy || uncertain} onClick={() => select()}>
                Новый сценарий
              </button>
            </div>
            {items.length === 0 ? (
              <p className="muted">Пока нет сценариев. Создайте первый.</p>
            ) : (
              <ul className="scenario-list">
                {items.map((item) => (
                  <li key={item.id}>
                    <button
                      type="button"
                      aria-pressed={selected?.id === item.id}
                      disabled={busy || uncertain}
                      onClick={() => select(item)}
                    >
                      <strong>{item.definition.name}</strong>
                      <span>
                        {item.definition.active ? 'Активен' : 'Приостановлен'} · версия{' '}
                        {item.version}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <p className="muted">
              При изменении версии ожидающие отправки отменяются. Уже начатая внешняя отправка может
              завершиться.
            </p>
          </section>
          <form className="panel scenario-form" onSubmit={(event) => void save(event)}>
            <h2>{selected ? 'Редактирование сценария' : 'Новый сценарий'}</h2>
            <fieldset disabled={busy || uncertain}>
              <legend className="sr-only">Настройки сценария</legend>
              <label>
                Название
                <input
                  required
                  maxLength={120}
                  value={definition.name}
                  onChange={(e) => change('name', e.target.value)}
                />
              </label>
              <label>
                Триггер
                <select
                  value={definition.trigger}
                  onChange={(e) => {
                    const trigger = e.target.value as NotificationScenarioInput['trigger'];
                    setDefinition((current) => ({
                      ...current,
                      trigger,
                      delayMinutes: [
                        'BOOKING_STARTS',
                        'GAME_STARTS',
                        'SUBSCRIPTION_ENDS',
                        'BIRTHDAY',
                      ].includes(trigger)
                        ? trigger === 'GAME_STARTS'
                          ? -60
                          : -120
                        : 0,
                      goal: trigger === 'FRIEND_GAME_PUBLISHED' ? 'GAME_JOINED' : 'NONE',
                      channels:
                        trigger === 'FRIEND_GAME_PUBLISHED'
                          ? [...new Set([...current.channels, 'IN_APP' as const])]
                          : current.channels,
                    }));
                  }}
                >
                  {catalog.map((item) => (
                    <option key={item.type} value={item.type} disabled={!item.available}>
                      {labels[item.type] ?? item.type}
                      {!item.available ? ` — ${item.reason}` : ''}
                    </option>
                  ))}
                </select>
              </label>
              {definition.trigger === 'FRIEND_GAME_PUBLISHED' ? (
                <p className="muted">
                  Публичные игры друзей с доступным местом. Учитываются текущая дружба, уровень и
                  сохранённые предпочтения. Поддерживаются игры, опубликованные локальным контуром
                  LK2.
                </p>
              ) : null}
              <div className="scenario-fields">
                <label>
                  Сдвиг, минут
                  <input
                    type="number"
                    required
                    min={
                      ['BOOKING_STARTS', 'GAME_STARTS', 'SUBSCRIPTION_ENDS', 'BIRTHDAY'].includes(
                        definition.trigger,
                      )
                        ? -43200
                        : 0
                    }
                    max={43200}
                    value={definition.delayMinutes}
                    onChange={(e) => change('delayMinutes', Number(e.target.value))}
                  />
                  <small>Минус — до события, плюс — после события.</small>
                </label>
                <label>
                  Срок актуальности, минут
                  <input
                    type="number"
                    required
                    min={1}
                    max={43200}
                    value={definition.ttlMinutes}
                    onChange={(e) => change('ttlMinutes', Number(e.target.value))}
                  />
                </label>
              </div>
              <label>
                Заголовок
                <input
                  required
                  maxLength={300}
                  value={definition.title}
                  onChange={(e) => change('title', e.target.value)}
                />
              </label>
              <label>
                Текст
                <textarea
                  required
                  maxLength={8000}
                  value={definition.body}
                  onChange={(e) => change('body', e.target.value)}
                />
                <small>
                  Переменные: {'{{serviceTitle}}, {{startsAt}}, {{locationName}}, {{gameId}}'}.
                </small>
              </label>
              <fieldset>
                <legend>Каналы</legend>
                {(Object.keys(channelLabels) as (keyof typeof channelLabels)[]).map((channel) => (
                  <label className="scenario-checkbox" key={channel}>
                    <input
                      type="checkbox"
                      checked={definition.channels.includes(channel)}
                      aria-description={
                        channel === 'SMS' || channel === 'TELEGRAM'
                          ? 'Канал недоступен, подключение отложено'
                          : undefined
                      }
                      disabled={
                        channel === 'IN_APP' &&
                        (definition.channels.some(
                          (c) => c === 'ANDROID_PUSH' || c === 'IOS_PUSH',
                        ) ||
                          definition.goal !== 'NONE')
                      }
                      onChange={(e) =>
                        change(
                          'channels',
                          e.target.checked
                            ? [
                                ...new Set([
                                  ...definition.channels,
                                  ...(channel === 'ANDROID_PUSH' || channel === 'IOS_PUSH'
                                    ? ['IN_APP' as const]
                                    : []),
                                  channel,
                                ]),
                              ]
                            : definition.channels.filter((c) => c !== channel),
                        )
                      }
                    />
                    {channelLabels[channel]}
                  </label>
                ))}
                <small>
                  Центр уведомлений и один доступный внешний канал: push или email. Приоритет
                  определяется порядком выбора. Обращение в ЦУП создаётся отдельно.
                </small>
              </fieldset>
              <label>
                Тихие часы
                <select
                  value={definition.quietHours}
                  onChange={(e) =>
                    change('quietHours', e.target.value as NotificationScenarioInput['quietHours'])
                  }
                >
                  <option value="DEFER">Отложить push или email до разрешённого времени</option>
                  <option value="SKIP">Пропустить push или email</option>
                </select>
              </label>
              {definition.trigger === 'FRIEND_GAME_PUBLISHED' ? (
                <>
                  <label>
                    Лимит рекомендаций за 24 часа
                    <input
                      type="number"
                      required
                      min={1}
                      max={3}
                      value={definition.dailyLimit}
                      onChange={(e) => change('dailyLimit', Number(e.target.value))}
                    />
                  </label>
                  <label>
                    Цель
                    <select
                      value={definition.goal}
                      onChange={(e) =>
                        setDefinition((current) => ({
                          ...current,
                          goal: e.target.value as NotificationScenarioInput['goal'],
                          channels:
                            e.target.value !== 'NONE'
                              ? [...new Set([...current.channels, 'IN_APP' as const])]
                              : current.channels,
                        }))
                      }
                    >
                      <option value="NONE">Без целевого действия</option>
                      <option value="GAME_JOINED">Подтверждённое присоединение к игре</option>
                    </select>
                  </label>
                  {definition.goal !== 'NONE' ? (
                    <label>
                      Окно цели, минут
                      <input
                        type="number"
                        required
                        min={1}
                        max={43200}
                        value={definition.goalWindowMinutes}
                        onChange={(e) => change('goalWindowMinutes', Number(e.target.value))}
                      />
                    </label>
                  ) : null}
                </>
              ) : null}
              <label className="scenario-checkbox">
                <input
                  type="checkbox"
                  checked={definition.active}
                  onChange={(e) => change('active', e.target.checked)}
                />
                Сценарий активен
              </label>
            </fieldset>
            <aside className="scenario-preview" aria-label="Предварительный просмотр">
              <small>Пример с вымышленными данными · без отправки</small>
              <strong>{preview(definition.title)}</strong>
              <p>{preview(definition.body)}</p>
            </aside>
            {uncertain ? (
              <p role="status">
                Результат сохранения пока не подтверждён. Повторите ту же команду, чтобы получить её
                результат.
              </p>
            ) : null}
            <button
              className="primary-button"
              type="submit"
              disabled={busy || definition.channels.length === 0}
            >
              {busy ? 'Сохраняем…' : uncertain ? 'Проверить сохранение' : 'Сохранить сценарий'}
            </button>
          </form>
        </div>
      )}
      <section className="panel scenario-journal">
        <div className="section-heading">
          <h2>Журнал запусков</h2>
          <button
            className="secondary-button"
            type="button"
            disabled={busy || loading}
            onClick={() => {
              setError(undefined);
              void reload().catch((error) => setError(errorText(error)));
            }}
          >
            Обновить журнал
          </button>
        </div>
        <p className="muted">
          Последние 100 запусков. Приём провайдером, доставка и достижение цели учитываются
          отдельно.
        </p>
        {runs.length === 0 ? (
          <p>Запусков пока нет.</p>
        ) : (
          <div className="scenario-table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">Сценарий</th>
                  <th scope="col">Получатель</th>
                  <th scope="col">Время</th>
                  <th scope="col">Решение</th>
                  <th scope="col">Доставка</th>
                  <th scope="col">Цель</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => (
                  <tr key={run.id}>
                    <td>
                      {items.find((s) => s.id === run.scenarioId)?.definition.name ?? 'Сценарий'} ·
                      v{run.scenarioVersion}
                    </td>
                    <td>
                      <code>{run.recipientUserId}</code>
                    </td>
                    <td>{date(run.dueAt)}</td>
                    <td>
                      {states[run.state] ?? run.state}
                      {run.reason ? <small>{reasons[run.reason] ?? run.reason}</small> : null}
                    </td>
                    <td>
                      {run.deliveryStates.map((d) => (
                        <div key={`${d.channel}:${d.state}:${d.errorCode ?? ''}`}>
                          {d.channel === 'IN_APP'
                            ? 'В кабинете'
                            : d.channel === 'EMAIL'
                              ? 'Email'
                              : d.channel === 'STAFF_TASK'
                                ? 'Обращение в ЦУП'
                                : 'Push'}
                          :{' '}
                          {d.errorCode?.endsWith('_OUTCOME_UNKNOWN')
                            ? 'Результат неизвестен, без автоматического повтора'
                            : (states[d.state] ?? d.state)}{' '}
                          ({d.count})
                        </div>
                      ))}
                    </td>
                    <td>
                      {states[run.goalState] ?? run.goalState}
                      {run.goalAchievedAt ? <small>{date(run.goalAchievedAt)}</small> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}
