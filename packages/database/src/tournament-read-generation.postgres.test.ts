import { randomUUID, createHash } from 'node:crypto';
import { Pool } from 'pg';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { withTenantTransaction } from './connection.js';
import {
  verifyTournamentReadGeneration,
  tournamentOwnerKey,
} from './tournament-local-repository.js';
import { tournamentDigest, tournamentOwnerOperationId } from '@phub/domain';
function ciDatabase() {
  if (process.env.GITHUB_ACTIONS !== 'true' || process.env.APP_ENV !== 'ci') return undefined;
  if (!process.env.DATABASE_URL) throw Error('TOURNAMENT_READ_CI_DATABASE_REQUIRED');
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
    throw Error('TOURNAMENT_READ_CI_DATABASE_REQUIRED');
  return u.href;
}
const url = ciDatabase();
(url ? describe : describe.skip)('original tournament generation on existing CI PostgreSQL', () => {
  const pool = new Pool({ connectionString: url, max: 2 }),
    tenantId = randomUUID(),
    tenantKey = 'read-' + tenantId;
  const ownerTenantKey = 'synthetic-distinct-owner';
  beforeAll(async () => {
    await pool.query(
      "insert into identity.tenants(id,tenant_key,display_name) values($1,$2,'Synthetic read')",
      [tenantId, tenantKey],
    );
    await withTenantTransaction(pool, tenantId, (c) =>
      c.query(
        "insert into integration.identity_provider_bindings(tenant_id,provider,provider_tenant_key) values($1,'VIVA',$2)",
        [tenantId, ownerTenantKey],
      ),
    );
  });
  afterAll(async () => {
    try {
      await withTenantTransaction(pool, tenantId, async (c) => {
        for (const table of [
          'booking.tournament_local_attempts',
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
      mapId = randomUUID(),
      attemptId = randomUUID(),
      tournamentId = randomUUID(),
      providerClientId = 'synthetic-' + userId;
    const request = { action: 'JOIN' as const },
      command = { schemaVersion: 1, action: 'JOIN', tournamentId, date: '2026-11-01' };
    const generation = await tournamentOwnerOperationId(
      ownerTenantKey,
      providerClientId,
      tournamentOwnerKey(attemptId),
      tournamentId,
    );
    const authority = await tournamentDigest('lk2-tournament-authority:v1', [
      attemptId,
      tenantId,
      userId,
      command,
      ownerTenantKey,
      providerClientId,
      mapId,
      null,
    ]);
    await withTenantTransaction(pool, tenantId, async (c) => {
      await c.query("insert into identity.users(tenant_id,id,status) values($1,$2,'ACTIVE')", [
        tenantId,
        userId,
      ]);
      await c.query(
        "insert into integration.external_entity_map(tenant_id,id,external_system,entity_type,internal_id,external_id,sync_status,last_synced_at) values($1,$2,'VIVA','viva_profile',$3,$4,'synced',now())",
        [tenantId, mapId, userId, providerClientId],
      );
      await c.query(
        `insert into booking.tournament_local_attempts(tenant_id,id,actor_user_id,tournament_id,key_sha256,request,request_hash,owner_command,owner_operation_id,provider_tenant_key,provider_client_id,provider_mapping_id,authority_hash,state,dispatch_started_at)
        values($1,$2,$3,$4,$5,$6::jsonb,$7,$8::jsonb,$9,$10,$11,$12,$13,'DISPATCHED',now())`,
        [
          tenantId,
          attemptId,
          userId,
          tournamentId,
          createHash('sha256').update(attemptId).digest('hex'),
          JSON.stringify(request),
          await tournamentDigest('lk2-tournament-request:v1', { tournamentId, ...request }),
          JSON.stringify(command),
          generation,
          ownerTenantKey,
          providerClientId,
          mapId,
          authority,
        ],
      );
    });
    const scope = { tenantId, userId, tournamentId },
      identity = { ownerTenantKey, providerClientId };
    return {
      scope,
      identity,
      generation,
      attemptId,
      mapId,
      command,
      verify: () => verifyTournamentReadGeneration(pool, scope, generation, identity),
    };
  }
  it('unique immutable DISPATCHED original qualifies only as tuple evidence for fresh owner witness', async () => {
    const f = await fixture();
    await expect(f.verify()).resolves.toBeUndefined();
  });
  it('READY, missing, foreign tenant/actor/generation cannot resolve', async () => {
    const f = await fixture();
    await expect(
      verifyTournamentReadGeneration(
        pool,
        { ...f.scope, userId: randomUUID() },
        f.generation,
        f.identity,
      ),
    ).rejects.toThrow();
    await expect(
      verifyTournamentReadGeneration(
        pool,
        { ...f.scope, tenantId: randomUUID() },
        f.generation,
        f.identity,
      ),
    ).rejects.toThrow();
    await expect(
      verifyTournamentReadGeneration(pool, f.scope, randomUUID(), f.identity),
    ).rejects.toThrow();
    await withTenantTransaction(pool, tenantId, (c) =>
      c.query(
        "update booking.tournament_local_attempts set state='READY',dispatch_started_at=null where tenant_id=$1 and id=$2",
        [tenantId, f.attemptId],
      ),
    );
    await expect(f.verify()).rejects.toThrow();
  });
  it('corrupt original authority and ambiguous reverse generation fail closed', async () => {
    const f = await fixture();
    await withTenantTransaction(pool, tenantId, (c) =>
      c.query(
        'update booking.tournament_local_attempts set authority_hash=$3 where tenant_id=$1 and id=$2',
        [tenantId, f.attemptId, 'a'.repeat(64)],
      ),
    );
    await expect(f.verify()).rejects.toThrow();
    const g = await fixture(),
      other = await fixture();
    await withTenantTransaction(pool, tenantId, (c) =>
      c.query(
        'update booking.tournament_local_attempts set tournament_id=$3,owner_operation_id=$4 where tenant_id=$1 and id=$2',
        [tenantId, other.attemptId, g.scope.tournamentId, g.generation],
      ),
    );
    await expect(g.verify()).rejects.toThrow();
  });
  it('disabled canonical identity, mapping transfer and duplicate mapping deny old tuple', async () => {
    const f = await fixture();
    await withTenantTransaction(pool, tenantId, (c) =>
      c.query("update identity.users set status='DISABLED' where tenant_id=$1 and id=$2", [
        tenantId,
        f.scope.userId,
      ]),
    );
    await expect(f.verify()).rejects.toThrow();
    const g = await fixture();
    await withTenantTransaction(pool, tenantId, (c) =>
      c.query('update integration.external_entity_map set id=$3 where tenant_id=$1 and id=$2', [
        tenantId,
        g.mapId,
        randomUUID(),
      ]),
    );
    await expect(g.verify()).rejects.toThrow();
    const h = await fixture();
    await withTenantTransaction(pool, tenantId, (c) =>
      c.query(
        "insert into integration.external_entity_map(tenant_id,id,external_system,entity_type,internal_id,external_id,sync_status,last_synced_at) values($1,$2,'VIVA','viva_profile',$3,$4,'synced',now())",
        [tenantId, randomUUID(), h.scope.userId, 'synthetic-duplicate'],
      ),
    );
    await expect(h.verify()).rejects.toThrow();
  });
  it('completed rejection cannot impersonate current original JOIN', async () => {
    const f = await fixture(),
      receipt = {
        schemaVersion: 1,
        tournamentId: f.scope.tournamentId,
        operation: {
          operationId: f.generation,
          action: 'JOIN',
          outcome: 'REJECTED',
          reason: 'FULL',
          generation: null,
          committedAt: '2026-11-01T00:00:00.000Z',
        },
        registration: { status: 'NOT_REGISTERED_BY_OPERATION', asOf: '2026-11-01T00:00:00.000Z' },
      };
    await withTenantTransaction(pool, tenantId, async (c) =>
      c.query(
        "update booking.tournament_local_attempts set state='COMPLETED',receipt=$3::jsonb,receipt_hash=$4 where tenant_id=$1 and id=$2",
        [
          tenantId,
          f.attemptId,
          JSON.stringify(receipt),
          await tournamentDigest('lk2-tournament-receipt:v1', receipt.operation),
        ],
      ),
    );
    await expect(f.verify()).rejects.toThrow();
  });
  it('completed original REGISTERED receipt keeps exact generation identity', async () => {
    const f = await fixture();
    const operation = {
      operationId: f.generation,
      action: 'JOIN',
      outcome: 'REGISTERED',
      reason: 'REGISTERED',
      generation: f.generation,
      committedAt: '2026-11-01T00:00:00.000Z',
    };
    const receipt = {
      schemaVersion: 1,
      tournamentId: f.scope.tournamentId,
      operation,
      registration: { status: 'REGISTERED', asOf: operation.committedAt },
    };
    const receiptHash = await tournamentDigest('lk2-tournament-receipt:v1', operation);
    await withTenantTransaction(pool, tenantId, (c) =>
      c.query(
        "update booking.tournament_local_attempts set state='COMPLETED',receipt=$3::jsonb,receipt_hash=$4 where tenant_id=$1 and id=$2",
        [tenantId, f.attemptId, JSON.stringify(receipt), receiptHash],
      ),
    );
    await expect(f.verify()).resolves.toBeUndefined();
  });
});
