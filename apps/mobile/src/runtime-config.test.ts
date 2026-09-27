import { describe, expect, it } from 'vitest';
import { resolveMobileRuntimeConfig } from './runtime-config.js';

const native = { native: true, origin: 'https://localhost', tenantKey: 'local-padel' };
describe('Android API configuration', () => {
  it('requires an explicit target and tenant before constructing a client', () => {
    expect(() => resolveMobileRuntimeConfig(native)).toThrow('MOBILE_API_NOT_CONFIGURED');
    expect(() =>
      resolveMobileRuntimeConfig({
        native: true,
        origin: 'https://localhost',
        apiBaseUrl: 'https://lk.nano.padlhub.su',
      }),
    ).toThrow('MOBILE_API_NOT_CONFIGURED');
  });
  it('accepts the exact existing HTTPS staging origin', () => {
    expect(
      resolveMobileRuntimeConfig({ ...native, apiBaseUrl: 'https://lk.nano.padlhub.su/' })
        .apiBaseUrl,
    ).toBe('https://lk.nano.padlhub.su');
  });
  it.each([
    'http://lk.nano.padlhub.su',
    'https://lk.nano.padlhub.su.attacker.test',
    'https://attacker.test',
    'https://user:secret@lk.nano.padlhub.su',
    'https://lk.nano.padlhub.su:8443',
    'https://lk.nano.padlhub.su/api',
    'https://lk.nano.padlhub.su?token=secret',
    'https://lk.nano.padlhub.su#token',
    'https://localhost',
    'http://127.0.0.1:3000',
  ])('rejects an untrusted or non-origin value: %s', (apiBaseUrl) => {
    expect(() => resolveMobileRuntimeConfig({ ...native, apiBaseUrl })).toThrow(
      'MOBILE_API_ORIGIN_INVALID',
    );
  });
  it('rejects a tenant path and supports ordinary local browser preview', () => {
    expect(() =>
      resolveMobileRuntimeConfig({
        ...native,
        apiBaseUrl: 'https://lk.nano.padlhub.su',
        tenantKey: '../other',
      }),
    ).toThrow('MOBILE_TENANT_INVALID');
    expect(
      resolveMobileRuntimeConfig({ native: false, origin: 'http://localhost:5175' }),
    ).toMatchObject({ apiBaseUrl: 'http://localhost:5175', tenantKey: 'local-padel' });
  });
});
