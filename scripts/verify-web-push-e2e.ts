import { createHash } from 'node:crypto';

import {
  createDatabasePool,
  createNotificationEndpointRepository,
  withTenantTransaction,
} from '@phub/database';
import {
  canonicalWebPushSubscription,
  createNotificationEndpointCipher,
  type NotificationPushDeliveryPort,
  type PushDeliveryResult,
  type WebPushSubscription,
} from '@phub/notifications';
import type { Logger } from 'pino';

import { applyNotificationSourceEvent } from '../apps/worker/src/notification-projector.js';
import { runWebPushDeliveryBatch } from '../apps/worker/src/web-push-delivery.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required');
const databaseName = new URL(connectionString).pathname.slice(1);
if (!databaseName.startsWith('phub_web_push_e2e_')) {
  throw new Error('Refusing to run outside an isolated phub_web_push_e2e_* database');
}

const tenantId = '10000000-0000-4000-8000-000000000001';
const userId = '10000000-0000-4000-8000-000000000002';
const providerId = '10000000-0000-4000-8000-000000000003';
const templateId = '10000000-0000-4000-8000-000000000004';
const ruleId = '10000000-0000-4000-8000-000000000005';
const installationId = '10000000-0000-4000-8000-000000000006';
const aggregateId = '10000000-0000-4000-8000-000000000007';
const subscription: WebPushSubscription = {
  endpoint: 'https://push.example.test/subscriptions/web-push-e2e',
  expirationTime: null,
  keys: {
    p256dh: 'B'.repeat(65),
    auth: 'a'.repeat(22),
  },
};
const endpointKeyring = JSON.stringify({
  v1: Buffer.alloc(32, 7).toString('base64'),
});
const cipher = createNotificationEndpointCipher({
  serializedKeys: endpointKeyring,
  activeKeyId: 'v1',
});
const pool = createDatabasePool(connectionString);
const repository = createNotificationEndpointRepository(pool);
const logger = {
  info() {},
} as unknown as Logger;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

class ResultAdapter implements NotificationPushDeliveryPort {
  public readonly platform = 'WEB' as const;

  public constructor(private readonly result: PushDeliveryResult) {}

  public send(): Promise<PushDeliveryResult> {
    return Promise.resolve(this.result);
  }
}

async function project(eventId: string, correlationId: string) {
  return applyNotificationSourceEvent({
    pool,
    webPush: { appId: 'padlhub-web', environment: 'SANDBOX' },
    event: {
      id: eventId,
      type: 'booking.reminder.v1',
      aggregateId,
      tenantId,
      occurredAt: new Date().toISOString(),
      correlationId,
      payload: {
        recipientUserId: userId,
        bookingTitle: 'Американо',
      },
    },
  });
}

try {
  await pool.query(
    `insert into identity.tenants (id, tenant_key, display_name)
     values ($1, 'web-push-e2e', 'Web Push E2E')`,
    [tenantId],
  );
  await withTenantTransaction(pool, tenantId, async (client) => {
    await client.query(`insert into identity.users (id, tenant_id) values ($1, $2)`, [
      userId,
      tenantId,
    ]);
    await client.query(
      `insert into integration.notification_provider_accounts (
         tenant_id, id, channel, platform, provider, app_id, environment, credential_ref, status
       ) values ($1, $2, 'PUSH', 'WEB', 'WEB_PUSH', 'padlhub-web', 'SANDBOX',
                 'env:WEB_PUSH_VAPID_PRIVATE_KEY', 'ACTIVE')`,
      [tenantId, providerId],
    );
    await client.query(
      `insert into notifications.tenant_runtime_settings (
         tenant_id, in_app_enabled, web_push_enabled, updated_by
       ) values ($1, true, true, $2)`,
      [tenantId, userId],
    );
    await client.query(
      `insert into notifications.templates (
         tenant_id, id, template_key, version, locale, category, channels,
         title_template, body_template, deep_link_template, active, created_by_user_id
       ) values (
         $1, $2, 'booking.reminder', 1, 'ru-RU', 'BOOKING_REMINDER',
         array['IN_APP', 'PUSH'], 'Игра уже скоро',
         '{{bookingTitle}} начнётся сегодня', '/bookings', true, $3
       )`,
      [tenantId, templateId, userId],
    );
    await client.query(
      `insert into notifications.trigger_rules (
         tenant_id, id, rule_key, source_event_type, template_id,
         audience_selector, active, created_by_user_id
       ) values (
         $1, $2, 'booking.reminder.user', 'booking.reminder.v1', $3,
         '{"type":"EVENT_USER","field":"recipientUserId"}'::jsonb, true, $4
       )`,
      [tenantId, ruleId, templateId, userId],
    );
  });

  const canonical = canonicalWebPushSubscription(subscription);
  const encrypted = cipher.encrypt(canonical);
  const registrationInput = {
    tenantId,
    userId,
    selector: { appId: 'padlhub-web', environment: 'SANDBOX' as const },
    installationId,
    ciphertext: encrypted.ciphertext,
    addressHash: createHash('sha256').update(subscription.endpoint).digest('hex'),
    encryptionKeyId: encrypted.keyId,
    requestHash: createHash('sha256').update(canonical).digest('hex'),
    idempotencyKey: 'web-push-e2e-register-0001',
    correlationId: 'web-push-e2e-register',
  };
  const registration = await repository.registerWebPush(registrationInput);
  const replay = await repository.registerWebPush(registrationInput);
  assert(registration.outcome === 'updated' && !registration.replayed, 'registration failed');
  assert(replay.outcome === 'updated' && replay.replayed, 'registration replay failed');

  const firstProjection = await project(
    '20000000-0000-4000-8000-000000000001',
    'web-push-e2e-accepted',
  );
  assert(
    firstProjection.outcome === 'processed' &&
      firstProjection.created === 1 &&
      firstProjection.pushQueued === 1,
    'accepted projection did not create both channels',
  );
  const acceptedBatch = await runWebPushDeliveryBatch({
    pool,
    logger,
    tenantId,
    appId: 'padlhub-web',
    environment: 'SANDBOX',
    cipher,
    adapter: new ResultAdapter({ outcome: 'accepted' }),
    maxAttempts: 3,
    retryBaseMs: 1_000,
  });
  assert(acceptedBatch.sent === 1, 'accepted delivery was not marked sent');

  const secondProjection = await project(
    '20000000-0000-4000-8000-000000000002',
    'web-push-e2e-gone',
  );
  assert(
    secondProjection.outcome === 'processed' && secondProjection.pushQueued === 1,
    'gone projection did not create a push delivery',
  );
  const goneBatch = await runWebPushDeliveryBatch({
    pool,
    logger,
    tenantId,
    appId: 'padlhub-web',
    environment: 'SANDBOX',
    cipher,
    adapter: new ResultAdapter({
      outcome: 'terminal_failure',
      errorCode: 'WEB_PUSH_SUBSCRIPTION_GONE',
      invalidate: true,
    }),
    maxAttempts: 3,
    retryBaseMs: 1_000,
  });
  assert(goneBatch.dead === 1, 'gone delivery was not moved to dead');

  const verification = await withTenantTransaction(pool, tenantId, async (client) => {
    const endpoints = await client.query<{
      address_ciphertext: Buffer;
      status: string;
    }>(
      `select address_ciphertext, status
         from integration.notification_endpoints
        where tenant_id = $1 and installation_id = $2`,
      [tenantId, installationId],
    );
    const deliveries = await client.query<{ channel: string; state: string }>(
      `select channel, state
         from notifications.deliveries
        where tenant_id = $1
        order by created_at, channel`,
      [tenantId],
    );
    const receipts = await client.query<{ receipt_type: string }>(
      `select receipt_type
         from notifications.delivery_receipts
        where tenant_id = $1`,
      [tenantId],
    );
    const intents = await client.query<{ state: string }>(
      `select state
         from notifications.intents
        where tenant_id = $1
        order by source_event_id`,
      [tenantId],
    );
    const forcedRls = await client.query<{ relname: string; relforcerowsecurity: boolean }>(
      `select relname, relforcerowsecurity
         from pg_class
        where oid in (
          'integration.notification_endpoints'::regclass,
          'integration.notification_endpoint_commands'::regclass,
          'notifications.deliveries'::regclass
        )`,
    );
    return {
      endpoint: endpoints.rows[0],
      deliveries: deliveries.rows,
      receipts: receipts.rows,
      intents: intents.rows,
      forcedRls: forcedRls.rows,
    };
  });

  assert(verification.endpoint?.status === 'INVALID', 'gone endpoint was not invalidated');
  assert(
    !verification.endpoint.address_ciphertext.includes(Buffer.from(subscription.endpoint)),
    'plaintext endpoint leaked into ciphertext',
  );
  assert(
    verification.deliveries.filter((delivery) => delivery.channel === 'IN_APP').length === 2 &&
      verification.deliveries.some(
        (delivery) => delivery.channel === 'PUSH' && delivery.state === 'SENT',
      ) &&
      verification.deliveries.some(
        (delivery) => delivery.channel === 'PUSH' && delivery.state === 'DEAD',
      ),
    'delivery terminal states are incorrect',
  );
  assert(
    verification.receipts.length === 1 &&
      verification.receipts[0]?.receipt_type === 'PROVIDER_ACCEPTED',
    'provider acceptance receipt is incorrect',
  );
  assert(
    verification.intents.map((intent) => intent.state).join(',') === 'DELIVERED,PARTIAL',
    'intent states are incorrect',
  );
  assert(
    verification.forcedRls.length === 3 &&
      verification.forcedRls.every((relation) => relation.relforcerowsecurity),
    'required notification tables do not force RLS',
  );

  process.stdout.write(
    `${JSON.stringify(
      {
        databaseName,
        registrationReplayed: true,
        acceptedBatch,
        goneBatch,
        endpointStatus: verification.endpoint.status,
        deliveryStates: verification.deliveries,
        intentStates: verification.intents.map((intent) => intent.state),
        receipts: verification.receipts.map((receipt) => receipt.receipt_type),
        forcedRls: verification.forcedRls.map((relation) => relation.relname),
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await pool.end();
}
