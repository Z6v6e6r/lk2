import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenantTransaction } from './connection.js';
import { createProfileProviderObservationRepository } from './profile-provider-observation-repository.js';

function ciDatabase() {
  if (
    process.env.GITHUB_ACTIONS !== 'true' ||
    process.env.APP_ENV !== 'ci' ||
    !process.env.DATABASE_URL
  )
    return undefined;
  const url = new URL(process.env.DATABASE_URL);
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !['localhost', '127.0.0.1'].includes(url.hostname) ||
    url.username !== 'phub' ||
    url.port !== '5432' ||
    url.pathname !== '/phub' ||
    url.search ||
    url.hash
  )
    throw new Error('PROFILE_OBSERVATION_DISPOSABLE_CI_DATABASE_REQUIRED');
  return url.toString();
}

const adminUrl = ciDatabase();
const suite = adminUrl ? describe : describe.skip;

suite('profile provider observation physical PostgreSQL (existing CI database only)', () => {
  const admin = new Pool({ connectionString: adminUrl, max: 4 });
  const tenantId = randomUUID();
  const otherTenant = randomUUID();
  const userId = randomUUID();
  const role = 'profile_observation_' + randomUUID().replaceAll('-', '');
  const password = randomUUID();
  let runtime: Pool;
  let repository: ReturnType<typeof createProfileProviderObservationRepository>;

  beforeAll(async () => {
    await admin.query(
      'create role ' +
        role +
        " login password '" +
        password +
        "' nosuperuser nobypassrls noinherit nocreatedb nocreaterole",
    );
    await admin.query('grant usage on schema profile to "' + role + '"');
    await admin.query(
      'grant select,insert,update on profile.provider_observations to "' + role + '"',
    );
    const url = new URL(adminUrl!);
    url.username = role;
    url.password = password;
    runtime = new Pool({ connectionString: url.toString(), max: 4 });
    repository = createProfileProviderObservationRepository(runtime);
    await admin.query(
      'insert into identity.tenants(id,tenant_key,display_name) values($1,$2,$3),($4,$5,$6)',
      [
        tenantId,
        'provider-observation-' + tenantId,
        'Provider observation fixture',
        otherTenant,
        'provider-observation-' + otherTenant,
        'Other tenant fixture',
      ],
    );
    await withTenantTransaction(admin, tenantId, async (client) => {
      await client.query('insert into identity.users(tenant_id,id,status) values($1,$2,$3)', [
        tenantId,
        userId,
        'ACTIVE',
      ]);
    });
  });

  afterAll(async () => {
    await runtime.end();
    await admin.query('drop owned by "' + role + '"');
    await admin.query('drop role if exists "' + role + '"');
    await admin.end();
  });

  it('keeps the newest observation and never publishes a fabricated zero', async () => {
    expect(
      await repository.put({
        tenantId,
        userId,
        observation: {
          level: { label: 'C', value: 3 },
          balanceMinor: 21_000,
          currency: 'RUB',
          observedAt: '2026-11-09T04:00:00.000Z',
        },
      }),
    ).toBe('accepted');
    expect(
      await repository.put({
        tenantId,
        userId,
        observation: {
          level: { label: 'D', value: 0 },
          balanceMinor: 1,
          currency: 'RUB',
          observedAt: '2026-11-09T03:00:00.000Z',
        },
      }),
    ).toBe('ignored');
    expect(await repository.get(tenantId, userId)).toEqual({
      level: { label: 'C', value: 3 },
      balanceMinor: 21_000,
      currency: 'RUB',
      observedAt: '2026-11-09T04:00:00.000Z',
    });
    expect(
      await repository.put({
        tenantId,
        userId,
        observation: {
          level: { label: 'B', value: 4.5 },
          balanceMinor: -500,
          currency: 'RUB',
          observedAt: '2026-11-09T05:00:00.000Z',
        },
      }),
    ).toBe('accepted');
    expect(await repository.get(tenantId, userId)).toMatchObject({
      level: { label: 'B', value: 4.5 },
      balanceMinor: -500,
      observedAt: '2026-11-09T05:00:00.000Z',
    });
  });

  it('publishes only the provider-owned presentation fields that were read', async () => {
    const secondUser = randomUUID();
    await withTenantTransaction(admin, tenantId, async (client) => {
      await client.query('insert into identity.users(tenant_id,id,status) values($1,$2,$3)', [
        tenantId,
        secondUser,
        'ACTIVE',
      ]);
    });
    await repository.put({
      tenantId,
      userId: secondUser,
      observation: { currency: 'RUB', observedAt: '2026-11-09T06:00:00.000Z' },
    });
    expect(await repository.get(tenantId, secondUser)).toEqual({
      currency: 'RUB',
      observedAt: '2026-11-09T06:00:00.000Z',
    });
  });

  it('FORCE RLS conceals a foreign tenant and rejects cross-tenant writes', async () => {
    const hidden = await withTenantTransaction(runtime, otherTenant, (client) =>
      client.query('select * from profile.provider_observations where tenant_id = $1', [tenantId]),
    );
    expect(hidden.rows).toHaveLength(0);
    await expect(
      withTenantTransaction(runtime, otherTenant, (client) =>
        client.query(
          'insert into profile.provider_observations (tenant_id,user_id,level_label,level_value,balance_minor,currency,observed_at) values($1,$2,$3,$4,$5,$6,now())',
          [tenantId, userId, 'C', 3, 1000, 'RUB'],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    const forced = await admin.query(
      'select relrowsecurity,relforcerowsecurity from pg_class where oid = ' +
        "'profile.provider_observations'::regclass",
    );
    expect(forced.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
  });

  it('denies the runtime role without a tenant scope', async () => {
    await expect(
      runtime.query(
        'insert into profile.provider_observations (tenant_id,user_id,level_label,level_value,balance_minor,currency,observed_at) values($1,$2,$3,$4,$5,$6,now())',
        [tenantId, userId, 'C', 3, 1000, 'RUB'],
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('ships the tenant isolation policy in the packaged migration', async () => {
    const sql = await readFile(
      'packages/database/migrations/0116_profile_provider_observations.sql',
      'utf8',
    );
    expect(sql).toContain('force row level security');
    expect(sql).toContain('provider_observation_tenant_isolation');
    expect(sql).not.toMatch(/provider_id|access_token|phone|avatar|photo/i);
  });
});
