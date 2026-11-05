import {
  CLOSED_R1_CONTROLLER_BASE,
  CLOSED_R1_CONTROLLER_FILES,
  validateClosedR1NativeJoinPrerequisite,
  validateClosedR1PhonePrerequisite,
} from './timeweb-closed-application-source.js';
// Separate exact-source enrollment. Historical108 source guards stay unchanged.
import { assertControllerPromotionGitConfig } from './verify-source-ci.js';
import { parseApiWorkerControllerDiff } from './timeweb-api-worker-contract.js';
import { parseStrictJson } from './strict-json.js';
import { r1PackagedInventory, r1Hash, r1Stop } from './r1-tail-migration-profile.js';
import { validateR1TailOperation } from './r1-tail-migration-controller.js';
import { r1TailSourceCatalogs } from './r1-tail-migration-state.js';
const SOURCE = '/opt/phub/timeweb-beta/standard/source';
export const R1_TAIL_SOURCE_BASE = CLOSED_R1_CONTROLLER_BASE.sha;
const allowed = new Set([
  ...CLOSED_R1_CONTROLLER_FILES,
  'apps/migrator/src/main.ts',
  'apps/migrator/src/closed-single-migration.pg.test.ts',
  'apps/migrator/src/r1-tail-migration.ts',
  'apps/migrator/src/r1-tail-migration.test.ts',
  'apps/migrator/src/r1-tail-migration.pg.test.ts',
  'deploy/timeweb/r1-tail108-119.v1.json',
  'deploy/timeweb/r1-tail108-119-catalogs.v1.json',
  'scripts/control-timeweb-database-backup.py',
  'scripts/test-timeweb-database-backup.py',
  'docs/runbooks/r1-tail108-119-migration.md',
  ...[
    'profile',
    'catalog',
    'acl',
    'state',
    'source',
    'backup',
    'runtime',
    'controller',
    'locks',
  ].flatMap((name) => [
    `scripts/r1-tail-migration-${name}.js`,
    `scripts/r1-tail-migration-${name}.d.ts`,
    `scripts/r1-tail-migration-${name}.test.ts`,
  ]),
]);
export function validateR1TailSourceDelta(entries) {
  if (
    !Array.isArray(entries) ||
    entries.length === 0 ||
    new Set(entries.map((row) => row.path)).size !== entries.length
  )
    r1Stop('SOURCE_DELTA');
  const nativePrerequisite = validateClosedR1NativeJoinPrerequisite(entries);
  const phonePrerequisite = validateClosedR1PhonePrerequisite(entries);
  for (const row of entries) {
    if (
      (!allowed.has(row.path) &&
        !nativePrerequisite.has(row.path) &&
        !phonePrerequisite.has(row.path)) ||
      !['A', 'M'].includes(row.status) ||
      row.newMode !== '100644' ||
      !/^[a-f0-9]{40}$/.test(row.newOid ?? '') ||
      /^0{40}$/.test(row.newOid) ||
      (row.status === 'A'
        ? row.oldMode !== '000000' || row.oldOid !== '0'.repeat(40)
        : row.oldMode !== '100644' || row.newOid === row.oldOid)
    )
      r1Stop('SOURCE_DELTA');
  }
  return entries;
}
export function attestR1TailSource(operation, deps) {
  validateR1TailOperation(operation);
  const { git, read, secure, present } = deps;
  assertControllerPromotionGitConfig(git);
  if (
    !secure(SOURCE, 0o700).isDirectory() ||
    !secure(`${SOURCE}/.git`).isDirectory() ||
    git(['rev-parse', '--show-toplevel']) !== SOURCE ||
    git(['rev-parse', '--absolute-git-dir']) !== `${SOURCE}/.git` ||
    git(['rev-parse', '--path-format=absolute', '--git-common-dir']) !== `${SOURCE}/.git` ||
    git(['rev-parse', 'HEAD']) !== operation.controllerSha ||
    git(['rev-parse', 'HEAD^{tree}']) !== operation.controllerTree ||
    git(['status', '--porcelain', '--untracked-files=all']) ||
    present(`${SOURCE}/.git/objects/info/alternates`) ||
    present(`${SOURCE}/.git/shallow`)
  )
    r1Stop('SOURCE_IDENTITY');
  const config = parseStrictJson(read('/etc/phub/timeweb-beta-standard-delivery.json'));
  if (
    config.schema !== 1 ||
    config.enabled !== true ||
    typeof config.owner !== 'string' ||
    !config.owner.trim() ||
    config.controllerSha !== operation.controllerSha
  )
    r1Stop('SOURCE_ENROLLMENT');
  if (git(['rev-parse', `${R1_TAIL_SOURCE_BASE}^{tree}`]) !== CLOSED_R1_CONTROLLER_BASE.tree)
    r1Stop('SOURCE_BASE');
  git(['merge-base', '--is-ancestor', R1_TAIL_SOURCE_BASE, operation.controllerSha]);
  validateR1TailSourceDelta(
    parseApiWorkerControllerDiff(
      git([
        'diff',
        '--no-renames',
        '--raw',
        '--abbrev=40',
        '-z',
        R1_TAIL_SOURCE_BASE,
        operation.controllerSha,
      ]),
    ),
  );
  for (const entry of git(['ls-files', '--stage', '-z']).split('\0').filter(Boolean)) {
    const match = /^(100644|100755) [a-f0-9]{40} 0\t(.+)$/.exec(entry);
    if (
      !match ||
      match[2].startsWith('/') ||
      match[2].split('/').includes('..') ||
      match[2].includes('\\')
    )
      r1Stop('SOURCE_FILE');
    secure(`${SOURCE}/${match[2]}`, match[1] === '100644' ? 0o644 : 0o755);
  }
  const paths = git(['ls-files', '--', 'packages/database/migrations/*.sql'])
    .split('\n')
    .filter(Boolean)
    .sort();
  r1PackagedInventory(
    paths.map((path) => {
      const match = /^packages\/database\/migrations\/([0-9]{4}_[a-z0-9_]+\.sql)$/.exec(path);
      if (!match) r1Stop('SOURCE_SQL');
      return { filename: match[1], checksum: r1Hash(read(`${SOURCE}/${path}`, 0o644)) };
    }),
  );
  if (
    r1Hash(read(`${SOURCE}/deploy/timeweb/r1-tail108-119.v1.json`, 0o644)) !==
      operation.packageDescriptorSha256 ||
    r1Hash(read(`${SOURCE}/scripts/r1-tail-migration-catalog.js`, 0o644)) !==
      operation.catalogBuilderSha256
  )
    r1Stop('SOURCE_INPUTS');
  r1TailSourceCatalogs(operation.catalogsSha256);
  return operation;
}
