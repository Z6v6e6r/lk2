import { randomUUID } from 'node:crypto';

import type { AppConfig } from '@phub/config';
import { createLegacyGameImportRepository } from '@phub/database';
import type { LegacyGamesMongoAdapter } from '@phub/legacy-games-adapter';
import type { Logger } from 'pino';
import type { Pool } from 'pg';

export interface LegacyGamesRosterSyncCycleResult {
  readonly attempted: number;
  readonly imported: number;
  readonly synced: number;
  readonly bootstrapped: number;
  readonly unchanged: number;
  readonly conflicts: number;
  readonly skipped: number;
}

function isoAtOffset(now: Date, days: number): string {
  return new Date(now.getTime() + days * 86_400_000).toISOString();
}

/**
 * Imports previously unseen aggregates, then mirrors participants only for migration-owned
 * Games. The repository uses aggregate revisions to quarantine any game touched locally.
 */
export async function runLegacyGamesRosterSyncCycle(input: {
  readonly pool: Pool;
  readonly config: AppConfig;
  readonly logger: Logger;
  readonly source: Pick<LegacyGamesMongoAdapter, 'read'>;
  readonly now?: Date;
}): Promise<LegacyGamesRosterSyncCycleResult> {
  if (!input.config.LEGACY_GAMES_ROSTER_SYNC_ENABLED) {
    return {
      attempted: 0,
      imported: 0,
      synced: 0,
      bootstrapped: 0,
      unchanged: 0,
      conflicts: 0,
      skipped: 0,
    };
  }
  const now = input.now ?? new Date();
  const correlationId = `legacy-games-roster-sync-${randomUUID()}`;
  const snapshots = await input.source.read({
    from: isoAtOffset(now, -input.config.LEGACY_GAMES_ROSTER_SYNC_LOOKBACK_DAYS),
    to: isoAtOffset(now, input.config.LEGACY_GAMES_ROSTER_SYNC_LOOKAHEAD_DAYS),
    limit: input.config.LEGACY_GAMES_ROSTER_SYNC_LIMIT,
  });
  const repository = createLegacyGameImportRepository(input.pool);
  const imported = await repository.importSnapshots({
    tenantKey: input.config.LEGACY_GAMES_ROSTER_SYNC_TENANT_KEY as string,
    snapshots,
    correlationId,
    now,
  });
  const mirrored = await repository.synchronizeParticipants({
    tenantKey: input.config.LEGACY_GAMES_ROSTER_SYNC_TENANT_KEY as string,
    snapshots,
    correlationId,
    now,
  });
  const result = {
    attempted: snapshots.length,
    imported: imported.imported.length,
    synced: mirrored.synced.length,
    bootstrapped: mirrored.bootstrapped,
    unchanged: mirrored.unchanged,
    conflicts: mirrored.conflicts,
    skipped: mirrored.skipped,
  };
  input.logger.info(
    {
      tenantId: mirrored.tenantId,
      correlationId,
      ...result,
    },
    'legacy Games roster synchronization completed',
  );
  return result;
}
