#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  constants,
  chmodSync,
  chownSync,
  closeSync,
  copyFileSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseStrictJson } from './strict-json.js';
import {
  validateApplicationCompose,
  validateIngressCompose,
  validateRuntimeContract,
  validateTargetContract,
  validateYandexPublicBetaCaddyfile,
  validateYandexPublicBetaIngressContract,
} from './verify-timeweb-deployment-contract.js';
import {
  assertExactTimewebFrozenSource,
  requireExactTimewebFrozenSourceAuthority,
} from './verify-timeweb-frozen-source.js';

const REPOSITORY_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const DOCKER = '/usr/bin/docker';
const CURL = '/usr/bin/curl';
const CADDY_IMAGE_REFERENCE =
  'caddy@sha256:5f5c8640aae01df9654968d946d8f1a56c497f1dd5c5cda4cf95ab7c14d58648';
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const SHA = /^[0-9a-f]{40}$/u;
const RECEIPT_SCHEMA = 'PHUB_TIMEWEB_YANDEX_PUBLIC_ROLLBACK_RECEIPT_V1';
const REPOSITORIES = Object.freeze({
  api: 'ghcr.io/z6v6e6r/phub-api',
  web: 'ghcr.io/z6v6e6r/phub-web',
  realtime: 'ghcr.io/z6v6e6r/phub-realtime',
  worker: 'ghcr.io/z6v6e6r/phub-worker',
  migrator: 'ghcr.io/z6v6e6r/phub-migrator',
});

function canonicalRuntimeRoot() {
  return validateRuntimeContract(
    parseStrictJson(
      readFileSync(
        resolve(REPOSITORY_ROOT, 'deploy/timeweb/runtime-environment.contract.json'),
        'utf8',
      ),
    ),
  ).rootOnlyDirectory;
}

export class TimewebYandexPublicBetaControlError extends Error {
  constructor(code) {
    super(code);
    this.name = 'TimewebYandexPublicBetaControlError';
    this.code = code;
  }
}

function fail(code) {
  throw new TimewebYandexPublicBetaControlError(code);
}

function object(value, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(code);
  return value;
}

function exactKeys(value, keys, code) {
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) fail(code);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function imageReference(component, digest) {
  if (!Object.hasOwn(REPOSITORIES, component) || !DIGEST.test(digest)) fail('image_identity');
  return `${REPOSITORIES[component]}@${digest}`;
}

function isImageReference(component, value) {
  if (typeof value !== 'string') return false;
  const prefix = `${REPOSITORIES[component]}@`;
  return value.startsWith(prefix) && DIGEST.test(value.slice(prefix.length));
}

function safeAbsolutePath(candidate, prefixes, code) {
  if (typeof candidate !== 'string' || !isAbsolute(candidate)) fail(code);
  const normalized = resolve(candidate);
  if (normalized !== candidate || !prefixes.some((prefix) => normalized.startsWith(prefix)))
    fail(code);
  return normalized;
}

function secureRegularFile(
  path,
  { maxMode = 0o600, expectedMode, expectedUid = 0, expectedLinks = 1 } = {},
) {
  const stat = lstatSync(path);
  const mode = stat.mode & 0o777;
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.uid !== expectedUid ||
    stat.nlink !== expectedLinks ||
    (expectedMode === undefined ? (mode & ~maxMode) !== 0 : mode !== expectedMode)
  )
    fail('file_security');
  return stat;
}

function secureDirectory(path, expectedUid = 0) {
  const stat = lstatSync(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== expectedUid ||
    (stat.mode & 0o077) !== 0
  )
    fail('directory_security');
}

function writeExclusive(path, contents, mode = 0o600) {
  secureDirectory(dirname(path));
  const fd = openSync(path, 'wx', mode);
  try {
    writeFileSync(fd, contents);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(path, mode);
  chownSync(path, 0, 0);
}

function runDocker(args, options = {}) {
  const { raw = false, ...execOptions } = options;
  try {
    const output = execFileSync(DOCKER, args, {
      encoding: 'utf8',
      env: {
        PATH: '/usr/bin:/bin',
        HOME: '/root',
        DOCKER_HOST: 'unix:///var/run/docker.sock',
        DOCKER_CONFIG: '/root/.docker',
        COMPOSE_PROFILES: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      ...execOptions,
    });
    return raw ? output : output.trim();
  } catch {
    fail('docker_operation');
  }
}

function runCurl(args) {
  try {
    return execFileSync(CURL, args, {
      encoding: 'utf8',
      env: { PATH: '/usr/bin:/bin', HOME: '/root' },
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    fail('ingress_smoke');
  }
}

export function validateRollbackFloor(input, target) {
  const floor = object(input, 'rollback_floor');
  exactKeys(
    floor,
    [
      'schema',
      'hostname',
      'canonicalPublication',
      'authorizesPublication',
      'failedPublicationRunProvenance',
      'sourceSha',
      'sourceTree',
      'runtimeEnvRoot',
      'images',
    ],
    'rollback_floor_keys',
  );
  if (
    floor.schema !== 'PHUB_TIMEWEB_YANDEX_PUBLIC_ROLLBACK_FLOOR_V1' ||
    floor.hostname !== target.hostname ||
    floor.canonicalPublication !== false ||
    floor.authorizesPublication !== false ||
    floor.failedPublicationRunProvenance !== '33168712014' ||
    !SHA.test(floor.sourceSha) ||
    !SHA.test(floor.sourceTree) ||
    floor.runtimeEnvRoot !== '/etc/phub/timeweb-beta-fast'
  )
    fail('rollback_floor_identity');
  const images = object(floor.images, 'rollback_floor_images');
  exactKeys(images, Object.keys(REPOSITORIES), 'rollback_floor_components');
  for (const [component, repository] of Object.entries(REPOSITORIES)) {
    const image = object(images[component], 'rollback_floor_image');
    const keys =
      component === 'api' || component === 'web'
        ? ['indexDigest', 'runtimeDigest']
        : ['indexDigest'];
    exactKeys(image, keys, 'rollback_floor_image_keys');
    if (
      !DIGEST.test(image.indexDigest) ||
      ('runtimeDigest' in image && !DIGEST.test(image.runtimeDigest))
    )
      fail('rollback_floor_digest');
    if (imageReference(component, image.indexDigest) !== `${repository}@${image.indexDigest}`)
      fail('rollback_floor_repository');
  }
  return floor;
}

function readRepositoryContracts() {
  const target = validateTargetContract(
    parseStrictJson(readFileSync(resolve(REPOSITORY_ROOT, 'deploy/timeweb/target.json'), 'utf8')),
  );
  const publicIngress = validateYandexPublicBetaIngressContract(
    parseStrictJson(
      readFileSync(
        resolve(REPOSITORY_ROOT, 'deploy/timeweb/yandex-public-beta-ingress.json'),
        'utf8',
      ),
    ),
    target,
  );
  const publicCaddyPath = resolve(REPOSITORY_ROOT, publicIngress.caddyfile);
  const publicCaddyBytes = readFileSync(publicCaddyPath);
  validateYandexPublicBetaCaddyfile(publicCaddyBytes.toString('utf8'), target);
  const floor = validateRollbackFloor(
    parseStrictJson(
      readFileSync(
        resolve(REPOSITORY_ROOT, 'deploy/timeweb/yandex-public-beta-rollback-floor.json'),
        'utf8',
      ),
    ),
    target,
  );
  return { target, publicIngress, publicCaddyPath, publicCaddyBytes, floor };
}

function containerId(service, project = 'phub-timeweb-beta') {
  const ids = runDocker([
    'ps',
    '--filter',
    `label=com.docker.compose.project=${project}`,
    '--filter',
    `label=com.docker.compose.service=${service}`,
    '--format',
    '{{.ID}}',
  ])
    .split('\n')
    .filter(Boolean);
  if (ids.length !== 1) fail('container_identity');
  return ids[0];
}

function assertContainerImage(service, expectedReference, project) {
  const id = containerId(service, project);
  const actual = runDocker(['inspect', '--format', '{{.Config.Image}}', id]);
  if (actual !== expectedReference) fail('container_image_identity');
  return id;
}

function assertHealthyContainer(service, expectedReference, expectedReleaseId) {
  const id = assertContainerImage(service, expectedReference);
  const health = runDocker([
    'inspect',
    '--format',
    '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}',
    id,
  ]);
  const releaseId = runDocker([
    'inspect',
    '--format',
    '{{ index .Config.Labels "phub.release-id" }}',
    id,
  ]);
  validateCandidateContainerAttestation(
    { image: expectedReference, health, releaseId },
    { image: expectedReference, releaseId: expectedReleaseId },
  );
  return id;
}

export function validateCandidateContainerAttestation(actual, expected) {
  const attestation = object(actual, 'candidate_container_attestation');
  const authority = object(expected, 'candidate_container_authority');
  exactKeys(attestation, ['image', 'health', 'releaseId'], 'candidate_container_attestation');
  exactKeys(authority, ['image', 'releaseId'], 'candidate_container_authority');
  if (
    typeof authority.image !== 'string' ||
    typeof authority.releaseId !== 'string' ||
    attestation.image !== authority.image ||
    attestation.health !== 'healthy' ||
    attestation.releaseId !== authority.releaseId
  )
    fail('candidate_container_attestation');
  return attestation;
}

function assertLocalImage(reference) {
  let repoDigests;
  try {
    repoDigests = JSON.parse(
      runDocker(['image', 'inspect', '--format', '{{json .RepoDigests}}', reference]),
    );
  } catch {
    fail('local_image_identity');
  }
  if (!Array.isArray(repoDigests) || !repoDigests.includes(reference)) fail('local_image_identity');
}

export function validateOperationInput(input) {
  const value = object(input, 'operation_input');
  exactKeys(
    value,
    [
      'activeCaddyfile',
      'applicationCompose',
      'ingressCompose',
      'backupCaddyfile',
      'receipt',
      'rollbackEnv',
      'candidateSourceSha',
      'candidateSourceTree',
      'candidateReleaseId',
      'candidateRuntimeEnvRoot',
      'candidateReleaseEnv',
    ],
    'operation_input_keys',
  );
  for (const key of [
    'activeCaddyfile',
    'applicationCompose',
    'ingressCompose',
    'backupCaddyfile',
    'receipt',
    'rollbackEnv',
  ])
    safeAbsolutePath(value[key], ['/opt/phub/timeweb-beta/'], 'operation_path');
  if (value.activeCaddyfile !== join(dirname(value.ingressCompose), 'Caddyfile'))
    fail('ingress_caddy_mount_identity');
  if (value.candidateRuntimeEnvRoot !== canonicalRuntimeRoot()) fail('runtime_path');
  if (!SHA.test(value.candidateSourceSha) || !SHA.test(value.candidateSourceTree))
    fail('candidate_source');
  if (
    typeof value.candidateReleaseId !== 'string' ||
    !new RegExp(`^${value.candidateSourceSha}-[0-9]{11,20}-1$`, 'u').test(value.candidateReleaseId)
  )
    fail('candidate_release_identity');
  if (
    safeAbsolutePath(
      value.candidateReleaseEnv,
      ['/opt/phub/timeweb-beta/releases/'],
      'release_env_path',
    ) !== value.candidateReleaseEnv ||
    value.candidateReleaseEnv !==
      `/opt/phub/timeweb-beta/releases/${value.candidateReleaseId}/release.env`
  )
    fail('candidate_release_env_identity');
  return value;
}

const RELEASE_ENV_KEYS = Object.freeze([
  'PHUB_TIMEWEB_RELEASE_ENV_SCHEMA',
  'REGISTRY',
  'PHUB_RELEASE_ID',
  'PHUB_RELEASE_SOURCE_SHA',
  'PHUB_RELEASE_SOURCE_TREE',
  'PHUB_PUBLICATION_WORKFLOW_SHA',
  'PHUB_PUBLICATION_RUN_ID',
  'PHUB_PUBLICATION_RUN_ATTEMPT',
  'PHUB_CANONICAL_MANIFEST_SHA256',
  'PHUB_CANONICAL_RUN_EVIDENCE_SHA256',
  'PHUB_CANONICAL_ARTIFACT_ID',
  'PHUB_CANONICAL_ARTIFACT_NAME',
  'PHUB_CANONICAL_ARTIFACT_DIGEST',
  'TIMEWEB_RUNTIME_ENV_ROOT',
  'PHUB_API_RUNTIME_ENV_FILE',
  'PHUB_WORKER_RUNTIME_ENV_FILE',
  'PHUB_REALTIME_RUNTIME_ENV_FILE',
  'PHUB_MIGRATOR_RUNTIME_ENV_FILE',
  'PHUB_WORKER_ENABLED',
  'PHUB_MIGRATOR_ENABLED',
  'COMPOSE_PROFILES',
  'PHUB_ROLLBACK_PREVIOUS_RELEASE_ID',
  'PHUB_ROLLBACK_MODE',
  'WEB_IMAGE_DIGEST',
  'WEB_RUNTIME_DIGEST',
  'API_IMAGE_DIGEST',
  'API_RUNTIME_DIGEST',
  'WORKER_IMAGE_DIGEST',
  'WORKER_RUNTIME_DIGEST',
  'REALTIME_IMAGE_DIGEST',
  'REALTIME_RUNTIME_DIGEST',
  'MIGRATOR_IMAGE_DIGEST',
  'MIGRATOR_RUNTIME_DIGEST',
]);

export function validateCandidateReleaseEnvironment(bytes, operation) {
  const text = bytes.toString('utf8');
  if (!text.endsWith('\n') || /\r|\0/u.test(text)) fail('release_env_format');
  const values = Object.create(null);
  for (const line of text.slice(0, -1).split('\n')) {
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/u);
    if (!match || Object.hasOwn(values, match[1])) fail('release_env_format');
    values[match[1]] = match[2];
  }
  exactKeys(values, RELEASE_ENV_KEYS, 'release_env_keys');
  const runId = operation.candidateReleaseId.slice(operation.candidateSourceSha.length + 1, -2);
  if (
    values.PHUB_TIMEWEB_RELEASE_ENV_SCHEMA !== 'PHUB_TIMEWEB_RELEASE_ENV_V1' ||
    values.REGISTRY !== 'ghcr.io/z6v6e6r' ||
    values.PHUB_RELEASE_ID !== operation.candidateReleaseId ||
    values.PHUB_RELEASE_SOURCE_SHA !== operation.candidateSourceSha ||
    values.PHUB_RELEASE_SOURCE_TREE !== operation.candidateSourceTree ||
    values.PHUB_PUBLICATION_WORKFLOW_SHA !== operation.candidateSourceSha ||
    values.PHUB_PUBLICATION_RUN_ID !== runId ||
    values.PHUB_PUBLICATION_RUN_ATTEMPT !== '1' ||
    !/^[1-9][0-9]*$/u.test(values.PHUB_CANONICAL_ARTIFACT_ID) ||
    values.PHUB_CANONICAL_ARTIFACT_NAME !==
      `timeweb-amd64-canonical-release-${operation.candidateSourceSha}-${runId}-1` ||
    values.TIMEWEB_RUNTIME_ENV_ROOT !== operation.candidateRuntimeEnvRoot ||
    values.PHUB_WORKER_ENABLED !== 'false' ||
    values.PHUB_MIGRATOR_ENABLED !== 'false' ||
    values.COMPOSE_PROFILES !== '' ||
    values.PHUB_ROLLBACK_PREVIOUS_RELEASE_ID !== 'NONE' ||
    values.PHUB_ROLLBACK_MODE !== 'stop-candidate-no-previous-release'
  )
    fail('release_env_identity');
  for (const [component, prefix] of [
    ['web', 'WEB'],
    ['api', 'API'],
    ['worker', 'WORKER'],
    ['realtime', 'REALTIME'],
    ['migrator', 'MIGRATOR'],
  ]) {
    if (
      !DIGEST.test(values[`${prefix}_IMAGE_DIGEST`]) ||
      !DIGEST.test(values[`${prefix}_RUNTIME_DIGEST`]) ||
      imageReference(component, values[`${prefix}_IMAGE_DIGEST`]) !==
        `${REPOSITORIES[component]}@${values[`${prefix}_IMAGE_DIGEST`]}`
    )
      fail('release_env_image_identity');
  }
  for (const key of ['PHUB_CANONICAL_MANIFEST_SHA256', 'PHUB_CANONICAL_RUN_EVIDENCE_SHA256'])
    if (!/^[0-9a-f]{64}$/u.test(values[key])) fail('release_env_custody');
  if (!/^sha256:[0-9a-f]{64}$/u.test(values.PHUB_CANONICAL_ARTIFACT_DIGEST))
    fail('release_env_custody');
  for (const [service, path] of [
    ['api', values.PHUB_API_RUNTIME_ENV_FILE],
    ['worker', values.PHUB_WORKER_RUNTIME_ENV_FILE],
    ['realtime', values.PHUB_REALTIME_RUNTIME_ENV_FILE],
    ['migrator', values.PHUB_MIGRATOR_RUNTIME_ENV_FILE],
  ])
    if (path !== `${operation.candidateRuntimeEnvRoot}/${service}.env`)
      fail('release_env_runtime_path');
  return values;
}

function rollbackEnvironment(floor) {
  return `${[
    `PHUB_RELEASE_ID=${floor.sourceSha}-ROLLBACK-FLOOR`,
    `TIMEWEB_RUNTIME_ENV_ROOT=${floor.runtimeEnvRoot}`,
    ...Object.keys(REPOSITORIES).map(
      (component) =>
        `${component.toUpperCase()}_IMAGE_DIGEST=${floor.images[component].indexDigest}`,
    ),
  ].join('\n')}\n`;
}

export function validateReceipt(input) {
  const receipt = object(input, 'receipt');
  exactKeys(
    receipt,
    [
      'schema',
      'status',
      'hostname',
      'floorSourceSha',
      'floorSourceTree',
      'candidateSourceSha',
      'candidateSourceTree',
      'candidateReleaseId',
      'candidateRuntimeEnvRoot',
      'candidateReleaseEnv',
      'candidateReleaseEnvSha256',
      'priorApiReference',
      'priorWebReference',
      'candidateApiReference',
      'candidateWebReference',
      'activeCaddyfile',
      'activeCaddySha256',
      'activeCaddyAdaptedSha256',
      'backupCaddyfile',
      'backupCaddySha256',
      'publicCaddyfile',
      'publicCaddySha256',
      'publicCaddyAdaptedSha256',
      'applicationCompose',
      'ingressCompose',
      'rollbackEnv',
      'preparedAt',
      'complete',
    ],
    'receipt_keys',
  );
  if (
    receipt.schema !== RECEIPT_SCHEMA ||
    receipt.status !== 'PREPARED' ||
    receipt.hostname !== 'lk2.padlhub.su' ||
    receipt.complete !== true ||
    !SHA.test(receipt.floorSourceSha) ||
    !SHA.test(receipt.floorSourceTree) ||
    !SHA.test(receipt.candidateSourceSha) ||
    !SHA.test(receipt.candidateSourceTree) ||
    typeof receipt.candidateReleaseId !== 'string' ||
    !new RegExp(`^${receipt.candidateSourceSha}-[0-9]{11,20}-1$`, 'u').test(
      receipt.candidateReleaseId,
    ) ||
    receipt.candidateRuntimeEnvRoot !== canonicalRuntimeRoot() ||
    receipt.candidateReleaseEnv !==
      `/opt/phub/timeweb-beta/releases/${receipt.candidateReleaseId}/release.env` ||
    receipt.activeCaddyfile !== join(dirname(receipt.ingressCompose), 'Caddyfile') ||
    !/^[0-9a-f]{64}$/u.test(receipt.candidateReleaseEnvSha256) ||
    !isImageReference('api', receipt.priorApiReference) ||
    !isImageReference('web', receipt.priorWebReference) ||
    !isImageReference('api', receipt.candidateApiReference) ||
    !isImageReference('web', receipt.candidateWebReference) ||
    !/^[0-9a-f]{64}$/u.test(receipt.activeCaddySha256) ||
    !/^[0-9a-f]{64}$/u.test(receipt.activeCaddyAdaptedSha256) ||
    receipt.activeCaddySha256 !== receipt.backupCaddySha256 ||
    !/^[0-9a-f]{64}$/u.test(receipt.publicCaddySha256) ||
    !/^[0-9a-f]{64}$/u.test(receipt.publicCaddyAdaptedSha256) ||
    Number.isNaN(Date.parse(receipt.preparedAt))
  )
    fail('receipt_identity');
  return receipt;
}

export function buildRollbackSteps(receipt) {
  validateReceipt(receipt);
  return Object.freeze([
    'restore-basic-caddy',
    'validate-basic-caddy-offline',
    'recreate-basic-caddy',
    'verify-basic-caddy-mounted-config',
    'restore-api',
    'wait-api-ready',
    'restore-web',
    'wait-web-ready',
  ]);
}

export function prepare(input) {
  if (process.getuid?.() !== 0) fail('root_required');
  const operation = validateOperationInput(input);
  const sourceAuthority = assertExactTimewebFrozenSource({
    expectedSourceSha: operation.candidateSourceSha,
    expectedSourceTree: operation.candidateSourceTree,
  });
  requireExactTimewebFrozenSourceAuthority(sourceAuthority, {
    sourceSha: operation.candidateSourceSha,
    sourceTree: operation.candidateSourceTree,
  });
  const { target, publicIngress, publicCaddyPath, publicCaddyBytes, floor } =
    readRepositoryContracts();
  for (const path of [
    operation.activeCaddyfile,
    operation.applicationCompose,
    operation.ingressCompose,
  ])
    secureRegularFile(path, { maxMode: 0o644 });
  validateApplicationCompose(readFileSync(operation.applicationCompose, 'utf8'), target);
  validateIngressCompose(readFileSync(operation.ingressCompose, 'utf8'), target);
  secureDirectory(operation.candidateRuntimeEnvRoot);
  secureRegularFile(operation.candidateReleaseEnv, { expectedMode: 0o600 });
  const candidateReleaseEnvBytes = readFileSync(operation.candidateReleaseEnv);
  const candidateReleaseEnv = validateCandidateReleaseEnvironment(
    candidateReleaseEnvBytes,
    operation,
  );
  const runtimeIdentityPath = `${operation.candidateRuntimeEnvRoot}/.release-identity.json`;
  secureRegularFile(runtimeIdentityPath);
  const runtimeIdentity = parseStrictJson(readFileSync(runtimeIdentityPath, 'utf8'));
  if (
    JSON.stringify(runtimeIdentity) !==
    JSON.stringify({
      schema: 'PHUB_TIMEWEB_SECRET_SET_V1',
      releaseId: operation.candidateReleaseId,
    })
  )
    fail('runtime_release_identity');
  const activeBytes = readFileSync(operation.activeCaddyfile);
  const activeText = activeBytes.toString('utf8');
  if (!/(?:basic_auth|basicauth)/u.test(activeText) || !/405/u.test(activeText))
    fail('active_caddy_preimage');
  const activeCaddyAdaptedSha256 = prospectiveCaddyAdaptedSha256(operation.activeCaddyfile);

  const priorApiReference = imageReference('api', floor.images.api.indexDigest);
  const priorWebReference = imageReference('web', floor.images.web.indexDigest);
  const candidateApiReference = imageReference('api', candidateReleaseEnv.API_IMAGE_DIGEST);
  const candidateWebReference = imageReference('web', candidateReleaseEnv.WEB_IMAGE_DIGEST);
  assertContainerImage('api', priorApiReference);
  assertContainerImage('web', priorWebReference);
  for (const reference of [
    priorApiReference,
    priorWebReference,
    candidateApiReference,
    candidateWebReference,
  ])
    assertLocalImage(reference);

  for (const path of [operation.backupCaddyfile, operation.receipt, operation.rollbackEnv])
    secureDirectory(dirname(path));
  copyFileSync(operation.activeCaddyfile, operation.backupCaddyfile, constants.COPYFILE_EXCL);
  chmodSync(operation.backupCaddyfile, 0o600);
  chownSync(operation.backupCaddyfile, 0, 0);
  secureRegularFile(operation.backupCaddyfile);
  if (!readFileSync(operation.backupCaddyfile).equals(activeBytes)) fail('backup_identity');
  writeExclusive(operation.rollbackEnv, rollbackEnvironment(floor));

  const receipt = {
    schema: RECEIPT_SCHEMA,
    status: 'PREPARED',
    hostname: target.hostname,
    floorSourceSha: floor.sourceSha,
    floorSourceTree: floor.sourceTree,
    candidateSourceSha: operation.candidateSourceSha,
    candidateSourceTree: operation.candidateSourceTree,
    candidateReleaseId: operation.candidateReleaseId,
    candidateRuntimeEnvRoot: operation.candidateRuntimeEnvRoot,
    candidateReleaseEnv: operation.candidateReleaseEnv,
    candidateReleaseEnvSha256: sha256(candidateReleaseEnvBytes),
    priorApiReference,
    priorWebReference,
    candidateApiReference,
    candidateWebReference,
    activeCaddyfile: operation.activeCaddyfile,
    activeCaddySha256: sha256(activeBytes),
    activeCaddyAdaptedSha256,
    backupCaddyfile: operation.backupCaddyfile,
    backupCaddySha256: sha256(readFileSync(operation.backupCaddyfile)),
    publicCaddyfile: publicCaddyPath,
    publicCaddySha256: sha256(publicCaddyBytes),
    publicCaddyAdaptedSha256: publicIngress.adaptedJsonSha256,
    applicationCompose: operation.applicationCompose,
    ingressCompose: operation.ingressCompose,
    rollbackEnv: operation.rollbackEnv,
    preparedAt: new Date().toISOString(),
    complete: true,
  };
  validateReceipt(receipt);
  writeExclusive(operation.receipt, `${JSON.stringify(receipt)}\n`);
  return { status: 'prepared', receipt: operation.receipt };
}

function assertReceiptFrozenSource(receipt) {
  const authority = assertExactTimewebFrozenSource({
    expectedSourceSha: receipt.candidateSourceSha,
    expectedSourceTree: receipt.candidateSourceTree,
  });
  requireExactTimewebFrozenSourceAuthority(authority, {
    sourceSha: receipt.candidateSourceSha,
    sourceTree: receipt.candidateSourceTree,
  });
}

function readReceipt(path) {
  safeAbsolutePath(path, ['/opt/phub/timeweb-beta/'], 'receipt_path');
  secureRegularFile(path, { expectedMode: 0o600 });
  const receipt = validateReceipt(parseStrictJson(readFileSync(path, 'utf8')));
  secureRegularFile(receipt.activeCaddyfile, { maxMode: 0o644 });
  secureRegularFile(receipt.backupCaddyfile);
  secureRegularFile(receipt.applicationCompose, { maxMode: 0o644 });
  secureRegularFile(receipt.ingressCompose, { maxMode: 0o644 });
  secureRegularFile(receipt.rollbackEnv, { expectedMode: 0o600 });
  assertReceiptFrozenSource(receipt);
  return receipt;
}

function readActivationReceipt(path) {
  const receipt = readReceipt(path);
  const { floor, publicIngress, publicCaddyPath, publicCaddyBytes } = readRepositoryContracts();
  if (
    receipt.floorSourceSha !== floor.sourceSha ||
    receipt.floorSourceTree !== floor.sourceTree ||
    receipt.priorApiReference !== imageReference('api', floor.images.api.indexDigest) ||
    receipt.priorWebReference !== imageReference('web', floor.images.web.indexDigest) ||
    receipt.publicCaddyfile !== publicCaddyPath ||
    receipt.publicCaddySha256 !== sha256(publicCaddyBytes) ||
    receipt.publicCaddyAdaptedSha256 !== publicIngress.adaptedJsonSha256
  )
    fail('receipt_contract_drift');
  secureRegularFile(receipt.publicCaddyfile, { maxMode: 0o644 });
  secureRegularFile(receipt.candidateReleaseEnv, { expectedMode: 0o600 });
  const operation = {
    candidateSourceSha: receipt.candidateSourceSha,
    candidateSourceTree: receipt.candidateSourceTree,
    candidateReleaseId: receipt.candidateReleaseId,
    candidateRuntimeEnvRoot: receipt.candidateRuntimeEnvRoot,
  };
  const releaseEnvBytes = readFileSync(receipt.candidateReleaseEnv);
  if (sha256(releaseEnvBytes) !== receipt.candidateReleaseEnvSha256)
    fail('release_env_receipt_mismatch');
  const releaseEnv = validateCandidateReleaseEnvironment(releaseEnvBytes, operation);
  if (
    receipt.candidateApiReference !== imageReference('api', releaseEnv.API_IMAGE_DIGEST) ||
    receipt.candidateWebReference !== imageReference('web', releaseEnv.WEB_IMAGE_DIGEST)
  )
    fail('release_env_receipt_mismatch');
  secureDirectory(receipt.candidateRuntimeEnvRoot);
  const runtimeIdentityPath = `${receipt.candidateRuntimeEnvRoot}/.release-identity.json`;
  secureRegularFile(runtimeIdentityPath, { expectedMode: 0o600 });
  const runtimeIdentity = parseStrictJson(readFileSync(runtimeIdentityPath, 'utf8'));
  if (
    JSON.stringify(runtimeIdentity) !==
    JSON.stringify({ schema: 'PHUB_TIMEWEB_SECRET_SET_V1', releaseId: receipt.candidateReleaseId })
  )
    fail('runtime_release_identity');
  return receipt;
}

function atomicInstall(source, destination) {
  const bytes = readFileSync(source);
  const temporary = `${destination}.phub-new`;
  writeExclusive(temporary, bytes);
  renameSync(temporary, destination);
  secureRegularFile(destination);
}

export function buildProspectiveCaddyInvocation(command) {
  if (command !== 'validate' && command !== 'adapt') fail('caddy_command');
  return Object.freeze({
    command: DOCKER,
    args: Object.freeze([
      'run',
      '--rm',
      '-i',
      '--pull',
      'never',
      '--network',
      'none',
      '--read-only',
      '--user',
      '65534:65534',
      '--entrypoint',
      '/usr/bin/caddy',
      CADDY_IMAGE_REFERENCE,
      command,
      ...(command === 'adapt' ? ['--pretty'] : []),
      '--config',
      '-',
      '--adapter',
      'caddyfile',
    ]),
  });
}

export function buildProspectiveCaddyExecution(source, command) {
  return Object.freeze({
    ...buildProspectiveCaddyInvocation(command),
    input: readFileSync(source),
  });
}

export function buildCaddyRecreateInvocation(receipt) {
  return Object.freeze({
    command: DOCKER,
    args: Object.freeze([
      'compose',
      '-f',
      receipt.ingressCompose,
      'up',
      '--pull',
      'never',
      '-d',
      '--no-deps',
      '--force-recreate',
      'caddy',
    ]),
  });
}

export function buildIngressSmokeInvocations(mode) {
  if (mode !== 'public' && mode !== 'basic') fail('ingress_smoke_mode');
  const common = [
    '--silent',
    '--show-error',
    '--output',
    '/dev/null',
    '--write-out',
    '%{http_code}',
    '--max-time',
    '10',
    '--noproxy',
    '*',
  ];
  if (mode === 'basic') {
    return Object.freeze([
      Object.freeze([
        ...common,
        '--resolve',
        'lk2.padlhub.su:443:127.0.0.1',
        'https://lk2.padlhub.su/',
      ]),
      Object.freeze([
        ...common,
        '--request',
        'POST',
        '--resolve',
        'lk2.padlhub.su:443:127.0.0.1',
        'https://lk2.padlhub.su/user/api/v1/local-padel/auth/viva/authorize',
      ]),
      Object.freeze([
        ...common,
        '--resolve',
        'lk2.padlhub.su:443:127.0.0.1',
        'https://lk2.padlhub.su/public/api/v1/local-padel/games',
      ]),
      Object.freeze([
        ...common,
        '--request',
        'POST',
        '--resolve',
        'lk2.padlhub.su:443:127.0.0.1',
        'https://lk2.padlhub.su/user/api/v1/local-padel/profile',
      ]),
      Object.freeze([
        ...common,
        '--resolve',
        'lk2.padlhub.su:443:127.0.0.1',
        'https://lk2.padlhub.su/realtime/health/ready',
      ]),
    ]);
  }
  return Object.freeze([
    Object.freeze([
      ...common,
      '--head',
      '--resolve',
      'lk2.padlhub.su:80:127.0.0.1',
      'http://lk2.padlhub.su/',
    ]),
    Object.freeze([
      ...common,
      '--resolve',
      'lk2.padlhub.su:443:127.0.0.1',
      'https://lk2.padlhub.su/',
    ]),
    Object.freeze([
      ...common,
      '--resolve',
      'lk2.padlhub.su:443:127.0.0.1',
      'https://lk2.padlhub.su/health/ready',
    ]),
    Object.freeze([
      ...common,
      '--request',
      'POST',
      '--resolve',
      'lk2.padlhub.su:443:127.0.0.1',
      'https://lk2.padlhub.su/user/api/v1/local-padel/profile',
    ]),
  ]);
}

function verifyIngressSmoke(mode) {
  const expected =
    mode === 'basic' ? ['401', '401', '401', '401', '401'] : ['308', '200', '200', '405'];
  const actual = buildIngressSmokeInvocations(mode).map((args) => runCurl(args));
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail('ingress_smoke');
}

function runProspectiveCaddy(source, command) {
  assertLocalImage(CADDY_IMAGE_REFERENCE);
  const execution = buildProspectiveCaddyExecution(source, command);
  return runDocker(execution.args, {
    raw: command === 'adapt',
    input: execution.input,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function prospectiveCaddyAdaptedSha256(source) {
  runProspectiveCaddy(source, 'validate');
  return sha256(Buffer.from(runProspectiveCaddy(source, 'adapt'), 'utf8'));
}

function recreateAndVerifyCaddy(receipt, expectedAdaptedSha256) {
  const invocation = buildCaddyRecreateInvocation(receipt);
  runDocker(invocation.args);
  const id = assertContainerImage('caddy', CADDY_IMAGE_REFERENCE, 'phub-timeweb-beta-ingress');
  const running = runDocker(['inspect', '--format', '{{.State.Running}}', id]);
  if (running !== 'true') fail('caddy_not_running');
  const adapted = runDocker(
    [
      'exec',
      id,
      '/usr/bin/caddy',
      'adapt',
      '--pretty',
      '--config',
      '/etc/caddy/Caddyfile',
      '--adapter',
      'caddyfile',
    ],
    { raw: true },
  );
  if (sha256(Buffer.from(adapted, 'utf8')) !== expectedAdaptedSha256)
    fail('caddy_mounted_config_identity');
}

export function executeCaddyTransition(
  source,
  destination,
  expectedSourceSha256,
  expectedAdaptedSha256,
  operations,
) {
  if (operations.hash(source) !== expectedSourceSha256) fail('caddy_source_identity');
  operations.validate(source, expectedAdaptedSha256);
  operations.install(source, destination);
  if (operations.hash(destination) !== expectedSourceSha256) fail('caddy_install_identity');
  operations.recreate(expectedAdaptedSha256);
}

function installAndRecreateCaddy(receipt, source, sourceSha256, adaptedSha256) {
  executeCaddyTransition(source, receipt.activeCaddyfile, sourceSha256, adaptedSha256, {
    hash: (path) => sha256(readFileSync(path)),
    validate: (path, expected) => {
      if (prospectiveCaddyAdaptedSha256(path) !== expected) fail('caddy_adapted_identity');
    },
    install: atomicInstall,
    recreate: (expected) => recreateAndVerifyCaddy(receipt, expected),
  });
}

function restoreBasicCaddy(receipt) {
  if (sha256(readFileSync(receipt.backupCaddyfile)) !== receipt.backupCaddySha256)
    fail('backup_receipt_mismatch');
  installAndRecreateCaddy(
    receipt,
    receipt.backupCaddyfile,
    receipt.backupCaddySha256,
    receipt.activeCaddyAdaptedSha256,
  );
  verifyIngressSmoke('basic');
}

export function activateIngress(receiptPath) {
  if (process.getuid?.() !== 0) fail('root_required');
  const receipt = readActivationReceipt(receiptPath);
  if (sha256(readFileSync(receipt.activeCaddyfile)) !== receipt.activeCaddySha256)
    fail('active_caddy_drift');
  if (sha256(readFileSync(receipt.publicCaddyfile)) !== receipt.publicCaddySha256)
    fail('public_caddy_drift');
  assertHealthyContainer('api', receipt.candidateApiReference, receipt.candidateReleaseId);
  assertHealthyContainer('web', receipt.candidateWebReference, receipt.candidateReleaseId);
  try {
    installAndRecreateCaddy(
      receipt,
      receipt.publicCaddyfile,
      receipt.publicCaddySha256,
      receipt.publicCaddyAdaptedSha256,
    );
    verifyIngressSmoke('public');
  } catch (error) {
    restoreBasicCaddy(receipt);
    throw error;
  }
  return { status: 'ingress-activated', receipt: receiptPath };
}

function waitHealthy(service, expectedReference) {
  for (let attempt = 1; attempt <= 30; attempt += 1) {
    const id = assertContainerImage(service, expectedReference);
    const health = runDocker([
      'inspect',
      '--format',
      '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}',
      id,
    ]);
    if (health === 'healthy') return;
    if (health === 'unhealthy' || health === 'exited' || health === 'dead') fail('rollback_health');
    execFileSync('/bin/sleep', ['2'], { stdio: 'ignore' });
  }
  fail('rollback_health_timeout');
}

export function rollback(receiptPath) {
  if (process.getuid?.() !== 0) fail('root_required');
  const receipt = readReceipt(receiptPath);
  buildRollbackSteps(receipt);
  restoreBasicCaddy(receipt);
  for (const [service, reference] of [
    ['api', receipt.priorApiReference],
    ['web', receipt.priorWebReference],
  ]) {
    assertLocalImage(reference);
    runDocker([
      'compose',
      '--env-file',
      receipt.rollbackEnv,
      '-f',
      receipt.applicationCompose,
      'up',
      '--pull',
      'never',
      '-d',
      '--no-deps',
      service,
    ]);
    waitHealthy(service, reference);
  }
  return { status: 'rolled-back', receipt: receiptPath };
}

function parseArguments(argv) {
  if (argv.length !== 4 || argv[0] !== '--mode') fail('arguments');
  const mode = argv[1];
  if (argv[2] !== (mode === 'prepare' ? '--input' : '--receipt')) fail('arguments');
  const path = resolve(argv[3]);
  return { mode, path };
}

function main() {
  const { mode, path } = parseArguments(process.argv.slice(2));
  let result;
  if (mode === 'prepare') {
    if (process.getuid?.() !== 0) fail('root_required');
    safeAbsolutePath(path, ['/opt/phub/timeweb-beta/'], 'operation_input_path');
    secureRegularFile(path, { expectedMode: 0o600 });
    result = prepare(parseStrictJson(readFileSync(path, 'utf8')));
  } else if (mode === 'activate-ingress') result = activateIngress(path);
  else if (mode === 'rollback') result = rollback(path);
  else fail('arguments');
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    const code =
      error instanceof TimewebYandexPublicBetaControlError ? error.code : 'unexpected_error';
    process.stderr.write(`${JSON.stringify({ status: 'fail', code })}\n`);
    process.exitCode = 1;
  }
}
