import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

export class ReleaseManifestContractError extends Error {
  constructor(reason) {
    super(reason);
    this.name = 'ReleaseManifestContractError';
    this.reason = reason;
  }
}

function reject(reason) {
  throw new ReleaseManifestContractError(reason);
}

function readSchema(relativePath) {
  try {
    return JSON.parse(readFileSync(new URL(relativePath, import.meta.url), 'utf8'));
  } catch {
    reject('schema_unavailable');
  }
}

export const currentSchema = readSchema('../deploy/timeweb/release-manifest.schema.json');
export const legacyV1Schema = readSchema('../deploy/timeweb/release-manifest.v1.schema.json');

const CURRENT_VERSION = currentSchema.properties.schemaVersion.const;
const LEGACY_VERSION = legacyV1Schema.properties.schemaVersion.const;
const COMPONENTS = currentSchema.properties.images.items.properties.component.enum;
const COMMIT = currentSchema.properties.gitCommit.const;
const TREE = currentSchema.properties.gitTree.const;
const DIGEST_PATTERN = new RegExp(
  currentSchema.properties.images.items.properties.digest.pattern,
  'u',
);
const SHA_PATTERN = new RegExp(
  currentSchema.properties.publication.properties.workflowSha.pattern,
  'u',
);
const RUN_ID_PATTERN = new RegExp(
  currentSchema.properties.publication.properties.runId.pattern,
  'u',
);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value, expected) {
  return Object.keys(value).sort().join(',') === [...expected].sort().join(',');
}

function validateImages(images, schema, version) {
  if (!Array.isArray(images) || images.length !== COMPONENTS.length) reject('component_set');
  const itemSchema = schema.properties.images.items;
  const imageKeys = itemSchema.required;
  const seen = new Set();
  for (const image of images) {
    if (!isRecord(image)) reject('image_shape');
    if (!hasExactKeys(image, imageKeys)) reject('image_keys');
    if (!COMPONENTS.includes(image.component) || seen.has(image.component)) reject('component_set');
    seen.add(image.component);
    if (image.repository !== `ghcr.io/z6v6e6r/phub-${image.component}`) reject('repository');
    if (typeof image.digest !== 'string' || !DIGEST_PATTERN.test(image.digest)) reject('digest');
    if (
      image.architecture !== itemSchema.properties.architecture.const ||
      image.revision !== itemSchema.properties.revision.const ||
      image.provenance !== true ||
      image.sbom !== true
    )
      reject('image_verification');
    if (version === CURRENT_VERSION) {
      if (typeof image.runtimeDigest !== 'string' || !DIGEST_PATTERN.test(image.runtimeDigest))
        reject('runtime_digest');
      if (image.publication !== true) reject('publication_verification');
    } else if (image.reconciliation !== true) {
      reject('reconciliation_verification');
    }
  }
  if (COMPONENTS.some((component) => !seen.has(component))) reject('component_set');
}

export function resolveApplicationTree(commit = COMMIT) {
  if (typeof commit !== 'string' || !/^[0-9a-f]{40}$/u.test(commit)) reject('git_commit');
  try {
    const tree = execFileSync('git', ['rev-parse', '--verify', `${commit}^{tree}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (!/^[0-9a-f]{40}$/u.test(tree)) reject('git_tree');
    return tree;
  } catch (error) {
    if (error instanceof ReleaseManifestContractError) throw error;
    reject('git_tree_unavailable');
  }
}

export function buildCurrentManifest(evidence) {
  if (!isRecord(evidence)) reject('publication_shape');
  const requiredEvidenceKeys = [
    'schemaVersion',
    'kind',
    'sourceSha',
    'sourceTree',
    'workflowSha',
    'repository',
    'platform',
    'runId',
    'runAttempt',
    'authorizesDeploy',
    'authorizesVpsProvisioning',
    'authorizesDatabaseMutation',
    'images',
  ];
  if (!hasExactKeys(evidence, requiredEvidenceKeys)) reject('publication_keys');
  const resolvedTree = resolveApplicationTree(COMMIT);
  if (resolvedTree !== TREE) reject('schema_tree_mismatch');
  if (
    evidence.schemaVersion !== 1 ||
    evidence.kind !== 'phub-timeweb-amd64-publication' ||
    evidence.sourceSha !== COMMIT ||
    evidence.sourceTree !== resolvedTree ||
    evidence.repository !== currentSchema.properties.repository.const ||
    evidence.platform !== currentSchema.properties.platform.const ||
    typeof evidence.workflowSha !== 'string' ||
    !SHA_PATTERN.test(evidence.workflowSha) ||
    typeof evidence.runId !== 'string' ||
    !RUN_ID_PATTERN.test(evidence.runId) ||
    evidence.runAttempt !== currentSchema.properties.publication.properties.runAttempt.const ||
    evidence.authorizesDeploy !== false ||
    evidence.authorizesVpsProvisioning !== false ||
    evidence.authorizesDatabaseMutation !== false
  )
    reject('publication_header');
  if (!Array.isArray(evidence.images) || evidence.images.length !== COMPONENTS.length)
    reject('component_set');

  const byComponent = new Map();
  for (const image of evidence.images) {
    if (!isRecord(image)) reject('publication_image_shape');
    if (!COMPONENTS.includes(image.service) || byComponent.has(image.service))
      reject('component_set');
    if (
      image.sourceSha !== COMMIT ||
      image.sourceTree !== resolvedTree ||
      image.workflowSha !== evidence.workflowSha ||
      image.repository !== `ghcr.io/z6v6e6r/phub-${image.service}` ||
      image.publicationTag !== `amd64-sha-${COMMIT}-${evidence.runId}-${evidence.runAttempt}` ||
      image.platform !== currentSchema.properties.platform.const ||
      image.runId !== evidence.runId ||
      image.runAttempt !== evidence.runAttempt ||
      image.provenance !== 'slsa-v1-max' ||
      image.sbom !== 'spdx' ||
      typeof image.indexDigest !== 'string' ||
      !DIGEST_PATTERN.test(image.indexDigest) ||
      typeof image.runtimeDigest !== 'string' ||
      !DIGEST_PATTERN.test(image.runtimeDigest)
    )
      reject('publication_image_identity');
    byComponent.set(image.service, image);
  }
  if (COMPONENTS.some((component) => !byComponent.has(component))) reject('component_set');

  return {
    schemaVersion: CURRENT_VERSION,
    repository: currentSchema.properties.repository.const,
    gitCommit: COMMIT,
    gitTree: resolvedTree,
    platform: currentSchema.properties.platform.const,
    publication: {
      workflow: currentSchema.properties.publication.properties.workflow.const,
      workflowSha: evidence.workflowSha,
      runId: evidence.runId,
      runAttempt: evidence.runAttempt,
    },
    images: COMPONENTS.map((component) => {
      const image = byComponent.get(component);
      return {
        component,
        repository: image.repository,
        digest: image.indexDigest,
        runtimeDigest: image.runtimeDigest,
        architecture: currentSchema.properties.images.items.properties.architecture.const,
        revision: COMMIT,
        provenance: true,
        sbom: true,
        publication: true,
      };
    }),
  };
}

function validateCurrent(manifest, expectedPublication) {
  if (!hasExactKeys(manifest, currentSchema.required)) reject('keys');
  const resolvedTree = resolveApplicationTree(manifest.gitCommit);
  if (
    manifest.repository !== currentSchema.properties.repository.const ||
    manifest.gitCommit !== COMMIT ||
    manifest.gitTree !== TREE ||
    manifest.gitTree !== resolvedTree ||
    manifest.platform !== currentSchema.properties.platform.const
  )
    reject('header');
  const publication = manifest.publication;
  const publicationSchema = currentSchema.properties.publication;
  if (!isRecord(publication) || !hasExactKeys(publication, publicationSchema.required))
    reject('publication_shape');
  if (
    publication.workflow !== publicationSchema.properties.workflow.const ||
    typeof publication.workflowSha !== 'string' ||
    !SHA_PATTERN.test(publication.workflowSha) ||
    typeof publication.runId !== 'string' ||
    !RUN_ID_PATTERN.test(publication.runId) ||
    publication.runAttempt !== publicationSchema.properties.runAttempt.const
  )
    reject('publication_identity');
  if (
    expectedPublication &&
    (publication.workflowSha !== expectedPublication.workflowSha ||
      publication.runId !== expectedPublication.runId ||
      publication.runAttempt !== expectedPublication.runAttempt)
  )
    reject('publication_identity_mismatch');
  validateImages(manifest.images, currentSchema, CURRENT_VERSION);
}

function validateLegacyV1(manifest, expectedPublication) {
  if (expectedPublication) reject('legacy_publication_identity');
  if (!hasExactKeys(manifest, legacyV1Schema.required)) reject('keys');
  if (
    manifest.repository !== legacyV1Schema.properties.repository.const ||
    manifest.gitCommit !== legacyV1Schema.properties.gitCommit.const ||
    manifest.platform !== legacyV1Schema.properties.platform.const
  )
    reject('header');
  validateImages(manifest.images, legacyV1Schema, LEGACY_VERSION);
  const reconciliationSchema = legacyV1Schema.properties.reconciliationRuns;
  const runIdPattern = new RegExp(reconciliationSchema.items.pattern, 'u');
  if (
    !Array.isArray(manifest.reconciliationRuns) ||
    manifest.reconciliationRuns.length !== reconciliationSchema.maxItems ||
    new Set(manifest.reconciliationRuns).size !== manifest.reconciliationRuns.length ||
    !manifest.reconciliationRuns.every(
      (runId) => typeof runId === 'string' && runIdPattern.test(runId),
    )
  )
    reject('reconciliation_runs');
}

export function validateCanonicalManifest(manifest, { expectedPublication } = {}) {
  if (!isRecord(manifest)) reject('shape');
  if (manifest.schemaVersion === CURRENT_VERSION) {
    validateCurrent(manifest, expectedPublication);
  } else if (manifest.schemaVersion === LEGACY_VERSION) {
    validateLegacyV1(manifest, expectedPublication);
  } else {
    reject('schema_version');
  }
  return manifest.schemaVersion;
}
