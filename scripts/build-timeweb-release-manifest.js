#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';

import {
  ReleaseManifestContractError,
  buildCurrentManifest,
  validateCanonicalManifest,
} from './timeweb-release-manifest-contract.js';

function fail(reason) {
  process.stderr.write(`TIMEWEB_RELEASE_MANIFEST_BUILD_FAILED|reason=${reason}\n`);
  process.exit(1);
}

const [publicationPath, manifestPath, checksumPath] = process.argv.slice(2);
if (process.argv.length !== 5) fail('usage');
if (basename(publicationPath) !== 'timeweb-amd64-publication-manifest.json') fail('input_path');
if (
  basename(manifestPath) !== 'release-manifest.json' ||
  basename(checksumPath) !== 'release-manifest.sha256' ||
  resolve(dirname(manifestPath)) !== resolve(dirname(checksumPath))
)
  fail('output_path');

let publication;
try {
  publication = JSON.parse(readFileSync(publicationPath, 'utf8'));
} catch {
  fail('input_unavailable');
}

try {
  const manifest = buildCurrentManifest(publication);
  validateCanonicalManifest(manifest, {
    expectedPublication: {
      workflowSha: publication.workflowSha,
      runId: publication.runId,
      runAttempt: publication.runAttempt,
    },
  });
  const contents = `${JSON.stringify(manifest, null, 2)}\n`;
  const checksum = createHash('sha256').update(contents).digest('hex');
  writeFileSync(manifestPath, contents, { flag: 'wx' });
  writeFileSync(checksumPath, `${checksum}  release-manifest.json\n`, { flag: 'wx' });
} catch (error) {
  if (error instanceof ReleaseManifestContractError) fail(error.reason);
  fail('output_write');
}
process.stdout.write('TIMEWEB_RELEASE_MANIFEST_BUILT|values_printed=false\n');
