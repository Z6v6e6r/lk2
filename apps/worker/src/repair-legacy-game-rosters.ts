import { randomUUID } from 'node:crypto';

import { loadWorkerConfig } from '@phub/config';
import {
  createLegacyGameImportRepository,
  type LegacyGameRosterRebaselineResult,
} from '@phub/database';
import { LegacyGamesMongoAdapter, LegacyGamesPublicAdapter } from '@phub/legacy-games-adapter';
import { Pool } from 'pg';

export interface LegacyGameRosterRepairReport {
  readonly tenantKey: string;
  readonly correlationId: string;
  readonly allowLocalRemovals: boolean;
  readonly window: { readonly from: string; readonly to: string; readonly limit: number };
  readonly attempted: number;
  readonly rebaselined: LegacyGameRosterRebaselineResult['rebaselined'];
  readonly deferred: LegacyGameRosterRebaselineResult['deferred'];
  readonly skipped: number;
}

export class LegacyGameRosterRepairArgumentError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'LegacyGameRosterRepairArgumentError';
  }
}

function isoAtOffset(now: Date, days: number): string {
  return new Date(now.getTime() + days * 86_400_000).toISOString();
}

/**
 * One-shot operator repair for rosters that the continuous mirror quarantined with
 * `LEGACY_GAME_ROSTER_BASELINE_MISMATCH`. It re-reads the bounded source window, asks the repository
 * to rebaseline only quarantined Games, and reports every Game it refused to touch.
 */
export async function repairLegacyGameRosters(input: {
  readonly pool: Pool;
  readonly tenantKey: string;
  readonly source: Pick<LegacyGamesMongoAdapter, 'read'>;
  readonly repository: Pick<
    ReturnType<typeof createLegacyGameImportRepository>,
    'rebaselineParticipants'
  >;
  readonly limit: number;
  readonly lookbackDays: number;
  readonly lookaheadDays: number;
  readonly allowLocalRemovals: boolean;
  readonly now?: Date;
  readonly correlationId?: string;
}): Promise<LegacyGameRosterRepairReport> {
  const now = input.now ?? new Date();
  const from = isoAtOffset(now, -input.lookbackDays);
  const to = isoAtOffset(now, input.lookaheadDays);
  const correlationId = input.correlationId ?? `legacy-games-roster-repair-${randomUUID()}`;
  const snapshots = await input.source.read({ from, to, limit: input.limit });
  const result = await input.repository.rebaselineParticipants({
    tenantKey: input.tenantKey,
    snapshots,
    correlationId,
    allowLocalRemovals: input.allowLocalRemovals,
    now,
  });
  return {
    tenantKey: input.tenantKey,
    correlationId,
    allowLocalRemovals: input.allowLocalRemovals,
    window: { from, to, limit: input.limit },
    attempted: snapshots.length,
    rebaselined: result.rebaselined,
    deferred: result.deferred,
    skipped: result.skipped,
  };
}

export function parseRepairArguments(argv: readonly string[]): {
  readonly tenantKey: string;
  readonly limit: number;
  readonly allowLocalRemovals: boolean;
} {
  const values = new Map<string, string>();
  let allowLocalRemovals = false;
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === '--allow-local-removals') {
      allowLocalRemovals = true;
      continue;
    }
    if (option !== '--tenant-key' && option !== '--limit') {
      throw new LegacyGameRosterRepairArgumentError('usage');
    }
    const value = argv[index + 1];
    if (!value || values.has(option)) throw new LegacyGameRosterRepairArgumentError('usage');
    values.set(option, value);
    index += 1;
  }
  const tenantKey = values.get('--tenant-key');
  if (!tenantKey || !/^[a-z0-9][a-z0-9-]{1,62}$/u.test(tenantKey)) {
    throw new LegacyGameRosterRepairArgumentError('tenant_key');
  }
  const limit = Number(values.get('--limit') ?? '500');
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new LegacyGameRosterRepairArgumentError('limit');
  }
  return { tenantKey, limit, allowLocalRemovals };
}

async function main(): Promise<void> {
  const config = loadWorkerConfig(process.env);
  const arguments_ = parseRepairArguments(process.argv.slice(2));
  const source =
    config.LEGACY_GAMES_ROSTER_SYNC_SOURCE === 'public'
      ? new LegacyGamesPublicAdapter({
          baseUrl: config.LEGACY_GAMES_PUBLIC_BASE_URL,
          timeoutMs: 8_000,
          freshTtlMs: 60_000,
          staleTtlMs: 600_000,
          circuitFailureThreshold: 3,
          circuitResetMs: 30_000,
          onMetric: () => undefined,
        })
      : new LegacyGamesMongoAdapter({
          uri: config.LEGACY_GAMES_MONGODB_URI as string,
          timeoutMs: 5_000,
          maxAttempts: 2,
          onMetric: () => undefined,
        });
  const pool = new Pool({ connectionString: config.DATABASE_URL, max: 2 });
  try {
    const report = await repairLegacyGameRosters({
      pool,
      tenantKey: arguments_.tenantKey,
      source,
      repository: createLegacyGameImportRepository(pool),
      limit: arguments_.limit,
      lookbackDays: config.LEGACY_GAMES_ROSTER_SYNC_LOOKBACK_DAYS,
      lookaheadDays: config.LEGACY_GAMES_ROSTER_SYNC_LOOKAHEAD_DAYS,
      allowLocalRemovals: arguments_.allowLocalRemovals,
    });
    process.stdout.write(
      `${JSON.stringify({
        schema: 'PHUB_TIMEWEB_LEGACY_ROSTER_REPAIR_V1',
        ...report,
        rebaselinedCount: report.rebaselined.length,
        deferredCount: report.deferred.length,
      })}\n`,
    );
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && process.argv[1].endsWith('repair-legacy-game-rosters.js')) {
  await main();
}
