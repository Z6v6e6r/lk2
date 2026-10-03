import { describe, expect, it } from 'vitest';

import {
  hashLocalPassword,
  normalizeLoginEmail,
  reservePasswordLoginSlot,
  validLocalPassword,
  verifyLocalPassword,
} from './local-password.js';

describe('LOCAL password and email policy', () => {
  it('canonicalizes only ASCII login bindings, without provider-specific alias merging', () => {
    expect(normalizeLoginEmail('  Player+Tag@EXAMPLE.TEST  ')).toBe('player+tag@example.test');
    expect(normalizeLoginEmail('player.name@example.test')).toBe('player.name@example.test');
    for (const email of [
      'K@example.test',
      'игрок@example.test',
      'a@@example.test',
      '.a@example.test',
      'a..b@example.test',
      'a@example..test',
      'a@-example.test',
      'a@localhost',
    ])
      expect(normalizeLoginEmail(email)).toBeUndefined();
  });
  it('accepts long Unicode/space passwords and rejects short or oversized values', () => {
    expect(validLocalPassword('пароль с пробелами 42')).toBe(true);
    expect(validLocalPassword('x'.repeat(128))).toBe(true);
    expect(validLocalPassword('x'.repeat(14))).toBe(false);
    expect(validLocalPassword('x'.repeat(129))).toBe(false);
    expect(validLocalPassword('x'.repeat(15) + '\ud800')).toBe(false);
  });
  it('uses random salts and preserves exact bytes on verification', async () => {
    const password = '  Synthetic пароль 42!  ';
    const first = await hashLocalPassword(password);
    const second = await hashLocalPassword(password);
    expect(first).not.toBe(second);
    expect(first).toMatch(/^phub-scrypt-v1\$131072\$8\$1\$/);
    expect(first).not.toContain(password);
    expect(await verifyLocalPassword(password, first)).toBe(true);
    expect(await verifyLocalPassword(password.trim(), first)).toBe(false);
    expect(await verifyLocalPassword('a different synthetic password', first)).toBe(false);
  }, 10000);
  it('fails closed for unknown and malicious cost envelopes', async () => {
    expect(await verifyLocalPassword('Synthetic password 42!')).toBe(false);
    expect(
      await verifyLocalPassword('Synthetic password 42!', 'phub-scrypt-v1$999999999$8$1$salt$key'),
    ).toBe(false);
    await expect(hashLocalPassword('short')).rejects.toThrow('AUTH_PASSWORD_POLICY_INVALID');
  });
  it('rejects a third login before work and releases admission exactly once', () => {
    const first = reservePasswordLoginSlot();
    const second = reservePasswordLoginSlot();
    try {
      expect(() => reservePasswordLoginSlot()).toThrow('AUTH_PASSWORD_CAPACITY_EXCEEDED');
    } finally {
      first();
      first();
      second();
    }
    reservePasswordLoginSlot()();
  });
});
