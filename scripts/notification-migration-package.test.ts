import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  diagnosticCheckNames,
  notificationLedgerCheckpoint,
  notificationLedgerDigest,
  notificationMigrationPackage,
  prepareNotificationMigrationPackage,
  readNotificationMigrationCatalog,
  validateNotificationMigrationCatalog,
  type MigrationRow,
  type PackageDiagnostic,
} from './notification-migration-package.js';
import { validateApiWorkerMigrationLedger } from './timeweb-api-worker-migration.js';

const at = Date.parse('2026-10-22T14:00:00.000Z');
let catalog: MigrationRow[];
beforeAll(async () => {
  catalog = await readNotificationMigrationCatalog(resolve('packages/database/migrations'));
});
function diagnostic(count = 102): PackageDiagnostic {
  return {
    schema: 'PHUB_NOTIFICATION_MIGRATION_DIAGNOSTIC_V1',
    capturedAt: new Date(at).toISOString(),
    databaseName: 'synthetic',
    systemIdentifier: '1234567890',
    postgresMajor: 16,
    readOnly: 'on',
    migrator: 'phub_migrator',
    runtime: 'phub_runtime',
    ledger: structuredClone(catalog.slice(0, count)),
    checks: diagnosticCheckNames.map((name) => ({ name, ok: true })),
    defaultAcls: [
      {
        scope: 'GLOBAL',
        objectType: 'f',
        grantee: 'PUBLIC',
        privilege: 'EXECUTE',
        grantable: false,
      },
    ],
    relations: ['notifications.deliveries', 'support.messages', 'support.tickets'].map((name) => ({
      name,
      owner: 'phub_migrator',
      canAlter: true,
    })),
    parentDefinitions: [
      ['identity.local_email_credentials', 'phub_migrator', 'UNIQUE (tenant_id, id, user_id)'],
      ['identity.tenants', 'phub_beta', 'PRIMARY KEY (id)'],
      ['identity.users', 'phub_beta', 'UNIQUE (tenant_id, id)'],
      ['notifications.intents', 'phub_beta', 'PRIMARY KEY (tenant_id, id)'],
      ['notifications.templates', 'phub_beta', 'PRIMARY KEY (tenant_id, id)'],
      ['support.tickets', 'phub_migrator', 'PRIMARY KEY (tenant_id, id)'],
    ].map(([name, owner, key]) => ({
      name: name!,
      definition: JSON.stringify({
        owner,
        keys: [{ name: 'synthetic_key', definition: key, validated: true }],
      }),
    })),
  };
}
describe('preparation-only notification migration package 0099–0101', () => {
  it('pins every checkpoint and leaves the frozen 99→102 runner closed', () => {
    expect(notificationMigrationPackage.preparationOnly).toBe(true);
    expect(notificationMigrationPackage.authorizesApply).toBe(false);
    expect([102, 103, 104, 105].map((n) => notificationLedgerDigest(catalog.slice(0, n)))).toEqual([
      'b9bfd91a3985de51b323d9955325b5edabc22b42cfc350bddebe811ca42c2f85',
      '30a0e396e35739c66291b7bc3143bb9ac9be584d4732ee01ed0dea82da7339f7',
      'e5eacd1ea2514df2abe7d8abd89f1b54e103c8b12a1aacf6b4790622236516d8',
      '7bd0476427e40967f4531972829a86f578d0e9d844ab9e92f16637b868e207fd',
    ]);
    expect(() =>
      validateApiWorkerMigrationLedger(catalog, notificationLedgerDigest(catalog)),
    ).toThrow('LEDGER_COUNT');
  });
  it('reports no diagnostic blockers without granting apply/deploy authority', () => {
    const report = prepareNotificationMigrationPackage(catalog, diagnostic(), at);
    expect(report).toMatchObject({
      diagnosticChecksPassed: true,
      authorizesApply: false,
      deploymentEligible: false,
      ledgerCount: 102,
      blockers: [],
    });
    expect(report.pending.map((s) => s.filename)).toEqual([
      '0099_local_password_reset_proofs.sql',
      '0100_notification_scenarios.sql',
      '0101_notification_lifecycle_channels.sql',
    ]);
    expect(report.executionGaps).toContain('REVIEWED_102_TO_105_CONTROLLER');
  });
  it('blocks the observed identity default ACL and independently blocks missing deliveries ownership', () => {
    const value = diagnostic();
    value.defaultAcls.push(
      ...['SELECT', 'INSERT', 'UPDATE', 'DELETE'].map((privilege) => ({
        scope: 'identity',
        objectType: 'r',
        grantee: 'phub_runtime',
        privilege,
        grantable: false,
      })),
    );
    value.relations[0] = { name: 'notifications.deliveries', owner: 'phub_beta', canAlter: false };
    const report = prepareNotificationMigrationPackage(catalog, value, at);
    expect(report.diagnosticChecksPassed).toBe(false);
    expect(report.blockers).toEqual([
      'DELIVERIES_DDL_OWNER_MISMATCH',
      'RESET_DEFAULT_ACL_WOULD_WIDEN_RUNTIME',
    ]);
  });
  it.each(['identity', 'notifications', 'GLOBAL'])(
    'blocks non-owner table grants in %s',
    (scope) => {
      for (const grantee of ['PUBLIC', 'unexpected_role', 'phub_runtime']) {
        const value = diagnostic();
        value.defaultAcls.push({
          scope,
          objectType: 'r',
          grantee,
          privilege: 'SELECT',
          grantable: true,
        });
        expect(prepareNotificationMigrationPackage(catalog, value, at).diagnosticChecksPassed).toBe(
          false,
        );
      }
    },
  );
  it('records existing support defaults and function ACLs without treating them as new-table grants', () => {
    const value = diagnostic();
    value.defaultAcls.push(
      ...['SELECT', 'INSERT', 'UPDATE', 'DELETE'].map((privilege) => ({
        scope: 'support',
        objectType: 'r',
        grantee: 'phub_runtime',
        privilege,
        grantable: false,
      })),
    );
    expect(prepareNotificationMigrationPackage(catalog, value, at).diagnosticChecksPassed).toBe(
      true,
    );
    value.defaultAcls[1]!.grantable = true;
    expect(prepareNotificationMigrationPackage(catalog, value, at).blockers).toContain(
      'SUPPORT_DEFAULT_ACL_UNEXPECTED',
    );
  });
  it.each(diagnosticCheckNames)('blocks a missing capability: %s', (name) => {
    const value = diagnostic();
    value.checks.find((r) => r.name === name)!.ok = false;
    expect(prepareNotificationMigrationPackage(catalog, value, at).blockers).toContain(
      `CAPABILITY_${name}`,
    );
  });
  it.each([103, 104, 105])(
    'recognizes checkpoint %s but never suggests automatic apply/retry',
    (count) => {
      const report = prepareNotificationMigrationPackage(catalog, diagnostic(count), at);
      expect(report.ledgerCount).toBe(count);
      expect(report.diagnosticChecksPassed).toBe(false);
      expect(report.authorizesApply).toBe(false);
      expect(report.blockers).toContain(
        count === 105
          ? 'ALREADY_APPLIED_REQUIRES_POSTFLIGHT'
          : 'PARTIAL_LEDGER_REQUIRES_OWNER_RECONCILIATION',
      );
    },
  );
  it('rejects checksum drift, extra/duplicate/reordered SQL, and unknown partial ledgers', () => {
    const changed = structuredClone(catalog);
    changed[102]!.checksum = '0'.repeat(64);
    const reordered = structuredClone(catalog);
    [reordered[102], reordered[103]] = [reordered[103]!, reordered[102]!];
    for (const rows of [
      changed,
      reordered,
      [...catalog, catalog[104]!],
      catalog.slice(0, 101),
      [...catalog.slice(0, 104), catalog[103]!],
    ]) {
      expect(() => validateNotificationMigrationCatalog(rows)).toThrow();
      expect(() => notificationLedgerCheckpoint(rows)).toThrow();
    }
  });
  it('fails closed on incomplete, duplicate, unknown, non-read-only and stale diagnostics', () => {
    const missing = diagnostic();
    missing.checks.pop();
    const duplicate = diagnostic();
    duplicate.checks[0] = duplicate.checks[1]!;
    const parent = diagnostic();
    parent.parentDefinitions.pop();
    const acl = diagnostic();
    acl.defaultAcls[0]!.objectType = 'unknown';
    const functionAcl = diagnostic();
    functionAcl.defaultAcls = [];
    const parentKey = diagnostic();
    parentKey.parentDefinitions[0]!.definition = JSON.stringify({
      owner: 'phub_migrator',
      keys: [
        { name: 'synthetic_key', definition: 'UNIQUE (id, tenant_id, user_id)', validated: true },
      ],
    });
    const parentOwner = diagnostic();
    parentOwner.parentDefinitions[0]!.definition = JSON.stringify({
      owner: 'unexpected_role',
      keys: [],
    });
    for (const value of [
      missing,
      duplicate,
      parent,
      acl,
      functionAcl,
      parentKey,
      parentOwner,
      { ...diagnostic(), readOnly: 'off' },
      { ...diagnostic(), extra: true },
    ]) {
      expect(() => prepareNotificationMigrationPackage(catalog, value, at)).toThrow();
    }
    expect(
      prepareNotificationMigrationPackage(catalog, diagnostic(), at + 300001).blockers,
    ).toContain('STALE_DIAGNOSTIC');
    expect(prepareNotificationMigrationPackage(catalog, diagnostic(), at - 1).blockers).toContain(
      'STALE_DIAGNOSTIC',
    );
  });
  it('keeps the diagnostic query read-only and disconnected from all live controllers', async () => {
    const sql = await readFile(
      resolve('deploy/timeweb/notification-migrations-0099-0101-diagnostic.sql'),
      'utf8',
    );
    expect(sql).toContain('begin transaction isolation level repeatable read read only;');
    expect(sql.trim().endsWith('rollback;')).toBe(true);
    expect(sql.replace(/--[^\n]*/g, '')).not.toMatch(
      /^\s*(?:create|alter|drop|grant|revoke|insert|update|delete|truncate|call|do)\s/im,
    );
    for (const name of [
      'timeweb-api-worker-migration.js',
      'control-timeweb-database-backup.py',
      'run-timeweb-standard-delivery.js',
    ]) {
      expect(await readFile(resolve('scripts', name), 'utf8')).not.toMatch(
        /notification-migration-package|notification-migrations-0099/,
      );
    }
  });
});
