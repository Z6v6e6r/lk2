import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { SubscriptionPurchaseResult } from '@phub/api-sdk';
import {
  monthlyOffer,
  monthlyStorageKey,
  loadMonthlyCustody,
  saveMonthlyCustody,
  validateMonthlyQuote,
  validateMonthlyResult,
  validateMonthlyLaunch,
  monthlyConsent,
  monthlyIdentity,
  type MonthlyCustody,
  type MonthlyPrincipal,
  type MonthlyPurchaseGateway,
} from './monthly-purchase-attempt.js';
import './MonthlyPurchasePanel.css';
/** One durable original key. Neither mount nor foreground can create or retry a payment. */
export function MonthlyPurchasePanel(props: {
  gateway: MonthlyPurchaseGateway;
  principal: MonthlyPrincipal;
}): React.JSX.Element {
  const original = props.gateway.monthlyPurchasePrincipal();
  return (
    <MonthlyPurchaseSession
      key={props.principal.tenantId + ':' + props.principal.userId + ':' + original}
      {...props}
      original={original}
    />
  );
}
function MonthlyPurchaseSession({
  gateway,
  principal,
  original,
}: {
  gateway: MonthlyPurchaseGateway;
  principal: MonthlyPrincipal;
  original: string | null;
}): React.JSX.Element {
  const [available, setAvailable] = useState(false),
    [custody, setCustody] = useState<MonthlyCustody | null>(null),
    [result, setResult] = useState<SubscriptionPurchaseResult | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  const scope = principal.tenantId + ':' + principal.userId;
  const mounted = useRef({ active: true }),
    busyRef = useRef(false);
  useLayoutEffect(() => {
    const lifetime = mounted.current;
    lifetime.active = true;
    return () => {
      lifetime.active = false;
    };
  }, []);
  const run = async (
    action: 'read' | 'quote' | 'buy' | 'retry' | 'reconcile' | 'launch' | 'new',
  ) => {
    if (busyRef.current) return;
    const p = gateway.monthlyPurchasePrincipal();
    const check = () => {
      if (
        !p ||
        p !== original ||
        p !== gateway.monthlyPurchasePrincipal() ||
        !mounted.current.active
      )
        throw new Error('MONTHLY_SESSION_CHANGED');
    };
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      check();
      const storage = window.localStorage,
        locks = navigator.locks;
      if (!locks) throw new Error('MONTHLY_STORAGE_UNAVAILABLE');
      await locks.request(monthlyStorageKey(principal), async () => {
        check();
        let c = loadMonthlyCustody(storage, principal);
        if (!['read', 'quote'].includes(action) && c?.key !== custody?.key)
          throw new Error('MONTHLY_CUSTODY_CHANGED');
        if (action === 'new') {
          if (!c) return;
          const receipt = await validateMonthlyResult(
            await gateway.getSubscriptionPurchase(c.key),
            c,
          );
          check();
          if (receipt.status !== 'PAID') throw new Error('MONTHLY_PENDING');
          storage.removeItem(monthlyStorageKey(principal));
          if (storage.getItem(monthlyStorageKey(principal)) !== null)
            throw new Error('MONTHLY_STORAGE_UNAVAILABLE');
          setCustody(null);
          setResult(null);
          return;
        }
        if (action === 'quote') {
          if (!available) throw new Error('MONTHLY_PENDING');
          if (c?.submitted) {
            const fresh = await validateMonthlyResult(
              await gateway.getSubscriptionPurchase(c.key),
              c,
            );
            check();
            if (!['QUOTING', 'QUOTED'].includes(fresh.status)) throw new Error('MONTHLY_PENDING');
          }
          if (!c) {
            c = {
              version: 1,
              ...principal,
              key: 'monthly:' + crypto.randomUUID(),
              submitted: false,
              quote: null,
            };
            saveMonthlyCustody(storage, c);
          }
          check();
          const q = await validateMonthlyQuote(
            await gateway.quoteSubscriptionPurchase(monthlyOffer, c.key),
            c,
          );
          check();
          c = { ...c, quote: q, submitted: false };
          saveMonthlyCustody(storage, c);
          setCustody(c);
          setResult(null);
          return;
        }
        if (!c) {
          setCustody(null);
          return;
        }
        setCustody(c);
        if (action === 'buy' || action === 'retry') {
          if (
            !available ||
            (action === 'buy' && c.submitted) ||
            (action === 'retry' && !c.submitted) ||
            JSON.stringify(c.quote) !== JSON.stringify(custody?.quote) ||
            !c.quote ||
            Date.parse(c.quote.expiresAt) <= Date.now()
          )
            throw new Error('MONTHLY_QUOTE_EXPIRED');
          if (action === 'retry') {
            const r = await validateMonthlyResult(await gateway.getSubscriptionPurchase(c.key), c);
            check();
            if (r.status !== 'QUOTED') throw new Error('MONTHLY_PENDING');
          }
          // Durable custody precedes even a potentially ambiguous native bridge invocation.
          c = { ...c, submitted: true };
          saveMonthlyCustody(storage, c);
          setCustody(c);
          check();
          const r = await validateMonthlyResult(
            await gateway.purchaseSubscription(monthlyConsent(c.quote!), c.key),
            c,
          );
          check();
          setResult(r);
          return;
        }
        const id = await monthlyIdentity(c);
        check();
        if (action === 'launch') {
          const fresh = await validateMonthlyResult(
            await gateway.getSubscriptionPurchase(c.key),
            c,
          );
          check();
          setResult(fresh);
          if (!fresh.canOpenPayment) throw new Error('MONTHLY_PAYMENT_UNAVAILABLE');
          const code = await validateMonthlyLaunch(
            await gateway.launchSubscriptionPayment(id.operationId, c.key),
            c,
          );
          check();
          await gateway.openSubscriptionPayment({
            operationId: code.operationId,
            launchCode: code.launchCode,
          });
          check();
          return;
        }
        if (!c.submitted) {
          setResult(null);
          return;
        }
        const r = await validateMonthlyResult(
          action === 'reconcile'
            ? await gateway.reconcileSubscriptionPurchase(id.operationId, c.key)
            : await gateway.getSubscriptionPurchase(c.key),
          c,
        );
        check();
        setResult(r);
      });
    } catch {
      if (mounted.current.active && p === gateway.monthlyPurchasePrincipal())
        setError(
          'Не удалось подтвердить результат. Проверьте статус этой покупки, когда связь восстановится.',
        );
    } finally {
      if (mounted.current.active) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  };
  useEffect(() => {
    const p = gateway.monthlyPurchasePrincipal();
    void gateway
      .getSubscriptionPurchaseCapability()
      .then((v) => {
        if (mounted.current.active && p && p === gateway.monthlyPurchasePrincipal())
          setAvailable(
            v.contractVersion === 1 &&
              v.available === true &&
              v.offers.length === 1 &&
              v.offers[0]?.id === monthlyOffer,
          );
      })
      .catch(() => {});
    void run('read');
    const foreground = () => {
      if (document.visibilityState === 'visible') void run('read');
    };
    document.addEventListener('visibilitychange', foreground);
    return () => document.removeEventListener('visibilitychange', foreground);
    // The effect captures a complete account epoch; button handlers use the current render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, original, gateway]);
  if (!original || original !== gateway.monthlyPurchasePrincipal())
    return (
      <section className="monthly-purchase">
        <h2>Абонемент «Дружба»</h2>
        <p>Покупка пока недоступна.</p>
      </section>
    );
  const quote = custody?.quote;
  return (
    <section className="monthly-purchase" aria-labelledby="monthly-purchase-title" aria-busy={busy}>
      <h2 id="monthly-purchase-title">Абонемент «Дружба»</h2>
      <p>Покупка месячного абонемента</p>
      {!available && !custody ? <p>Покупка пока недоступна.</p> : null}
      {quote && !custody?.submitted ? (
        <>
          <p className="monthly-purchase-price">
            {new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB' }).format(
              quote.amountMinor / 100,
            )}
          </p>
          <p>Цена подтверждена до {new Date(quote.expiresAt).toLocaleTimeString('ru-RU')}.</p>
          <button disabled={busy || !available} onClick={() => void run('buy')}>
            Подтвердить покупку
          </button>
        </>
      ) : null}
      {!custody?.submitted && available ? (
        <button disabled={busy} onClick={() => void run('quote')}>
          {quote ? 'Обновить предложение' : 'Узнать стоимость'}
        </button>
      ) : null}
      {custody?.submitted ? (
        <>
          <p role="status">
            {result?.status === 'PAID'
              ? 'Оплата подтверждена. Актуальные сроки и остаток смотрите в списке абонементов.'
              : result?.status === 'PAYMENT_PENDING'
                ? 'Покупка ожидает оплаты.'
                : 'Результат покупки уточняется.'}
          </p>
          <button disabled={busy} onClick={() => void run('reconcile')}>
            Проверить статус покупки
          </button>
          {result && ['QUOTING', 'QUOTED'].includes(result.status) ? (
            <button disabled={busy || !available} onClick={() => void run('quote')}>
              Обновить цену этой покупки
            </button>
          ) : null}
          {result?.status === 'QUOTED' ? (
            <button disabled={busy || !available} onClick={() => void run('retry')}>
              Повторить отправку этой покупки
            </button>
          ) : null}
          {result?.canOpenPayment ? (
            <button disabled={busy} onClick={() => void run('launch')}>
              Перейти к оплате
            </button>
          ) : null}
          {result?.status === 'PAID' ? (
            <button disabled={busy || !available} onClick={() => void run('new')}>
              Новая покупка
            </button>
          ) : null}
        </>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}
