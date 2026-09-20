import { randomUUID } from 'node:crypto';

import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createAdminNotificationRepository } from './admin-notification-repository.js';
import { withTenantTransaction } from './connection.js';

const suppliedConnectionString = process.env.ADMIN_NOTIFICATION_STATS_TEST_DATABASE_URL;
// The CI quality job applies every migration to a disposable database and exports APP_ENV=ci, which is
// the only place this reporting contract can be exercised without an operator-supplied database.
const ciConnectionString = process.env.APP_ENV === 'ci' ? process.env.DATABASE_URL : undefined;
const connectionString = suppliedConnectionString ?? ciConnectionString;
const describePostgres = connectionString ? describe : describe.skip;

/**
 * The CUP delivery report is the only place an operator can see what happened to a campaign, because Web
 * Push has no provider dashboard and no receipt beyond the push service's acceptance. That makes the
 * aggregation itself the contract: the window must exclude older work, the campaign counters must line up
 * with the deliveries its intents produced, failures must be grouped by the stable error code, and the
 * endpoint sample must stay bounded, active-only and tenant-scoped.
 */
describePostgres('admin notification delivery stats against real PostgreSQL', () => {
  const pool = new Pool({ connectionString, max: 4 });
  const tenantId = randomUUID();
  const foreignTenantId = randomUUID();
  const providerAccountId = randomUUID();
  const foreignProviderAccountId = randomUUID();
  const recipient = randomUUID();
  const foreignRecipient = randomUUID();

  async function insertUser(client: PoolClient, id: string, tenant: string): Promise<void> {
    await client.query(
      `insert into identity.users (id, tenant_id, status) values ($1, $2, 'ACTIVE')`,
      [id, tenant],
    );
    await client.query(
      `insert into profile.user_summaries (tenant_id, user_id, display_name, phone_e164)
       values ($1, $2, $3, null)`,
      [tenant, id, `Игрок ${id.slice(0, 4)}`],
    );
  }

  async function insertProviderAccount(
    client: PoolClient,
    tenant: string,
    id: string,
  ): Promise<void> {
    await client.query(
      `insert into integration.notification_provider_accounts (
         tenant_id, id, channel, platform, provider, app_id, environment, credential_ref, status
       ) values ($1, $2, 'PUSH', 'WEB', 'WEB_PUSH', 'padlhub-web', 'SANDBOX', 'env:TEST', 'ACTIVE')`,
      [tenant, id],
    );
    await client.query(
      `insert into notifications.tenant_runtime_settings (tenant_id, in_app_enabled, web_push_enabled)
       values ($1, true, true)`,
      [tenant],
    );
  }

  async function insertEndpoint(
    client: PoolClient,
    tenant: string,
    userId: string,
    accountId: string,
    label: string,
    status: 'ACTIVE' | 'INVALID' | 'REVOKED' = 'ACTIVE',
  ): Promise<string> {
    const row = await client.query<{ id: string }>(
      `insert into integration.notification_endpoints (
         tenant_id, user_id, provider_account_id, channel, address_ciphertext, address_hash,
         encryption_key_id, status
       ) values ($1, $2, $3, 'PUSH', $4::bytea, $5, 'v1', $6)
       returning id`,
      [
        tenant,
        userId,
        accountId,
        Buffer.from(`ciphertext-${label}`),
        Buffer.from(`hash-${label}`, 'utf8').toString('hex').padEnd(64, 'a').slice(0, 64),
        status,
      ],
    );
    const id = row.rows[0]?.id;
    if (!id) throw new Error('endpoint fixture failed');
    return id;
  }

  /** The union narrows to `accepted` here once, so every caller can use the campaign id directly. */
  async function createAcceptedCampaign(
    title: string,
    userIds: readonly string[],
  ): Promise<string> {
    const result = await createAdminNotificationRepository(pool).createCampaign({
      tenantId,
      actorUserId: recipient,
      normalizedPhones: [],
      normalizedUserIds: [...userIds],
      title,
      body: 'Текст кампании',
      deepLink: '/notifications',
      requestedChannels: ['IN_APP', 'WEB_PUSH'],
      requestHash: randomUUID().replaceAll('-', '').padEnd(64, 'a').slice(0, 64),
      idempotencyKey: `delivery-stats-${randomUUID()}`,
      correlationId: randomUUID(),
      webPushGloballyEnabled: true,
      webPushAppId: 'padlhub-web',
      webPushEnvironment: 'SANDBOX',
    });
    if (result.outcome !== 'accepted')
      throw new Error(`campaign was not accepted: ${result.outcome}`);
    return result.campaignId;
  }

  async function deliveriesOf(
    campaignId: string,
  ): Promise<readonly { id: string; channel: string }[]> {
    return withTenantTransaction(pool, tenantId, async (client) => {
      const result = await client.query<{ id: string; channel: string }>(
        `select d.id, d.channel
           from notifications.deliveries d
           join notifications.intents i on i.tenant_id = d.tenant_id and i.id = d.intent_id
          where d.tenant_id = $1 and i.source_event_id = $2`,
        [tenantId, campaignId],
      );
      return result.rows;
    });
  }

  async function setDeliveryState(
    deliveryId: string,
    state: 'SENT' | 'DEAD' | 'FAILED',
    errorCode?: string,
  ): Promise<void> {
    await withTenantTransaction(pool, tenantId, async (client) => {
      await client.query(
        `update notifications.deliveries
            set state = $2,
                completed_at = now(),
                attempt_count = 1,
                last_error_code = $3,
                updated_at = now()
          where tenant_id = $1 and id = $4`,
        [tenantId, state, errorCode ?? null, deliveryId],
      );
    });
  }

  beforeAll(async () => {
    await pool.query(
      `insert into identity.tenants (id, tenant_key, display_name) values ($1, $2, $3), ($4, $5, $6)`,
      [
        tenantId,
        `delivery-stats-${tenantId}`,
        'Delivery stats',
        foreignTenantId,
        `delivery-stats-foreign-${foreignTenantId}`,
        'Delivery stats foreign tenant',
      ],
    );
    await withTenantTransaction(pool, tenantId, async (client) => {
      await insertUser(client, recipient, tenantId);
      await insertProviderAccount(client, tenantId, providerAccountId);
      await insertEndpoint(client, tenantId, recipient, providerAccountId, 'active-chrome');
      await insertEndpoint(client, tenantId, recipient, providerAccountId, 'active-safari');
      await insertEndpoint(
        client,
        tenantId,
        recipient,
        providerAccountId,
        'invalid-one',
        'INVALID',
      );
      await insertEndpoint(
        client,
        tenantId,
        recipient,
        providerAccountId,
        'revoked-one',
        'REVOKED',
      );
    });
    await withTenantTransaction(pool, foreignTenantId, async (client) => {
      await insertUser(client, foreignRecipient, foreignTenantId);
      await insertProviderAccount(client, foreignTenantId, foreignProviderAccountId);
      await insertEndpoint(
        client,
        foreignTenantId,
        foreignRecipient,
        foreignProviderAccountId,
        'foreign-active',
      );
    });
  });

  afterAll(async () => {
    for (const tenant of [tenantId, foreignTenantId]) {
      await withTenantTransaction(pool, tenant, async (client) => {
        // Receipts reference deliveries, so they go first.
        await client.query('delete from notifications.delivery_receipts where tenant_id = $1', [
          tenant,
        ]);
        await client.query('delete from notifications.deliveries where tenant_id = $1', [tenant]);
        await client.query('delete from notifications.inbox_items where tenant_id = $1', [tenant]);
        // Children first: recipients reference intents, and the campaign templates reference the actor.
        await client.query(
          'delete from notifications.admin_campaign_recipients where tenant_id = $1',
          [tenant],
        );
        await client.query(
          'delete from notifications.admin_campaign_commands where tenant_id = $1',
          [tenant],
        );
        await client.query('delete from notifications.admin_campaigns where tenant_id = $1', [
          tenant,
        ]);
        await client.query('delete from notifications.intents where tenant_id = $1', [tenant]);
        await client.query('delete from notifications.templates where tenant_id = $1', [tenant]);
        await client.query('delete from audit.outbox_events where tenant_id = $1', [tenant]);
        await client.query('delete from audit.audit_log where tenant_id = $1', [tenant]);
        await client.query('delete from integration.notification_endpoints where tenant_id = $1', [
          tenant,
        ]);
        await client.query(
          'delete from notifications.tenant_runtime_settings where tenant_id = $1',
          [tenant],
        );
        await client.query(
          'delete from integration.notification_provider_accounts where tenant_id = $1',
          [tenant],
        );
        await client.query('delete from profile.user_summaries where tenant_id = $1', [tenant]);
        await client.query('delete from identity.users where tenant_id = $1', [tenant]);
      });
    }
    await pool.query('delete from identity.tenants where id = any($1::uuid[])', [
      [tenantId, foreignTenantId],
    ]);
    await pool.end();
  });

  function stats(since: Date, options: { readonly campaignLimit?: number } = {}) {
    return createAdminNotificationRepository(pool).getDeliveryStats({
      tenantId,
      since,
      campaignLimit: options.campaignLimit ?? 10,
      endpointSampleLimit: 10,
    });
  }

  it('summarises an accepted campaign, its counters and the endpoint health', async () => {
    const acceptedCampaignId = await createAcceptedCampaign('Принятая кампания', [recipient]);
    const deliveries = await deliveriesOf(acceptedCampaignId);
    for (const delivery of deliveries) {
      if (delivery.channel === 'PUSH') await setDeliveryState(delivery.id, 'SENT');
    }

    const result = await stats(new Date(Date.now() - 24 * 60 * 60 * 1000));
    // One delivery per channel and per live endpoint: the account has two active endpoints, so the
    // campaign queued two pushes for one person, and the in-app copy counts as accepted once delivered.
    expect(result.channels).toEqual([
      expect.objectContaining({ channel: 'IN_APP', queued: 1, accepted: 1 }),
      expect.objectContaining({ channel: 'PUSH', queued: 2, accepted: 2, dead: 0, failed: 0 }),
    ]);
    const pushChannel = result.channels.find((row) => row.channel === 'PUSH');
    expect(pushChannel?.medianAcceptSeconds).toBeGreaterThanOrEqual(0);
    expect(result.campaigns[0]).toMatchObject({
      campaignId: acceptedCampaignId,
      requestedChannels: ['IN_APP', 'WEB_PUSH'],
      matchedCount: 1,
      pushQueuedCount: 2,
      inAppCreatedCount: 1,
      pushAccepted: 2,
      pushFailed: 0,
      pushDead: 0,
    });
    expect(result.endpoints).toMatchObject({
      active: 2,
      invalid: 1,
      revoked: 1,
      suspendedPolicy: 0,
    });
    // Only live endpoints are sampled, and the sample stays bounded even though the account has more rows.
    expect(result.endpoints.activeEndpointSample).toHaveLength(2);
    expect(result.endpoints.activeEndpointSample[0]?.encryptionKeyId).toBe('v1');
  });

  it('groups failures by their stable error code and excludes work outside the window', async () => {
    const failingCampaignId = await createAcceptedCampaign('Кампания с ошибкой', [recipient]);
    const deliveries = await deliveriesOf(failingCampaignId);
    const pushDelivery = deliveries.find((delivery) => delivery.channel === 'PUSH');
    expect(pushDelivery).toBeDefined();
    await setDeliveryState(pushDelivery!.id, 'DEAD', 'WEB_PUSH_SUBSCRIPTION_GONE');

    const result = await stats(new Date(Date.now() - 24 * 60 * 60 * 1000));
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatchObject({
      channel: 'PUSH',
      errorCode: 'WEB_PUSH_SUBSCRIPTION_GONE',
      count: 1,
    });
    expect(Number.isFinite(Date.parse(result.failures[0]?.lastOccurredAt ?? ''))).toBe(true);
    expect(result.campaigns.find((row) => row.campaignId === failingCampaignId)).toMatchObject({
      pushDead: 1,
    });

    // A window that starts after the work was created reports nothing instead of all history.
    const empty = await stats(new Date(Date.now() + 60 * 60 * 1000));
    expect(empty.channels).toEqual([]);
    // Campaigns are windowed too, but endpoint health is a current-state view and stays reported.
    expect(empty.campaigns).toEqual([]);
    expect(empty.endpoints.active).toBe(2);
  });

  it('reports the display and open funnel the client sends back', async () => {
    const campaignId = await createAcceptedCampaign('Воронка', [recipient]);
    const deliveries = await deliveriesOf(campaignId);
    const pushDelivery = deliveries.find((delivery) => delivery.channel === 'PUSH');
    expect(pushDelivery).toBeDefined();
    await setDeliveryState(pushDelivery!.id, 'SENT');
    // Both receipts are written the way the API writes them, and a repeat of one must not double count.
    await withTenantTransaction(pool, tenantId, async (client) => {
      for (const type of ['DISPLAYED', 'DISPLAYED', 'OPENED']) {
        await client.query(
          `insert into notifications.delivery_receipts (
             tenant_id, delivery_id, receipt_key, receipt_type, source, platform, occurred_at
           ) values ($1, $2, $3, $4, 'CLIENT', 'WEB', now())
           on conflict (tenant_id, receipt_key) do nothing`,
          [tenantId, pushDelivery!.id, `funnel:${type}:${randomUUID()}`, type],
        );
      }
    });

    const result = await stats(new Date(Date.now() - 24 * 60 * 60 * 1000));
    const pushChannel = result.channels.find((row) => row.channel === 'PUSH');
    // Two display rows exist, but the report counts deliveries, not receipts.
    expect(pushChannel).toMatchObject({ displayed: 1, opened: 1 });
    expect(result.campaigns.find((row) => row.campaignId === campaignId)).toMatchObject({
      pushDisplayed: 1,
      pushOpened: 1,
    });
  });

  it('keeps the report inside the tenant that asked for it', async () => {
    const foreignCampaign = await createAdminNotificationRepository(pool).createCampaign({
      tenantId: foreignTenantId,
      actorUserId: foreignRecipient,
      normalizedPhones: [],
      normalizedUserIds: [foreignRecipient],
      title: 'Чужая кампания',
      body: 'Текст',
      deepLink: '/notifications',
      requestedChannels: ['IN_APP', 'WEB_PUSH'],
      requestHash: randomUUID().replaceAll('-', '').padEnd(64, 'b').slice(0, 64),
      idempotencyKey: `delivery-stats-foreign-${randomUUID()}`,
      correlationId: randomUUID(),
      webPushGloballyEnabled: true,
      webPushAppId: 'padlhub-web',
      webPushEnvironment: 'SANDBOX',
    });
    expect(foreignCampaign.outcome).toBe('accepted');
    const foreignCampaignId =
      foreignCampaign.outcome === 'accepted' ? foreignCampaign.campaignId : '';

    const result = await stats(new Date(Date.now() - 24 * 60 * 60 * 1000));
    expect(result.campaigns.map((row) => row.campaignId)).not.toContain(foreignCampaignId);
    // The neighbouring tenant's endpoint is not part of this tenant's health numbers either.
    expect(result.endpoints.active).toBe(2);
  });
});
