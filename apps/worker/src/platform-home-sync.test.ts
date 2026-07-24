import { loadConfig } from '@phub/config';
import type { Logger } from 'pino';
import { describe, expect, it, vi } from 'vitest';

import { runPlatformHomeSyncCycle } from './platform-home-sync.js';

describe('platform Home synchronization cycle', () => {
  it('does not read the database while real Home producers are disabled', async () => {
    const pool = { query: vi.fn() } as never;
    const logger = { info: vi.fn(), warn: vi.fn() } as unknown as Logger;
    const config = loadConfig({
      APP_ENV: 'ci',
      DATABASE_URL: 'postgresql://phub:test@localhost:5432/phub',
      REDIS_URL: 'redis://localhost:6379',
      RABBITMQ_URL: 'amqp://phub:test@localhost:5672',
      JWT_ISSUER: 'phub-identity',
      JWT_AUDIENCE: 'phub-api',
      JWT_ACCESS_SECRET: 'test-access-secret-at-least-32-characters',
      JWT_REFRESH_SECRET: 'test-refresh-secret-at-least-32-characters',
    });

    await expect(runPlatformHomeSyncCycle({ pool, config, logger })).resolves.toEqual({
      attempted: 0,
      synced: 0,
      failed: 0,
    });
  });
});
