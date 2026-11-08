import type { AuthGateway } from './auth-gateway.js';

/**
 * Server-side level refusals for tournament and training registration. The server evaluates the
 * policy before creating any attempt, so a 409 level refusal means nothing was registered or
 * dispatched under that idempotency key.
 */
const LEVEL_REFUSAL_MESSAGES: Readonly<Record<string, string>> = {
  PLAYER_LEVEL_REQUIRED: 'Чтобы записаться, укажите свой уровень.',
  PLAYER_LEVEL_UNKNOWN: 'Не удалось определить ваш уровень. Укажите его и повторите.',
  LEVEL_NOT_ALLOWED: 'Ваш уровень не подходит под диапазон этой активности.',
  LEVEL_SPORT_MISMATCH: 'Уровень указан для другого вида спорта.',
  LEVEL_SCALE_VERSION_MISMATCH: 'Шкала вашего уровня устарела. Обновите уровень и повторите.',
  ACTIVITY_LEVEL_UNDEFINED: 'Для этой активности не настроен диапазон уровней.',
  ACTIVITY_LEVEL_INVALID: 'Диапазон уровней этой активности настроен некорректно.',
  LEVEL_POLICY_MISCONFIGURED: 'Правило допуска по уровню временно настроено некорректно.',
};

const LEVEL_SETUP_CODES = new Set([
  'PLAYER_LEVEL_REQUIRED',
  'PLAYER_LEVEL_UNKNOWN',
  'LEVEL_SCALE_VERSION_MISMATCH',
]);

export interface ParticipationLevelRefusal {
  readonly code: string;
  readonly message: string;
  /** The player can resolve it by choosing a level (CUP has not projected one). */
  readonly needsLevel: boolean;
}

function errorField(error: unknown, field: 'code' | 'status'): unknown {
  return error && typeof error === 'object' && field in error
    ? (error as Record<string, unknown>)[field]
    : undefined;
}

export function participationLevelRefusal(error: unknown): ParticipationLevelRefusal | null {
  const code = errorField(error, 'code');
  if (typeof code !== 'string' || errorField(error, 'status') !== 409) return null;
  const message = LEVEL_REFUSAL_MESSAGES[code];
  return message ? { code, message, needsLevel: LEVEL_SETUP_CODES.has(code) } : null;
}

export function participationLevelUnavailable(error: unknown): boolean {
  return errorField(error, 'code') === 'PARTICIPATION_LEVEL_UNAVAILABLE';
}

export const PARTICIPATION_LEVEL_UNAVAILABLE_MESSAGE =
  'Не удалось проверить допуск по уровню. Запись не отправлена; повторите позже.';

export function canPickParticipationLevel(
  gateway: Pick<AuthGateway, 'getOwnPlayerLevel' | 'setOwnPlayerLevel'>,
): boolean {
  return Boolean(gateway.getOwnPlayerLevel && gateway.setOwnPlayerLevel);
}
