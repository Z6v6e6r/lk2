import { randomUUID } from 'node:crypto';

import { loadWorkerConfig } from '@phub/config';
import {
  createLegacyGameImportRepository,
  type LegacyGameRosterRebaselineResult,
} from '@phub/database';
import { LegacyGamesMongoAdapter, LegacyGamesPublicAdapter } from '@phub/legacy-games-adapter';
import { Pool, type PoolConfig } from 'pg';
import { exactLegacyGameRosterRepair } from './exact-legacy-game-roster-repair.js';

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
  readonly gameId?: string;
  readonly operationId?: string;
  readonly planOnly?: boolean;
  readonly expectedPlanSha256?: string;
} {
  const values = new Map<string, string>();
  let allowLocalRemovals = false;
  let planOnly = false;
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === '--plan') {
      if (planOnly) throw new LegacyGameRosterRepairArgumentError('usage');
      planOnly = true;
      continue;
    }
    if (option === '--allow-local-removals') {
      allowLocalRemovals = true;
      continue;
    }
    if (
      !option ||
      !['--tenant-key', '--limit', '--game-id', '--operation-id', '--plan-sha'].includes(option)
    ) {
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
  const gameId = values.get('--game-id'),
    operationId = values.get('--operation-id'),
    expectedPlanSha256 = values.get('--plan-sha');
  if (gameId || operationId || expectedPlanSha256 || planOnly) {
    if (
      !gameId ||
      !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u.test(gameId) ||
      !operationId ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{7,63}$/u.test(operationId) ||
      allowLocalRemovals ||
      values.has('--limit') ||
      (planOnly
        ? expectedPlanSha256 !== undefined
        : !/^[0-9a-f]{64}$/u.test(expectedPlanSha256 ?? ''))
    )
      throw new LegacyGameRosterRepairArgumentError('exact_scope');
    return {
      tenantKey,
      limit: 1,
      allowLocalRemovals: false,
      gameId,
      operationId,
      planOnly,
      ...(expectedPlanSha256 ? { expectedPlanSha256 } : {}),
    };
  }
  return { tenantKey, limit, allowLocalRemovals };
}

export function exactRosterRepairPoolOptions(
  planOnly: boolean,
): Pick<PoolConfig, 'connectionTimeoutMillis' | 'query_timeout' | 'options'> {
  return {
    connectionTimeoutMillis: 5000,
    query_timeout: 20000,
    options:
      '-c statement_timeout=15000 -c lock_timeout=3000 -c idle_in_transaction_session_timeout=20000' +
      (planOnly ? ' -c default_transaction_read_only=on' : ''),
  };
}
export function rosterRepairFailureReport(error: unknown) {
  const sqlCode = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  const code =
    sqlCode === '55P03'
      ? 'LEGACY_GAME_EXACT_REPAIR_LOCK_TIMEOUT'
      : sqlCode === '57014'
        ? 'LEGACY_GAME_EXACT_REPAIR_STATEMENT_TIMEOUT'
        : error instanceof Error && /^LEGACY_GAME[A-Z_]{1,100}$/u.test(error.message)
          ? error.message
          : 'LEGACY_GAME_ROSTER_REPAIR_FAILED';
  return { status: 'STOP', code, automaticRetry: false };
}

async function main(): Promise<void> {
  const config = loadWorkerConfig(process.env);
  const arguments_ = parseRepairArguments(process.argv.slice(2));
  if (arguments_.gameId && config.LEGACY_GAMES_ROSTER_SYNC_SOURCE !== 'mongo')
    throw new LegacyGameRosterRepairArgumentError('exact_source');
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
          onMetric: (metric) => {
            if (arguments_.gameId)
              process.stderr.write(
                JSON.stringify({
                  event: 'exact_roster_source_read',
                  operationId: arguments_.operationId,
                  outcome: metric.outcome,
                  attempt: metric.attempt,
                  durationMs: metric.durationMs,
                }) + '\n',
              );
          },
        });
  const pool = new Pool({
    connectionString: config.DATABASE_URL,
    max: 2,
    ...(arguments_.gameId ? exactRosterRepairPoolOptions(arguments_.planOnly === true) : {}),
  });
  const deadline = arguments_.gameId
    ? setTimeout(() => {
        process.stderr.write(
          JSON.stringify({
            status: 'STOP',
            code: 'LEGACY_GAME_EXACT_REPAIR_DEADLINE',
            automaticRetry: false,
          }) + '\n',
        );
        process.exit(124);
      }, 90_000)
    : undefined;
  try {
    if (arguments_.gameId) {
      if (!(source instanceof LegacyGamesMongoAdapter))
        throw new LegacyGameRosterRepairArgumentError('exact_source');
      const report = await exactLegacyGameRosterRepair({
        pool,
        repository: createLegacyGameImportRepository(pool),
        source,
        tenantKey: arguments_.tenantKey,
        gameId: arguments_.gameId,
        operationId: arguments_.operationId!,
        planOnly: arguments_.planOnly === true,
        ...(arguments_.expectedPlanSha256
          ? { expectedPlanSha256: arguments_.expectedPlanSha256 }
          : {}),
      });
      process.stdout.write(JSON.stringify(report) + '\n');
      return;
    }
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
    try {
      await pool.end();
    } finally {
      if (deadline) clearTimeout(deadline);
    }
  }
}

if (process.argv[1] && process.argv[1].endsWith('repair-legacy-game-rosters.js')) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(JSON.stringify(rosterRepairFailureReport(error)) + '\n');
    process.exitCode = 1;
  }
}
