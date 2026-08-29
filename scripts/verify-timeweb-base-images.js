#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { appendFileSync, lstatSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { parseStrictJson, StrictJsonError } from './strict-json.js';

export class BaseImageContractError extends Error {
  constructor(reason) {
    super(reason);
    this.name = 'BaseImageContractError';
    this.reason = reason;
  }
}

const SCHEMA = 'PHUB_TIMEWEB_BASE_IMAGES_V2';
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const NORMAL_MANIFEST_MEDIA_TYPES = new Set([
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
]);
const NORMAL_CONFIG_MEDIA_TYPES = new Set([
  'application/vnd.oci.image.config.v1+json',
  'application/vnd.docker.container.image.v1+json',
]);
const NORMAL_LAYER_MEDIA_TYPES = new Set([
  'application/vnd.oci.image.layer.v1.tar',
  'application/vnd.oci.image.layer.v1.tar+gzip',
  'application/vnd.oci.image.layer.v1.tar+zstd',
  'application/vnd.docker.image.rootfs.diff.tar',
  'application/vnd.docker.image.rootfs.diff.tar.gzip',
]);
const REGISTRY_TIMEOUT_MS = 20_000;
const TOKEN_MAX_BYTES = 1024 * 1024;
const MANIFEST_MAX_BYTES = 4 * 1024 * 1024;
const CONFIG_MAX_BYTES = 16 * 1024 * 1024;
const EXPECTED = new Map([
  [
    'node-runtime-build-base',
    {
      registry: 'docker.io',
      repository: 'library/node',
      consumers: [
        'api/build',
        'api/production',
        'migrator/build',
        'migrator/production',
        'realtime/build',
        'realtime/production',
        'web/build',
        'worker/build',
        'worker/production',
      ],
    },
  ],
  [
    'nginx-web-runtime',
    { registry: 'docker.io', repository: 'library/nginx', consumers: ['web/runtime'] },
  ],
  [
    'buildkit-syft-scanner',
    {
      registry: 'docker.io',
      repository: 'docker/buildkit-syft-scanner',
      consumers: [
        'api/sbom-generator',
        'migrator/sbom-generator',
        'realtime/sbom-generator',
        'web/sbom-generator',
        'worker/sbom-generator',
      ],
    },
  ],
]);

function reject(reason) {
  throw new BaseImageContractError(reason);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, keys) {
  return isRecord(value) && Object.keys(value).sort().join('|') === [...keys].sort().join('|');
}

function hash(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function validateDescriptor(descriptor, kind) {
  if (
    !isRecord(descriptor) ||
    !DIGEST.test(descriptor.digest) ||
    !Number.isInteger(descriptor.size) ||
    descriptor.size <= 0
  )
    reject(`${kind}_descriptor`);
}

function imageReferences(image) {
  const repository = `${image.registry}/${image.repository}`;
  return {
    repository,
    tagged: `${repository}:${image.tag}`,
    index: `${repository}:${image.tag}@${image.indexDigest}`,
    manifest: `${repository}@${image.platform.manifestDigest}`,
  };
}

export function parseBaseImageLock(bytes) {
  try {
    return parseStrictJson(bytes);
  } catch (error) {
    if (error instanceof StrictJsonError) reject(error.reason);
    reject('invalid_json');
  }
}

export function validateBaseImageLock(lock) {
  if (
    !exactKeys(lock, ['schema', 'images']) ||
    lock.schema !== SCHEMA ||
    !Array.isArray(lock.images)
  )
    reject('lock_shape');
  if (lock.images.length !== EXPECTED.size) reject('logical_image_set');
  const seen = new Set();
  for (const image of lock.images) {
    if (
      !exactKeys(image, [
        'id',
        'registry',
        'repository',
        'tag',
        'indexDigest',
        'platform',
        'consumers',
      ])
    )
      reject('image_shape');
    const expectation = EXPECTED.get(image.id);
    if (!expectation || seen.has(image.id)) reject('logical_image_set');
    seen.add(image.id);
    if (image.registry !== expectation.registry || image.repository !== expectation.repository)
      reject('repository_binding');
    if (typeof image.tag !== 'string' || !/^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,127}$/u.test(image.tag))
      reject('tag');
    if (!DIGEST.test(image.indexDigest)) reject('index_digest');
    if (
      !exactKeys(image.platform, ['os', 'architecture', 'variant', 'manifestDigest']) ||
      image.platform.os !== 'linux' ||
      image.platform.architecture !== 'amd64' ||
      image.platform.variant !== '' ||
      !DIGEST.test(image.platform.manifestDigest)
    )
      reject('platform');
    if (!Array.isArray(image.consumers)) reject('consumers');
    const consumers = image.consumers.map((consumer) => {
      if (!exactKeys(consumer, ['service', 'stage'])) reject('consumer_shape');
      if (
        typeof consumer.service !== 'string' ||
        typeof consumer.stage !== 'string' ||
        !/^[a-z][a-z0-9-]*$/u.test(consumer.service) ||
        !/^[a-z][a-z0-9-]*$/u.test(consumer.stage)
      )
        reject('consumer_value');
      return `${consumer.service}/${consumer.stage}`;
    });
    if (
      new Set(consumers).size !== consumers.length ||
      consumers.sort().join('|') !== [...expectation.consumers].sort().join('|')
    )
      reject('consumers');
  }
  if ([...EXPECTED.keys()].some((id) => !seen.has(id))) reject('logical_image_set');
  return lock;
}

export function validateDockerfiles(lock, repoRoot) {
  const expectedStages = new Map();
  for (const image of lock.images) {
    if (image.id === 'buildkit-syft-scanner') continue;
    for (const consumer of image.consumers) {
      expectedStages.set(`${consumer.service}/${consumer.stage}`, imageReferences(image).index);
    }
  }
  const observedStages = new Map();
  for (const service of ['web', 'api', 'worker', 'realtime', 'migrator']) {
    const dockerfilePath = resolve(repoRoot, 'apps', service, 'Dockerfile');
    if (!dockerfilePath.startsWith(`${resolve(repoRoot)}/`)) reject('dockerfile_path');
    let contents;
    try {
      const stat = lstatSync(dockerfilePath);
      if (!stat.isFile() || stat.isSymbolicLink()) reject('dockerfile_type');
      contents = readFileSync(dockerfilePath, 'utf8');
    } catch (error) {
      if (error instanceof BaseImageContractError) throw error;
      reject('dockerfile_unavailable');
    }
    if (/^ARG\s+[^\n]*(?:BASE|IMAGE|NODE|NGINX)[^\n]*$/imu.test(contents)) reject('base_arg');
    const fromLines = contents.match(/^FROM\s+.*$/gimu) ?? [];
    for (let index = 0; index < fromLines.length; index += 1) {
      const match = fromLines[index].match(
        /^FROM\s+(?:--platform=[^\s]+\s+)?([^\s]+)(?:\s+AS\s+([a-zA-Z0-9_.-]+))?\s*$/iu,
      );
      if (!match || match[1].includes('$')) reject('from_shape');
      const stage =
        match[2]?.toLowerCase() ?? (service === 'web' && index === 1 ? 'runtime' : 'production');
      const key = `${service}/${stage}`;
      if (observedStages.has(key)) reject('duplicate_stage');
      observedStages.set(key, match[1]);
    }
  }
  if (observedStages.size !== expectedStages.size) reject('dockerfile_stage_set');
  for (const [stage, expectedReference] of expectedStages) {
    const reference = observedStages.get(stage);
    if (!reference) reject('missing_stage');
    if (reference !== expectedReference) reject('dockerfile_lock_mismatch');
    if (!reference.includes('@sha256:')) reject('mutable_from');
  }
  for (const stage of observedStages.keys())
    if (!expectedStages.has(stage)) reject('unknown_stage');
}

export function validateRegistryProof(image, { indexBytes, childBytes, configBytes }) {
  if (hash(indexBytes) !== image.indexDigest) reject('index_hash');
  const index = parseBaseImageLock(indexBytes);
  if (
    index.schemaVersion !== 2 ||
    ![
      'application/vnd.oci.image.index.v1+json',
      'application/vnd.docker.distribution.manifest.list.v2+json',
    ].includes(index.mediaType) ||
    !Array.isArray(index.manifests)
  )
    reject('index_manifest');
  const runnable = index.manifests.filter(
    (descriptor) =>
      descriptor?.platform?.os === 'linux' &&
      descriptor?.platform?.architecture === 'amd64' &&
      (descriptor.platform.variant ?? '') === '',
  );
  if (runnable.length !== 1) reject('amd64_child_count');
  const descriptor = runnable[0];
  validateDescriptor(descriptor, 'child');
  if (
    descriptor.digest !== image.platform.manifestDigest ||
    !NORMAL_MANIFEST_MEDIA_TYPES.has(descriptor.mediaType) ||
    descriptor.artifactType !== undefined ||
    descriptor.subject !== undefined ||
    descriptor.annotations?.['vnd.docker.reference.type'] !== undefined
  )
    reject('child_descriptor');
  if (hash(childBytes) !== descriptor.digest) reject('child_hash');
  const child = parseBaseImageLock(childBytes);
  if (
    child.schemaVersion !== 2 ||
    !NORMAL_MANIFEST_MEDIA_TYPES.has(child.mediaType) ||
    child.artifactType !== undefined ||
    child.subject !== undefined ||
    !isRecord(child.config) ||
    !NORMAL_CONFIG_MEDIA_TYPES.has(child.config.mediaType) ||
    child.config.mediaType === 'application/vnd.oci.empty.v1+json' ||
    !Array.isArray(child.layers) ||
    child.layers.length === 0
  )
    reject('runtime_manifest');
  validateDescriptor(child.config, 'config');
  for (const layer of child.layers) {
    validateDescriptor(layer, 'layer');
    if (!NORMAL_LAYER_MEDIA_TYPES.has(layer.mediaType)) reject('runtime_layer');
  }
  if (hash(configBytes) !== child.config.digest) reject('config_hash');
  const config = parseBaseImageLock(configBytes);
  if (
    !isRecord(config) ||
    config.os !== 'linux' ||
    config.architecture !== 'amd64' ||
    ![undefined, ''].includes(config.variant)
  )
    reject('config_platform');
}

async function dockerHubToken(repository) {
  const url = new URL('https://auth.docker.io/token');
  url.searchParams.set('service', 'registry.docker.io');
  url.searchParams.set('scope', `repository:${repository}:pull`);
  const response = await registryFetch(url, { redirect: 'error' });
  if (!response.ok || response.url !== url.href) reject('registry_token');
  const body = parseBaseImageLock(await boundedResponseBytes(response, TOKEN_MAX_BYTES));
  if (!isRecord(body) || typeof body.token !== 'string' || body.token.length < 20)
    reject('registry_token');
  return body.token;
}

async function registryFetch(url, options) {
  try {
    return await fetch(url, {
      ...options,
      signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
    });
  } catch {
    reject('registry_read');
  }
}

async function boundedResponseBytes(response, maximumBytes) {
  const declaredLength = response.headers.get('content-length');
  if (declaredLength !== null) {
    if (!/^[0-9]+$/u.test(declaredLength) || Number(declaredLength) > maximumBytes)
      reject('registry_size');
  }
  if (!response.body) reject('registry_read');
  const chunks = [];
  let total = 0;
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        reject('registry_size');
      }
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    if (error instanceof BaseImageContractError) throw error;
    reject('registry_read');
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

async function registryBytes(repository, reference, token, accept, blob = false) {
  const url = new URL(
    `https://registry-1.docker.io/v2/${repository}/${blob ? 'blobs' : 'manifests'}/${reference}`,
  );
  const response = await registryFetch(url, {
    headers: { Accept: accept, Authorization: `Bearer ${token}` },
    redirect: 'manual',
  });
  const maximumBytes = blob ? CONFIG_MAX_BYTES : MANIFEST_MAX_BYTES;
  if (response.ok && response.url === url.href) return boundedResponseBytes(response, maximumBytes);
  if (!blob || ![301, 302, 307, 308].includes(response.status)) reject('registry_read');
  const location = response.headers.get('location');
  if (!location) reject('registry_redirect');
  const redirect = new URL(location);
  if (redirect.protocol !== 'https:' || redirect.hostname !== 'production.cloudfront.docker.com')
    reject('registry_redirect');
  const redirected = await registryFetch(redirect, { redirect: 'error' });
  if (!redirected.ok) reject('registry_read');
  return boundedResponseBytes(redirected, maximumBytes);
}

async function verifyRegistry(lock) {
  const accept = [
    'application/vnd.oci.image.index.v1+json',
    'application/vnd.docker.distribution.manifest.list.v2+json',
    'application/vnd.oci.image.manifest.v1+json',
    'application/vnd.docker.distribution.manifest.v2+json',
  ].join(', ');
  for (const image of lock.images) {
    const token = await dockerHubToken(image.repository);
    const indexBytes = await registryBytes(image.repository, image.indexDigest, token, accept);
    const childBytes = await registryBytes(
      image.repository,
      image.platform.manifestDigest,
      token,
      accept,
    );
    const child = parseBaseImageLock(childBytes);
    if (!isRecord(child.config) || !DIGEST.test(child.config.digest)) reject('config_descriptor');
    const configBytes = await registryBytes(
      image.repository,
      child.config.digest,
      token,
      'application/octet-stream',
      true,
    );
    validateRegistryProof(image, { indexBytes, childBytes, configBytes });
  }
}

export function baseImageEvidence(lock, rawBytes) {
  return {
    baseLock: { schema: SCHEMA, sha256: hash(rawBytes).slice('sha256:'.length) },
    baseImages: lock.images
      .map((image) => ({
        id: image.id,
        registry: image.registry,
        repository: image.repository,
        tag: image.tag,
        indexDigest: image.indexDigest,
        manifestDigest: image.platform.manifestDigest,
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  };
}

function outputValues(lock, rawBytes) {
  const byId = new Map(lock.images.map((image) => [image.id, image]));
  const node = byId.get('node-runtime-build-base');
  const nginx = byId.get('nginx-web-runtime');
  const scanner = byId.get('buildkit-syft-scanner');
  return {
    base_lock_schema: SCHEMA,
    base_lock_sha256: hash(rawBytes).slice('sha256:'.length),
    node_index_digest: node.indexDigest,
    node_manifest_digest: node.platform.manifestDigest,
    nginx_index_digest: nginx.indexDigest,
    nginx_manifest_digest: nginx.platform.manifestDigest,
    scanner_index_digest: scanner.indexDigest,
    scanner_manifest_digest: scanner.platform.manifestDigest,
    scanner_immutable_reference: imageReferences(scanner).index,
  };
}

async function main() {
  const [mode, ...options] = process.argv.slice(2);
  if (!['static', 'registry', 'all'].includes(mode)) reject('usage');
  let lockPath = 'deploy/timeweb/base-images.lock.json';
  let repoRoot = '.';
  let githubOutput;
  let evidence = false;
  for (let index = 0; index < options.length; index += 1) {
    const option = options[index];
    if (option === '--evidence-json') {
      evidence = true;
      continue;
    }
    const value = options[index + 1];
    if (!value) reject('usage');
    if (option === '--lock') lockPath = value;
    else if (option === '--repo-root') repoRoot = value;
    else if (option === '--github-output') githubOutput = value;
    else reject('usage');
    index += 1;
  }
  const resolvedRoot = resolve(repoRoot);
  const resolvedLock = resolve(lockPath);
  if (!resolvedLock.startsWith(`${resolvedRoot}/`)) reject('lock_path');
  const stat = lstatSync(resolvedLock);
  if (!stat.isFile() || stat.isSymbolicLink()) reject('lock_type');
  const rawBytes = readFileSync(resolvedLock);
  const lock = validateBaseImageLock(parseBaseImageLock(rawBytes));
  if (mode === 'static' || mode === 'all') validateDockerfiles(lock, resolvedRoot);
  if (mode === 'registry' || mode === 'all') await verifyRegistry(lock);
  if (githubOutput) {
    const lines = Object.entries(outputValues(lock, rawBytes)).map(
      ([key, value]) => `${key}=${value}`,
    );
    if (lines.some((line) => line.includes('\n') || line.includes('\r'))) reject('output_value');
    appendFileSync(githubOutput, `${lines.join('\n')}\n`, { encoding: 'utf8' });
  }
  if (evidence)
    process.stdout.write(`${JSON.stringify(baseImageEvidence(lock, rawBytes), null, 2)}\n`);
  else process.stdout.write(`TIMEWEB_BASE_IMAGES_PASSED|mode=${mode}|values_printed=false\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    const reason = error instanceof BaseImageContractError ? error.reason : 'verification_error';
    process.stderr.write(`TIMEWEB_BASE_IMAGES_FAILED|reason=${reason}\n`);
    process.exit(1);
  });
}
