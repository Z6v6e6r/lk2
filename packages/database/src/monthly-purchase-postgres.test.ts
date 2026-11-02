import { randomUUID, createHash } from 'node:crypto';
import { Pool } from 'pg';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import {
  createMonthlyPurchaseRepository,
  type MonthlyActor,
  type MonthlyScope,
} from './monthly-purchase-repository.js';
import { withTenantTransaction } from './connection.js';
import { mpHash, mpOfferId } from '@phub/domain/subscription-purchase';
import {
  monthlyQuote,
  monthlyReceipt,
} from '../../domain/src/subscription-purchase.test-fixture.js';
function ci() {
  if (process.env.GITHUB_ACTIONS !== 'true' || process.env.APP_ENV !== 'ci') return undefined;
  if (!process.env.DATABASE_URL) throw Error('MONTHLY_CI_DATABASE_REQUIRED');
  const u = new URL(process.env.DATABASE_URL);
  if (
    process.env.VIVA_MODE !== 'mock' ||
    !['postgres:', 'postgresql:'].includes(u.protocol) ||
    !['localhost', '127.0.0.1'].includes(u.hostname) ||
    u.username !== 'phub' ||
    u.password !== 'ci-password' ||
    u.pathname !== '/phub' ||
    u.port !== '5432' ||
    u.search ||
    u.hash
  )
    throw Error('MONTHLY_CI_DATABASE_REQUIRED');
  return u.href;
}
const url = ci();
(url ? describe : describe.skip)('monthly purchase existing disposable CI PostgreSQL', () => {
  const admin = new Pool({ connectionString: url, max: 2 }),
    tenantId = randomUUID(),
    foreign = randomUUID(),
    role = 'monthly_' + randomUUID().replaceAll('-', ''),
    password = randomUUID();
  let one: Pool,
    two: Pool,
    a: ReturnType<typeof createMonthlyPurchaseRepository>,
    b: ReturnType<typeof createMonthlyPurchaseRepository>;
  beforeAll(async () => {
    await admin.query(
      `create role ${role} login password '${password}' nosuperuser nobypassrls noinherit nocreatedb nocreaterole`,
    );
    await admin.query(`grant usage on schema commerce,identity,integration,audit to ${role}`);
    await admin.query(
      `grant select,insert,update,delete on all tables in schema commerce,audit to ${role}`,
    );
    await admin.query(
      `grant select on identity.users,identity.tenants,identity.refresh_sessions,integration.identity_provider_bindings,integration.external_entity_map to ${role}`,
    );
    const u = new URL(url!);
    u.username = role;
    u.password = password;
    one = new Pool({ connectionString: u.href, max: 2 });
    two = new Pool({ connectionString: u.href, max: 2 });
    a = createMonthlyPurchaseRepository(one);
    b = createMonthlyPurchaseRepository(two);
    await admin.query(
      "insert into identity.tenants(id,tenant_key,display_name) values($1,$2,'Synthetic monthly'),($3,$4,'Other monthly')",
      [tenantId, 'monthly-' + tenantId, foreign, 'monthly-' + foreign],
    );
    for (const t of [tenantId, foreign])
      await withTenantTransaction(admin, t, (c) =>
        c.query(
          "insert into integration.identity_provider_bindings(tenant_id,provider,provider_tenant_key) values($1,'VIVA','iSkq6G')",
          [t],
        ),
      );
    expect(await a.ready()).toBe(true);
    expect((await one.query<{ pid: number }>('select pg_backend_pid() pid')).rows[0]!.pid).not.toBe(
      (await two.query<{ pid: number }>('select pg_backend_pid() pid')).rows[0]!.pid,
    );
  });
  afterAll(async () => {
    try {
      await one?.end();
      await two?.end();
      for (const t of [tenantId, foreign])
        await withTenantTransaction(admin, t, async (c) => {
          for (const table of [
            'commerce.monthly_purchase_launches',
            'commerce.monthly_purchase_attempts',
            'audit.outbox_events',
            'audit.audit_log',
            'integration.external_entity_map',
            'identity.refresh_sessions',
            'integration.identity_provider_bindings',
            'identity.users',
          ])
            await c.query(`delete from ${table} where tenant_id=$1`, [t]);
        });
      await admin.query('delete from identity.tenants where id=any($1::uuid[])', [
        [tenantId, foreign],
      ]);
      await admin.query(`drop owned by ${role}`);
      await admin.query(`drop role ${role}`);
    } finally {
      await admin.end();
    }
  });
  async function fixture(t = tenantId) {
    const userId = randomUUID(),
      sessionId = randomUUID(),
      mappingId = randomUUID(),
      clientId = 'fixture-client-' + userId,
      key = 'monthly-' + randomUUID();
    await withTenantTransaction(admin, t, async (c) => {
      await c.query("insert into identity.users(tenant_id,id,status) values($1,$2,'ACTIVE')", [
        t,
        userId,
      ]);
      await c.query(
        "insert into identity.refresh_sessions(tenant_id,id,user_id,family_id,token_hash,expires_at) values($1,$2,$3,$4,$5,now()+interval '1 hour')",
        [
          t,
          sessionId,
          userId,
          randomUUID(),
          createHash('sha256').update(randomUUID()).digest('hex'),
        ],
      );
      await c.query(
        "insert into integration.external_entity_map(id,tenant_id,external_system,entity_type,internal_id,external_id,sync_status,last_synced_at) values($1,$2,'VIVA','viva_profile',$3,$4,'synced',now())",
        [mappingId, t, userId, clientId],
      );
    });
    const actor: MonthlyActor = {
        tenantId: t,
        tenantKey: 'iSkq6G',
        userId,
        sessionId,
        correlationId: 'synthetic-monthly',
      },
      scope: MonthlyScope = { tenantId: t, userId, keySha256: mpHash(key) };
    const initial = await a.begin(actor, scope),
      quote = { ...monthlyQuote(), operationId: initial.id },
      consent = {
        offerId: mpOfferId,
        expectedRevision: quote.revision,
        amountMinor: quote.amountMinor,
        currency: 'RUB' as const,
      };
    await a.saveQuote(actor, scope, quote);
    const receipt = {
      ...monthlyReceipt(),
      operationId: initial.id,
      providerTransactionId: 'fixture-tx-' + initial.id,
    };
    return { actor, scope, initial, quote, consent, receipt, mappingId, clientId };
  }
  it('concurrent original dispatch claims have exactly one winner; restart never acquires another POST', async () => {
    const f = await fixture(),
      r = await Promise.all([
        a.claimDispatch(f.actor, f.scope, f.consent),
        b.claimDispatch(f.actor, f.scope, f.consent),
      ]);
    expect(r.filter((x) => x.claimed)).toHaveLength(1);
    await a.markUnknown(f.actor, f.scope);
    expect((await b.claimDispatch(f.actor, f.scope, f.consent)).claimed).toBe(false);
    expect((await a.read(f.actor, f.scope))?.state).toBe('UNKNOWN');
  });
  it('different original keys for one actor serialize to one active purchase', async () => {
    const f = await fixture(),
      other = { ...f.scope, keySha256: mpHash('other-' + randomUUID()) },
      initial = await a.begin(f.actor, other);
    await a.saveQuote(f.actor, other, { ...f.quote, operationId: initial.id });
    const r = await Promise.allSettled([
      a.claimDispatch(f.actor, f.scope, f.consent),
      b.claimDispatch(f.actor, other, f.consent),
    ]);
    expect(r.filter((x) => x.status === 'fulfilled' && x.value.claimed)).toHaveLength(1);
    expect(r.filter((x) => x.status === 'rejected')).toHaveLength(1);
  });
  it('changed consent and expired quote reject before dispatch and leave no payment receipt', async () => {
    const f = await fixture();
    await expect(
      a.claimDispatch(f.actor, f.scope, { ...f.consent, amountMinor: 1 }),
    ).rejects.toMatchObject({ code: 'SUBSCRIPTION_PURCHASE_PRICE_CHANGED' });
    await withTenantTransaction(admin, tenantId, (c) =>
      c.query(
        "update commerce.monthly_purchase_attempts set quote_expires_at=now()-interval '1 second' where tenant_id=$1 and id=$2",
        [tenantId, f.initial.id],
      ),
    );
    await expect(a.claimDispatch(f.actor, f.scope, f.consent)).rejects.toMatchObject({
      code: 'SUBSCRIPTION_PURCHASE_QUOTE_EXPIRED',
    });
    expect((await a.read(f.actor, f.scope))?.state).toBe('QUOTED');
  });
  it('receipt after logout persists but cannot be exposed or launched through the revoked session', async () => {
    const f = await fixture();
    await a.claimDispatch(f.actor, f.scope, f.consent);
    await withTenantTransaction(admin, tenantId, (c) =>
      c.query(
        'update identity.refresh_sessions set revoked_at=now() where tenant_id=$1 and id=$2',
        [tenantId, f.actor.sessionId],
      ),
    );
    expect((await a.saveReceipt(f.actor, f.scope, f.receipt)).state).toBe('PAYMENT_PENDING');
    await expect(a.read(f.actor, f.scope)).rejects.toMatchObject({
      code: 'SUBSCRIPTION_PURCHASE_IDENTITY_CHANGED',
    });
    await expect(a.createLaunch(f.actor, f.scope)).rejects.toThrow();
    const stored = await withTenantTransaction(admin, tenantId, (c) =>
      c.query<{ receipt: { providerTransactionId: string } }>(
        'select receipt from commerce.monthly_purchase_attempts where tenant_id=$1 and id=$2',
        [tenantId, f.initial.id],
      ),
    );
    expect(stored.rows[0]!.receipt.providerTransactionId).toBe(f.receipt.providerTransactionId);
  });
  it('concurrent one-use launch consumers have exactly one success and no raw code stored', async () => {
    const f = await fixture();
    await a.claimDispatch(f.actor, f.scope, f.consent);
    await a.saveReceipt(f.actor, f.scope, f.receipt);
    const launch = await a.createLaunch(f.actor, f.scope);
    const raw = await withTenantTransaction(admin, tenantId, (c) =>
      c.query(
        'select * from commerce.monthly_purchase_launches where tenant_id=$1 and operation_id=$2',
        [tenantId, f.initial.id],
      ),
    );
    expect(JSON.stringify(raw.rows)).not.toContain(launch.launchCode);
    const r = await Promise.allSettled([
      a.consumeLaunch(f.initial.id, launch.launchCode),
      b.consumeLaunch(f.initial.id, launch.launchCode),
    ]);
    expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect(r.filter((x) => x.status === 'rejected')).toHaveLength(1);
  });
  it('superseded code, expired code and mapping drift deny bank navigation', async () => {
    const f = await fixture();
    await a.claimDispatch(f.actor, f.scope, f.consent);
    await a.saveReceipt(f.actor, f.scope, f.receipt);
    const old = await a.createLaunch(f.actor, f.scope),
      fresh = await b.createLaunch(f.actor, f.scope);
    await expect(a.consumeLaunch(f.initial.id, old.launchCode)).rejects.toThrow();
    await withTenantTransaction(admin, tenantId, (c) =>
      c.query(
        "update commerce.monthly_purchase_launches set created_at=statement_timestamp()-interval '120 seconds',expires_at=statement_timestamp()-interval '61 seconds' where tenant_id=$1 and operation_id=$2",
        [tenantId, f.initial.id],
      ),
    );
    await expect(a.consumeLaunch(f.initial.id, fresh.launchCode)).rejects.toThrow();
    const next = await a.createLaunch(f.actor, f.scope);
    await withTenantTransaction(admin, tenantId, (c) =>
      c.query(
        "update integration.external_entity_map set sync_status='pending' where tenant_id=$1 and id=$2",
        [tenantId, f.mappingId],
      ),
    );
    await expect(a.consumeLaunch(f.initial.id, next.launchCode)).rejects.toThrow();
  });
  it('expired quote can renew only without a dispatch marker; operation identity and ambiguous hold stay fixed', async () => {
    const f = await fixture();
    await withTenantTransaction(admin, tenantId, (c) =>
      c.query(
        "update commerce.monthly_purchase_attempts set quote_expires_at=clock_timestamp()-interval '1 second' where tenant_id=$1 and id=$2",
        [tenantId, f.initial.id],
      ),
    );
    const restarted = await a.restartExpiredQuote(f.actor, f.scope);
    expect(restarted.id).toBe(f.initial.id);
    expect(restarted.state).toBe('QUOTING');
    expect(restarted.quote).toBeNull();
    const fresh = {
      ...f.quote,
      revision: mpHash('renewed-price'),
      amountMinor: f.quote.amountMinor + 100,
    };
    await a.saveQuote(f.actor, f.scope, fresh);
    await expect(a.claimDispatch(f.actor, f.scope, f.consent)).rejects.toThrow();
    await a.claimDispatch(f.actor, f.scope, {
      ...f.consent,
      expectedRevision: fresh.revision,
      amountMinor: fresh.amountMinor,
    });
    await a.markUnknown(f.actor, f.scope);
    expect((await a.restartExpiredQuote(f.actor, f.scope)).state).toBe('UNKNOWN');
    expect((await a.read(f.actor, f.scope))?.quote).toEqual(fresh);
  });
  it.each(['revocation', 'expiry'] as const)(
    'rechecks %s after waiting on the launch row lock',
    async (mode) => {
      const f = await fixture();
      await a.claimDispatch(f.actor, f.scope, f.consent);
      await a.saveReceipt(f.actor, f.scope, f.receipt);
      const link = await a.createLaunch(f.actor, f.scope),
        holder = await admin.connect();
      let pending: Promise<{ ok: boolean }> | undefined;
      try {
        if (mode === 'expiry')
          await withTenantTransaction(admin, tenantId, (c) =>
            c.query(
              "update commerce.monthly_purchase_launches set expires_at=clock_timestamp()+interval '2 seconds' where tenant_id=$1 and operation_id=$2",
              [tenantId, f.initial.id],
            ),
          );
        await holder.query('begin');
        await holder.query("select set_config('app.tenant_id',$1,true)", [tenantId]);
        const pid = Number(
          (await holder.query<{ pid: number }>('select pg_backend_pid() pid')).rows[0]!.pid,
        );
        await holder.query(
          'select id from commerce.monthly_purchase_launches where tenant_id=$1 and operation_id=$2 for update',
          [tenantId, f.initial.id],
        );
        pending = a.consumeLaunch(f.initial.id, link.launchCode).then(
          () => ({ ok: true }),
          () => ({ ok: false }),
        );
        let blocked = false;
        for (let n = 0; n < 100; n++) {
          blocked =
            (
              await admin.query(
                'select 1 from pg_stat_activity where $1=any(pg_blocking_pids(pid))',
                [pid],
              )
            ).rowCount !== 0;
          if (blocked) break;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(blocked).toBe(true);
        if (mode === 'revocation')
          await withTenantTransaction(admin, tenantId, (c) =>
            c.query(
              'update identity.refresh_sessions set revoked_at=clock_timestamp() where tenant_id=$1 and id=$2',
              [tenantId, f.actor.sessionId],
            ),
          );
        else await admin.query('select pg_sleep(2.1)');
        await holder.query('commit');
        expect(await pending).toEqual({ ok: false });
        const row = await withTenantTransaction(admin, tenantId, (c) =>
          c.query<{ used_at: Date | null }>(
            'select used_at from commerce.monthly_purchase_launches where tenant_id=$1 and code_hash=$2',
            [tenantId, mpHash(link.launchCode)],
          ),
        );
        expect(row.rows[0]!.used_at).toBeNull();
      } finally {
        await holder.query('rollback');
        holder.release();
        await pending;
      }
    },
  );
  it('tenant RLS and composite mapping FK reject cross-tenant/orphan custody', async () => {
    const f = await fixture(),
      other = await fixture(foreign);
    const unseen = await withTenantTransaction(one, foreign, (c) =>
      c.query('select id from commerce.monthly_purchase_attempts where id=$1', [f.initial.id]),
    );
    expect(unseen.rowCount).toBe(0);
    await expect(
      withTenantTransaction(admin, tenantId, (c) =>
        c.query(
          'update commerce.monthly_purchase_attempts set provider_mapping_id=$3 where tenant_id=$1 and id=$2',
          [tenantId, f.initial.id, other.mappingId],
        ),
      ),
    ).rejects.toMatchObject({ code: '23503' });
    await expect(
      withTenantTransaction(one, foreign, (c) =>
        c.query(
          'update commerce.monthly_purchase_attempts set tenant_id=$1 where tenant_id=$2 and id=$3',
          [tenantId, foreign, other.initial.id],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });
  it('audit failure rolls back dispatch atomically; immutable receipt IDs cannot be reassigned', async () => {
    const f = await fixture();
    await admin.query(`revoke insert on audit.outbox_events from ${role}`);
    try {
      await expect(a.claimDispatch(f.actor, f.scope, f.consent)).rejects.toMatchObject({
        code: '42501',
      });
    } finally {
      await admin.query(`grant insert on audit.outbox_events to ${role}`);
    }
    expect((await a.read(f.actor, f.scope))?.state).toBe('QUOTED');
    await a.claimDispatch(f.actor, f.scope, f.consent);
    await a.saveReceipt(f.actor, f.scope, f.receipt);
    await expect(
      a.saveReceipt(f.actor, f.scope, { ...f.receipt, providerTransactionId: 'other-transaction' }),
    ).rejects.toThrow();
    expect((await a.read(f.actor, f.scope))?.receipt?.providerTransactionId).toBe(
      f.receipt.providerTransactionId,
    );
  });
});
