import markUrl from '../assets/brand/подписка.svg';
import type { SubscriptionPlanView, SubscriptionStorefrontView } from '../model.js';
import {
  summerPlanDisplayOrder,
  summerPlanPresentation,
  type SummerPlanCounterKey,
} from './plan-presentation.js';
import type { SummerSubscriptionPlanStatus, SummerSubscriptionStatusResponse } from './summer-subscription-types.js';

export const EXCLUDED_SUMMER_PLAN_KEYS = new Set(['energy5']);

export interface MappedSummerSubscriptionStorefront {
  readonly view: SubscriptionStorefrontView;
  readonly plansById: Readonly<Record<string, SummerSubscriptionPlanStatus>>;
}

function isSummerPlanCounterKey(counterKey: string): counterKey is SummerPlanCounterKey {
  return counterKey in summerPlanPresentation;
}

function mapBillingOption(plan: SummerSubscriptionPlanStatus): SubscriptionPlanView['billingOptions'][number] {
  const billingOption: SubscriptionPlanView['billingOptions'][number] = {
    id: 'monthly',
    label: 'мес.',
    priceMinor: plan.priceMinor,
  };

  if (!plan.unlimited && plan.totalLimit > 0) {
    return {
      ...billingOption,
      progress: {
        current: plan.remainingCount,
        total: plan.totalLimit,
        label: 'Осталось мест',
      },
    };
  }

  return billingOption;
}

function mapPlan(plan: SummerSubscriptionPlanStatus): SubscriptionPlanView | null {
  if (EXCLUDED_SUMMER_PLAN_KEYS.has(plan.counterKey) || !isSummerPlanCounterKey(plan.counterKey)) {
    return null;
  }

  const presentation = summerPlanPresentation[plan.counterKey];
  const billingOptions = [mapBillingOption(plan)];

  return {
    id: plan.counterKey,
    label: presentation.label,
    tagTone: presentation.tagTone,
    ...(presentation.artUrl ? { artUrl: presentation.artUrl } : {}),
    ...(presentation.featured ? { featured: true } : {}),
    billingOptions,
    initialBillingOptionId: 'monthly',
    ctaLabel: plan.canPurchase ? 'Оформить подписку' : 'Мест нет',
    ...(plan.canPurchase ? {} : { ctaDisabled: true }),
    benefitGroups: presentation.benefitGroups,
  };
}

export function mapSummerSubscriptionStatus(
  status: SummerSubscriptionStatusResponse,
): MappedSummerSubscriptionStorefront {
  const plansById: Record<string, SummerSubscriptionPlanStatus> = {};
  const plans: SubscriptionPlanView[] = [];

  for (const counterKey of summerPlanDisplayOrder) {
    const source = status.plans.find((plan) => plan.counterKey === counterKey);
    if (!source) continue;
    const mapped = mapPlan(source);
    if (!mapped) continue;
    plans.push(mapped);
    plansById[mapped.id] = source;
  }

  return {
    view: {
      id: 'summer-subscription-test',
      title: 'Лето начинается с падела',
      description: 'Актуальные цены и остатки обновляются каждые 5 секунд.',
      markUrl,
      markAlt: '',
      theme: {
        accent: '#7858df',
        accentStrong: '#6142c2',
        pageBackground: '#f8f8f4',
      },
      sections: [
        {
          id: 'leto-plans',
          title: 'Абонементы Лето.Падел',
          description: 'Данные загружаются с padlhub.su. Тариф «Энергия-5» скрыт.',
          plans,
        },
      ],
    },
    plansById,
  };
}
