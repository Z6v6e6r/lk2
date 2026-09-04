import { useCallback, useEffect, useState } from 'react';

import { SubscriptionStorefront } from '../SubscriptionStorefront.js';
import type { SubscriptionPlanSelection } from '../model.js';
import {
  buildSummerSubscriptionPurchaseRequest,
  createSummerSubscriptionPurchase,
  fetchSummerSubscriptionStatus,
  readAnalyticsUserFromStorage,
  SUMMER_SUBSCRIPTION_POLL_MS,
} from './summer-subscription-api.js';
import { mapSummerSubscriptionStatus } from './summer-subscription-mapper.js';
import type { MappedSummerSubscriptionStorefront } from './summer-subscription-mapper.js';

type PreviewNotice =
  | { readonly kind: 'info'; readonly message: string }
  | { readonly kind: 'error'; readonly message: string };

export function SubscriptionStorefrontTestPreview(): React.JSX.Element {
  const [mapped, setMapped] = useState<MappedSummerSubscriptionStorefront | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<PreviewNotice | null>(null);
  const [purchaseBusy, setPurchaseBusy] = useState(false);

  const refreshStatus = useCallback(async (signal?: AbortSignal) => {
    const status = await fetchSummerSubscriptionStatus(signal);
    setMapped(mapSummerSubscriptionStatus(status));
    setError(null);
    setLoading(false);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void refreshStatus(controller.signal).catch((refreshError: unknown) => {
      if (controller.signal.aborted) return;
      setError(refreshError instanceof Error ? refreshError.message : 'Не удалось загрузить данные');
      setLoading(false);
    });

    const intervalId = window.setInterval(() => {
      void refreshStatus(controller.signal).catch((refreshError: unknown) => {
        if (controller.signal.aborted) return;
        setError(refreshError instanceof Error ? refreshError.message : 'Не удалось обновить данные');
      });
    }, SUMMER_SUBSCRIPTION_POLL_MS);

    return () => {
      controller.abort();
      window.clearInterval(intervalId);
    };
  }, [refreshStatus]);

  async function handleChoose(selection: SubscriptionPlanSelection): Promise<void> {
    if (!mapped) return;

    const plan = mapped.plansById[selection.planId];
    if (!plan) {
      setNotice({ kind: 'error', message: 'Тариф не найден в последнем ответе API.' });
      return;
    }
    if (!plan.canPurchase) {
      setNotice({ kind: 'error', message: `${plan.productName}: покупка сейчас недоступна.` });
      return;
    }

    const user = readAnalyticsUserFromStorage();
    if (!user) {
      setNotice({
        kind: 'error',
        message: `В localStorage нет ${'iSkq6G_lk_analytics_user_v1'} с phone и clientId.`,
      });
      return;
    }

    setPurchaseBusy(true);
    setNotice({ kind: 'info', message: `Создаём ссылку на оплату для ${plan.productName}…` });

    try {
      const response = await createSummerSubscriptionPurchase(
        buildSummerSubscriptionPurchaseRequest(plan, user),
      );
      if (!response.ok || !response.paymentUrl) {
        throw new Error('Сервер не вернул ссылку на оплату.');
      }
      window.location.assign(response.paymentUrl);
    } catch (purchaseError: unknown) {
      setNotice({
        kind: 'error',
        message:
          purchaseError instanceof Error ? purchaseError.message : 'Не удалось создать ссылку на оплату.',
      });
      setPurchaseBusy(false);
    }
  }

  if (loading && !mapped) {
    return (
      <main className="subscription-storefront subscription-storefront--loading" aria-busy="true">
        <p role="status">Загружаем актуальные данные подписок…</p>
      </main>
    );
  }

  if (error && !mapped) {
    return (
      <main className="subscription-storefront subscription-storefront--error">
        <p role="alert">{error}</p>
      </main>
    );
  }

  if (!mapped) {
    return (
      <main className="subscription-storefront subscription-storefront--error">
        <p role="alert">Нет данных для отображения витрины.</p>
      </main>
    );
  }

  return (
    <>
      <SubscriptionStorefront
        view={mapped.view}
        onBack={() => window.history.back()}
        onMore={() => undefined}
        onChoose={(selection) => {
          void handleChoose(selection);
        }}
      />
      {error ? (
        <output className="subscription-preview-selection subscription-preview-selection--error" aria-live="polite">
          {error}
        </output>
      ) : null}
      {notice ? (
        <output
          className={`subscription-preview-selection${
            notice.kind === 'error' ? ' subscription-preview-selection--error' : ''
          }`}
          aria-live="polite"
        >
          {purchaseBusy && notice.kind === 'info' ? '… ' : ''}
          {notice.message}
        </output>
      ) : null}
    </>
  );
}
