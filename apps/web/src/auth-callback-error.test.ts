import { describe, expect, it, vi } from 'vitest';

import { clearAuthCallbackError, readAuthCallbackError } from './auth-callback-error.js';

describe('readAuthCallbackError', () => {
  it('reads a supported callback failure without touching the URL', () => {
    expect(
      readAuthCallbackError({
        hash: '#viva_auth_error=AUTH_IDENTITY_CONFLICT&viva_correlation_id=73408883-7e73-4ce1-b899-5bc73b42f7f9',
      }),
    ).toEqual({
      code: 'AUTH_IDENTITY_CONFLICT',
      correlationId: '73408883-7e73-4ce1-b899-5bc73b42f7f9',
    });
  });

  it('stays silent when the callback did not report a failure', () => {
    expect(readAuthCallbackError({ hash: '#viva_handoff=one-time-code' })).toBeNull();
    expect(readAuthCallbackError({ hash: '' })).toBeNull();
  });

  it('drops codes the client cannot explain', () => {
    expect(
      readAuthCallbackError({ hash: '#viva_auth_error=AUTH_PROVIDER_UNAVAILABLE' }),
    ).toBeNull();
  });

  it('never surfaces a correlation ID that is not a plain identifier', () => {
    expect(
      readAuthCallbackError({
        hash: `#viva_auth_error=AUTH_IDENTITY_CONFLICT&viva_correlation_id=${'<b>'.repeat(60)}`,
      }),
    ).toEqual({ code: 'AUTH_IDENTITY_CONFLICT' });
  });
});

describe('clearAuthCallbackError', () => {
  it('removes the marker while preserving unrelated query and fragment values', () => {
    const replaceState = vi.fn();

    clearAuthCallbackError(
      {
        pathname: '/',
        search: '?from=viva',
        hash: '#viva_handoff=one-time-code&viva_auth_error=AUTH_IDENTITY_CONFLICT&viva_correlation_id=abc-1',
      },
      { state: { test: true }, replaceState },
    );

    expect(replaceState).toHaveBeenCalledWith(
      { test: true },
      '',
      '/?from=viva#viva_handoff=one-time-code',
    );
  });

  it('does not rewrite history when there is no marker', () => {
    const replaceState = vi.fn();

    clearAuthCallbackError(
      { pathname: '/profile', search: '', hash: '#viva_handoff=one-time-code' },
      { state: null, replaceState },
    );

    expect(replaceState).not.toHaveBeenCalled();
  });
});
