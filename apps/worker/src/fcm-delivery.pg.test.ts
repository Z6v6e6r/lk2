import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import type { Logger } from 'pino';
import { runFcmDeliveryBatch } from './fcm-delivery.js';

// Reuse only the existing quality-full disposable PostgreSQL service. No local provisioning,
// migrations or business fixtures; the two sessions write advisory lock state only.
const fixture =
  process.env.GITHUB_ACTIONS === 'true' &&
  process.env.APP_ENV === 'ci' &&
  process.env.TIMEWEB_STANDARD_DOCKER_VERIFY === '1' &&
  process.env.DATABASE_URL === 'postgresql://phub:ci-password@localhost:5432/phub';
const tenant = 'a7000000-0000-4000-8000-000000000077';
const providerKey = `android-push-provider:${tenant}:ru.padlhub.app:SANDBOX`;
const runtimeKey = `notification-runtime:${tenant}`;
const describeFixture = fixture ? describe : describe.skip;
describeFixture('FCM canonical fence on real PostgreSQL16 CI fixture', () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  beforeAll(async () => {
    expect(
      Number(
        (await pool.query<{ server_version_num: string }>('show server_version_num')).rows[0]
          ?.server_version_num,
      ),
    ).toBeGreaterThanOrEqual(160000);
  });
  afterAll(async () => {
    await pool.end();
  });
  it.each([runtimeKey, providerKey])(
    'busy %s makes zero claim queries or provider calls, then resumes',
    async (key) => {
      const fence = await pool.connect();
      const queries: string[] = [];
      const guarded = {
        connect: async () => {
          const client = await pool.connect();
          return {
            query: async (sql: string, values?: unknown[]) => {
              queries.push(sql);
              return client.query(sql, values);
            },
            release: () => client.release(),
          };
        },
      } as unknown as Pool;
      const send = vi.fn();
      const options = {
        pool: guarded,
        logger: { info: vi.fn() } as unknown as Logger,
        tenantId: tenant,
        appId: 'ru.padlhub.app',
        environment: 'SANDBOX' as const,
        cipher: { activeKeyId: 'fixture', encrypt: vi.fn(), decrypt: vi.fn() },
        adapter: { platform: 'ANDROID' as const, send },
        maxAttempts: 3,
        retryBaseMs: 1000,
      };
      try {
        await fence.query('begin');
        await fence.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [key]);
        expect(await runFcmDeliveryBatch(options)).toMatchObject({ claimed: 0 });
        expect(queries.some((q) => q.includes('from notifications.deliveries'))).toBe(false);
        expect(queries.some((q) => q.includes('update notifications.deliveries'))).toBe(false);
        expect(send).not.toHaveBeenCalled();
        await fence.query('rollback');
        queries.length = 0;
        expect(await runFcmDeliveryBatch(options)).toMatchObject({ claimed: 0 });
        expect(queries.some((q) => q.includes('from notifications.deliveries'))).toBe(true);
        expect(queries.filter((q) => q.includes('pg_try_advisory_xact_lock'))).toHaveLength(2);
        expect(send).not.toHaveBeenCalled();
      } finally {
        await fence.query('rollback');
        fence.release();
      }
    },
  );
});
