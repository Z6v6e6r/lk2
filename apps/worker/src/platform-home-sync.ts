import { randomUUID } from 'node:crypto';

import type { AppConfig } from '@phub/config';
import type { Logger } from 'pino';
import type { Pool } from 'pg';

import {
  listDuePlatformHomeUsers,
  synchronizePlatformHomeUser,
} from './platform-home-repository.js';

export interface PlatformHomeSyncCycleResult {
  readonly attempted: number;
  readonly synced: number;
  readonly failed: number;
}

function failureCode(error: unknown): string {
  if (error instanceof Error && /^[A-Z0-9_]+$/.test(error.message)) return error.message;
  return 'PLATFORM_HOME_SYNC_FAILED';
}

export async function runPlatformHomeSyncCycle(input: {
  readonly pool: Pool;
  readonly config: AppConfig;
  readonly logger: Logger;
  readonly now?: Date;
}): Promise<PlatformHomeSyncCycleResult> {
  if (!input.config.HOME_VIVA_SYNC_ENABLED) return { attempted: 0, synced: 0, failed: 0 };
  const now = input.now ?? new Date();
  const dueBefore = new Date(now.getTime() - input.config.HOME_VIVA_SYNC_INTERVAL_MS);
  const tenants = await input.pool.query<{ id: string }>(
    'select id from identity.tenants where active = true order by id',
  );
  let attempted = 0;
  let synced = 0;
  let failed = 0;
  let remaining = input.config.HOME_VIVA_SYNC_BATCH_SIZE;
  for (const tenant of tenants.rows) {
    if (remaining <= 0) break;
    const users = await listDuePlatformHomeUsers({
      pool: input.pool,
      tenantId: tenant.id,
      dueBefore,
      limit: remaining,
    });
    remaining -= users.length;
    for (const user of users) {
      attempted += 1;
      const correlationId = randomUUID();
      try {
        const result = await synchronizePlatformHomeUser({
          pool: input.pool,
          tenantId: tenant.id,
          userId: user.userId,
          correlationId,
          fetchedAt: now.toISOString(),
        });
        synced += 1;
        input.logger.info(
          { tenantId: tenant.id, userId: user.userId, correlationId, ...result },
          'platform Home source synchronized',
        );
      } catch (error) {
        failed += 1;
        input.logger.warn(
          {
            tenantId: tenant.id,
            userId: user.userId,
            correlationId,
            code: failureCode(error),
          },
          'platform Home source synchronization deferred',
        );
      }
    }
  }
  return { attempted, synced, failed };
}
