import { describe, expect, it } from 'vitest';

import { parsePhones, parseUserIds } from './notification-recipients.js';

describe('CUP recipient input parsing', () => {
  it('splits, trims and deduplicates phone numbers without rewriting them', () => {
    expect(parsePhones('+7 999 000-00-01\n8 (999) 000-00-01, +79990000001;')).toEqual([
      '+7 999 000-00-01',
      '8 (999) 000-00-01',
      '+79990000001',
    ]);
  });

  it('keeps a malformed PadlHub id visible instead of dropping it', () => {
    const parsed = parseUserIds(
      'D938CAF6-4ECA-49D3-8F78-C7AB1B967A41, not-a-uuid\n96d1b47c-dc5c-493f-836c-827f01c31546',
    );

    expect(parsed.ids).toEqual([
      'd938caf6-4eca-49d3-8f78-c7ab1b967a41',
      '96d1b47c-dc5c-493f-836c-827f01c31546',
    ]);
    expect(parsed.invalid).toEqual(['not-a-uuid']);
  });

  it('returns an empty selector for blank input and counts a repeated id once', () => {
    expect(parseUserIds('   \n ')).toEqual({ ids: [], invalid: [] });
    expect(
      parseUserIds('d938caf6-4eca-49d3-8f78-c7ab1b967a41 d938caf6-4eca-49d3-8f78-c7ab1b967a41').ids,
    ).toEqual(['d938caf6-4eca-49d3-8f78-c7ab1b967a41']);
  });
});
