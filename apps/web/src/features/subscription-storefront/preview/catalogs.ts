import markUrl from '../assets/subscription-mark-compact.png';
import type { SubscriptionBenefitGroup, SubscriptionStorefrontView } from '../model.js';

const discounts: SubscriptionBenefitGroup = {
  id: 'discounts',
  title: 'Сверх 1 часа:',
  items: [
    { id: 'game-discount', badge: '30%', label: 'Скидка на создание / участие в игре' },
    { id: 'other-discount', badge: '50%', label: 'Скидка на все остальные форматы' },
  ],
};

const friendshipBenefits: readonly SubscriptionBenefitGroup[] = [
  {
    id: 'daily',
    title: '1 час в день:',
    items: [{ id: 'game', icon: 'game', label: 'Создание / участие в игре' }],
  },
  discounts,
];

const fullBenefits: readonly SubscriptionBenefitGroup[] = [
  {
    id: 'daily',
    title: '1 час в день:',
    items: [
      { id: 'game', icon: 'game', label: 'Создание / участие в игре' },
      { id: 'training', icon: 'training', label: 'Игра + тренер' },
      { id: 'group', icon: 'group', label: 'Групповые тренировки' },
      { id: 'tournament', icon: 'tournament', label: 'Турниры «Время на друзей»' },
    ],
  },
  discounts,
];

const academyBenefits: readonly SubscriptionBenefitGroup[] = [
  {
    id: 'daily',
    title: '1 час в день:',
    items: [
      { id: 'game', icon: 'game', label: 'Создание / участие в игре' },
      { id: 'training', icon: 'training', label: 'Игра + тренер' },
      { id: 'group', icon: 'group', label: 'Групповые тренировки' },
    ],
  },
  discounts,
];

const primaryPlans = [
  {
    id: 'friendship',
    label: 'Дружба',
    tagTone: 'mint' as const,
    billingOptions: [
      { id: 'monthly', label: 'месячная', priceMinor: 980_000 },
      { id: 'annual', label: 'годовая', priceMinor: 9_800_000, priceSuffix: '/ год' },
    ],
    benefitGroups: friendshipBenefits,
  },
  {
    id: 'ra',
    label: 'РА',
    tagTone: 'violet' as const,
    featured: true,
    progress: { current: 12, total: 100, label: 'Осталось мест' },
    billingOptions: [{ id: 'monthly', label: 'месячная', priceMinor: 2_380_000 }],
    benefitGroups: fullBenefits,
  },
  {
    id: 'academy',
    label: 'Академия',
    tagTone: 'lime' as const,
    billingOptions: [{ id: 'monthly', label: 'месячная', priceMinor: 2_380_000 }],
    benefitGroups: academyBenefits,
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
          tagTone: 'blue',
          billingOptions: [{ id: 'monthly', label: 'месячная', priceMinor: 1_580_000 }],
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
          tagTone: 'lime',
          featured: true,
          billingOptions: [
            { id: 'season', label: 'сезон', priceMinor: 1_490_000, priceSuffix: '/ сезон' },
          ],
          benefitGroups: academyBenefits,
        },
        {
          id: 'weekend',
          label: 'Выходные',
          tagTone: 'blue',
          billingOptions: [{ id: 'monthly', label: 'месячная', priceMinor: 890_000 }],
          benefitGroups: friendshipBenefits,
        },
      ],
    },
  ],
};
