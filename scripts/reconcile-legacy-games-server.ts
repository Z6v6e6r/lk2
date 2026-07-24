import { createDatabasePool, createLegacyGameReconciliationRepository } from '@phub/database';
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
  throw new Error('LEGACY_GAMES_RECONCILIATION_REQUIRES_STAGING_OR_PRODUCTION');
}
if (process.env.LEGACY_GAMES_RECONCILIATION_CONFIRM !== 'read-only-report') {
  throw new Error('LEGACY_GAMES_RECONCILIATION_CONFIRM_REQUIRED');
}

const from = isoInstant('LEGACY_GAMES_IMPORT_FROM');
const to = isoInstant('LEGACY_GAMES_IMPORT_TO');
if (Date.parse(to) <= Date.parse(from)) throw new Error('LEGACY_GAMES_IMPORT_DATE_RANGE_INVALID');

const pool = createDatabasePool(required('DATABASE_URL'));
const source = new LegacyGamesMongoAdapter({
  uri: required('LEGACY_GAMES_MONGODB_URI'),
  timeoutMs: 5_000,
  maxAttempts: 2,
});

try {
  const snapshots = await source.read({
    from,
    to,
    limit: positiveInteger('LEGACY_GAMES_IMPORT_LIMIT', 500),
  });
  const report = await createLegacyGameReconciliationRepository(pool).reconcileSnapshots({
    tenantKey: required('LEGACY_GAMES_IMPORT_TENANT_KEY'),
    snapshots,
    now: new Date(),
  });
  process.stdout.write(
    `${JSON.stringify({
      tenantId: report.tenantId,
      sourceRows: snapshots.length,
      compared: report.compared,
      matched: report.matched,
      missing: report.missing,
      discrepancyCount: report.discrepancies.length,
      sampleGameIds: report.discrepancies
        .flatMap((item) => (item.gameId ? [item.gameId] : []))
        .slice(0, 10),
      reasonCounts: Object.fromEntries(
        [...new Set(report.discrepancies.flatMap((item) => item.reasons))].map((reason) => [
          reason,
          report.discrepancies.filter((item) => item.reasons.includes(reason)).length,
        ]),
      ),
    })}\n`,
  );
} finally {
  await pool.end();
}
