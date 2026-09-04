import academyArtUrl from '../assets/plan-art/академия.svg';
import friendshipArtUrl from '../assets/plan-art/дружба.svg';
import raArtUrl from '../assets/plan-art/ра.svg';
import type { SubscriptionBenefitGroup, SubscriptionPlanView } from '../model.js';

export const discounts: SubscriptionBenefitGroup = {
  id: 'discounts',
  title: 'Сверх 1 часа:',
  items: [
    { id: 'game-discount', badge: '30%', label: 'Скидка на создание / участие в игре' },
    {
      id: 'other-discount',
      badge: '50%',
      label:
        'Скидка на форматы: игра + тренер, групповые тренировки, «Время на друзей», турниры Падлхаб',
    },
  ],
};

export const friendshipBenefits: readonly SubscriptionBenefitGroup[] = [
  {
    id: 'daily',
    title: '1 час в день:',
    items: [{ id: 'game', icon: 'game', label: 'Создание / участие в игре' }],
  },
  discounts,
];

export const fullBenefits: readonly SubscriptionBenefitGroup[] = [
  {
    id: 'daily',
    title: '1 час в день:',
    items: [
      { id: 'game', icon: 'game', label: 'Создание / участие в игре' },
      { id: 'training', icon: 'training', label: 'Игра + тренер' },
      { id: 'group', icon: 'group', label: 'Групповые тренировки' },
      { id: 'friends-time', icon: 'friends-time', label: '«Время на друзей»' },
      { id: 'tournament', icon: 'tournament', label: 'Турниры Падлхаб' },
    ],
  },
  discounts,
];

export const academyBenefits: readonly SubscriptionBenefitGroup[] = [
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

export const sportBenefits: readonly SubscriptionBenefitGroup[] = [
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

export type SummerPlanCounterKey = 'friendship' | 'ra' | 'academy' | 'sport';

export const summerPlanDisplayOrder: readonly SummerPlanCounterKey[] = [
  'friendship',
  'ra',
  'academy',
  'sport',
];

export interface SummerPlanPresentation
  extends Pick<SubscriptionPlanView, 'label' | 'tagTone' | 'artUrl' | 'featured' | 'benefitGroups'> {}

export const summerPlanPresentation: Readonly<Record<SummerPlanCounterKey, SummerPlanPresentation>> = {
  friendship: {
    label: 'Дружба',
    tagTone: '#49d8a1',
    artUrl: friendshipArtUrl,
    benefitGroups: friendshipBenefits,
  },
  ra: {
    label: 'РА',
    tagTone: '#9a74ef',
    artUrl: raArtUrl,
    featured: true,
    benefitGroups: fullBenefits,
  },
  academy: {
    label: 'Академия',
    tagTone: '#91dd1c',
    artUrl: academyArtUrl,
    benefitGroups: academyBenefits,
  },
  sport: {
    label: 'Спорт',
    tagTone: '#66bceb',
    benefitGroups: sportBenefits,
  },
};
