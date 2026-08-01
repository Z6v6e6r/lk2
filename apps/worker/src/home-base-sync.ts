import { randomUUID } from 'node:crypto';

import type { AppConfig } from '@phub/config';
import type { Logger } from 'pino';
import type { Pool } from 'pg';

import { listDueHomeBaseUsers, projectHomeBaseUser } from './home-base-projector.js';

export interface HomeBaseSyncCycleResult {
  readonly attempted: number;
  readonly projected: number;
  readonly unchanged: number;
  readonly failed: number;
}

export async function runHomeBaseSyncCycle(input: {
  readonly pool: Pool;
  readonly config: AppConfig;
  readonly logger: Logger;
  readonly now?: Date;
}): Promise<HomeBaseSyncCycleResult> {
  if (!input.config.HOME_BASE_SYNC_ENABLED) {
    return { attempted: 0, projected: 0, unchanged: 0, failed: 0 };
  }
  const now = input.now ?? new Date();
  const dueBefore = new Date(now.getTime() - input.config.HOME_BASE_SYNC_INTERVAL_MS);
  const tenants = await input.pool.query<{ id: string }>(
    'select id from identity.tenants where active = true order by id',
  );
  let attempted = 0;
  let projected = 0;
  let unchanged = 0;
  let failed = 0;
  const cycleSeed = now.getTime().toString();
  for (const tenant of tenants.rows) {
    const users = await listDueHomeBaseUsers({
      pool: input.pool,
      tenantId: tenant.id,
      dueBefore,
      limit: input.config.HOME_BASE_SYNC_BATCH_SIZE,
      cycleSeed,
    });
    for (const user of users) {
      attempted += 1;
      const correlationId = randomUUID();
      try {
        const result = await projectHomeBaseUser({
          pool: input.pool,
          tenantId: tenant.id,
          userId: user.userId,
          correlationId,
          ttlSeconds: input.config.HOME_PROJECTION_TTL_SECONDS,
          now,
        });
        if (result.outcome === 'projected') projected += 1;
        else unchanged += 1;
        input.logger.info(
          { tenantId: tenant.id, userId: user.userId, correlationId, ...result },
          'HomeBase projection refreshed',
        );
      } catch (error) {
        failed += 1;
        input.logger.warn(
          { err: error, tenantId: tenant.id, userId: user.userId, correlationId },
          'HomeBase projection refresh deferred',
        );
      }
    }
  }
  return { attempted, projected, unchanged, failed };
}
