import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import {
  discoveredResidencyAttempt,
  parseUnresolvedResidencyOrders,
  renewalUnavailableMessage,
  formatDay,
  formatRub,
  formatTerm,
  isDefinitiveCreateRefusal,
  listResidencyAttempts,
  newResidencyAttempt,
  parseClientResidencyStatus,
  parseResidencyCatalog,
  parseResidencyOrder,
  parseResidencyOrderEnvelope,
  parseResidencyPayment,
  removeResidencyAttempt,
  residencyErrorCode,
  residencyErrorMessage,
  residencyFailureMessage,
  residencyLockName,
  residencyOrderPhase,
  residencyStatusView,
  residencyUnavailableMessage,
  saveResidencyAttempt,
  shortOrderReference,
  type ResidencyAttempt,
  type ResidencyCatalog,
  type ResidencyGateway,
  type ResidencyOrder,
  type ResidencyOrderPhase,
  type ResidencyPrincipal,
  type ResidencyStatusView,
} from './residency-purchase.js';
import './SubscriptionsPage.css';
import './ResidencyPage.css';

export interface ResidencyPageProps {
  /** Absent where the platform has no reviewed residency transport (native shells today). */
  readonly gateway?: ResidencyGateway;
  readonly principal: ResidencyPrincipal;
  readonly storage?: () => Storage;
  readonly randomUuid?: () => string;
  /** Bounded automatic reconciliation while a created order awaits payment or activation. */
  readonly pollIntervalMs?: number;
  readonly pollLimit?: number;
  /** Test seam: absent Web Locks exercises the per-key storage fallback. */
  readonly locks?: LockManager | null;
}

type Load<T> =
  | { readonly state: 'loading' }
  | { readonly state: 'ready'; readonly value: T }
  | { readonly state: 'error' };

interface Entry {
  readonly attempt: ResidencyAttempt;
  readonly order: ResidencyOrder | null;
}

const CONFIRM_ERROR =
  'Не удалось получить ответ сервера. Повторная оплата не создаётся: проверьте статус заказа.';
/** Keeps an API error (with its status and code) intact; anything else becomes an Error. */
const asError = (e: unknown): Error => (e instanceof Error ? e : new Error('RESIDENCY_FAILED'));
const PHASE_RANK: Readonly<Record<ResidencyOrderPhase, number>> = {
  review: 0,
  uncertain: 1,
  'payment-pending': 2,
  confirming: 3,
  creating: 4,
  activated: 5,
  failed: 6,
  idle: 7,
};
const STATUS_REFRESH_CODES = new Set([
  'RESIDENCY_RENEWAL_REQUIRED',
  'RESIDENCY_RENEWAL_NOT_ELIGIBLE',
  'RESIDENCY_RENEWAL_TOO_EARLY',
  'RESIDENCY_STATUS_UNAVAILABLE',
]);

export function ResidencyPage(props: ResidencyPageProps): React.JSX.Element {
  if (!props.gateway)
    return (
      <ResidencyShell>
        <p className="subscriptions-message" role="status">
          Оформление резидентства в приложении пока недоступно. Воспользуйтесь веб-версией личного
          кабинета.
        </p>
      </ResidencyShell>
    );
  const original = props.gateway.residencyPrincipal();
  return (
    <ResidencySession
      key={props.principal.tenantId + ':' + props.principal.userId + ':' + String(original)}
      {...props}
      gateway={props.gateway}
      original={original}
    />
  );
}

function ResidencyShell({ children }: { readonly children: React.ReactNode }): React.JSX.Element {
  return (
    <main className="subscriptions-page residency-page" aria-labelledby="residency-title">
      <header className="subscriptions-header residency-header">
        <a className="subscriptions-back" href="/profile" aria-label="Вернуться в профиль">
          ‹
        </a>
        <h1 id="residency-title" tabIndex={-1}>
          Резидентство
        </h1>
      </header>
      {children}
    </main>
  );
}

function ResidencySession({
  gateway,
  principal,
  original,
  storage = () => window.localStorage,
  randomUuid = () => crypto.randomUUID(),
  pollIntervalMs = 4000,
  pollLimit = 8,
  locks,
}: ResidencyPageProps & {
  readonly gateway: ResidencyGateway;
  readonly original: string | null;
}): React.JSX.Element {
  const [status, setStatus] = useState<Load<ResidencyStatusView>>({ state: 'loading' });
  const [catalog, setCatalog] = useState<Load<ResidencyCatalog>>({ state: 'loading' });
  const [entries, setEntries] = useState<readonly Entry[]>([]);
  const [confirming, setConfirming] = useState(false);
  const [lookupReady, setLookupReady] = useState(false);
  const [reauth, setReauth] = useState(false);
  const [reauthInterrupted, setReauthInterrupted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false);
  const life = useRef({ active: true });
  const polls = useRef(0);
  useLayoutEffect(() => {
    const current = life.current;
    current.active = true;
    return () => {
      current.active = false;
    };
  }, []);

  const sameAccount = useCallback(
    () => life.current.active && original !== null && gateway.residencyPrincipal() === original,
    [gateway, original],
  );
  const check = useCallback(() => {
    if (!sameAccount()) throw new Error('RESIDENCY_SESSION_CHANGED');
  }, [sameAccount]);

  const readStatus = useCallback(async (): Promise<ResidencyStatusView | null> => {
    try {
      const view = residencyStatusView(
        parseClientResidencyStatus(await gateway.getClientResidency()),
      );
      if (!sameAccount()) return null;
      setStatus({ state: 'ready', value: view });
      return view;
    } catch {
      if (sameAccount()) setStatus({ state: 'error' });
      return null;
    }
  }, [gateway, sameAccount]);

  const readCatalog = useCallback(async (): Promise<ResidencyCatalog | null> => {
    try {
      const value = parseResidencyCatalog(await gateway.getResidencyCatalog());
      if (!sameAccount()) return null;
      setCatalog({ state: 'ready', value });
      setReauthInterrupted(false);
      return value;
    } catch (e) {
      if (sameAccount()) {
        setCatalog({ state: 'error' });
        if (residencyErrorCode(e) === 'RESIDENCY_REAUTH_REQUIRED') {
          setReauth(true);
          setReauthInterrupted(gateway.wasResidencyReauthorizationInterrupted?.() === true);
        }
      }
      return null;
    }
  }, [gateway, sameAccount]);

  /**
   * Serializes this tab's commands (a repeated tap is ignored, not queued) and, where the browser
   * has Web Locks, this account's commands across tabs. Without Web Locks, concurrent tabs are
   * safe because every attempt has its own storage entry and the owner admits one order.
   */
  const exclusive = useCallback(
    async (work: (store: Storage) => Promise<void>): Promise<void> => {
      if (busyRef.current || !sameAccount()) return;
      busyRef.current = true;
      setBusy(true);
      setError(null);
      try {
        const store = storage();
        const manager =
          locks !== undefined
            ? locks
            : typeof navigator === 'undefined'
              ? null
              : (navigator.locks ?? null);
        if (manager) await manager.request(residencyLockName(principal), () => work(store));
        else await work(store);
      } catch (e) {
        if (sameAccount()) {
          setError(residencyErrorMessage(e, CONFIRM_ERROR));
          if (residencyErrorCode(e) === 'RESIDENCY_REAUTH_REQUIRED') setReauth(true);
        }
      } finally {
        if (life.current.active) {
          busyRef.current = false;
          setBusy(false);
        }
      }
    },
    [locks, principal, sameAccount, storage],
  );

  const loadAttempts = useCallback(
    async (store: Storage): Promise<ResidencyAttempt[]> => {
      try {
        return listResidencyAttempts(store, principal);
      } catch (e) {
        // A broken local record is never silently replaced; the status is still shown.
        await readStatus();
        throw e;
      }
    },
    [principal, readStatus],
  );

  const putEntry = useCallback((next: Entry) => {
    setEntries((all) => {
      const others = all.filter((e) => e.attempt.key !== next.attempt.key);
      return [...others, next].sort((a, b) =>
        a.attempt.createdAt.localeCompare(b.attempt.createdAt),
      );
    });
  }, []);
  const dropEntry = useCallback((key: string) => {
    setEntries((all) => all.filter((e) => e.attempt.key !== key));
  }, []);

  /**
   * The one place that interprets a create outcome, for the first send and for every same-key
   * replay. A definitive owner refusal removes only this attempt; anything uncertain keeps the
   * original key so the same operation can be replayed.
   */
  const settle = useCallback(
    async (store: Storage, attempt: ResidencyAttempt): Promise<ResidencyOrder | null> => {
      if (!attempt.createPayload)
        throw Object.assign(new Error('legacy attempt'), { code: 'RESIDENCY_LEGACY_ATTEMPT' });
      let created: ResidencyOrder;
      try {
        created = parseResidencyOrderEnvelope(
          await gateway.createResidencyOrder(attempt.createPayload, attempt.key),
        );
      } catch (e) {
        if (!sameAccount()) throw e;
        if (isDefinitiveCreateRefusal(e, attempt)) {
          removeResidencyAttempt(store, attempt);
          dropEntry(attempt.key);
          const code = residencyErrorCode(e);
          if (code && STATUS_REFRESH_CODES.has(code)) await readStatus();
          await readCatalog();
          if (code === 'RESIDENCY_ORDER_ALREADY_PENDING') {
            setLookupReady(false);
            const orders = parseUnresolvedResidencyOrders(
              await gateway.listUnresolvedResidencyOrders(),
            );
            check();
            const local = listResidencyAttempts(store, principal);
            for (const order of orders) {
              const saved =
                local.find((a) => a.orderId === order.orderId) ??
                discoveredResidencyAttempt(principal, order);
              saveResidencyAttempt(store, saved);
              putEntry({ attempt: saved, order });
            }
            setLookupReady(true);
          }
        }
        throw e;
      }
      check();
      const next = { ...attempt, orderId: created.orderId };
      saveResidencyAttempt(store, next);
      putEntry({ attempt: next, order: created });
      return created;
    },
    [gateway, check, sameAccount, dropEntry, readStatus, readCatalog, putEntry, principal],
  );

  /** Restores every saved attempt (reopened app, reload, new sign-in or return from payment). */
  const refresh = useCallback(
    (mode: 'read' | 'reconcile' | 'recover') =>
      exclusive(async (store) => {
        const attempts = await loadAttempts(store);
        check();
        const view = await readStatus();
        // Replace from current storage, including deletions and orderIds saved by another visible tab.
        setEntries(attempts.map((attempt) => ({ attempt, order: null })));
        const next: Entry[] = [];
        let failure: unknown = null;
        for (const attempt of attempts) {
          if (!attempt.orderId) {
            if (mode === 'recover' && attempt.createPayload) {
              try {
                const order = await settle(store, attempt);
                if (order) next.push({ attempt: { ...attempt, orderId: order.orderId }, order });
              } catch (e) {
                if (!sameAccount()) throw e;
                failure = e;
                if (!isDefinitiveCreateRefusal(e, attempt)) next.push({ attempt, order: null });
              }
            } else {
              next.push({ attempt, order: null });
              if (mode === 'recover')
                failure = Object.assign(new Error('legacy'), { code: 'RESIDENCY_LEGACY_ATTEMPT' });
            }
            continue;
          }
          try {
            let order = parseResidencyOrder(
              await gateway.getResidencyOrder(attempt.orderId),
              attempt.orderId,
            );
            check();
            const phase = residencyOrderPhase(attempt, order, view);
            if (
              mode === 'reconcile' &&
              (phase === 'payment-pending' ||
                phase === 'confirming' ||
                phase === 'review' ||
                phase === 'uncertain')
            ) {
              order = parseResidencyOrderEnvelope(
                await gateway.reconcileResidencyOrder(
                  attempt.orderId,
                  'residency-reconcile:' + randomUuid(),
                ),
                attempt.orderId,
              );
              check();
            }
            next.push({ attempt, order });
          } catch (e) {
            if (!sameAccount()) throw e;
            failure = e;
            next.push({ attempt, order: null });
          }
        }
        try {
          const unresolved = parseUnresolvedResidencyOrders(
            await gateway.listUnresolvedResidencyOrders(),
          );
          check();
          for (const order of unresolved) {
            if (next.some((e) => e.attempt.orderId === order.orderId)) continue;
            const attempt = discoveredResidencyAttempt(principal, order);
            saveResidencyAttempt(store, attempt);
            next.push({ attempt, order });
          }
          setLookupReady(true);
        } catch (e) {
          if (!sameAccount()) throw e;
          setLookupReady(false);
          failure = e;
        }
        check();
        const unique = next.filter((e) => {
          const duplicate =
            e.attempt.key.startsWith('residency-lookup:') &&
            next.some(
              (other) =>
                other.attempt.orderId === e.attempt.orderId &&
                !other.attempt.key.startsWith('residency-lookup:'),
            );
          if (duplicate) removeResidencyAttempt(store, e.attempt);
          return !duplicate;
        });
        setEntries(unique);
        if (mode === 'reconcile') await readStatus();
        if (failure) throw asError(failure);
      }),
    [
      check,
      exclusive,
      gateway,
      loadAttempts,
      randomUuid,
      readStatus,
      sameAccount,
      settle,
      principal,
    ],
  );

  useEffect(() => {
    const initial = window.setTimeout(() => {
      void readCatalog();
      void refresh('read');
    }, 0);
    const foreground = () => {
      if (document.visibilityState === 'visible') void refresh('read');
    };
    const returned = (event: PageTransitionEvent) => {
      if (event.persisted && gateway.wasResidencyReauthorizationInterrupted?.()) void readCatalog();
    };
    document.addEventListener('visibilitychange', foreground);
    window.addEventListener('pageshow', returned);
    return () => {
      window.clearTimeout(initial);
      document.removeEventListener('visibilitychange', foreground);
      window.removeEventListener('pageshow', returned);
    };
    // One account epoch per mount; handlers below always use the current render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gateway, original]);

  const view = status.state === 'ready' ? status.value : null;
  const ranked = entries
    .map((e) => ({ ...e, phase: residencyOrderPhase(e.attempt, e.order, view) }))
    .sort((a, b) => PHASE_RANK[a.phase] - PHASE_RANK[b.phase]);
  const current = ranked[0] ?? null;
  const phase: ResidencyOrderPhase = current?.phase ?? 'idle';
  const order = current?.order ?? null;

  // Bounded reconciliation after payment; never a create, never an endless loop. The owner
  // learns the payment outcome only through reconcile, so a returned user is not left waiting.
  useEffect(() => {
    if (phase !== 'confirming' && phase !== 'payment-pending') {
      polls.current = 0;
      return;
    }
    if (polls.current >= pollLimit || busy) return;
    const timer = window.setTimeout(() => {
      polls.current += 1;
      void refresh('reconcile');
    }, pollIntervalMs);
    return () => window.clearTimeout(timer);
  }, [phase, busy, pollIntervalMs, pollLimit, refresh, order]);

  const openPayment = async (attempt: ResidencyAttempt, target: ResidencyOrder) => {
    if (
      target.state !== 'PENDING_PAYMENT' ||
      target.paymentStatus !== 'PENDING' ||
      target.overdue ||
      target.recovery.state !== 'AWAITING_PAYMENT' ||
      target.recovery.action !== 'PAY'
    )
      return;
    if (
      !target.consent ||
      target.productId !== target.consent.productId ||
      target.totalMinor !== target.consent.expectedTotalMinor ||
      target.totalMinor !== attempt.confirmedPriceMinor ||
      target.mode !== attempt.mode ||
      (attempt.createPayload !== undefined &&
        target.consent.expectedTotalMinor !== attempt.createPayload.expectedTotalMinor) ||
      (attempt.createPayload?.expectedProductId !== undefined &&
        target.productId !== attempt.createPayload.expectedProductId)
    ) {
      // The owner priced the order differently from the confirmed catalog: never open the
      // payment silently; the user sees the order total and decides.
      setError(
        `Сумма заказа ${formatRub(target.totalMinor)} отличается от подтверждённой ${formatRub(attempt.confirmedPriceMinor)}. Проверьте сумму перед оплатой.`,
      );
      return;
    }
    let url = target.paymentUrl;
    if (!url) {
      const payment = parseResidencyPayment(
        await gateway.getResidencyOrderPayment(attempt.orderId!),
        attempt.orderId!,
      );
      check();
      if (
        payment.overdue ||
        payment.recovery.state !== 'AWAITING_PAYMENT' ||
        payment.recovery.action !== 'PAY'
      )
        return;
      url = payment.paymentUrl;
    }
    if (url) gateway.openResidencyPayment(url);
  };

  /** Re-reads the server price right before the user confirms. */
  const startConfirm = () =>
    exclusive(async () => {
      const fresh = await readCatalog();
      check();
      if (
        fresh &&
        (status.state !== 'ready' || status.value.kind !== 'active' || fresh.renewal.eligible)
      )
        setConfirming(true);
    });

  const create = () =>
    exclusive(async (store) => {
      const existing = await loadAttempts(store);
      check();
      if (existing.length) {
        // An earlier tap or another tab already owns an attempt; never start a second one here.
        setEntries(existing.map((attempt) => ({ attempt, order: null })));
        setConfirming(false);
        // Read their orders once this command releases the in-tab guard.
        window.setTimeout(() => void refresh('read'), 0);
        return;
      }
      if (!lookupReady || catalog.state !== 'ready' || status.state !== 'ready') return;
      if (status.value.kind === 'unavailable') return;
      const mode = status.value.kind === 'active' ? 'RENEWAL' : 'NEW';
      if (mode === 'RENEWAL' && !catalog.value.renewal.eligible) return;
      // Durable custody precedes the command: a lost response is recovered by the same key.
      const attempt = newResidencyAttempt(
        principal,
        mode,
        catalog.value.priceMinor,
        randomUuid,
        Date.now,
        catalog.value.productId,
      );
      saveResidencyAttempt(store, attempt);
      putEntry({ attempt, order: null });
      setConfirming(false);
      const created = await settle(store, attempt);
      if (created) await openPayment({ ...attempt, orderId: created.orderId }, created);
    });

  const recover = () => refresh('recover');

  const pay = () =>
    exclusive(async () => {
      if (!current?.attempt.orderId) return;
      const target = parseResidencyOrder(
        await gateway.getResidencyOrder(current.attempt.orderId),
        current.attempt.orderId,
      );
      check();
      putEntry({ attempt: current.attempt, order: target });
      await openPayment(current.attempt, target);
    });

  /** Clears this attempt only after a fresh server read shows it is finished and known. */
  const finish = () =>
    exclusive(async (store) => {
      if (!current) return;
      const { attempt } = current;
      if (attempt.orderId) {
        const latest = parseResidencyOrder(
          await gateway.getResidencyOrder(attempt.orderId),
          attempt.orderId,
        );
        check();
        const freshView = await readStatus();
        putEntry({ attempt, order: latest });
        const settled = residencyOrderPhase(attempt, latest, freshView);
        if (settled !== 'activated' && settled !== 'failed') return;
      }
      removeResidencyAttempt(store, attempt);
      dropEntry(attempt.key);
      await readStatus();
      await readCatalog();
    });

  const reauthorize = () =>
    exclusive(async () => {
      setReauthInterrupted(false);
      try {
        await gateway.reauthorizeResidency();
      } catch (error) {
        if (!sameAccount()) return;
        const interrupted =
          residencyErrorCode(error) === 'VIVA_OAUTH_CANCELLED' ||
          (error instanceof Error && error.name === 'AbortError');
        if (interrupted) setReauthInterrupted(true);
        else
          setError(
            'Не удалось начать повторный вход через Viva. Операция сохранена, попробуйте позже.',
          );
      }
    });

  const renewing = view?.kind === 'active';
  const paymentConfirmed = order?.paymentStatus === 'PAID';
  const product = catalog.state === 'ready' ? catalog.value : null;
  const statusKnown = view !== null && view.kind !== 'unavailable';
  const reference = current?.attempt.orderId ? shortOrderReference(current.attempt.orderId) : null;
  const time = (value: string) =>
    new Date(value).toLocaleTimeString('ru-RU', {
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'Europe/Moscow',
    });

  return (
    <ResidencyShell>
      <section
        className="residency-status"
        aria-live="polite"
        aria-busy={status.state === 'loading'}
      >
        <h2>Ваш статус</h2>
        <StatusBlock status={status} onRetry={() => void refresh('read')} busy={busy} />
      </section>

      {phase === 'activated' && order?.residencyValidUntil ? (
        <section className="residency-result residency-success" role="status">
          <h2>{order.mode === 'RENEWAL' ? 'Резидентство продлено' : 'Резидентство активно'}</h2>
          <p>
            {paymentConfirmed ? 'Оплата подтверждена. ' : ''}Резидентство действует до{' '}
            {formatDay(order.residencyValidUntil)}
          </p>
          <button
            type="button"
            className="residency-primary"
            disabled={busy}
            onClick={() => void finish()}
          >
            Готово
          </button>
        </section>
      ) : phase === 'failed' ? (
        <section className="residency-result residency-failure" role="alert">
          <h2>{order?.state === 'CANCELLED' ? 'Заказ отменён' : 'Резидентство не оформлено'}</h2>
          <p>{residencyFailureMessage(order)}</p>
          <button
            type="button"
            className="residency-primary"
            disabled={busy}
            onClick={() => void finish()}
          >
            Оформить заново
          </button>
        </section>
      ) : phase === 'uncertain' ? (
        <section className="residency-result residency-failure" role="alert">
          <h2>Результат оплаты не подтверждён</h2>
          <p>
            Не удалось подтвердить, был ли создан платёж по этому заказу. Новый платёж недоступен,
            пока клуб не выяснит результат. Если деньги списались, сообщите в поддержку номер
            заказа.
          </p>
          {reference ? <p className="residency-note">Номер заказа: {reference}</p> : null}
          <button
            type="button"
            className="residency-secondary"
            disabled={busy}
            onClick={() => void refresh('reconcile')}
          >
            Проверить снова
          </button>
          <a className="residency-secondary residency-link" href="/support">
            Написать в поддержку
          </a>
        </section>
      ) : phase === 'review' ? (
        <section className="residency-result residency-failure" role="alert">
          <h2>Нужна проверка клуба</h2>
          <p>
            {paymentConfirmed
              ? 'Оплата получена. Клуб проверит, почему резидентство не активировалось.'
              : 'Оплата пока не подтверждена. Клуб проверит заказ.'}{' '}
            Новый платёж недоступен. Если вопрос не решится, напишите в поддержку.
          </p>
          {reference ? <p className="residency-note">Номер заказа: {reference}</p> : null}
          <button
            type="button"
            className="residency-secondary"
            disabled={busy}
            onClick={() => void refresh('reconcile')}
          >
            Проверить снова
          </button>
          <a className="residency-secondary residency-link" href="/support">
            Написать в поддержку
          </a>
        </section>
      ) : phase === 'payment-pending' ? (
        <section className="residency-result" role="status">
          <h2>Ожидает оплаты</h2>
          <p>
            {order?.mode === 'RENEWAL' ? 'Продление' : 'Заказ'}{' '}
            {order ? `на ${formatRub(order.totalMinor)} ` : ''}ждёт оплаты. Если вы уже оплатили,
            подтверждение придёт после ответа банка. Заказ остаётся открытым, пока результат не
            подтверждён.
          </p>
          <button
            type="button"
            className="residency-primary"
            disabled={busy}
            onClick={() => void pay()}
          >
            Перейти к оплате
          </button>
          <button
            type="button"
            className="residency-secondary"
            disabled={busy}
            onClick={() => void refresh('reconcile')}
          >
            Проверить оплату
          </button>
        </section>
      ) : phase === 'confirming' ? (
        <section className="residency-result" role="status">
          <h2>Проверяем оплату</h2>
          <p>
            {!order
              ? 'Не удалось прочитать заказ. Проверьте статус ещё раз.'
              : order.overdue
                ? 'Время ожидания истекло, но результат банка ещё не подтверждён. Заказ остаётся открытым; новый платёж недоступен.'
                : order.state === 'ACTIVE'
                  ? 'Резидентство активировано. Ждём подтверждения нового срока в вашем статусе.'
                  : paymentConfirmed
                    ? 'Оплата получена. Ждём активации резидентства клубом.'
                    : 'Проверяем статус платежа. Новый платёж недоступен.'}
          </p>
          <button
            type="button"
            className="residency-secondary"
            disabled={busy}
            onClick={() => void refresh('reconcile')}
          >
            Проверить статус
          </button>
        </section>
      ) : phase === 'creating' ? (
        <section className="residency-result" role="status">
          <h2>Заказ отправлен</h2>
          <p>
            {current?.attempt.createPayload
              ? 'Ответ сервера не получен. Нажмите «Проверить заказ»: будет повторён тот же запрос, второй заказ не создаётся.'
              : 'Сохранена прежняя попытка без полного согласия. Проверка найдёт незавершённый заказ; новый заказ автоматически не создаётся. Если заказ не найден, обратитесь в поддержку.'}
          </p>
          <button
            type="button"
            className="residency-primary"
            disabled={busy}
            onClick={() => void recover()}
          >
            Проверить заказ
          </button>
        </section>
      ) : null}

      {phase === 'idle' ? (
        <section
          className="residency-offers"
          aria-labelledby="residency-offers-title"
          aria-busy={catalog.state === 'loading'}
        >
          <h2 id="residency-offers-title">{renewing ? 'Продление' : 'Условия резидентства'}</h2>
          {catalog.state === 'loading' ? (
            <p className="subscriptions-message" role="status">
              Загружаем условия…
            </p>
          ) : !product ? (
            <p className="subscriptions-message" role="status">
              Оформление резидентства пока недоступно. Условия появятся здесь, когда клуб откроет
              продажу.
            </p>
          ) : (
            <>
              <article className="residency-offer" data-selected={confirming}>
                <span className="residency-offer-head">
                  <strong>{product.title}</strong>
                  <span>{formatTerm(product.termDays)}</span>
                </span>
                <span className="residency-offer-price">{formatRub(product.priceMinor)}</span>
                {product.benefits.length ? (
                  <ul className="residency-benefits" aria-label="Преимущества">
                    {product.benefits.map((b) => (
                      <li key={b}>{b}</li>
                    ))}
                  </ul>
                ) : null}
              </article>
              {renewing && !product.renewal.eligible ? (
                <p role="status">{renewalUnavailableMessage(product.renewal)}</p>
              ) : !lookupReady ? (
                <div>
                  <p role="status">
                    Проверяем незавершённые заказы. Оплата станет доступна после проверки.
                  </p>
                  <button
                    type="button"
                    className="residency-secondary"
                    disabled={busy}
                    onClick={() => void refresh('read')}
                  >
                    Проверить заказы
                  </button>
                </div>
              ) : confirming ? (
                <div className="residency-confirm" aria-label="Подтверждение">
                  <dl className="subscriptions-facts">
                    <div>
                      <dt>Тип</dt>
                      <dd>{renewing ? 'Продление' : 'Новое оформление'}</dd>
                    </div>
                    <div>
                      <dt>К оплате</dt>
                      <dd>{formatRub(product.priceMinor)}</dd>
                    </div>
                    <div>
                      <dt>Срок</dt>
                      <dd>{formatTerm(product.termDays)}</dd>
                    </div>
                  </dl>
                  <p className="residency-note">
                    Цена подтверждена клубом в {time(product.checkedAt)} (МСК).
                    {renewing && view?.kind === 'active' && view.validUntil
                      ? ` Текущее резидентство действует до ${formatDay(view.validUntil)} Новый срок клуб подтвердит после оплаты.`
                      : ''}{' '}
                    Оплата проходит на защищённой странице платёжного сервиса. При изменении суммы
                    потребуется новое подтверждение.
                  </p>
                  <button
                    type="button"
                    className="residency-primary"
                    disabled={busy}
                    onClick={() => void create()}
                  >
                    {renewing ? 'Подтвердить продление и оплатить' : 'Подтвердить и оплатить'}
                  </button>
                  <button
                    type="button"
                    className="residency-secondary"
                    disabled={busy}
                    onClick={() => setConfirming(false)}
                  >
                    Отмена
                  </button>
                </div>
              ) : statusKnown ? (
                <button
                  type="button"
                  className="residency-primary"
                  disabled={busy}
                  onClick={() => void startConfirm()}
                >
                  {renewing ? 'Продлить резидентство' : 'Оформить резидентство'}
                </button>
              ) : (
                <p className="residency-note">
                  Оформление станет доступно, когда удастся проверить ваш статус.
                </p>
              )}
            </>
          )}
        </section>
      ) : null}
      {entries.some((e) => !e.attempt.orderId) && phase !== 'creating' ? (
        <button
          type="button"
          className="residency-secondary"
          disabled={busy}
          onClick={() => void recover()}
        >
          Проверить сохранённую попытку
        </button>
      ) : null}
      {current && !current.attempt.createPayload && !current.attempt.orderId ? (
        <a href="/support" className="residency-secondary residency-link">
          Написать в поддержку
        </a>
      ) : null}
      {reauth ? (
        <button
          type="button"
          className="residency-primary"
          disabled={busy}
          onClick={() => void reauthorize()}
        >
          Войти повторно через Viva
        </button>
      ) : null}
      {reauthInterrupted || error ? (
        <p className="subscriptions-message subscriptions-error" role="alert">
          {reauthInterrupted
            ? 'Повторный вход через Viva прерван. Операция сохранена, можно попробовать снова.'
            : error}
        </p>
      ) : null}
    </ResidencyShell>
  );
}

function StatusBlock({
  status,
  onRetry,
  busy,
}: {
  readonly status: Load<ResidencyStatusView>;
  readonly onRetry: () => void;
  readonly busy: boolean;
}): React.JSX.Element {
  if (status.state === 'loading')
    return (
      <p className="residency-status-line" role="status">
        Проверяем статус…
      </p>
    );
  if (status.state === 'error' || status.value.kind === 'unavailable')
    return (
      <div className="residency-status-card" data-state="unavailable">
        <p>
          {residencyUnavailableMessage(
            status.state === 'ready' && status.value.kind === 'unavailable'
              ? status.value.reason
              : null,
          )}
        </p>
        <button type="button" className="residency-secondary" disabled={busy} onClick={onRetry}>
          Повторить
        </button>
      </div>
    );
  const v = status.value;
  if (v.kind === 'active')
    return (
      <div className="residency-status-card" data-state="active">
        <span className="subscriptions-status">Активно</span>
        <p>
          {v.validUntil ? (
            <>
              Действует до <time dateTime={v.validUntil}>{formatDay(v.validUntil)}</time>
            </>
          ) : (
            'Срок действия не указан'
          )}
        </p>
      </div>
    );
  if (v.kind === 'expired')
    return (
      <div className="residency-status-card" data-state="expired">
        <span className="subscriptions-status">Истёк срок</span>
        <p>
          Срок закончился <time dateTime={v.validUntil}>{formatDay(v.validUntil)}</time> —
          резидентство можно оформить снова.
        </p>
      </div>
    );
  return (
    <div className="residency-status-card" data-state="none">
      <span className="subscriptions-status">Нет резидентства</span>
      <p>У вас пока нет действующего резидентства.</p>
    </div>
  );
}
