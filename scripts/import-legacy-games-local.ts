import { randomUUID } from 'node:crypto';

import {
  createDatabasePool,
  createGameRepository,
  createLegacyGameImportRepository,
} from '@phub/database';
import { LegacyGamesPublicAdapter } from '@phub/legacy-games-adapter';

function positiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 500) {
    throw new Error('LEGACY_GAMES_IMPORT_LIMIT_INVALID');
  }
  return parsed;
}

function assertLocalDatabase(connectionString: string): void {
  const url = new URL(connectionString);
  const allowedHosts = new Set(['localhost', '127.0.0.1', 'postgres', 'phub-postgres']);
  if (!allowedHosts.has(url.hostname)) throw new Error('LEGACY_GAMES_IMPORT_DATABASE_NOT_LOCAL');
}

if (process.env.APP_ENV !== 'local') {
  throw new Error('LEGACY_GAMES_IMPORT_REQUIRES_APP_ENV_LOCAL');
}
if (process.env.LEGACY_GAMES_IMPORT_CONFIRM !== 'local-clone') {
  throw new Error('LEGACY_GAMES_IMPORT_CONFIRM_REQUIRED');
}
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL_REQUIRED');
assertLocalDatabase(databaseUrl);
const now = new Date();
const limit = positiveInteger(process.env.LEGACY_GAMES_IMPORT_LIMIT, 500);
const tenantKey = process.env.LEGACY_GAMES_IMPORT_TENANT_KEY?.trim() || 'local-padel';
const correlationId = `legacy-local-clone-${randomUUID()}`;

const adapter = new LegacyGamesPublicAdapter({
  baseUrl: process.env.LEGACY_GAMES_PUBLIC_BASE_URL ?? 'https://padlhub.su',
  timeoutMs: 8_000,
});
const pool = createDatabasePool(databaseUrl);
try {
  const snapshots = await adapter.readAvailable({ limit });
  const imported = await createLegacyGameImportRepository(pool).importSnapshots({
    tenantKey,
    snapshots,
    correlationId,
    now,
  });
  const projector = createGameRepository(pool);
  const projectionTargets = [...imported.imported, ...imported.existing];
  const projectionOutcomes = await Promise.all(
    projectionTargets.map(async (target) => ({
      gameId: target.gameId,
      outcome: await projector.projectCardEvent({
        tenantId: imported.tenantId,
        eventId: target.projectionEventId,
        gameId: target.gameId,
      }),
    })),
  );
  const healthyProjectionOutcomes = new Set(['applied', 'duplicate', 'stale']);
  const failed = projectionOutcomes.filter(
    (result) => !healthyProjectionOutcomes.has(result.outcome),
  );
  if (failed.length > 0) {
    throw new Error(
      `LEGACY_GAMES_PROJECTION_FAILED:${failed
        .map((result) => `${result.gameId}:${result.outcome}`)
        .join(',')}`,
    );
  }
  process.stdout.write(
    `${JSON.stringify(
      {
        tenantId: imported.tenantId,
        sourceRows: snapshots.length,
        imported: imported.imported.length,
        preservedExisting: imported.skipped,
        projected: projectionOutcomes.length,
        projectionOutcomes: Object.fromEntries(
          [...healthyProjectionOutcomes].map((outcome) => [
            outcome,
            projectionOutcomes.filter((result) => result.outcome === outcome).length,
          ]),
        ),
        sampleGameIds: projectionOutcomes.slice(0, 10).map((result) => result.gameId),
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await pool.end();
}
