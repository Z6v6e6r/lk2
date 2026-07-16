import { describe, expect, it } from 'vitest';

import {
  VivaDelegationCryptoError,
  decryptVivaDelegationToken,
  encryptVivaDelegationToken,
  vivaRefreshLockRedisKey,
} from './viva-delegation.js';

const key = Buffer.alloc(32, 7).toString('base64url');

describe('Viva delegation primitives', () => {
  it('round-trips a refresh token and keeps the shared lock namespace stable', () => {
    const encrypted = encryptVivaDelegationToken('refresh-secret', key);
    expect(encrypted).not.toContain('refresh-secret');
    expect(
      decryptVivaDelegationToken({
        value: encrypted,
        keyText: key,
        keyVersion: 'v1',
        expectedKeyVersion: 'v1',
      }),
    ).toBe('refresh-secret');
    expect(vivaRefreshLockRedisKey('tenant:user')).toBe('phub:auth:viva-refresh-lock:tenant:user');
  });

  it('rejects a token encrypted under a different key version', () => {
    const encrypted = encryptVivaDelegationToken('refresh-secret', key);
    expect(() =>
      decryptVivaDelegationToken({
        value: encrypted,
        keyText: key,
        keyVersion: 'v1',
        expectedKeyVersion: 'v2',
      }),
    ).toThrowError(expect.objectContaining({ code: 'KEY_VERSION_MISMATCH' }));
    expect(VivaDelegationCryptoError).toBeDefined();
  });
});
