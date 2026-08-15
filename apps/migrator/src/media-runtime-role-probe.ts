import { randomUUID } from 'node:crypto';

import { Client } from 'pg';

export type MediaRuntimeRoleProbeClient = {
  connect(): Promise<void>;
  query(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ readonly rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
};

export type MediaRuntimeRoleProbeClientFactory = (
  connectionString: string,
) => MediaRuntimeRoleProbeClient;

export class MediaRuntimeRoleProbeError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'MediaRuntimeRoleProbeError';
  }
}

function postgresErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('code' in error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}

export async function verifyMediaRuntimeRole(
  input: {
    readonly connectionString: string;
    readonly tenantKey: string;
  },
  createClient: MediaRuntimeRoleProbeClientFactory = (value) =>
    new Client({
      connectionString: value,
      application_name: 'phub-media-runtime-role-probe',
      connectionTimeoutMillis: 5_000,
      query_timeout: 5_000,
      statement_timeout: 5_000,
    }) as unknown as MediaRuntimeRoleProbeClient,
): Promise<void> {
  const client = createClient(input.connectionString);
  await client.connect();
  let transactionOpen = false;
  try {
    await client.query(`select pg_catalog.set_config('search_path', 'pg_catalog', false)`);
    await client.query('begin');
    transactionOpen = true;

    const tenantResult = (await client.query(
      `select id::text as tenant_id
         from identity.tenants
        where active
          and tenant_key = $1
        limit 1`,
      [input.tenantKey],
    )) as { readonly rows: { readonly tenant_id: string }[] };
    const tenantId = tenantResult.rows[0]?.tenant_id;
    if (!tenantId) throw new MediaRuntimeRoleProbeError('MEDIA_RUNTIME_TENANT_REQUIRED');
    await client.query(`select pg_catalog.set_config('app.tenant_id', $1, true)`, [tenantId]);
    const userResult = (await client.query(
      `select id::text as user_id
         from identity.users
        where tenant_id = $1::uuid
        order by id
        limit 1`,
      [tenantId],
    )) as { readonly rows: { readonly user_id: string }[] };
    const userId = userResult.rows[0]?.user_id;
    if (!userId) throw new MediaRuntimeRoleProbeError('MEDIA_RUNTIME_USER_REQUIRED');

    const communityId = randomUUID();
    const idempotencyKey = `media-role-probe-${randomUUID()}`;
    const grantId = randomUUID();
    const sha256 = '0'.repeat(64);
    const objectKey = `profile-photos/${tenantId}/${userId}/${sha256}.webp`;

    await client.query(
      `insert into integration.profile_photo_observation_watermarks (
         tenant_id, user_id, observed_at
       ) values ($1::uuid, $2::uuid, now())
       on conflict (tenant_id, user_id) do update
         set observed_at = excluded.observed_at,
             updated_at = now()`,
      [tenantId, userId],
    );
    await client.query(
      `insert into integration.profile_photo_client_commands (
         tenant_id, user_id, idempotency_key, grant_id,
         request_sha256, content_sha256, object_key,
         grant_issued_at, expires_at
       ) values (
         $1::uuid, $2::uuid, $3, $4::uuid,
         $5, $5, $6,
         now(), now() + interval '5 minutes'
       )`,
      [tenantId, userId, idempotencyKey, grantId, sha256, objectKey],
    );
    await client.query(
      `insert into integration.community_logo_observation_watermarks (
         tenant_id, community_id, observed_at
       ) values ($1::uuid, $2::uuid, now())`,
      [tenantId, communityId],
    );
    await client.query(
      `insert into integration.media_cutover_state (feature, active)
       values ('community_logo_stable_delivery', false)
       on conflict (feature) do update
         set active = excluded.active,
             updated_at = now()`,
    );

    const otherTenantId =
      tenantId === '00000000-0000-0000-0000-000000000001'
        ? '00000000-0000-0000-0000-000000000002'
        : '00000000-0000-0000-0000-000000000001';
    await client.query(`select pg_catalog.set_config('app.tenant_id', $1, true)`, [otherTenantId]);
    const hiddenResult = (await client.query(
      `select count(*)::text as row_count
         from integration.community_logo_observation_watermarks
        where tenant_id = $1::uuid
          and community_id = $2::uuid`,
      [tenantId, communityId],
    )) as { readonly rows: { readonly row_count: string }[] };
    if (hiddenResult.rows[0]?.row_count !== '0') {
      throw new MediaRuntimeRoleProbeError('MEDIA_RUNTIME_CROSS_TENANT_READ_VISIBLE');
    }

    await client.query('savepoint cross_tenant_write');
    let crossTenantWriteRejected = false;
    try {
      await client.query(
        `insert into integration.community_logo_observation_watermarks (
           tenant_id, community_id, observed_at
         ) values ($1::uuid, $2::uuid, now())`,
        [tenantId, randomUUID()],
      );
    } catch (error) {
      await client.query('rollback to savepoint cross_tenant_write');
      if (postgresErrorCode(error) !== '42501') throw error;
      crossTenantWriteRejected = true;
    }
    if (!crossTenantWriteRejected) {
      throw new MediaRuntimeRoleProbeError('MEDIA_RUNTIME_CROSS_TENANT_WRITE_ALLOWED');
    }
  } finally {
    if (transactionOpen) await client.query('rollback').catch(() => undefined);
    await client.end().catch(() => undefined);
  }
}
