import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  catalogDigest,
  isNotificationMigrationStep,
  notificationBuilderSha256,
  notificationPackageSha256,
  parseNotificationTarget,
  validateNotificationDefaults,
  validateNotificationGolden,
} from './notification-migration.js';
import { NOTIFICATION_CATALOG_VERSION } from '../../../scripts/notification-migration-catalog.js';

const defaults = () =>
  ['DELETE', 'INSERT', 'SELECT', 'UPDATE'].map((privilege) => ({
    scope: 'identity',
    type: 'r',
    grantor: 'phub_migrator',
    grantee: 'phub_runtime',
    privilege,
    grantable: false,
  }));
const example = () => {
  const rows = [{ key: 'relation:synthetic', value: '{"kind":"r"}' }];
  return {
    schema: 'PHUB_NOTIFICATION_MIGRATION_CATALOGS_V1',
    postgresMajor: 16,
    packageDescriptorSha256: notificationPackageSha256,
    builderVersion: NOTIFICATION_CATALOG_VERSION,
    builderSha256: notificationBuilderSha256,
    checkpoints: Object.fromEntries(
      ['102', '103', '104', '105'].map((n) => [
        n,
        { rows: structuredClone(rows), sha256: catalogDigest(rows) },
      ]),
    ),
  };
};
describe('notification migration executable contract', () => {
  it('limits notification execution to its three frozen steps', () => {
    for (const filename of [
      '0099_local_password_reset_proofs.sql',
      '0100_notification_scenarios.sql',
      '0101_notification_lifecycle_channels.sql',
    ])
      expect(isNotificationMigrationStep(filename)).toBe(true);
    for (const filename of [
      '0098_support_tickets.sql',
      '0102_location_recommendation_photos.sql',
      '0103_unexpected.sql',
    ])
      expect(isNotificationMigrationStep(filename)).toBe(false);
  });
  it('binds the exact existing package descriptor bytes', async () => {
    const { createHash } = await import('node:crypto');
    expect(notificationPackageSha256).toBe(
      createHash('sha256')
        .update(await readFile('deploy/timeweb/notification-migrations-0099-0101.v1.json'))
        .digest('hex'),
    );
  });
  it('validates the complete golden contract before using any checkpoint', () => {
    expect(Object.keys(validateNotificationGolden(example()))).toEqual([
      '102',
      '103',
      '104',
      '105',
    ]);
    for (const key of [
      'schema',
      'postgresMajor',
      'packageDescriptorSha256',
      'builderVersion',
      'builderSha256',
    ] as const) {
      const value = { ...example(), [key]: key === 'postgresMajor' ? 17 : 'changed' };
      expect(() => validateNotificationGolden(value)).toThrow('GOLDEN_BINDING');
    }
    const missing = example();
    delete missing.checkpoints['104'];
    expect(() => validateNotificationGolden(missing)).toThrow();
    const extra = example();
    extra.checkpoints['106'] = extra.checkpoints['105']!;
    expect(() => validateNotificationGolden(extra)).toThrow();
    const duplicate = example();
    duplicate.checkpoints['103']!.rows.push(duplicate.checkpoints['103']!.rows[0]!);
    expect(() => validateNotificationGolden(duplicate)).toThrow('GOLDEN_ROWS');
    const drift = example();
    drift.checkpoints['105']!.rows[0]!.value = '{}';
    expect(() => validateNotificationGolden(drift)).toThrow('GOLDEN_DIGEST');
    const shape = example();
    shape.checkpoints['104']!.rows[0]!.value = '[]';
    expect(() => validateNotificationGolden(shape)).toThrow('GOLDEN_ROWS');
  });
  it('accepts only the four stored schema-local defaults; no global, owner, PUBLIC, third-party or grant options', () => {
    expect(() => validateNotificationDefaults(defaults())).not.toThrow();
    for (const patch of [
      { scope: 'GLOBAL' },
      { grantor: 'phub_beta' },
      { grantee: 'PUBLIC' },
      { grantee: 'phub_migrator' },
      { grantee: 'other_role' },
      { grantable: true },
      { privilege: 'TRUNCATE' },
    ]) {
      const value = defaults();
      value[0] = { ...value[0]!, ...patch };
      expect(() => validateNotificationDefaults(value)).toThrow('DEFAULT_ACL_PREIMAGE');
    }
    expect(() =>
      validateNotificationDefaults([
        ...defaults(),
        { ...defaults()[0]!, grantee: 'phub_migrator' },
      ]),
    ).toThrow();
    expect(() => validateNotificationDefaults(defaults().slice(1))).toThrow();
  });
  it('requires a concrete database/system identifier instead of an unbound role-only proof', () => {
    expect(
      parseNotificationTarget({ databaseName: 'synthetic', systemIdentifier: '1234' }),
    ).toEqual({ databaseName: 'synthetic', systemIdentifier: '1234' });
    for (const value of [
      { databaseName: 'synthetic' },
      { databaseName: 'synthetic', systemIdentifier: 1234 },
      { databaseName: 'synthetic;drop', systemIdentifier: '1234' },
      { databaseName: 'synthetic', systemIdentifier: '1234', extra: true },
    ])
      expect(() => parseNotificationTarget(value)).toThrow();
  });
  it('places the strict guard before all schema DDL in both ordinary entry points', async () => {
    for (const path of ['apps/migrator/src/migration-runner.ts', 'scripts/migrate.ts']) {
      const source = await readFile(path, 'utf8');
      const guard = source.indexOf("throw new Error('NOTIFICATION_MIGRATION_CONTROLLER_REQUIRED')");
      expect(guard).toBeGreaterThan(0);
      expect(guard).toBeLessThan(
        source.indexOf('create table if not exists public.schema_migrations'),
      );
      expect(source.slice(0, guard)).toContain('applied.length > 0');
    }
  });
});
