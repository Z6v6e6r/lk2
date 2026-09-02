#!/usr/bin/env node

import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fchownSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  linkSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, normalize, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';

import {
  ReleaseManifestContractError,
  validateCanonicalManifest,
} from './timeweb-release-manifest-contract.js';
import {
  assertExactTimewebFrozenSource,
  requireExactTimewebFrozenSourceAuthority,
} from './verify-timeweb-frozen-source.js';

const BASE_LOCK_PATH = fileURLToPath(
  new URL('../deploy/timeweb/base-images.lock.json', import.meta.url),
);
const COMPOSE_PATH = fileURLToPath(new URL('../deploy/timeweb/compose.beta.yaml', import.meta.url));
const TARGET_DOCKER_PATH = '/usr/bin/docker';
const TARGET_DOCKER_SOCKET = '/var/run/docker.sock';
const TARGET_DOCKER_CONFIG = '/root/.docker';
const TARGET_CONTRACT_PATH = new URL('../deploy/timeweb/target.json', import.meta.url);
const GITHUB_CREDENTIAL_CONTRACT_PATH = new URL(
  '../deploy/timeweb/github-release-reader.contract.json',
  import.meta.url,
);
const RELEASE_ROOT = '/opt/phub/timeweb-beta/releases';
const RUNTIME_ENV_ROOT = '/etc/phub/timeweb-beta';
const RUN_EVIDENCE_NAME = 'canonical-run-evidence.json';
const CANONICAL_ARTIFACT_ARCHIVE_NAME = 'canonical-artifact.zip';
const GITHUB_API_ROOT = 'https://api.github.com';
const GITHUB_REPOSITORY = 'Z6v6e6r/lk2';
const GITHUB_OWNER = 'Z6v6e6r';
const CANONICAL_GITHUB_TOKEN_PATH = '/etc/phub/timeweb-beta/github-release-reader.token';
const GITHUB_PACKAGE_RESOURCES = Object.freeze(
  ['api', 'migrator', 'realtime', 'web', 'worker'].map(
    (component) => `${GITHUB_OWNER}/phub-${component}`,
  ),
);
const WORKFLOW_PATH = '.github/workflows/publish-timeweb-amd64-images.yaml';
const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const CHECKSUM_PATTERN = /^[0-9a-f]{64}$/u;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const FORBIDDEN_RUN_IDS = new Set(['33011023879']);
const COMPONENT_VARIABLES = Object.freeze({
  web: 'WEB',
  api: 'API',
  worker: 'WORKER',
  realtime: 'REALTIME',
  migrator: 'MIGRATOR',
});
const SECRET_FILES = Object.freeze(['api.env', 'worker.env', 'realtime.env', 'migrator.env']);
const verifiedRunEvidence = new WeakMap();
const verifiedRenderedEnvironments = new WeakMap();

export class TimewebReleaseEnvironmentError extends Error {
  constructor(reason) {
    super(reason);
    this.name = 'TimewebReleaseEnvironmentError';
    this.reason = reason;
  }
}

function fail(reason) {
  throw new TimewebReleaseEnvironmentError(reason);
}

function readTargetContract() {
  try {
    return JSON.parse(readFileSync(TARGET_CONTRACT_PATH, 'utf8'));
  } catch {
    fail('target_contract_unavailable');
  }
}

function validateGitHubCredentialContract(contract, { allowTestIdentity = false } = {}) {
  if (
    !hasExactKeys(contract, ['schema', 'file', 'credential', 'resources', 'lifecycle']) ||
    contract.schema !== 'PHUB_TIMEWEB_GITHUB_RELEASE_READER_V1' ||
    !hasExactKeys(contract.file, [
      'path',
      'uid',
      'gid',
      'mode',
      'linkCount',
      'minimumBytes',
      'maximumBytes',
    ]) ||
    !hasExactKeys(contract.credential, ['type', 'prefix', 'requiredScopes', 'scopeAuthority']) ||
    !hasExactKeys(contract.resources, ['repository', 'packages']) ||
    !hasExactKeys(contract.lifecycle, [
      'oneShot',
      'maximumFileAgeSeconds',
      'revokeAfterUse',
      'rotationOwner',
    ]) ||
    !isAbsolute(contract.file.path) ||
    normalize(contract.file.path) !== contract.file.path ||
    (!allowTestIdentity && contract.file.path !== CANONICAL_GITHUB_TOKEN_PATH) ||
    (!allowTestIdentity && contract.file.uid !== 0) ||
    (!allowTestIdentity && contract.file.gid !== 0) ||
    (allowTestIdentity && (!Number.isSafeInteger(contract.file.uid) || contract.file.uid < 0)) ||
    (allowTestIdentity && (!Number.isSafeInteger(contract.file.gid) || contract.file.gid < 0)) ||
    contract.file.mode !== '0600' ||
    contract.file.linkCount !== 1 ||
    contract.file.minimumBytes !== 40 ||
    contract.file.maximumBytes !== 256 ||
    contract.credential.type !== 'github_personal_access_token_classic' ||
    contract.credential.prefix !== 'ghp_' ||
    !Array.isArray(contract.credential.requiredScopes) ||
    contract.credential.requiredScopes.join(',') !== 'read:packages' ||
    contract.credential.scopeAuthority !== 'github_x_oauth_scopes_exact' ||
    contract.resources.repository !== GITHUB_REPOSITORY ||
    !Array.isArray(contract.resources.packages) ||
    contract.resources.packages.join(',') !== GITHUB_PACKAGE_RESOURCES.join(',') ||
    contract.lifecycle.oneShot !== true ||
    contract.lifecycle.maximumFileAgeSeconds !== 3600 ||
    contract.lifecycle.revokeAfterUse !== true ||
    contract.lifecycle.rotationOwner !== 'Z6v6e6r repository owner'
  )
    fail('github_credential_contract');
  return deepFreeze(contract);
}

function readGitHubCredentialContract() {
  try {
    return validateGitHubCredentialContract(
      JSON.parse(readFileSync(GITHUB_CREDENTIAL_CONTRACT_PATH, 'utf8')),
    );
  } catch (error) {
    if (error instanceof TimewebReleaseEnvironmentError) throw error;
    fail('github_credential_contract_unavailable');
  }
}

const targetContract = readTargetContract();
const githubCredentialContract = readGitHubCredentialContract();
const historicalPaths = new Set(
  targetContract.release.historicalEvidence.map(({ path }) => normalize(path)),
);

function assertSafeAbsolutePath(path, reason) {
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

function syncDirectory(path) {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function hasExactKeys(value, keys) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === [...keys].sort().join(',')
  );
}

function objectChecksum(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function decodeUtf8(bytes, reason) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    fail(reason);
  }
}

function readSecureRegularFile(
  path,
  { expectedUid, expectedGid, expectedMode, minBytes = 0, maxBytes, reason },
) {
  const before = lstatSync(path);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1 ||
    (expectedUid !== undefined && before.uid !== expectedUid) ||
    (expectedGid !== undefined && before.gid !== expectedGid) ||
    (expectedMode !== undefined && (before.mode & 0o777) !== expectedMode) ||
    before.size < minBytes ||
    before.size > maxBytes
  )
    fail(reason);
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(descriptor);
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.nlink !== 1)
      fail(`${reason}_race`);
    return readFileSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function assertRootOwnedParentChain(
  path,
  expectedUid,
  expectedGid,
  allowTestIdentity,
  reason = 'github_token_parent_security',
) {
  let current = dirname(path);
  let directParent = true;
  while (true) {
    const metadata = lstatSync(current);
    if (
      !metadata.isDirectory() ||
      metadata.isSymbolicLink() ||
      (directParent && (metadata.uid !== expectedUid || metadata.gid !== expectedGid)) ||
      (!directParent &&
        !allowTestIdentity &&
        (metadata.uid !== expectedUid || metadata.gid !== expectedGid)) ||
      (!directParent && allowTestIdentity && ![0, expectedUid].includes(metadata.uid)) ||
      (metadata.mode & 0o022) !== 0
    )
      fail(reason);
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
    directParent = false;
  }
}

export function readCanonicalTimewebReleasePair(manifestPath, expectedChecksum) {
  assertSafeAbsolutePath(manifestPath, 'manifest_path');
  if (basename(manifestPath) !== 'release-manifest.json') fail('manifest_name');
  if (!CHECKSUM_PATTERN.test(expectedChecksum)) fail('expected_checksum');
  const checksumPath = join(dirname(manifestPath), 'release-manifest.sha256');
  const manifestBytes = readSecureRegularFile(manifestPath, {
    maxBytes: 1_048_576,
    reason: 'manifest_file_security',
  });
  const checksumBytes = readSecureRegularFile(checksumPath, {
    maxBytes: 256,
    reason: 'checksum_file_security',
  });
  const contents = decodeUtf8(manifestBytes, 'manifest_encoding');
  const checksumContents = decodeUtf8(checksumBytes, 'checksum_encoding');
  const checksumMatch = checksumContents.match(/^([a-f0-9]{64})  release-manifest\.json\n$/u);
  if (!checksumMatch) fail('checksum_format');
  const actualChecksum = createHash('sha256').update(manifestBytes).digest('hex');
  if (checksumMatch[1] !== actualChecksum || expectedChecksum !== actualChecksum)
    fail('checksum_mismatch');
  let manifest;
  try {
    manifest = JSON.parse(contents);
  } catch {
    fail('manifest_json');
  }
  return { manifest, checksum: actualChecksum, manifestBytes, checksumBytes };
}

export function readCanonicalTimewebRunEvidence(evidencePath, expectedChecksum) {
  assertSafeAbsolutePath(evidencePath, 'run_evidence_path');
  if (basename(evidencePath) !== RUN_EVIDENCE_NAME) fail('run_evidence_name');
  if (!CHECKSUM_PATTERN.test(expectedChecksum)) fail('run_evidence_expected_checksum');
  const checksumPath = join(dirname(evidencePath), 'canonical-run-evidence.sha256');
  const evidenceBytes = readSecureRegularFile(evidencePath, {
    maxBytes: 65_536,
    reason: 'run_evidence_file_security',
  });
  const checksumBytes = readSecureRegularFile(checksumPath, {
    maxBytes: 256,
    reason: 'run_evidence_checksum_security',
  });
  const checksumContents = decodeUtf8(checksumBytes, 'run_evidence_checksum_encoding');
  const checksumMatch = checksumContents.match(/^([a-f0-9]{64})  canonical-run-evidence\.json\n$/u);
  if (!checksumMatch) fail('run_evidence_checksum_format');
  const actualChecksum = createHash('sha256').update(evidenceBytes).digest('hex');
  if (checksumMatch[1] !== actualChecksum || expectedChecksum !== actualChecksum)
    fail('run_evidence_checksum_mismatch');
  let evidence;
  try {
    evidence = JSON.parse(decodeUtf8(evidenceBytes, 'run_evidence_encoding'));
  } catch (error) {
    if (error instanceof TimewebReleaseEnvironmentError) throw error;
    fail('run_evidence_json');
  }
  return { evidence, checksum: actualChecksum };
}

function readGitHubToken(
  tokenPath,
  contract,
  nowMs = Date.now(),
  { allowTestIdentity = false } = {},
) {
  const validatedContract = validateGitHubCredentialContract(contract, { allowTestIdentity });
  if (tokenPath !== validatedContract.file.path) fail('github_token_path');
  assertSafeAbsolutePath(tokenPath, 'github_token_path');
  assertRootOwnedParentChain(
    tokenPath,
    validatedContract.file.uid,
    validatedContract.file.gid,
    allowTestIdentity,
  );
  const metadata = lstatSync(tokenPath);
  const ageMs = nowMs - metadata.mtimeMs;
  if (
    !Number.isFinite(nowMs) ||
    ageMs < 0 ||
    ageMs > validatedContract.lifecycle.maximumFileAgeSeconds * 1000
  )
    fail('github_token_freshness');
  const bytes = readSecureRegularFile(tokenPath, {
    expectedUid: validatedContract.file.uid,
    expectedGid: validatedContract.file.gid,
    expectedMode: 0o600,
    minBytes: validatedContract.file.minimumBytes,
    maxBytes: validatedContract.file.maximumBytes,
    reason: 'github_token_file_security',
  });
  const contents = decodeUtf8(bytes, 'github_token_encoding');
  if (contents.includes('\0') || contents.includes('\r')) fail('github_token_format');
  const token = contents.endsWith('\n') ? contents.slice(0, -1) : contents;
  if (!/^ghp_[A-Za-z0-9]{36,251}$/u.test(token)) fail('github_token_format');
  return token;
}

function assertGitHubCredentialScope(response, contract) {
  const rawScopes = response.headers.get('x-oauth-scopes');
  if (rawScopes === null) fail('github_token_scope_metadata');
  const scopes = rawScopes
    .split(',')
    .map((scope) => scope.trim())
    .filter(Boolean)
    .sort();
  if (scopes.join(',') !== [...contract.credential.requiredScopes].sort().join(','))
    fail('github_token_scope');
}

async function githubFetch(
  path,
  token,
  credentialContract,
  accept = 'application/vnd.github+json',
) {
  if (!path.startsWith('/')) fail('github_api_path');
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    let response;
    try {
      response = await globalThis.fetch(`${GITHUB_API_ROOT}${path}`, {
        headers: {
          Accept: accept,
          Authorization: `Bearer ${token}`,
          'X-GitHub-Api-Version': '2022-11-28',
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      if (attempt === 3) fail('github_api_unavailable');
      await new Promise((resolve) => setTimeout(resolve, attempt * 200));
      continue;
    }
    if (response.ok) {
      assertGitHubCredentialScope(response, credentialContract);
      return response;
    }
    if (![429, 502, 503, 504].includes(response.status) || attempt === 3)
      fail('github_api_response');
    await new Promise((resolve) => setTimeout(resolve, attempt * 200));
  }
  fail('github_api_unavailable');
}

async function githubJson(path, token, credentialContract) {
  const response = await githubFetch(path, token, credentialContract);
  try {
    return await response.json();
  } catch {
    fail('github_api_json');
  }
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function extractCanonicalArtifactPair(archiveBytes) {
  if (archiveBytes.length > 4_194_304 || archiveBytes.length < 22)
    fail('canonical_artifact_archive_size');
  let eocd = -1;
  const searchStart = Math.max(0, archiveBytes.length - 65_557);
  for (let offset = archiveBytes.length - 22; offset >= searchStart; offset -= 1) {
    if (archiveBytes.readUInt32LE(offset) === 0x06054b50) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) fail('canonical_artifact_archive');
  const entryCount = archiveBytes.readUInt16LE(eocd + 10);
  const directorySize = archiveBytes.readUInt32LE(eocd + 12);
  const directoryOffset = archiveBytes.readUInt32LE(eocd + 16);
  if (
    entryCount !== 2 ||
    archiveBytes.readUInt16LE(eocd + 4) !== 0 ||
    archiveBytes.readUInt16LE(eocd + 6) !== 0 ||
    directoryOffset + directorySize > eocd
  )
    fail('canonical_artifact_inventory');

  const files = new Map();
  let cursor = directoryOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (archiveBytes.readUInt32LE(cursor) !== 0x02014b50) fail('canonical_artifact_archive');
    const flags = archiveBytes.readUInt16LE(cursor + 8);
    const method = archiveBytes.readUInt16LE(cursor + 10);
    const expectedCrc = archiveBytes.readUInt32LE(cursor + 16);
    const compressedSize = archiveBytes.readUInt32LE(cursor + 20);
    const uncompressedSize = archiveBytes.readUInt32LE(cursor + 24);
    const nameLength = archiveBytes.readUInt16LE(cursor + 28);
    const extraLength = archiveBytes.readUInt16LE(cursor + 30);
    const commentLength = archiveBytes.readUInt16LE(cursor + 32);
    const localOffset = archiveBytes.readUInt32LE(cursor + 42);
    const name = decodeUtf8(
      archiveBytes.subarray(cursor + 46, cursor + 46 + nameLength),
      'canonical_artifact_filename',
    );
    if (
      flags & 0x1 ||
      ![0, 8].includes(method) ||
      !['release-manifest.json', 'release-manifest.sha256'].includes(name) ||
      files.has(name) ||
      uncompressedSize > 1_048_576 ||
      localOffset + 30 > archiveBytes.length ||
      archiveBytes.readUInt32LE(localOffset) !== 0x04034b50
    )
      fail('canonical_artifact_inventory');
    const localNameLength = archiveBytes.readUInt16LE(localOffset + 26);
    const localExtraLength = archiveBytes.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > archiveBytes.length) fail('canonical_artifact_archive');
    let contents;
    try {
      const compressed = archiveBytes.subarray(dataStart, dataEnd);
      contents = method === 0 ? Buffer.from(compressed) : inflateRawSync(compressed);
    } catch {
      fail('canonical_artifact_archive');
    }
    if (contents.length !== uncompressedSize || crc32(contents) !== expectedCrc)
      fail('canonical_artifact_archive');
    files.set(name, contents);
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  if (cursor !== directoryOffset + directorySize) fail('canonical_artifact_archive');
  return files;
}

async function assertRegistryInventory(manifest, token, credentialContract) {
  let presentImages = 0;
  for (const image of manifest.images) {
    const packageName = `phub-${image.component}`;
    let found = false;
    for (let page = 1; page <= 10 && !found; page += 1) {
      if (!credentialContract.resources.packages.includes(`${GITHUB_OWNER}/${packageName}`))
        fail('github_credential_resource');
      const versions = await githubJson(
        `/users/${GITHUB_OWNER}/packages/container/${packageName}/versions?per_page=100&page=${page}`,
        token,
        credentialContract,
      );
      if (!Array.isArray(versions)) fail('github_registry_response');
      found = versions.some(
        (version) =>
          version?.name === image.digest &&
          version?.metadata?.package_type === 'container' &&
          version?.metadata?.container !== null,
      );
      if (versions.length < 100) break;
    }
    if (!found) fail('registry_inventory_incomplete');
    presentImages += 1;
  }
  return { complete: presentImages === 5, presentImages, expectedImages: 5 };
}

export async function verifyCanonicalGitHubRunAuthority({
  manifest,
  manifestBytes,
  checksumBytes,
  manifestChecksum,
  expectedSourceSha,
  expectedSourceTree,
  expectedWorkflowSha,
  expectedRunId,
  expectedRunAttempt,
  githubTokenFile,
  artifactArchivePath,
  credentialContract = githubCredentialContract,
  nowMs = Date.now(),
}) {
  const allowTestIdentity = credentialContract !== githubCredentialContract;
  if (allowTestIdentity && process.env.NODE_ENV !== 'test') fail('github_credential_contract');
  const validatedCredentialContract = validateGitHubCredentialContract(credentialContract, {
    allowTestIdentity,
  });
  const expected = {
    sourceSha: expectedSourceSha,
    sourceTree: expectedSourceTree,
    workflowSha: expectedWorkflowSha,
    runId: expectedRunId,
    runAttempt: expectedRunAttempt,
  };
  validateExpectedIdentity(manifest, expected, BASE_LOCK_PATH);
  const token = readGitHubToken(githubTokenFile, validatedCredentialContract, nowMs, {
    allowTestIdentity,
  });
  assertSafeAbsolutePath(artifactArchivePath, 'canonical_artifact_archive_path');
  if (basename(artifactArchivePath) !== CANONICAL_ARTIFACT_ARCHIVE_NAME)
    fail('canonical_artifact_archive_path');
  const releaseId = `${expectedSourceSha}-${expectedRunId}-${expectedRunAttempt}`;
  if (
    !allowTestIdentity &&
    artifactArchivePath !==
      join(RELEASE_ROOT, releaseId, 'artifact', CANONICAL_ARTIFACT_ARCHIVE_NAME)
  )
    fail('canonical_artifact_archive_path');
  assertRootOwnedParentChain(
    artifactArchivePath,
    validatedCredentialContract.file.uid,
    validatedCredentialContract.file.gid,
    allowTestIdentity,
    'canonical_artifact_archive_parent_security',
  );
  const run = await githubJson(
    `/repos/${GITHUB_REPOSITORY}/actions/runs/${expectedRunId}/attempts/${expectedRunAttempt}`,
    token,
    validatedCredentialContract,
  );
  if (
    String(run?.id) !== expectedRunId ||
    String(run?.run_attempt) !== '1' ||
    run?.head_sha !== expectedSourceSha ||
    run?.path !== WORKFLOW_PATH ||
    run?.event !== 'workflow_dispatch' ||
    run?.status !== 'completed' ||
    run?.conclusion !== 'success' ||
    typeof run?.updated_at !== 'string' ||
    Number.isNaN(Date.parse(run.updated_at))
  )
    fail('github_run_identity');

  const artifactName = `timeweb-amd64-canonical-release-${expectedSourceSha}-${expectedRunId}-1`;
  const artifactListing = await githubJson(
    `/repos/${GITHUB_REPOSITORY}/actions/runs/${expectedRunId}/artifacts?per_page=100`,
    token,
    validatedCredentialContract,
  );
  const artifacts = Array.isArray(artifactListing?.artifacts)
    ? artifactListing.artifacts.filter((artifact) => artifact?.name === artifactName)
    : [];
  if (artifacts.length !== 1) fail('canonical_artifact_custody');
  const artifact = artifacts[0];
  if (
    !Number.isSafeInteger(artifact.id) ||
    artifact.expired !== false ||
    !DIGEST_PATTERN.test(artifact.digest) ||
    String(artifact?.workflow_run?.id) !== expectedRunId ||
    artifact?.workflow_run?.head_sha !== expectedSourceSha ||
    artifact.archive_download_url !==
      `${GITHUB_API_ROOT}/repos/${GITHUB_REPOSITORY}/actions/artifacts/${artifact.id}/zip`
  )
    fail('canonical_artifact_custody');
  const archiveBytes = readSecureRegularFile(artifactArchivePath, {
    expectedUid: validatedCredentialContract.file.uid,
    expectedGid: validatedCredentialContract.file.gid,
    expectedMode: 0o600,
    minBytes: 22,
    maxBytes: 4_194_304,
    reason: 'canonical_artifact_archive_file_security',
  });
  if (createHash('sha256').update(archiveBytes).digest('hex') !== artifact.digest.slice(7))
    fail('canonical_artifact_digest');
  const files = extractCanonicalArtifactPair(archiveBytes);
  if (
    !files.get('release-manifest.json')?.equals(manifestBytes) ||
    !files.get('release-manifest.sha256')?.equals(checksumBytes)
  )
    fail('canonical_artifact_pair_mismatch');
  const registryInventory = await assertRegistryInventory(
    manifest,
    token,
    validatedCredentialContract,
  );
  let artifactManifest;
  try {
    artifactManifest = JSON.parse(decodeUtf8(manifestBytes, 'manifest_encoding'));
  } catch (error) {
    if (error instanceof TimewebReleaseEnvironmentError) throw error;
    fail('manifest_json');
  }
  if (objectChecksum(artifactManifest) !== objectChecksum(manifest))
    fail('canonical_artifact_manifest_binding');
  const evidence = {
    schema: 'PHUB_TIMEWEB_CANONICAL_RUN_EVIDENCE_V1',
    repository: GITHUB_REPOSITORY,
    workflowPath: WORKFLOW_PATH,
    workflowSha: expectedWorkflowSha,
    sourceSha: expectedSourceSha,
    sourceTree: expectedSourceTree,
    runId: expectedRunId,
    runAttempt: '1',
    status: run.status,
    conclusion: run.conclusion,
    event: run.event,
    authenticatedSource: 'github-actions-api+artifact-digest-bound-local-archive+ghcr-api',
    observedAt: run.updated_at,
    canonicalArtifact: {
      id: String(artifact.id),
      name: artifact.name,
      digest: artifact.digest,
      expired: artifact.expired,
      files: [...files.keys()].sort(),
    },
    registryInventory,
    releaseManifestSha256: manifestChecksum,
  };
  const checksum = createHash('sha256')
    .update(`${JSON.stringify(evidence)}\n`)
    .digest('hex');
  deepFreeze(evidence);
  verifiedRunEvidence.set(evidence, {
    manifestChecksum,
    manifestObjectChecksum: objectChecksum(manifest),
    evidenceChecksum: checksum,
  });
  return { evidence, checksum };
}

function validateCanonicalRunEvidence(
  evidence,
  manifest,
  expected,
  manifestChecksum,
  evidenceChecksum,
) {
  const authority = verifiedRunEvidence.get(evidence);
  if (!authority) fail('untrusted_run_evidence');
  if (
    authority.manifestChecksum !== manifestChecksum ||
    authority.manifestObjectChecksum !== objectChecksum(manifest) ||
    authority.evidenceChecksum !== evidenceChecksum
  )
    fail('run_evidence_manifest_binding');
  const keys = [
    'schema',
    'repository',
    'workflowPath',
    'workflowSha',
    'sourceSha',
    'sourceTree',
    'runId',
    'runAttempt',
    'status',
    'conclusion',
    'event',
    'authenticatedSource',
    'observedAt',
    'canonicalArtifact',
    'registryInventory',
    'releaseManifestSha256',
  ];
  if (!hasExactKeys(evidence, keys)) fail('run_evidence_shape');
  if (
    evidence.schema !== 'PHUB_TIMEWEB_CANONICAL_RUN_EVIDENCE_V1' ||
    evidence.repository !== 'Z6v6e6r/lk2' ||
    evidence.workflowPath !== '.github/workflows/publish-timeweb-amd64-images.yaml' ||
    evidence.workflowSha !== expected.workflowSha ||
    evidence.sourceSha !== expected.sourceSha ||
    evidence.sourceTree !== expected.sourceTree ||
    evidence.runId !== expected.runId ||
    evidence.runAttempt !== '1' ||
    evidence.status !== 'completed' ||
    evidence.conclusion !== 'success' ||
    evidence.event !== 'workflow_dispatch' ||
    evidence.authenticatedSource !==
      'github-actions-api+artifact-digest-bound-local-archive+ghcr-api' ||
    typeof evidence.observedAt !== 'string' ||
    Number.isNaN(Date.parse(evidence.observedAt)) ||
    evidence.releaseManifestSha256 !== manifestChecksum ||
    !CHECKSUM_PATTERN.test(evidenceChecksum)
  )
    fail('run_evidence_identity');

  if (
    !hasExactKeys(evidence.canonicalArtifact, ['id', 'name', 'digest', 'expired', 'files']) ||
    !/^[1-9][0-9]*$/u.test(evidence.canonicalArtifact.id) ||
    evidence.canonicalArtifact.name !==
      `timeweb-amd64-canonical-release-${manifest.gitCommit}-${manifest.publication.runId}-1` ||
    !/^sha256:[a-f0-9]{64}$/u.test(evidence.canonicalArtifact.digest) ||
    evidence.canonicalArtifact.expired !== false ||
    !Array.isArray(evidence.canonicalArtifact.files) ||
    [...evidence.canonicalArtifact.files].sort().join(',') !==
      'release-manifest.json,release-manifest.sha256'
  )
    fail('canonical_artifact_custody');
  if (
    !hasExactKeys(evidence.registryInventory, ['complete', 'presentImages', 'expectedImages']) ||
    evidence.registryInventory.complete !== true ||
    evidence.registryInventory.presentImages !== 5 ||
    evidence.registryInventory.expectedImages !== 5
  )
    fail('registry_inventory_incomplete');
}

function validateExpectedIdentity(manifest, expected, baseLockPath) {
  for (const [key, pattern] of [
    ['sourceSha', SHA_PATTERN],
    ['sourceTree', SHA_PATTERN],
    ['workflowSha', SHA_PATTERN],
  ]) {
    if (typeof expected[key] !== 'string' || !pattern.test(expected[key]))
      fail('expected_identity');
  }
  if (!/^[1-9][0-9]*$/u.test(expected.runId) || expected.runAttempt !== '1')
    fail('expected_publication');
  if (FORBIDDEN_RUN_IDS.has(expected.runId)) fail('forbidden_publication_run');
  try {
    validateCanonicalManifest(manifest, {
      expectedPublication: {
        workflowSha: expected.workflowSha,
        runId: expected.runId,
        runAttempt: expected.runAttempt,
      },
      expectedBaseLockPath: baseLockPath,
    });
  } catch (error) {
    if (error instanceof ReleaseManifestContractError) fail(`canonical_${error.reason}`);
    fail('canonical_validation');
  }
  if (manifest.schemaVersion !== 'PHUB_TIMEWEB_RELEASE_MANIFEST_V2') fail('canonical_v2_required');
  if (
    manifest.gitCommit !== expected.sourceSha ||
    manifest.gitTree !== expected.sourceTree ||
    manifest.publication.workflowSha !== expected.workflowSha ||
    manifest.publication.runId !== expected.runId ||
    manifest.publication.runAttempt !== expected.runAttempt
  )
    fail('release_identity_mismatch');
  if (
    manifest.images.length !== 5 ||
    manifest.images.some(
      (image) =>
        image.publication !== true ||
        !DIGEST_PATTERN.test(image.digest) ||
        !DIGEST_PATTERN.test(image.runtimeDigest),
    )
  )
    fail('incomplete_publication');
}

export function validateTimewebRuntimeSecretPaths(runtimeEnvRoot, releaseId, expectedUid = 0) {
  assertSafeAbsolutePath(runtimeEnvRoot, 'runtime_env_root');
  const root = lstatSync(runtimeEnvRoot);
  if (
    !root.isDirectory() ||
    root.isSymbolicLink() ||
    root.uid !== expectedUid ||
    (root.mode & 0o777) !== 0o700
  )
    fail('runtime_env_root_security');
  for (const name of SECRET_FILES) {
    readSecureRegularFile(join(runtimeEnvRoot, name), {
      expectedUid,
      expectedMode: 0o600,
      maxBytes: 131_072,
      reason: 'runtime_secret_file_security',
    });
  }
  const identityBytes = readSecureRegularFile(join(runtimeEnvRoot, '.release-identity.json'), {
    expectedUid,
    expectedMode: 0o600,
    maxBytes: 4096,
    reason: 'runtime_identity_file_security',
  });
  let identity;
  try {
    identity = JSON.parse(decodeUtf8(identityBytes, 'runtime_identity_encoding'));
  } catch (error) {
    if (error instanceof TimewebReleaseEnvironmentError) throw error;
    fail('runtime_identity_format');
  }
  if (
    identity.schema !== 'PHUB_TIMEWEB_SECRET_SET_V1' ||
    identity.releaseId !== releaseId ||
    Object.keys(identity).sort().join(',') !== 'releaseId,schema'
  )
    fail('runtime_secret_release_identity');
}

export function assertNoAmbientComposeOverrides(environment = process.env) {
  const forbidden = Object.keys(environment).filter(
    (key) => key.startsWith('COMPOSE_') && environment[key] !== undefined,
  );
  if (forbidden.length > 0) fail('ambient_compose_override');
}

export function assertNoAmbientDockerOverrides(environment = process.env) {
  if (Object.keys(environment).some((key) => key.startsWith('DOCKER_'))) {
    fail('ambient_docker_override');
  }
}

export function buildTimewebInitialBetaComposeInvocation(stage, releaseEnvPath) {
  const stages = {
    preflight: ['config', '--services'],
    'pull-api': ['pull', 'api'],
    'up-api': ['up', '-d', '--no-deps', 'api'],
    'pull-web': ['pull', 'web'],
    'up-web': ['up', '-d', '--no-deps', 'web'],
    'pull-realtime': ['pull', 'realtime'],
    'up-realtime': ['up', '-d', '--no-deps', 'realtime'],
  };
  if (!Object.hasOwn(stages, stage)) fail('compose_stage');
  assertSafeAbsolutePath(releaseEnvPath, 'release_env_path');
  if (basename(releaseEnvPath) !== 'release.env') fail('release_env_path');
  return {
    command: TARGET_DOCKER_PATH,
    args: ['compose', '--env-file', releaseEnvPath, '-f', COMPOSE_PATH, ...stages[stage]],
  };
}

export function runTimewebInitialBetaComposeStage(
  stage,
  releaseEnvPath,
  rendered,
  expectedUid = 0,
) {
  assertNoAmbientDockerOverrides(process.env);
  const authority = verifiedRenderedEnvironments.get(rendered);
  if (!authority) fail('untrusted_rendered_environment');
  const currentSourceAuthority = assertExactTimewebFrozenSource({
    expectedSourceSha: authority.sourceSha,
    expectedSourceTree: authority.sourceTree,
  });
  requireExactTimewebFrozenSourceAuthority(currentSourceAuthority, {
    sourceSha: authority.sourceSha,
    sourceTree: authority.sourceTree,
  });
  assertSafeAbsolutePath(releaseEnvPath, 'release_env_path');
  if (
    dirname(dirname(releaseEnvPath)) !== RELEASE_ROOT ||
    basename(dirname(releaseEnvPath)) !== authority.releaseId
  )
    fail('release_env_identity');
  const releaseDirectory = lstatSync(dirname(releaseEnvPath));
  if (
    !releaseDirectory.isDirectory() ||
    releaseDirectory.isSymbolicLink() ||
    releaseDirectory.uid !== expectedUid ||
    (releaseDirectory.mode & 0o777) !== 0o700
  )
    fail('release_dir_security');
  const releaseEnvBytes = readSecureRegularFile(releaseEnvPath, {
    expectedUid,
    expectedMode: 0o600,
    maxBytes: 131_072,
    reason: 'release_env_file_security',
  });
  if (
    createHash('sha256').update(releaseEnvBytes).digest('hex') !== authority.contentsChecksum ||
    !releaseEnvBytes.equals(Buffer.from(rendered.contents, 'utf8'))
  )
    fail('release_env_authority_mismatch');
  validateTimewebRuntimeSecretPaths(authority.runtimeEnvRoot, authority.releaseId, expectedUid);
  const dockerSocket = lstatSync(TARGET_DOCKER_SOCKET);
  if (!dockerSocket.isSocket() || dockerSocket.isSymbolicLink() || dockerSocket.uid !== expectedUid)
    fail('docker_socket_identity');
  const environment = {
    PATH: '/usr/bin:/bin',
    HOME: '/root',
    DOCKER_HOST: `unix://${TARGET_DOCKER_SOCKET}`,
    DOCKER_CONFIG: TARGET_DOCKER_CONFIG,
    COMPOSE_PROFILES: '',
  };
  const preflight = buildTimewebInitialBetaComposeInvocation('preflight', releaseEnvPath);
  let services;
  try {
    services = execFileSync(preflight.command, preflight.args, {
      encoding: 'utf8',
      env: environment,
    })
      .trim()
      .split('\n')
      .filter(Boolean)
      .sort();
  } catch {
    fail('compose_preflight');
  }
  if (services.join(',') !== 'api,realtime,web') fail('compose_service_set');
  if (stage === 'preflight') return { stage, services, mutated: false };
  const invocation = buildTimewebInitialBetaComposeInvocation(stage, releaseEnvPath);
  try {
    execFileSync(invocation.command, invocation.args, {
      encoding: 'utf8',
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    fail('compose_stage_failed');
  }
  return { stage, services, mutated: true };
}

export function renderTimewebBetaReleaseEnvironment(
  manifest,
  {
    expectedSourceSha,
    expectedSourceTree,
    expectedWorkflowSha,
    expectedRunId,
    expectedRunAttempt,
    canonicalManifestChecksum,
    runEvidence,
    runEvidenceChecksum,
    runtimeEnvRoot,
    sourceAuthority,
    previousReleaseId = 'NONE',
    baseLockPath = BASE_LOCK_PATH,
  },
) {
  const expected = {
    sourceSha: expectedSourceSha,
    sourceTree: expectedSourceTree,
    workflowSha: expectedWorkflowSha,
    runId: expectedRunId,
    runAttempt: expectedRunAttempt,
  };
  requireExactTimewebFrozenSourceAuthority(sourceAuthority, expected);
  validateExpectedIdentity(manifest, expected, baseLockPath);
  if (!CHECKSUM_PATTERN.test(canonicalManifestChecksum)) fail('expected_checksum');
  validateCanonicalRunEvidence(
    runEvidence,
    manifest,
    expected,
    canonicalManifestChecksum,
    runEvidenceChecksum,
  );
  assertSafeAbsolutePath(runtimeEnvRoot, 'runtime_env_root');
  if (previousReleaseId !== 'NONE') fail('previous_release_not_supported');

  const releaseId = `${manifest.gitCommit}-${manifest.publication.runId}-${manifest.publication.runAttempt}`;
  const values = {
    PHUB_TIMEWEB_RELEASE_ENV_SCHEMA: 'PHUB_TIMEWEB_RELEASE_ENV_V1',
    REGISTRY: 'ghcr.io/z6v6e6r',
    PHUB_RELEASE_ID: releaseId,
    PHUB_RELEASE_SOURCE_SHA: manifest.gitCommit,
    PHUB_RELEASE_SOURCE_TREE: manifest.gitTree,
    PHUB_PUBLICATION_WORKFLOW_SHA: manifest.publication.workflowSha,
    PHUB_PUBLICATION_RUN_ID: manifest.publication.runId,
    PHUB_PUBLICATION_RUN_ATTEMPT: manifest.publication.runAttempt,
    PHUB_CANONICAL_MANIFEST_SHA256: canonicalManifestChecksum,
    PHUB_CANONICAL_RUN_EVIDENCE_SHA256: runEvidenceChecksum,
    PHUB_CANONICAL_ARTIFACT_ID: runEvidence.canonicalArtifact.id,
    PHUB_CANONICAL_ARTIFACT_NAME: runEvidence.canonicalArtifact.name,
    PHUB_CANONICAL_ARTIFACT_DIGEST: runEvidence.canonicalArtifact.digest,
    TIMEWEB_RUNTIME_ENV_ROOT: runtimeEnvRoot,
    PHUB_API_RUNTIME_ENV_FILE: join(runtimeEnvRoot, 'api.env'),
    PHUB_WORKER_RUNTIME_ENV_FILE: join(runtimeEnvRoot, 'worker.env'),
    PHUB_REALTIME_RUNTIME_ENV_FILE: join(runtimeEnvRoot, 'realtime.env'),
    PHUB_MIGRATOR_RUNTIME_ENV_FILE: join(runtimeEnvRoot, 'migrator.env'),
    PHUB_WORKER_ENABLED: 'false',
    PHUB_MIGRATOR_ENABLED: 'false',
    COMPOSE_PROFILES: '',
    PHUB_ROLLBACK_PREVIOUS_RELEASE_ID: previousReleaseId,
    PHUB_ROLLBACK_MODE:
      previousReleaseId === 'NONE' ? 'stop-candidate-no-previous-release' : 'previous-release-only',
  };
  for (const image of manifest.images) {
    const prefix = COMPONENT_VARIABLES[image.component];
    if (!prefix) fail('component_set');
    values[`${prefix}_IMAGE_DIGEST`] = image.digest;
    values[`${prefix}_RUNTIME_DIGEST`] = image.runtimeDigest;
  }
  const rendered = {
    releaseId,
    contents: `${Object.entries(values)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n')}\n`,
  };
  Object.freeze(rendered);
  verifiedRenderedEnvironments.set(rendered, {
    releaseId,
    runtimeEnvRoot,
    sourceSha: expected.sourceSha,
    sourceTree: expected.sourceTree,
    contentsChecksum: createHash('sha256').update(rendered.contents).digest('hex'),
  });
  return rendered;
}

export function writeTimewebBetaReleaseEnvironment({
  manifest,
  expectedSourceSha,
  expectedSourceTree,
  expectedWorkflowSha,
  expectedRunId,
  expectedRunAttempt,
  canonicalManifestChecksum,
  runEvidence,
  runEvidenceChecksum,
  runtimeEnvRoot = RUNTIME_ENV_ROOT,
  sourceAuthority,
  previousReleaseId = 'NONE',
  releaseRoot = RELEASE_ROOT,
  releaseDir,
  expectedUid = 0,
  expectedGid = expectedUid,
  baseLockPath = BASE_LOCK_PATH,
  ambientEnvironment = process.env,
  failAfter,
}) {
  assertNoAmbientComposeOverrides(ambientEnvironment);
  const rendered = renderTimewebBetaReleaseEnvironment(manifest, {
    expectedSourceSha,
    expectedSourceTree,
    expectedWorkflowSha,
    expectedRunId,
    expectedRunAttempt,
    canonicalManifestChecksum,
    runEvidence,
    runEvidenceChecksum,
    runtimeEnvRoot,
    sourceAuthority,
    previousReleaseId,
    baseLockPath,
  });
  validateTimewebRuntimeSecretPaths(runtimeEnvRoot, rendered.releaseId, expectedUid);
  assertSafeAbsolutePath(releaseRoot, 'release_root');
  assertSafeAbsolutePath(releaseDir, 'release_dir');
  if (
    dirname(releaseDir) !== releaseRoot ||
    basename(releaseDir) !== rendered.releaseId ||
    relative(releaseRoot, releaseDir).startsWith('..')
  )
    fail('release_dir_identity');
  const directory = lstatSync(releaseDir);
  if (
    !directory.isDirectory() ||
    directory.isSymbolicLink() ||
    directory.uid !== expectedUid ||
    (directory.mode & 0o777) !== 0o700
  )
    fail('release_dir_security');
  const output = join(releaseDir, 'release.env');
  if (existsSync(output)) fail('release_env_exists');
  const staging = join(
    releaseDir,
    `.release.env.incoming-${process.pid}-${randomBytes(12).toString('hex')}`,
  );
  let descriptor;
  let stagingIdentity;
  let installed = false;
  try {
    descriptor = openSync(
      staging,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    stagingIdentity = fstatSync(descriptor);
    writeFileSync(descriptor, rendered.contents, 'utf8');
    fchownSync(descriptor, expectedUid, expectedGid);
    fchmodSync(descriptor, 0o600);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    installed = true;
    linkSync(staging, output);
    unlinkSync(staging);
    if (failAfter === 'rename') fail('injected_failure');
    syncDirectory(releaseDir);
    return { releaseId: rendered.releaseId, output, mode: '0600' };
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    if (installed && existsSync(output) && stagingIdentity) {
      const current = lstatSync(output);
      if (current.dev !== stagingIdentity.dev || current.ino !== stagingIdentity.ino)
        fail('release_env_output_identity');
      rmSync(output);
      syncDirectory(releaseDir);
      installed = false;
    }
    if (error instanceof TimewebReleaseEnvironmentError) throw error;
    fail('release_env_write');
  } finally {
    if (existsSync(staging)) {
      const current = lstatSync(staging);
      if (
        stagingIdentity &&
        current.dev === stagingIdentity.dev &&
        current.ino === stagingIdentity.ino &&
        basename(staging).startsWith('.release.env.incoming-')
      )
        rmSync(staging);
      else fail('release_env_staging_identity');
    }
  }
}

function parseOptionPairs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const option = argv[index];
    const value = argv[index + 1];
    if (!option?.startsWith('--') || !value || Object.hasOwn(values, option)) fail('usage');
    values[option] = value;
  }
  return values;
}

function requireExactOptions(values, required) {
  const allowed = new Set(required);
  if (
    Object.keys(values).some((key) => !allowed.has(key)) ||
    Object.keys(values).length !== required.length ||
    required.some((key) => !values[key])
  )
    fail('usage');
  return values;
}

function parseArguments(argv) {
  const values = parseOptionPairs(argv);
  const required = [
    '--manifest',
    '--expected-manifest-sha256',
    '--github-token-file',
    '--artifact-archive',
    '--expected-source-sha',
    '--expected-source-tree',
    '--expected-workflow-sha',
    '--expected-run-id',
    '--expected-run-attempt',
    '--release-dir',
  ];
  return requireExactOptions(values, required);
}

function parseComposeArguments(argv) {
  const values = parseOptionPairs(argv);
  return requireExactOptions(values, [
    '--compose-stage',
    '--release-env',
    '--manifest',
    '--expected-manifest-sha256',
    '--github-token-file',
    '--artifact-archive',
    '--expected-source-sha',
    '--expected-source-tree',
    '--expected-workflow-sha',
    '--expected-run-id',
    '--expected-run-attempt',
  ]);
}

async function readVerifiedReleaseInputs(values) {
  const sourceAuthority = assertExactTimewebFrozenSource({
    expectedSourceSha: values['--expected-source-sha'],
    expectedSourceTree: values['--expected-source-tree'],
  });
  const pair = readCanonicalTimewebReleasePair(
    values['--manifest'],
    values['--expected-manifest-sha256'],
  );
  const runEvidence = await verifyCanonicalGitHubRunAuthority({
    manifest: pair.manifest,
    manifestBytes: pair.manifestBytes,
    checksumBytes: pair.checksumBytes,
    manifestChecksum: pair.checksum,
    expectedSourceSha: values['--expected-source-sha'],
    expectedSourceTree: values['--expected-source-tree'],
    expectedWorkflowSha: values['--expected-workflow-sha'],
    expectedRunId: values['--expected-run-id'],
    expectedRunAttempt: values['--expected-run-attempt'],
    githubTokenFile: values['--github-token-file'],
    artifactArchivePath: values['--artifact-archive'],
  });
  return { pair, runEvidence, sourceAuthority };
}

async function main() {
  if (process.getuid?.() !== 0) fail('root_required');
  const argv = process.argv.slice(2);
  if (argv.includes('--compose-stage')) {
    const values = parseComposeArguments(argv);
    const { pair, runEvidence, sourceAuthority } = await readVerifiedReleaseInputs(values);
    const rendered = renderTimewebBetaReleaseEnvironment(pair.manifest, {
      expectedSourceSha: values['--expected-source-sha'],
      expectedSourceTree: values['--expected-source-tree'],
      expectedWorkflowSha: values['--expected-workflow-sha'],
      expectedRunId: values['--expected-run-id'],
      expectedRunAttempt: values['--expected-run-attempt'],
      canonicalManifestChecksum: pair.checksum,
      runEvidence: runEvidence.evidence,
      runEvidenceChecksum: runEvidence.checksum,
      runtimeEnvRoot: RUNTIME_ENV_ROOT,
      sourceAuthority,
      previousReleaseId: 'NONE',
    });
    const result = runTimewebInitialBetaComposeStage(
      values['--compose-stage'],
      values['--release-env'],
      rendered,
    );
    process.stdout.write(
      `TIMEWEB_BETA_COMPOSE_STAGE_PASSED|stage=${result.stage}|services=${result.services.join(',')}|mutated=${result.mutated}\n`,
    );
    return;
  }
  const values = parseArguments(argv);
  const { pair, runEvidence, sourceAuthority } = await readVerifiedReleaseInputs(values);
  const result = writeTimewebBetaReleaseEnvironment({
    manifest: pair.manifest,
    expectedSourceSha: values['--expected-source-sha'],
    expectedSourceTree: values['--expected-source-tree'],
    expectedWorkflowSha: values['--expected-workflow-sha'],
    expectedRunId: values['--expected-run-id'],
    expectedRunAttempt: values['--expected-run-attempt'],
    canonicalManifestChecksum: pair.checksum,
    runEvidence: runEvidence.evidence,
    runEvidenceChecksum: runEvidence.checksum,
    sourceAuthority,
    previousReleaseId: 'NONE',
    releaseDir: values['--release-dir'],
  });
  process.stdout.write(
    `TIMEWEB_BETA_RELEASE_ENV_PASSED|release_id=${result.releaseId}|mode=${result.mode}|values_printed=false\n`,
  );
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((error) => {
    const reason =
      error instanceof TimewebReleaseEnvironmentError ? error.reason : 'validation_error';
    process.stderr.write(`TIMEWEB_BETA_RELEASE_ENV_FAILED|reason=${reason}\n`);
    process.exitCode = 1;
  });
}
