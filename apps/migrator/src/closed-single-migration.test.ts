import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import descriptor from '../../../deploy/timeweb/closed-application-migrations-0103-0104.v1.json';
import { ledger as frozenLedger } from '../../../scripts/timeweb-api-worker.fixture.js';
import {
  assertClosedLedger,
  assertClosedPackagedCatalog,
  closedProfile,
  closedProfileArgument,
  parseClosedSingleTarget,
} from './closed-single-migration.js';

const directory = resolve('packages/database/migrations');
const currentFiles = (await readdir(directory)).filter((x) => x.endsWith('.sql')).sort();
// The closed release remains its exact original package even when current main expands.
const files = [
  ...frozenLedger.map((row) => row.filename),
  '0099_local_password_reset_proofs.sql',
  '0100_notification_scenarios.sql',
  '0101_notification_lifecycle_channels.sql',
  '0102_location_recommendation_photos.sql',
  descriptor.profiles.game_start_0103.filename,
  descriptor.profiles.subject_link_0104.filename,
];
const packaged = await Promise.all(
  files.map(async (filename) => ({
    filename,
    checksum: createHash('sha256')
      .update(await readFile(resolve(directory, filename)))
      .digest('hex'),
  })),
);
describe('fixed single application migration source and ledger contract', () => {
  it('admits only the two exact entry arguments and fixed source filenames', () => {
    expect(closedProfileArgument('--game-start-migration-0103')).toBe('game_start_0103');
    expect(closedProfileArgument('--subject-link-migration-0104')).toBe('subject_link_0104');
    for (const value of [
      '--migration',
      '0103_game_start_notification_scenarios.sql',
      '--game-start-migration-0103=force',
      '__proto__',
      '',
    ])
      expect(closedProfileArgument(value)).toBeUndefined();
    expect(closedProfile('game_start_0103').filename).toBe(
      '0103_game_start_notification_scenarios.sql',
    );
    expect(closedProfile('subject_link_0104').filename).toBe(
      '0104_identity_external_subject_link_commands.sql',
    );
  });
  it('requires an explicit reviewed catalog variant and rejects ambiguous target shapes', () => {
    const identity = { databaseName: 'phub_beta', systemIdentifier: '7679' };
    for (const catalogVariant of ['DORMANT', 'SCENARIO_EDITOR_V1'])
      expect(parseClosedSingleTarget({ ...identity, catalogVariant })).toEqual({
        ...identity,
        catalogVariant,
      });
    for (const value of [
      identity,
      { ...identity, catalogVariant: 'AUTO' },
      { ...identity, catalogVariant: 'DORMANT', force: true },
      null,
      [],
    ])
      expect(() => parseClosedSingleTarget(value)).toThrow();
  });
  it('pins the full packaged source and each preceding ledger prefix', () => {
    expect(packaged.slice(0, frozenLedger.length)).toEqual(frozenLedger);
    expect(() => assertClosedPackagedCatalog(packaged)).not.toThrow();
    for (const mutation of [
      packaged.slice(0, -1),
      [...packaged, { filename: '0105_unreviewed.sql', checksum: 'a'.repeat(64) }],
      [...packaged].reverse(),
      packaged.map((row, i) => (i === 106 ? { ...row, checksum: 'a'.repeat(64) } : row)),
    ])
      expect(() => assertClosedPackagedCatalog(mutation)).toThrow();
  });
  it('rejects the extended current directory without widening the closed release', async () => {
    const current = await Promise.all(
      currentFiles.map(async (filename) => ({
        filename,
        checksum: createHash('sha256')
          .update(await readFile(resolve(directory, filename)))
          .digest('hex'),
      })),
    );
    expect(current.length).toBeGreaterThan(descriptor.packagedCount);
    expect(() => assertClosedPackagedCatalog(current)).toThrow(
      'CLOSED_APPLICATION_MIGRATION_SOURCE_CATALOG',
    );
  });
  it('requires each exact full checkpoint, with no skipped or reordered migration', () => {
    for (const count of [106, 107, 108]) {
      const prefix = packaged.slice(0, count);
      expect(() => assertClosedLedger(prefix, count)).not.toThrow();
      for (const mutation of [
        prefix.slice(1),
        [...prefix].reverse(),
        prefix.map((row, i) => (i === count - 1 ? { ...row, checksum: 'b'.repeat(64) } : row)),
      ])
        expect(() => assertClosedLedger(mutation, count)).toThrow();
    }
    expect(() => assertClosedLedger(packaged, 109)).toThrow();
    expect(() => assertClosedLedger(packaged.slice(0, 106), 107)).toThrow();
  });
});
