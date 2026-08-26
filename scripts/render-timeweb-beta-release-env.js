#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { closeSync, constants, lstatSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import {
  ReleaseManifestContractError,
  validateCanonicalManifest,
} from './timeweb-release-manifest-contract.js';

const COMPONENT_VARIABLES = {
  web: 'WEB',
  api: 'API',
  worker: 'WORKER',
  realtime: 'REALTIME',
  migrator: 'MIGRATOR',
};

function fail(reason) {
  throw new Error(reason);
}

function readCanonicalPair(manifestPath) {
  if (basename(manifestPath) !== 'release-manifest.json') fail('manifest_name');
  const checksumPath = join(dirname(manifestPath), 'release-manifest.sha256');
  const manifestStat = lstatSync(manifestPath);
  const checksumStat = lstatSync(checksumPath);
  if (
    !manifestStat.isFile() ||
    manifestStat.isSymbolicLink() ||
    !checksumStat.isFile() ||
    checksumStat.isSymbolicLink()
  )
    fail('input_type');
  const contents = readFileSync(manifestPath, 'utf8');
  const checksum = readFileSync(checksumPath, 'utf8');
  const match = checksum.match(/^([a-f0-9]{64})  release-manifest\.json\n$/u);
  if (!match) fail('checksum_format');
  if (createHash('sha256').update(contents).digest('hex') !== match[1]) fail('checksum_mismatch');
  return JSON.parse(contents);
}

export function renderReleaseEnvironment(manifest, expected) {
  validateCanonicalManifest(manifest, { expectedPublication: expected });
  if (manifest.schemaVersion !== 'PHUB_TIMEWEB_RELEASE_MANIFEST_V2') fail('legacy_manifest');
  const lines = [
    'REGISTRY=ghcr.io/z6v6e6r',
    `PHUB_RELEASE=${manifest.gitCommit}`,
    `PHUB_RELEASE_TREE=${manifest.gitTree}`,
    `PHUB_PUBLICATION_WORKFLOW_SHA=${manifest.publication.workflowSha}`,
    `PHUB_PUBLICATION_RUN_ID=${manifest.publication.runId}`,
    `PHUB_PUBLICATION_RUN_ATTEMPT=${manifest.publication.runAttempt}`,
  ];
  for (const image of manifest.images) {
    const prefix = COMPONENT_VARIABLES[image.component];
    if (!prefix) fail('component_set');
    lines.push(`${prefix}_IMAGE_DIGEST=${image.digest}`);
    lines.push(`${prefix}_RUNTIME_DIGEST=${image.runtimeDigest}`);
  }
  return `${lines.join('\n')}\n`;
}

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const option = argv[index];
    const value = argv[index + 1];
    if (!option?.startsWith('--') || !value) fail('usage');
    if (Object.hasOwn(values, option)) fail('duplicate_option');
    values[option] = value;
  }
  const required = [
    '--manifest',
    '--output',
    '--expected-workflow-sha',
    '--expected-run-id',
    '--expected-run-attempt',
  ];
  if (Object.keys(values).length !== required.length || required.some((key) => !values[key]))
    fail('usage');
  return values;
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  const manifest = readCanonicalPair(options['--manifest']);
  const contents = renderReleaseEnvironment(manifest, {
    workflowSha: options['--expected-workflow-sha'],
    runId: options['--expected-run-id'],
    runAttempt: options['--expected-run-attempt'],
  });
  let file;
  try {
    file = openSync(
      options['--output'],
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    writeFileSync(file, contents, 'utf8');
  } finally {
    if (file !== undefined) closeSync(file);
  }
  process.stdout.write('TIMEWEB_BETA_RELEASE_ENV_PASSED|values_printed=false\n');
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try {
    main();
  } catch (error) {
    const reason =
      error instanceof ReleaseManifestContractError || error instanceof Error
        ? error.message
        : 'validation_error';
    process.stderr.write(`TIMEWEB_BETA_RELEASE_ENV_FAILED|reason=${reason}\n`);
    process.exit(1);
  }
}
