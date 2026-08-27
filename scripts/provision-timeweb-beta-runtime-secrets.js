#!/usr/bin/env node

import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  chownSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fchownSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, normalize, relative, sep } from 'node:path';

import {
  assertExactTimewebFrozenSource,
  requireExactTimewebFrozenSourceAuthority,
} from './verify-timeweb-frozen-source.js';

const TARGET_DIR = '/etc/phub/timeweb-beta';
const BACKUP_ROOT = '/etc/phub/timeweb-beta-backups';
const CONTRACT_PATH = new URL(
  '../deploy/timeweb/runtime-environment.contract.json',
  import.meta.url,
);
const TARGET_CONTRACT_PATH = new URL('../deploy/timeweb/target.json', import.meta.url);
const FILE_BY_SERVICE = Object.freeze({
  api: 'api.env',
  worker: 'worker.env',
  realtime: 'realtime.env',
  migrator: 'migrator.env',
});
const FILES = Object.freeze(Object.values(FILE_BY_SERVICE));
const IDENTITY_FILE = '.release-identity.json';
const RELEASE_ID_PATTERN = /^[0-9a-f]{40}-[1-9][0-9]*-1$/u;
const MAX_SECRET_FILE_BYTES = 131_072;

export class TimewebSecretProvisionError extends Error {
  constructor(reason) {
    super(reason);
    this.name = 'TimewebSecretProvisionError';
    this.reason = reason;
  }
}

function fail(reason) {
  throw new TimewebSecretProvisionError(reason);
}

function readJson(path, reason) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    fail(reason);
  }
}

const runtimeContract = readJson(CONTRACT_PATH, 'runtime_contract_unavailable');
const targetContract = readJson(TARGET_CONTRACT_PATH, 'target_contract_unavailable');
const historicalPaths = new Set(
  targetContract.release.historicalEvidence.map(({ path }) => normalize(path)),
);

function assertAbsoluteNormalizedPath(path, reason) {
  if (
    typeof path !== 'string' ||
    !isAbsolute(path) ||
    normalize(path) !== path ||
    path.includes(`..${sep}`) ||
    path.endsWith(`${sep}..`) ||
    historicalPaths.has(path) ||
    path.split(sep).some((segment) => segment === 'staging' || segment === 'rollback')
  )
    fail(reason);
}

function assertReleaseId(releaseId, reason = 'release_identity') {
  if (typeof releaseId !== 'string' || !RELEASE_ID_PATTERN.test(releaseId)) fail(reason);
}

function assertDirectory(path, expectedUid, { mode = 0o700, allowMissing = false } = {}) {
  if (!existsSync(path)) {
    if (allowMissing) return undefined;
    fail('directory_missing');
  }
  const value = lstatSync(path);
  if (
    !value.isDirectory() ||
    value.isSymbolicLink() ||
    value.uid !== expectedUid ||
    (value.mode & 0o777) !== mode
  )
    fail('directory_security');
  return value;
}

function ensurePrivateDirectory(path, expectedUid, expectedGid) {
  if (existsSync(path)) {
    assertDirectory(path, expectedUid);
    return false;
  }
  const parent = dirname(path);
  const parentStat = lstatSync(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) fail('parent_directory_security');
  mkdirSync(path, { mode: 0o700 });
  chownSync(path, expectedUid, expectedGid);
  chmodSync(path, 0o700);
  syncDirectory(parent);
  assertDirectory(path, expectedUid);
  return true;
}

function syncDirectory(path) {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function readRegularFile(path, expectedUid, expectedMode, reason) {
  const before = lstatSync(path);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.uid !== expectedUid ||
    before.nlink !== 1 ||
    (before.mode & 0o777) !== expectedMode ||
    before.size > MAX_SECRET_FILE_BYTES
  )
    fail(reason);
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(descriptor);
    if (
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.uid !== expectedUid ||
      opened.nlink !== 1 ||
      (opened.mode & 0o777) !== expectedMode
    )
      fail(`${reason}_race`);
    return readFileSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function decodeUtf8(bytes) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    fail('invalid_encoding');
  }
}

export function parseTimewebSecretEnvironment(bytes) {
  const contents = Buffer.isBuffer(bytes) ? decodeUtf8(bytes) : bytes;
  if (typeof contents !== 'string') fail('invalid_encoding');
  if (contents.includes('\0')) fail('nul_value');
  if (contents.includes('\r')) fail('forbidden_newline');
  if (!contents.endsWith('\n') || contents.endsWith('\n\n')) fail('terminal_newline');

  const values = {};
  for (const line of contents.slice(0, -1).split('\n')) {
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(.+)$/u);
    if (!match) fail(line.includes('=') ? 'empty_value' : 'env_format');
    const [, key, value] = match;
    if (Object.hasOwn(values, key)) fail('duplicate_key');
    if (value.includes('\0') || value.includes('\n') || value.includes('\r'))
      fail('forbidden_newline');
    if (/[#$'"\\\s]/u.test(value)) fail('compose_metacharacter');
    values[key] = value;
  }
  return values;
}

function requireExactKeys(environment, service) {
  const contract = runtimeContract.services[service];
  const keys = Object.keys(environment);
  const unknown = keys.filter((key) => !contract.allowed.includes(key));
  const missing = contract.required.filter((key) => !Object.hasOwn(environment, key));
  const forbidden = contract.forbidden.filter((key) => Object.hasOwn(environment, key));
  if (unknown.length > 0) fail('unknown_key');
  if (missing.length > 0) fail('missing_key');
  if (forbidden.length > 0) fail('forbidden_key');
  for (const key of contract.requiredTrueFlags) {
    if (environment[key] !== 'true') fail('required_true_flag');
  }
  for (const key of contract.requiredFalseFlags) {
    if (environment[key] !== 'false') fail('required_false_flag');
  }
  for (const key of contract.requiredDisabledModes) {
    if (environment[key] !== 'disabled') fail('required_disabled_mode');
  }
  for (const key of contract.requiredOffModes) {
    if (environment[key] !== 'OFF') fail('required_off_mode');
  }
}

function normalizedDependency(value, key) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail('dependency_url');
  }
  const schemes = runtimeContract.dependencySchemes[key];
  if (!schemes?.includes(parsed.protocol.slice(0, -1)) || !parsed.hostname) fail('dependency_url');
  parsed.username = '';
  parsed.password = '';
  return parsed.toString();
}

function assertPrivateKey(environment, key) {
  const value = environment[key];
  if (
    typeof value !== 'string' ||
    value.length < 32 ||
    new Set(value).size < 12 ||
    /(?:replace|change|example|password|secret|test)/iu.test(value)
  )
    fail('weak_key_material');
}

export function validateTimewebRuntimeEnvironments(environments, { host, tenantKey }) {
  if (host !== targetContract.hostname) fail('host_identity');
  if (!/^[a-z0-9][a-z0-9-]{1,62}$/u.test(tenantKey)) fail('tenant_identity');

  for (const service of Object.keys(FILE_BY_SERVICE)) {
    if (!environments[service]) fail('missing_environment');
    requireExactKeys(environments[service], service);
  }

  const { api, worker, realtime, migrator } = environments;
  if (
    api.APP_ENV !== 'staging' ||
    worker.APP_ENV !== 'staging' ||
    realtime.APP_ENV !== 'staging' ||
    api.LK2_BETA_HOST !== host ||
    api.TENANT_KEY !== tenantKey ||
    worker.TENANT_KEY !== tenantKey ||
    api.AUTH_COOKIE_SECURE !== 'true' ||
    api.CORS_ORIGINS !== `https://${host}` ||
    api.TRUSTED_PROXY_CIDRS !== `${targetContract.network.ingressAddress}/32` ||
    api.CUP_DEV_AUTH_ENABLED !== 'false' ||
    api.VIVA_MODE !== 'production' ||
    api.VIVA_OAUTH_ENABLED !== 'true' ||
    api.VIVA_OAUTH_REDIRECT_URI !== `https://${host}/user/api/v1/${tenantKey}/auth/viva/callback` ||
    api.VIVA_OAUTH_SUCCESS_REDIRECT_URL !== `https://${host}/`
  )
    fail('runtime_identity');

  for (const key of ['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET', 'JWT_REALTIME_SECRET'])
    assertPrivateKey(api, key);
  assertPrivateKey(api, 'VIVA_DELEGATION_ENCRYPTION_KEY');
  if (!/^[A-Za-z0-9_-]{43}$/u.test(api.VIVA_DELEGATION_ENCRYPTION_KEY))
    fail('delegation_key_encoding');
  assertPrivateKey(realtime, 'JWT_REALTIME_SECRET');
  if (
    new Set([
      api.JWT_ACCESS_SECRET,
      api.JWT_REFRESH_SECRET,
      api.JWT_REALTIME_SECRET,
      api.VIVA_DELEGATION_ENCRYPTION_KEY,
    ]).size !== 4 ||
    realtime.JWT_REALTIME_SECRET !== api.JWT_REALTIME_SECRET
  )
    fail('signing_key_identity');

  for (const key of Object.keys(runtimeContract.dependencySchemes)) {
    const applicationTargets = [api, worker, realtime].map((environment) =>
      normalizedDependency(environment[key], key),
    );
    if (new Set(applicationTargets).size !== 1) fail('dependency_contour');
  }
  if (
    normalizedDependency(migrator.DATABASE_URL, 'DATABASE_URL') !==
    normalizedDependency(api.DATABASE_URL, 'DATABASE_URL')
  )
    fail('migration_contour');
  if (
    api.JWT_ISSUER !== worker.JWT_ISSUER ||
    api.JWT_ISSUER !== realtime.JWT_ISSUER ||
    api.JWT_AUDIENCE !== worker.JWT_AUDIENCE ||
    api.JWT_AUDIENCE !== realtime.JWT_AUDIENCE ||
    api.JWT_REALTIME_AUDIENCE !== realtime.JWT_REALTIME_AUDIENCE
  )
    fail('jwt_contour');
  if (realtime.REALTIME_EXPECTED_REPLICAS !== '1') fail('realtime_replica_identity');
  if (
    new Set([
      api.OTEL_SERVICE_INSTANCE_ID,
      worker.OTEL_SERVICE_INSTANCE_ID,
      realtime.OTEL_SERVICE_INSTANCE_ID,
    ]).size !== 3
  )
    fail('instance_identity');

  return environments;
}

function readSourceSet(sourceDir, expectedUid, host, tenantKey) {
  const directoryBefore = assertDirectory(sourceDir, expectedUid);
  const names = readdirSync(sourceDir).sort();
  if (names.join('\n') !== [...FILES].sort().join('\n')) fail('source_file_set');
  const environments = {};
  const keys = {};
  for (const [service, name] of Object.entries(FILE_BY_SERVICE)) {
    const bytes = readRegularFile(
      join(sourceDir, name),
      expectedUid,
      0o600,
      'source_file_security',
    );
    environments[service] = parseTimewebSecretEnvironment(bytes);
    keys[service] = Object.keys(environments[service]).sort();
  }
  const directoryAfter = statSync(sourceDir);
  if (directoryBefore.dev !== directoryAfter.dev || directoryBefore.ino !== directoryAfter.ino)
    fail('source_directory_race');
  validateTimewebRuntimeEnvironments(environments, { host, tenantKey });
  return { environments, keys };
}

function writeExclusive(path, contents, expectedUid, expectedGid) {
  const descriptor = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(descriptor, contents);
    fchownSync(descriptor, expectedUid, expectedGid);
    fchmodSync(descriptor, 0o600);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function readInstalledIdentity(targetDir, expectedUid) {
  const bytes = readRegularFile(
    join(targetDir, IDENTITY_FILE),
    expectedUid,
    0o600,
    'identity_file_security',
  );
  let identity;
  try {
    identity = JSON.parse(decodeUtf8(bytes));
  } catch {
    fail('identity_file_format');
  }
  if (
    Object.keys(identity).sort().join(',') !== 'releaseId,schema' ||
    identity.schema !== 'PHUB_TIMEWEB_SECRET_SET_V1'
  )
    fail('identity_file_format');
  assertReleaseId(identity.releaseId);
  return identity.releaseId;
}

function cleanupOwnedStaging(path, identity) {
  if (!existsSync(path)) return;
  const current = lstatSync(path);
  if (
    current.dev !== identity.dev ||
    current.ino !== identity.ino ||
    !current.isDirectory() ||
    !basename(path).startsWith('.timeweb-beta.incoming-')
  )
    fail('staging_identity_changed');
  rmSync(path, { recursive: true });
}

function inspectCurrentTarget(targetDir, expectedUid, expectedCurrentReleaseId) {
  if (!existsSync(targetDir)) {
    if (expectedCurrentReleaseId !== null) fail('current_release_missing');
    return { exists: false, releaseId: null, identity: null };
  }
  const identity = assertDirectory(targetDir, expectedUid);
  const targetNames = readdirSync(targetDir).sort();
  if (targetNames.join('\n') !== [...FILES, IDENTITY_FILE].sort().join('\n'))
    fail('target_file_set');
  const releaseId = readInstalledIdentity(targetDir, expectedUid);
  for (const name of FILES)
    readRegularFile(join(targetDir, name), expectedUid, 0o600, 'current_secret_file_security');
  if (expectedCurrentReleaseId === null || releaseId !== expectedCurrentReleaseId)
    fail('current_release_identity_mismatch');
  return { exists: true, releaseId, identity };
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function readProvisionLock(lockPath, expectedUid) {
  const bytes = readRegularFile(lockPath, expectedUid, 0o600, 'provision_lock_security');
  let lock;
  try {
    lock = JSON.parse(decodeUtf8(bytes));
  } catch {
    fail('provision_lock_format');
  }
  if (
    Object.keys(lock).sort().join(',') !==
      'backupDir,expectedCurrentReleaseId,incomingPath,pid,releaseId,schema' ||
    lock.schema !== 'PHUB_TIMEWEB_SECRET_PROVISION_TRANSACTION_V1' ||
    !Number.isSafeInteger(lock.pid) ||
    lock.pid < 1
  )
    fail('provision_lock_format');
  assertReleaseId(lock.releaseId);
  if (lock.expectedCurrentReleaseId !== null)
    assertReleaseId(lock.expectedCurrentReleaseId, 'provision_lock_format');
  assertAbsoluteNormalizedPath(lock.incomingPath, 'provision_lock_format');
  if (lock.backupDir !== null)
    assertAbsoluteNormalizedPath(lock.backupDir, 'provision_lock_format');
  return lock;
}

function removeExactLock(lockPath, lockIdentity, targetParent) {
  const current = lstatSync(lockPath);
  if (current.dev !== lockIdentity.dev || current.ino !== lockIdentity.ino)
    fail('provision_lock_identity');
  rmSync(lockPath);
  syncDirectory(targetParent);
}

function recoverStaleProvision(lockPath, targetDir, backupRoot, expectedUid) {
  const lockIdentity = lstatSync(lockPath);
  const lock = readProvisionLock(lockPath, expectedUid);
  if (processIsAlive(lock.pid)) fail('provision_lock_active');
  if (dirname(lock.incomingPath) !== dirname(targetDir)) fail('provision_lock_format');
  if (lock.backupDir !== null && dirname(lock.backupDir) !== backupRoot)
    fail('provision_lock_format');

  if (existsSync(targetDir)) {
    const installed = readInstalledIdentity(targetDir, expectedUid);
    if (![lock.releaseId, lock.expectedCurrentReleaseId].includes(installed))
      fail('provision_recovery_identity');
  } else if (lock.backupDir !== null && existsSync(lock.backupDir)) {
    if (readInstalledIdentity(lock.backupDir, expectedUid) !== lock.expectedCurrentReleaseId)
      fail('provision_recovery_identity');
    renameSync(lock.backupDir, targetDir);
    syncDirectory(backupRoot);
    syncDirectory(dirname(targetDir));
  } else if (lock.expectedCurrentReleaseId !== null) {
    fail('provision_recovery_missing');
  }

  if (existsSync(lock.incomingPath)) {
    const incoming = lstatSync(lock.incomingPath);
    if (
      !incoming.isDirectory() ||
      incoming.isSymbolicLink() ||
      incoming.uid !== expectedUid ||
      (incoming.mode & 0o777) !== 0o700 ||
      !basename(lock.incomingPath).startsWith('.timeweb-beta.incoming-')
    )
      fail('provision_recovery_staging');
    rmSync(lock.incomingPath, { recursive: true });
    syncDirectory(dirname(targetDir));
  }
  removeExactLock(lockPath, lockIdentity, dirname(targetDir));
}

export function provisionTimewebBetaRuntimeSecrets({
  sourceDir,
  host,
  tenantKey,
  releaseId,
  expectedSourceSha,
  expectedSourceTree,
  expectedCurrentReleaseId = null,
  targetDir = TARGET_DIR,
  backupRoot = BACKUP_ROOT,
  expectedUid = 0,
  expectedGid = expectedUid,
  dryRun = false,
  failAfter,
}) {
  const sourceAuthority = assertExactTimewebFrozenSource({
    expectedSourceSha,
    expectedSourceTree,
  });
  requireExactTimewebFrozenSourceAuthority(sourceAuthority, {
    sourceSha: expectedSourceSha,
    sourceTree: expectedSourceTree,
  });
  assertReleaseId(releaseId);
  if (!releaseId.startsWith(`${expectedSourceSha}-`)) fail('release_source_identity');
  if (expectedCurrentReleaseId !== null)
    assertReleaseId(expectedCurrentReleaseId, 'expected_current_identity');
  for (const [path, reason] of [
    [sourceDir, 'source_path'],
    [targetDir, 'target_path'],
    [backupRoot, 'backup_path'],
  ])
    assertAbsoluteNormalizedPath(path, reason);
  if (basename(targetDir) !== 'timeweb-beta' || targetDir === sourceDir) fail('target_path');
  if (relative(dirname(targetDir), backupRoot).startsWith('..')) fail('backup_path');

  const { environments, keys } = readSourceSet(sourceDir, expectedUid, host, tenantKey);
  const targetParent = dirname(targetDir);
  const lockPath = join(targetParent, '.timeweb-beta.provision.lock');
  if (dryRun && existsSync(lockPath)) fail('provision_transaction_present');
  if (!dryRun) {
    ensurePrivateDirectory(targetParent, expectedUid, expectedGid);
    ensurePrivateDirectory(backupRoot, expectedUid, expectedGid);
    if (existsSync(lockPath)) recoverStaleProvision(lockPath, targetDir, backupRoot, expectedUid);
  }
  const initialTarget = inspectCurrentTarget(targetDir, expectedUid, expectedCurrentReleaseId);
  const targetExists = initialTarget.exists;
  const currentReleaseId = initialTarget.releaseId;
  if (currentReleaseId === releaseId) fail('release_already_installed');

  const report = {
    schema: 'PHUB_TIMEWEB_SECRET_PROVISION_PLAN_V1',
    dryRun,
    releaseId,
    expectedCurrentReleaseId,
    sourceKeys: keys,
    targets: FILES.map((name) => ({ path: join(targetDir, name), mode: '0600' })),
    directories: [
      { path: dirname(targetDir), mode: '0700' },
      { path: backupRoot, mode: '0700' },
    ],
    actions: targetExists
      ? ['validate-source', 'stage-private', 'backup-exact-current', 'atomic-install', 'fsync']
      : ['validate-source', 'stage-private', 'atomic-install', 'fsync'],
  };
  if (dryRun) return report;

  const nonce = randomBytes(12).toString('hex');
  const incoming = join(targetParent, `.timeweb-beta.incoming-${process.pid}-${nonce}`);
  const backupDir = targetExists
    ? join(backupRoot, `${currentReleaseId}--replaced-by--${releaseId}`)
    : null;
  writeExclusive(
    lockPath,
    `${JSON.stringify({
      schema: 'PHUB_TIMEWEB_SECRET_PROVISION_TRANSACTION_V1',
      pid: process.pid,
      releaseId,
      expectedCurrentReleaseId,
      incomingPath: incoming,
      backupDir,
    })}\n`,
    expectedUid,
    expectedGid,
  );
  syncDirectory(targetParent);
  const lockIdentity = lstatSync(lockPath);
  let stagingIdentity;
  let previousMoved = false;
  let installed = false;
  let transactionResolved = false;
  try {
    const lockedTarget = inspectCurrentTarget(targetDir, expectedUid, expectedCurrentReleaseId);
    if (
      lockedTarget.exists !== initialTarget.exists ||
      (lockedTarget.identity &&
        initialTarget.identity &&
        (lockedTarget.identity.dev !== initialTarget.identity.dev ||
          lockedTarget.identity.ino !== initialTarget.identity.ino))
    )
      fail('current_release_changed');
    mkdirSync(incoming, { mode: 0o700 });
    chownSync(incoming, expectedUid, expectedGid);
    chmodSync(incoming, 0o700);
    stagingIdentity = lstatSync(incoming);
    for (const [service, name] of Object.entries(FILE_BY_SERVICE)) {
      const contents = `${Object.entries(environments[service])
        .map(([key, value]) => `${key}=${value}`)
        .join('\n')}\n`;
      writeExclusive(join(incoming, name), contents, expectedUid, expectedGid);
    }
    writeExclusive(
      join(incoming, IDENTITY_FILE),
      `${JSON.stringify({ schema: 'PHUB_TIMEWEB_SECRET_SET_V1', releaseId })}\n`,
      expectedUid,
      expectedGid,
    );
    syncDirectory(incoming);
    if (failAfter === 'staging') fail('injected_failure');

    if (targetExists) {
      if (existsSync(backupDir)) fail('backup_identity_exists');
      const beforeCommit = inspectCurrentTarget(targetDir, expectedUid, expectedCurrentReleaseId);
      if (
        beforeCommit.identity.dev !== initialTarget.identity.dev ||
        beforeCommit.identity.ino !== initialTarget.identity.ino
      )
        fail('current_release_changed');
      renameSync(targetDir, backupDir);
      previousMoved = true;
      syncDirectory(backupRoot);
      syncDirectory(targetParent);
    }
    if (['backup', 'recovery'].includes(failAfter)) fail('injected_failure');
    renameSync(incoming, targetDir);
    installed = true;
    if (failAfter === 'install') fail('injected_failure');
    syncDirectory(targetParent);
    transactionResolved = true;
    return { ...report, dryRun: false, previousBackedUp: previousMoved, backupDir };
  } catch (error) {
    if (installed && existsSync(targetDir)) {
      const installedIdentity = lstatSync(targetDir);
      if (
        installedIdentity.dev !== stagingIdentity.dev ||
        installedIdentity.ino !== stagingIdentity.ino
      )
        fail('installed_identity_changed');
      renameSync(targetDir, incoming);
      syncDirectory(targetParent);
      installed = false;
    }
    if (previousMoved && failAfter === 'recovery') fail('injected_recovery_failure');
    if (previousMoved && !existsSync(targetDir) && backupDir && existsSync(backupDir)) {
      renameSync(backupDir, targetDir);
      syncDirectory(backupRoot);
      syncDirectory(targetParent);
    }
    transactionResolved = true;
    if (error instanceof TimewebSecretProvisionError) throw error;
    fail('filesystem_operation');
  } finally {
    if (transactionResolved) {
      if (stagingIdentity) cleanupOwnedStaging(incoming, stagingIdentity);
      if (existsSync(lockPath)) removeExactLock(lockPath, lockIdentity, targetParent);
    }
  }
}

function parseArguments(argv) {
  const values = {};
  let dryRun = false;
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === '--dry-run') {
      if (dryRun) fail('usage');
      dryRun = true;
      continue;
    }
    const value = argv[index + 1];
    if (!option?.startsWith('--') || !value || Object.hasOwn(values, option)) fail('usage');
    values[option] = value;
    index += 1;
  }
  const allowed = new Set([
    '--source-dir',
    '--host',
    '--tenant-key',
    '--release-id',
    '--expected-source-sha',
    '--expected-source-tree',
    '--expected-current-release-id',
  ]);
  if (Object.keys(values).some((key) => !allowed.has(key))) fail('usage');
  for (const key of [
    '--source-dir',
    '--host',
    '--tenant-key',
    '--release-id',
    '--expected-source-sha',
    '--expected-source-tree',
  ]) {
    if (!values[key]) fail('usage');
  }
  return { values, dryRun };
}

function main() {
  if (process.getuid?.() !== 0) fail('root_required');
  const { values, dryRun } = parseArguments(process.argv.slice(2));
  const result = provisionTimewebBetaRuntimeSecrets({
    sourceDir: values['--source-dir'],
    host: values['--host'],
    tenantKey: values['--tenant-key'],
    releaseId: values['--release-id'],
    expectedSourceSha: values['--expected-source-sha'],
    expectedSourceTree: values['--expected-source-tree'],
    expectedCurrentReleaseId: values['--expected-current-release-id'] ?? null,
    dryRun,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try {
    main();
  } catch (error) {
    const reason = error instanceof TimewebSecretProvisionError ? error.reason : 'validation_error';
    process.stderr.write(`TIMEWEB_BETA_SECRET_PROVISION_FAILED|reason=${reason}\n`);
    process.exitCode = 1;
  }
}
