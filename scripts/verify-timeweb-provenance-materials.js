#!/usr/bin/env node
import {
  constants,
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { parseStrictJson, StrictJsonError } from './strict-json.js';
import { validateBaseImageLock } from './verify-timeweb-base-images.js';

const STATEMENT_TYPE = 'https://in-toto.io/Statement/v1';
const PREDICATE_TYPE = 'https://slsa.dev/provenance/v1';
const BUILD_TYPE =
  'https://github.com/moby/buildkit/blob/master/docs/attestations/slsa-definitions.md';
const REPOSITORY = 'Z6v6e6r/lk2';
const SERVICE_SET = new Set(['web', 'api', 'worker', 'realtime', 'migrator']);
const SHA1 = /^[a-f0-9]{40}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const PRINTABLE_ASCII = /^[\u0021-\u007e]+$/u;
const BASE_IDENTITIES = new Map([
  [
    'node-runtime-build-base',
    { registry: 'docker.io', repository: 'library/node', packageName: 'node' },
  ],
  [
    'nginx-web-runtime',
    { registry: 'docker.io', repository: 'library/nginx', packageName: 'nginx' },
  ],
  [
    'buildkit-syft-scanner',
    {
      registry: 'docker.io',
      repository: 'docker/buildkit-syft-scanner',
      packageName: 'docker/buildkit-syft-scanner',
    },
  ],
]);
const NORMALIZED_PACKAGES = new Map([
  ['node', 'node'],
  ['docker.io/library/node', 'node'],
  ['nginx', 'nginx'],
  ['docker.io/library/nginx', 'nginx'],
  ['docker/buildkit-syft-scanner', 'docker/buildkit-syft-scanner'],
  ['docker.io/docker/buildkit-syft-scanner', 'docker/buildkit-syft-scanner'],
]);

export class ProvenanceMaterialsError extends Error {
  constructor(reason, details = {}) {
    super(reason);
    this.name = 'ProvenanceMaterialsError';
    this.reason = reason;
    this.details = details;
  }
}

function reject(reason, details = {}) {
  throw new ProvenanceMaterialsError(reason, details);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, keys) {
  return isRecord(value) && Object.keys(value).sort().join('|') === [...keys].sort().join('|');
}

function regularFileBytes(path, reason) {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) reject(reason);
    return readFileSync(path);
  } catch (error) {
    if (error instanceof ProvenanceMaterialsError) throw error;
    reject(reason);
  }
}

function parseStrict(bytes, reason) {
  try {
    return parseStrictJson(bytes);
  } catch (error) {
    if (error instanceof StrictJsonError) reject(`${reason}_${error.reason}`);
    reject(reason);
  }
}

function decodeQualifier(value, reason) {
  if (typeof value !== 'string' || value.length === 0) reject(reason);
  if (/%(?![a-fA-F0-9]{2})/u.test(value)) reject('purl_malformed_percent_encoding');
  let decoded;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    reject('purl_malformed_percent_encoding');
  }
  if (/%[a-fA-F0-9]{2}/u.test(decoded)) reject('purl_double_encoding');
  if (!PRINTABLE_ASCII.test(decoded)) reject('purl_qualifier_characters');
  return decoded;
}

export function parseCanonicalBuildkitPurl(uri) {
  if (typeof uri !== 'string' || uri.length > 1024 || !PRINTABLE_ASCII.test(uri))
    reject('purl_characters', { observedUri: typeof uri === 'string' ? uri : null });
  if (uri.includes('#')) reject('purl_fragment', { observedUri: uri });
  if (!uri.startsWith('pkg:docker/')) reject('purl_type', { observedUri: uri });
  const value = uri.slice('pkg:docker/'.length);
  if ((value.match(/\?/gu) ?? []).length !== 1) reject('purl_query', { observedUri: uri });
  const [path, query] = value.split('?');
  if (!path || !query) reject('purl_shape', { observedUri: uri });
  if ((path.match(/@/gu) ?? []).length !== 1) reject('purl_version_shape', { observedUri: uri });
  const separator = path.indexOf('@');
  const packageName = path.slice(0, separator);
  const version = path.slice(separator + 1);
  if (!packageName || !version) reject('purl_empty_version', { observedUri: uri });
  if (packageName.includes('%') || version.includes('%'))
    reject('purl_path_encoding', { observedUri: uri });

  const qualifiers = new Map();
  for (const component of query.split('&')) {
    if (!component || (component.match(/=/gu) ?? []).length !== 1)
      reject('purl_qualifier_shape', { observedUri: uri });
    const [key, rawValue] = component.split('=');
    if (!['digest', 'platform'].includes(key))
      reject('purl_unknown_qualifier', { observedUri: uri });
    if (qualifiers.has(key)) reject('purl_duplicate_qualifier', { observedUri: uri });
    qualifiers.set(key, {
      raw: rawValue,
      decoded: decodeQualifier(rawValue, 'purl_empty_qualifier'),
    });
  }
  if (qualifiers.size !== 2 || !qualifiers.has('digest') || !qualifiers.has('platform'))
    reject('purl_missing_qualifier', { observedUri: uri });
  if (qualifiers.get('platform').raw !== 'linux%2Famd64')
    reject('purl_platform_encoding', { observedUri: uri });
  if (qualifiers.get('platform').decoded !== 'linux/amd64')
    reject('purl_platform', { observedUri: uri });
  const digest = qualifiers.get('digest').decoded;
  if (qualifiers.get('digest').raw !== digest || !/^sha256:[a-f0-9]{64}$/u.test(digest))
    reject('purl_digest', { observedUri: uri });
  const normalizedPackageName = NORMALIZED_PACKAGES.get(packageName);
  if (!normalizedPackageName) reject('purl_package', { observedUri: uri });
  return {
    type: 'docker',
    packageName: normalizedPackageName,
    version,
    digest,
    platform: 'linux/amd64',
  };
}

function expectedBases(lock, service) {
  const byId = new Map(lock.images.map((image) => [image.id, image]));
  const ids =
    service === 'web'
      ? ['node-runtime-build-base', 'nginx-web-runtime', 'buildkit-syft-scanner']
      : ['node-runtime-build-base', 'buildkit-syft-scanner'];
  return ids.map((id) => {
    const image = byId.get(id);
    const identity = BASE_IDENTITIES.get(id);
    if (
      !image ||
      !identity ||
      image.registry !== identity.registry ||
      image.repository !== identity.repository
    )
      reject('base_lock_identity', { logicalId: id });
    return {
      logicalId: id,
      packageName: identity.packageName,
      repository: `${image.registry}/${image.repository}`,
      tag: image.tag,
      digest: image.indexDigest,
    };
  });
}

function validateBaseMaterial(material, expected) {
  const observedUri = isRecord(material) && typeof material.uri === 'string' ? material.uri : null;
  const observedDigest =
    isRecord(material) && isRecord(material.digest) && typeof material.digest.sha256 === 'string'
      ? material.digest.sha256
      : null;
  const details = {
    logicalId: expected.logicalId,
    expectedRepository: expected.repository,
    expectedTag: expected.tag,
    expectedDigest: expected.digest,
    observedUri,
    observedDigest,
  };
  if (!exactKeys(material, ['uri', 'digest'])) reject('material_shape', details);
  if (!exactKeys(material.digest, ['sha256'])) reject('material_digest_shape', details);
  if (!SHA256.test(material.digest.sha256)) reject('material_digest', details);
  if (`sha256:${material.digest.sha256}` !== expected.digest)
    reject('material_digest_mismatch', details);
  let parsed;
  try {
    parsed = parseCanonicalBuildkitPurl(material.uri);
  } catch (error) {
    if (error instanceof ProvenanceMaterialsError)
      reject(error.reason, { ...details, ...error.details });
    throw error;
  }
  if (parsed.type !== 'docker') reject('material_type', details);
  if (parsed.packageName !== expected.packageName) reject('material_repository', details);
  if (parsed.version !== expected.tag) reject('material_tag', details);
  if (parsed.digest !== expected.digest) reject('material_qualifier_digest', details);
  if (parsed.platform !== 'linux/amd64') reject('material_platform', details);
}

function validateSourceMaterial(material, sourceSha) {
  if (!exactKeys(material, ['uri', 'digest'])) reject('source_material_shape');
  if (!exactKeys(material.digest, ['sha1'])) reject('source_material_digest_shape');
  if (
    material.uri !== `https://github.com/${REPOSITORY}.git#${sourceSha}` ||
    material.digest.sha1 !== sourceSha
  )
    reject('source_material');
}

export function validateProvenanceMaterials({
  statement,
  service,
  sourceSha,
  builderId,
  runtimeDigest,
  dockerfilePath,
  repository,
  baseLock,
}) {
  if (!SERVICE_SET.has(service)) reject('service');
  if (!SHA1.test(sourceSha)) reject('source_sha');
  if (!/^sha256:[a-f0-9]{64}$/u.test(runtimeDigest)) reject('runtime_digest');
  if (repository !== REPOSITORY) reject('repository');
  if (dockerfilePath !== `apps/${service}/Dockerfile`) reject('dockerfile_path');
  if (
    typeof builderId !== 'string' ||
    !/^https:\/\/github\.com\/Z6v6e6r\/lk2\/actions\/runs\/[1-9][0-9]*\/attempts\/[1-9][0-9]*$/u.test(
      builderId,
    )
  )
    reject('builder_input');
  validateBaseImageLock(baseLock);
  if (!exactKeys(statement, ['_type', 'predicateType', 'subject', 'predicate']))
    reject('statement_shape');
  if (statement._type !== STATEMENT_TYPE || statement.predicateType !== PREDICATE_TYPE)
    reject('statement_type');
  if (!Array.isArray(statement.subject) || statement.subject.length !== 1) reject('subject_count');
  const subject = statement.subject[0];
  if (!exactKeys(subject, ['name', 'digest']) || !exactKeys(subject.digest, ['sha256']))
    reject('subject_shape');
  if (subject.digest.sha256 !== runtimeDigest.slice('sha256:'.length)) reject('subject_digest');
  if (typeof subject.name !== 'string' || !PRINTABLE_ASCII.test(subject.name))
    reject('subject_name');

  const predicate = statement.predicate;
  if (
    !isRecord(predicate) ||
    !isRecord(predicate.buildDefinition) ||
    !isRecord(predicate.runDetails)
  )
    reject('predicate_shape');
  const buildDefinition = predicate.buildDefinition;
  if (buildDefinition.buildType !== BUILD_TYPE) reject('build_type');
  if (!isRecord(buildDefinition.externalParameters)) reject('external_parameters');
  const configSource = buildDefinition.externalParameters.configSource;
  if (!exactKeys(configSource, ['uri', 'digest', 'path'])) reject('config_source_shape');
  if (
    configSource.uri !== `https://github.com/${repository}.git#${sourceSha}` ||
    !exactKeys(configSource.digest, ['sha1']) ||
    configSource.digest.sha1 !== sourceSha ||
    configSource.path !== dockerfilePath
  )
    reject('config_source');
  if (
    !exactKeys(predicate.runDetails.builder, ['id']) ||
    predicate.runDetails.builder.id !== builderId
  )
    reject('builder');
  if (
    !isRecord(predicate.runDetails.metadata) ||
    !isRecord(predicate.runDetails.metadata.buildkit_completeness) ||
    predicate.runDetails.metadata.buildkit_completeness.resolvedDependencies !== true
  )
    reject('materials_completeness');
  const materials = buildDefinition.resolvedDependencies;
  if (!Array.isArray(materials)) reject('materials_shape');
  const bases = expectedBases(baseLock, service);
  if (materials.length !== bases.length + 1) reject('material_count');

  let sourceCount = 0;
  const seen = new Set();
  for (const material of materials) {
    if (isRecord(material) && exactKeys(material.digest, ['sha1'])) {
      validateSourceMaterial(material, sourceSha);
      sourceCount += 1;
      continue;
    }
    if (!isRecord(material) || typeof material.uri !== 'string') reject('material_shape');
    const parsed = parseCanonicalBuildkitPurl(material.uri);
    const expected = bases.find((candidate) => candidate.packageName === parsed.packageName);
    if (!expected) reject('material_repository', { observedUri: material.uri });
    if (seen.has(expected.logicalId))
      reject('duplicate_material', { logicalId: expected.logicalId, observedUri: material.uri });
    validateBaseMaterial(material, expected);
    seen.add(expected.logicalId);
  }
  if (sourceCount !== 1) reject('source_material_count');
  if (seen.size !== bases.length) reject('missing_material');
  for (const expected of bases)
    if (!seen.has(expected.logicalId))
      reject('missing_material', { logicalId: expected.logicalId });
  return {
    service,
    sourceSha,
    builderId,
    dockerfilePath,
    repository,
    runtimeDigest,
    materials: bases.map(({ logicalId, repository: baseRepository, tag, digest }) => ({
      logicalId,
      repository: baseRepository,
      tag,
      digest,
    })),
  };
}

function writeDiagnostic(path, diagnostic) {
  if (!path) return;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW;
  const descriptor = openSync(path, flags, 0o600);
  try {
    writeFileSync(descriptor, `${JSON.stringify(diagnostic, null, 2)}\n`, 'utf8');
  } finally {
    closeSync(descriptor);
  }
}

function parseArguments(arguments_) {
  const [mode, ...options] = arguments_;
  if (mode !== 'verify') reject('usage');
  const values = {};
  for (let index = 0; index < options.length; index += 2) {
    const option = options[index];
    const value = options[index + 1];
    if (!option?.startsWith('--') || !value) reject('usage');
    const key = option.slice(2);
    if (values[key] !== undefined) reject('duplicate_option');
    values[key] = value;
  }
  for (const key of [
    'statement',
    'service',
    'source-sha',
    'builder-id',
    'runtime-digest',
    'dockerfile-path',
    'repository',
    'base-lock',
  ])
    if (!values[key]) reject('usage');
  return values;
}

async function main() {
  let values;
  try {
    values = parseArguments(process.argv.slice(2));
    const statementPath = resolve(values.statement);
    const baseLockPath = resolve(values['base-lock']);
    const statement = parseStrict(regularFileBytes(statementPath, 'statement_file'), 'statement');
    const baseLock = parseStrict(regularFileBytes(baseLockPath, 'base_lock_file'), 'base_lock');
    const evidence = validateProvenanceMaterials({
      statement,
      service: values.service,
      sourceSha: values['source-sha'],
      builderId: values['builder-id'],
      runtimeDigest: values['runtime-digest'],
      dockerfilePath: values['dockerfile-path'],
      repository: values.repository,
      baseLock,
    });
    writeDiagnostic(values.diagnostic, {
      schemaVersion: 1,
      kind: 'phub-timeweb-provenance-material-diagnostic',
      service: values.service,
      verified: true,
      materialCount: evidence.materials.length + 1,
      authorizesPublication: false,
      authorizesDeploy: false,
    });
    process.stdout.write(
      `TIMEWEB_PROVENANCE_MATERIALS_PASSED|service=${values.service}|materials=${evidence.materials.length + 1}|authorizes_publication=false|authorizes_deploy=false\n`,
    );
  } catch (error) {
    const failure =
      error instanceof ProvenanceMaterialsError
        ? error
        : new ProvenanceMaterialsError('verification_error');
    try {
      writeDiagnostic(values?.diagnostic, {
        schemaVersion: 1,
        kind: 'phub-timeweb-provenance-material-diagnostic',
        service: values?.service ?? null,
        logicalId: failure.details.logicalId ?? null,
        expectedRepository: failure.details.expectedRepository ?? null,
        expectedTag: failure.details.expectedTag ?? null,
        expectedDigest: failure.details.expectedDigest ?? null,
        observedUri: failure.details.observedUri ?? null,
        observedDigest: failure.details.observedDigest ?? null,
        reason: failure.reason,
        verified: false,
        authorizesPublication: false,
        authorizesDeploy: false,
      });
    } catch {
      // The workflow pre-creates a non-authorizing placeholder so diagnostics never mask custody.
    }
    process.stderr.write(`TIMEWEB_PROVENANCE_MATERIALS_FAILED|reason=${failure.reason}\n`);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
