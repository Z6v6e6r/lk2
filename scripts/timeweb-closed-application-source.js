// Separate enrollment closure: the historical notification/photo allowlists are unchanged.
import { createHash } from 'node:crypto';
import descriptor from '../deploy/timeweb/closed-application-migrations-0103-0104.v1.json' with { type: 'json' };
import { assertControllerPromotionGitConfig } from './verify-source-ci.js';
import { parseApiWorkerControllerDiff } from './timeweb-api-worker-contract.js';
import { parseStrictJson } from './strict-json.js';
import {
  validateClosedApplicationOperation,
  closedApplicationInputDigests,
} from './timeweb-closed-application-profile.js';

export const CLOSED_APPLICATION_CONTROLLER_BASE = Object.freeze({
  sha: '871cc2f8660ec98ec4b95f50a78aad1e6d1b1cfe',
  tree: 'a76bc4ce1f472e2465a0bbb0075f1ec0efba294c',
});
const source = '/opt/phub/timeweb-beta/standard/source';
const workflow = Object.freeze({
  path: '.github/workflows/pull-request.yaml',
  oldOid: 'ac7b7ea78fd496cdb2caae3f42b0371741ef1465',
  newOid: 'd6fa780fb7f509abb14d1e5774ecb29e2b0719c7',
});
const allowed = new Set([
  workflow.path,
  'apps/migrator/src/closed-single-migration.pg.test.ts',
  'apps/migrator/src/closed-single-migration.test.ts',
  'apps/migrator/src/closed-single-migration.ts',
  'apps/migrator/src/main.ts',
  'apps/migrator/src/migration-runner.ts',
  'deploy/timeweb/closed-application-migrations-0103-0104.v1.json',
  'scripts/closed-application-migration-acl.js',
  'scripts/closed-application-migration-acl.d.ts',
  'scripts/closed-application-migration-acl.test.ts',
  'scripts/closed-application-migration-catalog.js',
  'scripts/closed-application-migration-catalog.d.ts',
  'scripts/closed-schema-migration-guard.ts',
  'scripts/closed-schema-migration-guard.test.ts',
  'scripts/migrate.ts',
  'scripts/owned-closed-schema-test-target.ts',
  'scripts/owned-closed-schema-test-target.test.ts',
  'scripts/timeweb-location-photo-postgres.test.ts',
  'scripts/timeweb-api-worker-migration.js',
  'scripts/timeweb-api-worker-migration.d.ts',
  'scripts/timeweb-api-worker-migration.test.ts',
  'scripts/timeweb-closed-application-profile.js',
  'scripts/timeweb-closed-application-profile.d.ts',
  'scripts/timeweb-closed-application-profile.test.ts',
  'scripts/timeweb-closed-application.fixture.ts',
  'scripts/timeweb-closed-application-controller.js',
  'scripts/timeweb-closed-application-controller.test.ts',
  'scripts/timeweb-closed-application-source.js',
  'scripts/timeweb-closed-application-source.d.ts',
  'scripts/timeweb-closed-application-source.test.ts',
  'scripts/timeweb-closed-application-runtime.js',
  'scripts/timeweb-closed-application-runtime.d.ts',
  'scripts/timeweb-closed-application-runtime.test.ts',
  'scripts/timeweb-closed-application-backup.js',
  'scripts/timeweb-closed-application-backup.d.ts',
  'scripts/timeweb-closed-application-backup.test.ts',
  'scripts/control-timeweb-database-backup.py',
  'scripts/control-timeweb-database-backup.test.ts',
  'scripts/test-timeweb-database-backup.py',
  'docs/runbooks/closed-application-migrations-0103-0104.md',
]);
const required = [
  'apps/migrator/src/main.ts',
  'apps/migrator/src/migration-runner.ts',
  'apps/migrator/src/closed-single-migration.ts',
  'scripts/migrate.ts',
  'scripts/closed-schema-migration-guard.ts',
  'deploy/timeweb/closed-application-migrations-0103-0104.v1.json',
  'scripts/closed-application-migration-catalog.js',
  'scripts/closed-application-migration-acl.js',
  'scripts/timeweb-api-worker-migration.js',
  'scripts/timeweb-closed-application-profile.js',
  'scripts/timeweb-closed-application-source.js',
  'scripts/timeweb-closed-application-controller.js',
  'scripts/timeweb-closed-application-runtime.js',
  'scripts/timeweb-closed-application-backup.js',
  'scripts/control-timeweb-database-backup.py',
];
const hash = (value) => createHash('sha256').update(value).digest('hex');
const same = (a, b) =>
  JSON.stringify(a, (_key, value) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort())
      : value,
  ) ===
  JSON.stringify(b, (_key, value) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort())
      : value,
  );
const fail = (code) => {
  throw Error(`CLOSED_APPLICATION_SOURCE_${code}`);
};
export function validateClosedApplicationControllerClosure(entries) {
  if (
    !Array.isArray(entries) ||
    !entries.length ||
    new Set(entries.map((row) => row?.path)).size !== entries.length
  )
    fail('DELTA');
  for (const row of entries) {
    if (
      !row ||
      !same(
        Object.keys(row).sort(),
        ['oldMode', 'newMode', 'oldOid', 'newOid', 'status', 'path'].sort(),
      ) ||
      !allowed.has(row.path) ||
      !['A', 'M'].includes(row.status) ||
      !['100644', '100755'].includes(row.newMode) ||
      !/^[a-f0-9]{40}$/.test(row.newOid ?? '') ||
      /^0{40}$/.test(row.newOid) ||
      (row.status === 'A'
        ? row.oldMode !== '000000' || row.oldOid !== '0'.repeat(40)
        : row.oldMode !== row.newMode ||
          !/^[a-f0-9]{40}$/.test(row.oldOid ?? '') ||
          row.oldOid === row.newOid)
    )
      fail('DELTA');
    if (
      row.path === workflow.path &&
      (row.status !== 'M' ||
        row.oldMode !== '100644' ||
        row.newMode !== '100644' ||
        row.oldOid !== workflow.oldOid ||
        row.newOid !== workflow.newOid)
    )
      fail('WORKFLOW');
  }
  if (
    required.some((path) => !entries.some((row) => row.path === path)) ||
    !entries.some((row) => row.path === workflow.path)
  )
    fail('REQUIRED');
  return entries;
}
export function attestClosedApplicationControllerSource(operation, deps) {
  validateClosedApplicationOperation(operation);
  const { git, read, secure, present } = deps;
  if (!secure(source, 0o700).isDirectory() || !secure(`${source}/.git`).isDirectory())
    fail('DIRECTORY');
  (deps.assertGitConfig ?? assertControllerPromotionGitConfig)(git);
  const config = parseStrictJson(read('/etc/phub/timeweb-beta-standard-delivery.json'));
  if (
    !same(Object.keys(config).sort(), ['schema', 'enabled', 'owner', 'controllerSha'].sort()) ||
    config.schema !== 1 ||
    config.enabled !== true ||
    typeof config.owner !== 'string' ||
    !config.owner.trim() ||
    config.controllerSha !== operation.controllerSha ||
    git(['rev-parse', '--show-toplevel']) !== source ||
    git(['rev-parse', '--absolute-git-dir']) !== `${source}/.git` ||
    git(['rev-parse', '--path-format=absolute', '--git-common-dir']) !== `${source}/.git` ||
    git(['rev-parse', 'HEAD']) !== operation.controllerSha ||
    git(['rev-parse', 'HEAD^{tree}']) !== operation.controllerTree ||
    git(['status', '--porcelain', '--untracked-files=all']) ||
    present(`${source}/.git/objects/info/alternates`) ||
    present(`${source}/.git/shallow`)
  )
    fail('IDENTITY');
  if (
    git(['rev-parse', `${CLOSED_APPLICATION_CONTROLLER_BASE.sha}^{tree}`]) !==
    CLOSED_APPLICATION_CONTROLLER_BASE.tree
  )
    fail('BASE');
  git([
    'merge-base',
    '--is-ancestor',
    CLOSED_APPLICATION_CONTROLLER_BASE.sha,
    operation.controllerSha,
  ]);
  validateClosedApplicationControllerClosure(
    parseApiWorkerControllerDiff(
      git([
        'diff',
        '--no-renames',
        '--raw',
        '--abbrev=40',
        '-z',
        CLOSED_APPLICATION_CONTROLLER_BASE.sha,
        operation.controllerSha,
      ]),
    ),
  );
  for (const item of git(['ls-files', '--stage', '-z']).split('\0').filter(Boolean)) {
    const match = /^(100644|100755) [a-f0-9]{40} 0\t(.+)$/.exec(item);
    if (
      !match ||
      match[2].startsWith('/') ||
      match[2].split('/').includes('..') ||
      match[2].includes('\\')
    )
      fail('FILE');
    secure(`${source}/${match[2]}`, match[1] === '100644' ? 0o644 : 0o755);
  }
  const packageBytes = read(
      `${source}/deploy/timeweb/closed-application-migrations-0103-0104.v1.json`,
      0o644,
    ),
    builderBytes = read(`${source}/scripts/closed-application-migration-catalog.js`, 0o644);
  if (
    hash(packageBytes) !== operation.packageDescriptorSha256 ||
    hash(builderBytes) !== operation.catalogBuilderSha256 ||
    !same(parseStrictJson(packageBytes), descriptor)
  )
    fail('INPUTS');
  const files = git(['ls-files', '--', 'packages/database/migrations/*.sql'])
    .split('\n')
    .filter(Boolean)
    .sort();
  if (files.length !== descriptor.packagedCount) fail('MIGRATION_SOURCE');
  const packaged = files.map((path) => {
    const match = /^packages\/database\/migrations\/([0-9]{4}_[a-z0-9_]+\.sql)$/.exec(path);
    if (!match) fail('MIGRATION_SOURCE');
    return [match[1], hash(read(`${source}/${path}`, 0o644))];
  });
  if (hash(JSON.stringify(packaged) + '\n') !== descriptor.packagedLedgerSha256)
    fail('MIGRATION_SOURCE');
  for (const step of Object.values(descriptor.profiles))
    if (!packaged.some(([name, checksum]) => name === step.filename && checksum === step.checksum))
      fail('MIGRATION_SOURCE');
  // Runtime/env checks belong to the host binding, never the networkless restore child.
  const inputs = closedApplicationInputDigests(operation);
  if (
    inputs.aclPreimageSha256 !== operation.aclPreimageSha256 ||
    inputs.bootstrapSha256 !== operation.bootstrapSha256 ||
    inputs.cleanupSha256 !== operation.cleanupSha256
  )
    fail('ACL_INPUTS');
  return operation;
}
