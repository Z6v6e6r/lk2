import { randomUUID } from 'node:crypto';

import {
  createDatabasePool,
  createGameRepository,
  createLegacyGameImportRepository,
} from '@phub/database';
import { LegacyGamesMongoAdapter } from '@phub/legacy-games-adapter';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
}

function isoInstant(name: string): string {
  const value = required(name);
  if (Number.isNaN(Date.parse(value))) throw new Error(`${name}_INVALID`);
  return new Date(value).toISOString();
}

function positiveInteger(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 500) {
    throw new Error(`${name}_INVALID`);
  }
  return parsed;
}

if (!['staging', 'production'].includes(process.env.APP_ENV ?? '')) {
  throw new Error('LEGACY_GAMES_SERVER_IMPORT_REQUIRES_STAGING_OR_PRODUCTION');
}
if (process.env.LEGACY_GAMES_SERVER_IMPORT_CONFIRM !== 'server-migration') {
  throw new Error('LEGACY_GAMES_SERVER_IMPORT_CONFIRM_REQUIRED');
}

const databaseUrl = required('DATABASE_URL');
const sourceUri = required('LEGACY_GAMES_MONGODB_URI');
const tenantKey = required('LEGACY_GAMES_IMPORT_TENANT_KEY');
const from = isoInstant('LEGACY_GAMES_IMPORT_FROM');
const to = isoInstant('LEGACY_GAMES_IMPORT_TO');
if (Date.parse(to) <= Date.parse(from)) throw new Error('LEGACY_GAMES_IMPORT_DATE_RANGE_INVALID');

const limit = positiveInteger('LEGACY_GAMES_IMPORT_LIMIT', 500);
const correlationId = `legacy-server-migration-${randomUUID()}`;
const pool = createDatabasePool(databaseUrl);
const source = new LegacyGamesMongoAdapter({
  uri: sourceUri,
  timeoutMs: 5_000,
  maxAttempts: 2,
});

try {
  const snapshots = await source.read({ from, to, limit });
  const imported = await createLegacyGameImportRepository(pool).importSnapshots({
    tenantKey,
    snapshots,
    correlationId,
    now: new Date(),
  });
  const rosterSync = await createLegacyGameImportRepository(pool).synchronizeParticipants({
    tenantKey,
    snapshots,
    correlationId,
    now: new Date(),
  });
  const projector = createGameRepository(pool);
  const targets = [...imported.imported, ...imported.existing, ...rosterSync.synced];
  const projections = await Promise.all(
    targets.map(async (target) => ({
      gameId: target.gameId,
      outcome: await projector.projectCardEvent({
        tenantId: imported.tenantId,
        eventId: target.projectionEventId,
        gameId: target.gameId,
      }),
    })),
  );
  const healthyOutcomes = new Set(['applied', 'duplicate', 'stale']);
  const failures = projections.filter((item) => !healthyOutcomes.has(item.outcome));
  if (failures.length > 0) {
    throw new Error(`LEGACY_GAMES_PROJECTION_FAILED:${failures.length}`);
  }
  process.stdout.write(
    `${JSON.stringify({
      tenantId: imported.tenantId,
      sourceRows: snapshots.length,
      imported: imported.imported.length,
      preservedExisting: imported.skipped,
      rosterMirrorBootstrapped: rosterSync.bootstrapped,
      rosterMirrored: rosterSync.synced.length,
      rosterConflicts: rosterSync.conflicts,
      projected: projections.length,
      projectionOutcomes: Object.fromEntries(
        [...healthyOutcomes].map((outcome) => [
          outcome,
          projections.filter((item) => item.outcome === outcome).length,
        ]),
      ),
      sampleGameIds: projections.slice(0, 10).map((item) => item.gameId),
    })}\n`,
  );
} finally {
  await pool.end();
}
