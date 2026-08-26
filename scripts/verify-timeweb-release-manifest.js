#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import {
  ReleaseManifestContractError,
  validateCanonicalManifest,
} from './timeweb-release-manifest-contract.js';

function fail(reason) {
  process.stderr.write(`TIMEWEB_RELEASE_MANIFEST_FAILED|reason=${reason}\n`);
  process.exit(1);
}

const [manifestPath, ...options] = process.argv.slice(2);
if (!manifestPath) fail('usage');
if (basename(manifestPath) !== 'release-manifest.json') fail('manifest_name');

let outputMode;
const expectedPublication = {};
let expectedBaseLockPath;
for (let index = 0; index < options.length; index += 1) {
  const option = options[index];
  if (option === '--image-lines' && outputMode === undefined) {
    outputMode = option;
    continue;
  }
  const value = options[index + 1];
  if (!value) fail('usage');
  if (option === '--expected-publication-workflow-sha') expectedPublication.workflowSha = value;
  else if (option === '--expected-publication-run-id') expectedPublication.runId = value;
  else if (option === '--expected-publication-run-attempt') expectedPublication.runAttempt = value;
  else if (option === '--expected-base-lock') expectedBaseLockPath = value;
  else fail('usage');
  index += 1;
}
const expectationKeys = Object.keys(expectedPublication);
if (expectationKeys.length !== 0 && expectationKeys.length !== 3) fail('publication_expectations');

const checksumPath = join(dirname(manifestPath), 'release-manifest.sha256');
let manifestContents;
let checksumContents;
try {
  const manifestStat = lstatSync(manifestPath);
  const checksumStat = lstatSync(checksumPath);
  if (
    !manifestStat.isFile() ||
    manifestStat.isSymbolicLink() ||
    !checksumStat.isFile() ||
    checksumStat.isSymbolicLink()
  )
    fail('input_type');
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
try {
  validateCanonicalManifest(manifest, {
    expectedPublication: expectationKeys.length === 3 ? expectedPublication : undefined,
    expectedBaseLockPath,
  });
} catch (error) {
  if (error instanceof ReleaseManifestContractError) fail(error.reason);
  fail('validation_error');
}

if (outputMode === '--image-lines') {
  for (const image of manifest.images) {
    process.stdout.write(`${image.component}|${image.repository}|${image.digest}\n`);
  }
} else {
  process.stdout.write('TIMEWEB_RELEASE_MANIFEST_PASSED|values_printed=false\n');
}
