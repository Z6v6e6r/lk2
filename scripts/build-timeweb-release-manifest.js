#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

function fail(reason) {
  process.stderr.write(`TIMEWEB_RELEASE_MANIFEST_BUILD_FAILED|reason=${reason}\n`);
  process.exit(1);
}

const [reconciliationPath, priorRunId, currentRunId, manifestPath, checksumPath] =
  process.argv.slice(2);
if (process.argv.length !== 7) fail('usage');

let schema;
let reconciliation;
try {
  schema = JSON.parse(
    readFileSync(
      new URL('../deploy/timeweb/release-manifest.schema.json', import.meta.url),
      'utf8',
    ),
  );
  reconciliation = JSON.parse(readFileSync(reconciliationPath, 'utf8'));
} catch {
  fail('input_unavailable');
}

const COMPONENTS = schema.properties.images.items.properties.component.enum;
const COMMIT = schema.properties.gitCommit.const;
const SOURCE_TREE = schema['x-sourceTree'];
const runIdPattern = new RegExp(schema.properties.reconciliationRuns.items.pattern, 'u');
if (
  !runIdPattern.test(priorRunId) ||
  !runIdPattern.test(currentRunId) ||
  priorRunId === currentRunId
)
  fail('reconciliation_runs');
if (reconciliation === null || typeof reconciliation !== 'object' || Array.isArray(reconciliation))
  fail('reconciliation_shape');
if (
  reconciliation.schemaVersion !== 1 ||
  reconciliation.kind !== 'phub-timeweb-amd64-publication-reconciliation' ||
  reconciliation.reconciliationRunId !== currentRunId ||
  reconciliation.reconciliationRunAttempt !== '1' ||
  reconciliation.authorizesDeploy !== false ||
  reconciliation.authorizesVpsProvisioning !== false ||
  reconciliation.authorizesDatabaseMutation !== false ||
  !Array.isArray(reconciliation.images) ||
  reconciliation.images.length !== COMPONENTS.length
)
  fail('reconciliation_header');

const byComponent = new Map();
for (const image of reconciliation.images) {
  if (image === null || typeof image !== 'object' || Array.isArray(image))
    fail('reconciliation_image_shape');
  if (!COMPONENTS.includes(image.service) || byComponent.has(image.service)) fail('component_set');
  if (
    image.repository !== `ghcr.io/z6v6e6r/phub-${image.service}` ||
    image.sourceSha !== COMMIT ||
    image.sourceTree !== SOURCE_TREE ||
    image.architecture !== schema.properties.images.items.properties.architecture.const ||
    typeof image.indexDigest !== 'string' ||
    !new RegExp(schema.properties.images.items.properties.digest.pattern, 'u').test(
      image.indexDigest,
    )
  )
    fail('image_identity');
  if (
    image.provenanceVerified !== true ||
    image.sbomVerified !== true ||
    image.reconciliationVerified !== true
  )
    fail('image_verification');
  byComponent.set(image.service, image);
}
if (COMPONENTS.some((component) => !byComponent.has(component))) fail('component_set');

const manifest = {
  schemaVersion: schema.properties.schemaVersion.const,
  repository: schema.properties.repository.const,
  gitCommit: COMMIT,
  platform: schema.properties.platform.const,
  images: COMPONENTS.map((component) => {
    const image = byComponent.get(component);
    return {
      component,
      repository: image.repository,
      digest: image.indexDigest,
      architecture: image.architecture,
      revision: image.sourceSha,
      provenance: image.provenanceVerified,
      sbom: image.sbomVerified,
      reconciliation: image.reconciliationVerified,
    };
  }),
  reconciliationRuns: [priorRunId, currentRunId],
};
const contents = `${JSON.stringify(manifest, null, 2)}\n`;
const checksum = createHash('sha256').update(contents).digest('hex');
try {
  writeFileSync(manifestPath, contents, { flag: 'wx' });
  writeFileSync(checksumPath, `${checksum}  release-manifest.json\n`, { flag: 'wx' });
} catch {
  fail('output_write');
}
process.stdout.write('TIMEWEB_RELEASE_MANIFEST_BUILT|values_printed=false\n');
