import type { SubscriptionBenefitIcon } from '../model.js';
import friendsTimeUrl from './icons/time.svg';
import gameUrl from './icons/game.svg';
import groupUrl from './icons/group.svg';
import tournamentUrl from './icons/tournament.svg';
import trainingUrl from './icons/training.svg';

export const subscriptionBenefitIconUrls: Readonly<Record<SubscriptionBenefitIcon, string>> = {
  game: gameUrl,
  training: trainingUrl,
  group: groupUrl,
  'friends-time': friendsTimeUrl,
  tournament: tournamentUrl,
};
