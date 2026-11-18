import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import {
  clearResidencyCustody,
  formatDay,
  formatRub,
  formatTerm,
  loadResidencyCustody,
  newResidencyCustody,
  parseResidencyCatalog,
  parseResidencyOrder,
  parseResidencyOrderEnvelope,
  parseResidencyPayment,
  residencyErrorCode,
  residencyErrorMessage,
  residencyFailureMessage,
  residencyOrderPhase,
  residencyStatusView,
  residencyStorageKey,
  residencyUnavailableMessage,
  saveResidencyCustody,
  type ResidencyCatalog,
  type ResidencyCustody,
  type ResidencyGateway,
  type ResidencyOrder,
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
}

type Load<T> =
  | { readonly state: 'loading' }
  | { readonly state: 'ready'; readonly value: T }
  | { readonly state: 'error' };

const CONFIRM_ERROR =
  'Не удалось получить ответ сервера. Повторная оплата не создаётся: проверьте статус заказа.';
/** Owner refusals that happen before any order or provider transaction exists for the key. */
const REFUSED_BEFORE_ORDER = new Set([
  'RESIDENCY_ORDER_ALREADY_PENDING',
  'RESIDENCY_RENEWAL_REQUIRED',
  'RESIDENCY_RENEWAL_NOT_ELIGIBLE',
  'RESIDENCY_PRODUCT_TERMS_MISMATCH',
  'RESIDENCY_CATALOG_UNAVAILABLE',
  'RESIDENCY_PRICING_UNAVAILABLE',
  'RESIDENCY_PRICING_INVALID',
  'RESIDENCY_STATUS_UNAVAILABLE',
  'RESIDENCY_IDEMPOTENCY_CONFLICT',
  'RESIDENCY_RATE_LIMITED',
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
}: ResidencyPageProps & {
  readonly gateway: ResidencyGateway;
  readonly original: string | null;
}): React.JSX.Element {
  const [status, setStatus] = useState<Load<ResidencyStatusView>>({ state: 'loading' });
  const [catalog, setCatalog] = useState<Load<ResidencyCatalog>>({ state: 'loading' });
  const [custody, setCustody] = useState<ResidencyCustody | null>(null);
  const [order, setOrder] = useState<ResidencyOrder | null>(null);
  const [confirming, setConfirming] = useState(false);
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

  const readStatus = useCallback(async (): Promise<void> => {
    try {
      const view = residencyStatusView(await gateway.getClientResidency());
      if (sameAccount()) setStatus({ state: 'ready', value: view });
    } catch {
      if (sameAccount()) setStatus({ state: 'error' });
    }
  }, [gateway, sameAccount]);

  const readCatalog = useCallback(async (): Promise<ResidencyCatalog | null> => {
    try {
      const value = parseResidencyCatalog(await gateway.getResidencyCatalog());
      if (!sameAccount()) return null;
      setCatalog({ state: 'ready', value });
      return value;
    } catch {
      if (sameAccount()) setCatalog({ state: 'error' });
      return null;
    }
  }, [gateway, sameAccount]);

  /** Serializes every command; a second tap while one runs is ignored, not queued. */
  const exclusive = useCallback(
    async (work: (store: Storage) => Promise<void>): Promise<void> => {
      if (busyRef.current || !sameAccount()) return;
      busyRef.current = true;
      setBusy(true);
      setError(null);
      try {
        const store = storage();
        const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
        if (locks) await locks.request(residencyStorageKey(principal), () => work(store));
        else await work(store);
      } catch (e) {
        if (sameAccount()) setError(residencyErrorMessage(e, CONFIRM_ERROR));
      } finally {
        if (life.current.active) {
          busyRef.current = false;
          setBusy(false);
        }
      }
    },
    [principal, sameAccount, storage],
  );

  const loadCustody = useCallback(
    async (store: Storage): Promise<ResidencyCustody | null> => {
      try {
        return loadResidencyCustody(store, principal);
      } catch (e) {
        // A broken local record is never silently replaced; the status is still shown.
        await readStatus();
        throw e;
      }
    },
    [principal, readStatus],
  );

  /** Restores the saved order (reopened app, reload or return from the payment page). */
  const refresh = useCallback(
    (mode: 'read' | 'reconcile') =>
      exclusive(async (store) => {
        const c = await loadCustody(store);
        check();
        setCustody(c);
        if (!c?.orderId) {
          setOrder(null);
          await readStatus();
          return;
        }
        const next =
          mode === 'reconcile'
            ? parseResidencyOrderEnvelope(
                await gateway.reconcileResidencyOrder(
                  c.orderId,
                  'residency-reconcile:' + randomUuid(),
                ),
                c.orderId,
              )
            : parseResidencyOrder(await gateway.getResidencyOrder(c.orderId), c.orderId);
        check();
        setOrder(next);
        await readStatus();
      }),
    [check, exclusive, gateway, loadCustody, randomUuid, readStatus],
  );

  useEffect(() => {
    const initial = window.setTimeout(() => {
      void readCatalog();
      void refresh('read');
    }, 0);
    const foreground = () => {
      if (document.visibilityState === 'visible') void refresh('read');
    };
    document.addEventListener('visibilitychange', foreground);
    return () => {
      window.clearTimeout(initial);
      document.removeEventListener('visibilitychange', foreground);
    };
    // One account epoch per mount; handlers below always use the current render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gateway, original]);

  const view = status.state === 'ready' ? status.value : null;
  const phase = residencyOrderPhase(custody, order, view);

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

  const openPayment = async (c: ResidencyCustody, current: ResidencyOrder) => {
    let url = current.state === 'PENDING_PAYMENT' ? current.paymentUrl : null;
    if (!url && current.state === 'PENDING_PAYMENT') {
      const payment = parseResidencyPayment(
        await gateway.getResidencyOrderPayment(c.orderId!),
        c.orderId!,
      );
      check();
      url = payment.paymentUrl;
    }
    if (url) gateway.openResidencyPayment(url);
  };

  /** Re-reads the server price right before the user confirms. */
  const startConfirm = () =>
    exclusive(async () => {
      const fresh = await readCatalog();
      check();
      if (fresh) setConfirming(true);
    });

  const create = () =>
    exclusive(async (store) => {
      const existing = await loadCustody(store);
      check();
      if (existing) {
        // Another tab or an earlier tap already owns an order; never start a second one.
        setCustody(existing);
        setConfirming(false);
        return;
      }
      if (status.state !== 'ready' || status.value.kind === 'unavailable') return;
      const mode = status.value.kind === 'active' ? 'RENEWAL' : 'NEW';
      // Durable custody precedes the command: a lost response is recovered by the same key.
      let c = newResidencyCustody(principal, mode, randomUuid);
      saveResidencyCustody(store, c);
      setCustody(c);
      setConfirming(false);
      let created: ResidencyOrder;
      try {
        created = parseResidencyOrderEnvelope(await gateway.createResidencyOrder(mode, c.key));
      } catch (e) {
        const code = residencyErrorCode(e);
        if (code && REFUSED_BEFORE_ORDER.has(code)) {
          clearResidencyCustody(store, principal);
          setCustody(null);
          if (code === 'RESIDENCY_RENEWAL_REQUIRED' || code === 'RESIDENCY_RENEWAL_NOT_ELIGIBLE')
            await readStatus();
        }
        throw e;
      }
      check();
      c = { ...c, orderId: created.orderId };
      saveResidencyCustody(store, c);
      setCustody(c);
      setOrder(created);
      await openPayment(c, created);
    });

  /** Replays the original create key after a lost response; the owner returns the same order. */
  const recover = () =>
    exclusive(async (store) => {
      let c = await loadCustody(store);
      check();
      if (!c) return;
      if (c.orderId) {
        setOrder(parseResidencyOrder(await gateway.getResidencyOrder(c.orderId), c.orderId));
        return;
      }
      const recovered = parseResidencyOrderEnvelope(
        await gateway.createResidencyOrder(c.mode, c.key),
      );
      check();
      c = { ...c, orderId: recovered.orderId };
      saveResidencyCustody(store, c);
      setCustody(c);
      setOrder(recovered);
    });

  const pay = () =>
    exclusive(async (store) => {
      const c = await loadCustody(store);
      check();
      if (!c?.orderId) return;
      const current = parseResidencyOrder(await gateway.getResidencyOrder(c.orderId), c.orderId);
      check();
      setOrder(current);
      await openPayment(c, current);
    });

  const cancel = () =>
    exclusive(async (store) => {
      const c = await loadCustody(store);
      check();
      if (!c?.orderId) return;
      const next = parseResidencyOrderEnvelope(
        await gateway.cancelResidencyOrder(c.orderId, 'residency-cancel:' + randomUuid()),
        c.orderId,
      );
      check();
      setOrder(next);
    });

  /** Clears the saved order only after the server shows it is finished. */
  const finish = () =>
    exclusive(async (store) => {
      const c = await loadCustody(store);
      check();
      if (c?.orderId) {
        const current = parseResidencyOrder(await gateway.getResidencyOrder(c.orderId), c.orderId);
        check();
        setOrder(current);
        if (!['ACTIVE', 'PAYMENT_FAILED', 'EXPIRED', 'CANCELLED'].includes(current.state)) return;
      }
      clearResidencyCustody(store, principal);
      setCustody(null);
      setOrder(null);
      await readStatus();
    });

  const renewing = view?.kind === 'active';
  const product = catalog.state === 'ready' ? catalog.value : null;
  const statusKnown = view !== null && view.kind !== 'unavailable';
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

      {phase === 'activated' ? (
        <section className="residency-result residency-success" role="status">
          <h2>Резидентство активно</h2>
          <p>
            Оплата подтверждена, резидентство оформлено
            {view?.kind === 'active' && view.validUntil
              ? ` и действует до ${formatDay(view.validUntil)}`
              : '.'}
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
          <h2>{order?.state === 'CANCELLED' ? 'Заказ отменён' : 'Оплата не прошла'}</h2>
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
      ) : phase === 'review' ? (
        <section className="residency-result residency-failure" role="alert">
          <h2>Нужна проверка клуба</h2>
          <p>
            Оплата получена, но резидентство не удалось активировать автоматически. Повторно платить
            не нужно — клуб проверит заказ. Если вопрос не решится, напишите в поддержку.
          </p>
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
            Заказ {order ? `на ${formatRub(order.totalMinor)} ` : ''}создан и ждёт оплаты
            {order?.paymentExpiresAt ? ` до ${time(order.paymentExpiresAt)} (МСК)` : ''}. Если вы
            уже оплатили, подтверждение придёт после ответа банка.
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
          <button
            type="button"
            className="residency-secondary"
            disabled={busy}
            onClick={() => void cancel()}
          >
            Отменить заказ
          </button>
        </section>
      ) : phase === 'confirming' ? (
        <section className="residency-result" role="status">
          <h2>Проверяем оплату</h2>
          <p>
            {order?.state === 'ACTIVE'
              ? 'Резидентство активировано. Ждём подтверждения статуса.'
              : order && order.state !== 'PENDING_PAYMENT'
                ? 'Оплата получена. Ждём активации резидентства клубом.'
                : 'Ждём ответа банка. Повторно платить не нужно.'}
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
            Ответ сервера не получен. Проверьте заказ: будет найден тот же заказ, повторной оплаты
            не будет.
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
              {confirming ? (
                <div className="residency-confirm" aria-label="Подтверждение">
                  <dl className="subscriptions-facts">
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
                      ? ` Текущее резидентство действует до ${formatDay(view.validUntil)}; даты нового периода клуб определит после оплаты.`
                      : ''}{' '}
                    Оплата проходит на защищённой странице платёжного сервиса.
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
      {error ? (
        <p className="subscriptions-message subscriptions-error" role="alert">
          {error}
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
