import markUrl from '../assets/brand/подписка.svg';
import type { SubscriptionStorefrontView } from '../model.js';
import {
  academyBenefits,
  friendshipBenefits,
  summerPlanPresentation,
} from './plan-presentation.js';

/** Default desktop mock aligned with the Figma/storefront card trio. */
const primaryPlans = [
  {
    id: 'friendship',
    ...summerPlanPresentation.friendship,
    billingOptions: [
      { id: 'monthly', label: 'мес.', priceMinor: 980_000 },
      { id: 'x2', label: 'X2', priceMinor: 1_960_000, priceSuffix: '/ 2 мес.' },
      {
        id: 'annual',
        label: 'год',
        priceMinor: 9_800_000,
        priceSuffix: '/ год',
        progress: { current: 45, total: 200, label: 'Осталось мест' },
      },
    ],
  },
  {
    id: 'ra',
    ...summerPlanPresentation.ra,
    billingOptions: [
      {
        id: 'monthly',
        label: 'мес.',
        priceMinor: 2_380_000,
        progress: { current: 12, total: 100, label: 'Осталось мест' },
      },
    ],
  },
  {
    id: 'academy',
    ...summerPlanPresentation.academy,
    billingOptions: [{ id: 'monthly', label: 'мес.', priceMinor: 2_380_000 }],
  },
] as const;

export const defaultSubscriptionStorefront: SubscriptionStorefrontView = {
  id: 'subscriptions-default-preview',
  title: 'Играй в падел выгодно',
  description: 'Выберите формат, который подходит вашему ритму игры и тренировок.',
  markUrl,
  markAlt: '',
  sections: [{ id: 'main-plans', plans: primaryPlans }],
};

export const abLetoSubscriptionStorefront: SubscriptionStorefrontView = {
  id: 'ab-leto-preview',
  title: 'Лето начинается с падела',
  description: 'Демонстрационная конфигурация отдельной промостраницы на том же UI-каркасе.',
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
      description: 'Контент ниже является локальной фикстурой и не отражает активные продажи.',
      plans: [
        ...primaryPlans,
        {
          id: 'energy-five',
          label: 'Энергия-5',
          tagTone: '#66bceb',
          billingOptions: [{ id: 'monthly', label: 'мес.', priceMinor: 1_580_000 }],
          benefitGroups: friendshipBenefits,
        },
      ],
    },
  ],
};

export const multiSectionSubscriptionStorefront: SubscriptionStorefrontView = {
  ...defaultSubscriptionStorefront,
  id: 'subscriptions-multi-section-preview',
  sections: [
    { id: 'main-plans', title: 'Основные абонементы', plans: primaryPlans },
    {
      id: 'seasonal-plans',
      title: 'Сезонные предложения',
      description: 'Вторая секция проверяет вертикальный скролл страницы.',
      plans: [
        {
          id: 'summer-training',
          label: 'Лето',
          tagTone: '#91dd1c',
          featured: true,
          billingOptions: [
            { id: 'season', label: 'сезон', priceMinor: 1_490_000, priceSuffix: '/ сезон' },
          ],
          benefitGroups: academyBenefits,
        },
        {
          id: 'weekend',
          label: 'Выходные',
          tagTone: '#66bceb',
          billingOptions: [{ id: 'monthly', label: 'мес.', priceMinor: 890_000 }],
          benefitGroups: friendshipBenefits,
        },
      ],
    },
  ],
};

// Re-export for tests and static previews.
export { fullBenefits, friendshipBenefits, academyBenefits } from './plan-presentation.js';
