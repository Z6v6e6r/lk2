import { randomUUID } from 'node:crypto';

import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createAdminNotificationRepository } from './admin-notification-repository.js';
import { withTenantTransaction } from './connection.js';

const suppliedConnectionString = process.env.ADMIN_NOTIFICATION_RESOLVE_TEST_DATABASE_URL;
// The CI quality job applies every migration to a disposable database and exports APP_ENV=ci, which is
// the only place this resolution contract can be exercised without an operator-supplied database.
const ciConnectionString = process.env.APP_ENV === 'ci' ? process.env.DATABASE_URL : undefined;
const connectionString = suppliedConnectionString ?? ciConnectionString;
const describePostgres = connectionString ? describe : describe.skip;

/**
 * The CUP addresses recipients by phone. A phone reaches a PadlHub user either through the verified
 * phone-login column or through the provider viewer-phone mapping, and the client relays the provider
 * value without server attestation. This needs a real database to prove the login value wins, that the
 * provider mapping still makes an OAuth-only account reachable, that ambiguity stays fail-closed, and
 * that two phones of one person produce one recipient.
 */
describePostgres('CUP phone resolution against real PostgreSQL', () => {
  const pool = new Pool({ connectionString, max: 4 });
  const tenantId = randomUUID();
  const providerAccountId = randomUUID();
  const loginOwner = randomUUID();
  const providerClaimant = randomUUID();
  const providerOnly = randomUUID();
  const ambiguousUser = randomUUID();
  const ambiguousTwinUser = randomUUID();
  const disabledProviderOwner = randomUUID();
  const dualPhoneUser = randomUUID();
  const loginPhone = '+79995550001';
  const providerOnlyPhone = '+79995550002';
  const ambiguousPhone = '+79995550003';
  const disabledOwnerPhone = '+79995550004';
  const dualLoginPhone = '+79995550005';
  const dualProviderPhone = '+79995550006';

  async function insertUser(
    client: PoolClient,
    id: string,
    status: 'ACTIVE' | 'DISABLED',
    displayName: string,
    phone: string | null,
  ): Promise<void> {
    await client.query(`insert into identity.users (id, tenant_id, status) values ($1, $2, $3)`, [
      id,
      tenantId,
      status,
    ]);
    await client.query(
      `insert into profile.user_summaries (tenant_id, user_id, display_name, phone_e164)
       values ($1, $2, $3, $4)`,
      [tenantId, id, displayName, phone],
    );
  }

  async function insertEndpoint(client: PoolClient, userId: string, hashCharacter: string) {
    await client.query(
      `insert into integration.notification_endpoints (
         tenant_id, user_id, provider_account_id, channel, address_ciphertext, address_hash,
         encryption_key_id, status
       ) values ($1, $2, $3, 'PUSH', $4::bytea, $5, 'v1', 'ACTIVE')`,
      [
        tenantId,
        userId,
        providerAccountId,
        Buffer.from(`ciphertext-${hashCharacter}`),
        hashCharacter.repeat(64),
      ],
    );
  }

  async function insertProviderPhone(client: PoolClient, userId: string, phone: string) {
    await client.query(
      `insert into integration.external_entity_map (
         tenant_id, external_system, entity_type, internal_id, external_id, last_synced_at, sync_status
       ) values ($1, 'VIVA', 'legacy_viewer_phone', $2, $3, now(), 'synced')`,
      [tenantId, userId, phone],
    );
  }

  beforeAll(async () => {
    await pool.query(
      `insert into identity.tenants (id, tenant_key, display_name) values ($1, $2, $3)`,
      [tenantId, `cup-phone-${tenantId}`, 'CUP phone resolution'],
    );
    await withTenantTransaction(pool, tenantId, async (client) => {
      await insertUser(client, loginOwner, 'ACTIVE', 'Проверенный вход', loginPhone);
      await insertUser(client, providerClaimant, 'ACTIVE', 'Заявка провайдера', null);
      await insertUser(client, providerOnly, 'ACTIVE', 'Только провайдер', null);
      await insertUser(client, ambiguousUser, 'ACTIVE', 'Спорный первый', ambiguousPhone);
      await insertUser(client, ambiguousTwinUser, 'ACTIVE', 'Спорный второй', ambiguousPhone);
      await insertUser(client, disabledProviderOwner, 'DISABLED', 'Отключён', null);
      await insertUser(client, dualPhoneUser, 'ACTIVE', 'Два номера', dualLoginPhone);

      await client.query(
        `insert into integration.notification_provider_accounts (
           tenant_id, id, channel, platform, provider, app_id, environment, credential_ref, status
         ) values ($1, $2, 'PUSH', 'WEB', 'WEB_PUSH', 'padlhub-web', 'SANDBOX', 'env:TEST', 'ACTIVE')`,
        [tenantId, providerAccountId],
      );
      await client.query(
        `insert into notifications.tenant_runtime_settings (tenant_id, in_app_enabled, web_push_enabled)
         values ($1, true, true)`,
        [tenantId],
      );
      await insertEndpoint(client, loginOwner, 'a');
      await insertEndpoint(client, providerOnly, 'b');
      await insertEndpoint(client, dualPhoneUser, 'c');

      await insertProviderPhone(client, providerClaimant, loginPhone);
      await insertProviderPhone(client, providerOnly, providerOnlyPhone);
      await insertProviderPhone(client, disabledProviderOwner, disabledOwnerPhone);
      await insertProviderPhone(client, dualPhoneUser, dualProviderPhone);
    });
  });

  afterAll(async () => {
    await withTenantTransaction(pool, tenantId, async (client) => {
      await client.query(
        'delete from notifications.admin_campaign_recipients where tenant_id = $1',
        [tenantId],
      );
      await client.query('delete from notifications.admin_campaign_commands where tenant_id = $1', [
        tenantId,
      ]);
      await client.query('delete from notifications.admin_campaigns where tenant_id = $1', [
        tenantId,
      ]);
      await client.query('delete from notifications.inbox_items where tenant_id = $1', [tenantId]);
      await client.query('delete from notifications.deliveries where tenant_id = $1', [tenantId]);
      await client.query('delete from notifications.intents where tenant_id = $1', [tenantId]);
      await client.query('delete from notifications.templates where tenant_id = $1', [tenantId]);
      await client.query('delete from audit.outbox_events where tenant_id = $1', [tenantId]);
      await client.query('delete from audit.audit_log where tenant_id = $1', [tenantId]);
      await client.query('delete from integration.notification_endpoints where tenant_id = $1', [
        tenantId,
      ]);
      await client.query('delete from notifications.tenant_runtime_settings where tenant_id = $1', [
        tenantId,
      ]);
      await client.query(
        `delete from integration.external_entity_map
          where tenant_id = $1 and entity_type = 'legacy_viewer_phone'`,
        [tenantId],
      );
      await client.query(
        'delete from integration.notification_provider_accounts where tenant_id = $1',
        [tenantId],
      );
      await client.query('delete from profile.user_summaries where tenant_id = $1', [tenantId]);
      await client.query('delete from identity.users where tenant_id = $1', [tenantId]);
    });
    await pool.query('delete from identity.tenants where id = $1', [tenantId]);
    await pool.end();
  });

  function resolve(phones: readonly string[]) {
    return createAdminNotificationRepository(pool).resolveRecipients({
      tenantId,
      normalizedPhones: phones,
      webPushGloballyEnabled: true,
      webPushAppId: 'padlhub-web',
      webPushEnvironment: 'SANDBOX',
    });
  }

  it('never lets a client-relayed provider phone outrank the verified login phone', async () => {
    const resolution = await resolve([loginPhone]);

    expect(resolution.unresolvedPhones).toEqual([]);
    expect(resolution.matched.map((recipient) => recipient.userId)).toEqual([loginOwner]);
    expect(resolution.matched[0]?.availableChannels).toEqual(['IN_APP', 'WEB_PUSH']);
  });

  it('reaches an OAuth-only account through the provider phone mapping', async () => {
    const resolution = await resolve([providerOnlyPhone]);

    expect(resolution.unresolvedPhones).toEqual([]);
    expect(resolution.matched.map((recipient) => recipient.userId)).toEqual([providerOnly]);
    expect(resolution.matched[0]?.availableChannels).toEqual(['IN_APP', 'WEB_PUSH']);
  });

  it('never resolves a phone that two login rows claim', async () => {
    const resolution = await resolve([ambiguousPhone]);

    expect(resolution.matched).toEqual([]);
    expect(resolution.unresolvedPhones).toEqual(['•••• 0003']);
  });

  it('drops a provider phone whose owner is not active instead of guessing', async () => {
    const resolution = await resolve([disabledOwnerPhone]);

    expect(resolution.matched).toEqual([]);
    expect(resolution.unresolvedPhones).toEqual(['•••• 0004']);
  });

  it('collapses two phones of one person into a single recipient', async () => {
    const resolution = await resolve([dualProviderPhone, dualLoginPhone]);

    expect(resolution.unresolvedPhones).toEqual([]);
    expect(resolution.matched.map((recipient) => recipient.userId)).toEqual([dualPhoneUser]);
  });

  it('creates one campaign recipient when two phones belong to the same user', async () => {
    const repository = createAdminNotificationRepository(pool);
    const campaign = await repository.createCampaign({
      tenantId,
      actorUserId: loginOwner,
      normalizedPhones: [dualProviderPhone, dualLoginPhone],
      title: 'Проверка баннера',
      body: 'Один получатель на два номера',
      deepLink: '/notifications',
      requestedChannels: ['IN_APP'],
      requestHash: 'a'.repeat(64),
      idempotencyKey: `cup-phone-${randomUUID()}`,
      correlationId: randomUUID(),
      webPushGloballyEnabled: true,
      webPushAppId: 'padlhub-web',
      webPushEnvironment: 'SANDBOX',
    });

    if (campaign.outcome !== 'accepted') {
      throw new Error(`unexpected campaign outcome: ${campaign.outcome}`);
    }
    expect(campaign.matchedCount).toBe(1);

    const recipients = await withTenantTransaction(pool, tenantId, async (client) => {
      const result = await client.query<{ user_id: string }>(
        `select user_id from notifications.admin_campaign_recipients where tenant_id = $1 and campaign_id = $2`,
        [tenantId, campaign.campaignId],
      );
      return result.rows.map((row) => row.user_id);
    });
    expect(recipients).toEqual([dualPhoneUser]);
  });
});
