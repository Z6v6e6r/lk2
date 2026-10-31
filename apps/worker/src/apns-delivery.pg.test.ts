import { randomUUID } from 'node:crypto';
import { withTenantTransaction } from '@phub/database';
import {
  createNotificationEndpointCipher,
  type NotificationSourceEvent,
  type PushDeliveryResult,
} from '@phub/notifications';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { runApnsDeliveryBatch } from './apns-delivery.js';
import { applyNotificationSourceEvent } from './notification-projector.js';

// Uses only the already-migrated disposable service in the automatic quality-full Actions job.
function ciUrl(): string | undefined {
  if (process.env.GITHUB_ACTIONS !== 'true' || process.env.APP_ENV !== 'ci') return undefined;
  if (!process.env.DATABASE_URL) throw new Error('APNS_CI_DATABASE_MISSING');
  const url = new URL(process.env.DATABASE_URL);
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !['localhost', '127.0.0.1'].includes(url.hostname) ||
    url.username !== 'phub' ||
    url.pathname !== '/phub' ||
    url.port !== '5432' ||
    url.search ||
    url.hash
  )
    throw new Error('APNS_CI_DATABASE_TARGET_INVALID');
  return url.toString();
}
const connectionString = ciUrl();
const physical = connectionString ? describe.sequential : describe.skip;
physical('ordinary APNs physical PostgreSQL delivery and RLS', () => {
  const tenantId = randomUUID(),
    template = randomUUID(),
    rule = randomUUID(),
    account = randomUUID();
  const role = `apns_test_${randomUUID().replaceAll('-', '')}`,
    password = randomUUID();
  const owner = new Pool({ connectionString, max: 4 });
  const applicationName = `apns-${tenantId}`;
  let runtime: Pool;
  let otherWorker: Pool;
  const cipher = createNotificationEndpointCipher({
    serializedKeys: JSON.stringify({ test: Buffer.alloc(32, 7).toString('base64') }),
    activeKeyId: 'test',
  });
  const selector = {
    appId: 'ordinary-apns-test',
    environment: 'SANDBOX' as const,
    credentialRef: 'synthetic-apns',
  };
  const options = (pool: Pool, send: (request: unknown) => Promise<PushDeliveryResult>) => ({
    pool,
    tenantId,
    ...selector,
    cipher,
    adapter: { platform: 'IOS' as const, send },
    enabled: true,
  });
  beforeAll(async () => {
    await owner.query(
      `create role ${role} login password '${password}' nosuperuser nobypassrls nocreatedb nocreaterole noinherit`,
    );
    await owner.query(`grant usage on schema identity,notifications,integration,audit to ${role}`);
    await owner.query(
      `grant select on identity.users,notifications.templates,notifications.trigger_rules,notifications.user_preferences,notifications.tenant_runtime_settings,integration.notification_provider_accounts to ${role}`,
    );
    await owner.query(
      `grant select,insert,update on notifications.intents,notifications.deliveries,notifications.inbox_items,notifications.delivery_attempts,notifications.delivery_receipts,integration.notification_endpoints,integration.notification_provider_links,audit.inbox_events to ${role}`,
    );
    await owner.query(`grant insert on audit.audit_log,audit.outbox_events to ${role}`);
    const url = new URL(connectionString!);
    url.username = role;
    url.password = password;
    runtime = new Pool({
      connectionString: url.toString(),
      max: 2,
      application_name: applicationName,
    });
    otherWorker = new Pool({
      connectionString: url.toString(),
      max: 2,
      application_name: applicationName,
    });
    await owner.query(
      `insert into identity.tenants(id,tenant_key,display_name) values($1,$2,'Synthetic APNs')`,
      [tenantId, `apns-${tenantId}`],
    );
    await withTenantTransaction(owner, tenantId, async (client) => {
      await client.query(
        `insert into notifications.tenant_runtime_settings(tenant_id,in_app_enabled,ios_push_enabled) values($1,true,true)`,
        [tenantId],
      );
      await client.query(
        `insert into notifications.templates(tenant_id,id,template_key,version,category,channels,title_template,body_template,active) values($1,$2,'apns-test',1,'MESSAGING',array['IN_APP','PUSH'],'Synthetic','Synthetic',true)`,
        [tenantId, template],
      );
      await client.query(
        `insert into notifications.trigger_rules(tenant_id,id,rule_key,source_event_type,template_id,audience_selector,active) values($1,$2,'apns-test','messaging.message.created.v1',$3,'{"type":"EVENT_USERS","field":"recipientUserIds"}',true)`,
        [tenantId, rule, template],
      );
      await client.query(
        `insert into integration.notification_provider_accounts(tenant_id,id,channel,platform,provider,app_id,environment,credential_ref,status) values($1,$2,'PUSH','IOS','APNS',$3,$4,$5,'ACTIVE')`,
        [tenantId, account, selector.appId, selector.environment, selector.credentialRef],
      );
    });
  });
  afterAll(async () => {
    await runtime?.end();
    await otherWorker?.end();
    try {
      // Exact generated tenant only; no shared fixture, schema or migration is removed.
      await withTenantTransaction(owner, tenantId, async (client) => {
        for (const table of [
          'audit.outbox_events',
          'audit.audit_log',
          'audit.inbox_events',
          'notifications.delivery_receipts',
          'notifications.delivery_attempts',
          'integration.notification_provider_links',
          'notifications.inbox_items',
          'notifications.deliveries',
          'notifications.intents',
          'integration.notification_endpoints',
          'integration.notification_provider_accounts',
          'notifications.trigger_rules',
          'notifications.templates',
          'notifications.user_preferences',
          'notifications.tenant_runtime_settings',
          'identity.users',
        ])
          await client.query(`delete from ${table} where tenant_id=$1`, [tenantId]);
      });
      await owner.query('delete from identity.tenants where id=$1', [tenantId]);
      await owner.query(`drop owned by ${role}`);
      await owner.query(`drop role if exists ${role}`);
    } finally {
      await owner.end();
    }
  });

  async function fixture() {
    const user = randomUUID(),
      endpoint = randomUUID(),
      conversation = randomUUID();
    const encrypted = cipher.encrypt('ab'.repeat(32));
    await withTenantTransaction(owner, tenantId, async (client) => {
      await client.query(`insert into identity.users(tenant_id,id,status) values($1,$2,'ACTIVE')`, [
        tenantId,
        user,
      ]);
      await client.query(
        `insert into integration.notification_endpoints(tenant_id,id,user_id,provider_account_id,channel,address_ciphertext,address_hash,encryption_key_id) values($1,$2,$3,$4,'PUSH',$5,$6,$7)`,
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
    });
    const event: NotificationSourceEvent = {
      id: randomUUID(),
      tenantId,
      type: 'messaging.message.created.v1',
      aggregateId: conversation,
      occurredAt: new Date().toISOString(),
      correlationId: 'synthetic-apns',
      payload: {
        conversationId: conversation,
        messageId: randomUUID(),
        sequence: 1,
        recipientUserIds: [user],
      },
    };
    expect(
      await applyNotificationSourceEvent({ pool: runtime, event, iosPush: selector }),
    ).toMatchObject({ outcome: 'processed', created: 1, pushQueued: 1 });
    const delivery = (
      await withTenantTransaction(owner, tenantId, (client) =>
        client.query<{ id: string }>(
          `select d.id from notifications.deliveries d join notifications.intents i on i.tenant_id=d.tenant_id and i.id=d.intent_id where d.tenant_id=$1 and i.source_event_id=$2 and d.channel='PUSH'`,
          [tenantId, event.id],
        ),
      )
    ).rows[0]!.id;
    return { user, endpoint, event, delivery };
  }
  async function delivery(id: string) {
    return (
      await withTenantTransaction(owner, tenantId, (client) =>
        client.query<{
          state: string;
          attempt_count: number;
          last_error_code: string | null;
          scenario_dispatch_started_at: Date | null;
        }>(
          `select state,attempt_count,last_error_code,scenario_dispatch_started_at from notifications.deliveries where tenant_id=$1 and id=$2`,
          [tenantId, id],
        ),
      )
    ).rows[0];
  }

  it('deduplicates projection, fences concurrent workers and denies foreign tenant visibility', async () => {
    const item = await fixture();
    expect(
      await applyNotificationSourceEvent({ pool: runtime, event: item.event, iosPush: selector }),
    ).toEqual({ outcome: 'duplicate' });
    let release!: () => void;
    let entered!: () => void;
    const enteredSend = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const send = vi.fn(async () => {
      entered();
      await held;
      return { outcome: 'accepted' as const, externalMessageId: item.delivery };
    });
    const first = runApnsDeliveryBatch(options(runtime, send));
    try {
      await Promise.race([
        enteredSend,
        first.then(() => {
          throw new Error('APNS_DISPATCH_NOT_ENTERED');
        }),
      ]);
      expect(await runApnsDeliveryBatch(options(otherWorker, send))).toBe(0);
      expect(
        (
          await withTenantTransaction(otherWorker, randomUUID(), (client) =>
            client.query('select id from notifications.deliveries where tenant_id=$1', [tenantId]),
          )
        ).rows,
      ).toEqual([]);
    } finally {
      release();
    }
    expect(await first).toBe(1);
    expect(send).toHaveBeenCalledOnce();
    expect(await delivery(item.delivery)).toMatchObject({ state: 'SENT', attempt_count: 1 });
  }, 15000);

  it('serializes terminal-state recomputation for two sibling endpoints', async () => {
    const item = await fixture();
    const siblingEndpoint = randomUUID();
    const sibling = randomUUID();
    await withTenantTransaction(owner, tenantId, async (client) => {
      await client.query(
        `insert into integration.notification_endpoints(tenant_id,id,user_id,provider_account_id,channel,address_ciphertext,address_hash,encryption_key_id)
        select tenant_id,$3,user_id,provider_account_id,channel,address_ciphertext,$4,encryption_key_id from integration.notification_endpoints where tenant_id=$1 and id=$2`,
        [tenantId, item.endpoint, siblingEndpoint, randomUUID().replaceAll('-', '').repeat(2)],
      );
      await client.query(
        `insert into notifications.deliveries(tenant_id,id,intent_id,endpoint_id,channel)
        select tenant_id,$3,intent_id,$4,channel from notifications.deliveries where tenant_id=$1 and id=$2`,
        [tenantId, item.delivery, sibling, siblingEndpoint],
      );
    });
    const locker = await owner.connect();
    await locker.query('begin');
    await locker.query(
      `select id from notifications.intents where tenant_id=$1 and source_event_id=$2 for update`,
      [tenantId, item.event.id],
    );
    const send = vi.fn(() => Promise.resolve({ outcome: 'accepted' as const }));
    const finished = Promise.all([
      runApnsDeliveryBatch(options(runtime, send)),
      runApnsDeliveryBatch(options(otherWorker, send)),
    ]);
    try {
      // Both finalizers are blocked on the same intent. Without the pre-read intent lock both
      // would already have read the other's uncommitted SENDING state and retain PROCESSING.
      await vi.waitFor(
        async () => {
          const waiting = await owner.query<{ count: string }>(
            `select count(*)::text count from pg_stat_activity where application_name=$1 and wait_event_type='Lock'`,
            [applicationName],
          );
          expect(Number(waiting.rows[0]?.count)).toBe(2);
        },
        { timeout: 5000, interval: 20 },
      );
    } finally {
      await locker.query('commit');
      locker.release();
    }
    expect(await finished).toEqual([1, 1]);
    expect(send).toHaveBeenCalledTimes(2);
    expect(
      (
        await withTenantTransaction(owner, tenantId, (client) =>
          client.query<{ state: string }>(
            `select state from notifications.intents where tenant_id=$1 and source_event_id=$2`,
            [tenantId, item.event.id],
          ),
        )
      ).rows[0]?.state,
    ).toBe('DELIVERED');
  }, 15000);

  it('applies opt-out after projection while retaining the durable inbox', async () => {
    const item = await fixture();
    await withTenantTransaction(owner, tenantId, (client) =>
      client.query(
        `insert into notifications.user_preferences(tenant_id,user_id,category,channel,enabled) values($1,$2,'MESSAGING','PUSH',false)`,
        [tenantId, item.user],
      ),
    );
    const send = vi.fn();
    expect(await runApnsDeliveryBatch(options(runtime, send))).toBe(1);
    expect(send).not.toHaveBeenCalled();
    expect(await delivery(item.delivery)).toMatchObject({
      state: 'SUPPRESSED',
      last_error_code: 'OPTED_OUT',
      attempt_count: 0,
    });
    expect(
      (
        await withTenantTransaction(owner, tenantId, (client) =>
          client.query(
            'select id from notifications.inbox_items where tenant_id=$1 and user_id=$2',
            [tenantId, item.user],
          ),
        )
      ).rowCount,
    ).toBe(1);
  });

  it('reclaims expired undispatched work but never resends a committed dispatch after a crash', async () => {
    const before = await fixture();
    await withTenantTransaction(owner, tenantId, (client) =>
      client.query(
        `update notifications.deliveries set state='SENDING',attempt_count=1,lease_expires_at=clock_timestamp()-interval '1 minute' where tenant_id=$1 and id=$2`,
        [tenantId, before.delivery],
      ),
    );
    const send = vi.fn(() => Promise.resolve({ outcome: 'accepted' as const }));
    await runApnsDeliveryBatch(options(runtime, send));
    expect(await delivery(before.delivery)).toMatchObject({ state: 'SENT', attempt_count: 2 });
    const after = await fixture();
    await withTenantTransaction(owner, tenantId, (client) =>
      client.query(
        `update notifications.deliveries set state='SENDING',attempt_count=1,scenario_dispatch_started_at=clock_timestamp()-interval '2 minutes',lease_expires_at=clock_timestamp()-interval '1 minute' where tenant_id=$1 and id=$2`,
        [tenantId, after.delivery],
      ),
    );
    expect(await runApnsDeliveryBatch(options(otherWorker, send))).toBe(0);
    expect(await delivery(after.delivery)).toMatchObject({
      state: 'DEAD',
      last_error_code: 'APNS_OUTCOME_UNKNOWN',
    });
    expect(send).toHaveBeenCalledOnce();
  });

  it('does not invalidate a rotated token when the old provider response arrives', async () => {
    const item = await fixture();
    const send = vi.fn(async () => {
      const rotated = cipher.encrypt('cd'.repeat(32));
      await withTenantTransaction(owner, tenantId, (client) =>
        client.query(
          `update integration.notification_endpoints set address_ciphertext=$3 where tenant_id=$1 and id=$2`,
          [tenantId, item.endpoint, rotated.ciphertext],
        ),
      );
      return {
        outcome: 'terminal_failure' as const,
        errorCode: 'APNS_TOKEN_INVALID',
        invalidate: true,
      };
    });
    await runApnsDeliveryBatch(options(runtime, send));
    expect(await delivery(item.delivery)).toMatchObject({ state: 'DEAD' });
    expect(
      (
        await withTenantTransaction(owner, tenantId, (client) =>
          client.query<{ status: string }>(
            'select status from integration.notification_endpoints where tenant_id=$1 and id=$2',
            [tenantId, item.endpoint],
          ),
        )
      ).rows[0]?.status,
    ).toBe('ACTIVE');
  });

  it('leaves scenario-v2 deliveries for their separate owner', async () => {
    const item = await fixture();
    await withTenantTransaction(owner, tenantId, (client) =>
      client.query(
        // Migration 0101 parks scenario-v2 rows outside both legacy delivery queues.
        `update notifications.deliveries set scenario_v2_available_at=clock_timestamp(),
          scenario_available_at=null,next_attempt_at='infinity'::timestamptz where tenant_id=$1 and id=$2`,
        [tenantId, item.delivery],
      ),
    );
    const send = vi.fn();
    expect(await runApnsDeliveryBatch(options(runtime, send))).toBe(0);
    expect(send).not.toHaveBeenCalled();
    expect(await delivery(item.delivery)).toMatchObject({ state: 'PENDING', attempt_count: 0 });
  });
});
