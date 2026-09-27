import type { GameCard as ViewerGameCard, PublicGameCard } from './auth-gateway.js';

export type GameCardModel = ViewerGameCard | PublicGameCard;
export type GameCardAction = GameCardModel['allowedActions'][number];

/** How a card or the detail screen reaches the game chat, if at all. */
export type GameChatEntry = 'OPEN' | 'CREATE' | 'NONE';

/**
 * The card and the detail screen must agree on the game chat entry: an authorized conversation is
 * always openable; a viewer who is on the roster can create or open the thread on demand, except for
 * a cancelled game, where the messaging command cannot open a conversation at all. Everyone else —
 * an anonymous discovery card, an outsider, a waitlisted or merely reserved viewer — gets no entry,
 * because the server never sends them a conversation reference.
 */
export function gameChatEntry(game: GameCardModel): GameChatEntry {
  // Only a viewer card carries a conversation reference at all; a public card never does.
  if ('conversation' in game && game.conversation && game.allowedActions.includes('OPEN_CHAT')) {
    return 'OPEN';
  }
  if (
    game.displayState !== 'CANCELLED' &&
    (game.viewerRelation === 'ORGANIZER' || game.viewerRelation === 'PARTICIPANT')
  ) {
    return 'CREATE';
  }
  return 'NONE';
}

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
  COMPLETED: 'Игра завершена',
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
  'CANCEL',
];

export function gameStateLabel(state: GameCardModel['displayState']): string {
  return stateLabels[state];
}

export function gamePrimaryAction(game: GameCardModel): GameCardAction | undefined {
  const allowedActions: readonly string[] = game.allowedActions;
  return actionPriority.find((action) => allowedActions.includes(action));
}

export function gameHistoryStateLabel(game: GameCardModel): string {
  if ('resultSummary' in game && game.resultSummary?.state === 'CONFIRMED') {
    return 'Результат внесён';
  }
  return gameStateLabel(game.displayState);
}

export function gameHistoryPrimaryAction(game: GameCardModel): GameCardAction | undefined {
  const allowedActions: readonly string[] = game.allowedActions;
  if (game.displayState === 'RESULT_REQUIRED' && allowedActions.includes('SUBMIT_RESULT')) {
    return 'SUBMIT_RESULT';
  }
  if (game.displayState === 'RESULT_PENDING' && allowedActions.includes('DISPUTE_RESULT')) {
    return 'DISPUTE_RESULT';
  }
  return undefined;
}
