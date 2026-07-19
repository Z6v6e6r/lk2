import type { GameCard as ViewerGameCard, PublicGameCard } from './auth-gateway.js';

export type GameCardModel = ViewerGameCard | PublicGameCard;
export type GameCardAction = GameCardModel['allowedActions'][number];

const stateLabels: Record<GameCardModel['displayState'], string> = {
  FINDING_PLAYERS: 'Ищем игроков',
  ONE_SPOT_LEFT: 'Осталось одно место',
  ROSTER_READY: 'Состав набран',
  SEAT_PAYMENT_REQUIRED: 'Нужно оплатить место',
  STARTING_SOON: 'Скоро начало',
  REGISTRATION_CLOSED: 'Регистрация закрыта',
  IN_PROGRESS: 'Игра идёт',
  RESULT_REQUIRED: 'Внесите счёт',
  RESULT_PENDING: 'Ожидание результата',
  RESULT_DISPUTED: 'Результат оспаривается',
  COMPLETED: 'Игра состоялась',
  CANCELLED: 'Игра отменена',
};

const actionPriority: readonly GameCardAction[] = [
  'PAY',
  'RETRY_PAYMENT',
  'JOIN',
  'JOIN_WAITLIST',
  'SUBMIT_RESULT',
  'CONFIRM_RESULT',
  'DISPUTE_RESULT',
  'OPEN_DISPUTE',
  'VIEW_RESULT',
  'LEAVE_WAITLIST',
  'LEAVE',
];

export function gameStateLabel(state: GameCardModel['displayState']): string {
  return stateLabels[state];
}

export function gamePrimaryAction(game: GameCardModel): GameCardAction | undefined {
  const allowedActions: readonly string[] = game.allowedActions;
  return actionPriority.find((action) => allowedActions.includes(action));
}
