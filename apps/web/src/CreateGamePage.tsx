import { useEffect, useMemo, useState } from 'react';

import { MainBottomNavigation } from './HomeDashboardPage.js';
import type { AuthGateway, CreateGameRequest } from './auth-gateway.js';
import {
  browserCreateGameAttemptLockManager,
  clearCreateGameAttempt,
  CreateGameAttemptError,
  loadCreateGameAttempt,
  prepareCreateGameAttempt,
  type CreateGameAttemptLockManager,
  type CreateGameAttemptPrincipal,
  type PendingCreateGameAttempt,
} from './create-game-attempt.js';

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
  if (error instanceof CreateGameAttemptError) {
    if (error.code === 'ATTEMPT_PAYLOAD_CHANGED') {
      return 'Есть незавершённая попытка с другими параметрами. Верните сохранённые значения и повторите восстановление — новая команда не отправлена.';
    }
    if (error.code === 'ATTEMPT_MALFORMED' || error.code === 'ATTEMPT_FOREIGN_PRINCIPAL') {
      return 'Сохранённую попытку нельзя безопасно проверить. Новая команда не отправлена. Обновите страницу; если сообщение останется, обратитесь в поддержку.';
    }
    return 'Защищённое восстановление сейчас недоступно. Новая команда не отправлена. Обновите страницу и повторите.';
  }
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { readonly code?: unknown }).code;
    if (code === 'GAME_PAYMENT_REQUIRED') return 'Сейчас можно создать только бесплатную игру.';
    if (code === 'GAME_START_TIME_PASSED') return 'Время начала уже прошло.';
    if (code === 'IDEMPOTENCY_KEY_REUSED') {
      return 'Ключ незавершённой попытки уже связан с другими параметрами. Новая команда не отправлена; обратитесь в поддержку.';
    }
    if (code === 'INVALID_REQUEST') return 'Проверьте обязательные поля и время игры.';
  }
  return 'Не удалось создать игру. Проверьте связь и повторите.';
}

function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error
    ? (error as { readonly code?: unknown }).code
    : undefined;
}

function isTerminalNoCommitError(error: unknown): boolean {
  return errorCode(error) === 'GAME_START_TIME_PASSED';
}

function browserAttemptStorage(): Storage | undefined {
  if (typeof window === 'undefined') return undefined;
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

export function CreateGamePage({
  gateway,
  principal,
  navigate = (url) => window.location.assign(url),
  attemptStorage,
  attemptLockManager,
}: {
  readonly gateway: AuthGateway;
  readonly principal: CreateGameAttemptPrincipal;
  readonly navigate?: (url: string) => void;
  readonly attemptStorage?: Storage;
  readonly attemptLockManager?: CreateGameAttemptLockManager;
}): React.JSX.Element {
  const tenantId = principal.tenantId;
  const userId = principal.userId;
  const scopedPrincipal = useMemo(() => ({ tenantId, userId }), [tenantId, userId]);
  const storage = useMemo(() => attemptStorage ?? browserAttemptStorage(), [attemptStorage]);
  const lockManager = useMemo(
    () => attemptLockManager ?? browserCreateGameAttemptLockManager(),
    [attemptLockManager],
  );
  const restored = useMemo(() => {
    if (!storage) {
      return {
        attempt: null,
        error: new CreateGameAttemptError('ATTEMPT_STORAGE_UNAVAILABLE'),
      };
    }
    try {
      return { attempt: loadCreateGameAttempt(scopedPrincipal, storage), error: null };
    } catch (error) {
      return { attempt: null, error: error as Error };
    }
  }, [scopedPrincipal, storage]);
  const restoredPayload = restored.attempt?.payload;
  const defaults = useMemo(() => {
    if (!restoredPayload) return initialTimes();
    return {
      startsAt: localDateTime(new Date(restoredPayload.startsAt)),
      endsAt: localDateTime(new Date(restoredPayload.endsAt)),
    };
  }, [restoredPayload]);
  const [locations, setLocations] = useState<
    Awaited<ReturnType<AuthGateway['listLocations']>>['items']
  >([]);
  const [locationsError, setLocationsError] = useState<string | null>(null);
  const [title, setTitle] = useState(restoredPayload?.title ?? 'Открытая игра');
  const [stationId, setStationId] = useState(restoredPayload?.stationId ?? '');
  const [startsAt, setStartsAt] = useState(defaults.startsAt);
  const [endsAt, setEndsAt] = useState(defaults.endsAt);
  const [capacity, setCapacity] = useState<2 | 4>(restoredPayload?.capacity ?? 4);
  const [visibility, setVisibility] = useState<'PUBLIC' | 'PRIVATE'>(
    restoredPayload?.visibility === 'PRIVATE' ? 'PRIVATE' : 'PUBLIC',
  );
  const [levelFrom, setLevelFrom] = useState(restoredPayload?.levelRange?.from ?? '');
  const [levelTo, setLevelTo] = useState(restoredPayload?.levelRange?.to ?? '');
  const [waitlistEnabled, setWaitlistEnabled] = useState(restoredPayload?.waitlistEnabled ?? true);
  const [activeAttempt, setActiveAttempt] = useState<PendingCreateGameAttempt | null>(
    restored.attempt,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(
    restored.error ? commandError(restored.error) : null,
  );
  const [notice, setNotice] = useState<string | null>(
    restored.attempt
      ? 'Найдена незавершённая попытка. Проверьте сохранённые параметры и повторите восстановление тем же ключом.'
      : null,
  );

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
    if (!storage || !lockManager || restored.error) {
      setError(
        commandError(
          restored.error ??
            new CreateGameAttemptError(
              storage ? 'ATTEMPT_LOCK_UNAVAILABLE' : 'ATTEMPT_STORAGE_UNAVAILABLE',
            ),
        ),
      );
      return;
    }
    setError(null);
    setNotice(null);
    const start = new Date(startsAt);
    const end = new Date(endsAt);
    if (
      !stationId ||
      !title.trim() ||
      Number.isNaN(start.getTime()) ||
      Number.isNaN(end.getTime()) ||
      end <= start ||
      (start <= new Date() && !activeAttempt)
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
      timezone:
        restoredPayload?.timezone ??
        Intl.DateTimeFormat().resolvedOptions().timeZone ??
        'Europe/Moscow',
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
    let attempt: PendingCreateGameAttempt | undefined;
    try {
      attempt = await prepareCreateGameAttempt(scopedPrincipal, input, storage, lockManager);
      setActiveAttempt(attempt);
      const result = await gateway.createGame(attempt.payload, {
        idempotencyKey: attempt.idempotencyKey,
      });
      if (result.operation.status === 'FAILED') {
        const failure = Object.assign(new Error('Create game failed'), {
          code: result.operation.error?.code,
        });
        if (isTerminalNoCommitError(failure)) {
          await clearCreateGameAttempt(scopedPrincipal, attempt, storage, lockManager);
          setActiveAttempt(null);
          setError(`Создание отклонено: ${commandError(failure)} Игра не создана.`);
        } else if (errorCode(failure) === 'IDEMPOTENCY_KEY_REUSED') {
          setError(commandError(failure));
        } else {
          setError(
            'Ответ о создании не подтверждён. Сохранённые параметры и ключ оставлены для безопасного повтора.',
          );
        }
        setBusy(false);
        return;
      }
      if (
        !result.operation.gameId ||
        ['ACCEPTED', 'PROCESSING'].includes(result.operation.status)
      ) {
        setError(
          'Ответ о создании не подтверждён. Сохранённые параметры и ключ оставлены для безопасного повтора.',
        );
        setBusy(false);
        return;
      }
      await clearCreateGameAttempt(scopedPrincipal, attempt, storage, lockManager);
      setActiveAttempt(null);
      const recovered = result.replayed ? '&recovered=1' : '';
      navigate(`/games/${encodeURIComponent(result.operation.gameId)}?created=1${recovered}`);
    } catch (cause) {
      if (attempt && isTerminalNoCommitError(cause)) {
        try {
          await clearCreateGameAttempt(scopedPrincipal, attempt, storage, lockManager);
          setActiveAttempt(null);
          setError(`Создание отклонено: ${commandError(cause)} Игра не создана.`);
        } catch (storageError) {
          setError(commandError(storageError));
        }
      } else if (cause instanceof CreateGameAttemptError) {
        setError(commandError(cause));
      } else if (errorCode(cause) === 'IDEMPOTENCY_KEY_REUSED') {
        setError(commandError(cause));
      } else {
        setError(
          'Связь прервалась, результат неизвестен. Сохранённые параметры и ключ оставлены — повторите восстановление.',
        );
      }
      setBusy(false);
    }
  }

  const restoredStationUnavailable =
    Boolean(activeAttempt) &&
    Boolean(stationId) &&
    locations.length > 0 &&
    !locations.some((location) => location.id === stationId);

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
        {notice ? (
          <p className="games-message" role="status">
            {notice}
          </p>
        ) : null}
        {restoredStationUnavailable ? (
          <p className="games-message" role="status">
            Сохранённая станция больше не отображается в списке. Она оставлена только для точного
            восстановления прежней попытки.
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
            {restoredStationUnavailable ? (
              <option value={stationId}>Сохранённая станция (нет в списке)</option>
            ) : null}
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
