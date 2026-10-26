#!/usr/bin/env node
/**
 * Print the conservative backup-renewal plan for a successful but unadmitted pre-105 backup.
 *
 * Read-only: reads one operator packet and prints the verdict. It never retires, releases, deletes,
 * contacts the host or mutates custody.
 *
 * Usage:
 *   node --import tsx scripts/plan-backup-renewal.ts --input <packet.json> [--json]
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  evaluateBackupRenewal,
  renewalSummary,
  type BackupRenewalInput,
} from './timeweb-backup-renewal.js';

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
  const raw = JSON.parse(readFileSync(options.input, 'utf8')) as BackupRenewalInput;
  const plan = evaluateBackupRenewal(raw);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
  } else {
    process.stdout.write(`${renewalSummary(plan)}\n`);
    for (const check of plan.checks)
      process.stdout.write(`${check.ok ? 'GO' : 'NO_GO'} ${check.code} ${check.detail}\n`);
    if (plan.status === 'GO')
      for (const action of plan.actions) process.stdout.write(`ACTION ${action}\n`);
  }
  return plan.status === 'GO' ? 0 : 2;
}

if (process.argv[1]?.endsWith('plan-backup-renewal.ts')) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`BACKUP_RENEWAL_ERROR ${(error as Error).message}\n`);
    process.exitCode = 1;
  }
}
