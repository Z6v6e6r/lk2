import { randomUUID, createHash } from 'node:crypto';
import { Pool } from 'pg';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { withTenantTransaction } from '@phub/database';
import { createTournamentChatActorReader } from './tournament-chat-actor-context.js';
function ciDatabase() {
  if (process.env.GITHUB_ACTIONS !== 'true' || process.env.APP_ENV !== 'ci') return undefined;
  if (!process.env.DATABASE_URL) throw Error('TOURNAMENT_CHAT_CI_DATABASE_REQUIRED');
  const u = new URL(process.env.DATABASE_URL);
  if (
    process.env.VIVA_MODE !== 'mock' ||
    !['postgres:', 'postgresql:'].includes(u.protocol) ||
    !['127.0.0.1', 'localhost'].includes(u.hostname) ||
    u.username !== 'phub' ||
    u.password !== 'ci-password' ||
    u.pathname !== '/phub' ||
    u.port !== '5432' ||
    u.search ||
    u.hash
  )
    throw Error('TOURNAMENT_CHAT_CI_DATABASE_REQUIRED');
  return u.href;
}
const url = ciDatabase();
(url ? describe : describe.skip)('tournament actor on existing migrated CI PostgreSQL', () => {
  const pool = new Pool({ connectionString: url, max: 2 }),
    tenantId = randomUUID(),
    tenantKey = 'chat-' + tenantId,
    read = createTournamentChatActorReader(pool);
  beforeAll(async () => {
    await pool.query(
      "insert into identity.tenants(id,tenant_key,display_name) values($1,$2,'Synthetic chat')",
      [tenantId, tenantKey],
    );
    await withTenantTransaction(pool, tenantId, (c) =>
      c.query(
        "insert into integration.identity_provider_bindings(tenant_id,provider,provider_tenant_key) values($1,'VIVA','synthetic-owner-different')",
        [tenantId],
      ),
    );
  });
  afterAll(async () => {
    try {
      await withTenantTransaction(pool, tenantId, async (c) => {
        for (const table of [
          'identity.refresh_sessions',
          'integration.external_entity_map',
          'integration.identity_provider_bindings',
          'identity.users',
        ])
          await c.query(`delete from ${table} where tenant_id=$1`, [tenantId]);
      });
      await pool.query('delete from identity.tenants where id=$1', [tenantId]);
    } finally {
      await pool.end();
    }
  });
  async function fixture() {
    const userId = randomUUID(),
      sessionId = randomUUID(),
      mapId = randomUUID(),
      providerId = 'synthetic-' + userId;
    await withTenantTransaction(pool, tenantId, async (c) => {
      await c.query("insert into identity.users(tenant_id,id,status) values($1,$2,'ACTIVE')", [
        tenantId,
        userId,
      ]);
      await c.query(
        "insert into identity.refresh_sessions(id,tenant_id,user_id,family_id,token_hash,expires_at) values($1,$2,$3,$4,$5,now()+interval '1 hour')",
        [
          sessionId,
          tenantId,
          userId,
          randomUUID(),
          createHash('sha256').update(sessionId).digest('hex'),
        ],
      );
      await c.query(
        "insert into integration.external_entity_map(tenant_id,id,external_system,entity_type,internal_id,external_id,sync_status,last_synced_at) values($1,$2,'VIVA','viva_profile',$3,$4,'synced',now())",
        [tenantId, mapId, userId, providerId],
      );
    });
    return {
      actor: { tenantId, tenantKey, userId, sessionId, correlationId: randomUUID() },
      mapId,
      providerId,
    };
  }
  it('resolves exact current ACTIVE session and distinct provider tenant namespace', async () => {
    const x = await fixture();
    expect(await read(x.actor)).toEqual({
      ownerTenantKey: 'synthetic-owner-different',
      providerClientId: x.providerId,
    });
  });
  it('rejects foreign tenant key/user/session and revoked session', async () => {
    const x = await fixture();
    for (const actor of [
      { ...x.actor, tenantKey: 'foreign' },
      { ...x.actor, userId: randomUUID() },
      { ...x.actor, sessionId: randomUUID() },
    ])
      await expect(read(actor)).rejects.toMatchObject({ status: 403 });
    await withTenantTransaction(pool, tenantId, (c) =>
      c.query(
        'update identity.refresh_sessions set revoked_at=now() where tenant_id=$1 and id=$2',
        [tenantId, x.actor.sessionId],
      ),
    );
    await expect(read(x.actor)).rejects.toMatchObject({ status: 403 });
  });
  it('existing forward and reverse uniqueness reject ambiguous mappings without weakening constraints', async () => {
    const x = await fixture(),
      y = await fixture();
    for (const [user, external] of [
      [x.actor.userId, 'synthetic-other-' + randomUUID()],
      [y.actor.userId, x.providerId],
    ])
      await expect(
        withTenantTransaction(pool, tenantId, (c) =>
          c.query(
            "insert into integration.external_entity_map(tenant_id,id,external_system,entity_type,internal_id,external_id,sync_status) values($1,$2,'VIVA','viva_profile',$3,$4,'pending')",
            [tenantId, randomUUID(), user, external],
          ),
        ),
      ).rejects.toMatchObject({ code: '23505' });
    expect(await read(x.actor)).toMatchObject({ providerClientId: x.providerId });
    await withTenantTransaction(pool, tenantId, (c) =>
      c.query(
        "update integration.external_entity_map set sync_status='pending' where tenant_id=$1 and id=$2",
        [tenantId, x.mapId],
      ),
    );
    await expect(read(x.actor)).rejects.toMatchObject({ status: 403 });
  });
  it('rejects missing mapping and inactive canonical identity', async () => {
    const x = await fixture();
    await withTenantTransaction(pool, tenantId, (c) =>
      c.query('delete from integration.external_entity_map where tenant_id=$1 and id=$2', [
        tenantId,
        x.mapId,
      ]),
    );
    await expect(read(x.actor)).rejects.toMatchObject({ status: 403 });
    const y = await fixture();
    await withTenantTransaction(pool, tenantId, (c) =>
      c.query("update identity.users set status='DISABLED' where tenant_id=$1 and id=$2", [
        tenantId,
        y.actor.userId,
      ]),
    );
    await expect(read(y.actor)).rejects.toMatchObject({ status: 403 });
  });
  it('rejects missing authoritative namespace binding', async () => {
    const x = await fixture();
    await withTenantTransaction(pool, tenantId, (c) =>
      c.query(
        "delete from integration.identity_provider_bindings where tenant_id=$1 and provider='VIVA'",
        [tenantId],
      ),
    );
    try {
      await expect(read(x.actor)).rejects.toMatchObject({ status: 403 });
    } finally {
      await withTenantTransaction(pool, tenantId, (c) =>
        c.query(
          "insert into integration.identity_provider_bindings(tenant_id,provider,provider_tenant_key) values($1,'VIVA','synthetic-owner-different')",
          [tenantId],
        ),
      );
    }
  });
});
