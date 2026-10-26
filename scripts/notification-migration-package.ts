// Offline preparation only. This module neither connects to a database nor authorizes execution.
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import descriptor from '../deploy/timeweb/notification-migrations-0099-0101.v1.json';
import { parseStrictJson } from './strict-json.js';

export const notificationMigrationPackage = descriptor;
export type MigrationRow = { filename: string; checksum: string };
export type PackageDiagnostic = {
  schema: 'PHUB_NOTIFICATION_MIGRATION_DIAGNOSTIC_V1';
  capturedAt: string;
  databaseName: string;
  systemIdentifier: string;
  postgresMajor: number;
  readOnly: 'on';
  migrator: string;
  runtime: string;
  ledger: MigrationRow[];
  checks: { name: string; ok: boolean }[];
  defaultAcls: {
    scope: string;
    objectType: string;
    grantee: string;
    privilege: string;
    grantable: boolean;
  }[];
  relations: { name: string; owner: string; canAlter: boolean }[];
  parentDefinitions: { name: string; definition: string }[];
};

const sha256 = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
const fail = (code: string): never => {
  throw new Error(`NOTIFICATION_MIGRATION_PACKAGE_${code}`);
};
function exact(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join('\n') !== [...keys].sort().join('\n')
  )
    fail('SHAPE');
}
export function notificationLedgerDigest(rows: readonly MigrationRow[]): string {
  if (!Array.isArray(rows)) fail('LEDGER');
  let previous = '';
  for (const row of rows) {
    exact(row, ['filename', 'checksum']);
    if (
      typeof row.filename !== 'string' ||
      !/^[0-9]{4}_[a-z0-9_]+\.sql$/.test(row.filename) ||
      typeof row.checksum !== 'string' ||
      !/^[a-f0-9]{64}$/.test(row.checksum) ||
      row.filename <= previous
    )
      fail('LEDGER');
    previous = row.filename;
  }
  return sha256(`${JSON.stringify(rows.map((r) => [r.filename, r.checksum]))}\n`);
}
export function notificationLedgerCheckpoint(rows: readonly MigrationRow[]): number {
  const checkpoints = [
    descriptor.initial,
    ...descriptor.steps.map((s) => ({ count: s.ledgerCount, sha256: s.ledgerSha256 })),
  ];
  const expected = checkpoints.find((s) => s.count === rows.length);
  if (!expected || notificationLedgerDigest(rows) !== expected.sha256)
    return fail('UNKNOWN_LEDGER');
  return expected.count;
}
export function validateNotificationMigrationCatalog(rows: readonly MigrationRow[]): void {
  // The following photo expansion is packaged with the application, but is not a
  // notification step or checkpoint. Pin its exact bytes; never accept an arbitrary suffix.
  if (
    rows.length !== 106 ||
    rows[105]?.filename !== '0102_location_recommendation_photos.sql' ||
    rows[105].checksum !== '8817a4dab03e78d27023d4b3ee72a12bfa8f2ffe4599e4e78df1d3a3893366f0'
  )
    fail('SOURCE_CATALOG');
  if (notificationLedgerCheckpoint(rows.slice(0, 105)) !== 105) fail('SOURCE_CATALOG');
  if (notificationLedgerCheckpoint(rows.slice(0, 102)) !== 102) fail('SOURCE_CATALOG');
  for (const [i, step] of descriptor.steps.entries()) {
    const row = rows[102 + i];
    if (row?.filename !== step.filename || row.checksum !== step.checksum) fail('SOURCE_CATALOG');
    notificationLedgerCheckpoint(rows.slice(0, step.ledgerCount));
  }
}
export async function readNotificationMigrationCatalog(directory: string): Promise<MigrationRow[]> {
  const names = (await readdir(directory)).filter((name) => name.endsWith('.sql')).sort();
  const rows = await Promise.all(
    names.map(async (filename) => ({
      filename,
      checksum: sha256(await readFile(resolve(directory, filename))),
    })),
  );
  validateNotificationMigrationCatalog(rows);
  return rows;
}

export const diagnosticCheckNames = [
  'migratorRestricted',
  'runtimeCannotAssumeMigrator',
  'identitySchema',
  'notificationsSchema',
  'supportSchema',
  'plpgsqlUsage',
  'uuidExecute',
  'ledgerSelectInsert',
  'credentialsReferences',
  'tenantsReferences',
  'usersReferences',
  'templatesReferences',
  'intentsReferences',
  'ticketsReferences',
  'newObjectsAbsent',
];
const ddlRelations = ['notifications.deliveries', 'support.messages', 'support.tickets'];
const parentRelations = new Map([
  ['identity.local_email_credentials', ['phub_migrator', 'UNIQUE (tenant_id, id, user_id)']],
  ['identity.tenants', ['phub_beta', 'PRIMARY KEY (id)']],
  ['identity.users', ['phub_beta', 'UNIQUE (tenant_id, id)']],
  ['notifications.intents', ['phub_beta', 'PRIMARY KEY (tenant_id, id)']],
  ['notifications.templates', ['phub_beta', 'PRIMARY KEY (tenant_id, id)']],
  ['support.tickets', ['phub_migrator', 'PRIMARY KEY (tenant_id, id)']],
]);

export function prepareNotificationMigrationPackage(
  catalog: readonly MigrationRow[],
  input: unknown,
  at = Date.now(),
) {
  validateNotificationMigrationCatalog(catalog);
  exact(input, [
    'schema',
    'capturedAt',
    'databaseName',
    'systemIdentifier',
    'postgresMajor',
    'readOnly',
    'migrator',
    'runtime',
    'ledger',
    'checks',
    'defaultAcls',
    'relations',
    'parentDefinitions',
  ]);
  if (
    input.schema !== 'PHUB_NOTIFICATION_MIGRATION_DIAGNOSTIC_V1' ||
    input.readOnly !== 'on' ||
    input.postgresMajor !== 16 ||
    !/^[a-z_][a-z0-9_]{0,62}$/.test(String(input.databaseName)) ||
    !/^[1-9][0-9]*$/.test(String(input.systemIdentifier)) ||
    input.migrator !== 'phub_migrator' ||
    input.runtime !== 'phub_runtime' ||
    typeof input.capturedAt !== 'string' ||
    !Number.isFinite(Date.parse(input.capturedAt)) ||
    new Date(input.capturedAt).toISOString() !== input.capturedAt ||
    ['ledger', 'checks', 'defaultAcls', 'relations', 'parentDefinitions'].some(
      (k) => !Array.isArray(input[k]),
    )
  )
    fail('DIAGNOSTIC');
  const value = input as unknown as PackageDiagnostic;
  const count = notificationLedgerCheckpoint(value.ledger);
  const blockers: string[] = [];
  if (at - Date.parse(value.capturedAt) > 300000 || at < Date.parse(value.capturedAt))
    blockers.push('STALE_DIAGNOSTIC');
  if (count !== 102)
    blockers.push(
      count === 105
        ? 'ALREADY_APPLIED_REQUIRES_POSTFLIGHT'
        : 'PARTIAL_LEDGER_REQUIRES_OWNER_RECONCILIATION',
    );
  if (value.checks.length !== diagnosticCheckNames.length) fail('CHECKS');
  for (const name of diagnosticCheckNames) {
    const rows = value.checks.filter((r) => r.name === name);
    if (rows.length !== 1) fail('CHECKS');
    const row = rows[0]!;
    exact(row, ['name', 'ok']);
    if (typeof row.ok !== 'boolean') fail('CHECKS');
    if (!row.ok) blockers.push(`CAPABILITY_${name}`);
  }
  if (value.relations.length !== ddlRelations.length) fail('RELATIONS');
  for (const name of ddlRelations) {
    const rows = value.relations.filter((r) => r.name === name);
    if (rows.length !== 1) fail('RELATIONS');
    const row = rows[0]!;
    exact(row, ['name', 'owner', 'canAlter']);
    if (!['phub_beta', 'phub_migrator'].includes(row.owner) || typeof row.canAlter !== 'boolean')
      fail('RELATIONS');
    if (!row.canAlter)
      blockers.push(
        name === 'notifications.deliveries'
          ? 'DELIVERIES_DDL_OWNER_MISMATCH'
          : `DDL_OWNER_MISMATCH_${name}`,
      );
  }
  if (!value.defaultAcls.some((a) => a.scope === 'GLOBAL' && a.objectType === 'f'))
    fail('FUNCTION_ACL_INVENTORY');
  for (const acl of value.defaultAcls) {
    exact(acl, ['scope', 'objectType', 'grantee', 'privilege', 'grantable']);
    if (
      !['GLOBAL', 'identity', 'notifications', 'support'].includes(acl.scope) ||
      !['r', 'f'].includes(acl.objectType) ||
      typeof acl.grantable !== 'boolean' ||
      !/^(PUBLIC|[a-z_][a-z0-9_]{0,62})$/.test(acl.grantee) ||
      ![
        'SELECT',
        'INSERT',
        'UPDATE',
        'DELETE',
        'TRUNCATE',
        'REFERENCES',
        'TRIGGER',
        'MAINTAIN',
        'EXECUTE',
      ].includes(acl.privilege)
    )
      fail('ACL');
    if (acl.objectType === 'f') continue; // Inventory only; function ACLs require exact per-object postflight.
    if (acl.grantee === value.migrator) continue;
    if (['GLOBAL', 'identity'].includes(acl.scope))
      blockers.push('RESET_DEFAULT_ACL_WOULD_WIDEN_RUNTIME');
    if (['GLOBAL', 'notifications'].includes(acl.scope))
      blockers.push('SCENARIO_DEFAULT_ACL_WOULD_GRANT_RUNTIME');
    if (
      acl.scope === 'support' &&
      (acl.grantee !== value.runtime ||
        acl.grantable ||
        !['SELECT', 'INSERT', 'UPDATE', 'DELETE'].includes(acl.privilege))
    )
      blockers.push('SUPPORT_DEFAULT_ACL_UNEXPECTED');
  }
  if (value.parentDefinitions.length !== parentRelations.size) fail('PARENTS');
  for (const [name, [owner, requiredKey]] of parentRelations) {
    const rows = value.parentDefinitions.filter((r) => r.name === name);
    if (rows.length !== 1) fail('PARENTS');
    exact(rows[0], ['name', 'definition']);
    if (typeof rows[0].definition !== 'string' || !rows[0].definition.length) fail('PARENTS');
    const definition = parseStrictJson(rows[0].definition);
    exact(definition, ['owner', 'keys']);
    if (definition.owner !== owner || !Array.isArray(definition.keys)) return fail('PARENTS');
    let found = false;
    for (const key of definition.keys) {
      exact(key, ['name', 'definition', 'validated']);
      if (
        typeof key.name !== 'string' ||
        typeof key.definition !== 'string' ||
        key.validated !== true
      )
        fail('PARENTS');
      if (key.definition === requiredKey) found = true;
    }
    if (!found) fail('PARENTS');
  }
  return {
    schema: 'PHUB_NOTIFICATION_MIGRATION_PREPARATION_V1',
    preparationOnly: true,
    authorizesApply: false,
    deploymentEligible: false,
    diagnosticChecksPassed: blockers.length === 0,
    ledgerCount: count,
    ledgerSha256: notificationLedgerDigest(value.ledger),
    pending: descriptor.steps.filter((s) => s.ledgerCount > count),
    blockers: [...new Set(blockers)].sort(),
    // These prerequisites are deliberately not inferred from a successful catalog diagnostic.
    executionGaps: [
      'REVIEWED_ROLE_ACL_STRATEGY',
      'EXACT_PARENT_AND_POST_DDL_CATALOG',
      'FINAL_MAIN_MANIFEST_AND_CI',
      'LEDGER102_PRE0105_BACKUP_RESTORE_CUSTODY',
      'REVIEWED_102_TO_105_CONTROLLER',
    ],
    diagnostics: value,
  };
}
