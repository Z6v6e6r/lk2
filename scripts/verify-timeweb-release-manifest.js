#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

function fail(reason) {
  process.stderr.write(`TIMEWEB_RELEASE_MANIFEST_FAILED|reason=${reason}\n`);
  process.exit(1);
}

const [manifestPath, outputMode] = process.argv.slice(2);
if (process.argv.length !== 3 && process.argv.length !== 4) fail('usage');
if (basename(manifestPath) !== 'release-manifest.json') fail('manifest_name');
const checksumPath = join(dirname(manifestPath), 'release-manifest.sha256');
let schema;
let manifestContents;
let checksumContents;
try {
  schema = JSON.parse(
    readFileSync(
      new URL('../deploy/timeweb/release-manifest.schema.json', import.meta.url),
      'utf8',
    ),
  );
  manifestContents = readFileSync(manifestPath, 'utf8');
  checksumContents = readFileSync(checksumPath, 'utf8');
} catch {
  fail('input_unavailable');
}
const checksumMatch = checksumContents.match(/^([a-f0-9]{64})  release-manifest\.json\n$/u);
if (!checksumMatch) fail('checksum_format');
if (createHash('sha256').update(manifestContents).digest('hex') !== checksumMatch[1])
  fail('checksum_mismatch');

let manifest;
try {
  manifest = JSON.parse(manifestContents);
} catch {
  fail('invalid_json');
}
if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) fail('shape');
if (Object.keys(manifest).sort().join(',') !== schema.required.toSorted().join(',')) fail('keys');
if (
  manifest.schemaVersion !== schema.properties.schemaVersion.const ||
  manifest.repository !== schema.properties.repository.const ||
  manifest.gitCommit !== schema.properties.gitCommit.const ||
  manifest.platform !== schema.properties.platform.const ||
  !Array.isArray(manifest.images) ||
  manifest.images.length !== schema.properties.images.maxItems
)
  fail('header');

const COMPONENTS = schema.properties.images.items.properties.component.enum;
const imageKeys = schema.properties.images.items.required.toSorted().join(',');
const digestPattern = new RegExp(schema.properties.images.items.properties.digest.pattern, 'u');
const seen = new Set();
for (const image of manifest.images) {
  if (image === null || typeof image !== 'object' || Array.isArray(image)) fail('image_shape');
  if (Object.keys(image).sort().join(',') !== imageKeys) fail('image_keys');
  if (!COMPONENTS.includes(image.component) || seen.has(image.component)) fail('component_set');
  seen.add(image.component);
  if (image.repository !== `ghcr.io/z6v6e6r/phub-${image.component}`) fail('repository');
  if (typeof image.digest !== 'string' || !digestPattern.test(image.digest)) fail('digest');
  if (
    image.architecture !== schema.properties.images.items.properties.architecture.const ||
    image.revision !== schema.properties.images.items.properties.revision.const ||
    image.provenance !== schema.properties.images.items.properties.provenance.const ||
    image.sbom !== schema.properties.images.items.properties.sbom.const ||
    image.reconciliation !== schema.properties.images.items.properties.reconciliation.const
  )
    fail('attestation');
}
if (COMPONENTS.some((component) => !seen.has(component))) fail('component_set');
const runIdPattern = new RegExp(schema.properties.reconciliationRuns.items.pattern, 'u');
if (
  !Array.isArray(manifest.reconciliationRuns) ||
  manifest.reconciliationRuns.length !== schema.properties.reconciliationRuns.maxItems ||
  new Set(manifest.reconciliationRuns).size !== manifest.reconciliationRuns.length ||
  !manifest.reconciliationRuns.every(
    (runId) => typeof runId === 'string' && runIdPattern.test(runId),
  )
)
  fail('reconciliation_runs');

if (outputMode === '--image-lines') {
  for (const image of manifest.images) {
    process.stdout.write(`${image.component}|${image.repository}|${image.digest}\n`);
  }
} else if (outputMode === undefined) {
  process.stdout.write('TIMEWEB_RELEASE_MANIFEST_PASSED|values_printed=false\n');
} else {
  fail('usage');
}
