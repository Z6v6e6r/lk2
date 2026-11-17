export type AuthCallbackErrorCode = 'AUTH_IDENTITY_CONFLICT';

export interface AuthCallbackError {
  readonly code: AuthCallbackErrorCode;
  readonly correlationId?: string;
}

const AUTH_ERROR_FRAGMENT_KEY = 'viva_auth_error';
const CORRELATION_ID_FRAGMENT_KEY = 'viva_correlation_id';
const SUPPORTED_AUTH_ERRORS: readonly string[] = ['AUTH_IDENTITY_CONFLICT'];
const CORRELATION_ID_PATTERN = /^[A-Za-z0-9-]{1,128}$/;

/**
 * Reads the one-shot marker the API appends when the Viva OAuth callback cannot finish the login,
 * then removes it from the URL so a reload starts a clean login. Only stable codes are surfaced, and
 * the correlation ID is treated as untrusted text: it is displayed for support, never parsed.
 */
export function consumeAuthCallbackError(
  location: Pick<Location, 'pathname' | 'search' | 'hash'>,
  history: Pick<History, 'replaceState' | 'state'>,
): AuthCallbackError | null {
  const fragment = new URLSearchParams(location.hash.replace(/^#/, ''));
  if (!fragment.has(AUTH_ERROR_FRAGMENT_KEY)) return null;
  const code = fragment.get(AUTH_ERROR_FRAGMENT_KEY) ?? '';
  const correlationId = fragment.get(CORRELATION_ID_FRAGMENT_KEY) ?? '';
  fragment.delete(AUTH_ERROR_FRAGMENT_KEY);
  fragment.delete(CORRELATION_ID_FRAGMENT_KEY);
  const hash = fragment.toString();
  history.replaceState(
    history.state,
    '',
    `${location.pathname}${location.search}${hash ? `#${hash}` : ''}`,
  );
  if (!SUPPORTED_AUTH_ERRORS.includes(code)) return null;
  return {
    code: code as AuthCallbackErrorCode,
    ...(CORRELATION_ID_PATTERN.test(correlationId) ? { correlationId } : {}),
  };
}
