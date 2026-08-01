import type { BookingRecommendationPage } from './auth-gateway.js';

export type BookingRecommendationActivity = Extract<
  BookingRecommendationPage['items'][number],
  { kind: 'TRAINING' | 'TOURNAMENT' }
>['activity'];

export function isCoachGameActivity(activity: BookingRecommendationActivity): boolean {
  return activity.kind === 'TRAINING' && /игра\s*\+\s*тренер/iu.test(activity.title);
}
