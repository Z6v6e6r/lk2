import { randomUUID } from 'node:crypto';
import { withTenantTransaction } from '@phub/database';
import { createNotificationEndpointCipher, type PushDeliveryResult } from '@phub/notifications';
import { Pool } from 'pg';
import type { Logger } from 'pino';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { runFcmDeliveryBatch } from './fcm-delivery.js';
import { runWebPushDeliveryBatch } from './web-push-delivery.js';
import { deferNotificationDeliveryWithoutAttempt } from './notification-delivery-finalizer.js';
import { checkOrdinaryPushPolicy } from './ordinary-push-policy.js';

// Discovered by the existing quality-full test:source **/*.test.ts contour after migrations.
// A CI target mismatch fails collection instead of silently skipping required physical evidence.
const ci = process.env.GITHUB_ACTIONS === 'true' && process.env.APP_ENV === 'ci';
const url = 'postgresql://phub:ci-password@localhost:5432/phub';
if (
  ci &&
  (process.env.TIMEWEB_STANDARD_DOCKER_VERIFY !== '1' || process.env.DATABASE_URL !== url)
) {
  throw new Error('ORDINARY_PUSH_CI_DATABASE_TARGET_INVALID');
}
const physical = ci ? describe.sequential : describe.skip;
physical('ordinary FCM/Web policy on existing PostgreSQL16 CI fixture', () => {
  const tenantId = randomUUID();
  const applicationName = `ordinary-push-${tenantId}`;
  const owner = new Pool({ connectionString: url, max: 4 });
  const first = new Pool({ connectionString: url, max: 2, application_name: applicationName });
  const second = new Pool({ connectionString: url, max: 2, application_name: applicationName });
  const cipher = createNotificationEndpointCipher({
    serializedKeys: JSON.stringify({ test: Buffer.alloc(32, 9).toString('base64') }),
    activeKeyId: 'test',
  });
  const tx = <T>(fn: Parameters<typeof withTenantTransaction<T>>[2]) =>
    withTenantTransaction(owner, tenantId, fn);
  beforeAll(async () => {
    expect(
      Number(
        (await owner.query<{ server_version_num: string }>('show server_version_num')).rows[0]
          ?.server_version_num,
      ),
    ).toBeGreaterThanOrEqual(160000);
    await owner.query(
      "insert into identity.tenants(id,tenant_key,display_name) values($1,$2,'Synthetic ordinary push')",
      [tenantId, `ordinary-${tenantId}`],
    );
    await tx((c) =>
      c.query(
        'insert into notifications.tenant_runtime_settings(tenant_id,android_push_enabled,web_push_enabled) values($1,true,true)',
        [tenantId],
      ),
    );
  });
  afterAll(async () => {
    await first.end();
    await second.end();
    try {
      await tx(async (c) => {
        for (const table of [
          'audit.outbox_events',
          'audit.audit_log',
          'notifications.delivery_receipts',
          'notifications.delivery_attempts',
          'integration.notification_provider_links',
          'notifications.deliveries',
          'notifications.intents',
          'integration.notification_endpoints',
          'integration.notification_provider_accounts',
          'notifications.templates',
          'notifications.user_preferences',
          'notifications.tenant_runtime_settings',
          'identity.users',
        ]) {
          await c.query(`delete from ${table} where tenant_id=$1`, [tenantId]);
        }
      });
      await owner.query('delete from identity.tenants where id=$1', [tenantId]);
    } finally {
      await owner.end();
    }
  });
  async function fixture(provider: 'FCM' | 'WEB_PUSH') {
    const user = randomUUID(),
      otherUser = randomUUID(),
      endpoint = randomUUID(),
      account = randomUUID(),
      template = randomUUID(),
      intent = randomUUID(),
      delivery = randomUUID();
    const appId = `ordinary-${account}`;
    const plaintext =
      provider === 'FCM'
        ? 'synthetic-token'
        : JSON.stringify({
            endpoint: 'https://push.example.test/synthetic',
            keys: { p256dh: 'a'.repeat(40), auth: 'b'.repeat(16) },
          });
    const encrypted = cipher.encrypt(plaintext);
    await tx(async (c) => {
      for (const id of [user, otherUser])
        await c.query('insert into identity.users(tenant_id,id) values($1,$2)', [tenantId, id]);
      await c.query(
        "insert into notifications.templates(tenant_id,id,template_key,version,category,channels,title_template,body_template,active) values($1,$2,$3,1,'ADMIN_MESSAGE',array['PUSH'],'Synthetic','Synthetic',true)",
        [tenantId, template, `test-${template}`],
      );
      await c.query(
        "insert into integration.notification_provider_accounts(tenant_id,id,channel,platform,provider,app_id,environment,credential_ref,status) values($1,$2,'PUSH',$3,$4,$5,'SANDBOX','synthetic','ACTIVE')",
        [tenantId, account, provider === 'FCM' ? 'ANDROID' : 'WEB', provider, appId],
      );
      await c.query(
        "insert into integration.notification_endpoints(tenant_id,id,user_id,provider_account_id,channel,address_ciphertext,address_hash,encryption_key_id) values($1,$2,$3,$4,'PUSH',$5,$6,$7)",
        [
          tenantId,
          endpoint,
          user,
          account,
          encrypted.ciphertext,
          randomUUID().replaceAll('-', '').repeat(2),
          encrypted.keyId,
        ],
      );
      await c.query(
        "insert into notifications.intents(tenant_id,id,recipient_user_id,source_event_id,template_id,dedupe_key,rendered_title,rendered_body,state) values($1,$2,$3,$4,$5,$6,'Synthetic','Synthetic','PROCESSING')",
        [tenantId, intent, user, randomUUID(), template, randomUUID()],
      );
      await c.query(
        "insert into notifications.deliveries(tenant_id,id,intent_id,endpoint_id,channel) values($1,$2,$3,$4,'PUSH')",
        [tenantId, delivery, intent, endpoint],
      );
    });
    const options = {
      tenantId,
      appId,
      environment: 'SANDBOX' as const,
      cipher,
      logger: { info: vi.fn() } as unknown as Logger,
      maxAttempts: 3,
      retryBaseMs: 1000,
    };
    return {
      user,
      otherUser,
      endpoint,
      account,
      template,
      intent,
      delivery,
      appId,
      provider,
      run: (pool: Pool, send: (input: unknown) => Promise<PushDeliveryResult>) =>
        provider === 'FCM'
          ? runFcmDeliveryBatch({ ...options, pool, adapter: { platform: 'ANDROID', send } })
          : runWebPushDeliveryBatch({
              ...options,
              pool,
              batchSize: 1,
              adapter: { platform: 'WEB', send },
            }),
      job: {
        tenantId,
        deliveryId: delivery,
        intentId: intent,
        endpointId: endpoint,
        providerAccountId: account,
        attemptNo: 1,
      },
    };
  }
  async function state(id: string) {
    return (
      await tx((c) =>
        c.query<{ state: string; attempt_count: number; last_error_code: string | null }>(
          'select state,attempt_count,last_error_code from notifications.deliveries where tenant_id=$1 and id=$2',
          [tenantId, id],
        ),
      )
    ).rows[0];
  }
  // Commit the real claim, then change policy using an independent connection before dispatch.
  function afterClaim(change: () => Promise<unknown>): Pool {
    let applied = false;
    return {
      connect: async () => {
        const c = await first.connect();
        return {
          query: async (sql: string, values?: unknown[]) => {
            const r = await c.query(sql, values);
            if (sql === 'commit' && !applied) {
              applied = true;
              await change();
            }
            return r;
          },
          release: () => c.release(),
        };
      },
    } as unknown as Pool;
  }
  for (const provider of ['FCM', 'WEB_PUSH'] as const) {
    it.each(['transfer', 'revoke', 'optout', 'quiet'] as const)(
      `${provider} suppresses %s committed after claim`,
      async (change) => {
        const f = await fixture(provider);
        const changePolicy = () =>
          tx(async (c) => {
            if (change === 'transfer')
              await c.query(
                'update integration.notification_endpoints set user_id=$3 where tenant_id=$1 and id=$2',
                [tenantId, f.endpoint, f.otherUser],
              );
            else if (change === 'revoke')
              await c.query(
                "update integration.notification_endpoints set status='REVOKED' where tenant_id=$1 and id=$2",
                [tenantId, f.endpoint],
              );
            else if (change === 'optout')
              await c.query(
                "insert into notifications.user_preferences(tenant_id,user_id,category,channel,enabled) values($1,$2,'ADMIN_MESSAGE','PUSH',false)",
                [tenantId, f.user],
              );
            else
              await c.query(
                "insert into notifications.user_preferences(tenant_id,user_id,category,channel,quiet_from,quiet_until,timezone) values($1,$2,'ADMIN_MESSAGE','PUSH',((clock_timestamp() at time zone 'UTC')-interval '1 hour')::time,((clock_timestamp() at time zone 'UTC')+interval '1 hour')::time,'UTC')",
                [tenantId, f.user],
              );
          });
        const send = vi.fn();
        expect(await f.run(afterClaim(changePolicy), send)).toMatchObject({
          claimed: 1,
          dead: 1,
          sent: 0,
        });
        expect(send).not.toHaveBeenCalled();
        expect(await state(f.delivery)).toMatchObject({ state: 'SUPPRESSED', attempt_count: 0 });
        const counts = (
          await tx((c) =>
            c.query<{ attempts: number; events: number }>(
              `select
        (select count(*) from notifications.delivery_attempts where tenant_id=$1 and delivery_id=$2)::int attempts,
        (select count(*) from audit.outbox_events where tenant_id=$1 and aggregate_id=$2 and event_type='notifications.delivery.changed.v1')::int events`,
              [tenantId, f.delivery],
            ),
          )
        ).rows[0];
        expect(counts).toEqual({ attempts: 0, events: 1 });
      },
    );
    it.each(['rotate', 'transfer'] as const)(
      `${provider} decrypts current token and fences later %s`,
      async (change) => {
        const f = await fixture(provider);
        const rotated =
          provider === 'FCM'
            ? 'rotated-token'
            : JSON.stringify({
                endpoint: 'https://push.example.test/rotated',
                keys: { p256dh: 'a'.repeat(40), auth: 'b'.repeat(16) },
              });
        const encrypted = cipher.encrypt(rotated);
        const send = vi.fn(async (request: unknown) => {
          expect((request as { endpoint: string }).endpoint).toBe(rotated);
          await tx((c) =>
            c.query(
              'update integration.notification_endpoints set user_id=$3,address_ciphertext=$4 where tenant_id=$1 and id=$2',
              [
                tenantId,
                f.endpoint,
                change === 'transfer' ? f.otherUser : f.user,
                change === 'rotate'
                  ? cipher.encrypt('new-address').ciphertext
                  : encrypted.ciphertext,
              ],
            ),
          );
          return {
            outcome: 'terminal_failure' as const,
            errorCode: 'SYNTHETIC_INVALID',
            invalidate: true,
          };
        });
        await f.run(
          afterClaim(() =>
            tx((c) =>
              c.query(
                'update integration.notification_endpoints set address_ciphertext=$3 where tenant_id=$1 and id=$2',
                [tenantId, f.endpoint, encrypted.ciphertext],
              ),
            ),
          ),
          send,
        );
        expect(send).toHaveBeenCalledOnce();
        const endpoint = (
          await tx((c) =>
            c.query<{ status: string; user_id: string }>(
              'select status,user_id from integration.notification_endpoints where tenant_id=$1 and id=$2',
              [tenantId, f.endpoint],
            ),
          )
        ).rows[0];
        expect(endpoint).toEqual({
          status: 'ACTIVE',
          user_id: change === 'transfer' ? f.otherUser : f.user,
        });
        expect(await state(f.delivery)).toMatchObject({ state: 'DEAD', attempt_count: 1 });
      },
    );
  }
  it('rolls back suppression, attempt restoration and intent when outbox insert fails', async () => {
    const f = await fixture('WEB_PUSH');
    await tx(async (c) => {
      await c.query(
        "update notifications.deliveries set state='SENDING',attempt_count=1,lease_expires_at=clock_timestamp()+interval '60 seconds' where tenant_id=$1 and id=$2",
        [tenantId, f.delivery],
      );
      await c.query(
        "update integration.notification_endpoints set status='REVOKED' where tenant_id=$1 and id=$2",
        [tenantId, f.endpoint],
      );
    });
    const failing = {
      connect: async () => {
        const c = await first.connect();
        return {
          query: (sql: string, values?: unknown[]) =>
            sql.includes('insert into audit.outbox_events')
              ? c.query('select 1/0')
              : c.query(sql, values),
          release: () => c.release(),
        };
      },
    } as unknown as Pool;
    await expect(
      checkOrdinaryPushPolicy({
        pool: failing,
        job: f.job,
        provider: 'WEB_PUSH',
        appId: f.appId,
        environment: 'SANDBOX',
      }),
    ).rejects.toThrow();
    expect(await state(f.delivery)).toMatchObject({
      state: 'SENDING',
      attempt_count: 1,
      last_error_code: null,
    });
    expect(
      (
        await tx((c) =>
          c.query<{ state: string }>(
            'select state from notifications.intents where tenant_id=$1 and id=$2',
            [tenantId, f.intent],
          ),
        )
      ).rows[0]?.state,
    ).toBe('PROCESSING');
    expect(
      (
        await tx((c) =>
          c.query('select id from audit.outbox_events where tenant_id=$1 and aggregate_id=$2', [
            tenantId,
            f.delivery,
          ]),
        )
      ).rowCount,
    ).toBe(0);
    expect(
      (
        await checkOrdinaryPushPolicy({
          pool: first,
          job: f.job,
          provider: 'WEB_PUSH',
          appId: f.appId,
          environment: 'SANDBOX',
        })
      ).outcome,
    ).toBe('SUPPRESSED');
  });
  it('serializes simultaneous sibling suppression before reading terminal intent state', async () => {
    const f = await fixture('WEB_PUSH'),
      sibling = randomUUID(),
      endpoint = randomUUID();
    await tx(async (c) => {
      await c.query(
        "insert into integration.notification_endpoints(tenant_id,id,user_id,provider_account_id,channel,address_ciphertext,address_hash,encryption_key_id,status) select tenant_id,$3,user_id,provider_account_id,channel,address_ciphertext,$4,encryption_key_id,'REVOKED' from integration.notification_endpoints where tenant_id=$1 and id=$2",
        [tenantId, f.endpoint, endpoint, randomUUID().replaceAll('-', '').repeat(2)],
      );
      await c.query(
        "update integration.notification_endpoints set status='REVOKED' where tenant_id=$1 and id=$2",
        [tenantId, f.endpoint],
      );
      await c.query(
        "insert into notifications.deliveries(tenant_id,id,intent_id,endpoint_id,channel,state,attempt_count,lease_expires_at) values($1,$2,$3,$4,'PUSH','SENDING',1,clock_timestamp()+interval '60 seconds')",
        [tenantId, sibling, f.intent, endpoint],
      );
      await c.query(
        "update notifications.deliveries set state='SENDING',attempt_count=1,lease_expires_at=clock_timestamp()+interval '60 seconds' where tenant_id=$1 and id=$2",
        [tenantId, f.delivery],
      );
    });
    const holder = await owner.connect();
    await holder.query('begin');
    await holder.query(
      'select id from notifications.intents where tenant_id=$1 and id=$2 for update',
      [tenantId, f.intent],
    );
    const operations = Promise.all([
      checkOrdinaryPushPolicy({
        pool: first,
        job: f.job,
        provider: 'WEB_PUSH',
        appId: f.appId,
        environment: 'SANDBOX',
      }),
      checkOrdinaryPushPolicy({
        pool: second,
        job: { ...f.job, deliveryId: sibling, endpointId: endpoint },
        provider: 'WEB_PUSH',
        appId: f.appId,
        environment: 'SANDBOX',
      }),
    ]);
    // Attach a rejection handler while waiting, then always release the test-owned lock.
    void operations.catch(() => undefined);
    try {
      await vi.waitFor(
        async () => {
          const r = await owner.query<{ count: number }>(
            "select count(*)::int count from pg_stat_activity where application_name=$1 and wait_event_type='Lock'",
            [applicationName],
          );
          expect(r.rows[0]?.count).toBe(2);
        },
        { timeout: 2000, interval: 10 },
      );
    } finally {
      await holder.query('rollback');
      holder.release();
    }
    expect(await operations).toEqual([{ outcome: 'SUPPRESSED' }, { outcome: 'SUPPRESSED' }]);
    expect(
      (
        await tx((c) =>
          c.query<{ state: string }>(
            'select state from notifications.intents where tenant_id=$1 and id=$2',
            [tenantId, f.intent],
          ),
        )
      ).rows[0]?.state,
    ).toBe('SUPPRESSED');
  });
  it('repeated post-claim FCM advisory contention restores the unconsumed attempt', async () => {
    const f = await fixture('FCM'),
      holder = await owner.connect(),
      send = vi.fn();
    try {
      for (let cycle = 0; cycle < 2; cycle++) {
        await tx((c) =>
          c.query(
            'update notifications.deliveries set next_attempt_at=clock_timestamp() where tenant_id=$1 and id=$2',
            [tenantId, f.delivery],
          ),
        );
        const guarded = afterClaim(async () => {
          await holder.query('begin');
          await holder.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [
            `notification-runtime:${tenantId}`,
          ]);
        });
        expect(await f.run(guarded, send)).toMatchObject({ claimed: 1, retried: 1, sent: 0 });
        expect(await state(f.delivery)).toMatchObject({
          state: 'PENDING',
          attempt_count: 0,
          last_error_code: 'FCM_ROLLOUT_GATE_BUSY',
        });
        await holder.query('rollback');
      }
      expect(send).not.toHaveBeenCalled();
    } finally {
      await holder.query('rollback');
      holder.release();
    }
  });
  it('ordinary-only deferral rejects stale generation, late lease, foreign binding and retained scenario scheduling', async () => {
    for (const variant of [
      'attempt',
      'lease',
      'intent',
      'endpoint',
      'v1',
      'v2',
      'run',
      'dispatch',
    ] as const) {
      const f = await fixture('FCM');
      await tx(async (c) => {
        await c.query(
          "update notifications.deliveries set state='SENDING',attempt_count=1,lease_expires_at=clock_timestamp()+interval '60 seconds' where tenant_id=$1 and id=$2",
          [tenantId, f.delivery],
        );
        if (variant === 'lease')
          await c.query(
            "update notifications.deliveries set lease_expires_at=clock_timestamp()-interval '1 second' where tenant_id=$1 and id=$2",
            [tenantId, f.delivery],
          );
        if (variant === 'v1')
          await c.query(
            "update notifications.deliveries set scenario_available_at=clock_timestamp(),next_attempt_at='infinity'::timestamptz where tenant_id=$1 and id=$2",
            [tenantId, f.delivery],
          );
        if (variant === 'v2')
          await c.query(
            "update notifications.deliveries set scenario_v2_available_at=clock_timestamp(),next_attempt_at='infinity'::timestamptz where tenant_id=$1 and id=$2",
            [tenantId, f.delivery],
          );
        if (variant === 'run')
          await c.query(
            `update notifications.intents set render_data='{"scenarioRunId":null}'::jsonb where tenant_id=$1 and id=$2`,
            [tenantId, f.intent],
          );
        if (variant === 'dispatch')
          await c.query(
            'update notifications.deliveries set scenario_dispatch_started_at=clock_timestamp() where tenant_id=$1 and id=$2',
            [tenantId, f.delivery],
          );
      });
      const before = (
        await tx((c) =>
          c.query(
            'select to_jsonb(d)::text snapshot from notifications.deliveries d where tenant_id=$1 and id=$2',
            [tenantId, f.delivery],
          ),
        )
      ).rows[0] as { snapshot: string };
      const altered = {
        ...f.job,
        startedAt: new Date().toISOString(),
        ...(variant === 'attempt' ? { attemptNo: 2 } : {}),
        ...(variant === 'intent' ? { intentId: randomUUID() } : {}),
        ...(variant === 'endpoint' ? { endpointId: randomUUID() } : {}),
      };
      expect(
        await deferNotificationDeliveryWithoutAttempt({
          pool: first,
          job: altered,
          ordinaryOnly: true,
          retryAfterMs: 30000,
          errorCode: 'FCM_ROLLOUT_GATE_BUSY',
        }),
      ).toBe('stale');
      const after = (
        await tx((c) =>
          c.query(
            'select to_jsonb(d)::text snapshot from notifications.deliveries d where tenant_id=$1 and id=$2',
            [tenantId, f.delivery],
          ),
        )
      ).rows[0] as { snapshot: string };
      expect(after).toEqual(before);
    }
  });
  it('policy SELECT observes a preference committed during endpoint-lock wait', async () => {
    const f = await fixture('WEB_PUSH');
    await tx((c) =>
      c.query(
        "update notifications.deliveries set state='SENDING',attempt_count=1,lease_expires_at=clock_timestamp()+interval '60 seconds' where tenant_id=$1 and id=$2",
        [tenantId, f.delivery],
      ),
    );
    const holder = await owner.connect();
    await holder.query('begin');
    await holder.query(
      'select id from integration.notification_endpoints where tenant_id=$1 and id=$2 for update',
      [tenantId, f.endpoint],
    );
    const pending = checkOrdinaryPushPolicy({
      pool: first,
      job: f.job,
      provider: 'WEB_PUSH',
      appId: f.appId,
      environment: 'SANDBOX',
    });
    void pending.catch(() => undefined);
    try {
      await vi.waitFor(
        async () => {
          const r = await owner.query<{ count: number }>(
            "select count(*)::int count from pg_stat_activity where application_name=$1 and wait_event_type='Lock'",
            [applicationName],
          );
          expect(r.rows[0]?.count).toBe(1);
        },
        { timeout: 2000, interval: 10 },
      );
      await holder.query(
        "insert into notifications.user_preferences(tenant_id,user_id,category,channel,enabled) values($1,$2,'ADMIN_MESSAGE','PUSH',false)",
        [tenantId, f.user],
      );
      await holder.query('commit');
    } finally {
      await holder.query('rollback');
      holder.release();
    }
    expect(await pending).toEqual({ outcome: 'SUPPRESSED' });
    expect(await state(f.delivery)).toMatchObject({
      state: 'SUPPRESSED',
      last_error_code: 'OPTED_OUT',
    });
  });
});
