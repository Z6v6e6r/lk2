import { useCallback, useEffect, useMemo, useState, useRef } from 'react';

import { GameCreationOperation } from './GameCreationOperation.js';
import { MainBottomNavigation } from './HomeDashboardPage.js';
import type { AuthGateway, CreateGameRequest, GameCommandResult } from './auth-gateway.js';
import {
  bindCreateGameOperation,
  browserCreateGameAttemptLockManager,
  clearCreateGameAttempt,
  CreateGameAttemptError,
  isCreateGameOperation,
  loadCreateGameAttempt,
  prepareCreateGameAttempt,
  resolveCreateGameAttempt,
  type CreateGameAttemptLockManager,
  type CreateGameAttemptPrincipal,
  type PendingCreateGameAttempt,
  type CreateGameAttempt,
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

function browserNavigate(url: string): void {
  window.location.assign(url);
}

export function CreateGamePage(
  props: Parameters<typeof CreateGamePageForPrincipal>[0],
): React.JSX.Element {
  return (
    <CreateGamePageForPrincipal
      key={`${props.principal.tenantId}:${props.principal.userId}`}
      {...props}
    />
  );
}

function CreateGamePageForPrincipal({
  gateway,
  principal,
  navigate = browserNavigate,
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
  const explicitNewIntent = useMemo(
    () =>
      typeof window !== 'undefined' &&
      new URLSearchParams(window.location.search).get('new') === '1',
    [],
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
  const restoredPending = restored.attempt?.state === 'PENDING' ? restored.attempt : null;
  const restoredResolved = restored.attempt?.state === 'RESOLVED' ? restored.attempt : null;
  const restoredPayload = restoredPending?.payload;
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
  const [courtId, setCourtId] = useState(restoredPayload?.courtId ?? '');
  const [testCourts, setTestCourts] = useState<
    Awaited<ReturnType<NonNullable<AuthGateway['listGameTestCourts']>>>['items']
  >([]);
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
    restoredPending,
  );
  const [busy, setBusy] = useState(
    Boolean(restoredPending || (restoredResolved && !explicitNewIntent)),
  );
  const [error, setError] = useState<string | null>(
    restored.error ? commandError(restored.error) : null,
  );
  const [notice, setNotice] = useState<string | null>(
    restoredPending
      ? 'Найдена исходная попытка. Проверяем её состояние без нового создания.'
      : null,
  );

  const [operationStatus, setOperationStatus] = useState<
    'ACCEPTED' | 'PROCESSING' | 'FAILED' | 'UNKNOWN' | null
  >(restoredPending?.operationId ? 'UNKNOWN' : null);

  const generation = useRef(0);
  const activeRead = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      generation.current += 1;
      activeRead.current?.abort();
    },
    [],
  );

  const applyResult = useCallback(
    async (result: GameCommandResult, attempt: CreateGameAttempt, token: number) => {
      if (token !== generation.current) return;
      if (
        !storage ||
        !isCreateGameOperation(result, attempt.operationId) ||
        (attempt.gameId && result.operation.gameId !== attempt.gameId) ||
        !('recovery' in result) ||
        (result.recovery as { paymentMode?: unknown } | null)?.paymentMode !== 'NO_PAYMENT'
      ) {
        setOperationStatus('UNKNOWN');
        setError('Ответ операции не подтверждён. Прежние параметры и ключ сохранены.');
        return;
      }
      if (attempt.state === 'RESOLVED') {
        if (result.operation.status !== 'SUCCEEDED') {
          setOperationStatus('UNKNOWN');
          return;
        }
        navigate(`/games/${encodeURIComponent(attempt.gameId)}?created=1&recovered=1`);
        return;
      }
      if (result.operation.status !== 'SUCCEEDED') {
        const bound = await bindCreateGameOperation(
          scopedPrincipal,
          attempt,
          result.operation.id,
          storage,
          lockManager,
          result.operation.gameId ?? undefined,
          () => token === generation.current,
        );
        if (token !== generation.current) return;
        setActiveAttempt(bound);
        setNotice(null);
        setOperationStatus(result.operation.status);
        return;
      }
      // This is success of the NO_PAYMENT beta command only, never booking confirmation.
      await resolveCreateGameAttempt(
        scopedPrincipal,
        attempt,
        result.operation.gameId!,
        storage,
        lockManager,
        { operationId: result.operation.id, isCurrent: () => token === generation.current },
      );
      if (token !== generation.current) return;
      setActiveAttempt(null);
      setOperationStatus(null);
      const recovered = result.replayed ? '&recovered=1' : '';
      navigate(
        `/games/${encodeURIComponent(result.operation.gameId!)}?created=1&revision=${result.operation.aggregateRevision}${recovered}`,
      );
    },
    [scopedPrincipal, storage, lockManager, navigate],
  );

  const checkOriginal = useCallback(
    async (attempt: CreateGameAttempt) => {
      const token = ++generation.current;
      activeRead.current?.abort();
      const controller = new AbortController();
      activeRead.current = controller;
      setBusy(true);
      setError(null);
      const timeout = setTimeout(() => controller.abort(), 8_000);
      try {
        if (!gateway.getGameCreateOperation) throw new Error('CREATE_READ_DISABLED');
        const aborted = new Promise<never>((_, reject) => {
          controller.signal.addEventListener(
            'abort',
            () => reject(new Error('CREATE_READ_TIMEOUT')),
            { once: true },
          );
        });
        const result = await Promise.race([
          gateway.getGameCreateOperation(attempt.idempotencyKey, controller.signal),
          aborted,
        ]);
        if (token === generation.current) await applyResult(result, attempt, token);
      } catch {
        if (token === generation.current) {
          setOperationStatus('UNKNOWN');
          setError(
            'Не удалось проверить прежнюю операцию. Результат неизвестен; исходный ключ сохранён. Новый запрос создания не отправлен.',
          );
        }
      } finally {
        clearTimeout(timeout);
        if (token === generation.current) {
          setBusy(false);
          setNotice(null);
        }
      }
    },
    [gateway, applyResult],
  );

  useEffect(() => {
    let current = true;
    queueMicrotask(() => {
      if (!current) return;
      if (restoredPending) void checkOriginal(restoredPending);
      else if (restoredResolved && !explicitNewIntent) void checkOriginal(restoredResolved);
    });
    return () => {
      current = false;
      generation.current += 1;
      activeRead.current?.abort();
    };
  }, [restoredPending, restoredResolved, explicitNewIntent, checkOriginal]);

  useEffect(() => {
    if (!explicitNewIntent || typeof window === 'undefined') return;
    const url = new URL(window.location.href);
    url.searchParams.delete('new');
    window.history.replaceState(
      window.history.state,
      '',
      `${url.pathname}${url.search}${url.hash}`,
    );
  }, [explicitNewIntent]);

  useEffect(() => {
    let active = true;
    void gateway.listGameTestCourts?.().then(
      (result) => {
        if (active) setTestCourts(result.items);
      },
      () => {
        if (active) setTestCourts([]);
      },
    );
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
    const recoveryAttempt = activeAttempt ?? (!explicitNewIntent ? restoredResolved : null);
    if (recoveryAttempt) {
      await checkOriginal(recoveryAttempt);
      return;
    }
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
    setOperationStatus(null);
    const start = new Date(startsAt);
    const end = new Date(endsAt);
    if (
      !activeAttempt?.operationId &&
      (!stationId ||
        !title.trim() ||
        Number.isNaN(start.getTime()) ||
        Number.isNaN(end.getTime()) ||
        end <= start ||
        (start <= new Date() && !activeAttempt))
    ) {
      setError('Проверьте название, станцию и будущее время игры.');
      return;
    }
    if (!activeAttempt?.operationId && ((levelFrom && !levelTo) || (!levelFrom && levelTo))) {
      setError('Укажите обе границы уровня или оставьте любой уровень.');
      return;
    }
    if (
      !activeAttempt?.operationId &&
      levelFrom &&
      levelTo &&
      LEVELS.indexOf(levelFrom as (typeof LEVELS)[number]) >
        LEVELS.indexOf(levelTo as (typeof LEVELS)[number])
    ) {
      setError('Начальный уровень не может быть выше конечного.');
      return;
    }
    const input: CreateGameRequest = activeAttempt?.operationId
      ? activeAttempt.payload
      : {
          title: title.trim(),
          kind: 'FRIENDLY',
          visibility,
          stationId,
          ...(courtId ? { courtId } : {}),
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
    const submitGeneration = generation.current;
    let attempt: PendingCreateGameAttempt | undefined;
    try {
      let createdHere = false;
      const prepared = await prepareCreateGameAttempt(
        scopedPrincipal,
        input,
        storage,
        lockManager,
        {
          mountedAttempt: activeAttempt,
          allowNewIntent: explicitNewIntent,
          onNewAttempt: () => {
            createdHere = true;
          },
        },
      );
      if (submitGeneration !== generation.current) return;
      if (prepared.state === 'RESOLVED') {
        await checkOriginal(prepared);
        return;
      }
      attempt = prepared;
      setActiveAttempt(prepared);
      // Another tab may already own this prepared key. Any saved attempt uses read only.
      if (!createdHere) {
        await checkOriginal(attempt);
        return;
      }
      const token = ++generation.current;
      const controller = new AbortController();
      activeRead.current = controller;
      const timeout = setTimeout(() => controller.abort(), 8_000);
      try {
        const aborted = new Promise<never>((_, reject) =>
          controller.signal.addEventListener(
            'abort',
            () => reject(new Error('CREATE_RESPONSE_TIMEOUT')),
            { once: true },
          ),
        );
        const result = await Promise.race([
          gateway.createGame(attempt.payload, {
            idempotencyKey: attempt.idempotencyKey,
            signal: controller.signal,
          }),
          aborted,
        ]);
        if (token !== generation.current) return;
        if (!isCreateGameOperation(result)) throw new Error('CREATE_RESPONSE_UNTRUSTED');
        const bound = await bindCreateGameOperation(
          scopedPrincipal,
          attempt,
          result.operation.id,
          storage,
          lockManager,
          result.operation.gameId ?? undefined,
          () => token === generation.current,
        );
        if (token !== generation.current) return;
        setActiveAttempt(bound);
        setOperationStatus(
          result.operation.status === 'SUCCEEDED' ? 'UNKNOWN' : result.operation.status,
        );
        await checkOriginal(bound);
      } finally {
        clearTimeout(timeout);
      }
      setBusy(false);
    } catch (cause) {
      if (attempt && !attempt.operationId && isTerminalNoCommitError(cause)) {
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
      } else if (attempt?.operationId) {
        setOperationStatus('UNKNOWN');
        setError('Не удалось проверить прежнюю операцию. Новый запрос создания не отправлен.');
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
  const stationTestCourts = testCourts.filter((court) => court.stationId === stationId);
  const selectedTestCourt = stationTestCourts.some((court) => court.id === courtId);

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

      <aside className="games-message" aria-label="Создание игры с бронированием">
        <strong>Игра с бронированием пока недоступна</strong>
        <p>
          Выбор разрешённого слота и подтверждение брони ещё не подключены. Форма ниже создаёт
          только beta-игру без бронирования корта.
        </p>
      </aside>
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
        {operationStatus ? <GameCreationOperation status={operationStatus} /> : null}
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
            onChange={(event) => {
              setStationId(event.target.value);
              setCourtId('');
            }}
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
        {stationTestCourts.length > 0 ? (
          <label>
            <span>Тестовый корт</span>
            <select
              value={courtId}
              onChange={(event) => {
                setCourtId(event.target.value);
                if (event.target.value) setVisibility('PRIVATE');
              }}
            >
              <option value="">Без выбора корта</option>
              {stationTestCourts.map((court) => (
                <option key={court.id} value={court.id}>
                  {court.title}
                </option>
              ))}
            </select>
          </label>
        ) : courtId && activeAttempt ? (
          <p className="games-message" role="status">
            Сохранённый корт оставлен для восстановления прежней попытки.
          </p>
        ) : null}
        {selectedTestCourt ? (
          <p className="games-message">
            Игра доступна только тестовым аккаунтам. Бронь корта в Viva не создаётся.
          </p>
        ) : null}
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
              disabled={selectedTestCourt}
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
          disabled={busy || (!activeAttempt && !restoredResolved && Boolean(locationsError))}
        >
          {busy
            ? 'Проверяем операцию…'
            : activeAttempt || (!explicitNewIntent && restoredResolved)
              ? 'Проверить прежнюю операцию'
              : 'Создать игру'}
        </button>
      </form>
      <MainBottomNavigation active="games" gamesDestination="games" />
    </main>
  );
}
