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
    expect(readTimewebCorsOrigins({ hostname: 'lk2.padlhub.su', cupOrigins: ['padlhub.su'] })).toEqual(
      { ok: true, value: 'https://lk2.padlhub.su,https://padlhub.su' },
    );
    expect(
      readTimewebCorsOrigins({
        hostname: 'lk2.padlhub.su',
        cupOrigins: ['padlhub.su', 'cup.example.org'],
      }),
    ).toEqual({ ok: true, value: 'https://lk2.padlhub.su,https://padlhub.su,https://cup.example.org' });
  });

  it('refuses a declaration that is not a bare host name', () => {
    for (const origin of ['https://padlhub.su', '*.padlhub.su', 'padlhub.su/', 'PADLHUB.SU', 'localhost']) {
      expect(readTimewebCorsOrigins({ hostname: 'lk2.padlhub.su', cupOrigins: [origin] })).toEqual({
        ok: false,
        reason: 'cup_origins_host',
      });
    }
  });

  it('refuses a repeated origin and a malformed declaration', () => {
    expect(
      readTimewebCorsOrigins({ hostname: 'lk2.padlhub.su', cupOrigins: ['padlhub.su', 'padlhub.su'] }),
    ).toEqual({ ok: false, reason: 'cup_origins_duplicate' });
    expect(
      readTimewebCorsOrigins({ hostname: 'padlhub.su', cupOrigins: ['padlhub.su'] }),
    ).toEqual({ ok: false, reason: 'cup_origins_duplicate' });
    expect(readTimewebCorsOrigins({ hostname: 'lk2.padlhub.su', cupOrigins: 'padlhub.su' })).toEqual({
      ok: false,
      reason: 'cup_origins_shape',
    });
    expect(readTimewebCorsOrigins({})).toEqual({ ok: false, reason: 'cup_origins_hostname' });
  });
});
