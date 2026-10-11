import { describe, expect, it } from 'vitest';
import { createRuntimeNotificationEndpointCipher } from './runtime-endpoint-cipher.js';

const base = {
  WEB_PUSH_ENABLED: false,
  FCM_ENABLED: false,
  NOTIFICATION_ENDPOINT_ENCRYPTION_KEYS: JSON.stringify({
    v1: Buffer.alloc(32, 1).toString('base64'),
  }),
  NOTIFICATION_ENDPOINT_ACTIVE_KEY_ID: 'v1',
};

describe('API endpoint encryption runtime', () => {
  it('keeps disabled transports from reading or requiring the keyring', () => {
    expect(
      createRuntimeNotificationEndpointCipher({
        ...base,
        NOTIFICATION_ENDPOINT_ENCRYPTION_KEYS: 'invalid',
      }),
    ).toBeUndefined();
  });
  it.each(['FCM_ENABLED', 'WEB_PUSH_ENABLED'] as const)(
    'encrypts when only %s is enabled',
    (enabled) => {
      const cipher = createRuntimeNotificationEndpointCipher({ ...base, [enabled]: true });
      const sealed = cipher!.encrypt('synthetic-registration-address');
      expect(cipher!.decrypt(sealed.ciphertext, sealed.keyId)).toBe(
        'synthetic-registration-address',
      );
      expect(sealed.ciphertext.toString()).not.toContain('synthetic-registration-address');
    },
  );
  it('fails closed on an unreadable active keyring', () => {
    expect(() =>
      createRuntimeNotificationEndpointCipher({
        ...base,
        FCM_ENABLED: true,
        NOTIFICATION_ENDPOINT_ENCRYPTION_KEYS: 'invalid',
      }),
    ).toThrow();
  });
});
