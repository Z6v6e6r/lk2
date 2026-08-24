import { ApiClientError } from '@phub/api-sdk';

export const LEGAL_ACCEPTANCE_MESSAGE =
  'Подтвердите публичную оферту и обработку персональных данных.';
export const PHONE_INVALID_MESSAGE = 'Проверьте номер телефона.';
export const CODE_INVALID_MESSAGE = 'Код не подошёл. Попробуйте ещё раз.';
export const CODE_EXPIRED_MESSAGE = 'Срок действия кода истёк. Получите новый код.';
export const UNKNOWN_AUTH_ERROR_MESSAGE =
  'Не удалось выполнить вход. Проверьте связь и попробуйте ещё раз.';

const messagesByCode: Readonly<Record<string, string>> = {
  LEGAL_ACCEPTANCE_REQUIRED: LEGAL_ACCEPTANCE_MESSAGE,
  AUTH_PHONE_INVALID: PHONE_INVALID_MESSAGE,
  AUTH_CODE_INVALID: CODE_INVALID_MESSAGE,
  AUTH_CODE_EXPIRED: CODE_EXPIRED_MESSAGE,
  AUTH_PROVIDER_UNAVAILABLE: 'Этот способ входа сейчас недоступен. Выберите номер телефона.',
};

export function messageForAuthError(error: unknown): string {
  if (!(error instanceof ApiClientError)) return UNKNOWN_AUTH_ERROR_MESSAGE;
  return messagesByCode[error.code] ?? UNKNOWN_AUTH_ERROR_MESSAGE;
}
