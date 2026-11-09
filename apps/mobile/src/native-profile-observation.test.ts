import { describe, expect, it, vi } from 'vitest';
import {
  createNativeProfileObservationRefresh,
  type AndroidSessionPlugin,
} from './native-api-fetch.js';
import { sessionFailureDetails } from './session-failure.js';

function plugin(overrides: Partial<AndroidSessionPlugin> = {}): AndroidSessionPlugin {
  return { configuration: vi.fn(), request: vi.fn(), ...overrides };
}

describe('Android profile observation bridge capability', () => {
  it('accepts only the closed acknowledgement', async () => {
    const refreshProfile = vi.fn().mockResolvedValue({ state: 'refreshed' });
    await expect(
      createNativeProfileObservationRefresh(plugin({ refreshProfile }))(),
    ).resolves.toBeUndefined();
    expect(refreshProfile).toHaveBeenCalledWith();
  });

  it('rejects additional data on the bridge acknowledgement', async () => {
    const refreshProfile = vi
      .fn()
      .mockResolvedValue({ state: 'refreshed', token: 'synthetic-private-token' });
    const failure: unknown = await createNativeProfileObservationRefresh(
      plugin({ refreshProfile }),
    )().catch((error: unknown) => error);
    expect(sessionFailureDetails(failure).code).toBe('NATIVE_REQUEST_REJECTED');
    expect(JSON.stringify(failure)).not.toContain('synthetic-private-token');
  });

  it('rejects a bridge that is absent on this installation', async () => {
    const failure: unknown = await createNativeProfileObservationRefresh(plugin())().catch(
      (error: unknown) => error,
    );
    expect(sessionFailureDetails(failure).code).toBe('NATIVE_REQUEST_REJECTED');
  });

  it('keeps native failures bounded and free of native messages', async () => {
    const refreshProfile = vi
      .fn()
      .mockRejectedValue({ code: 'NATIVE_PROFILE_READ_DISABLED', message: 'synthetic-private' });
    const failure: unknown = await createNativeProfileObservationRefresh(
      plugin({ refreshProfile }),
    )().catch((error: unknown) => error);
    expect(sessionFailureDetails(failure).code).toBe('NATIVE_SESSION_UNAVAILABLE');
    expect(JSON.stringify(failure)).not.toContain('synthetic-private');
  });
});
