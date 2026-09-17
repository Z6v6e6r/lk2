import { describe, expect, it } from 'vitest';

import { readTimewebCorsOrigins } from './timeweb-cors-origins.js';

describe('Timeweb beta API origin allow-list', () => {
  it('keeps the contour self-origin when no CUP origin is declared', () => {
    expect(readTimewebCorsOrigins({ hostname: 'lk2.padlhub.su' })).toEqual({
      ok: true,
      value: 'https://lk2.padlhub.su',
    });
  });

  it('adds a declared CUP host after the contour host', () => {
    expect(
      readTimewebCorsOrigins({ hostname: 'lk2.padlhub.su', cupOrigins: ['padlhub.su'] }),
    ).toEqual({ ok: true, value: 'https://lk2.padlhub.su,https://padlhub.su' });
    expect(
      readTimewebCorsOrigins({
        hostname: 'lk2.padlhub.su',
        cupOrigins: ['padlhub.su', 'cup.example.org'],
      }),
    ).toEqual({
      ok: true,
      value: 'https://lk2.padlhub.su,https://padlhub.su,https://cup.example.org',
    });
  });

  it('refuses a declaration that is not a bare host name', () => {
    for (const origin of [
      'https://padlhub.su',
      '*.padlhub.su',
      'padlhub.su/',
      'padlhub.su:443',
      'padlhub.su.',
      'padlhub.su,x',
      'padlhub.su ',
      'padlhub.su\n',
      'padlhub.su\t',
      'sub.padlhub.su.evil',
      'PADLHUB.SU',
      'localhost',
    ]) {
      expect(readTimewebCorsOrigins({ hostname: 'lk2.padlhub.su', cupOrigins: [origin] })).toEqual({
        ok: false,
        reason: 'cup_origins_host',
      });
    }
  });

  it('refuses a repeated origin and a malformed declaration', () => {
    expect(
      readTimewebCorsOrigins({
        hostname: 'lk2.padlhub.su',
        cupOrigins: ['padlhub.su', 'padlhub.su'],
      }),
    ).toEqual({ ok: false, reason: 'cup_origins_duplicate' });
    expect(readTimewebCorsOrigins({ hostname: 'padlhub.su', cupOrigins: ['padlhub.su'] })).toEqual({
      ok: false,
      reason: 'cup_origins_duplicate',
    });
    expect(
      readTimewebCorsOrigins({ hostname: 'lk2.padlhub.su', cupOrigins: 'padlhub.su' }),
    ).toEqual({
      ok: false,
      reason: 'cup_origins_shape',
    });
    expect(readTimewebCorsOrigins({})).toEqual({ ok: false, reason: 'cup_origins_hostname' });
    expect(readTimewebCorsOrigins({ hostname: 'lk2.padlhub.su', cupOrigins: [] })).toEqual({
      ok: true,
      value: 'https://lk2.padlhub.su',
    });
  });

  it('refuses a contour host that is not a bare host name', () => {
    for (const hostname of [
      'lk2.padlhub.su,x',
      'https://lk2.padlhub.su',
      'LK2.PADLHUB.SU',
      'localhost',
    ]) {
      expect(readTimewebCorsOrigins({ hostname, cupOrigins: ['padlhub.su'] })).toEqual({
        ok: false,
        reason: 'cup_origins_hostname',
      });
    }
  });

  it('keeps the contour host first so single-value consumers stay on it', () => {
    const result = readTimewebCorsOrigins({
      hostname: 'lk2.padlhub.su',
      cupOrigins: ['cup.example.org', 'padlhub.su'],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected an accepted declaration');
    expect(result.value.split(',')[0]).toBe('https://lk2.padlhub.su');
    expect(result.value).toBe('https://lk2.padlhub.su,https://cup.example.org,https://padlhub.su');
  });
});
