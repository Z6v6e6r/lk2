import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import { withTenantTransaction } from '@phub/database';
import type { WorkerConfig } from '@phub/config';
import type { VivaOAuthProviderPort } from '@phub/auth';
import type { VivaNotificationSource } from '@phub/viva-adapter/notification-lifecycle';
import { type VivaNotificationFact } from '@phub/viva-adapter/notification-lifecycle';
import type Redis from 'ioredis';
import type { Pool } from 'pg';
import { refreshDelegation } from './viva-home-sync.js';
import type { VivaHomeDelegation } from './viva-home-repository.js';
import { persistNotificationLifecycleSnapshot } from './notification-lifecycle.js';
import { readNotificationCredentialFile } from './notification-provider-credentials.js';

export async function runNotificationLifecycleSync(input: {
  pool: Pool;
  redis: Redis;
  config: WorkerConfig;
  provider: VivaOAuthProviderPort;
  source: VivaNotificationSource;
  now?: Date;
}): Promise<{ synced: number; failed: number }> {
  const { config, pool } = input;
  const tenantId = config.NOTIFICATION_VIVA_TENANT_ID;
  if (
    !config.NOTIFICATION_SCENARIOS_ENABLED ||
    !config.NOTIFICATION_LIFECYCLE_VIVA_ENABLED ||
    !tenantId
  )
    return { synced: 0, failed: 0 };
  const now = input.now ?? new Date();
  let synced = 0,
    failed = 0;
  const due = await withTenantTransaction(pool, tenantId, async (client) => {
    const rows = await client.query<{
      id: string;
      user_id: string;
      provider_tenant_key: string;
      issuer: string;
      subject: string;
      refresh_token_ciphertext: string;
      encryption_key_version: string;
      refresh_expires_at: Date | null;
    }>(
      `select d.id,d.user_id,b.provider_tenant_key,d.issuer,d.subject,d.refresh_token_ciphertext,d.encryption_key_version,d.refresh_expires_at from integration.user_delegations d join integration.identity_provider_bindings b on b.tenant_id=d.tenant_id and b.provider='VIVA' join identity.users u on u.tenant_id=d.tenant_id and u.id=d.user_id and u.status='ACTIVE' left join notifications.scenario_source_sync s on s.tenant_id=d.tenant_id and s.user_id=d.user_id where d.tenant_id=$1 and b.provider_tenant_key='iSkq6G' and d.provider='VIVA' and d.revoked_at is null and (d.refresh_expires_at is null or d.refresh_expires_at>now()) and (s.attempted_at is null or s.attempted_at<$2::timestamptz-interval '60 seconds') order by s.attempted_at asc nulls first,d.id limit 10`,
      [tenantId, now],
    );
    return rows.rows;
  });
  for (const row of due) {
    const delegation: VivaHomeDelegation = {
      id: row.id,
      tenantId,
      userId: row.user_id,
      providerTenantKey: row.provider_tenant_key,
      issuer: row.issuer,
      subject: row.subject,
      refreshTokenCiphertext: row.refresh_token_ciphertext,
      encryptionKeyVersion: row.encryption_key_version,
      ...(row.refresh_expires_at ? { refreshExpiresAt: row.refresh_expires_at.toISOString() } : {}),
    };
    await withTenantTransaction(pool, tenantId, (client) =>
      client.query(
        `insert into notifications.scenario_source_sync(tenant_id,user_id,attempted_at) values($1,$2,$3) on conflict(tenant_id,user_id) do update set attempted_at=excluded.attempted_at`,
        [tenantId, row.user_id, now],
      ),
    );
    try {
      const refreshed = await refreshDelegation({
        pool,
        redis: input.redis,
        config,
        provider: input.provider,
        delegation,
        correlationId: randomUUID(),
        now,
      });
      if (refreshed.outcome !== 'ready') continue;
      const snapshot = await input.source.readOwned({
        accessToken: refreshed.accessToken,
        correlationId: randomUUID(),
        now,
      });
      const owned = await withTenantTransaction(
        pool,
        tenantId,
        async (client) =>
          (
            await client.query(
              `select 1 from integration.external_entity_map where tenant_id=$1 and internal_id=$2 and external_system='VIVA' and entity_type='viva_profile' and external_id=$3 and sync_status='synced' and sync_error_code is null and last_synced_at is not null`,
              [tenantId, row.user_id, snapshot.externalClientId],
            )
          ).rowCount === 1,
      );
      if (!owned) throw new Error('VIVA_NOTIFICATION_OWNER_MISMATCH');
      await persistNotificationLifecycleSnapshot({
        pool,
        tenantId,
        userId: row.user_id,
        facts: snapshot.facts,
        scopes: ['SUBSCRIPTIONS', 'BIRTHDAY'],
        now,
      });
      await withTenantTransaction(pool, tenantId, (client) =>
        client.query(
          `update notifications.scenario_source_sync set checked_at=$3,error_code=null where tenant_id=$1 and user_id=$2`,
          [tenantId, row.user_id, now],
        ),
      );
      synced++;
    } catch {
      await withTenantTransaction(pool, tenantId, (client) =>
        client.query(
          `update notifications.scenario_source_sync set error_code='VIVA_NOTIFICATION_READ_FAILED' where tenant_id=$1 and user_id=$2`,
          [tenantId, row.user_id],
        ),
      );
      failed++;
    }
  }
  return { synced, failed };
}

export async function runNotificationAttendanceSync(input: {
  pool: Pool;
  config: WorkerConfig;
  source: VivaNotificationSource;
  now?: Date;
}): Promise<number> {
  const { config, pool } = input,
    tenantId = config.NOTIFICATION_VIVA_TENANT_ID;
  if (
    !config.NOTIFICATION_LIFECYCLE_VIVA_ENABLED ||
    !config.NOTIFICATION_SCENARIOS_ENABLED ||
    !tenantId ||
    !config.NOTIFICATION_VIVA_ADMIN_CREDENTIAL_FILE
  )
    return 0;
  const now = input.now ?? new Date();
  const credential = z
    .object({
      accessToken: z.string().min(20).max(12000),
      expiresAt: z.iso.datetime({ offset: true }),
      providerTenantKey: z.literal('iSkq6G'),
    })
    .strict()
    .parse(await readNotificationCredentialFile(config.NOTIFICATION_VIVA_ADMIN_CREDENTIAL_FILE));
  if (Date.parse(credential.expiresAt) <= now.getTime() + 30_000)
    throw new Error('VIVA_NOTIFICATION_ADMIN_TOKEN_EXPIRED');
  const binding = await withTenantTransaction(
    pool,
    tenantId,
    async (client) =>
      (
        await client.query(
          `select 1 from integration.identity_provider_bindings where tenant_id=$1 and provider='VIVA' and provider_tenant_key=$2`,
          [tenantId, credential.providerTenantKey],
        )
      ).rowCount === 1,
  );
  if (!binding) throw new Error('VIVA_NOTIFICATION_ADMIN_TENANT_MISMATCH');
  let synced = 0;
  for (const offset of [1, 0]) {
    const date = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Moscow',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(now.getTime() - offset * 86_400_000));
    const snapshot = await input.source.readAttendance({
      accessToken: credential.accessToken,
      correlationId: randomUUID(),
      date,
      now,
      allowedTypeIds: config.NOTIFICATION_TRAINING_TYPE_IDS.split(',').filter(Boolean),
      allowedStudioIds: config.NOTIFICATION_TRAINING_STUDIO_IDS.split(',').filter(Boolean),
    });
    const groups = new Map<string, VivaNotificationFact[]>();
    for (const fact of snapshot.facts) {
      const users = await withTenantTransaction(
        pool,
        tenantId,
        async (client) =>
          (
            await client.query<{ internal_id: string }>(
              `select m.internal_id from integration.external_entity_map m join identity.users u on u.tenant_id=m.tenant_id and u.id=m.internal_id and u.status='ACTIVE' where m.tenant_id=$1 and m.external_system='VIVA' and m.entity_type='viva_profile' and m.external_id=$2 and m.sync_status='synced' and m.sync_error_code is null and m.last_synced_at is not null`,
              [tenantId, fact.clientId],
            )
          ).rows,
      );
      if (users.length !== 1) continue;
      const userId = users[0]!.internal_id;
      const facts = groups.get(userId) ?? [];
      facts.push(fact);
      groups.set(userId, facts);
    }
    const existing = await withTenantTransaction(
      pool,
      tenantId,
      async (client) =>
        (
          await client.query<{ user_id: string }>(
            `select distinct payload->>'recipientUserId' user_id from notifications.scenario_contexts where tenant_id=$1 and kind='LIFECYCLE' and payload->>'scope'=any($2::text[])`,
            [
              tenantId,
              snapshot.scopes.map((scope) => createHash('sha256').update(scope).digest('hex')),
            ],
          )
        ).rows,
    );
    for (const user of existing) if (!groups.has(user.user_id)) groups.set(user.user_id, []);
    for (const [userId, facts] of groups) {
      await persistNotificationLifecycleSnapshot({
        pool,
        tenantId,
        userId,
        facts,
        scopes: snapshot.scopes,
        now,
      });
      synced++;
    }
  }
  return synced;
}
