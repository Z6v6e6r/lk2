import { randomUUID } from 'node:crypto';

import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createIdentityAuthRepository } from './auth-repository.js';
import { withTenantTransaction } from './connection.js';

const suppliedConnectionString = process.env.PROFILE_PHONE_CONFIRMATION_TEST_DATABASE_URL;
// The CI quality job applies every migration to a disposable database and exports APP_ENV=ci, which is
// the only place this write path can be exercised without an operator-supplied database.
const ciConnectionString = process.env.APP_ENV === 'ci' ? process.env.DATABASE_URL : undefined;
const connectionString = suppliedConnectionString ?? ciConnectionString;
const describePostgres = connectionString ? describe : describe.skip;

/**
 * Confirming a phone for the authenticated account writes `profile.user_summaries.phone_e164`, the phone
 * the CUP resolver trusts first. This needs a real database because the whole guarantee is a partial
 * unique index inside one transaction: a phone must not move to a second account, a number another
 * account already holds as its provider viewer phone is unavailable too, a released number is reported
 * once, and two concurrent confirmations of one free number produce exactly one owner. The audit row is
 * the operator's only record that a number moved, so it is asserted together with the write.
 */
describePostgres('profile phone confirmation against real PostgreSQL', () => {
  const pool = new Pool({ connectionString, max: 4 });
  const tenantId = randomUUID();
  const foreignTenantId = randomUUID();
  const issuer = 'https://auth.viva.example/realms/beta';
  const mover = randomUUID();
  const moverPhoneBefore = '+79996660010';
  const moverPhoneAfter = '+79996660011';
  const holder = randomUUID();
  const holderPhone = '+79996660012';
  const providerPhoneOwner = randomUUID();
  const providerPhone = '+79996660013';
  const firstTime = randomUUID();
  const firstTimePhone = '+79996660014';
  const foreignUser = randomUUID();
  const foreignPhone = '+79996660015';
  const tenantScoped = randomUUID();
  const concurrentFirst = randomUUID();
  const concurrentSecond = randomUUID();
  const concurrentPhone = '+79996660016';
  const withoutSummary = randomUUID();
  const disabledUser = randomUUID();
  const disabledPhone = '+79996660018';
  const replayedUser = randomUUID();
  const replayedPhone = '+79996660019';

  async function insertUser(
    client: PoolClient,
    id: string,
    displayName: string,
    phone: string | null,
    options: { readonly tenant?: string; readonly status?: 'ACTIVE' | 'DISABLED' } = {},
  ): Promise<void> {
    const tenant = options.tenant ?? tenantId;
    await client.query(`insert into identity.users (id, tenant_id, status) values ($1, $2, $3)`, [
      id,
      tenant,
      options.status ?? 'ACTIVE',
    ]);
    await client.query(
      `insert into profile.user_summaries (tenant_id, user_id, display_name, phone_e164)
       values ($1, $2, $3, $4)`,
      [tenant, id, displayName, phone],
    );
  }

  async function insertProviderPhone(
    client: PoolClient,
    userId: string,
    phone: string,
  ): Promise<void> {
    await client.query(
      `insert into integration.external_entity_map (
         tenant_id, external_system, entity_type, internal_id, external_id, last_synced_at, sync_status
       ) values ($1, 'VIVA', 'legacy_viewer_phone', $2, $3, now(), 'synced')`,
      [tenantId, userId, phone],
    );
  }

  async function insertExternalIdentity(
    client: PoolClient,
    userId: string,
    subject: string,
    options: { readonly tenant?: string } = {},
  ): Promise<void> {
    await client.query(
      `insert into integration.external_identity_map (tenant_id, user_id, provider, issuer, subject)
       values ($1, $2, 'VIVA', $3, $4)`,
      [options.tenant ?? tenantId, userId, issuer, subject],
    );
  }

  function confirm(
    userId: string,
    phoneE164: string,
    options: { readonly tenant?: string; readonly correlationId?: string } = {},
  ) {
    return createIdentityAuthRepository(pool).confirmProfilePhone({
      tenantId: options.tenant ?? tenantId,
      userId,
      phoneE164,
      challengeId: `challenge-${userId}`,
      correlationId: options.correlationId ?? randomUUID(),
    });
  }

  async function phoneOf(userId: string, tenant = tenantId): Promise<string | null> {
    return withTenantTransaction(pool, tenant, async (client) => {
      const result = await client.query<{ readonly phone_e164: string | null }>(
        `select phone_e164 from profile.user_summaries where tenant_id = $1 and user_id = $2`,
        [tenant, userId],
      );
      return result.rows[0]?.phone_e164 ?? null;
    });
  }

  async function confirmationAudits(
    userId: string,
  ): Promise<
    readonly { readonly correlation_id: string; readonly new_value: Record<string, unknown> }[]
  > {
    return withTenantTransaction(pool, tenantId, async (client) => {
      const result = await client.query<{
        readonly correlation_id: string;
        readonly new_value: Record<string, unknown>;
      }>(
        `select correlation_id, new_value from audit.audit_log
          where tenant_id = $1 and actor_id = $2 and action = 'PROFILE_PHONE_CONFIRMED'
          order by occurred_at`,
        [tenantId, userId],
      );
      return result.rows;
    });
  }

  beforeAll(async () => {
    await pool.query(
      `insert into identity.tenants (id, tenant_key, display_name) values ($1, $2, $3), ($4, $5, $6)`,
      [
        tenantId,
        `phone-confirm-${tenantId}`,
        'Profile phone confirmation',
        foreignTenantId,
        `phone-confirm-foreign-${foreignTenantId}`,
        'Profile phone confirmation foreign tenant',
      ],
    );
    await withTenantTransaction(pool, tenantId, async (client) => {
      await insertUser(client, mover, 'Перенос телефона', moverPhoneBefore);
      await insertUser(client, holder, 'Держит номер', holderPhone);
      await insertUser(client, providerPhoneOwner, 'Телефон провайдера', null);
      await insertUser(client, firstTime, 'Первый телефон', null);
      await insertUser(client, tenantScoped, 'Соседний номер в своём тенанте', null);
      await insertUser(client, concurrentFirst, 'Параллельно первый', null);
      await insertUser(client, disabledUser, 'Отключённый аккаунт', null, { status: 'DISABLED' });
      await insertUser(client, replayedUser, 'Повторная команда', null);
      await insertUser(client, concurrentSecond, 'Параллельно второй', null);
      await client.query(
        `insert into identity.users (id, tenant_id, status) values ($1, $2, 'ACTIVE')`,
        [withoutSummary, tenantId],
      );
      await insertProviderPhone(client, providerPhoneOwner, providerPhone);
      await insertExternalIdentity(client, holder, 'subject-holder');
    });
    await withTenantTransaction(pool, foreignTenantId, async (client) => {
      await insertUser(client, foreignUser, 'Соседний тенант', foreignPhone, {
        tenant: foreignTenantId,
      });
      // The same provider subject exists in two tenants; the read must stay inside the caller's tenant.
      await insertExternalIdentity(client, foreignUser, 'subject-holder', {
        tenant: foreignTenantId,
      });
    });
  });

  afterAll(async () => {
    for (const tenant of [tenantId, foreignTenantId]) {
      await withTenantTransaction(pool, tenant, async (client) => {
        await client.query(`delete from audit.audit_log where tenant_id = $1`, [tenant]);
        await client.query(`delete from integration.external_entity_map where tenant_id = $1`, [
          tenant,
        ]);
        await client.query(`delete from integration.external_identity_map where tenant_id = $1`, [
          tenant,
        ]);
        await client.query(`delete from profile.user_summaries where tenant_id = $1`, [tenant]);
        await client.query(`delete from identity.users where tenant_id = $1`, [tenant]);
      });
    }
    await pool.query(`delete from identity.tenants where id = any($1::uuid[])`, [
      [tenantId, foreignTenantId],
    ]);
    await pool.end();
  });

  it('moves the phone, releases the previous number and records one audit row', async () => {
    const correlationId = randomUUID();
    await expect(confirm(mover, moverPhoneAfter, { correlationId })).resolves.toEqual({
      outcome: 'confirmed',
      releasedPhoneLast4: moverPhoneBefore.slice(-4),
    });
    await expect(phoneOf(mover)).resolves.toBe(moverPhoneAfter);

    const audits = await confirmationAudits(mover);
    expect(audits).toHaveLength(1);
    expect(audits[0]?.correlation_id).toBe(correlationId);
    expect(audits[0]?.new_value).toMatchObject({
      source: 'PROFILE_PHONE_CONFIRMATION',
      challengeId: `challenge-${mover}`,
      phoneLast4: moverPhoneAfter.slice(-4),
      releasedPhoneLast4: moverPhoneBefore.slice(-4),
    });
    // The whole previous phone never enters the audit trail.
    expect(JSON.stringify(audits[0]?.new_value)).not.toContain(moverPhoneBefore);
  });

  it('reports a repeat confirmation instead of writing a second audit row', async () => {
    await expect(confirm(mover, moverPhoneAfter)).resolves.toEqual({
      outcome: 'already_confirmed',
    });
    await expect(phoneOf(mover)).resolves.toBe(moverPhoneAfter);
    await expect(confirmationAudits(mover)).resolves.toHaveLength(1);
  });

  it('refuses a phone another account verified and leaves it untouched', async () => {
    await expect(confirm(firstTime, holderPhone)).resolves.toEqual({ outcome: 'phone_taken' });
    await expect(phoneOf(holder)).resolves.toBe(holderPhone);
    await expect(phoneOf(firstTime)).resolves.toBeNull();
    await expect(confirmationAudits(firstTime)).resolves.toHaveLength(0);
  });

  it('refuses a phone another account holds as its provider viewer phone', async () => {
    await expect(confirm(firstTime, providerPhone)).resolves.toEqual({ outcome: 'phone_taken' });
    await expect(phoneOf(firstTime)).resolves.toBeNull();
    await expect(phoneOf(providerPhoneOwner)).resolves.toBeNull();
    await expect(confirmationAudits(firstTime)).resolves.toHaveLength(0);
  });

  it('confirms a first phone without claiming a released number', async () => {
    const result = await confirm(firstTime, firstTimePhone);
    expect(result).toEqual({ outcome: 'confirmed' });
    expect(result).not.toHaveProperty('releasedPhoneLast4');
    await expect(phoneOf(firstTime)).resolves.toBe(firstTimePhone);
    expect((await confirmationAudits(firstTime))[0]?.new_value).toMatchObject({
      phoneLast4: firstTimePhone.slice(-4),
      releasedPhoneLast4: null,
    });
  });

  it('keeps the phone unique per tenant instead of globally', async () => {
    // The foreign tenant already holds this number as a verified phone; that must not block this one.
    await expect(confirm(tenantScoped, foreignPhone)).resolves.toEqual({ outcome: 'confirmed' });
    await expect(phoneOf(tenantScoped)).resolves.toBe(foreignPhone);
    await expect(phoneOf(foreignUser, foreignTenantId)).resolves.toBe(foreignPhone);
  });

  it('lets exactly one of two concurrent confirmations own a free phone', async () => {
    const outcomes = await Promise.all([
      confirm(concurrentSecond, concurrentPhone),
      confirm(concurrentFirst, concurrentPhone),
    ]);
    const confirmed = outcomes.filter((outcome) => outcome.outcome === 'confirmed');
    const taken = outcomes.filter((outcome) => outcome.outcome === 'phone_taken');
    expect(confirmed).toHaveLength(1);
    expect(taken).toHaveLength(1);
    expect(outcomes.every((outcome) => outcome.outcome !== 'already_confirmed')).toBe(true);

    const owners = await withTenantTransaction(pool, tenantId, async (client) => {
      const result = await client.query<{ readonly user_id: string }>(
        `select user_id from profile.user_summaries where tenant_id = $1 and phone_e164 = $2`,
        [tenantId, concurrentPhone],
      );
      return result.rows.map((row) => row.user_id);
    });
    expect(owners).toHaveLength(1);
    // Only the owner wrote the audit row; the loser must not leave a phantom confirmation behind.
    const audits = [
      ...(await confirmationAudits(concurrentFirst)),
      ...(await confirmationAudits(concurrentSecond)),
    ];
    expect(audits).toHaveLength(1);
    expect(audits[0]?.new_value).toMatchObject({ challengeId: `challenge-${owners[0]}` });
  });

  it('refuses an account that has no profile summary to write to', async () => {
    await expect(confirm(withoutSummary, '+79996660017')).rejects.toThrow('AUTH_USER_NOT_ACTIVE');
  });

  it('refuses to write a phone for a disabled account', async () => {
    await expect(confirm(disabledUser, disabledPhone)).rejects.toThrow('AUTH_USER_NOT_ACTIVE');
    await expect(phoneOf(disabledUser)).resolves.toBeNull();
    await expect(confirmationAudits(disabledUser)).resolves.toHaveLength(0);
  });

  it('reads back the recorded confirmation so a retried command is not a false expiry', async () => {
    await expect(confirm(replayedUser, replayedPhone)).resolves.toMatchObject({
      outcome: 'confirmed',
    });
    const repository = createIdentityAuthRepository(pool);
    const recorded = await repository.findProfilePhoneConfirmation({
      tenantId,
      userId: replayedUser,
      challengeId: `challenge-${replayedUser}`,
    });
    expect(recorded).toMatchObject({ phoneLast4: replayedPhone.slice(-4) });
    expect(Number.isFinite(Date.parse(recorded?.confirmedAt ?? ''))).toBe(true);
    // The replay record is addressed by the caller's own account, the tenant and that exact challenge.
    await expect(
      repository.findProfilePhoneConfirmation({
        tenantId,
        userId: replayedUser,
        challengeId: 'challenge-unknown',
      }),
    ).resolves.toBeUndefined();
    await expect(
      repository.findProfilePhoneConfirmation({
        tenantId,
        userId: firstTime,
        challengeId: `challenge-${replayedUser}`,
      }),
    ).resolves.toBeUndefined();
    await expect(
      repository.findProfilePhoneConfirmation({
        tenantId: foreignTenantId,
        userId: replayedUser,
        challengeId: `challenge-${replayedUser}`,
      }),
    ).resolves.toBeUndefined();
  });

  it('resolves the account behind a provider subject inside the caller tenant only', async () => {
    const repository = createIdentityAuthRepository(pool);
    await expect(
      repository.findExternalSubjectUser({
        tenantId,
        provider: 'VIVA',
        issuer,
        subject: 'subject-holder',
      }),
    ).resolves.toMatchObject({
      id: holder,
      tenantId,
      displayName: 'Держит номер',
      phoneLast4: holderPhone.slice(-4),
    });
    // The same subject in the neighbouring tenant must not leak into this tenant's answer.
    await expect(
      repository.findExternalSubjectUser({
        tenantId: foreignTenantId,
        provider: 'VIVA',
        issuer,
        subject: 'subject-holder',
      }),
    ).resolves.toMatchObject({ id: foreignUser, tenantId: foreignTenantId });
    await expect(
      repository.findExternalSubjectUser({
        tenantId,
        provider: 'VIVA',
        issuer,
        subject: 'unknown',
      }),
    ).resolves.toBeUndefined();
    await expect(
      repository.findExternalSubjectUser({
        tenantId,
        provider: 'LOCAL',
        issuer,
        subject: 'subject-holder',
      }),
    ).resolves.toBeUndefined();
  });
});
