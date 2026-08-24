#!/usr/bin/env node
import { readFileSync } from 'node:fs';

function fail(reason) {
  process.stderr.write(`TIMEWEB_RELEASE_MANIFEST_FAILED|reason=${reason}\n`);
  process.exit(1);
}

const [manifestPath, outputMode] = process.argv.slice(2);
if (process.argv.length !== 3 && process.argv.length !== 4) fail('usage');
let schema;
try {
  schema = JSON.parse(
    readFileSync(
      new URL('../deploy/timeweb/release-manifest.schema.json', import.meta.url),
      'utf8',
    ),
  );
} catch {
  fail('schema_unavailable');
}
const COMPONENTS = schema.properties.images.items.properties.component.enum;
const COMMIT = schema.properties.gitCommit.const;
const REPOSITORY = schema.properties.repository.const;
let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
} catch {
  fail('invalid_json');
}
if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) fail('shape');
if (Object.keys(manifest).sort().join(',') !== schema.required.sort().join(',')) fail('keys');
if (
  manifest.schemaVersion !== schema.properties.schemaVersion.const ||
  manifest.repository !== REPOSITORY ||
  manifest.gitCommit !== COMMIT ||
  manifest.platform !== schema.properties.platform.const ||
  !Array.isArray(manifest.images) ||
  manifest.images.length !== schema.properties.images.maxItems
)
  fail('header');

const seen = new Set();
for (const image of manifest.images) {
  if (image === null || typeof image !== 'object' || Array.isArray(image)) fail('image_shape');
  if (
    Object.keys(image).sort().join(',') !== schema.properties.images.items.required.sort().join(',')
  )
    fail('image_keys');
  const {
    component,
    repository,
    digest,
    architecture,
    revision,
    provenance,
    sbom,
    reconciliation,
  } = image;
  if (!COMPONENTS.includes(component) || seen.has(component)) fail('component_set');
  seen.add(component);
  if (repository !== `ghcr.io/z6v6e6r/phub-${component}`) fail('repository');
  if (
    typeof digest !== 'string' ||
    !new RegExp(schema.properties.images.items.properties.digest.pattern, 'u').test(digest)
  )
    fail('digest');
  if (
    architecture !== schema.properties.images.items.properties.architecture.const ||
    revision !== COMMIT ||
    provenance !== schema.properties.images.items.properties.provenance.const ||
    sbom !== schema.properties.images.items.properties.sbom.const ||
    reconciliation !== schema.properties.images.items.properties.reconciliation.const
  )
    fail('attestation');
}
if (COMPONENTS.some((component) => !seen.has(component))) fail('component_set');
if (outputMode === '--image-lines') {
  for (const image of manifest.images) {
    process.stdout.write(`${image.component}|${image.repository}|${image.digest}\n`);
  }
} else if (outputMode === undefined) {
  process.stdout.write('TIMEWEB_RELEASE_MANIFEST_PASSED|values_printed=false\n');
} else {
  fail('usage');
}
