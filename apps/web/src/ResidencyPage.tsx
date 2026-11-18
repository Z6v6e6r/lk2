import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import {
  clearResidencyCustody,
  formatDay,
  formatRub,
  loadResidencyCustody,
  newResidencyCustody,
  parseResidencyCapability,
  parseResidencyLaunch,
  parseResidencyQuote,
  parseResidencyResult,
  residencyConsent,
  residencyFailureMessage,
  residencyPurchasePhase,
  residencyStatusView,
  residencyStorageKey,
  residencyUnavailableMessage,
  saveResidencyCustody,
  type ResidencyCapability,
  type ResidencyCustody,
  type ResidencyGateway,
  type ResidencyPrincipal,
  type ResidencyPurchaseResult,
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
  /** Bounded automatic re-reads while a submitted operation awaits confirmation. */
  readonly pollIntervalMs?: number;
  readonly pollLimit?: number;
}

type Load<T> =
  | { readonly state: 'loading' }
  | { readonly state: 'ready'; readonly value: T }
  | { readonly state: 'error' };

const CONFIRM_ERROR =
  'Не удалось получить ответ сервера. Повторная оплата не создаётся: проверьте статус этой операции.';

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
  const [capability, setCapability] = useState<Load<ResidencyCapability>>({ state: 'loading' });
  const [custody, setCustody] = useState<ResidencyCustody | null>(null);
  const [result, setResult] = useState<ResidencyPurchaseResult | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false);
  const life = useRef({ active: true });
  const polls = useRef(0);
  /** Render-time clock, advanced exactly when the confirmed price expires. */
  const [clock, setClock] = useState(() => Date.now());
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

  const readStatus = useCallback(async (): Promise<ResidencyStatusView | null> => {
    try {
      const view = residencyStatusView(await gateway.getClientResidency());
      if (!sameAccount()) return null;
      setStatus({ state: 'ready', value: view });
      return view;
    } catch {
      if (sameAccount()) setStatus({ state: 'error' });
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
      } catch {
        if (sameAccount()) setError(CONFIRM_ERROR);
      } finally {
        if (life.current.active) {
          busyRef.current = false;
          setBusy(false);
        }
      }
    },
    [principal, sameAccount, storage],
  );

  const check = useCallback(() => {
    if (!sameAccount()) throw new Error('RESIDENCY_SESSION_CHANGED');
  }, [sameAccount]);

  /** Restores the saved operation (reopened app or return from the payment page). */
  const refresh = useCallback(
    (mode: 'read' | 'reconcile') =>
      exclusive(async (store) => {
        let c: ResidencyCustody | null;
        try {
          c = loadResidencyCustody(store, principal);
        } catch (e) {
          // A broken local record is never silently replaced; the status is still shown.
          await readStatus();
          throw e;
        }
        check();
        setCustody(c);
        if (c?.quote) setSelected(c.quote.offerId);
        if (!c?.submitted || !c.quote) {
          setResult(null);
          await readStatus();
          return;
        }
        const raw =
          mode === 'reconcile'
            ? await gateway.reconcileResidencyPurchase(c.quote.operationId, c.key)
            : await gateway.getResidencyPurchase(c.key);
        const r = parseResidencyResult(raw, c);
        check();
        setResult(r);
        await readStatus();
      }),
    [check, exclusive, gateway, principal, readStatus],
  );

  useEffect(() => {
    void gateway
      .getResidencyPurchaseCapability()
      .then((raw) => {
        const value = parseResidencyCapability(raw);
        if (!sameAccount()) return;
        setCapability({ state: 'ready', value });
        if (value.offers.length === 1) setSelected(value.offers[0]!.offerId);
      })
      .catch(() => {
        if (sameAccount()) setCapability({ state: 'error' });
      });
    const initial = window.setTimeout(() => void refresh('read'), 0);
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

  const phase = residencyPurchasePhase(
    custody,
    result,
    status.state === 'ready' ? status.value : null,
  );

  const quoteExpiresAt = custody?.quote && !custody.submitted ? custody.quote.expiresAt : null;
  useEffect(() => {
    if (!quoteExpiresAt) return;
    const timer = window.setTimeout(
      () => setClock(Date.now()),
      Math.max(0, Math.min(Date.parse(quoteExpiresAt) - Date.now() + 50, 2_147_000_000)),
    );
    return () => window.clearTimeout(timer);
  }, [quoteExpiresAt]);

  // Bounded re-reads after submission; never a new POST, never an endless loop.
  useEffect(() => {
    if (phase !== 'confirming' && phase !== 'payment-pending') {
      polls.current = 0;
      return;
    }
    if (polls.current >= pollLimit || busy) return;
    const timer = window.setTimeout(() => {
      polls.current += 1;
      void refresh('read');
    }, pollIntervalMs);
    return () => window.clearTimeout(timer);
  }, [phase, busy, pollIntervalMs, pollLimit, refresh, result]);

  const quote = () =>
    exclusive(async (store) => {
      if (!selected) return;
      let c = loadResidencyCustody(store, principal);
      check();
      if (c?.submitted) {
        // The saved operation must be terminal before a new quote may replace it.
        const r = parseResidencyResult(await gateway.getResidencyPurchase(c.key), c);
        check();
        if (!['PAYMENT_FAILED', 'EXPIRED', 'ACTIVATED'].includes(r.status)) {
          setCustody(c);
          setResult(r);
          return;
        }
        clearResidencyCustody(store, principal);
        c = null;
      }
      if (!c || (c.quote && c.quote.offerId !== selected)) {
        if (c) clearResidencyCustody(store, principal);
        c = newResidencyCustody(principal, randomUuid);
        saveResidencyCustody(store, c);
      }
      const q = parseResidencyQuote(
        await gateway.quoteResidencyPurchase(selected, c.key),
        selected,
      );
      check();
      c = { ...c, quote: q, submitted: false };
      saveResidencyCustody(store, c);
      setCustody(c);
      setResult(null);
    });

  const launch = async (c: ResidencyCustody) => {
    const l = parseResidencyLaunch(
      await gateway.launchResidencyPayment(c.quote!.operationId, c.key),
      c,
    );
    check();
    gateway.openResidencyPayment(l.paymentUrl);
  };

  const confirm = () =>
    exclusive(async (store) => {
      let c = loadResidencyCustody(store, principal);
      check();
      if (
        !c?.quote ||
        c.submitted ||
        c.key !== custody?.key ||
        JSON.stringify(c.quote) !== JSON.stringify(custody.quote) ||
        Date.parse(c.quote.expiresAt) <= Date.now()
      ) {
        setCustody(c);
        setError('Цена устарела. Запросите стоимость заново.');
        return;
      }
      // Durable custody precedes the command: a lost response is recovered by the same key.
      c = { ...c, submitted: true };
      saveResidencyCustody(store, c);
      setCustody(c);
      const r = parseResidencyResult(
        await gateway.purchaseResidency(residencyConsent(c.quote!), c.key),
        c,
      );
      check();
      setResult(r);
      if (r.canOpenPayment) await launch(c);
    });

  const pay = () =>
    exclusive(async (store) => {
      const c = loadResidencyCustody(store, principal);
      check();
      if (!c?.submitted || c.key !== custody?.key) return;
      const r = parseResidencyResult(await gateway.getResidencyPurchase(c.key), c);
      check();
      setResult(r);
      if (r.canOpenPayment) await launch(c);
    });

  const finish = () =>
    exclusive(async (store) => {
      const c = loadResidencyCustody(store, principal);
      check();
      if (c?.submitted) {
        const r = parseResidencyResult(await gateway.getResidencyPurchase(c.key), c);
        check();
        if (!['PAYMENT_FAILED', 'EXPIRED', 'ACTIVATED'].includes(r.status)) {
          setResult(r);
          return;
        }
      }
      clearResidencyCustody(store, principal);
      setCustody(null);
      setResult(null);
      await readStatus();
    });

  const view = status.state === 'ready' ? status.value : null;
  const renewing = view?.kind === 'active';
  const offers = capability.state === 'ready' ? capability.value.offers : [];
  const canBuy = capability.state === 'ready' && capability.value.available;
  // A saved price is offered for confirmation only while its offer is the selected one.
  const q = custody?.quote && custody.quote.offerId === selected ? custody.quote : null;
  const quoteExpired = q ? Date.parse(q.expiresAt) <= clock : false;

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
          <h2>Оплата не прошла</h2>
          <p>{residencyFailureMessage(result)}</p>
          <button
            type="button"
            className="residency-primary"
            disabled={busy}
            onClick={() => void finish()}
          >
            Выбрать заново
          </button>
        </section>
      ) : phase === 'payment-pending' ? (
        <section className="residency-result" role="status">
          <h2>Ожидает оплаты</h2>
          <p>
            Заказ {result?.amountMinor ? `на ${formatRub(result.amountMinor)} ` : ''}создан и ждёт
            оплаты
            {result?.paymentExpiresAt
              ? ` до ${new Date(result.paymentExpiresAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`
              : ''}
            . Если вы уже оплатили, подтверждение придёт в течение нескольких минут.
          </p>
          {result?.canOpenPayment ? (
            <button
              type="button"
              className="residency-primary"
              disabled={busy}
              onClick={() => void pay()}
            >
              Перейти к оплате
            </button>
          ) : null}
          <button
            type="button"
            className="residency-secondary"
            disabled={busy}
            onClick={() => void refresh('reconcile')}
          >
            Проверить статус оплаты
          </button>
        </section>
      ) : phase === 'confirming' ? (
        <section className="residency-result" role="status">
          <h2>Проверяем оплату</h2>
          <p>
            {result?.status === 'ACTIVATED'
              ? 'Оплата получена. Ждём подтверждения резидентства клубной системой.'
              : 'Ждём подтверждения операции от сервера. Повторно платить не нужно.'}
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
      ) : null}

      {phase === 'idle' || phase === 'quoted' ? (
        <section
          className="residency-offers"
          aria-labelledby="residency-offers-title"
          aria-busy={capability.state === 'loading'}
        >
          <h2 id="residency-offers-title">{renewing ? 'Продление' : 'Условия резидентства'}</h2>
          {capability.state === 'loading' ? (
            <p className="subscriptions-message" role="status">
              Загружаем условия…
            </p>
          ) : capability.state === 'error' ? (
            <p className="subscriptions-message" role="status">
              Оформление резидентства пока недоступно. Условия появятся здесь, когда клуб откроет
              продажу.
            </p>
          ) : offers.length === 0 ? (
            <p className="subscriptions-message" role="status">
              Сейчас нет доступных предложений резидентства.
            </p>
          ) : (
            <>
              {!canBuy ? (
                <p className="subscriptions-message" role="status">
                  Оформление временно недоступно. Условия показаны для ознакомления.
                </p>
              ) : null}
              <ul className="residency-offer-list" role="radiogroup" aria-label="Предложения">
                {offers.map((offer) => {
                  const checked = selected === offer.offerId;
                  return (
                    <li key={offer.offerId}>
                      <label className="residency-offer" data-selected={checked}>
                        <input
                          type="radio"
                          name="residency-offer"
                          value={offer.offerId}
                          checked={checked}
                          disabled={busy || !canBuy}
                          onChange={() => setSelected(offer.offerId)}
                        />
                        <span className="residency-offer-head">
                          <strong>{offer.title}</strong>
                          <span>{offer.durationLabel}</span>
                        </span>
                        <span className="residency-offer-price">
                          {formatRub(offer.amountMinor)}
                        </span>
                        {offer.description ? (
                          <span className="residency-offer-text">{offer.description}</span>
                        ) : null}
                        {offer.benefits.length ? (
                          <ul className="residency-benefits" aria-label="Преимущества">
                            {offer.benefits.map((b) => (
                              <li key={b}>{b}</li>
                            ))}
                          </ul>
                        ) : null}
                      </label>
                    </li>
                  );
                })}
              </ul>
              {q && phase === 'quoted' && !quoteExpired ? (
                <div className="residency-confirm" aria-label="Подтверждение">
                  <dl className="subscriptions-facts">
                    <div>
                      <dt>К оплате</dt>
                      <dd>{formatRub(q.amountMinor)}</dd>
                    </div>
                    <div>
                      <dt>Период</dt>
                      <dd>
                        {formatDay(q.validFrom)} — {formatDay(q.validUntil)}
                      </dd>
                    </div>
                  </dl>
                  <p className="residency-note">
                    Стоимость подтверждена клубом до{' '}
                    {new Date(q.expiresAt).toLocaleTimeString('ru-RU', {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                    . Оплата проходит на защищённой странице платёжного сервиса.
                  </p>
                  <button
                    type="button"
                    className="residency-primary"
                    disabled={busy || !canBuy}
                    onClick={() => void confirm()}
                  >
                    {renewing ? 'Подтвердить продление и оплатить' : 'Подтвердить и оплатить'}
                  </button>
                </div>
              ) : null}
              {canBuy && !selected ? (
                <p className="residency-note">
                  Выберите предложение, чтобы узнать итоговую стоимость.
                </p>
              ) : null}
              {canBuy ? (
                <button
                  type="button"
                  className={q && !quoteExpired ? 'residency-secondary' : 'residency-primary'}
                  disabled={busy || !selected}
                  onClick={() => void quote()}
                >
                  {q && quoteExpired
                    ? 'Цена устарела — обновить'
                    : q
                      ? 'Обновить стоимость'
                      : renewing
                        ? 'Продлить резидентство'
                        : 'Оформить резидентство'}
                </button>
              ) : null}
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
