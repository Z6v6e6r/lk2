import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import descriptor from '../deploy/timeweb/r1-tail108-119.v1.json';
import reviewed from '../deploy/timeweb/r1-tail108-119-catalogs.v1.json';
import { R1_TAIL_CATALOG_SQL, R1_TAIL_TABLES } from './r1-tail-migration-catalog.js';
import {
  parseR1TailTarget,
  r1Encode,
  r1Hash,
  r1LedgerCount,
  r1PackagedInventory,
  validateR1TailCatalogs,
} from './r1-tail-migration-profile.js';

describe('fixed R1 tail inventory and admission', () => {
  it('pins119 actual SQL bytes and all12 exact full prefixes', async () => {
    const directory = resolve('packages/database/migrations');
    const actual = await Promise.all(
      (await readdir(directory))
        .filter((name) => name.endsWith('.sql'))
        .sort()
        .map(async (filename) => ({
          filename,
          checksum: createHash('sha256')
            .update(await readFile(resolve(directory, filename)))
            .digest('hex'),
        })),
    );
    expect(actual).toEqual(descriptor.inventory);
    expect(r1PackagedInventory(actual)).toEqual(actual);
    expect(r1LedgerCount(actual.map(({ filename, checksum }) => ({ checksum, filename })))).toBe(
      119,
    );
    for (let count = 108; count <= 119; count++)
      expect(r1LedgerCount(actual.slice(0, count))).toBe(count);
    for (const bad of [
      actual.slice(0, 107),
      actual.slice(1),
      [...actual].reverse(),
      actual.map((row, i) => (i === 110 ? { ...row, checksum: 'a'.repeat(64) } : row)),
      [...actual, { filename: '0116_unreviewed.sql', checksum: 'a'.repeat(64) }],
    ])
      expect(() => r1LedgerCount(bad)).toThrow('R1_TAIL_LEDGER');
  });
  it('rejects SQL/target/budget selection and unreviewed golden catalogs', () => {
    const target = {
      databaseName: 'phub_beta',
      systemIdentifier: '7679125609183186977',
      fromCount: 108,
      catalogVariant: 'DORMANT',
      catalogsSha256: 'a'.repeat(64),
    };
    expect(parseR1TailTarget(target)).toEqual(target);
    for (const bad of [
      { ...target, fromCount: 107 },
      { ...target, fromCount: 119 },
      { ...target, systemIdentifier: 'wrong' },
      { ...target, sql: 'select 1' },
      { ...target, statementMs: 0 },
      { ...target, catalogVariant: 'AUTO' },
    ])
      expect(() => parseR1TailTarget(bad)).toThrow();
    expect(
      validateR1TailCatalogs(reviewed, r1Encode(reviewed), r1Hash(r1Encode(reviewed))),
    ).toEqual(reviewed);
    expect(reviewed.builderSha256).toBe(r1Hash(R1_TAIL_CATALOG_SQL));
    for (const status of ['UNREHEARSED', 'REHEARSED_UNREVIEWED']) {
      const unreviewed = { ...reviewed, status };
      expect(() =>
        validateR1TailCatalogs(unreviewed, r1Encode(unreviewed), r1Hash(r1Encode(unreviewed))),
      ).toThrow('R1_TAIL_CATALOGS_NOT_ADMITTED');
    }
  });
  it('serializes exact changed relations, parent ACLs and attached trigger definitions', () => {
    expect(R1_TAIL_TABLES).toContain('notifications.intents');
    expect(R1_TAIL_TABLES).toContain('notifications.deliveries');
    expect(R1_TAIL_TABLES).toContain('commerce.monthly_purchase_attempts');
    expect(R1_TAIL_CATALOG_SQL).toContain('true as fresh');
    expect(R1_TAIL_CATALOG_SQL).toContain('tr.tgfoid=p.oid');
    expect(R1_TAIL_CATALOG_SQL).toContain('securityDefiner');
    expect(R1_TAIL_CATALOG_SQL).toContain('nullsNotDistinct');
  });
});
