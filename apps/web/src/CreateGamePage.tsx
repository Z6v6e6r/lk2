import { QuarterCreatePanel } from './QuarterCreatePanel.js';
import { quarterBrowserStorage, quarterStorageKey } from './quarter-create-attempt.js';
import { useEffect, useMemo, useRef, useState } from 'react';

import { MainBottomNavigation } from './HomeDashboardPage.js';
import type { AuthGateway, CreateGameRequest } from './auth-gateway.js';
import {
  browserCreateGameAttemptLockManager,
  clearCreateGameAttempt,
  CreateGameAttemptError,
  isPendingConfirmationAttempt,
  loadCreateGameAttempt,
  prepareCreateGameAttempt,
  recordCreateGameConfirmation,
  resolveCreateGameAttempt,
  type ActiveCreateGameAttempt,
  type CreateGameAttemptLockManager,
  type CreateGameAttemptPrincipal,
  type PendingConfirmationCreateGameAttempt,
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
    if (code === 'GAME_PAYMENT_MODE_MISMATCH')
      return 'Этот режим оплаты игры сейчас недоступен. Выберите другой вариант.';
    if (code === 'GAME_PRICE_CONFIRMATION_REQUIRED')
      return 'Цена изменилась или ещё не подтверждена. Подтвердите актуальную цену и повторите.';
    if (code === 'GAME_SUBSCRIPTION_SELECTION_REQUIRED')
      return 'Нужно выбрать подписку или другой способ оплаты.';
    if (code === 'GAME_SERVICE_BLOCKED')
      return 'Клуб не разрешает эту игру; оплата не снимает ограничение.';
    if (code === 'GAME_OWNER_UNAVAILABLE')
      return 'Статус создания не подтверждён. Сохранённые параметры и ключ оставлены — повторите проверку.';
    if (code === 'GAME_RECONCILIATION_REQUIRED')
      return 'Предыдущая попытка ещё не завершена. Дождитесь проверки статуса, новую игру не начинайте.';
    if (code === 'GAME_COMMERCIAL_ATTEMPT_CONFLICT')
      return 'Ключ незавершённой попытки уже связан с другой командой. Новая команда не отправлена.';
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

/**
 * Managed CREATE refusals that are decided before any durable local write. Clearing the saved
 * attempt is safe for these: the server created nothing, so the user may change the mode and retry.
 * Ambiguous outcomes (owner unavailable, reconciliation, key conflict) are never in this set.
 */
const TERMINAL_CREATE_REFUSALS: ReadonlySet<unknown> = new Set([
  'GAME_START_TIME_PASSED',
  'GAME_PAYMENT_REQUIRED',
  'GAME_PAYMENT_MODE_MISMATCH',
  'GAME_PRICE_CONFIRMATION_REQUIRED',
  'GAME_SUBSCRIPTION_SELECTION_REQUIRED',
  'GAME_SERVICE_BLOCKED',
]);

function isTerminalNoCommitError(error: unknown): boolean {
  return TERMINAL_CREATE_REFUSALS.has(errorCode(error));
}

/** Server codes with a precise, actionable copy. Anything else stays an unknown-outcome message. */
const KNOWN_CREATE_FAILURE_CODES: ReadonlySet<unknown> = new Set([
  ...TERMINAL_CREATE_REFUSALS,
  'IDEMPOTENCY_KEY_REUSED',
  'GAME_OWNER_UNAVAILABLE',
  'GAME_RECONCILIATION_REQUIRED',
  'GAME_COMMERCIAL_ATTEMPT_CONFLICT',
]);

function isKnownCreateFailureCode(code: unknown): boolean {
  return KNOWN_CREATE_FAILURE_CODES.has(code);
}

function browserAttemptStorage(): Storage | undefined {
  if (typeof window === 'undefined') return undefined;
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

function LegacyCreateGamePage({
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
  const explicitNewIntent = useMemo(
    () =>
      typeof window !== 'undefined' &&
      new URLSearchParams(window.location.search).get('new') === '1',
    [],
  );
  // WARN-era gate: the paid create options are offered only when the page is opened with an
  // explicit commercial-create intent and the gateway exposes the managed CREATE capability. The
  // default production UI therefore keeps offering the free beta scenario only. Remove this gate
  // when the server activates the managed create contour (ENFORCE approval).
  const paidCreateIntent = useMemo(
    () =>
      typeof window !== 'undefined' &&
      new URLSearchParams(window.location.search).get('commercialCreate') === '1',
    [],
  );
  const paidCreateAvailable = paidCreateIntent && typeof gateway.createPaidGame === 'function';
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
  const restoredConfirmation = isPendingConfirmationAttempt(restored.attempt)
    ? restored.attempt
    : null;
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
  const [paymentMode, setPaymentMode] = useState<'NO_PAYMENT' | 'SPLIT' | 'SUBSCRIPTION'>(
    restoredPayload?.paymentMode === 'SPLIT' || restoredPayload?.paymentMode === 'SUBSCRIPTION'
      ? restoredPayload.paymentMode
      : 'NO_PAYMENT',
  );
  const [activeAttempt, setActiveAttempt] = useState<ActiveCreateGameAttempt | null>(
    restoredPending ?? restoredConfirmation,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(
    restored.error ? commandError(restored.error) : null,
  );
  const [notice, setNotice] = useState<string | null>(
    restoredPending
      ? 'Найдена незавершённая попытка. Проверьте сохранённые параметры и повторите восстановление тем же ключом.'
      : restoredConfirmation
        ? 'Игра создана и ожидает подтверждения. Платёж и бронь не выполнены; проверьте статус операции.'
        : null,
  );

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
    if (!restoredResolved || explicitNewIntent || restoredConfirmation) return;
    navigate(`/games/${encodeURIComponent(restoredResolved.gameId)}?created=1&recovered=1`);
  }, [explicitNewIntent, navigate, restoredConfirmation, restoredResolved]);

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
    if (paymentMode !== 'NO_PAYMENT' && !gateway.createPaidGame) {
      setError('Платный режим на этом клиенте недоступен. Выберите бесплатную игру.');
      return;
    }
    const input: CreateGameRequest = {
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
      paymentMode,
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
      const prepared = await prepareCreateGameAttempt(
        scopedPrincipal,
        input,
        storage,
        lockManager,
        {
          mountedAttempt: activeAttempt,
          allowNewIntent: explicitNewIntent,
        },
      );
      if (prepared.state === 'RESOLVED') {
        setActiveAttempt(null);
        navigate(`/games/${encodeURIComponent(prepared.gameId)}?created=1&recovered=1`);
        setBusy(false);
        return;
      }
      if (prepared.state === 'PENDING_CONFIRMATION') {
        setActiveAttempt(prepared);
        setNotice(
          'Игра создана и ожидает подтверждения. Платёж и бронь не выполнены; проверьте статус операции.',
        );
        setBusy(false);
        return;
      }
      attempt = prepared;
      setActiveAttempt(prepared);
      const paid = attempt.payload.paymentMode !== 'NO_PAYMENT';
      const result =
        paid && gateway.createPaidGame
          ? await gateway.createPaidGame(attempt.payload, attempt.idempotencyKey)
          : await gateway.createGame(attempt.payload, {
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
      if (paid) {
        // The managed contour accepts the create but keeps the game PROVISIONING and the operation
        // unresolved. Record the acceptance and let the user re-read that operation; never resolve
        // it as a created/published game and never send a replacement POST.
        if (
          result.operation.gameId &&
          ['UNKNOWN', 'PROCESSING', 'ACCEPTED'].includes(result.operation.status)
        ) {
          const confirmation = await recordCreateGameConfirmation(
            scopedPrincipal,
            attempt,
            { gameId: result.operation.gameId, operationId: result.operation.id },
            storage,
            lockManager,
          );
          setActiveAttempt(confirmation);
          setNotice(
            'Игра создана и ожидает подтверждения. Платёж и бронь не выполнены; проверьте статус операции.',
          );
          setBusy(false);
          return;
        }
        if (result.operation.status === 'SUCCEEDED' && result.operation.gameId) {
          await resolveCreateGameAttempt(
            scopedPrincipal,
            attempt,
            result.operation.gameId,
            storage,
            lockManager,
          );
          setActiveAttempt(null);
          navigate(
            `/games/${encodeURIComponent(result.operation.gameId)}?created=1${
              result.replayed ? '&recovered=1' : ''
            }`,
          );
          setBusy(false);
          return;
        }
        setError(
          'Ответ о создании не подтверждён. Сохранённые параметры и ключ оставлены для безопасного повтора.',
        );
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
      await resolveCreateGameAttempt(
        scopedPrincipal,
        attempt,
        result.operation.gameId,
        storage,
        lockManager,
      );
      setActiveAttempt(null);
      const recovered = result.replayed ? '&recovered=1' : '';
      const revision = result.operation.aggregateRevision ?? 0;
      navigate(
        `/games/${encodeURIComponent(result.operation.gameId)}?created=1&revision=${revision}${recovered}`,
      );
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
      } else if (isKnownCreateFailureCode(errorCode(cause))) {
        setError(commandError(cause));
      } else {
        setError(
          'Связь прервалась, результат неизвестен. Сохранённые параметры и ключ оставлены — повторите восстановление.',
        );
      }
      setBusy(false);
    }
  }

  const activeConfirmation: PendingConfirmationCreateGameAttempt | null =
    isPendingConfirmationAttempt(activeAttempt) ? activeAttempt : null;
  const confirmationHeadingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (activeConfirmation) confirmationHeadingRef.current?.focus();
  }, [activeConfirmation]);

  async function checkConfirmation(): Promise<void> {
    const confirmation = activeConfirmation;
    if (!confirmation || busy) return;
    if (!storage || !lockManager) {
      setError(commandError(new CreateGameAttemptError('ATTEMPT_STORAGE_UNAVAILABLE')));
      return;
    }
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      const result = await gateway.getGameOperation(confirmation.operationId);
      // The readback must describe exactly the accepted operation and draft; anything else is a
      // conflict, never a reason to resolve, navigate or repeat a create.
      if (
        result.operation.type !== 'CREATE_GAME' ||
        result.operation.id !== confirmation.operationId
      ) {
        setError(
          'Статус операции не совпал с ожидаемым. Новая команда не отправлена; обратитесь в поддержку.',
        );
        return;
      }
      if (result.operation.status === 'FAILED') {
        await clearCreateGameAttempt(scopedPrincipal, confirmation, storage, lockManager);
        setActiveAttempt(null);
        setNotice(null);
        setError('Создание игры отклонено. Игра не создана.');
      } else if (result.operation.status === 'SUCCEEDED' && result.operation.gameId) {
        if (result.operation.gameId !== confirmation.gameId) {
          setError(
            'Подтверждённая игра не совпала с ожидаемой. Новая команда не отправлена; обратитесь в поддержку.',
          );
          return;
        }
        await resolveCreateGameAttempt(
          scopedPrincipal,
          confirmation,
          result.operation.gameId,
          storage,
          lockManager,
        );
        setActiveAttempt(null);
        navigate(`/games/${encodeURIComponent(result.operation.gameId)}?created=1&recovered=1`);
      } else {
        setNotice('Пока не подтверждено. Платёж и бронь не выполнены; проверьте статус позже.');
      }
    } catch {
      setNotice('Не удалось проверить статус. Повторите проверку позже.');
    } finally {
      setBusy(false);
    }
  }

  async function startAnotherGame(): Promise<void> {
    const confirmation = activeConfirmation;
    if (!confirmation || busy) return;
    if (!storage || !lockManager) return;
    setBusy(true);
    try {
      await clearCreateGameAttempt(scopedPrincipal, confirmation, storage, lockManager);
      setActiveAttempt(null);
      navigate(`/games/new?new=1${paidCreateAvailable ? '&commercialCreate=1' : ''}`);
    } catch (cause) {
      setError(commandError(cause));
    } finally {
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

  const pageHeader = (
    <header className="games-header">
      <a className="games-back" href="/games" aria-label="Назад к играм">
        <span aria-hidden="true">←</span>
        Назад
      </a>
      <div>
        <h1>{activeConfirmation ? 'Ожидание подтверждения' : 'Создать игру'}</h1>
        <p>
          {paidCreateAvailable
            ? 'Бесплатная игра и beta-режим по подписке без брони и списания'
            : 'Бесплатный beta-сценарий без бронирования и оплаты'}
        </p>
      </div>
    </header>
  );

  if (activeConfirmation) {
    return (
      <main className="games-page games-page--create">
        {pageHeader}
        <section className="game-create-form" aria-label="Ожидание подтверждения создания игры">
          <h2 ref={confirmationHeadingRef} tabIndex={-1}>
            Игра ожидает подтверждения
          </h2>
          <p className="games-message" role="status">
            Платёж и бронь не выполнены. Игра появится в списке после подтверждения операции. Не
            создавайте новую игру с другими параметрами, пока эта операция не завершена.
          </p>
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
          <button
            className="game-detail-primary"
            type="button"
            disabled={busy}
            onClick={() => void checkConfirmation()}
          >
            {busy ? 'Проверяем статус…' : 'Проверить статус'}
          </button>
          <button
            className="game-detail-secondary"
            type="button"
            disabled={busy}
            onClick={() => void startAnotherGame()}
          >
            Создать другую игру
          </button>
          <p className="games-message">
            Новая игра начнёт новую операцию. Это ожидание исчезнет с устройства, но останется в
            обработке на сервере — его статус можно уточнить в поддержке.
          </p>
        </section>
        <MainBottomNavigation active="games" gamesDestination="games" />
      </main>
    );
  }

  return (
    <main className="games-page games-page--create">
      {pageHeader}
      {paidCreateIntent ? (
        <a href="/games/new?quarterCreate=1">Игра по подписке: четверть корта</a>
      ) : null}
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
        {paidCreateAvailable ? (
          <label>
            <span>Оплата</span>
            <select
              value={paymentMode}
              disabled={Boolean(activeAttempt)}
              onChange={(event) =>
                setPaymentMode(event.target.value as 'NO_PAYMENT' | 'SPLIT' | 'SUBSCRIPTION')
              }
            >
              <option value="NO_PAYMENT">Бесплатно</option>
              <option value="SPLIT">Делится между игроками (beta)</option>
              <option value="SUBSCRIPTION">По подписке (beta)</option>
            </select>
          </label>
        ) : null}
        {paymentMode !== 'NO_PAYMENT' ? (
          <p className="games-message" role="status">
            Платёж и бронь не выполняются в beta-контуре. Игра создаётся и появляется в списке после
            подтверждения операции.
          </p>
        ) : null}
        <div className="game-create-form__summary">
          <strong>
            {paymentMode === 'NO_PAYMENT'
              ? 'Стоимость: бесплатно'
              : paymentMode === 'SUBSCRIPTION'
                ? 'Стоимость: по подписке (beta)'
                : 'Стоимость: делится между игроками (beta)'}
          </strong>
          <span>
            {paymentMode === 'NO_PAYMENT'
              ? 'Платёжный и provider-контур не используется.'
              : 'Списание и бронь не выполняются до подтверждения.'}
          </span>
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

export function CreateGamePage(
  props: Parameters<typeof LegacyCreateGamePage>[0],
): React.JSX.Element {
  let quarter =
    typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).get('quarterCreate') === '1';
  try {
    const storage = props.attemptStorage ?? quarterBrowserStorage();
    quarter = quarter || Boolean(storage?.getItem(quarterStorageKey(props.principal)));
  } catch {
    quarter = true;
  }
  return quarter ? <QuarterCreatePanel {...props} /> : <LegacyCreateGamePage {...props} />;
}
