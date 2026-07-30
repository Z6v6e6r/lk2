import { loadConfig } from '@phub/config';
import type { Logger } from 'pino';
import { describe, expect, it, vi } from 'vitest';

const { listDueHomeBaseUsers, projectHomeBaseUser } = vi.hoisted(() => ({
  listDueHomeBaseUsers: vi.fn(),
  projectHomeBaseUser: vi.fn(),
}));

vi.mock('./home-base-projector.js', () => ({
  listDueHomeBaseUsers,
  projectHomeBaseUser,
}));

import { runHomeBaseSyncCycle } from './home-base-sync.js';

const tenantId = '86afbe01-0318-4dd2-bc25-303b7bf0d430';
const secondTenantId = '96afbe01-0318-4dd2-bc25-303b7bf0d430';
const userId = '49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca';
const validEnvironment = {
  APP_ENV: 'ci',
  DATABASE_URL: 'postgresql://phub:test@localhost:5432/phub',
  REDIS_URL: 'redis://localhost:6379',
  RABBITMQ_URL: 'amqp://phub:test@localhost:5672',
  JWT_ISSUER: 'phub-identity',
  JWT_AUDIENCE: 'phub-api',
  JWT_ACCESS_SECRET: 'test-access-secret-at-least-32-characters',
  JWT_REFRESH_SECRET: 'test-refresh-secret-at-least-32-characters',
} as const;

describe('HomeBase synchronization cycle', () => {
  it('does not read the database while the recovery projection is disabled', async () => {
    const query = vi.fn();
    const pool = { query } as never;
    const logger = { info: vi.fn(), warn: vi.fn() } as unknown as Logger;
    const config = loadConfig(validEnvironment);

    await expect(runHomeBaseSyncCycle({ pool, config, logger })).resolves.toEqual({
      attempted: 0,
      projected: 0,
      unchanged: 0,
      failed: 0,
    });
    expect(query).not.toHaveBeenCalled();
  });

  it('runs a bounded active-user backfill per tenant and counts unchanged projections', async () => {
    listDueHomeBaseUsers.mockResolvedValueOnce([{ userId }]).mockResolvedValueOnce([{ userId }]);
    projectHomeBaseUser
      .mockResolvedValueOnce({
        outcome: 'unchanged',
        sourceRevision: '4',
        snapshotVersion: 'home-base-v1-4',
        communities: 'READY',
        promotions: 'UNAVAILABLE',
        invalidSections: [],
      })
      .mockResolvedValueOnce({
        outcome: 'unchanged',
        sourceRevision: '2',
        snapshotVersion: 'home-base-v1-2',
        communities: 'UNAVAILABLE',
        promotions: 'READY',
        invalidSections: [],
      });
    const pool = {
      query: vi
        .fn()
        .mockResolvedValue({ rows: [{ id: tenantId }, { id: secondTenantId }], rowCount: 2 }),
    } as never;
    const logger = { info: vi.fn(), warn: vi.fn() } as unknown as Logger;
    const config = loadConfig({ ...validEnvironment, HOME_BASE_SYNC_ENABLED: 'true' });
    const now = new Date('2026-07-29T12:00:00.000Z');

    await expect(runHomeBaseSyncCycle({ pool, config, logger, now })).resolves.toEqual({
      attempted: 2,
      projected: 0,
      unchanged: 2,
      failed: 0,
    });
    expect(listDueHomeBaseUsers).toHaveBeenCalledTimes(2);
    for (const currentTenantId of [tenantId, secondTenantId]) {
      expect(listDueHomeBaseUsers).toHaveBeenCalledWith({
        pool,
        tenantId: currentTenantId,
        dueBefore: new Date('2026-07-29T11:58:00.000Z'),
        limit: 20,
        cycleSeed: '1785326400000',
      });
      expect(projectHomeBaseUser).toHaveBeenCalledWith(
        expect.objectContaining({
          pool,
          tenantId: currentTenantId,
          userId,
          now,
          ttlSeconds: 300,
        }),
      );
    }
  });
});
