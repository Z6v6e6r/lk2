#!/usr/bin/env node

import {
  closeSync,
  constants,
  fchmodSync,
  fchownSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = 1;
const BOOTSTRAP_VERSION = 2;
const FILES = Object.freeze({
  staging: 'staging.env',
  realtime: 'realtime.env',
  marker: '.runtime-secret-isolation.transition.json',
  bootstrapReceipt: '.runtime-secret-bootstrap.finalized.json',
  backup: '.runtime-secret-isolation.staging.backup',
  stagingNext: '.runtime-secret-isolation.staging.next',
  realtimeNext: '.runtime-secret-isolation.realtime.next',
});
const PHASES = new Set([
  'initial',
  'prepared',
  'compose-committed',
  'runtime-stopped',
  'realtime-ready',
  'api-ready',
  'worker-ready',
  'verified',
  'finalizing',
  'files-restoring',
  'files-restored',
  'runtime-restored',
]);
const PHASE_TRANSITIONS = new Map([
  ['prepared', 'compose-committed'],
  ['compose-committed', 'runtime-stopped'],
  ['runtime-stopped', 'realtime-ready'],
  ['realtime-ready', 'api-ready'],
  ['api-ready', 'worker-ready'],
  ['worker-ready', 'verified'],
  ['files-restored', 'runtime-restored'],
]);
const BOOTSTRAP_PHASES = new Set([
  'initial',
  'files-prepared',
  'images-probed',
  'runtime-stopping',
  'runtime-stopped',
  'compose-committed',
  'release-committed',
  'realtime-ready',
  'api-ready',
  'worker-ready',
  'web-ready',
  'verified',
  'finalizing',
  'files-restoring',
  'files-restored',
  'runtime-restored',
  'finalized',
]);
const BOOTSTRAP_PHASE_TRANSITIONS = new Map([
  ['files-prepared', 'images-probed'],
  ['images-probed', 'runtime-stopping'],
  ['runtime-stopping', 'runtime-stopped'],
  ['runtime-stopped', 'compose-committed'],
  ['compose-committed', 'release-committed'],
  ['release-committed', 'realtime-ready'],
  ['realtime-ready', 'api-ready'],
  ['api-ready', 'worker-ready'],
  ['worker-ready', 'web-ready'],
  ['web-ready', 'verified'],
  ['files-restored', 'runtime-restored'],
]);
const BOOTSTRAP_SERVICES = Object.freeze(['api', 'worker', 'realtime', 'web']);
const BOOTSTRAP_IMAGES = Object.freeze([...BOOTSTRAP_SERVICES, 'migrator']);

export const REALTIME_KEYS = Object.freeze([
  'APP_ENV',
  'LOG_LEVEL',
  'REALTIME_HOST',
  'REALTIME_PORT',
  'DATABASE_URL',
  'REDIS_URL',
  'RABBITMQ_URL',
  'JWT_ISSUER',
  'JWT_AUDIENCE',
  'JWT_REALTIME_AUDIENCE',
  'OTEL_EXPORTER_OTLP_ENDPOINT',
  'OTEL_SERVICE_NAMESPACE',
  'OTEL_SERVICE_INSTANCE_ID',
  'REALTIME_DATABASE_POOL_MAX',
  'REALTIME_DATABASE_POOL_WARM_CONNECTIONS',
  'REALTIME_MAX_CONNECTIONS',
  'REALTIME_MAX_SUBSCRIPTIONS_PER_CONNECTION',
  'REALTIME_MAX_SOCKET_BUFFER_BYTES',
  'REALTIME_HEARTBEAT_INTERVAL_MS',
]);
const REQUIRED_REALTIME_KEYS = Object.freeze([
  'DATABASE_URL',
  'REDIS_URL',
  'RABBITMQ_URL',
  'JWT_ISSUER',
  'JWT_AUDIENCE',
  'JWT_REALTIME_AUDIENCE',
]);
const APPLICATION_DISABLED_KEYS = Object.freeze([
  'PROFILE_PHOTO_CLIENT_SYNC_ENABLED',
  'COMMUNITY_INVITES_ENABLED',
  'COMMUNITIES_REALTIME_ENABLED',
  'COMMUNITY_MEDIA_ENABLED',
  'COMMUNITY_LOGO_STABLE_DELIVERY_ENABLED',
  'COMMUNITY_LOGO_COMPATIBILITY_BACKFILL_ENABLED',
]);
const STAGING_RESERVED_KEYS = Object.freeze(['JWT_REALTIME_SECRET', 'REALTIME_EXPECTED_REPLICAS']);
const REALTIME_ADDED_KEYS = Object.freeze([
  'JWT_REALTIME_SECRET',
  'COMMUNITIES_REALTIME_ENABLED',
  'REALTIME_EXPECTED_REPLICAS',
]);
const REVIEWED_REALTIME_ANCHOR = 'x-realtime-runtime: &realtime-runtime';
const REVIEWED_REALTIME_ENV_PATH =
  '    - path: ${REALTIME_RUNTIME_ENV_FILE:-/etc/phub/realtime.env}';
const LEGACY_REALTIME_MERGE = '    <<: *runtime';
const REVIEWED_REALTIME_MERGE = '    <<: *realtime-runtime';
const GENERATED_REALTIME_ENV = Object.freeze([
  '    env_file:',
  '      - path: ${REALTIME_RUNTIME_ENV_FILE:-/etc/phub/realtime.env}',
]);

function fail(message) {
  throw new Error(`runtime secret provisioning refused: ${message}`);
}

function exists(path) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return false;
    throw error;
  }
}

function metadata(path) {
  const stat = lstatSync(path, { bigint: true });
  return {
    dev: stat.dev.toString(),
    ino: stat.ino.toString(),
    size: stat.size.toString(),
    mtimeNs: stat.mtimeNs.toString(),
    uid: Number(stat.uid),
    gid: Number(stat.gid),
    mode: Number(stat.mode & 0o777n),
    nlink: Number(stat.nlink),
    regular: stat.isFile(),
    directory: stat.isDirectory(),
    symlink: stat.isSymbolicLink(),
  };
}

function syncPath(path) {
  const descriptor = openSync(path, constants.O_RDONLY);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function safeDirectory(path, expected) {
  const value = metadata(path);
  if (!value.directory || value.symlink) fail('target directory is unsafe');
  if (value.uid !== expected.uid || value.gid !== expected.gid || value.mode !== expected.mode) {
    fail('target directory ownership or mode differs');
  }
  return value;
}

function safeFile(path, expected) {
  const value = metadata(path);
  if (!value.regular || value.symlink || value.nlink !== (expected.nlink ?? 1)) {
    fail(`${basename(path)} is not a single-link regular file`);
  }
  if (value.uid !== expected.uid || value.gid !== expected.gid || value.mode !== expected.mode) {
    fail(`${basename(path)} ownership or mode differs`);
  }
  return value;
}

function sameFile(path, recorded) {
  if (!exists(path)) return false;
  const actual = metadata(path);
  return (
    actual.regular &&
    !actual.symlink &&
    actual.dev === recorded.dev &&
    actual.ino === recorded.ino &&
    actual.size === recorded.size &&
    actual.mtimeNs === recorded.mtimeNs &&
    actual.uid === recorded.uid &&
    actual.gid === recorded.gid &&
    actual.mode === recorded.mode
  );
}

function writeExclusive(path, content, uid, gid) {
  const descriptor = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    0o600,
  );
  try {
    writeFileSync(descriptor, content, 'utf8');
    fchmodSync(descriptor, 0o600);
    fchownSync(descriptor, uid, gid);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function writeExclusiveForCurrentOwner(path, content, uid, gid) {
  const descriptor = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    0o600,
  );
  try {
    writeFileSync(descriptor, content, 'utf8');
    fchmodSync(descriptor, 0o600);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  const value = metadata(path);
  if (value.uid !== uid || value.gid !== gid || value.mode !== 0o600) {
    fail('generated Compose ownership or mode differs');
  }
}

function parseEnvironment(source) {
  const values = new Map();
  const lines = new Map();
  for (const line of source.split('\n')) {
    if (!line || /^\s*#/.test(line)) continue;
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!match) fail('staging.env contains a malformed non-comment line');
    if (values.has(match[1])) fail(`staging.env contains duplicate key ${match[1]}`);
    values.set(match[1], match[2]);
    lines.set(match[1], line);
  }
  return { values, lines };
}

function validateSecret(secret) {
  if (!/^[A-Za-z0-9+/]{64}$/.test(secret)) fail('realtime secret is not canonical base64');
  const decoded = Buffer.from(secret, 'base64');
  if (decoded.length !== 48 || decoded.toString('base64') !== secret) {
    fail('realtime secret is not exactly 48 bytes');
  }
}

function buildCandidates(source, secret) {
  const { values, lines } = parseEnvironment(source);
  if (!source.endsWith('\n')) fail('staging.env must end with a newline');
  if (values.get('APP_ENV') !== 'staging') fail('staging.env APP_ENV must be staging');
  for (const key of STAGING_RESERVED_KEYS) {
    if (values.has(key)) fail(`staging.env already contains ${key}`);
  }
  for (const key of APPLICATION_DISABLED_KEYS) {
    if (values.has(key) && values.get(key) !== 'false') {
      fail(`staging.env must omit ${key} or set it to false`);
    }
  }
  for (const key of REQUIRED_REALTIME_KEYS) {
    if (!values.get(key)) fail(`staging.env is missing required realtime key ${key}`);
  }
  validateSecret(secret);
  for (const key of ['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET']) {
    if (values.get(key) === secret) fail(`generated secret duplicates ${key}`);
  }
  const realtimeLines = REALTIME_KEYS.filter((key) => lines.has(key)).map((key) => lines.get(key));
  realtimeLines.push(
    `JWT_REALTIME_SECRET=${secret}`,
    'COMMUNITIES_REALTIME_ENABLED=false',
    'REALTIME_EXPECTED_REPLICAS=1',
  );
  const missingDisabledLines = APPLICATION_DISABLED_KEYS.filter((key) => !values.has(key)).map(
    (key) => `${key}=false`,
  );
  const stagingLines = [`JWT_REALTIME_SECRET=${secret}`, ...missingDisabledLines];
  return {
    staging: `${source}${stagingLines.join('\n')}\n`,
    realtime: `${realtimeLines.join('\n')}\n`,
  };
}

function isSha256(value) {
  return /^[0-9a-f]{64}$/.test(value ?? '');
}

function isCommit(value) {
  return /^[0-9a-f]{40}$/.test(value ?? '');
}

function isImageId(value) {
  return /^sha256:[0-9a-f]{64}$/.test(value ?? '');
}

function isImageRef(value) {
  return /^ghcr\.io\/[A-Za-z0-9._/-]+@sha256:[0-9a-f]{64}$/.test(value ?? '');
}

function isContainerId(value) {
  return /^[0-9a-f]{12,64}$/.test(value ?? '');
}

function isSafeAbsolutePath(value, root) {
  if (typeof value !== 'string' || !value.startsWith(`${root}/`)) return false;
  return !value.includes('/../') && /^[A-Za-z0-9._/-]+$/.test(value);
}

function validateBootstrapImageMap(images, services) {
  if (!images || typeof images !== 'object') return false;
  return services.every(
    (service) => isImageId(images[service]?.id) && isImageRef(images[service]?.ref),
  );
}

function validateBootstrapState(state) {
  const hashes = state?.hashes ?? {};
  const requiredHashes = [
    hashes.runtimeSnapshot,
    hashes.activeCompose,
    hashes.candidateCompose,
    hashes.activeReleaseEnv,
    hashes.candidateReleaseEnv,
    hashes.infrastructureCompose,
    hashes.activeMigrationManifest,
    hashes.candidateMigrationManifest,
    hashes.applicationBackup,
  ];
  const oldContainers = state?.oldContainers ?? {};
  const runtimeContainersValid = BOOTSTRAP_SERVICES.every(
    (service) =>
      isContainerId(oldContainers[service]?.id) &&
      typeof oldContainers[service]?.startedAt === 'string' &&
      oldContainers[service].startedAt.length >= 20 &&
      oldContainers[service].startedAt.length <= 64,
  );
  const infrastructureContainers = state?.infrastructureContainers ?? {};
  const valid =
    state?.version === BOOTSTRAP_VERSION &&
    state.operation === 'legacy-runtime-secret-bootstrap' &&
    BOOTSTRAP_PHASES.has(state.phase) &&
    requiredHashes.every(isSha256) &&
    hashes.activeMigrationManifest === hashes.candidateMigrationManifest &&
    [
      state.expectedActiveRelease,
      state.candidateRelease,
      state.controlCommit,
      state.controlTree,
      state.candidateTree,
    ].every(isCommit) &&
    /^\d+$/.test(state.workflowRunId ?? '') &&
    /^\d+$/.test(state.workflowRunAttempt ?? '') &&
    /^\d+:\d+:\d+:\d+$/.test(state.infrastructureIdentity ?? '') &&
    isSafeAbsolutePath(state.backupPath, '/opt/phub/backups/releases') &&
    isSafeAbsolutePath(state.bundlePath, '/opt/phub/b0-candidates') &&
    validateBootstrapImageMap(state.oldImages, BOOTSTRAP_SERVICES) &&
    validateBootstrapImageMap(state.candidateImages, BOOTSTRAP_IMAGES) &&
    runtimeContainersValid &&
    isContainerId(infrastructureContainers.nginxId) &&
    isContainerId(infrastructureContainers.caddyId) &&
    Number.isSafeInteger(state.deployUid) &&
    Number.isSafeInteger(state.deployGid) &&
    (state.phase === 'finalized'
      ? isSha256(state.finalSnapshot)
      : state.finalSnapshot === undefined);
  if (!valid) fail('bootstrap marker has an unknown schema or phase');
  return state;
}

function exactLineIndexes(lines, expected) {
  return lines.flatMap((line, index) => (line === expected ? [index] : []));
}

function topLevelBlock(lines, header) {
  const starts = exactLineIndexes(lines, header);
  if (starts.length !== 1) fail(`reviewed Compose must contain exactly one ${header} block`);
  const start = starts[0];
  const next = lines.findIndex(
    (line, index) => index > start && /^[A-Za-z0-9][A-Za-z0-9_-]*:/.test(line),
  );
  return { start, end: next === -1 ? lines.length : next };
}

function serviceBlock(lines, service) {
  const header = `  ${service}:`;
  const starts = exactLineIndexes(lines, header);
  if (starts.length !== 1) fail(`Compose must contain exactly one services.${service} block`);
  const start = starts[0];
  const next = lines.findIndex(
    (line, index) =>
      index > start && /^\x20{2}[A-Za-z0-9][A-Za-z0-9_-]*:$/.test(line) && line !== header,
  );
  return { start, end: next === -1 ? lines.length : next };
}

function isServiceMappingKey(line, key) {
  if (!line.startsWith('    ') || line.startsWith('     ')) return false;
  const value = line.slice(4);
  if (key === 'env_file') return /^(?:env_file|'env_file'|"env_file")\s*:/.test(value);
  if (key === 'merge') return /^(?:<<|'<<'|"<<")\s*:/.test(value);
  fail('unknown scoped Compose key');
}

export function buildRuntimeSecretComposeCandidate(activeSource, reviewedSource) {
  for (const [name, source] of [
    ['active', activeSource],
    ['reviewed', reviewedSource],
  ]) {
    if (!source.endsWith('\n')) fail(`${name} Compose must end with a newline`);
    if (source.includes('\t')) fail(`${name} Compose must not contain tabs`);
  }

  const reviewedLines = reviewedSource.split('\n');
  const reviewedAnchor = topLevelBlock(reviewedLines, REVIEWED_REALTIME_ANCHOR);
  const reviewedAnchorLines = reviewedLines.slice(reviewedAnchor.start, reviewedAnchor.end);
  if (exactLineIndexes(reviewedAnchorLines, REVIEWED_REALTIME_ENV_PATH).length !== 1) {
    fail('reviewed Compose realtime anchor must contain the isolated env path exactly once');
  }
  const reviewedRealtime = serviceBlock(reviewedLines, 'realtime');
  const reviewedRealtimeLines = reviewedLines.slice(reviewedRealtime.start, reviewedRealtime.end);
  const reviewedMergeLines = reviewedRealtimeLines.filter((line) =>
    isServiceMappingKey(line, 'merge'),
  );
  if (reviewedMergeLines.length !== 1 || reviewedMergeLines[0] !== REVIEWED_REALTIME_MERGE) {
    fail('reviewed Compose realtime service must use the isolated runtime anchor exactly once');
  }

  const activeLines = activeSource.split('\n');
  if (activeLines.some((line) => line.includes('REALTIME_RUNTIME_ENV_FILE'))) {
    fail('active Compose already contains the isolated realtime env variable');
  }
  const activeRealtime = serviceBlock(activeLines, 'realtime');
  const activeRealtimeLines = activeLines.slice(activeRealtime.start, activeRealtime.end);
  if (activeRealtimeLines.some((line) => isServiceMappingKey(line, 'env_file'))) {
    fail('active Compose realtime service already contains env_file');
  }
  const mergeIndexes = activeRealtimeLines.flatMap((line, index) =>
    isServiceMappingKey(line, 'merge') ? [index] : [],
  );
  if (mergeIndexes.length !== 1 || activeRealtimeLines[mergeIndexes[0]] !== LEGACY_REALTIME_MERGE) {
    fail('active Compose realtime service must use the legacy runtime anchor exactly once');
  }
  const insertionIndex = activeRealtime.start + mergeIndexes[0] + 1;
  const candidateLines = [
    ...activeLines.slice(0, insertionIndex),
    ...GENERATED_REALTIME_ENV,
    ...activeLines.slice(insertionIndex),
  ];
  return candidateLines.join('\n');
}

export function buildRuntimeSecretComposeCandidateFile(
  activePathInput,
  reviewedPathInput,
  outputPathInput,
  uid,
  gid,
) {
  const activePath = resolve(activePathInput);
  const reviewedPath = resolve(reviewedPathInput);
  const outputPath = resolve(outputPathInput);
  const outputDirectory = dirname(outputPath);
  if (dirname(reviewedPath) !== outputDirectory) {
    fail('generated Compose must share the reviewed tool directory');
  }
  if (basename(outputPath) !== `${basename(reviewedPath)}.runtime-secret-generated`) {
    fail('generated Compose filename is not bound to the reviewed input');
  }
  if (!Number.isSafeInteger(uid) || uid <= 0 || !Number.isSafeInteger(gid) || gid <= 0) {
    fail('generated Compose ownership is invalid');
  }
  for (const path of [activePath, reviewedPath]) {
    const value = metadata(path);
    if (!value.regular || value.symlink || value.nlink !== 1) {
      fail(`${basename(path)} is not a single-link regular file`);
    }
  }
  const directoryValue = metadata(outputDirectory);
  if (!directoryValue.directory || directoryValue.symlink) {
    fail('reviewed tool directory is unsafe');
  }
  if (exists(outputPath)) fail('generated Compose already exists');
  const candidate = buildRuntimeSecretComposeCandidate(
    readFileSync(activePath, 'utf8'),
    readFileSync(reviewedPath, 'utf8'),
  );
  writeExclusiveForCurrentOwner(outputPath, candidate, uid, gid);
  syncPath(outputDirectory);
  return { status: 'compose-generated' };
}

function validateState(state) {
  if (state?.version === BOOTSTRAP_VERSION) return validateBootstrapState(state);
  const hashes = [
    state.runtimeSnapshot,
    state.activeComposeSha256,
    state.candidateComposeSha256,
    state.releaseEnvSha256,
    state.infrastructureComposeSha256,
  ];
  const ids = [state.oldApiImageId, state.oldWorkerImageId, state.oldRealtimeImageId];
  const refs = [state.oldApiImageRef, state.oldWorkerImageRef, state.oldRealtimeImageRef];
  if (
    state?.version !== VERSION ||
    state.operation !== 'runtime-secret-isolation' ||
    !PHASES.has(state.phase) ||
    hashes.some((value) => !/^[0-9a-f]{64}$/.test(value ?? '')) ||
    ids.some((value) => !/^sha256:[0-9a-f]{64}$/.test(value ?? '')) ||
    refs.some((value) => !/^ghcr\.io\/[A-Za-z0-9._/-]+@sha256:[0-9a-f]{64}$/.test(value ?? '')) ||
    !/^[0-9a-f]{40}$/.test(state.activeRelease ?? '') ||
    !/^\d+:\d+:\d+:\d+$/.test(state.infrastructureIdentity ?? '') ||
    !/^[0-9a-f]{12,64}$/.test(state.oldWebId ?? '') ||
    !/^[0-9a-f]{12,64}$/.test(state.oldNginxId ?? '') ||
    !Number.isSafeInteger(state.deployUid) ||
    !Number.isSafeInteger(state.deployGid)
  ) {
    fail('transition marker has an unknown schema or phase');
  }
  return state;
}

function readStateFile(path) {
  const file = safeFile(path, { uid: metadata(path).uid, gid: metadata(path).gid, mode: 0o600 });
  let state;
  try {
    state = validateState(JSON.parse(readFileSync(path, 'utf8')));
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith('runtime secret provisioning refused:')
    ) {
      throw error;
    }
    fail('transition marker is malformed');
  }
  if (file.uid !== state.deployUid || file.gid !== state.deployGid) {
    fail('transition marker ownership differs from recorded deployment identity');
  }
  return state;
}

function replaceMarker(directory, state, failpoint) {
  const marker = join(directory, FILES.marker);
  const next = `${marker}.next`;
  if (exists(next)) fail('marker next file already exists');
  writeExclusive(next, `${JSON.stringify(state)}\n`, state.deployUid, state.deployGid);
  if (failpoint === 'marker-next') throw new Error('injected failure after marker-next');
  renameSync(next, marker);
  syncPath(directory);
}

export function recoverMarker(directoryInput) {
  const directory = resolve(directoryInput);
  const marker = join(directory, FILES.marker);
  const next = `${marker}.next`;
  if (!exists(next)) return { status: 'marker-current' };
  const nextState = readStateFile(next);
  if (exists(marker)) {
    const current = readStateFile(marker);
    if (current.version !== nextState.version || current.operation !== nextState.operation) {
      fail('marker next belongs to another transition');
    }
    const fields =
      current.version === BOOTSTRAP_VERSION
        ? ['workflowRunId', 'workflowRunAttempt', 'candidateRelease', 'controlCommit']
        : ['runtimeSnapshot', 'activeComposeSha256', 'candidateComposeSha256', 'activeRelease'];
    for (const field of fields) {
      if (current[field] !== nextState[field]) fail('marker next belongs to another transition');
    }
  }
  renameSync(next, marker);
  syncPath(directory);
  return { status: 'marker-recovered' };
}

function loadState(directory) {
  recoverMarker(directory);
  return readStateFile(join(directory, FILES.marker));
}

function candidateSecret(stagingText) {
  const secret = parseEnvironment(stagingText).values.get('JWT_REALTIME_SECRET') ?? '';
  validateSecret(secret);
  return secret;
}

function verifyCandidatePair(directory, state, requireBackup = true) {
  const staging = join(directory, FILES.staging);
  const realtime = join(directory, FILES.realtime);
  if (
    !sameFile(staging, state.candidate.staging) ||
    !sameFile(realtime, state.candidate.realtime)
  ) {
    fail('candidate file identity or metadata changed');
  }
  const stagingText = readFileSync(staging, 'utf8');
  const realtimeText = readFileSync(realtime, 'utf8');
  const stagingValues = parseEnvironment(stagingText).values;
  const secret = candidateSecret(stagingText);
  for (const key of APPLICATION_DISABLED_KEYS) {
    if (stagingValues.get(key) !== 'false') fail(`candidate staging flag ${key} is unsafe`);
  }
  if (parseEnvironment(realtimeText).values.get('JWT_REALTIME_SECRET') !== secret) {
    fail('API and realtime candidate secrets differ');
  }
  if (requireBackup) {
    const backup = join(directory, FILES.backup);
    if (!sameFile(backup, state.original)) fail('staging backup identity changed');
    const expected = buildCandidates(readFileSync(backup, 'utf8'), secret);
    if (stagingText !== expected.staging || realtimeText !== expected.realtime) {
      fail('candidate content differs from the reviewed transformation');
    }
  }
  const realtimeValues = parseEnvironment(realtimeText).values;
  const allowed = new Set([...REALTIME_KEYS, ...REALTIME_ADDED_KEYS]);
  for (const key of realtimeValues.keys()) {
    if (!allowed.has(key)) fail(`realtime.env contains forbidden key ${key}`);
  }
  if (
    realtimeValues.get('COMMUNITIES_REALTIME_ENABLED') !== 'false' ||
    realtimeValues.get('REALTIME_EXPECTED_REPLICAS') !== '1'
  ) {
    fail('candidate realtime flags are unsafe');
  }
}

function validatePartialCandidate(source, path, kind, state) {
  safeFile(path, { uid: state.deployUid, gid: state.deployGid, mode: 0o600 });
  const text = readFileSync(path, 'utf8');
  const secret = candidateSecret(text);
  const expected = buildCandidates(source, secret)[kind];
  if (text !== expected) fail(`${basename(path)} differs from the reviewed transformation`);
}

export function prepare(directoryInput, options) {
  const directory = resolve(directoryInput);
  if (directory === '/') fail('target directory cannot be root');
  const paths = Object.fromEntries(
    Object.entries(FILES).map(([key, name]) => [key, join(directory, name)]),
  );
  const directoryMetadata = safeDirectory(directory, options.directory);
  const original = safeFile(paths.staging, options.staging);
  for (const path of [
    paths.realtime,
    paths.marker,
    `${paths.marker}.next`,
    paths.backup,
    paths.stagingNext,
    paths.realtimeNext,
  ]) {
    if (exists(path)) fail(`${basename(path)} already exists`);
  }
  const source = readFileSync(paths.staging, 'utf8');
  const secret = (options.randomBytes ?? randomBytes)(48).toString('base64');
  const candidates = buildCandidates(source, secret);
  const state = validateState({
    version: VERSION,
    operation: 'runtime-secret-isolation',
    phase: 'initial',
    ...options.attestation,
    deployUid: options.deployUid,
    deployGid: options.deployGid,
    directory: { dev: directoryMetadata.dev, ino: directoryMetadata.ino },
    original,
  });
  replaceMarker(directory, state, options.failAfter === 'initial-marker-next' ? 'marker-next' : '');
  linkSync(paths.staging, paths.backup);
  syncPath(directory);
  if (options.failAfter === 'backup') throw new Error('injected failure after backup');
  writeExclusive(paths.stagingNext, candidates.staging, options.deployUid, options.deployGid);
  writeExclusive(paths.realtimeNext, candidates.realtime, options.deployUid, options.deployGid);
  renameSync(paths.realtimeNext, paths.realtime);
  syncPath(directory);
  if (options.failAfter === 'realtime') throw new Error('injected failure after realtime');
  renameSync(paths.stagingNext, paths.staging);
  syncPath(directory);
  state.candidate = { staging: metadata(paths.staging), realtime: metadata(paths.realtime) };
  state.phase = 'prepared';
  replaceMarker(directory, state);
  verifyPrepared(directory);
  return { status: 'prepared' };
}

export function verifyPrepared(directoryInput) {
  const directory = resolve(directoryInput);
  const state = loadState(directory);
  if (!state.candidate) fail('transition marker lacks candidate metadata');
  const currentDirectory = metadata(directory);
  if (
    currentDirectory.dev !== state.directory.dev ||
    currentDirectory.ino !== state.directory.ino
  ) {
    fail('target directory identity changed');
  }
  verifyCandidatePair(directory, state, !['finalizing'].includes(state.phase));
  if (exists(join(directory, FILES.stagingNext)) || exists(join(directory, FILES.realtimeNext))) {
    fail('candidate next file remains');
  }
  return { status: state.phase };
}

export function advancePhase(directoryInput, expected, next, options = {}) {
  const directory = resolve(directoryInput);
  const state = loadState(directory);
  if (state.phase !== expected || PHASE_TRANSITIONS.get(expected) !== next) {
    fail(`invalid transition phase advance ${state.phase} -> ${next}`);
  }
  state.phase = next;
  replaceMarker(directory, state, options.failAfter === 'marker-next' ? 'marker-next' : '');
  return { status: next };
}

export function restoreFiles(directoryInput, options = {}) {
  const directory = resolve(directoryInput);
  const state = loadState(directory);
  const paths = Object.fromEntries(
    Object.entries(FILES).map(([key, name]) => [key, join(directory, name)]),
  );
  if (['verified', 'finalizing'].includes(state.phase)) fail('verified transition must finalize');
  if (state.phase === 'files-restored' || state.phase === 'runtime-restored') {
    if (!sameFile(paths.staging, state.original)) fail('original staging identity changed');
    if (exists(paths.realtime) || exists(paths.backup)) fail('rollback files are not converged');
    return { status: state.phase };
  }
  if (state.phase !== 'files-restoring') {
    if (state.phase !== 'initial') verifyCandidatePair(directory, state);
    state.restoreFromPhase = state.phase;
    state.phase = 'files-restoring';
    replaceMarker(directory, state);
  }
  const sourcePath = exists(paths.backup) ? paths.backup : paths.staging;
  if (!sameFile(sourcePath, state.original)) fail('original staging identity changed');
  const source = readFileSync(sourcePath, 'utf8');
  const stagingIsOriginal = sameFile(paths.staging, state.original);
  if (!stagingIsOriginal && exists(paths.staging)) {
    validatePartialCandidate(source, paths.staging, 'staging', state);
  }
  if (exists(paths.stagingNext)) {
    validatePartialCandidate(source, paths.stagingNext, 'staging', state);
  }
  for (const realtimePath of [paths.realtime, paths.realtimeNext]) {
    if (exists(realtimePath)) validatePartialCandidate(source, realtimePath, 'realtime', state);
  }
  for (const path of [paths.realtime, paths.realtimeNext, paths.stagingNext]) {
    if (exists(path)) rmSync(path);
  }
  syncPath(directory);
  if (options.failAfter === 'realtime-removed') {
    throw new Error('injected failure after realtime-removed');
  }
  if (exists(paths.backup)) {
    if (!sameFile(paths.backup, state.original)) fail('staging backup identity changed');
    if (stagingIsOriginal) rmSync(paths.backup);
    else {
      if (exists(paths.staging)) rmSync(paths.staging);
      renameSync(paths.backup, paths.staging);
    }
    syncPath(directory);
  } else if (!sameFile(paths.staging, state.original)) {
    fail('original staging file is absent after restoration');
  }
  state.phase = 'files-restored';
  replaceMarker(directory, state);
  return { status: 'files-restored' };
}

export function completeRollback(directoryInput) {
  const directory = resolve(directoryInput);
  const state = loadState(directory);
  if (state.phase !== 'runtime-restored') fail('runtime rollback is not attested');
  if (!sameFile(join(directory, FILES.staging), state.original)) {
    fail('original staging metadata changed');
  }
  if (exists(join(directory, FILES.realtime))) fail('realtime.env remains after rollback');
  rmSync(join(directory, FILES.marker));
  syncPath(directory);
  return { status: 'rolled-back' };
}

export function finalize(directoryInput, finalSnapshot, options = {}) {
  const directory = resolve(directoryInput);
  const state = loadState(directory);
  if (!['verified', 'finalizing'].includes(state.phase)) fail('transition is not verified');
  if (!/^[0-9a-f]{64}$/.test(finalSnapshot ?? '')) fail('final snapshot must be sha256');
  if (finalSnapshot === state.runtimeSnapshot) fail('serving snapshot did not change');
  if (state.phase === 'verified') {
    verifyCandidatePair(directory, state);
    state.phase = 'finalizing';
    replaceMarker(directory, state);
  } else {
    verifyCandidatePair(directory, state, false);
  }
  const backup = join(directory, FILES.backup);
  if (exists(backup)) {
    if (!sameFile(backup, state.original)) fail('staging backup identity changed');
    rmSync(backup);
    syncPath(directory);
  }
  if (options.failAfter === 'backup-removed') {
    throw new Error('injected failure after backup-removed');
  }
  rmSync(join(directory, FILES.marker));
  syncPath(directory);
  return { status: 'finalized' };
}

function loadBootstrapState(directory) {
  const state = loadState(directory);
  if (
    state.version !== BOOTSTRAP_VERSION ||
    state.operation !== 'legacy-runtime-secret-bootstrap'
  ) {
    fail('transition marker is not a legacy bootstrap');
  }
  return state;
}

function loadBootstrapReceipt(directory) {
  const path = join(directory, FILES.bootstrapReceipt);
  const state = readStateFile(path);
  if (
    state.version !== BOOTSTRAP_VERSION ||
    state.operation !== 'legacy-runtime-secret-bootstrap' ||
    state.phase !== 'finalized'
  ) {
    fail('bootstrap finalized receipt is invalid');
  }
  return state;
}

export function prepareBootstrap(directoryInput, options) {
  const directory = resolve(directoryInput);
  if (directory === '/') fail('target directory cannot be root');
  const paths = Object.fromEntries(
    Object.entries(FILES).map(([key, name]) => [key, join(directory, name)]),
  );
  const directoryMetadata = safeDirectory(directory, options.directory);
  const original = safeFile(paths.staging, options.staging);
  for (const path of [
    paths.realtime,
    paths.marker,
    `${paths.marker}.next`,
    paths.backup,
    paths.stagingNext,
    paths.realtimeNext,
  ]) {
    if (exists(path)) fail(`${basename(path)} already exists`);
  }
  const source = readFileSync(paths.staging, 'utf8');
  const secret = (options.randomBytes ?? randomBytes)(48).toString('base64');
  const candidates = buildCandidates(source, secret);
  const state = validateBootstrapState({
    version: BOOTSTRAP_VERSION,
    operation: 'legacy-runtime-secret-bootstrap',
    phase: 'initial',
    ...options.attestation,
    deployUid: options.deployUid,
    deployGid: options.deployGid,
    directory: { dev: directoryMetadata.dev, ino: directoryMetadata.ino },
    original,
  });
  replaceMarker(directory, state, options.failAfter === 'initial-marker-next' ? 'marker-next' : '');
  linkSync(paths.staging, paths.backup);
  syncPath(directory);
  if (options.failAfter === 'backup') throw new Error('injected failure after backup');
  writeExclusive(paths.stagingNext, candidates.staging, options.deployUid, options.deployGid);
  writeExclusive(paths.realtimeNext, candidates.realtime, options.deployUid, options.deployGid);
  renameSync(paths.realtimeNext, paths.realtime);
  syncPath(directory);
  if (options.failAfter === 'realtime') throw new Error('injected failure after realtime');
  renameSync(paths.stagingNext, paths.staging);
  syncPath(directory);
  state.candidate = { staging: metadata(paths.staging), realtime: metadata(paths.realtime) };
  state.phase = 'files-prepared';
  replaceMarker(directory, state);
  verifyBootstrapPrepared(directory);
  return { status: 'files-prepared' };
}

export function verifyBootstrapPrepared(directoryInput) {
  const directory = resolve(directoryInput);
  const state = loadBootstrapState(directory);
  if (!state.candidate) fail('bootstrap marker lacks candidate metadata');
  const currentDirectory = metadata(directory);
  if (
    currentDirectory.dev !== state.directory.dev ||
    currentDirectory.ino !== state.directory.ino
  ) {
    fail('target directory identity changed');
  }
  verifyCandidatePair(directory, state, state.phase !== 'finalizing');
  if (exists(join(directory, FILES.stagingNext)) || exists(join(directory, FILES.realtimeNext))) {
    fail('candidate next file remains');
  }
  return { status: state.phase };
}

export function advanceBootstrapPhase(directoryInput, expected, next, options = {}) {
  const directory = resolve(directoryInput);
  const state = loadBootstrapState(directory);
  if (state.phase !== expected || BOOTSTRAP_PHASE_TRANSITIONS.get(expected) !== next) {
    fail(`invalid bootstrap phase advance ${state.phase} -> ${next}`);
  }
  state.phase = next;
  replaceMarker(directory, state, options.failAfter === 'marker-next' ? 'marker-next' : '');
  return { status: next };
}

export function restoreBootstrapFiles(directoryInput, options = {}) {
  const directory = resolve(directoryInput);
  const state = loadBootstrapState(directory);
  const paths = Object.fromEntries(
    Object.entries(FILES).map(([key, name]) => [key, join(directory, name)]),
  );
  if (['verified', 'finalizing'].includes(state.phase)) {
    fail('verified bootstrap must finalize forward');
  }
  if (state.phase === 'files-restored' || state.phase === 'runtime-restored') {
    if (!sameFile(paths.staging, state.original)) fail('original staging identity changed');
    if (exists(paths.realtime) || exists(paths.backup)) fail('rollback files are not converged');
    return { status: state.phase };
  }
  if (state.phase !== 'files-restoring') {
    if (state.phase !== 'initial') verifyCandidatePair(directory, state);
    state.restoreFromPhase = state.phase;
    state.phase = 'files-restoring';
    replaceMarker(directory, state);
  }
  const sourcePath = exists(paths.backup) ? paths.backup : paths.staging;
  if (!sameFile(sourcePath, state.original)) fail('original staging identity changed');
  const source = readFileSync(sourcePath, 'utf8');
  const stagingIsOriginal = sameFile(paths.staging, state.original);
  if (!stagingIsOriginal && exists(paths.staging)) {
    validatePartialCandidate(source, paths.staging, 'staging', state);
  }
  if (exists(paths.stagingNext)) {
    validatePartialCandidate(source, paths.stagingNext, 'staging', state);
  }
  for (const realtimePath of [paths.realtime, paths.realtimeNext]) {
    if (exists(realtimePath)) validatePartialCandidate(source, realtimePath, 'realtime', state);
  }
  for (const path of [paths.realtime, paths.realtimeNext, paths.stagingNext]) {
    if (exists(path)) rmSync(path);
  }
  syncPath(directory);
  if (options.failAfter === 'realtime-removed') {
    throw new Error('injected failure after realtime-removed');
  }
  if (exists(paths.backup)) {
    if (!sameFile(paths.backup, state.original)) fail('staging backup identity changed');
    if (stagingIsOriginal) rmSync(paths.backup);
    else {
      if (exists(paths.staging)) rmSync(paths.staging);
      renameSync(paths.backup, paths.staging);
    }
    syncPath(directory);
  } else if (!sameFile(paths.staging, state.original)) {
    fail('original staging file is absent after restoration');
  }
  state.phase = 'files-restored';
  replaceMarker(directory, state);
  return { status: 'files-restored' };
}

export function completeBootstrapRollback(directoryInput) {
  const directory = resolve(directoryInput);
  const state = loadBootstrapState(directory);
  if (state.phase !== 'runtime-restored') fail('bootstrap runtime rollback is not attested');
  if (!sameFile(join(directory, FILES.staging), state.original)) {
    fail('original staging metadata changed');
  }
  if (exists(join(directory, FILES.realtime))) fail('realtime.env remains after rollback');
  rmSync(join(directory, FILES.marker));
  syncPath(directory);
  return { status: 'rolled-back' };
}

export function finalizeBootstrap(directoryInput, finalSnapshot, options = {}) {
  const directory = resolve(directoryInput);
  const receipt = join(directory, FILES.bootstrapReceipt);
  const marker = join(directory, FILES.marker);
  if (exists(receipt)) {
    if (exists(marker)) fail('bootstrap marker and finalized receipt coexist');
    const finalized = loadBootstrapReceipt(directory);
    if (finalized.finalSnapshot !== finalSnapshot) fail('finalized bootstrap snapshot differs');
    verifyCandidatePair(directory, finalized, false);
    return { status: 'already-finalized' };
  }
  const state = loadBootstrapState(directory);
  if (!['verified', 'finalizing', 'finalized'].includes(state.phase)) {
    fail('bootstrap is not verified');
  }
  if (!isSha256(finalSnapshot)) fail('final snapshot must be sha256');
  if (finalSnapshot === state.hashes.runtimeSnapshot) fail('serving snapshot did not change');
  if (state.phase === 'finalized' && state.finalSnapshot !== finalSnapshot) {
    fail('finalized bootstrap snapshot differs');
  }
  if (state.phase === 'verified') {
    verifyCandidatePair(directory, state);
    state.phase = 'finalizing';
    replaceMarker(directory, state);
  } else if (state.phase === 'finalizing') {
    verifyCandidatePair(directory, state, false);
  }
  const backup = join(directory, FILES.backup);
  if (exists(backup)) {
    if (!sameFile(backup, state.original)) fail('staging backup identity changed');
    rmSync(backup);
    syncPath(directory);
  }
  if (options.failAfter === 'backup-removed') {
    throw new Error('injected failure after backup-removed');
  }
  if (state.phase !== 'finalized') {
    state.phase = 'finalized';
    state.finalSnapshot = finalSnapshot;
    replaceMarker(directory, state, options.failAfter === 'final-marker-next' ? 'marker-next' : '');
  }
  if (options.failAfter === 'final-marker') {
    throw new Error('injected failure after final-marker');
  }
  renameSync(marker, receipt);
  syncPath(directory);
  if (options.failAfter === 'receipt-renamed') {
    throw new Error('injected failure after receipt-renamed');
  }
  return { status: 'finalized' };
}

export function verifyBootstrapFinalized(directoryInput) {
  const directory = resolve(directoryInput);
  if (exists(join(directory, FILES.marker))) fail('bootstrap marker remains after finalization');
  const state = loadBootstrapReceipt(directory);
  verifyCandidatePair(directory, state, false);
  return { status: 'finalized' };
}

export function readBootstrapField(directoryInput, field) {
  const allowed = new Set([
    'phase',
    'restoreFromPhase',
    'expectedActiveRelease',
    'candidateRelease',
    'controlCommit',
    'controlTree',
    'candidateTree',
    'workflowRunId',
    'workflowRunAttempt',
    'backupPath',
    'bundlePath',
    'infrastructureIdentity',
    'hashes.runtimeSnapshot',
    'hashes.activeCompose',
    'hashes.candidateCompose',
    'hashes.activeReleaseEnv',
    'hashes.candidateReleaseEnv',
    'hashes.infrastructureCompose',
    'hashes.activeMigrationManifest',
    'hashes.candidateMigrationManifest',
    'hashes.applicationBackup',
    ...BOOTSTRAP_SERVICES.flatMap((service) => [
      `oldImages.${service}.id`,
      `oldImages.${service}.ref`,
      `oldContainers.${service}.id`,
      `oldContainers.${service}.startedAt`,
    ]),
    ...BOOTSTRAP_IMAGES.flatMap((service) => [
      `candidateImages.${service}.id`,
      `candidateImages.${service}.ref`,
    ]),
    'infrastructureContainers.nginxId',
    'infrastructureContainers.caddyId',
  ]);
  if (!allowed.has(field)) fail('requested bootstrap marker field is not readable');
  const value = field
    .split('.')
    .reduce((current, segment) => current?.[segment], loadBootstrapState(resolve(directoryInput)));
  if (typeof value !== 'string') fail('requested bootstrap marker field is unavailable');
  return value;
}

export function readBootstrapFinalizedField(directoryInput, field) {
  const directory = resolve(directoryInput);
  const state = loadBootstrapReceipt(directory);
  const allowed = new Set([
    'finalSnapshot',
    'expectedActiveRelease',
    'candidateRelease',
    'controlCommit',
    'workflowRunId',
    'workflowRunAttempt',
    'bundlePath',
    'hashes.candidateCompose',
    'hashes.candidateReleaseEnv',
    'hashes.infrastructureCompose',
    ...BOOTSTRAP_SERVICES.flatMap((service) => [
      `candidateImages.${service}.id`,
      `candidateImages.${service}.ref`,
    ]),
    'infrastructureIdentity',
    'infrastructureContainers.nginxId',
    'infrastructureContainers.caddyId',
  ]);
  if (!allowed.has(field)) fail('requested finalized bootstrap field is not readable');
  const value = field.split('.').reduce((current, segment) => current?.[segment], state);
  if (typeof value !== 'string') fail('requested finalized bootstrap field is unavailable');
  return value;
}

export function readField(directoryInput, field) {
  const allowed = new Set([
    'phase',
    'restoreFromPhase',
    'runtimeSnapshot',
    'activeComposeSha256',
    'candidateComposeSha256',
    'activeRelease',
    'releaseEnvSha256',
    'infrastructureIdentity',
    'infrastructureComposeSha256',
    'oldApiImageId',
    'oldApiImageRef',
    'oldWorkerImageId',
    'oldWorkerImageRef',
    'oldRealtimeImageId',
    'oldRealtimeImageRef',
    'oldWebId',
    'oldNginxId',
  ]);
  if (!allowed.has(field)) fail('requested marker field is not readable');
  return String(loadState(resolve(directoryInput))[field]);
}

function cli() {
  const [mode, directory, ...args] = process.argv.slice(2);
  if (!mode || !directory) fail('mode and directory are required');
  let result;
  if (mode === 'prepare') {
    const [deployUid, deployGid, ...attestationValues] = args;
    const attestationKeys = [
      'runtimeSnapshot',
      'activeComposeSha256',
      'candidateComposeSha256',
      'activeRelease',
      'releaseEnvSha256',
      'infrastructureIdentity',
      'infrastructureComposeSha256',
      'oldApiImageId',
      'oldApiImageRef',
      'oldWorkerImageId',
      'oldWorkerImageRef',
      'oldRealtimeImageId',
      'oldRealtimeImageRef',
      'oldWebId',
      'oldNginxId',
    ];
    if (attestationValues.length !== attestationKeys.length)
      fail('prepare attestation is incomplete');
    result = prepare(directory, {
      directory: { uid: 0, gid: Number(deployGid), mode: 0o750 },
      staging: { uid: Number(deployUid), gid: Number(deployGid), mode: 0o600 },
      deployUid: Number(deployUid),
      deployGid: Number(deployGid),
      attestation: Object.fromEntries(
        attestationKeys.map((key, index) => [key, attestationValues[index]]),
      ),
    });
  } else if (mode === 'prepare-bootstrap' || mode === 'prepare-bootstrap-json') {
    const [deployUid, deployGid, encodedAttestation] = args;
    if (!/^\d+$/.test(deployUid ?? '') || !/^\d+$/.test(deployGid ?? '')) {
      fail('bootstrap deployment identity is malformed');
    }
    let attestation;
    try {
      let source;
      if (mode === 'prepare-bootstrap-json') {
        if (!/^\/bundle\/[A-Za-z0-9._-]+\.json$/.test(encodedAttestation ?? '')) {
          fail('bootstrap attestation path is unsafe');
        }
        safeFile(encodedAttestation, {
          uid: Number(deployUid),
          gid: Number(deployGid),
          mode: 0o600,
        });
        source = readFileSync(encodedAttestation, 'utf8');
      } else {
        source = Buffer.from(encodedAttestation ?? '', 'base64').toString('utf8');
        if (Buffer.from(source, 'utf8').toString('base64') !== encodedAttestation) {
          fail('bootstrap attestation is not canonical base64');
        }
      }
      attestation = JSON.parse(source);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.startsWith('runtime secret provisioning refused:')
      ) {
        throw error;
      }
      fail('bootstrap attestation is malformed');
    }
    result = prepareBootstrap(directory, {
      directory: { uid: 0, gid: Number(deployGid), mode: 0o750 },
      staging: { uid: 0, gid: Number(deployGid), mode: 0o640 },
      deployUid: Number(deployUid),
      deployGid: Number(deployGid),
      attestation,
    });
  } else if (mode === 'verify-prepared') result = verifyPrepared(directory);
  else if (mode === 'build-compose') {
    const [activePath, reviewedPath, outputPath, deployUid, deployGid] = args;
    result = buildRuntimeSecretComposeCandidateFile(
      activePath,
      reviewedPath,
      outputPath,
      Number(deployUid),
      Number(deployGid),
    );
  } else if (mode === 'verify-bootstrap-prepared') result = verifyBootstrapPrepared(directory);
  else if (mode === 'recover-marker') result = recoverMarker(directory);
  else if (mode === 'advance-phase') result = advancePhase(directory, args[0], args[1]);
  else if (mode === 'advance-bootstrap-phase') {
    result = advanceBootstrapPhase(directory, args[0], args[1]);
  } else if (mode === 'restore-files') result = restoreFiles(directory);
  else if (mode === 'restore-bootstrap-files') result = restoreBootstrapFiles(directory);
  else if (mode === 'complete-rollback') result = completeRollback(directory);
  else if (mode === 'complete-bootstrap-rollback') result = completeBootstrapRollback(directory);
  else if (mode === 'finalize') result = finalize(directory, args[0]);
  else if (mode === 'finalize-bootstrap') result = finalizeBootstrap(directory, args[0]);
  else if (mode === 'verify-bootstrap-finalized') result = verifyBootstrapFinalized(directory);
  else if (mode === 'read-bootstrap-finalized-field') {
    const field = args[0];
    const value = readBootstrapFinalizedField(directory, field);
    process.stdout.write(`runtime-secret-transition field=${field} value=${value} status=passed\n`);
    return;
  } else if (mode === 'read-bootstrap-field') {
    const field = args[0];
    const value = readBootstrapField(directory, field);
    process.stdout.write(`runtime-secret-transition field=${field} value=${value} status=passed\n`);
    return;
  } else if (mode === 'read-field') {
    const field = args[0];
    const value = readField(directory, field);
    process.stdout.write(`runtime-secret-transition field=${field} value=${value} status=passed\n`);
    return;
  } else fail('unknown helper mode');
  process.stdout.write(
    `runtime-secret-transition operation=${mode} result=${result.status} status=passed\n`,
  );
}

if (
  process.argv[1] === '-' ||
  resolve(process.argv[1] ?? '') === resolve(fileURLToPath(import.meta.url))
) {
  try {
    cli();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
