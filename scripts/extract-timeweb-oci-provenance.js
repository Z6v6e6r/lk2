#!/usr/bin/env node
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

import { parseStrictJson, StrictJsonError } from './strict-json.js';

const INDEX_TYPES = new Set([
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
]);
const MANIFEST_TYPES = new Set([
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
]);
const SHA256_DIGEST = /^sha256:[a-f0-9]{64}$/u;

export class OciProvenanceExtractionError extends Error {
  constructor(reason) {
    super(reason);
    this.name = 'OciProvenanceExtractionError';
    this.reason = reason;
  }
}

function reject(reason) {
  throw new OciProvenanceExtractionError(reason);
}

function readStrict(path, reason) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) reject(`${reason}_file`);
  const bytes = readFileSync(path);
  try {
    return { value: parseStrictJson(bytes), bytes };
  } catch (error) {
    if (error instanceof StrictJsonError) reject(`${reason}_${error.reason}`);
    reject(reason);
  }
}

function descriptorBlob(layout, descriptor) {
  if (!descriptor || !SHA256_DIGEST.test(descriptor.digest)) reject('descriptor_digest');
  const path = join(layout, 'blobs', 'sha256', descriptor.digest.slice('sha256:'.length));
  const result = readStrict(path, 'blob');
  if (`sha256:${createHash('sha256').update(result.bytes).digest('hex')}` !== descriptor.digest)
    reject('blob_digest');
  if (Number.isSafeInteger(descriptor.size) && descriptor.size !== result.bytes.length)
    reject('blob_size');
  return result.value;
}

function platformMatches(descriptor, os, architecture) {
  return (
    descriptor?.platform?.os === os &&
    descriptor?.platform?.architecture === architecture &&
    (descriptor.platform.variant ?? '') === ''
  );
}

export function extractTimewebOciProvenance(layoutPath) {
  const layout = resolve(layoutPath);
  const layoutVersion = readStrict(join(layout, 'oci-layout'), 'layout').value;
  if (layoutVersion?.imageLayoutVersion !== '1.0.0') reject('layout_version');
  const root = readStrict(join(layout, 'index.json'), 'index').value;
  if (!Array.isArray(root?.manifests)) reject('index_shape');

  const descriptors = [];
  const pending = [...root.manifests];
  const followed = new Set();
  while (pending.length > 0) {
    const descriptor = pending.shift();
    if (INDEX_TYPES.has(descriptor?.mediaType)) {
      if (followed.has(descriptor.digest)) reject('index_cycle');
      followed.add(descriptor.digest);
      const nested = descriptorBlob(layout, descriptor);
      if (!Array.isArray(nested?.manifests)) reject('nested_index_shape');
      pending.push(...nested.manifests);
    } else {
      descriptors.push(descriptor);
    }
  }

  const runtimes = descriptors.filter(
    (descriptor) =>
      MANIFEST_TYPES.has(descriptor?.mediaType) && platformMatches(descriptor, 'linux', 'amd64'),
  );
  if (runtimes.length !== 1) reject('runtime_count');
  const runtime = runtimes[0];
  const attestations = descriptors.filter(
    (descriptor) =>
      MANIFEST_TYPES.has(descriptor?.mediaType) &&
      platformMatches(descriptor, 'unknown', 'unknown') &&
      descriptor.annotations?.['vnd.docker.reference.type'] === 'attestation-manifest' &&
      descriptor.annotations?.['vnd.docker.reference.digest'] === runtime.digest,
  );
  if (attestations.length !== 1) reject('attestation_count');
  const attestation = descriptorBlob(layout, attestations[0]);
  if (attestation?.subject?.digest !== runtime.digest || !Array.isArray(attestation.layers))
    reject('attestation_subject');
  const provenanceLayers = attestation.layers.filter(
    (layer) =>
      layer?.mediaType === 'application/vnd.in-toto+json' &&
      layer.annotations?.['in-toto.io/predicate-type'] === 'https://slsa.dev/provenance/v1',
  );
  if (provenanceLayers.length !== 1) reject('provenance_layer_count');
  const statement = descriptorBlob(layout, provenanceLayers[0]);
  if (statement?.predicateType !== 'https://slsa.dev/provenance/v1') reject('provenance_statement');
  return { runtimeDigest: runtime.digest, statement };
}

function parseArguments(values) {
  if (values.length !== 7 || values[0] !== 'extract') reject('usage');
  const options = new Map();
  for (let index = 1; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (!key?.startsWith('--') || !value || options.has(key)) reject('usage');
    options.set(key, value);
  }
  if (!options.has('--layout') || !options.has('--statement') || !options.has('--github-output'))
    reject('usage');
  return options;
}

async function main() {
  try {
    const options = parseArguments(process.argv.slice(2));
    const evidence = extractTimewebOciProvenance(options.get('--layout'));
    const statementPath = resolve(options.get('--statement'));
    mkdirSync(dirname(statementPath), { recursive: true, mode: 0o700 });
    writeFileSync(statementPath, `${JSON.stringify(evidence.statement)}\n`, {
      mode: 0o600,
      flag: 'wx',
    });
    writeFileSync(
      resolve(options.get('--github-output')),
      `runtime_digest=${evidence.runtimeDigest}\nstatement=${statementPath}\n`,
      { encoding: 'utf8', flag: 'a' },
    );
    process.stdout.write(`TIMEWEB_OCI_PROVENANCE_EXTRACTED|runtime=${evidence.runtimeDigest}\n`);
  } catch (error) {
    const reason =
      error instanceof OciProvenanceExtractionError ? error.reason : 'extraction_error';
    process.stderr.write(`TIMEWEB_OCI_PROVENANCE_EXTRACTION_FAILED|reason=${reason}\n`);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
