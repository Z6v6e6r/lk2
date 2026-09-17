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
 * The CUP addresses recipients by phone or by PadlHub user id. A phone reaches a PadlHub user either
 * through the verified phone-login column or through the provider viewer-phone mapping, and the client
 * relays the provider value without server attestation. This needs a real database to prove the login
 * value wins, that the provider mapping still makes an OAuth-only account reachable, that ambiguity
 * stays fail-closed, that two selectors of one person produce one recipient, and that the user-id
 * selector reaches an account no phone can address.
 */
describePostgres('CUP phone and user-id resolution against real PostgreSQL', () => {
  const pool = new Pool({ connectionString, max: 4 });
  const tenantId = randomUUID();
  const providerAccountId = randomUUID();
  const loginOwner = randomUUID();
  const providerClaimant = randomUUID();
  const providerOnly = randomUUID();
  const idOnlyUser = randomUUID();
  const twinProviderUser = randomUUID();
  const disabledProviderOwner = randomUUID();
  const dualPhoneUser = randomUUID();
  const foreignTenantId = randomUUID();
  const foreignUserId = randomUUID();
  const loginPhone = '+79995550001';
  const providerOnlyPhone = '+79995550002';
  const unclaimedPhone = '+79995550003';
  const disabledOwnerPhone = '+79995550004';
  const dualLoginPhone = '+79995550005';
  const dualProviderPhone = '+79995550006';
  const foreignPhone = '+79995550007';

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
      // Ambiguity is impossible by construction on both phone sources: `profile.user_summaries
      // (tenant_id, phone_e164)` is unique (migration 0091) and `integration.external_entity_map` is
      // unique per (tenant, system, entity type, external id). The fail-closed ambiguity contract
      // lives in the mocked resolver test; here the schema refusals are proven.
      await insertUser(client, idOnlyUser, 'ACTIVE', 'Только по id', null);
      await insertUser(client, twinProviderUser, 'ACTIVE', 'Второй с тем же провайдерским', null);
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
      await insertProviderPhone(client, idOnlyUser, '+79995550009');
    });
    // A neighbouring tenant proves the selector stays tenant-scoped even though the phone and the user
    // id are otherwise perfectly valid.
    await pool.query(
      `insert into identity.tenants (id, tenant_key, display_name) values ($1, $2, $3)`,
      [foreignTenantId, `cup-foreign-${foreignTenantId}`, 'CUP foreign tenant'],
    );
    await withTenantTransaction(pool, foreignTenantId, async (client) => {
      await client.query(`insert into identity.users (id, tenant_id, status) values ($1, $2, $3)`, [
        foreignUserId,
        foreignTenantId,
        'ACTIVE',
      ]);
      await client.query(
        `insert into profile.user_summaries (tenant_id, user_id, display_name, phone_e164)
         values ($1, $2, $3, $4)`,
        [foreignTenantId, foreignUserId, 'Чужой пользователь', foreignPhone],
      );
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
    await withTenantTransaction(pool, foreignTenantId, async (client) => {
      await client.query('delete from profile.user_summaries where tenant_id = $1', [
        foreignTenantId,
      ]);
      await client.query('delete from identity.users where tenant_id = $1', [foreignTenantId]);
    });
    await pool.query('delete from identity.tenants where id = any($1::uuid[])', [
      [tenantId, foreignTenantId],
    ]);
    await pool.end();
  });

  function resolve(phones: readonly string[], userIds: readonly string[] = []) {
    return createAdminNotificationRepository(pool).resolveRecipients({
      tenantId,
      normalizedPhones: phones,
      normalizedUserIds: userIds,
      webPushGloballyEnabled: true,
      webPushAppId: 'padlhub-web',
      webPushEnvironment: 'SANDBOX',
    });
  }

  function createCampaignFor(input: {
    readonly phones?: readonly string[];
    readonly userIds?: readonly string[];
    readonly channels?: readonly ('IN_APP' | 'WEB_PUSH')[];
  }) {
    return createAdminNotificationRepository(pool).createCampaign({
      tenantId,
      actorUserId: loginOwner,
      normalizedPhones: input.phones ?? [],
      normalizedUserIds: input.userIds ?? [],
      title: 'Проверка баннера',
      body: 'Один получатель на два селектора',
      deepLink: '/notifications',
      requestedChannels: input.channels ?? ['IN_APP'],
      requestHash: 'a'.repeat(64),
      idempotencyKey: `cup-selector-${randomUUID()}`,
      correlationId: randomUUID(),
      webPushGloballyEnabled: true,
      webPushAppId: 'padlhub-web',
      webPushEnvironment: 'SANDBOX',
    });
  }

  async function campaignRecipients(campaignId: string): Promise<readonly string[]> {
    const recipients = await withTenantTransaction(pool, tenantId, async (client) => {
      const result = await client.query<{ user_id: string }>(
        `select user_id from notifications.admin_campaign_recipients where tenant_id = $1 and campaign_id = $2`,
        [tenantId, campaignId],
      );
      return result.rows.map((row) => row.user_id);
    });
    return recipients;
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

  it('rejects a second account claiming the same provider phone', async () => {
    await expect(
      withTenantTransaction(pool, tenantId, async (client) => {
        await insertProviderPhone(client, twinProviderUser, '+79995550009');
      }),
    ).rejects.toMatchObject({ code: '23505' });

    const resolution = await resolve(['+79995550009']);
    expect(resolution.matched.map((recipient) => recipient.userId)).toEqual([idOnlyUser]);
  });

  it('never resolves a phone that no account claims', async () => {
    const resolution = await resolve([unclaimedPhone]);

    expect(resolution.matched).toEqual([]);
    expect(resolution.unresolvedPhones).toEqual(['•••• 0003']);
  });

  it('rejects a second account claiming a verified phone', async () => {
    // The runtime refusal above cannot be reached through the login-phone source any more: the schema
    // now guarantees one account per verified phone within a tenant. A real second account keeps the
    // assertion about the unique index rather than about foreign-key ordering.
    const duplicateUserId = randomUUID();
    await expect(
      withTenantTransaction(pool, tenantId, async (client) => {
        await client.query(
          `insert into identity.users (id, tenant_id, status) values ($1, $2, 'ACTIVE')`,
          [duplicateUserId, tenantId],
        );
        await client.query(
          `insert into profile.user_summaries (tenant_id, user_id, display_name, phone_e164)
           values ($1, $2, $3, $4)`,
          [tenantId, duplicateUserId, 'Дубликат телефона', loginPhone],
        );
      }),
    ).rejects.toMatchObject({ code: '23505', constraint: 'user_summaries_phone_lookup_idx' });
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
    const campaign = await createCampaignFor({
      phones: [dualProviderPhone, dualLoginPhone],
    });

    if (campaign.outcome !== 'accepted') {
      throw new Error(`unexpected campaign outcome: ${campaign.outcome}`);
    }
    expect(campaign.matchedCount).toBe(1);
    // inputCount - matchedCount for two phone values that name one person.
    expect(campaign.unresolvedCount).toBe(1);
    await expect(campaignRecipients(campaign.campaignId)).resolves.toEqual([dualPhoneUser]);
  });

  it('resolves a recipient by PadlHub user id without needing any phone', async () => {
    const resolution = await resolve([], [providerClaimant]);

    expect(resolution.matched.map((recipient) => recipient.userId)).toEqual([providerClaimant]);
    // The account has no verified login phone, so the preview must not invent a masked number.
    expect(resolution.matched[0]?.phoneMasked).toBeUndefined();
    expect(resolution.matched[0]?.displayName).toBe('Заявка провайдера');
    expect(resolution.unresolvedPhones).toEqual([]);
    expect(resolution.unresolvedUserIds).toEqual([]);
  });

  it('reaches by user id the account whose provider phone lost the phone claim', async () => {
    // providerClaimant's provider phone is also the verified login phone of loginOwner, so the phone
    // selector resolves loginOwner and never providerClaimant.
    const byPhone = await resolve([loginPhone]);
    expect(byPhone.matched.map((recipient) => recipient.userId)).toEqual([loginOwner]);

    const byId = await resolve([], [providerClaimant]);
    expect(byId.matched.map((recipient) => recipient.userId)).toEqual([providerClaimant]);
  });

  it('reports unknown and disabled user ids as unresolved', async () => {
    const unknownUserId = randomUUID();
    const resolution = await resolve([], [unknownUserId, disabledProviderOwner]);

    expect(resolution.matched).toEqual([]);
    expect(resolution.unresolvedUserIds).toEqual([unknownUserId, disabledProviderOwner]);
    expect(resolution.unresolvedPhones).toEqual([]);
  });

  it('collapses a phone and a user id that name the same person into one recipient', async () => {
    const resolution = await resolve([dualLoginPhone], [dualPhoneUser]);

    expect(resolution.matched.map((recipient) => recipient.userId)).toEqual([dualPhoneUser]);
    expect(resolution.unresolvedPhones).toEqual([]);
    expect(resolution.unresolvedUserIds).toEqual([]);
  });

  it('creates a campaign by user id for an account no phone can address', async () => {
    const campaign = await createCampaignFor({ userIds: [providerClaimant] });

    if (campaign.outcome !== 'accepted') {
      throw new Error(`unexpected campaign outcome: ${campaign.outcome}`);
    }
    expect(campaign.matchedCount).toBe(1);
    expect(campaign.unresolvedCount).toBe(0);
    expect(campaign.inAppCreatedCount).toBe(1);
    await expect(campaignRecipients(campaign.campaignId)).resolves.toEqual([providerClaimant]);
  });

  it('writes one recipient row when a campaign names the same person by phone and by id', async () => {
    const campaign = await createCampaignFor({
      phones: [dualLoginPhone],
      userIds: [dualPhoneUser],
    });

    if (campaign.outcome !== 'accepted') {
      throw new Error(`unexpected campaign outcome: ${campaign.outcome}`);
    }
    expect(campaign.matchedCount).toBe(1);
    // inputCount - matchedCount: the second selector value did not add another recipient.
    expect(campaign.unresolvedCount).toBe(1);
    await expect(campaignRecipients(campaign.campaignId)).resolves.toEqual([dualPhoneUser]);
  });

  it('never resolves a phone or a user id that belongs to another tenant', async () => {
    const byPhone = await resolve([foreignPhone]);
    expect(byPhone.matched).toEqual([]);
    expect(byPhone.unresolvedPhones).toEqual(['•••• 0007']);

    const byId = await resolve([], [foreignUserId]);
    expect(byId.matched).toEqual([]);
    expect(byId.unresolvedUserIds).toEqual([foreignUserId]);

    await expect(createCampaignFor({ userIds: [foreignUserId] })).resolves.toEqual({
      outcome: 'recipients_not_found',
    });
  });

  it('keeps the campaign counters consistent for a mixed selector campaign', async () => {
    const unknownUserId = randomUUID();
    const campaign = await createCampaignFor({
      phones: [unclaimedPhone],
      userIds: [idOnlyUser, unknownUserId],
    });

    if (campaign.outcome !== 'accepted') {
      throw new Error(`unexpected campaign outcome: ${campaign.outcome}`);
    }
    // unclaimedPhone reaches nobody, unknownUserId does not exist; idOnlyUser resolves by id.
    expect(campaign.matchedCount).toBe(1);
    expect(campaign.unresolvedCount).toBe(2);
    await expect(campaignRecipients(campaign.campaignId)).resolves.toEqual([idOnlyUser]);
  });
});
