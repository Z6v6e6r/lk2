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
 * The CUP addresses recipients by phone. A phone reaches a PadlHub user either through the provider
 * custody mapping or through the login-verified profile column, and a legacy import can leave the same
 * phone on a different account. This needs a real database to prove which source wins, that an inactive
 * provider owner never falls back to a stale row, and that ambiguity stays fail-closed.
 */
describePostgres('CUP phone resolution against real PostgreSQL', () => {
  const pool = new Pool({ connectionString, max: 4 });
  const tenantId = randomUUID();
  const providerAccountId = randomUUID();
  const providerUser = randomUUID();
  const staleSummaryUser = randomUUID();
  const loginOnlyUser = randomUUID();
  const ambiguousUser = randomUUID();
  const ambiguousTwinUser = randomUUID();
  const disabledProviderUser = randomUUID();
  const providerPhone = '+79995550001';
  const loginOnlyPhone = '+79995550002';
  const ambiguousPhone = '+79995550003';
  const disabledOwnerPhone = '+79995550004';

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

  beforeAll(async () => {
    await pool.query(
      `insert into identity.tenants (id, tenant_key, display_name) values ($1, $2, $3)`,
      [tenantId, `cup-phone-${tenantId}`, 'CUP phone resolution'],
    );
    await withTenantTransaction(pool, tenantId, async (client) => {
      await insertUser(client, providerUser, 'ACTIVE', 'Провайдер', null);
      await insertUser(client, staleSummaryUser, 'ACTIVE', 'Старая проекция', providerPhone);
      await insertUser(client, loginOnlyUser, 'ACTIVE', 'Только вход', loginOnlyPhone);
      await insertUser(client, ambiguousUser, 'ACTIVE', 'Спорный первый', ambiguousPhone);
      await insertUser(client, ambiguousTwinUser, 'ACTIVE', 'Спорный второй', ambiguousPhone);
      await insertUser(client, disabledProviderUser, 'DISABLED', 'Отключён', null);

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
      await insertEndpoint(client, providerUser, 'a');
      await insertEndpoint(client, loginOnlyUser, 'b');

      for (const [userId, phone] of [
        [providerUser, providerPhone],
        [disabledProviderUser, disabledOwnerPhone],
      ] as const) {
        await client.query(
          `insert into integration.external_entity_map (
             tenant_id, external_system, entity_type, internal_id, external_id, last_synced_at, sync_status
           ) values ($1, 'VIVA', 'legacy_viewer_phone', $2, $3, now(), 'synced')`,
          [tenantId, userId, phone],
        );
      }
    });
  });

  afterAll(async () => {
    await withTenantTransaction(pool, tenantId, async (client) => {
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

  it('resolves a phone to the provider-linked user, not to the stale login column', async () => {
    const resolution = await resolve([providerPhone]);

    expect(resolution.unresolvedPhones).toEqual([]);
    expect(resolution.matched).toHaveLength(1);
    expect(resolution.matched[0]?.userId).toBe(providerUser);
    expect(resolution.matched[0]?.availableChannels).toEqual(['IN_APP', 'WEB_PUSH']);
  });

  it('keeps the login-verified column as a fallback for users the provider never reported', async () => {
    const resolution = await resolve([loginOnlyPhone]);

    expect(resolution.unresolvedPhones).toEqual([]);
    expect(resolution.matched.map((recipient) => recipient.userId)).toEqual([loginOnlyUser]);
  });

  it('never resolves a phone that two login rows claim', async () => {
    const resolution = await resolve([ambiguousPhone]);

    expect(resolution.matched).toEqual([]);
    expect(resolution.unresolvedPhones).toEqual(['•••• 0003']);
  });

  it('does not fall back to a stale row when the provider-linked user is inactive', async () => {
    const resolution = await resolve([disabledOwnerPhone]);

    expect(resolution.matched).toEqual([]);
    expect(resolution.unresolvedPhones).toEqual(['•••• 0004']);
  });

  it('resolves several phones in one request without crossing their owners', async () => {
    const resolution = await resolve([providerPhone, loginOnlyPhone]);

    expect(resolution.matched.map((recipient) => recipient.userId)).toEqual([
      providerUser,
      loginOnlyUser,
    ]);
    expect(resolution.unresolvedPhones).toEqual([]);
  });
});
