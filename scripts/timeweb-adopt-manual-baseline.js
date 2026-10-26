// Explicit one-shot adoption of an already-running manual Compose promotion as the canonical
// installed beta baseline. The manual promotion predates the enrolled controller, so no canonical
// rollout receipt exists for it. This mode records exactly what is running and which published
// immutable artifact it came from; it never fabricates a rollout receipt, never rotates or writes a
// runtime secret, never restarts a container and never touches the database. It is beta-only and
// refuses a production profile. Adoption is idempotent: a second run only re-verifies the recorded
// readback.
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  constants,
  closeSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseStrictJson } from './strict-json.js';

export const ROOT = '/opt/phub/timeweb-beta';
export const RUNTIME = '/etc/phub/timeweb-beta';
export const ADOPTION_REQUEST_PATH = `${ROOT}/operator/adopt-manual-baseline.json`;
export const ADOPTED_MANUAL_FULL_KIND = 'ADOPTED_MANUAL_FULL';
export const ADOPTION_SOURCE = 'manual-compose-simplified';
export const ADOPTION_REQUEST = 'adoption-request.json';
export const ADOPTION_RECEIPT = 'adoption-receipt.json';
export const PRE_ADOPTION_DESCRIPTOR = 'installed-components.pre-adoption.env';
export const OPERATION_SCHEMA = 'PHUB_TIMEWEB_ADOPT_MANUAL_BASELINE_V1';
export const RECEIPT_SCHEMA = 'PHUB_TIMEWEB_ADOPTION_RECEIPT_V1';
export const INSTALLED_SCHEMA = 'PHUB_TIMEWEB_INSTALLED_COMPONENT_ENV_V1';
export const MANUAL_BASELINE_KIND = 'SIMPLIFIED_FULL';
export const SECRET_SET_SCHEMA = 'PHUB_TIMEWEB_SECRET_SET_V1';
export const ROLLOUT_ABSENT_KIND = 'absent-manual-compose';
export const ROLLOUT_ABSENT_NOTE =
  'The promoted release was activated by a manual compose promotion; no canonical rollout receipt exists and adoption does not fabricate one.';
// Request inputs the operator declares but this mode cannot observe: they are recorded as
// declared, never presented as verified runtime evidence.
export const DECLARED_UNVERIFIED_INPUTS = Object.freeze([
  'manifestSha256',
  'tree',
  'images.migrator',
]);
export const PUBLISHER = 'publish-timeweb-amd64-images.yaml';
export const MAIN_CHECKS = '.github/workflows/pull-request.yaml';
export const TARGET = Object.freeze({
  hostname: 'lk2.padlhub.su',
  serverId: 8886471,
  projectId: 262717,
});
export const SECRET_NAMES = Object.freeze([
  '.release-identity.json',
  'api.env',
  'worker.env',
  'realtime.env',
  'migrator.env',
]);
// Container services that must be running and healthy; the migrator never runs in this baseline.
export const CONTAINER_SERVICES = Object.freeze(['api', 'web', 'realtime', 'worker']);
export const IMAGE_SERVICES = Object.freeze(['api', 'web', 'realtime', 'worker', 'migrator']);
// Deterministic descriptor key order; the file is byte-comparable for every reader.
export const DESCRIPTOR_KEYS = Object.freeze([
  'API_IMAGE_DIGEST',
  'COMPOSE_PROFILES',
  'MIGRATOR_IMAGE_DIGEST',
  'PHUB_ADOPTION_REQUEST_SHA256',
  'PHUB_ADOPTION_SOURCE',
  'PHUB_API_RUNTIME_ENV_FILE',
  'PHUB_COMPONENT_ROLLOUT_KIND',
  'PHUB_COMPONENT_ROLLOUT_RECEIPT',
  'PHUB_MIGRATOR_ENABLED',
  'PHUB_MIGRATOR_RUNTIME_ENV_FILE',
  'PHUB_REALTIME_RUNTIME_ENV_FILE',
  'PHUB_RELEASE_ID',
  'PHUB_ROLLBACK_MODE',
  'PHUB_ROLLBACK_PREVIOUS_RELEASE_ID',
  'PHUB_RUNTIME_SECRET_SET_RELEASE_ID',
  'PHUB_TIMEWEB_RELEASE_ENV_SCHEMA',
  'PHUB_WORKER_ENABLED',
  'PHUB_WORKER_RUNTIME_ENV_FILE',
  'REALTIME_IMAGE_DIGEST',
  'REGISTRY',
  'TIMEWEB_FCM_CREDENTIAL_SOURCE',
  'TIMEWEB_RUNTIME_ENV_ROOT',
  'WEB_IMAGE_DIGEST',
  'WORKER_IMAGE_DIGEST',
]);
const PROJECT = 'phub-timeweb-beta';
const REPOSITORY = 'Z6v6e6r/lk2';
const REGISTRY = 'ghcr.io/z6v6e6r';
const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const HASH = /^[a-f0-9]{64}$/;
const ID = /^[a-f0-9]{40}-[1-9][0-9]*-1$/;
const NUMBER = /^[1-9][0-9]*$/;
const ROLLBACK_MODE = 'previous-release-only';
const NO_PREVIOUS_RELEASE_ID = 'NONE';
// Exactly the installed kinds readInstalledApiBaseline() accepts as a canonical previous baseline.
// ADOPTED_MANUAL_FULL is included so a second manual promotion can be adopted on top of a previous
// adoption: the baseline must be able to advance across consecutive controller-source releases until
// a reviewed controller-source delivery route exists (ADR-0026 follow-up). The lineage stays explicit:
// the receipt records the adopted parent release and its descriptor hash.
const CANONICAL_BASELINE_KINDS = new Set([
  'API_WEB',
  'API_WORKER',
  'API_WORKER_NOTIFICATION_0105',
  'API_WORKER_NOTIFICATION_0105_PRESERVED_ANDROID',
  'ADOPTED_MANUAL_FULL',
]);
const FCM_SOURCE = '/etc/phub/timeweb-beta-fcm/fcm-service-account.json';
const MIN_ADOPTION_WINDOW_MS = 20 * 60 * 1000;
const MAX_ADOPTION_WINDOW_MS = 60 * 60 * 1000;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const OPERATION_KEYS = [
  'schema',
  'profile',
  'controllerSha',
  'controllerTree',
  'target',
  'release',
  'images',
  'containers',
  'expectedCurrentBaseline',
  'secretSet',
  'expiresAt',
  'confirmation',
];
const RELEASE_KEYS = [
  'releaseId',
  'sha',
  'tree',
  'sourceCiRunId',
  'publicationRunId',
  'artifactId',
  'artifactDigest',
  'manifestSha256',
];
const BASELINE_KEYS = ['releaseId', 'descriptorSha256', 'currentDescriptorSha256'];
const SECRET_SET_KEYS = ['releaseId', 'files'];
const CONTAINER_KEYS = ['id', 'image'];
const CONTAINER_EVIDENCE_KEYS = ['id', 'image', 'releaseId', 'revision', 'imageId'];
const RECEIPT_KEYS = [
  'schema',
  'status',
  'adoptedFrom',
  'controllerSha',
  'controllerTree',
  ...RELEASE_KEYS,
  'images',
  'containers',
  'requestSha256',
  'descriptorSha256',
  'previousBaselineSha256',
  'declaredUnverifiedInputs',
  'secretSet',
  'githubVerification',
  'runtimeEvidence',
  'adoptedAt',
];
const GITHUB_VERIFICATION_KEYS = [
  'publicationRunId',
  'publicationRunAttempt',
  'publicationWorkflowPath',
  'canonicalArtifactName',
  'canonicalArtifactDigest',
  'sourceCiRunId',
  'sourceCiRunAttempt',
  'sourceCiWorkflowPath',
  'verified',
];
const RUNTIME_EVIDENCE_KEYS = ['rolloutReceipt', 'note'];
const cleanEnvironment = {
  PATH: '/usr/bin:/bin',
  HOME: '/root',
  LANG: 'C',
  DOCKER_CONFIG: '/root/.docker',
  DOCKER_HOST: 'unix:///var/run/docker.sock',
  COMPOSE_PROFILES: '',
};

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fail = (code) => {
  throw new Error(code);
};
const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);

function isoTimestamp(value) {
  if (typeof value !== 'string') return false;
  const parsed = Date.parse(value);
  return !Number.isNaN(parsed) && new Date(parsed).toISOString() === value;
}

export function releaseDirectory(releaseId) {
  return `${ROOT}/releases/${releaseId}`;
}

function scopedReleaseDirectory(root, releaseId) {
  return `${root}/releases/${releaseId}`;
}

function exact(value, keys) {
  if (!value || Array.isArray(value) || !equal(Object.keys(value).sort(), [...keys].sort()))
    fail('invalid_keys');
}

function parseEnv(bytes) {
  const values = {};
  for (const line of bytes.toString('utf8').trimEnd().split('\n')) {
    const match = /^([A-Z_0-9]+)=([a-zA-Z0-9_./:@-]*)$/.exec(line);
    if (!match || Object.hasOwn(values, match[1])) fail('noncanonical_env');
    values[match[1]] = match[2];
  }
  return values;
}

// Every root-owned path is lstat-verified up to "/", including its parent chain. A hardlinked or
// group/world-writable file is ambiguous custody and fails closed instead of being normalized.
function secure(path, mode) {
  const value = lstatSync(path);
  if (
    value.isSymbolicLink() ||
    value.uid !== 0 ||
    value.gid !== 0 ||
    value.mode & 0o022 ||
    (!value.isDirectory() && (!value.isFile() || value.nlink !== 1)) ||
    (mode !== undefined && (value.mode & 0o777) !== mode)
  )
    fail('insecure_path');
  if (path !== '/') secure(dirname(path));
  return value;
}

function readBytes(path, mode = 0o600, max = MAX_FILE_BYTES) {
  const before = secure(path, mode);
  if (!before.isFile() || before.size > max) fail('invalid_file');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (opened.ino !== before.ino || opened.dev !== before.dev) fail('file_race');
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

function readOptional(path, mode = 0o600) {
  try {
    return readBytes(path, mode);
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  }
}

function writeAtomic(path, bytes, exclusive = false) {
  const temporary = `${path}.incoming-${randomBytes(12).toString('hex')}`;
  const fd = openSync(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    if (exclusive) {
      linkSync(temporary, path);
      unlinkSync(temporary);
    } else renameSync(temporary, path);
    const directory = openSync(dirname(path), 'r');
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  } finally {
    try {
      unlinkSync(temporary);
    } catch {
      /* Rename/link already consumed the temporary name. */
    }
  }
}

function command(program, args) {
  return execFileSync(program, args, {
    env: cleanEnvironment,
    encoding: 'utf8',
    timeout: 120000,
    maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function inspectContainer(service) {
  try {
    const ids = command('/usr/bin/docker', [
      'ps',
      '-q',
      '--filter',
      `label=com.docker.compose.project=${PROJECT}`,
      '--filter',
      `label=com.docker.compose.service=${service}`,
    ])
      .trim()
      .split('\n')
      .filter(Boolean);
    if (ids.length !== 1) fail('container_identity');
    const [value] = JSON.parse(command('/usr/bin/docker', ['inspect', ids[0]]));
    return {
      id: value.Id,
      image: value.Config.Image,
      releaseId: value.Config.Labels?.['phub.release-id'] ?? null,
      revision: value.Config.Labels?.['org.opencontainers.image.revision'] ?? null,
      imageId: value.Image,
      healthy: value.State.Status === 'running' && value.State.Health?.Status === 'healthy',
      restarts: value.RestartCount,
    };
  } catch (error) {
    // Command failures can contain host/runtime text; never propagate them from this module.
    throw error?.message === 'container_identity'
      ? error
      : new Error('container_inspection_failed');
  }
}

async function githubJson(path) {
  if (!/^actions\/runs\/[1-9][0-9]*(?:\/artifacts\?per_page=100)?$/.test(path)) fail('github_path');
  const response = await fetch(`https://api.github.com/repos/${REPOSITORY}/${path}`, {
    headers: { Accept: 'application/vnd.github+json' },
    redirect: 'error',
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) fail('github_read_failed');
  return response.json();
}

export function canonicalArtifactName(sha, publicationRunId) {
  return `timeweb-amd64-canonical-release-${sha}-${publicationRunId}-1`;
}

function confirmationFor(release, secretSet) {
  return `ADOPT_MANUAL_BASELINE_${release.sha.slice(0, 12).toUpperCase()}_KEEP_SECRETS_${secretSet.releaseId.slice(0, 12).toUpperCase()}`;
}

export function validateAdoptionOperation(value, now = new Date(), requireUnexpired = true) {
  exact(value, OPERATION_KEYS);
  if (value.schema !== OPERATION_SCHEMA || value.profile !== 'beta') fail('invalid_operation');
  if (!SHA.test(value.controllerSha ?? '') || !SHA.test(value.controllerTree ?? ''))
    fail('invalid_controller');
  exact(value.target, ['hostname', 'serverId', 'projectId']);
  if (!equal(value.target, TARGET)) fail('invalid_target');
  exact(value.release, RELEASE_KEYS);
  const release = value.release;
  if (
    !SHA.test(release.sha ?? '') ||
    !SHA.test(release.tree ?? '') ||
    !ID.test(release.releaseId ?? '') ||
    release.releaseId !== `${release.sha}-${release.publicationRunId}-1` ||
    ![release.sourceCiRunId, release.publicationRunId, release.artifactId].every(
      (item) => typeof item === 'string' && NUMBER.test(item),
    ) ||
    !DIGEST.test(release.artifactDigest ?? '') ||
    !HASH.test(release.manifestSha256 ?? '')
  )
    fail('invalid_release');
  exact(value.images, IMAGE_SERVICES);
  for (const service of IMAGE_SERVICES)
    if (!DIGEST.test(value.images[service] ?? '')) fail('invalid_images');
  exact(value.containers, CONTAINER_SERVICES);
  for (const service of CONTAINER_SERVICES) {
    const container = value.containers[service];
    exact(container, CONTAINER_KEYS);
    if (
      !HASH.test(container.id ?? '') ||
      container.image !== `${REGISTRY}/phub-${service}@${value.images[service]}`
    )
      fail('invalid_containers');
  }
  exact(value.expectedCurrentBaseline, BASELINE_KEYS);
  const baseline = value.expectedCurrentBaseline;
  if (
    !ID.test(baseline.releaseId ?? '') ||
    baseline.releaseId === release.releaseId ||
    !HASH.test(baseline.descriptorSha256 ?? '') ||
    !HASH.test(baseline.currentDescriptorSha256 ?? '')
  )
    fail('invalid_baseline');
  exact(value.secretSet, SECRET_SET_KEYS);
  if (!ID.test(value.secretSet.releaseId ?? '') || value.secretSet.releaseId !== baseline.releaseId)
    fail('invalid_secret_set');
  exact(value.secretSet.files, SECRET_NAMES);
  for (const name of SECRET_NAMES)
    if (!HASH.test(value.secretSet.files[name] ?? '')) fail('invalid_secret_set');
  if (!isoTimestamp(value.expiresAt)) fail('invalid_expiry');
  if (requireUnexpired) {
    const remaining = Date.parse(value.expiresAt) - now.getTime();
    if (remaining < MIN_ADOPTION_WINDOW_MS || remaining > MAX_ADOPTION_WINDOW_MS)
      fail('invalid_expiry');
  }
  if (value.confirmation !== confirmationFor(release, value.secretSet))
    fail('invalid_confirmation');
  return value;
}

export function validateAdoptionReceipt(value) {
  exact(value, RECEIPT_KEYS);
  if (
    value.schema !== RECEIPT_SCHEMA ||
    value.status !== 'SUCCESS' ||
    value.adoptedFrom !== ADOPTION_SOURCE
  )
    fail('adoption_receipt');
  if (
    !ID.test(value.releaseId ?? '') ||
    value.releaseId !== `${value.sha}-${value.publicationRunId}-1` ||
    !SHA.test(value.sha ?? '') ||
    !SHA.test(value.tree ?? '') ||
    ![value.sourceCiRunId, value.publicationRunId, value.artifactId].every(
      (item) => typeof item === 'string' && NUMBER.test(item),
    ) ||
    !DIGEST.test(value.artifactDigest ?? '') ||
    !HASH.test(value.manifestSha256 ?? '') ||
    !HASH.test(value.requestSha256 ?? '') ||
    !HASH.test(value.descriptorSha256 ?? '') ||
    !HASH.test(value.previousBaselineSha256 ?? '') ||
    !isoTimestamp(value.adoptedAt)
  )
    fail('adoption_receipt');
  if (
    !SHA.test(value.controllerSha ?? '') ||
    !SHA.test(value.controllerTree ?? '') ||
    !Array.isArray(value.declaredUnverifiedInputs) ||
    !equal(value.declaredUnverifiedInputs, [...DECLARED_UNVERIFIED_INPUTS])
  )
    fail('adoption_receipt');
  exact(value.images, IMAGE_SERVICES);
  for (const service of IMAGE_SERVICES)
    if (!DIGEST.test(value.images[service] ?? '')) fail('adoption_receipt');
  exact(value.containers, CONTAINER_SERVICES);
  for (const service of CONTAINER_SERVICES) {
    const container = value.containers[service];
    exact(container, ['id', 'image', 'releaseId']);
    if (
      !HASH.test(container.id ?? '') ||
      container.image !== `${REGISTRY}/phub-${service}@${value.images[service]}` ||
      !(service === 'api' || service === 'web'
        ? container.releaseId === value.releaseId
        : container.releaseId === null || ID.test(container.releaseId ?? ''))
    )
      fail('adoption_receipt');
  }
  exact(value.secretSet, SECRET_SET_KEYS);
  if (!ID.test(value.secretSet.releaseId ?? '')) fail('adoption_receipt');
  exact(value.secretSet.files, SECRET_NAMES);
  for (const name of SECRET_NAMES)
    if (!HASH.test(value.secretSet.files[name] ?? '')) fail('adoption_receipt');
  exact(value.githubVerification, GITHUB_VERIFICATION_KEYS);
  const github = value.githubVerification;
  if (
    github.publicationRunId !== value.publicationRunId ||
    github.publicationRunAttempt !== 1 ||
    github.publicationWorkflowPath !== `.github/workflows/${PUBLISHER}` ||
    github.canonicalArtifactName !== canonicalArtifactName(value.sha, value.publicationRunId) ||
    github.canonicalArtifactDigest !== value.artifactDigest ||
    github.sourceCiRunId !== value.sourceCiRunId ||
    github.sourceCiRunAttempt !== 1 ||
    github.sourceCiWorkflowPath !== MAIN_CHECKS ||
    github.verified !== true
  )
    fail('adoption_receipt');
  exact(value.runtimeEvidence, RUNTIME_EVIDENCE_KEYS);
  if (
    value.runtimeEvidence.rolloutReceipt !== ROLLOUT_ABSENT_KIND ||
    value.runtimeEvidence.note !== ROLLOUT_ABSENT_NOTE
  )
    fail('adoption_receipt');
  return value;
}

function descriptorBytes(operation, requestSha256, root = ROOT) {
  const values = {
    API_IMAGE_DIGEST: operation.images.api,
    COMPOSE_PROFILES: '',
    MIGRATOR_IMAGE_DIGEST: operation.images.migrator,
    PHUB_ADOPTION_REQUEST_SHA256: requestSha256,
    PHUB_ADOPTION_SOURCE: ADOPTION_SOURCE,
    PHUB_API_RUNTIME_ENV_FILE: `${RUNTIME}/api.env`,
    PHUB_COMPONENT_ROLLOUT_KIND: ADOPTED_MANUAL_FULL_KIND,
    PHUB_COMPONENT_ROLLOUT_RECEIPT: `${scopedReleaseDirectory(root, operation.release.releaseId)}/${ADOPTION_RECEIPT}`,
    PHUB_MIGRATOR_ENABLED: 'false',
    PHUB_MIGRATOR_RUNTIME_ENV_FILE: `${RUNTIME}/migrator.env`,
    PHUB_REALTIME_RUNTIME_ENV_FILE: `${RUNTIME}/realtime.env`,
    PHUB_RELEASE_ID: operation.release.releaseId,
    PHUB_ROLLBACK_MODE: ROLLBACK_MODE,
    PHUB_ROLLBACK_PREVIOUS_RELEASE_ID: operation.expectedCurrentBaseline.releaseId,
    PHUB_RUNTIME_SECRET_SET_RELEASE_ID: operation.secretSet.releaseId,
    PHUB_TIMEWEB_RELEASE_ENV_SCHEMA: INSTALLED_SCHEMA,
    PHUB_WORKER_ENABLED: 'true',
    PHUB_WORKER_RUNTIME_ENV_FILE: `${RUNTIME}/worker.env`,
    REALTIME_IMAGE_DIGEST: operation.images.realtime,
    REGISTRY,
    TIMEWEB_FCM_CREDENTIAL_SOURCE: FCM_SOURCE,
    TIMEWEB_RUNTIME_ENV_ROOT: RUNTIME,
    WEB_IMAGE_DIGEST: operation.images.web,
    WORKER_IMAGE_DIGEST: operation.images.worker,
  };
  const lines = DESCRIPTOR_KEYS.map((key) => `${key}=${values[key]}`);
  if (lines.some((line) => !/^[A-Z_0-9]+=[a-zA-Z0-9_./:@-]*$/.test(line))) fail('noncanonical_env');
  return Buffer.from(lines.join('\n') + '\n');
}

function isCanonicalBaselineKind(kind) {
  return CANONICAL_BASELINE_KINDS.has(kind);
}

function verifiedContainers(operation, containers) {
  exact(containers, CONTAINER_SERVICES);
  const verified = {};
  for (const service of CONTAINER_SERVICES) {
    const container = containers[service];
    exact(container, CONTAINER_EVIDENCE_KEYS);
    if (
      !HASH.test(container.id ?? '') ||
      container.id !== operation.containers[service].id ||
      !DIGEST.test(container.imageId ?? '')
    )
      fail('container_identity');
    if (container.image !== operation.containers[service].image) fail('container_image');
    if (!SHA.test(container.revision ?? '') || container.revision !== operation.release.sha)
      fail('container_revision');
    if (service === 'api' || service === 'web') {
      if (container.releaseId !== operation.release.releaseId) fail('container_release');
    } else if (container.releaseId !== null && !ID.test(container.releaseId ?? '')) {
      fail('container_release');
    }
    verified[service] = {
      id: container.id,
      image: container.image,
      releaseId: container.releaseId,
    };
  }
  return verified;
}

function verifiedSecretFiles(operation, secretFiles) {
  exact(secretFiles, SECRET_NAMES);
  for (const name of SECRET_NAMES) {
    const bytes = secretFiles[name];
    if (!Buffer.isBuffer(bytes) || hash(bytes) !== operation.secretSet.files[name])
      fail('secret_set_drift');
  }
  const identity = parseStrictJson(secretFiles['.release-identity.json']);
  exact(identity, ['schema', 'releaseId']);
  if (identity.schema !== SECRET_SET_SCHEMA || identity.releaseId !== operation.secretSet.releaseId)
    fail('secret_set_drift');
}

function verifiedGithub(operation, github) {
  exact(github, ['publicationRun', 'publicationArtifacts', 'sourceCiRun']);
  const release = operation.release;
  const run = github.publicationRun;
  if (
    !run ||
    String(run.id) !== release.publicationRunId ||
    run.head_sha !== release.sha ||
    run.head_branch !== 'main' ||
    run.run_attempt !== 1 ||
    run.status !== 'completed' ||
    run.conclusion !== 'success' ||
    run.event !== 'workflow_dispatch' ||
    run.path !== `.github/workflows/${PUBLISHER}`
  )
    fail('github_publication');
  const inventory = github.publicationArtifacts;
  if (
    !inventory ||
    !Array.isArray(inventory.artifacts) ||
    inventory.total_count !== inventory.artifacts.length
  )
    fail('github_artifacts');
  const name = canonicalArtifactName(release.sha, release.publicationRunId);
  const matches = inventory.artifacts.filter(
    (artifact) => artifact.name === name && artifact.expired !== true,
  );
  if (
    matches.length !== 1 ||
    String(matches[0].id) !== release.artifactId ||
    matches[0].digest !== release.artifactDigest ||
    inventory.artifacts.some((artifact) => artifact.name === name && artifact.expired === true)
  )
    fail('github_artifacts');
  const source = github.sourceCiRun;
  if (
    !source ||
    String(source.id) !== release.sourceCiRunId ||
    source.head_sha !== release.sha ||
    source.run_attempt !== 1 ||
    source.conclusion !== 'success' ||
    source.path !== MAIN_CHECKS
  )
    fail('github_source');
}

// Pure: every byte and every container/GitHub observation is passed in already read and inspected.
export function buildAdoptionArtifacts(operation, inputs) {
  exact(inputs, [
    'requestBytes',
    'previousDescriptorBytes',
    'secretFiles',
    'containers',
    'github',
    'controller',
    'adoptedAt',
    ...(inputs?.root === undefined ? [] : ['root']),
  ]);
  if (!Buffer.isBuffer(inputs.requestBytes)) fail('operation_binding');
  const request = validateAdoptionOperation(
    parseStrictJson(inputs.requestBytes),
    new Date(),
    false,
  );
  if (!equal(request, operation)) fail('operation_binding');
  const requestSha256 = hash(inputs.requestBytes);
  exact(inputs.controller, ['sha', 'tree']);
  if (
    inputs.controller.sha !== request.controllerSha ||
    inputs.controller.tree !== request.controllerTree
  )
    fail('controller_source_mismatch');
  if (!isoTimestamp(inputs.adoptedAt)) fail('invalid_adopted_at');
  const previous = parseEnv(inputs.previousDescriptorBytes);
  if (
    previous.PHUB_RELEASE_ID !== request.expectedCurrentBaseline.releaseId ||
    !isCanonicalBaselineKind(previous.PHUB_COMPONENT_ROLLOUT_KIND) ||
    hash(inputs.previousDescriptorBytes) !== request.expectedCurrentBaseline.descriptorSha256
  )
    fail('previous_baseline_drift');
  const containers = verifiedContainers(request, inputs.containers);
  verifiedSecretFiles(request, inputs.secretFiles);
  verifiedGithub(request, inputs.github);
  const bytes = descriptorBytes(request, requestSha256, inputs.root ?? ROOT);
  const receipt = {
    schema: RECEIPT_SCHEMA,
    status: 'SUCCESS',
    adoptedFrom: ADOPTION_SOURCE,
    controllerSha: request.controllerSha,
    controllerTree: request.controllerTree,
    releaseId: request.release.releaseId,
    sha: request.release.sha,
    tree: request.release.tree,
    sourceCiRunId: request.release.sourceCiRunId,
    publicationRunId: request.release.publicationRunId,
    artifactId: request.release.artifactId,
    artifactDigest: request.release.artifactDigest,
    manifestSha256: request.release.manifestSha256,
    images: { ...request.images },
    containers,
    requestSha256,
    descriptorSha256: hash(bytes),
    previousBaselineSha256: hash(inputs.previousDescriptorBytes),
    declaredUnverifiedInputs: [...DECLARED_UNVERIFIED_INPUTS],
    secretSet: {
      releaseId: request.secretSet.releaseId,
      files: { ...request.secretSet.files },
    },
    githubVerification: {
      publicationRunId: request.release.publicationRunId,
      publicationRunAttempt: 1,
      publicationWorkflowPath: `.github/workflows/${PUBLISHER}`,
      canonicalArtifactName: canonicalArtifactName(
        request.release.sha,
        request.release.publicationRunId,
      ),
      canonicalArtifactDigest: request.release.artifactDigest,
      sourceCiRunId: request.release.sourceCiRunId,
      sourceCiRunAttempt: 1,
      sourceCiWorkflowPath: MAIN_CHECKS,
      verified: true,
    },
    runtimeEvidence: {
      rolloutReceipt: ROLLOUT_ABSENT_KIND,
      note: ROLLOUT_ABSENT_NOTE,
    },
    adoptedAt: inputs.adoptedAt,
  };
  return {
    descriptorBytes: bytes,
    receiptBytes: Buffer.from(JSON.stringify(receipt, null, 2) + '\n'),
  };
}

function releaseFields(release) {
  return {
    releaseId: release.releaseId,
    sha: release.sha,
    tree: release.tree,
    sourceCiRunId: release.sourceCiRunId,
    publicationRunId: release.publicationRunId,
    artifactId: release.artifactId,
    artifactDigest: release.artifactDigest,
    manifestSha256: release.manifestSha256,
  };
}

export function validateAdoptedBaseline(values, bytes, directory, releaseId, options = {}) {
  const readFile = options.readFile ?? ((path) => readOptional(path));
  if (
    !ID.test(releaseId ?? '') ||
    !directory.endsWith(`/releases/${releaseId}`) ||
    values.PHUB_COMPONENT_ROLLOUT_KIND !== ADOPTED_MANUAL_FULL_KIND
  )
    fail('installed_baseline_kind');
  if (
    values.PHUB_TIMEWEB_RELEASE_ENV_SCHEMA !== INSTALLED_SCHEMA ||
    values.PHUB_RELEASE_ID !== releaseId ||
    values.PHUB_COMPONENT_ROLLOUT_RECEIPT !== `${directory}/${ADOPTION_RECEIPT}` ||
    values.PHUB_MIGRATOR_ENABLED !== 'false' ||
    values.PHUB_ADOPTION_SOURCE !== ADOPTION_SOURCE ||
    values.PHUB_ROLLBACK_MODE !== ROLLBACK_MODE
  )
    fail('installed_baseline_identity');
  exact(values, DESCRIPTOR_KEYS);
  if (!equal(values, parseEnv(bytes))) fail('adoption_descriptor_drift');
  const receiptBytes = readFile(`${directory}/${ADOPTION_RECEIPT}`);
  if (receiptBytes === undefined) fail('adoption_receipt_missing');
  const receipt = validateAdoptionReceipt(parseStrictJson(receiptBytes));
  const requestBytes = readFile(`${directory}/${ADOPTION_REQUEST}`);
  if (requestBytes === undefined) fail('adoption_request_missing');
  const requestSha256 = hash(requestBytes);
  const request = validateAdoptionOperation(parseStrictJson(requestBytes), new Date(), false);
  const root = dirname(dirname(directory));
  if (!bytes.equals(descriptorBytes(request, requestSha256, root)))
    fail('adoption_descriptor_drift');
  if (
    receipt.releaseId !== releaseId ||
    receipt.requestSha256 !== requestSha256 ||
    receipt.descriptorSha256 !== hash(bytes) ||
    values.PHUB_ADOPTION_REQUEST_SHA256 !== requestSha256 ||
    receipt.previousBaselineSha256 !== request.expectedCurrentBaseline.descriptorSha256
  )
    fail('adoption_lineage');
  if (
    receipt.controllerSha !== request.controllerSha ||
    receipt.controllerTree !== request.controllerTree
  )
    fail('adoption_controller_drift');
  if (!equal(releaseFields(request.release), releaseFields(receipt)))
    fail('adoption_release_drift');
  if (!equal(request.images, receipt.images)) fail('adoption_image_drift');
  if (!equal(request.secretSet, receipt.secretSet)) fail('adoption_secret_drift');
  if (
    values.PHUB_RUNTIME_SECRET_SET_RELEASE_ID !== request.secretSet.releaseId ||
    values.PHUB_ROLLBACK_PREVIOUS_RELEASE_ID !== request.expectedCurrentBaseline.releaseId
  )
    fail('adoption_secret_drift');
  for (const service of CONTAINER_SERVICES) {
    if (
      request.containers[service].image !== receipt.containers[service].image ||
      receipt.containers[service].image !== `${REGISTRY}/phub-${service}@${request.images[service]}`
    )
      fail('adoption_container_drift');
  }
  if (
    receipt.githubVerification.publicationRunId !== request.release.publicationRunId ||
    receipt.githubVerification.canonicalArtifactDigest !== request.release.artifactDigest ||
    receipt.githubVerification.sourceCiRunId !== request.release.sourceCiRunId
  )
    fail('adoption_github_drift');
  return receipt;
}

// The executed module itself is the only trusted source: read its own frozen checkout, never a
// candidate-controlled path or argv. The checkout is operator-installed and root-owned.
function controllerSource() {
  const repository = dirname(dirname(fileURLToPath(import.meta.url)));
  const git = (args) =>
    execFileSync(
      '/usr/bin/git',
      ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args],
      {
        cwd: repository,
        env: cleanEnvironment,
        encoding: 'utf8',
        timeout: 120000,
        maxBuffer: 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    ).trim();
  try {
    return {
      sha: git(['rev-parse', 'HEAD']),
      tree: git(['rev-parse', 'HEAD^{tree}']),
      dirty: git(['status', '--porcelain', '--untracked-files=all']) !== '',
    };
  } catch {
    // Git failure text can carry host paths; report only the stable code.
    fail('controller_source_mismatch');
  }
}

function verifyControllerSource(readControllerSource, operation) {
  const source = readControllerSource();
  if (!source || source.sha !== operation.controllerSha || source.tree !== operation.controllerTree)
    fail('controller_source_mismatch');
  if (source.dirty !== false) fail('controller_source_dirty');
  return { sha: source.sha, tree: source.tree };
}

function ensureArtifact(path, bytes, readFile, writeFileAtomic) {
  const current = readFile(path);
  if (current === undefined) {
    writeFileAtomic(path, bytes, true);
    return;
  }
  if (!current.equals(bytes)) fail('artifact_conflict');
}

// A crash after the receipt write but before the descriptor rename must reuse the first receipt so
// its adoptedAt stays the durable adoption time. Only an identical, self-consistent receipt is
// accepted; anything else is a conflict for the operator.
function reconcileReceipt(
  path,
  receiptBytes,
  descriptorHash,
  requestSha256,
  readFile,
  writeFileAtomic,
) {
  const current = readFile(path);
  if (current === undefined) {
    writeFileAtomic(path, receiptBytes, true);
    return;
  }
  const receipt = validateAdoptionReceipt(parseStrictJson(current));
  if (receipt.descriptorSha256 !== descriptorHash || receipt.requestSha256 !== requestSha256)
    fail('artifact_conflict');
}

function readPreviousDescriptor(readFile, root, previousReleaseId) {
  const bytes = readFile(
    `${scopedReleaseDirectory(root, previousReleaseId)}/installed-components.env`,
  );
  if (bytes === undefined) fail('previous_baseline_missing');
  return bytes;
}

function readSecretFiles(readFile, runtime) {
  const files = {};
  for (const name of SECRET_NAMES) {
    const bytes = readFile(`${runtime}/${name}`);
    if (bytes === undefined) fail('secret_missing');
    files[name] = bytes;
  }
  return files;
}

function inspectContainers(dockerInspect) {
  const containers = {};
  for (const service of CONTAINER_SERVICES) {
    const info = dockerInspect(service);
    if (!info) fail('container_missing');
    if (info.healthy !== true) fail('container_unhealthy');
    if (info.restarts !== 0) fail('container_restarted');
    containers[service] = {
      id: info.id,
      image: info.image,
      releaseId: info.releaseId ?? null,
      revision: info.revision ?? null,
      imageId: info.imageId,
    };
  }
  return containers;
}

async function collectGithub(fetchJson, release) {
  return {
    publicationRun: await fetchJson(`actions/runs/${release.publicationRunId}`),
    publicationArtifacts: await fetchJson(
      `actions/runs/${release.publicationRunId}/artifacts?per_page=100`,
    ),
    sourceCiRun: await fetchJson(`actions/runs/${release.sourceCiRunId}`),
  };
}

export async function runAdoptManualBaseline(requestPath, options = {}) {
  const root = options.root ?? ROOT;
  const runtime = options.runtime ?? RUNTIME;
  const now = options.now ?? (() => new Date());
  const getuid = options.getuid ?? (() => process.getuid?.());
  const readFile = options.readFile ?? ((path) => readOptional(path));
  const writeFileAtomic = options.writeFileAtomic ?? writeAtomic;
  const dockerInspect = options.dockerInspect ?? inspectContainer;
  const fetchJson = options.fetchJson ?? githubJson;
  const readControllerSource = options.readControllerSource ?? controllerSource;
  if (getuid() !== 0) fail('not_root');
  if (requestPath !== `${root}/operator/adopt-manual-baseline.json`) fail('adoption_entry');
  const moment = now();
  const requestBytes = readFile(requestPath);
  if (requestBytes === undefined) fail('adoption_request_missing');
  // Structural validation runs first so a completed adoption stays readable after its window; a new
  // write still requires fresh 20-60 minute forward authority below.
  const operation = validateAdoptionOperation(parseStrictJson(requestBytes), moment, false);
  const releaseId = operation.release.releaseId;
  const directory = scopedReleaseDirectory(root, releaseId);
  const descriptorPath = `${directory}/installed-components.env`;
  const receiptPath = `${directory}/${ADOPTION_RECEIPT}`;
  const requestCopyPath = `${directory}/${ADOPTION_REQUEST}`;
  const preimagePath = `${directory}/${PRE_ADOPTION_DESCRIPTOR}`;
  const requestSha256 = hash(requestBytes);
  const currentBytes = readFile(descriptorPath);
  if (currentBytes === undefined) fail('current_descriptor_missing');
  const currentValues = parseEnv(currentBytes);
  const adopted = currentValues.PHUB_COMPONENT_ROLLOUT_KIND === ADOPTED_MANUAL_FULL_KIND;
  if (adopted) {
    if (currentValues.PHUB_ADOPTION_REQUEST_SHA256 !== requestSha256)
      fail('adoption_identity_drift');
    if (readFile(receiptPath) !== undefined) {
      const receipt = validateAdoptedBaseline(currentValues, currentBytes, directory, releaseId, {
        readFile,
      });
      process.stdout.write(JSON.stringify(receipt, null, 2) + '\n');
      return receipt;
    }
    // A completed descriptor without its receipt is completed by re-verifying live evidence.
  } else {
    validateAdoptionOperation(operation, moment, true);
    if (
      currentValues.PHUB_RELEASE_ID !== releaseId ||
      currentValues.PHUB_COMPONENT_ROLLOUT_KIND !== MANUAL_BASELINE_KIND ||
      hash(currentBytes) !== operation.expectedCurrentBaseline.currentDescriptorSha256
    )
      fail('current_descriptor_drift');
  }
  // A completed adoption stays readable without re-reading its own checkout; every path that may
  // write binds the executed controller source first.
  const controller = verifyControllerSource(readControllerSource, operation);
  const previousDescriptorBytes = readPreviousDescriptor(
    readFile,
    root,
    operation.expectedCurrentBaseline.releaseId,
  );
  const secretFiles = readSecretFiles(readFile, runtime);
  const containers = inspectContainers(dockerInspect);
  const github = await collectGithub(fetchJson, operation.release);
  const built = buildAdoptionArtifacts(operation, {
    requestBytes,
    previousDescriptorBytes,
    secretFiles,
    containers,
    github,
    controller,
    adoptedAt: moment.toISOString(),
    root,
  });
  if (adopted) {
    if (!currentBytes.equals(built.descriptorBytes)) fail('adoption_descriptor_drift');
    ensureArtifact(requestCopyPath, requestBytes, readFile, writeFileAtomic);
  } else {
    ensureArtifact(requestCopyPath, requestBytes, readFile, writeFileAtomic);
    // Preserve the manual descriptor before it is replaced; it is never overwritten.
    ensureArtifact(preimagePath, currentBytes, readFile, writeFileAtomic);
  }
  reconcileReceipt(
    receiptPath,
    built.receiptBytes,
    hash(built.descriptorBytes),
    requestSha256,
    readFile,
    writeFileAtomic,
  );
  if (!adopted) writeFileAtomic(descriptorPath, built.descriptorBytes, false);
  const finalBytes = readFile(descriptorPath);
  if (finalBytes === undefined) fail('current_descriptor_missing');
  const receipt = validateAdoptedBaseline(parseEnv(finalBytes), finalBytes, directory, releaseId, {
    readFile,
  });
  process.stdout.write(JSON.stringify(receipt, null, 2) + '\n');
  return receipt;
}

// This entry point is deliberately separate from the enrolled controller runner: the PR468 JOIN
// compatibility bridge pins that runner's blob, so unrelated one-shot adoption must not edit it.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const operation =
    args.length === 1
      ? runAdoptManualBaseline(args[0])
      : Promise.reject(new Error('adoption_arguments'));
  operation.catch((error) => {
    const message = error instanceof Error ? error.message : '';
    const code = /^[a-z][a-z0-9_]{2,64}$/u.test(message) ? message : 'unexpected_error';
    process.stderr.write(`ADOPT_MANUAL_BASELINE_STOP ${code}\n`);
    process.exitCode = 1;
  });
}
