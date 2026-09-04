import { describe, expect, it } from 'vitest';

import { mapSummerSubscriptionStatus } from './summer-subscription-mapper.js';
import type { SummerSubscriptionStatusResponse } from './summer-subscription-types.js';
import {
  buildSummerSubscriptionPurchaseRequest,
  createPaymentRef,
  normalizeClientPhone,
} from './summer-subscription-api.js';

const statusFixture: SummerSubscriptionStatusResponse = {
  ok: true,
  counterKey: 'sport',
  inventoryId: 'ab_leto_2026_50_v1',
  unlimited: false,
  planKey: 'sport',
  planType: 'sport',
  campaignKey: 'summer_padel_sport_2026',
  productId: '82caad6f-4d19-4d01-852b-932bdbb0f405',
  productName: 'Лето.Падел.Спорт',
  totalLimit: 132,
  paidCount: 40,
  reservedCount: 0,
  takenCount: 40,
  remainingCount: 92,
  canPurchase: true,
  priceMinor: 1_980_000,
  price: 19_800,
  updatedAt: '2026-08-10T13:04:15.764Z',
  plans: [
    {
      counterKey: 'friendship',
      inventoryId: 'ab_leto_2026_100_then_7_v1_friendship',
      unlimited: false,
      saleType: 'summer_campaign',
      planKey: 'friendship',
      campaignKey: 'summer_padel_friendship_2026',
      productId: 'b2e6a9d4-53b5-4f79-87ec-3fb076381e9b',
      productName: 'Лето.Падел.Дружба',
      totalLimit: 7,
      paidCount: 5,
      reservedCount: 0,
      takenCount: 5,
      remainingCount: 2,
      canPurchase: true,
      bindingReady: true,
      bindingError: null,
      priceMinor: 980_000,
      price: 9800,
      updatedAt: '2026-09-01T11:18:46.961Z',
    },
    {
      counterKey: 'sport',
      inventoryId: 'ab_leto_2026_50_v1',
      unlimited: false,
      saleType: 'summer_campaign',
      planKey: 'sport',
      campaignKey: 'summer_padel_sport_2026',
      productId: '82caad6f-4d19-4d01-852b-932bdbb0f405',
      productName: 'Лето.Падел.Спорт',
      totalLimit: 132,
      paidCount: 40,
      reservedCount: 0,
      takenCount: 40,
      remainingCount: 92,
      canPurchase: true,
      bindingReady: true,
      bindingError: null,
      priceMinor: 1_980_000,
      price: 19_800,
      updatedAt: '2026-08-10T13:04:15.764Z',
    },
    {
      counterKey: 'academy',
      inventoryId: 'ab_leto_2026_50_v1',
      unlimited: true,
      saleType: 'direct_product',
      planKey: null,
      campaignKey: null,
      productId: '9eb8a7a4-c195-492a-95e4-3fb82899ac10',
      productName: 'Лето.Падел.Академия',
      totalLimit: 0,
      paidCount: 162,
      reservedCount: 0,
      takenCount: 162,
      remainingCount: 0,
      canPurchase: true,
      bindingReady: true,
      bindingError: null,
      priceMinor: 2_380_000,
      price: 23_800,
      updatedAt: '2026-09-01T11:18:44.968Z',
    },
    {
      counterKey: 'ra',
      inventoryId: 'ab_leto_2026_100_then_7_v1_ra',
      unlimited: false,
      saleType: 'direct_product',
      planKey: null,
      campaignKey: null,
      productId: 'b91e14d1-fe6e-4d0b-be39-3e45ad86b759',
      productName: 'Лето.Падел.РА',
      totalLimit: 10,
      paidCount: 3,
      reservedCount: 0,
      takenCount: 3,
      remainingCount: 7,
      canPurchase: true,
      bindingReady: true,
      bindingError: null,
      priceMinor: 2_380_000,
      price: 23_800,
      updatedAt: '2026-09-01T11:18:48.946Z',
    },
    {
      counterKey: 'energy5',
      inventoryId: 'ab_leto_2026_50_v1',
      unlimited: true,
      saleType: 'direct_product',
      planKey: null,
      campaignKey: null,
      productId: 'dfa72adf-233b-4285-8d69-e5eab4234fbe',
      productName: 'Энергия-5',
      totalLimit: 0,
      paidCount: 203,
      reservedCount: 0,
      takenCount: 203,
      remainingCount: 0,
      canPurchase: true,
      bindingReady: true,
      bindingError: null,
      priceMinor: 1_980_000,
      price: 19_800,
      updatedAt: '2026-09-01T11:18:43.958Z',
    },
  ],
};

describe('summer subscription mapper', () => {
  it('maps live plans into storefront cards and excludes energy5', () => {
    const mapped = mapSummerSubscriptionStatus(statusFixture);

    expect(mapped.view.sections[0]?.plans.map((plan) => plan.id)).toEqual([
      'friendship',
      'ra',
      'academy',
      'sport',
    ]);
    expect(mapped.view.sections[0]?.plans.find((plan) => plan.id === 'friendship')?.billingOptions[0])
      .toMatchObject({
        priceMinor: 980_000,
        progress: { current: 2, total: 7, label: 'Осталось мест' },
      });
    expect(mapped.view.sections[0]?.plans.find((plan) => plan.id === 'academy')?.billingOptions[0]).not
      .toHaveProperty('progress');
    expect(mapped.plansById.energy5).toBeUndefined();
  });

  it('disables CTA when canPurchase is false', () => {
    const soldOut = {
      ...statusFixture,
      plans: statusFixture.plans.map((plan) =>
        plan.counterKey === 'ra' ? { ...plan, canPurchase: false, remainingCount: 0 } : plan,
      ),
    };
    const mapped = mapSummerSubscriptionStatus(soldOut);
    const ra = mapped.view.sections[0]?.plans.find((plan) => plan.id === 'ra');
    expect(ra).toMatchObject({ ctaLabel: 'Мест нет', ctaDisabled: true });
  });
});

describe('summer subscription purchase helpers', () => {
  it('normalizes phone numbers for purchase payload', () => {
    expect(normalizeClientPhone('+79123456789')).toBe('79123456789');
  });

  it('builds purchase payload from analytics user and selected plan', () => {
    const plan = statusFixture.plans.find((entry) => entry.counterKey === 'academy')!;
    const payload = buildSummerSubscriptionPurchaseRequest(plan, {
      phone: '+79123456789',
      clientId: '12345678-1234-1234-1234-123456789012',
    });

    expect(payload).toMatchObject({
      clientPhone: '79123456789',
      clientId: '12345678-1234-1234-1234-123456789012',
      counterKey: 'academy',
      productId: '9eb8a7a4-c195-492a-95e4-3fb82899ac10',
      campaignKey: null,
      planType: null,
      plan: null,
    });
    expect(payload.paymentRef.startsWith('academy-summer-')).toBe(true);
  });

  it('creates unique payment refs', () => {
    expect(createPaymentRef('friendship')).not.toBe(createPaymentRef('friendship'));
  });
});
