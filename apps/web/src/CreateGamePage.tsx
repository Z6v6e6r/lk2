import { useEffect, useMemo, useState } from 'react';

import { MainBottomNavigation } from './HomeDashboardPage.js';
import type { AuthGateway, CreateGameRequest } from './auth-gateway.js';

const LEVELS = ['D', 'D+', 'C', 'C+', 'B', 'B+', 'A'] as const;

function localDateTime(date: Date): string {
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function initialTimes(): { startsAt: string; endsAt: string } {
  const start = new Date();
  start.setDate(start.getDate() + 1);
  start.setHours(18, 0, 0, 0);
  const end = new Date(start.getTime() + 90 * 60_000);
  return { startsAt: localDateTime(start), endsAt: localDateTime(end) };
}

function commandError(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { readonly code?: unknown }).code;
    if (code === 'GAME_PAYMENT_REQUIRED') return 'Сейчас можно создать только бесплатную игру.';
    if (code === 'IDEMPOTENCY_KEY_REUSED') return 'Команда уже изменилась. Обновите страницу.';
    if (code === 'INVALID_REQUEST') return 'Проверьте обязательные поля и время игры.';
  }
  return 'Не удалось создать игру. Проверьте связь и повторите.';
}

export function CreateGamePage({
  gateway,
  navigate = (url) => window.location.assign(url),
}: {
  readonly gateway: AuthGateway;
  readonly navigate?: (url: string) => void;
}): React.JSX.Element {
  const defaults = useMemo(() => initialTimes(), []);
  const [locations, setLocations] = useState<
    Awaited<ReturnType<AuthGateway['listLocations']>>['items']
  >([]);
  const [locationsError, setLocationsError] = useState<string | null>(null);
  const [title, setTitle] = useState('Открытая игра');
  const [stationId, setStationId] = useState('');
  const [startsAt, setStartsAt] = useState(defaults.startsAt);
  const [endsAt, setEndsAt] = useState(defaults.endsAt);
  const [capacity, setCapacity] = useState<2 | 4>(4);
  const [visibility, setVisibility] = useState<'PUBLIC' | 'PRIVATE'>('PUBLIC');
  const [levelFrom, setLevelFrom] = useState('');
  const [levelTo, setLevelTo] = useState('');
  const [waitlistEnabled, setWaitlistEnabled] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void gateway.listLocations().then(
      (result) => {
        if (!active) return;
        setLocations(result.items);
        setStationId((current) => current || result.items[0]?.id || '');
        setLocationsError(
          result.items.length > 0 ? null : 'Нет доступных станций для создания игры.',
        );
      },
      () => {
        if (active)
          setLocationsError('Не удалось загрузить станции. Вернитесь к играм и повторите.');
      },
    );
    return () => {
      active = false;
    };
  }, [gateway]);

  async function submit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (busy) return;
    setError(null);
    const start = new Date(startsAt);
    const end = new Date(endsAt);
    if (
      !stationId ||
      !title.trim() ||
      Number.isNaN(start.getTime()) ||
      end <= start ||
      start <= new Date()
    ) {
      setError('Проверьте название, станцию и будущее время игры.');
      return;
    }
    if ((levelFrom && !levelTo) || (!levelFrom && levelTo)) {
      setError('Укажите обе границы уровня или оставьте любой уровень.');
      return;
    }
    if (
      levelFrom &&
      levelTo &&
      LEVELS.indexOf(levelFrom as (typeof LEVELS)[number]) >
        LEVELS.indexOf(levelTo as (typeof LEVELS)[number])
    ) {
      setError('Начальный уровень не может быть выше конечного.');
      return;
    }
    const input: CreateGameRequest = {
      title: title.trim(),
      kind: 'FRIENDLY',
      visibility,
      stationId,
      startsAt: start.toISOString(),
      endsAt: end.toISOString(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Moscow',
      capacity,
      paymentMode: 'NO_PAYMENT',
      waitlistEnabled,
      levelRange:
        levelFrom && levelTo
          ? {
              from: levelFrom as (typeof LEVELS)[number],
              to: levelTo as (typeof LEVELS)[number],
            }
          : null,
    };
    setBusy(true);
    try {
      const result = await gateway.createGame(input);
      if (!result.operation.gameId || result.operation.status === 'FAILED') {
        throw Object.assign(new Error('Create game failed'), {
          code: result.operation.error?.code,
        });
      }
      navigate(`/games/${encodeURIComponent(result.operation.gameId)}?created=1`);
    } catch (cause) {
      setError(commandError(cause));
      setBusy(false);
    }
  }

  return (
    <main className="games-page games-page--create">
      <header className="games-header">
        <a className="games-back" href="/games" aria-label="Назад к играм">
          <span aria-hidden="true">←</span>
          Назад
        </a>
        <div>
          <h1>Создать игру</h1>
          <p>Бесплатный beta-сценарий без бронирования и оплаты</p>
        </div>
      </header>

      <form className="game-create-form" onSubmit={(event) => void submit(event)} noValidate>
        {locationsError ? (
          <p className="games-message is-error" role="alert">
            {locationsError}
          </p>
        ) : null}
        {error ? (
          <p className="games-message is-error" role="alert">
            {error}
          </p>
        ) : null}

        <label>
          <span>Название</span>
          <input
            value={title}
            maxLength={160}
            required
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>
        <label>
          <span>Станция</span>
          <select
            value={stationId}
            required
            disabled={locations.length === 0}
            onChange={(event) => setStationId(event.target.value)}
          >
            {locations.map((location) => (
              <option value={location.id} key={location.id}>
                {location.title}
              </option>
            ))}
          </select>
        </label>
        <div className="game-create-form__row">
          <label>
            <span>Начало</span>
            <input
              type="datetime-local"
              value={startsAt}
              required
              onChange={(event) => setStartsAt(event.target.value)}
            />
          </label>
          <label>
            <span>Окончание</span>
            <input
              type="datetime-local"
              value={endsAt}
              required
              onChange={(event) => setEndsAt(event.target.value)}
            />
          </label>
        </div>
        <div className="game-create-form__row">
          <label>
            <span>Игроков</span>
            <select
              value={capacity}
              onChange={(event) => setCapacity(Number(event.target.value) as 2 | 4)}
            >
              <option value={2}>2 игрока</option>
              <option value={4}>4 игрока</option>
            </select>
          </label>
          <label>
            <span>Доступ</span>
            <select
              value={visibility}
              onChange={(event) => setVisibility(event.target.value as 'PUBLIC' | 'PRIVATE')}
            >
              <option value="PUBLIC">Открытая</option>
              <option value="PRIVATE">По ссылке</option>
            </select>
          </label>
        </div>
        <fieldset>
          <legend>Уровень</legend>
          <div className="game-create-form__row">
            <label>
              <span>От</span>
              <select value={levelFrom} onChange={(event) => setLevelFrom(event.target.value)}>
                <option value="">Любой</option>
                {LEVELS.map((level) => (
                  <option value={level} key={level}>
                    {level}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>До</span>
              <select value={levelTo} onChange={(event) => setLevelTo(event.target.value)}>
                <option value="">Любой</option>
                {LEVELS.map((level) => (
                  <option value={level} key={level}>
                    {level}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </fieldset>
        <div className="game-create-form__summary">
          <strong>Стоимость: бесплатно</strong>
          <span>Платёжный и provider-контур не используется.</span>
        </div>
        <label className="game-create-form__check">
          <input
            type="checkbox"
            checked={waitlistEnabled}
            onChange={(event) => setWaitlistEnabled(event.target.checked)}
          />
          <span>Включить лист ожидания</span>
        </label>
        <button
          className="game-detail-primary"
          type="submit"
          disabled={busy || Boolean(locationsError)}
        >
          {busy ? 'Создаём игру…' : 'Создать игру'}
        </button>
      </form>
      <MainBottomNavigation active="games" gamesDestination="games" />
    </main>
  );
}
