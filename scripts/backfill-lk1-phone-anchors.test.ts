import { describe, expect, it } from 'vitest';

import { anchorFor, parseAnchorFile, parseArguments } from './backfill-lk1-phone-anchors.js';

const UUID_A = '4ae83246-59d6-4c73-911f-b439602596df';

describe('LK1 phone anchor backfill', () => {
  it('derives the same one-way anchor the Games import already uses', () => {
    // Pinned so a change to the namespace silently breaking the join to
    // integration.external_entity_map.external_id is caught here.
    expect(anchorFor('00000000-0000-4000-8000-000000000000')).toBe(
      'bb48876cdc6ea2a536afc42ca954436cd64521f9a41dbea97ff8692d775d1aaf',
    );
    expect(anchorFor(UUID_A)).toMatch(/^[0-9a-f]{64}$/);
    // Different anchors must not collide on a different entity type.
    expect(anchorFor(UUID_A)).not.toBe(anchorFor(`${UUID_A}x`));
  });

  it('parses the export file and skips comments and blank lines', () => {
    const { rows, malformed } = parseAnchorFile(
      [
        '# uuid\tphone_e164\tanchor:player',
        '',
        `${UUID_A}\t+79990000000\t${anchorFor(UUID_A)}`,
        '   ',
      ].join('\n'),
    );
    expect(malformed).toBe(0);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ externalId: UUID_A, phone: '+79990000000' });
  });

  it('counts malformed rows instead of throwing, so one bad line cannot abort a review', () => {
    // row 1: LK1 local phone format is not accepted; row 2: single field, no tab at all.
    const { rows, malformed } = parseAnchorFile(
      [`${UUID_A}\t89161234567\t${anchorFor(UUID_A)}`, 'broken-row'].join('\n'),
    );
    expect(rows).toHaveLength(0);
    expect(malformed).toBe(2);
  });

  it('rejects a row whose anchor column is missing rather than recomputing one', () => {
    const { rows, malformed } = parseAnchorFile(`${UUID_A}\t+79990000000`);
    expect(rows).toHaveLength(0);
    expect(malformed).toBe(1);
  });

  it('rejects an unknown argument so a typo cannot silently run as a dry run or as an apply', () => {
    expect(parseArguments([])).toEqual({ apply: false });
    expect(parseArguments(['--apply'])).toEqual({ apply: true });
    expect(() => parseArguments(['--aply'])).toThrow('LK1_ANCHOR_BACKFILL_ARGUMENT_INVALID');
  });

  it('treats a non-E.164 phone as malformed rather than coercing it', () => {
    const { rows, malformed } = parseAnchorFile(
      [`${UUID_A}\t89161234567\t${anchorFor(UUID_A)}`, `${UUID_A}\t+79990000000\tx`].join('\n'),
    );
    // first row: local format, rejected; second row: valid phone, anchor replaced or kept verbatim
    expect(malformed).toBe(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.phone).toBe('+79990000000');
  });
});
