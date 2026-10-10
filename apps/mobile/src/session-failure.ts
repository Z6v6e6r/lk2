import { ApiClientError } from '@phub/api-sdk';

const nativeCodes = [
  'NATIVE_STORAGE_UNAVAILABLE',
  'NATIVE_CACHE_UNAVAILABLE',
  'NATIVE_TLS_REJECTED',
  'NATIVE_RESPONSE_REJECTED',
  'NATIVE_REDIRECT_REJECTED',
  'NATIVE_REQUEST_REJECTED',
  'NATIVE_OAUTH_PENDING',
] as const;
type NativeCode = (typeof nativeCodes)[number] | 'NATIVE_SESSION_UNAVAILABLE';

class NativeSessionError extends ApiClientError {
  constructor(readonly diagnosticCode: NativeCode) {
    super(
      'Не удалось подключиться. Повторите попытку.',
      503,
      'NATIVE_SESSION_UNAVAILABLE',
      'native',
    );
  }
}

class NativeNetworkError extends TypeError {
  constructor() {
    super('Native network unavailable');
  }
}

/** Keep only reviewed constant codes. Native messages, causes and payloads may contain secrets. */
export function sanitizedNativeSessionError(error: unknown): Error {
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : null;
  if (code === 'NATIVE_NETWORK_UNAVAILABLE') return new NativeNetworkError();
  return new NativeSessionError(
    nativeCodes.find((known) => known === code) ?? 'NATIVE_SESSION_UNAVAILABLE',
  );
}

export function sessionFailureDetails(error: unknown): { message: string; code: string } {
  if (error instanceof NativeNetworkError) {
    return {
      message: 'Не удалось связаться с сервисом. Проверьте подключение и повторите попытку.',
      code: 'NATIVE_NETWORK_UNAVAILABLE',
    };
  }
  if (error instanceof NativeSessionError) {
    switch (error.diagnosticCode) {
      case 'NATIVE_STORAGE_UNAVAILABLE':
      case 'NATIVE_CACHE_UNAVAILABLE':
        return {
          message:
            'Не удалось прочитать защищённые данные приложения. Повторите попытку. Если ошибка останется, передайте код ошибки в поддержку.',
          code: error.diagnosticCode,
        };
      case 'NATIVE_TLS_REJECTED':
        return {
          message:
            'Не удалось установить защищённое соединение. Проверьте дату и время телефона и повторите попытку.',
          code: error.diagnosticCode,
        };
      default:
        return {
          message:
            'Не удалось проверить сохранённый вход. Повторите попытку. Если ошибка останется, передайте код ошибки в поддержку.',
          code: error.diagnosticCode,
        };
    }
  }
  return {
    message:
      'Не удалось проверить сохранённый вход. Повторите попытку. Если ошибка останется, передайте код ошибки в поддержку.',
    code:
      error instanceof ApiClientError &&
      Number.isInteger(error.status) &&
      error.status >= 400 &&
      error.status <= 599
        ? `HTTP_${error.status}`
        : 'SESSION_CHECK_FAILED',
  };
}
