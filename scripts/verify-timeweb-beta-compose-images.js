#!/usr/bin/env node
import { lstatSync, readFileSync } from 'node:fs';

import { parseEnvironment } from './verify-timeweb-beta-runtime-env.js';

const COMPONENTS = ['WEB', 'API', 'WORKER', 'REALTIME', 'MIGRATOR'];

function fail(reason) {
  throw new Error(reason);
}

function readRootOnlyFile(path) {
  const stat = lstatSync(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.uid !== 0 ||
    stat.mode !== 0o100600 ||
    stat.nlink !== 1
  )
    fail('file_security');
  return readFileSync(path, 'utf8');
}

export function verifyComposeImages(releaseEnvironment, actualImageOutput) {
  const environment = parseEnvironment(releaseEnvironment);
  if (environment.REGISTRY !== 'ghcr.io/z6v6e6r') fail('registry');
  const expected = COMPONENTS.map((component) => {
    const digest = environment[`${component}_IMAGE_DIGEST`];
    if (!/^sha256:[a-f0-9]{64}$/u.test(digest ?? '')) fail(`digest_${component}`);
    return `${environment.REGISTRY}/phub-${component.toLowerCase()}@${digest}`;
  }).sort();
  const actual = actualImageOutput.split('\n').filter(Boolean).sort();
  if (actual.length !== COMPONENTS.length || new Set(actual).size !== COMPONENTS.length)
    fail('image_count');
  if (actual.join('\n') !== expected.join('\n')) fail('image_set');
}

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const option = argv[index];
    const value = argv[index + 1];
    if (!option?.startsWith('--') || !value || Object.hasOwn(values, option)) fail('usage');
    values[option] = value;
  }
  const required = ['--release-env', '--actual-images'];
  if (Object.keys(values).length !== required.length || required.some((key) => !values[key]))
    fail('usage');
  return values;
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  verifyComposeImages(
    readRootOnlyFile(options['--release-env']),
    readRootOnlyFile(options['--actual-images']),
  );
  process.stdout.write('TIMEWEB_BETA_COMPOSE_IMAGES_PASSED|values_printed=false\n');
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(
      `TIMEWEB_BETA_COMPOSE_IMAGES_FAILED|reason=${error instanceof Error ? error.message : 'validation_error'}\n`,
    );
    process.exit(1);
  }
}
