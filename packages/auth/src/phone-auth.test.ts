import { describe, expect, it } from 'vitest';

import { maskPhone, MemoryAccessTokenStore, normalizePhoneE164 } from './index.js';

describe('provider-agnostic auth primitives', () => {
  it.each([
    ['9991234567', '+79991234567'],
    ['89991234567', '+79991234567'],
    ['+7 (999) 123-45-67', '+79991234567'],
  ])('normalizes Russian phone %s', (input, expected) => {
    expect(normalizePhoneE164(input)).toBe(expected);
  });

  it('rejects unsupported numbers and masks accepted ones', () => {
    expect(normalizePhoneE164('123')).toBeUndefined();
    expect(maskPhone('+79991234567')).toBe('+7 *** ***-**-67');
  });

  it('keeps only the PadlHub access token in web memory', () => {
    const store = new MemoryAccessTokenStore();
    store.write('phub-access');
    expect(store.read()).toBe('phub-access');
    store.clear();
    expect(store.read()).toBeUndefined();
  });
});
