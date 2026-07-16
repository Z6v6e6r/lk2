import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export type VivaDelegationCryptoErrorCode =
  'KEY_UNAVAILABLE' | 'KEY_VERSION_MISMATCH' | 'CIPHERTEXT_INVALID';

export class VivaDelegationCryptoError extends Error {
  public constructor(public readonly code: VivaDelegationCryptoErrorCode) {
    super(code);
    this.name = 'VivaDelegationCryptoError';
  }
}

function delegationKey(value: string | undefined): Buffer {
  if (!value) throw new VivaDelegationCryptoError('KEY_UNAVAILABLE');
  const key = Buffer.from(value, 'base64url');
  if (key.length !== 32) throw new VivaDelegationCryptoError('KEY_UNAVAILABLE');
  return key;
}

export function encryptVivaDelegationToken(value: string, keyText: string | undefined): string {
  const key = delegationKey(keyText);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64url');
}

export function decryptVivaDelegationToken(input: {
  readonly value: string;
  readonly keyText: string | undefined;
  readonly keyVersion: string;
  readonly expectedKeyVersion: string;
}): string {
  if (input.keyVersion !== input.expectedKeyVersion) {
    throw new VivaDelegationCryptoError('KEY_VERSION_MISMATCH');
  }
  const key = delegationKey(input.keyText);
  const packed = Buffer.from(input.value, 'base64url');
  if (packed.length <= 28) throw new VivaDelegationCryptoError('CIPHERTEXT_INVALID');
  const decipher = createDecipheriv('aes-256-gcm', key, packed.subarray(0, 12));
  decipher.setAuthTag(packed.subarray(12, 28));
  try {
    return Buffer.concat([decipher.update(packed.subarray(28)), decipher.final()]).toString('utf8');
  } catch {
    throw new VivaDelegationCryptoError('CIPHERTEXT_INVALID');
  }
}

export const VIVA_REFRESH_LOCK_PREFIX = 'phub:auth:viva-refresh-lock:';

export function vivaRefreshLockRedisKey(key: string): string {
  return `${VIVA_REFRESH_LOCK_PREFIX}${key}`;
}
