import { describe, expect, it, vi } from 'vitest';

import { consumeAuthCallbackError } from './auth-callback-error.js';

function locationWith(hash: string, search = '') {
  return { pathname: '/', search, hash };
}

describe('consumeAuthCallbackError', () => {
  it('reads a supported callback failure and removes the one-shot marker from the URL', () => {
    const replaceState = vi.fn();
    const error = consumeAuthCallbackError(
      locationWith(
        '#viva_auth_error=AUTH_IDENTITY_CONFLICT&viva_correlation_id=73408883-7e73-4ce1-b899-5bc73b42f7f9',
      ),
      { state: { test: true }, replaceState },
    );

    expect(error).toEqual({
      code: 'AUTH_IDENTITY_CONFLICT',
      correlationId: '73408883-7e73-4ce1-b899-5bc73b42f7f9',
    });
    expect(replaceState).toHaveBeenCalledWith({ test: true }, '', '/');
  });

  it('keeps unrelated fragment values while removing the marker', () => {
    const replaceState = vi.fn();

    consumeAuthCallbackError(
      locationWith(
        '#viva_handoff=one-time-code&viva_auth_error=AUTH_IDENTITY_CONFLICT',
        '?from=viva',
      ),
      { state: null, replaceState },
    );

    expect(replaceState).toHaveBeenCalledWith(null, '', '/?from=viva#viva_handoff=one-time-code');
  });

  it('stays silent when the callback did not report a failure', () => {
    const replaceState = vi.fn();

    expect(
      consumeAuthCallbackError(locationWith('#viva_handoff=one-time-code'), {
        state: null,
        replaceState,
      }),
    ).toBeNull();
    expect(replaceState).not.toHaveBeenCalled();
  });

  it('drops codes the client cannot explain and still clears the marker', () => {
    const replaceState = vi.fn();

    expect(
      consumeAuthCallbackError(locationWith('#viva_auth_error=AUTH_PROVIDER_UNAVAILABLE'), {
        state: null,
        replaceState,
      }),
    ).toBeNull();
    expect(replaceState).toHaveBeenCalledWith(null, '', '/');
  });

  it('never surfaces a correlation ID that is not a plain identifier', () => {
    const replaceState = vi.fn();

    const error = consumeAuthCallbackError(
      locationWith(
        `#viva_auth_error=AUTH_IDENTITY_CONFLICT&viva_correlation_id=${'<b>'.repeat(60)}`,
      ),
      { state: null, replaceState },
    );

    expect(error).toEqual({ code: 'AUTH_IDENTITY_CONFLICT' });
  });
});
