export type AuthCallbackErrorCode = 'AUTH_IDENTITY_CONFLICT';

export interface AuthCallbackError {
  readonly code: AuthCallbackErrorCode;
  readonly correlationId?: string;
}

const AUTH_ERROR_FRAGMENT_KEY = 'viva_auth_error';
const CORRELATION_ID_FRAGMENT_KEY = 'viva_correlation_id';
const SUPPORTED_AUTH_ERRORS: readonly string[] = ['AUTH_IDENTITY_CONFLICT'];
const CORRELATION_ID_PATTERN = /^[A-Za-z0-9-]{1,128}$/;

function markerFragment(hash: string): URLSearchParams {
  return new URLSearchParams(hash.replace(/^#/, ''));
}

/**
 * Reads the marker the API appends when the Viva OAuth callback cannot finish the login. Reading is
 * pure: the caller decides when the marker leaves the URL, so a repeated render cannot lose it.
 * Only stable codes are surfaced, and the correlation ID stays untrusted text that is displayed for
 * support and never parsed.
 */
export function readAuthCallbackError(location: Pick<Location, 'hash'>): AuthCallbackError | null {
  const fragment = markerFragment(location.hash);
  const code = fragment.get(AUTH_ERROR_FRAGMENT_KEY);
  if (!code || !SUPPORTED_AUTH_ERRORS.includes(code)) return null;
  const correlationId = fragment.get(CORRELATION_ID_FRAGMENT_KEY) ?? '';
  return {
    code: code as AuthCallbackErrorCode,
    ...(CORRELATION_ID_PATTERN.test(correlationId) ? { correlationId } : {}),
  };
}

/** Removes the one-shot marker while preserving unrelated query and fragment values. */
export function clearAuthCallbackError(
  location: Pick<Location, 'pathname' | 'search' | 'hash'>,
  history: Pick<History, 'replaceState' | 'state'>,
): void {
  const fragment = markerFragment(location.hash);
  if (!fragment.has(AUTH_ERROR_FRAGMENT_KEY) && !fragment.has(CORRELATION_ID_FRAGMENT_KEY)) return;
  fragment.delete(AUTH_ERROR_FRAGMENT_KEY);
  fragment.delete(CORRELATION_ID_FRAGMENT_KEY);
  const hash = fragment.toString();
  history.replaceState(
    history.state,
    '',
    `${location.pathname}${location.search}${hash ? `#${hash}` : ''}`,
  );
}
