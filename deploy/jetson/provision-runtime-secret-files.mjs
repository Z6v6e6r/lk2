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
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = 1;
const FILES = Object.freeze({
  staging: 'staging.env',
  realtime: 'realtime.env',
  marker: '.runtime-secret-isolation.transition.json',
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
const ADDED_KEYS = Object.freeze([
  'JWT_REALTIME_SECRET',
  'COMMUNITIES_REALTIME_ENABLED',
  'REALTIME_EXPECTED_REPLICAS',
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
  for (const key of ADDED_KEYS) {
    if (values.has(key)) fail(`staging.env already contains ${key}`);
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
  return {
    staging: `${source}JWT_REALTIME_SECRET=${secret}\nCOMMUNITIES_REALTIME_ENABLED=false\n`,
    realtime: `${realtimeLines.join('\n')}\n`,
  };
}

function validateState(state) {
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
    for (const field of [
      'runtimeSnapshot',
      'activeComposeSha256',
      'candidateComposeSha256',
      'activeRelease',
    ]) {
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
  const secret = candidateSecret(stagingText);
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
  const allowed = new Set([...REALTIME_KEYS, ...ADDED_KEYS]);
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
      staging: { uid: 0, gid: Number(deployGid), mode: 0o640 },
      deployUid: Number(deployUid),
      deployGid: Number(deployGid),
      attestation: Object.fromEntries(
        attestationKeys.map((key, index) => [key, attestationValues[index]]),
      ),
    });
  } else if (mode === 'verify-prepared') result = verifyPrepared(directory);
  else if (mode === 'recover-marker') result = recoverMarker(directory);
  else if (mode === 'advance-phase') result = advancePhase(directory, args[0], args[1]);
  else if (mode === 'restore-files') result = restoreFiles(directory);
  else if (mode === 'complete-rollback') result = completeRollback(directory);
  else if (mode === 'finalize') result = finalize(directory, args[0]);
  else if (mode === 'read-field') {
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
