#!/usr/bin/env node
/**
 * Print the restore operation schema for the current host and database size (ADR 0025 step 4).
 *
 * Read-only. The operator feeds the emitted schema into the backup-restore operation request so
 * the disk (LUKS/loop) path is selected automatically when the tmpfs formula no longer fits.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, statfsSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  selectRestorePlan,
  type Profile,
  type RestorePhase,
  type RestorePlan,
} from './timeweb-restore-capacity.js';

const PG_CONTAINER = 'phub-timeweb-beta-dependencies-postgres-1';

interface Options {
  readonly phase: RestorePhase;
  readonly profile: Profile;
  readonly root: string;
  readonly pgContainer: string;
  readonly databaseBytes?: number;
  readonly availableMemory?: number;
  readonly freeDisk?: number;
}

function fail(message: string): never {
  throw new Error(message);
}

function parseArgs(argv: readonly string[]): Options {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--json') {
      values.set('json', '1');
      continue;
    }
    if (!token?.startsWith('--')) fail(`Invalid argument ${token ?? '<missing>'}`);
    const separator = token.indexOf('=');
    if (separator > 2) {
      values.set(token.slice(2, separator), token.slice(separator + 1));
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) fail(`Invalid argument ${token}`);
    values.set(token.slice(2), value);
    index += 1;
  }
  const phase = (values.get('phase') ?? 'post101') as RestorePhase;
  const profile = (values.get('profile') ?? 'beta') as Profile;
  if (!['pre99', 'post101'].includes(phase)) fail('--phase must be pre99 or post101');
  if (!['beta', 'production'].includes(profile)) fail('--profile must be beta or production');
  const number = (key: string): number | undefined => {
    const raw = values.get(key);
    if (raw === undefined) return undefined;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value <= 0) fail(`--${key} must be a positive integer`);
    return value;
  };
  const databaseBytes = number('database-bytes');
  const availableMemory = number('mem-available');
  const freeDisk = number('free-disk');
  return {
    phase,
    profile,
    root: resolve(values.get('root') ?? '/opt/phub/timeweb-beta'),
    pgContainer: values.get('pg-container') ?? PG_CONTAINER,
    ...(databaseBytes === undefined ? {} : { databaseBytes }),
    ...(availableMemory === undefined ? {} : { availableMemory }),
    ...(freeDisk === undefined ? {} : { freeDisk }),
  };
}

function databaseSize(options: Options): number {
  if (options.databaseBytes !== undefined) return options.databaseBytes;
  const raw = execFileSync(
    '/usr/bin/docker',
    [
      'exec',
      options.pgContainer,
      'psql',
      '-X',
      '--no-password',
      '--username=phub_beta',
      '--dbname=phub_beta',
      '--no-psqlrc',
      '--tuples-only',
      '--no-align',
      '--command',
      'select pg_database_size(current_database())',
    ],
    { encoding: 'utf8' },
  ).trim();
  const bytes = Number(raw);
  if (!Number.isSafeInteger(bytes) || bytes <= 0) fail('invalid pg_database_size readback');
  return bytes;
}

function availableMemory(options: Options): number {
  if (options.availableMemory !== undefined) return options.availableMemory;
  const match = /^MemAvailable:\s+([0-9]+) kB$/mu.exec(readFileSync('/proc/meminfo', 'utf8'));
  if (!match?.[1]) fail('MemAvailable is missing from /proc/meminfo');
  return Number(match[1]) * 1024;
}

function freeDisk(options: Options): number {
  if (options.freeDisk !== undefined) return options.freeDisk;
  const stats = statfsSync(options.root);
  return stats.bavail * stats.bsize;
}

function main(argv: readonly string[]): number {
  const options = parseArgs(argv);
  const plan: RestorePlan = selectRestorePlan(
    options.phase,
    databaseSize(options),
    availableMemory(options),
    freeDisk(options),
    options.profile,
  );
  if (argv.includes('--json')) {
    process.stdout.write(
      `${JSON.stringify(
        {
          phase: options.phase,
          profile: options.profile,
          storageMode: plan.storageMode,
          schema: plan.schema,
          detail: plan.verdict.detail,
        },
        null,
        2,
      )}\n`,
    );
  } else {
    process.stdout.write(
      `phase=${options.phase} profile=${options.profile} storageMode=${plan.storageMode} schema=${plan.schema}\n${plan.verdict.detail}\n`,
    );
  }
  return 0;
}

if (process.argv[1]?.endsWith('plan-timeweb-beta-restore.ts')) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`RESTORE_PLAN_ERROR ${(error as Error).message}\n`);
    process.exitCode = 1;
  }
}
