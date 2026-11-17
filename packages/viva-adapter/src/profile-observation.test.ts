import { describe, expect, it } from 'vitest';

import { LEVEL_FIELD_IDS } from './home-source.js';
import {
  normalizeVivaProfileObservation,
  VivaProfileObservationInvalidError,
} from './profile-observation.js';

const providerProfileId = '1f6d8c19-0d6b-4a57-9f0e-2a1b3c4d5e6f';
const levelFieldId = LEVEL_FIELD_IDS[0];

function payload(overrides: Record<string, unknown> = {}) {
  return {
    id: providerProfileId,
    firstName: 'Алексей',
    middleName: null,
    lastName: 'Сергеев',
    phone: '+79990001122',
    photo: 'https://cdn.viva.test/profile/avatar.webp',
    deposit: 54_000,
    customFields: [{ id: levelFieldId, value: ['3.8'] }],
    ...overrides,
  };
}

describe('Viva profile observation normalizer', () => {
  it('keeps only the asserted level, the balance and the currency', () => {
    const observation = normalizeVivaProfileObservation(payload());

    expect(observation).toEqual({
      level: { label: 'C+', value: 3.8, assessmentRequired: false },
      balanceMinor: 54_000,
      currency: 'RUB',
    });
    // Provider identifiers, personal data and media URLs never survive normalization.
    const serialized = JSON.stringify(observation);
    for (const leaked of [
      providerProfileId,
      levelFieldId,
      'Алексей',
      'Сергеев',
      '+79990001122',
      '79990001122',
      'cdn.viva.test',
      'avatar.webp',
    ]) {
      expect(serialized).not.toContain(leaked);
    }
  });

  it('reads the level from any of the known provider field ids', () => {
    for (const fieldId of LEVEL_FIELD_IDS) {
      expect(
        normalizeVivaProfileObservation(
          payload({ customFields: [{ id: fieldId, value: ['4,8'] }] }),
        ).level,
      ).toEqual({ label: 'B+', value: 4.8, assessmentRequired: false });
    }
  });

  it('omits a level that the provider did not assert', () => {
    for (const customFields of [
      [],
      [{ id: levelFieldId, value: [] }],
      [{ id: levelFieldId, value: [''] }],
      [{ id: levelFieldId, value: ['не число'] }],
      [{ id: levelFieldId, value: ['11'] }],
      [{ id: levelFieldId, value: ['-1'] }],
      [{ id: '4e1c1f6a-90b3-4d2a-9a51-3a1d5e7f9b2c', value: ['3.8'] }],
    ]) {
      const observation = normalizeVivaProfileObservation(payload({ customFields }));
      expect(observation).not.toHaveProperty('level');
      expect(observation.balanceMinor).toBe(54_000);
    }
  });

  it('omits the balance instead of inventing zero when the provider value is unreadable', () => {
    for (const deposit of [undefined, null, '54000', 4.5, Number.POSITIVE_INFINITY]) {
      const observation = normalizeVivaProfileObservation(payload({ deposit }));
      expect(observation).not.toHaveProperty('balanceMinor');
      expect(observation.currency).toBe('RUB');
    }
    expect(normalizeVivaProfileObservation(payload({ deposit: -12_500 })).balanceMinor).toBe(
      -12_500,
    );
    expect(normalizeVivaProfileObservation(payload({ deposit: 0 })).balanceMinor).toBe(0);
  });

  it.each([
    ['not an object', 'provider payload'],
    ['empty object', {}],
    ['provider id is not a uuid', payload({ id: 'viva-user-1' })],
    ['custom fields missing', payload({ customFields: undefined })],
    ['custom fields not an array', payload({ customFields: 'none' })],
    ['custom field id is not a uuid', payload({ customFields: [{ id: 'x', value: [] }] })],
    [
      'custom field values are not strings',
      payload({ customFields: [{ id: levelFieldId, value: [3.8] }] }),
    ],
  ])('rejects an invalid payload (%s) with a typed error', (_label, invalid) => {
    expect(() => normalizeVivaProfileObservation(invalid)).toThrow(
      VivaProfileObservationInvalidError,
    );
  });
});
