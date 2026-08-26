#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  chownSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

import {
  parseEnvironment,
  validateRuntimeEnvironments,
} from './verify-timeweb-beta-runtime-env.js';

const FILES = ['api.env', 'worker.env', 'realtime.env', 'migrator.env'];
const TARGET_DIR = '/etc/phub/timeweb-beta';
const BACKUP_ROOT = '/etc/phub/timeweb-beta-backups';

function fail(reason) {
  throw new Error(reason);
}

function assertSecureDirectory(path, expectedUid, privateDirectory = true) {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== expectedUid || stat.nlink < 2)
    fail('directory_security');
  if (
    (privateDirectory && (stat.mode & 0o077) !== 0) ||
    (!privateDirectory && (stat.mode & 0o022) !== 0)
  )
    fail('directory_permissions');
}

function readSecureSource(path, expectedUid) {
  const lstat = lstatSync(path);
  if (
    !lstat.isFile() ||
    lstat.isSymbolicLink() ||
    lstat.uid !== expectedUid ||
    lstat.nlink !== 1 ||
    lstat.mode !== 0o100600 ||
    lstat.size > 131_072
  )
    fail('source_file_security');
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(descriptor);
    if (stat.dev !== lstat.dev || stat.ino !== lstat.ino) fail('source_file_race');
    return { contents: readFileSync(descriptor, 'utf8'), identity: `${stat.dev}:${stat.ino}` };
  } finally {
    closeSync(descriptor);
  }
}

function writeExclusive(path, contents, expectedUid, expectedGid) {
  const descriptor = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(descriptor, contents, 'utf8');
    fsyncSync(descriptor);
    chownSync(path, expectedUid, expectedGid);
    chmodSync(path, 0o600);
  } finally {
    closeSync(descriptor);
  }
}

function syncDirectory(path) {
  const descriptor = openSync(path, constants.O_RDONLY);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

export function provisionRuntimeSecrets({
  sourceDir,
  host,
  tenantKey,
  releaseId,
  targetDir = TARGET_DIR,
  backupRoot = BACKUP_ROOT,
  expectedUid = 0,
  expectedGid = expectedUid,
}) {
  if (!/^[a-f0-9]{40}-[1-9][0-9]*-[1-9][0-9]*$/u.test(releaseId)) fail('release_id');
  if (basename(targetDir) !== 'timeweb-beta' || dirname(targetDir) === '/') fail('target_dir');
  assertSecureDirectory(sourceDir, expectedUid);
  if (readdirSync(sourceDir).sort().join(',') !== [...FILES].sort().join(','))
    fail('source_file_set');

  const sources = FILES.map((name) => readSecureSource(join(sourceDir, name), expectedUid));
  if (new Set(sources.map(({ identity }) => identity)).size !== FILES.length)
    fail('source_file_identity');
  const environments = sources.map(({ contents }) => parseEnvironment(contents));
  validateRuntimeEnvironments({
    host,
    tenantKey,
    api: environments[0],
    worker: environments[1],
    realtime: environments[2],
    migrator: environments[3],
  });

  const targetParent = dirname(targetDir);
  assertSecureDirectory(targetParent, expectedUid, false);
  if (existsSync(backupRoot)) {
    assertSecureDirectory(backupRoot, expectedUid);
  } else {
    mkdirSync(backupRoot, { mode: 0o700 });
    chownSync(backupRoot, expectedUid, expectedGid);
    chmodSync(backupRoot, 0o700);
  }
  assertSecureDirectory(backupRoot, expectedUid);
  const backupDir = join(backupRoot, releaseId);
  mkdirSync(backupDir, { mode: 0o700 });
  chownSync(backupDir, expectedUid, expectedGid);
  syncDirectory(backupDir);
  syncDirectory(backupRoot);
  const previousDir = join(backupDir, 'previous');

  const incoming = join(
    targetParent,
    `.timeweb-beta.incoming-${process.pid}-${randomBytes(8).toString('hex')}`,
  );
  mkdirSync(incoming, { mode: 0o700 });
  chownSync(incoming, expectedUid, expectedGid);
  let previousMoved = false;
  try {
    for (let index = 0; index < FILES.length; index += 1)
      writeExclusive(
        join(incoming, FILES[index]),
        sources[index].contents,
        expectedUid,
        expectedGid,
      );
    syncDirectory(incoming);

    if (existsSync(targetDir)) {
      assertSecureDirectory(targetDir, expectedUid);
      renameSync(targetDir, previousDir);
      syncDirectory(backupDir);
      syncDirectory(targetParent);
      previousMoved = true;
    }
    try {
      renameSync(incoming, targetDir);
      syncDirectory(targetParent);
    } catch (error) {
      if (previousMoved && !existsSync(targetDir)) {
        renameSync(previousDir, targetDir);
        syncDirectory(targetParent);
      }
      throw error;
    }
  } finally {
    if (existsSync(incoming)) rmSync(incoming, { recursive: true });
  }
  return { previousBackedUp: previousMoved };
}

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const option = argv[index];
    const value = argv[index + 1];
    if (!option?.startsWith('--') || !value || Object.hasOwn(values, option)) fail('usage');
    values[option] = value;
  }
  const required = ['--source-dir', '--host', '--tenant-key', '--release-id'];
  if (Object.keys(values).length !== required.length || required.some((key) => !values[key]))
    fail('usage');
  return values;
}

function main() {
  if (process.getuid?.() !== 0) fail('root_required');
  const options = parseArguments(process.argv.slice(2));
  const result = provisionRuntimeSecrets({
    sourceDir: options['--source-dir'],
    host: options['--host'],
    tenantKey: options['--tenant-key'],
    releaseId: options['--release-id'],
  });
  process.stdout.write(
    `TIMEWEB_BETA_SECRET_PROVISION_PASSED|values_printed=false|previous_backed_up=${result.previousBackedUp}\n`,
  );
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(
      `TIMEWEB_BETA_SECRET_PROVISION_FAILED|reason=${error instanceof Error ? error.message : 'validation_error'}\n`,
    );
    process.exit(1);
  }
}
