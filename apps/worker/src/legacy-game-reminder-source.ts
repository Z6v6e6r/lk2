import { randomUUID } from 'node:crypto';

import type { WorkerConfig } from '@phub/config';
import {
  beginLegacyGameReminderSourceCycle,
  completeLegacyGameReminderSourceCycle,
  failLegacyGameReminderSourceCycle,
} from '@phub/database';
import type { LegacyGameSourceSnapshot, LegacyGamesMongoAdapter } from '@phub/legacy-games-adapter';
import type { Logger } from 'pino';
import type { Pool } from 'pg';

import { refreshPreparingLegacyGameStartReminderTarget } from './notification-scenarios.js';

export interface LegacyGameReminderSourceCycleResult {
  readonly attempted: number;
  readonly changed: number;
  readonly unchanged: number;
  readonly missing: number;
  readonly skippedUnmapped: number;
  readonly refreshed: number;
}

export function legacyGameReminderErrorCode(error: unknown): string {
  const value = error instanceof Error ? error.message : '';
  return /^[A-Z][A-Z0-9_]{2,127}$/.test(value) ? value : 'LEGACY_GAME_REMINDER_SOURCE_FAILED';
}

function mergeSnapshots(
  window: readonly LegacyGameSourceSnapshot[],
  tracked: readonly LegacyGameSourceSnapshot[],
  trackedExternalIds: readonly string[],
): LegacyGameSourceSnapshot[] {
  const exactIds = new Set(trackedExternalIds);
  const byId = new Map<string, LegacyGameSourceSnapshot>();
  const notTracked = window.filter(
    (snapshot) =>
      ![snapshot.externalId, ...(snapshot.externalAliases ?? [])].some((id) => exactIds.has(id)),
  );
  for (const snapshot of [...notTracked, ...tracked]) {
    const previous = byId.get(snapshot.externalId);
    if (
      previous &&
      (previous.externalVersion !== snapshot.externalVersion ||
        previous.sourceUpdatedAt !== snapshot.sourceUpdatedAt)
    )
      throw new Error('LEGACY_GAME_REMINDER_SOURCE_REVISION_CONFLICT');
    byId.set(snapshot.externalId, snapshot);
  }
  return [...byId.values()];
}

export async function runLegacyGameReminderSourceCycle(input: {
  readonly pool: Pool;
  readonly config: WorkerConfig;
  readonly source: Pick<LegacyGamesMongoAdapter, 'readReminderWindow' | 'readByExternalIds'>;
  readonly logger: Logger;
  readonly now?: Date;
}): Promise<LegacyGameReminderSourceCycleResult> {
  if (!input.config.LEGACY_GAME_REMINDERS_SOURCE_ENABLED) {
    return {
      attempted: 0,
      changed: 0,
      unchanged: 0,
      missing: 0,
      skippedUnmapped: 0,
      refreshed: 0,
    };
  }
  const now = input.now ?? new Date();
  const windowTo = new Date(
    now.getTime() + input.config.LEGACY_GAME_REMINDERS_LOOKAHEAD_DAYS * 86_400_000,
  );
  const generationId = randomUUID();
  const admission = await beginLegacyGameReminderSourceCycle(input.pool, {
    tenantKey: input.config.LEGACY_GAME_REMINDERS_TENANT_KEY as string,
    generationId,
    now,
    trackedLimit: input.config.LEGACY_GAME_REMINDERS_LIMIT,
  });
  try {
    const window = await input.source.readReminderWindow({
      from: now.toISOString(),
      to: windowTo.toISOString(),
      limit: input.config.LEGACY_GAME_REMINDERS_LIMIT,
    });
    const externalIds = [...new Set(admission.tracked.flatMap((target) => target.externalIds))];
    const tracked = await input.source.readByExternalIds({
      externalIds,
      limit: input.config.LEGACY_GAME_REMINDERS_LIMIT,
    });
    const snapshots = mergeSnapshots(window, tracked, externalIds);
    let refreshed = 0;
    const result = await completeLegacyGameReminderSourceCycle(input.pool, {
      admission,
      snapshots,
      now,
      windowTo,
      beforeFinalize: async (client, preparing) => {
        for (const gameId of preparing.refreshGameIds) {
          await refreshPreparingLegacyGameStartReminderTarget(client, {
            tenantId: preparing.tenantId,
            gameId,
            sourceEventId: randomUUID(),
            occurredAt: now,
            maxLegacySourceAgeMs: input.config.LEGACY_GAME_REMINDERS_MAX_SOURCE_AGE_MS,
            generationId: preparing.generationId,
          });
          refreshed += 1;
        }
      },
    });
    const summary = {
      attempted: snapshots.length,
      changed: result.changedGameIds.length,
      unchanged: result.unchanged,
      missing: result.missing,
      skippedUnmapped: result.skippedUnmapped,
      refreshed,
    };
    input.logger.info(
      {
        tenantId: result.tenantId,
        generationId,
        ...summary,
      },
      'isolated legacy game reminder source refreshed',
    );
    return summary;
  } catch (error) {
    await failLegacyGameReminderSourceCycle(input.pool, {
      tenantId: admission.tenantId,
      generationId,
      errorCode: legacyGameReminderErrorCode(error),
    });
    throw error;
  }
}
