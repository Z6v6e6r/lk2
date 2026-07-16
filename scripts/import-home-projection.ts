import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { createDatabasePool, createHomeDashboardProjectionRepository } from '@phub/database';
import { isValidIdempotencyKey } from '@phub/domain';

import { homeDashboardSchema } from '../apps/api/src/home/home-dashboard-schema.js';

interface ImportOptions {
  readonly file: string;
  readonly tenantKey: string;
  readonly sourceRevision: string;
  readonly sourceEventId: string;
  readonly correlationId: string;
  readonly producer: string;
  readonly apply: boolean;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TENANT_KEY_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}$/;
const PRODUCER_PATTERN = /^[A-Z][A-Z0-9_]{1,63}$/;

function usage(): never {
  throw new Error(
    'Usage: npm run home:projection:import -- --file <snapshot.json> --tenant <tenant-key> ' +
      '--revision <positive-int> --source-event-id <uuid> --correlation-id <opaque-id> ' +
      '[--producer HOME_IMPORT] [--apply]',
  );
}

function parseArguments(args: readonly string[]): ImportOptions {
  const values = new Map<string, string>();
  let apply = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--apply') {
      apply = true;
      continue;
    }
    if (!argument?.startsWith('--')) usage();
    const value = args[index + 1];
    if (!value || value.startsWith('--')) usage();
    values.set(argument, value);
    index += 1;
  }

  const file = values.get('--file');
  const tenantKey = values.get('--tenant');
  const sourceRevision = values.get('--revision');
  const sourceEventId = values.get('--source-event-id');
  const correlationId = values.get('--correlation-id');
  const producer = values.get('--producer') ?? 'HOME_IMPORT';
  if (!file || !tenantKey || !sourceRevision || !sourceEventId || !correlationId) usage();
  if (!TENANT_KEY_PATTERN.test(tenantKey)) throw new Error('Invalid --tenant value');
  if (!/^\d+$/.test(sourceRevision) || BigInt(sourceRevision) <= 0n) {
    throw new Error('--revision must be a positive integer');
  }
  if (!UUID_PATTERN.test(sourceEventId)) throw new Error('--source-event-id must be a UUID');
  if (!isValidIdempotencyKey(correlationId)) {
    throw new Error('--correlation-id must be 16-128 safe opaque characters');
  }
  if (!PRODUCER_PATTERN.test(producer)) throw new Error('Invalid --producer value');

  return {
    file,
    tenantKey,
    sourceRevision,
    sourceEventId,
    correlationId,
    producer,
    apply,
  };
}

const options = parseArguments(process.argv.slice(2));
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');

const rawPayload: unknown = JSON.parse(await readFile(resolve(options.file), 'utf8'));
const parsedPayload = homeDashboardSchema.safeParse(rawPayload);
if (!parsedPayload.success) {
  const details = parsedPayload.error.issues
    .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
    .join('; ');
  throw new Error(`Invalid HomeDashboard snapshot: ${details}`);
}
const payload = parsedPayload.data;
if (payload.snapshot.source !== 'LOCAL_PROJECTION') {
  throw new Error('Imported snapshot.source must be LOCAL_PROJECTION');
}
if (Date.parse(payload.snapshot.staleAt) <= Date.now()) {
  throw new Error('Imported snapshot is already stale');
}

const pool = createDatabasePool(databaseUrl);
try {
  const tenant = await pool.query<{ id: string }>(
    'select id from identity.tenants where tenant_key = $1 and active = true',
    [options.tenantKey],
  );
  const tenantId = tenant.rows[0]?.id;
  if (!tenantId) throw new Error('Active tenant not found');

  const summary = {
    mode: options.apply ? 'apply' : 'dry-run',
    tenantKey: options.tenantKey,
    tenantId,
    userId: payload.profile.userId,
    sourceRevision: options.sourceRevision,
    sourceEventId: options.sourceEventId,
    producer: options.producer,
    snapshotVersion: payload.snapshot.version,
    generatedAt: payload.snapshot.generatedAt,
    staleAt: payload.snapshot.staleAt,
  };
  if (!options.apply) {
    process.stdout.write(`${JSON.stringify({ ...summary, outcome: 'validated' }, null, 2)}\n`);
  } else {
    const result = await createHomeDashboardProjectionRepository(pool).upsert({
      tenantId,
      userId: payload.profile.userId,
      sourceRevision: options.sourceRevision,
      sourceEventId: options.sourceEventId,
      producer: options.producer,
      snapshotVersion: payload.snapshot.version,
      payload,
      generatedAt: payload.snapshot.generatedAt,
      staleAt: payload.snapshot.staleAt,
      correlationId: options.correlationId,
    });
    process.stdout.write(`${JSON.stringify({ ...summary, ...result }, null, 2)}\n`);
    if (result.outcome === 'revision_conflict') process.exitCode = 2;
  }
} finally {
  await pool.end();
}
