#!/usr/bin/env node
/**
 * Print a GO/NO-GO release-readiness report for the delivery lanes (ADR-0026).
 *
 * Read-only: reads one operator-provided JSON packet and prints the report. It never contacts the
 * host, GitHub, Docker or the database.
 *
 * Usage:
 *   node --import tsx scripts/report-release-readiness.ts --input <packet.json> [--json]
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { evaluateReleaseReadiness, type ReleaseReadinessInput } from './release-readiness.js';

function fail(message: string): never {
  throw new Error(message);
}

function parseArgs(argv: readonly string[]): { input: string; json: boolean } {
  let input: string | undefined;
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--json') {
      json = true;
      continue;
    }
    if (token === '--input') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) fail('--input requires a path');
      input = value;
      index += 1;
      continue;
    }
    fail(`Invalid argument ${token ?? '<missing>'}`);
  }
  if (input === undefined) fail('--input is required');
  return { input: resolve(input), json };
}

function main(argv: readonly string[]): number {
  const options = parseArgs(argv);
  const raw = JSON.parse(readFileSync(options.input, 'utf8')) as ReleaseReadinessInput;
  const report = evaluateReleaseReadiness(raw);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`RELEASE_READINESS ${report.status}\n`);
    for (const entry of report.categories)
      process.stdout.write(
        `${entry.status.padEnd(5)} ${entry.category.padEnd(12)} ${entry.code} ${entry.detail}\n`,
      );
  }
  return report.status === 'GO' ? 0 : 2;
}

if (process.argv[1]?.endsWith('report-release-readiness.ts')) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`RELEASE_READINESS_ERROR ${(error as Error).message}\n`);
    process.exitCode = 1;
  }
}
