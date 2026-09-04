import type {
  SummerSubscriptionAnalyticsUser,
  SummerSubscriptionPlanStatus,
  SummerSubscriptionPurchaseRequest,
  SummerSubscriptionPurchaseResponse,
  SummerSubscriptionStatusResponse,
} from './summer-subscription-types.js';

export const SUMMER_SUBSCRIPTION_STATUS_PATH = '/lk/tournaments/summer-subscription/status';
export const SUMMER_SUBSCRIPTION_PURCHASE_PATH = '/lk/tournaments/summer-subscription/purchase';
export const SUMMER_SUBSCRIPTION_POLL_MS = 5_000;
export const ANALYTICS_USER_STORAGE_KEY = 'iSkq6G_lk_analytics_user_v1';

export function summerSubscriptionApiBase(): string {
  const configured = import.meta.env.VITE_SUMMER_SUBSCRIPTION_API_BASE;
  if (configured) return configured.replace(/\/$/, '');
  return import.meta.env.DEV ? '' : 'https://padlhub.su';
}

export async function fetchSummerSubscriptionStatus(
  signal?: AbortSignal,
): Promise<SummerSubscriptionStatusResponse> {
  const response = await fetch(`${summerSubscriptionApiBase()}${SUMMER_SUBSCRIPTION_STATUS_PATH}`, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal,
  });
  if (!response.ok) {
    throw new Error(`Не удалось загрузить статус подписок (${response.status})`);
  }
  return (await response.json()) as SummerSubscriptionStatusResponse;
}

export async function createSummerSubscriptionPurchase(
  payload: SummerSubscriptionPurchaseRequest,
  signal?: AbortSignal,
): Promise<SummerSubscriptionPurchaseResponse> {
  const response = await fetch(`${summerSubscriptionApiBase()}${SUMMER_SUBSCRIPTION_PURCHASE_PATH}`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
    signal,
  });
  if (!response.ok) {
    throw new Error(`Не удалось создать ссылку на оплату (${response.status})`);
  }
  return (await response.json()) as SummerSubscriptionPurchaseResponse;
}

export function createPaymentRef(counterKey: string): string {
  const suffix = Math.random().toString(36).slice(2, 8);
  return `${counterKey}-summer-${Date.now()}-${suffix}`;
}

export function normalizeClientPhone(phone: string): string {
  return phone.replace(/\D/g, '');
}

export function readAnalyticsUserFromStorage(): SummerSubscriptionAnalyticsUser | null {
  const raw = window.localStorage.getItem(ANALYTICS_USER_STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<SummerSubscriptionAnalyticsUser>;
    if (!parsed.phone || !parsed.clientId) return null;
    return { phone: parsed.phone, clientId: parsed.clientId };
  } catch {
    return null;
  }
}

export function summerSubscriptionRedirectUrls(): {
  readonly successUrl: string;
  readonly failUrl: string;
  readonly baseRedirectUrl: string;
} {
  if (typeof window === 'undefined') {
    const fallback = 'https://padlhub.ru/ab_leto?authMode=viva';
    return { successUrl: fallback, failUrl: fallback, baseRedirectUrl: fallback };
  }

  const redirectUrl = new URL(window.location.href);
  redirectUrl.searchParams.set('scenario', 'test');
  const href = redirectUrl.toString();
  return { successUrl: href, failUrl: href, baseRedirectUrl: href };
}

export function buildSummerSubscriptionPurchaseRequest(
  plan: SummerSubscriptionPlanStatus,
  user: SummerSubscriptionAnalyticsUser,
): SummerSubscriptionPurchaseRequest {
  const redirects = summerSubscriptionRedirectUrls();
  return {
    clientPhone: normalizeClientPhone(user.phone),
    clientId: user.clientId,
    counterKey: plan.counterKey,
    planType: plan.planKey,
    plan: plan.planKey,
    tariff: null,
    campaignKey: plan.campaignKey,
    productId: plan.productId,
    paymentRef: createPaymentRef(plan.counterKey),
    successUrl: redirects.successUrl,
    failUrl: redirects.failUrl,
    baseRedirectUrl: redirects.baseRedirectUrl,
    trainerQrCode: null,
    referralToken: null,
    referralVisitId: null,
  };
}
