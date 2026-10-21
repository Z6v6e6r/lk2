#!/usr/bin/env node
/**
 * Generate the Python delivery-pin block from the JavaScript contract (ADR 0025 step 5).
 *
 * The frozen bridge pins 35 Git blobs in `scripts/timeweb-api-worker-contract.js`. The Python
 * backup helper needs the same tuples on the target host, so it used to carry a hand-maintained
 * mirror. This generator rewrites the marked block in `control-timeweb-database-backup.py`; a drift
 * test runs `--check`, so the two lists can no longer diverge silently.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  API_WORKER_ANDROID_CHAT_TEST_PATCH,
  API_WORKER_CI_DOWNLOAD_PATCH,
  API_WORKER_CI_READER_PATCH,
  API_WORKER_CONTROLLER_PROMOTION_PATCH,
  API_WORKER_MIGRATION_CONTROLLER_FILES,
  API_WORKER_NATIVE_BOOKINGS_PATCH,
  API_WORKER_REHEARSAL_READINESS_PATCH,
} from './timeweb-api-worker-contract.js';

export const BEGIN_MARKER =
  '# BEGIN GENERATED DELIVERY PINS (scripts/generate-timeweb-backup-pins.ts)';
export const END_MARKER = '# END GENERATED DELIVERY PINS';
export const DEFAULT_HELPER = 'scripts/control-timeweb-database-backup.py';

type Pin = Readonly<{
  path: string;
  status: string;
  oldMode: string;
  newMode: string;
  oldOid: string;
  newOid: string;
}>;

const GROUPS: ReadonlyArray<readonly [string, readonly Pin[]]> = [
  ['API_WORKER_CI_DOWNLOAD_PATCH', API_WORKER_CI_DOWNLOAD_PATCH],
  ['API_WORKER_CI_READER_PATCH', API_WORKER_CI_READER_PATCH],
  ['API_WORKER_CONTROLLER_PROMOTION_PATCH', API_WORKER_CONTROLLER_PROMOTION_PATCH],
  ['API_WORKER_ANDROID_CHAT_TEST_PATCH', API_WORKER_ANDROID_CHAT_TEST_PATCH],
  ['API_WORKER_REHEARSAL_READINESS_PATCH', API_WORKER_REHEARSAL_READINESS_PATCH],
  ['API_WORKER_NATIVE_BOOKINGS_PATCH', API_WORKER_NATIVE_BOOKINGS_PATCH],
];

function pythonValue(value: string): string {
  return `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
}

function dictLiteral(pin: Pin): string {
  return `{${[
    `'path': ${pythonValue(pin.path)}`,
    `'status': ${pythonValue(pin.status)}`,
    `'oldMode': ${pythonValue(pin.oldMode)}`,
    `'newMode': ${pythonValue(pin.newMode)}`,
    `'oldOid': ${pythonValue(pin.oldOid)}`,
    `'newOid': ${pythonValue(pin.newOid)}`,
  ].join(', ')}}`;
}

export function renderPinBlock(): string {
  const lines = [
    BEGIN_MARKER,
    '# Source: scripts/timeweb-api-worker-contract.js. Do not edit this block by hand;',
    '# run `node --import tsx scripts/generate-timeweb-backup-pins.ts --write`.',
    'API_WORKER_MIGRATION_CONTROLLER_FILES = frozenset([',
    ...[...API_WORKER_MIGRATION_CONTROLLER_FILES].sort().map((path) => `    ${pythonValue(path)},`),
    '])',
  ];
  for (const [name, pins] of GROUPS) {
    lines.push(`${name} = {`);
    for (const pin of pins) lines.push(`    ${pythonValue(pin.path)}: ${dictLiteral(pin)},`);
    lines.push('}');
  }
  lines.push(END_MARKER);
  return `${lines.join('\n')}\n`;
}

export function replacePinBlock(source: string, block: string): string {
  const begin = source.indexOf(BEGIN_MARKER);
  const end = source.indexOf(END_MARKER);
  if (begin === -1 || end === -1 || end < begin) {
    throw new Error('generated pin markers are missing from the backup helper');
  }
  const after = source.indexOf('\n', end);
  return `${source.slice(0, begin)}${block}${source.slice(after + 1)}`;
}

function main(argv: readonly string[]): number {
  const write = argv.includes('--write');
  const file = resolve(
    argv.find((value) => value.startsWith('--file='))?.slice('--file='.length) ?? DEFAULT_HELPER,
  );
  const source = readFileSync(file, 'utf8');
  const block = renderPinBlock();
  const replaced = replacePinBlock(source, block);
  if (write) {
    writeFileSync(file, replaced);
    process.stdout.write(`WROTE ${file}\n`);
    return 0;
  }
  if (source !== replaced) {
    process.stderr.write(`DELIVERY_PIN_DRIFT ${file}; run with --write\n`);
    return 1;
  }
  process.stdout.write(`DELIVERY_PINS_CURRENT ${file}\n`);
  return 0;
}

if (process.argv[1]?.endsWith('generate-timeweb-backup-pins.ts')) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`PIN_GENERATE_ERROR ${(error as Error).message}\n`);
    process.exitCode = 2;
  }
}
