import {
  closedApplicationPackageFamily,
  closedApplicationPackageDescriptor,
  closedApplicationDescriptorPath,
  assertClosedR1Descriptor,
} from './closed-application-package-family.js';
// Separate enrollment closure: the historical notification/photo allowlists are unchanged.
import { createHash } from 'node:crypto';
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
export const CLOSED_R1_CONTROLLER_BASE = Object.freeze({
  sha: '27d8527f2f36e1a647012a86f92f4a51b9dd50eb',
  tree: 'f144d66d2aaa3dfdb53177c62d35bcb7b327253f',
});
export const CLOSED_R1_CONTROLLER_FILES = Object.freeze([
  'scripts/closed-application-migration-acl.js',
  'scripts/closed-application-migration-acl.d.ts',
  'scripts/closed-application-migration-acl.test.ts',
  'deploy/timeweb/closed-application-prefix108-package119.v1.json',
  'deploy/timeweb/r1-tail108-119-catalogs.v1.json',
  'scripts/closed-application-package-family.js',
  'scripts/closed-application-package-family.d.ts',
  'scripts/closed-application-package-family.test.ts',
  'apps/migrator/src/main.ts',
  'apps/migrator/src/migration-runner.ts',
  'apps/migrator/src/closed-single-migration.ts',
  'apps/migrator/src/closed-single-migration.test.ts',
  'apps/migrator/src/closed-single-migration.pg.test.ts',
  'apps/migrator/src/r1-tail-migration.pg.test.ts',
  'scripts/timeweb-api-worker-migration.js',
  'scripts/timeweb-api-worker-migration.d.ts',
  'scripts/timeweb-api-worker-migration.test.ts',
  'scripts/timeweb-closed-application-profile.js',
  'scripts/timeweb-closed-application-profile.d.ts',
  'scripts/timeweb-closed-application-profile.test.ts',
  'scripts/timeweb-closed-application-backup.js',
  'scripts/timeweb-closed-application-backup.d.ts',
  'scripts/timeweb-closed-application-backup.test.ts',
  'scripts/timeweb-closed-application-source.js',
  'scripts/timeweb-closed-application-source.d.ts',
  'scripts/timeweb-closed-application-source.test.ts',
  'scripts/timeweb-closed-application-runtime.js',
  'scripts/timeweb-closed-application-runtime.test.ts',
  'scripts/timeweb-closed-application-controller.test.ts',
  'scripts/timeweb-closed-application.fixture.ts',
  'scripts/control-timeweb-database-backup.py',
  'scripts/test-timeweb-database-backup.py',
  'scripts/r1-tail-migration-runtime.js',
  'scripts/r1-tail-migration-source.js',
  'scripts/r1-tail-migration-catalog.js',
  'scripts/r1-tail-migration-catalog.test.ts',
  'scripts/r1-tail-migration-profile.test.ts',
  'docs/runbooks/closed-application-migrations-0103-0104.md',
  'docs/runbooks/r1-tail108-119-migration.md',
  // Fixed119 runtime privilege and existing API/Worker rollout extension.
  'scripts/r1-runtime-privilege-audit.js',
  'scripts/r1-runtime-privilege-audit.d.ts',
  'scripts/r1-runtime-privilege-audit.test.ts',
  'scripts/r1-runtime-grants119.js',
  'scripts/r1-runtime-grants119.d.ts',
  'scripts/r1-runtime-grants119.test.ts',
  'scripts/r1-tail-migration-controller.js',
  'scripts/r1-tail-migration-controller.d.ts',
  'scripts/r1-tail-migration-controller.test.ts',
  'scripts/r1-tail-migration-runtime.d.ts',
  'scripts/r1-tail-migration-runtime.test.ts',
  'scripts/timeweb-api-worker-upgrade.js',
  'scripts/timeweb-api-worker-upgrade.d.ts',
  'scripts/timeweb-api-worker-upgrade.test.ts',
  'scripts/timeweb-api-worker-adapter.test.ts',
  'scripts/timeweb-api-worker-contract.js',
  'scripts/timeweb-api-web-upgrade.js',
  'scripts/timeweb-r1-api-worker119-profile.js',
  'scripts/timeweb-r1-api-worker119-source.js',
  'scripts/timeweb-r1-api-worker119-source.d.ts',
  'scripts/timeweb-r1-api-worker119-profile.d.ts',
  'scripts/timeweb-r1-api-worker119-profile.test.ts',
  'scripts/timeweb-r1-api-worker119.fixture.ts',
  'scripts/timeweb-r1-api-worker119-access.js',
  'scripts/timeweb-r1-api-worker119-access.d.ts',
  'scripts/timeweb-r1-api-worker119-access.test.ts',
  'scripts/timeweb-r1-api-worker119-upgrade.test.ts',
  'docs/runbooks/r1-api-worker119-upgrade.md',
  'apps/web/src/CreateGamePage.test.tsx',
  // Non-executable release evidence does not alter the controller or migration package.
  'docs/release/R1-READINESS.md',
  'docs/release/R1-BLOCKERS.md',
  'docs/release/R1-DEPENDENCIES.md',
  'docs/release/R1-E2E-MATRIX.md',
  'docs/release/R1-RELEASE-RUNBOOK.md',
  'docs/release/R1-ROLLBACK.md',
  'docs/release/R1-GO-NOGO.md',
  'docs/release/R1-POST119-RUNTIME-ACCEPTANCE.md',
  'docs/release/R1-RUNTIME-PRIVILEGE-AUDIT.md',
  'docs/release/R1-OPERATIONS-20261103.md',
  'docs/release/R1-ANDROID-PHONE-ACCEPTANCE.md',
]);
// Exact P0 JOIN lifetime correction, independently reviewed with its regression test.
// These paths remain outside the editable controller allowlist. Admit the complete
// regular-blob pair only; later UI changes require their own reviewed release path.
const NATIVE_JOIN_PREREQUISITE = Object.freeze({
  'apps/web/src/NativeGameJoin.tsx': {
    oldOid: '5f0bd216b2236ad3dceb759dec01e9d56e261d36',
    newOid: '76175a62bd0a25ac281dd2ddf949f94add1106f5',
  },
  'apps/web/src/NativeGameJoin.test.tsx': {
    oldOid: 'f428b2d54b2f88d415fa936eca66b4b6d68435a3',
    newOid: '89350edf3ad31bdef5662197b95f554ce72182c6',
  },
});
export function validateClosedR1NativeJoinPrerequisite(entries) {
  if (!Array.isArray(entries)) fail('R1_NATIVE_JOIN');
  const rows = entries.filter((row) => row && Object.hasOwn(NATIVE_JOIN_PREREQUISITE, row.path));
  if (rows.length === 0) return new Set();
  if (
    rows.length !== 2 ||
    new Set(rows.map((row) => row.path)).size !== 2 ||
    rows.some((row) => {
      const pin = NATIVE_JOIN_PREREQUISITE[row.path];
      return (
        !same(
          Object.keys(row).sort(),
          ['oldMode', 'newMode', 'oldOid', 'newOid', 'status', 'path'].sort(),
        ) ||
        row.status !== 'M' ||
        row.oldMode !== '100644' ||
        row.newMode !== '100644' ||
        row.oldOid !== pin.oldOid ||
        row.newOid !== pin.newOid
      );
    })
  )
    fail('R1_NATIVE_JOIN');
  return new Set(rows.map((row) => row.path));
}
// Already merged #569/#572: quarter-court command routing and deterministic training
// date tests. These application paths remain outside the editable controller list.
const PHONE_PREREQUISITE = Object.freeze({
  'apps/web/src/CreateGamePage.tsx': {
    oldOid: '96db2b6e8d65a1f7ba48ff18e6055bebb882bc66',
    newOid: '8ff52b8b1170396f8e3cc48d6d5fd4c543b1a0eb',
  },
  'apps/web/src/TrainingsPage.test.tsx': {
    oldOid: '208f0c772b76f9d9a89b1cfeefd9071cb7595f62',
    newOid: 'a40331a45324f83fa6141ccad991d4338b24d053',
  },
});
export function validateClosedR1PhonePrerequisite(entries) {
  if (!Array.isArray(entries)) fail('R1_PHONE_PREREQUISITE');
  const rows = entries.filter((row) => row && Object.hasOwn(PHONE_PREREQUISITE, row.path));
  if (rows.length === 0) return new Set();
  if (
    rows.length !== 2 ||
    new Set(rows.map((row) => row.path)).size !== 2 ||
    rows.some((row) => {
      const pin = PHONE_PREREQUISITE[row.path];
      return (
        !same(
          Object.keys(row).sort(),
          ['oldMode', 'newMode', 'oldOid', 'newOid', 'status', 'path'].sort(),
        ) ||
        row.status !== 'M' ||
        row.oldMode !== '100644' ||
        row.newMode !== '100644' ||
        row.oldOid !== pin.oldOid ||
        row.newOid !== pin.newOid
      );
    })
  )
    fail('R1_PHONE_PREREQUISITE');
  return new Set(rows.map((row) => row.path));
}
// Exact JOIN60 implementation, regression tests and duration contract.
// Application paths stay outside the editable controller allowlist.
const JOIN60_PREREQUISITE = Object.freeze({
  'apps/api/src/games/game-commercial-join.test.ts': {
    oldOid: '6350c1d9d1e213a02351327e372c11ef930b1d88',
    newOid: '23fa1a6b8fd83042645ef82d96dc2329942dd34d',
  },
  'apps/api/src/games/game-join-conditions-owner.ts': {
    oldOid: '3ea378e81b3ab71cb263e0f1b9fc14d0a3650ef0',
    newOid: 'bae4a56b46088d9445f30a0956406832e65f3c24',
  },
  'apps/api/src/games/game-join-conditions-resolver.test.ts': {
    oldOid: '6ae655278baadea2c9cbcaeca30894c047f88c4e',
    newOid: '4d810ff830dd5d03adf1e083e253a6458e8312f7',
  },
  'apps/api/src/games/game-join-conditions.test-fixture.ts': {
    oldOid: '4af7f33ddf6a193e5b57440d920582081e4f6436',
    newOid: '3b93df7f80095bea1542922b8bfd9eb2588f71fd',
  },
  'apps/api/src/games/game-join-conditions.test.ts': {
    oldOid: '020305559f9a351f50db8c4eb22cbf7f96d364bd',
    newOid: '2dd7c344ad9f929495d1f1e50e47d5c2b639b0ac',
  },
  'apps/api/src/games/game-join-conditions.ts': {
    oldOid: 'fcedef03338f747145d08ac0796f0440d73e885a',
    newOid: 'f8c9e62ec57ca639bd8ad33f8b4f3fd09f997fa9',
  },
  'docs/contracts/game-join-conditions.md': {
    oldOid: 'b5009d30579e65caef133116bfb2f58cd2b0be36',
    newOid: 'af199d739153277becdbca1df6c0499108ed0d4f',
  },
  'packages/database/src/game-join-conditions-context-repository.ts': {
    oldOid: 'e4b084d60905099f1babdae0915f6cc6c8ed08ef',
    newOid: '2945dc681ee0eca5e9a6df8ed5a2f77fb21bd3a3',
  },
  'packages/viva-adapter/src/game-subscription-selection.ts': {
    oldOid: 'd3f3518ade36ffc400c5ea7e1fe8064d5f52ba7f',
    newOid: '055441ccc3363db241af1d378eadc3c23f5e62dd',
  },
  'apps/api/src/games/game-commercial-join-runtime.test.ts': {
    oldOid: 'c5a7bbc5fd82da33a84044bb48ffef0fea6a158c',
    newOid: '27471920361d91db421106a33e450823cd8bf438',
  },
});
export function validateClosedR1Join60Prerequisite(entries) {
  if (!Array.isArray(entries)) fail('R1_JOIN60_PREREQUISITE');
  const rows = entries.filter((row) => row && Object.hasOwn(JOIN60_PREREQUISITE, row.path));
  if (rows.length === 0) return new Set();
  if (
    rows.length !== 10 ||
    new Set(rows.map((row) => row.path)).size !== 10 ||
    rows.some((row) => {
      const pin = JOIN60_PREREQUISITE[row.path];
      return (
        !same(
          Object.keys(row).sort(),
          ['oldMode', 'newMode', 'oldOid', 'newOid', 'status', 'path'].sort(),
        ) ||
        row.status !== 'M' ||
        row.oldMode !== '100644' ||
        row.newMode !== '100644' ||
        row.oldOid !== pin.oldOid ||
        row.newOid !== pin.newOid
      );
    })
  )
    fail('R1_JOIN60_PREREQUISITE');
  return new Set(rows.map((row) => row.path));
}
export function validateClosedR1ControllerClosure(entries) {
  const paths = new Set();
  if (!Array.isArray(entries) || !entries.length) fail('R1_DELTA');
  const nativePrerequisite = validateClosedR1NativeJoinPrerequisite(entries);
  const phonePrerequisite = validateClosedR1PhonePrerequisite(entries);
  const join60Prerequisite = validateClosedR1Join60Prerequisite(entries);
  for (const row of entries) {
    if (
      !row ||
      !same(
        Object.keys(row).sort(),
        ['oldMode', 'newMode', 'oldOid', 'newOid', 'status', 'path'].sort(),
      ) ||
      paths.has(row.path) ||
      (!CLOSED_R1_CONTROLLER_FILES.includes(row.path) &&
        !nativePrerequisite.has(row.path) &&
        !phonePrerequisite.has(row.path) &&
        !join60Prerequisite.has(row.path)) ||
      !['A', 'M'].includes(row.status) ||
      row.newMode !== '100644' ||
      !/^[a-f0-9]{40}$/.test(row.newOid ?? '') ||
      /^0{40}$/.test(row.newOid) ||
      (row.status === 'A'
        ? row.oldMode !== '000000' || row.oldOid !== '0'.repeat(40)
        : row.oldMode !== '100644' ||
          !/^[a-f0-9]{40}$/.test(row.oldOid ?? '') ||
          row.oldOid === row.newOid)
    )
      fail('R1_DELTA');
    paths.add(row.path);
  }
  for (const required of [
    'scripts/closed-application-package-family.js',
    'deploy/timeweb/closed-application-prefix108-package119.v1.json',
    'deploy/timeweb/r1-tail108-119-catalogs.v1.json',
    'apps/migrator/src/main.ts',
    'apps/migrator/src/migration-runner.ts',
    'apps/migrator/src/closed-single-migration.ts',
    'scripts/timeweb-closed-application-profile.js',
    'scripts/timeweb-closed-application-source.js',
    'scripts/timeweb-closed-application-runtime.js',
    'scripts/timeweb-closed-application-backup.js',
    'scripts/timeweb-api-worker-migration.js',
    'scripts/control-timeweb-database-backup.py',
  ])
    if (!paths.has(required)) fail('R1_REQUIRED');
  return entries;
}
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
  const family = closedApplicationPackageFamily(operation);
  const base =
    family === 'R1_PACKAGE119' ? CLOSED_R1_CONTROLLER_BASE : CLOSED_APPLICATION_CONTROLLER_BASE;
  const selectedDescriptor = closedApplicationPackageDescriptor(operation);
  if (family === 'R1_PACKAGE119') assertClosedR1Descriptor();
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
  if (git(['rev-parse', `${base.sha}^{tree}`]) !== base.tree) fail('BASE');
  git(['merge-base', '--is-ancestor', base.sha, operation.controllerSha]);
  (family === 'R1_PACKAGE119'
    ? validateClosedR1ControllerClosure
    : validateClosedApplicationControllerClosure)(
    parseApiWorkerControllerDiff(
      git([
        'diff',
        '--no-renames',
        '--raw',
        '--abbrev=40',
        '-z',
        base.sha,
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
  const packageBytes = read(`${source}/${closedApplicationDescriptorPath(operation)}`, 0o644),
    builderBytes = read(`${source}/scripts/closed-application-migration-catalog.js`, 0o644);
  if (
    hash(packageBytes) !== operation.packageDescriptorSha256 ||
    hash(builderBytes) !== operation.catalogBuilderSha256 ||
    !same(parseStrictJson(packageBytes), selectedDescriptor)
  )
    fail('INPUTS');
  if (family === 'R1_PACKAGE119') {
    if (
      hash(
        read(`${source}/deploy/timeweb/closed-application-migrations-0103-0104.v1.json`, 0o644),
      ) !== selectedDescriptor.prefixDescriptorSha256 ||
      hash(read(`${source}/deploy/timeweb/r1-tail108-119.v1.json`, 0o644)) !==
        selectedDescriptor.fullInventoryDescriptorSha256
    )
      fail('R1_PREFIX_INPUTS');
  }
  const files = git(['ls-files', '--', 'packages/database/migrations/*.sql'])
    .split('\n')
    .filter(Boolean)
    .sort();
  if (files.length !== selectedDescriptor.packagedCount) fail('MIGRATION_SOURCE');
  const packaged = files.map((path) => {
    const match = /^packages\/database\/migrations\/([0-9]{4}_[a-z0-9_]+\.sql)$/.exec(path);
    if (!match) fail('MIGRATION_SOURCE');
    return [match[1], hash(read(`${source}/${path}`, 0o644))];
  });
  if (hash(JSON.stringify(packaged) + '\n') !== selectedDescriptor.packagedLedgerSha256)
    fail('MIGRATION_SOURCE');
  for (const step of Object.values(selectedDescriptor.profiles))
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
