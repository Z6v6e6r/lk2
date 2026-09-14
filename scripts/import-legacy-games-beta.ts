import { randomUUID } from 'node:crypto';

import {
  createDatabasePool,
  createGameRepository,
  createLegacyGameImportRepository,
} from '@phub/database';
import { LegacyGamesPublicAdapter } from '@phub/legacy-games-adapter';

/**
 * Bounded import of public legacy LK game data into an approved beta contour.
 *
 * This is deliberately separate from `games:legacy:import-local`: that command is scoped to a local
 * database and refuses anything else, while this one targets the beta tenant and therefore carries
 * its own gates. It is not synchronization and not a dual write. Source identifiers arrive
 * one-way pseudonymized, phones and payment identifiers are absent from the adapter payload, and
 * player display names are retained for the roster UI by explicit design.
 */
const BETA_TENANT_KEY = 'local-padel';

function positiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 500) {
    throw new Error('LEGACY_GAMES_IMPORT_LIMIT_INVALID');
  }
  return parsed;
}

function positiveTimeout(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 30_000 || parsed > 600_000) {
    throw new Error('LEGACY_GAMES_PUBLIC_TIMEOUT_INVALID');
  }
  return parsed;
}

if (process.env.APP_ENV !== 'staging') {
  throw new Error('LEGACY_GAMES_BETA_IMPORT_REQUIRES_APP_ENV_STAGING');
}
if (process.env.LEGACY_GAMES_IMPORT_CONFIRM !== 'beta-clone') {
  throw new Error('LEGACY_GAMES_IMPORT_CONFIRM_REQUIRED');
}
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL_REQUIRED');
const tenantKey = (process.env.LEGACY_GAMES_IMPORT_TENANT_KEY ?? '').trim();
if (tenantKey !== BETA_TENANT_KEY) {
  throw new Error('LEGACY_GAMES_BETA_IMPORT_TENANT_NOT_ALLOWED');
}
const baseUrl = process.env.LEGACY_GAMES_PUBLIC_BASE_URL ?? 'https://padlhub.su';
if (new URL(baseUrl).protocol !== 'https:') {
  throw new Error('LEGACY_GAMES_PUBLIC_SOURCE_NOT_HTTPS');
}

const now = new Date();
const limit = positiveInteger(process.env.LEGACY_GAMES_IMPORT_LIMIT, 500);
const timeoutMs = positiveTimeout(process.env.LEGACY_GAMES_PUBLIC_TIMEOUT_MS, 120_000);
const correlationId = `legacy-beta-clone-${randomUUID()}`;

const adapter = new LegacyGamesPublicAdapter({ baseUrl, timeoutMs });
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
        correlationId,
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
