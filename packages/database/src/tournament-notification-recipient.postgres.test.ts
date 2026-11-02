import { randomUUID, createHash } from 'node:crypto';
import { Pool } from 'pg';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { withTenantTransaction } from './connection.js';
import { tournamentOwnerKey } from './tournament-local-repository.js';
import { createTournamentNotificationRecipientResolver } from './tournament-notification-recipient.js';
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
(url ? describe : describe.skip)(
  'notification identity reverse lookup on existing CI PostgreSQL',
  () => {
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
        resolve: () =>
          createTournamentNotificationRecipientResolver(pool, {
            tenantId,
            tenantKey,
            ownerTenantKey,
          })(tournamentId, {
            kind: 'PARTICIPANT',
            generation,
            actorHash: createHash('sha256')
              .update(
                'tournament-local-actor:v1\0' + JSON.stringify([ownerTenantKey, providerClientId]),
              )
              .digest('hex'),
          }),
        organizer: () =>
          createTournamentNotificationRecipientResolver(pool, {
            tenantId,
            tenantKey,
            ownerTenantKey,
          })(tournamentId, { kind: 'ORGANIZER', revision: 1, selectedUserId: userId }),
      };
    }
    it('derives original user from immutable DISPATCHED JOIN and resolves organizer through current provider mapping', async () => {
      const f = await fixture();
      await expect(f.resolve()).resolves.toMatchObject({
        userId: f.scope.userId,
        providerMappingId: f.mapId,
        providerClientId: f.identity.providerClientId,
        ownerTenantKey,
      });
      await expect(f.organizer()).resolves.toMatchObject({
        userId: f.scope.userId,
        providerMappingId: f.mapId,
      });
    });
    it('READY, corrupt original authority and ambiguous reverse generation deny', async () => {
      for (const statement of [
        "update booking.tournament_local_attempts set state='READY',dispatch_started_at=null where tenant_id=$1 and id=$2",
        "update booking.tournament_local_attempts set authority_hash=repeat('a',64) where tenant_id=$1 and id=$2",
      ]) {
        const f = await fixture();
        await withTenantTransaction(pool, tenantId, (c) =>
          c.query(statement, [tenantId, f.attemptId]),
        );
        await expect(f.resolve()).rejects.toThrow();
      }
      const f = await fixture(),
        g = await fixture();
      await withTenantTransaction(pool, tenantId, (c) =>
        c.query(
          'update booking.tournament_local_attempts set tournament_id=$3,owner_operation_id=$4 where tenant_id=$1 and id=$2',
          [tenantId, g.attemptId, f.scope.tournamentId, f.generation],
        ),
      );
      await expect(f.resolve()).rejects.toThrow();
    });
    it('disabled tenant/user, stale mapping and mapping transfer deny both authority kinds', async () => {
      for (const statement of [
        "update identity.users set status='DISABLED' where tenant_id=$1 and id=$2",
        "update integration.external_entity_map set sync_status='error',sync_error_code='SYNTHETIC' where tenant_id=$1 and internal_id=$2",
      ]) {
        const f = await fixture();
        await withTenantTransaction(pool, tenantId, (c) =>
          c.query(statement, [tenantId, f.scope.userId]),
        );
        await expect(f.resolve()).rejects.toThrow();
        await expect(f.organizer()).rejects.toThrow();
      }
      const f = await fixture();
      await withTenantTransaction(pool, tenantId, (c) =>
        c.query('update integration.external_entity_map set id=$3 where tenant_id=$1 and id=$2', [
          tenantId,
          f.mapId,
          randomUUID(),
        ]),
      );
      await expect(f.resolve()).rejects.toThrow();
      const g = await fixture();
      await pool.query('update identity.tenants set active=false where id=$1', [tenantId]);
      try {
        await expect(g.resolve()).rejects.toThrow();
        await expect(g.organizer()).rejects.toThrow();
      } finally {
        await pool.query('update identity.tenants set active=true where id=$1', [tenantId]);
      }
    });
    it('canonical unique mapping rejects impossible duplicate; no index weakening', async () => {
      const f = await fixture();
      await expect(
        withTenantTransaction(pool, tenantId, (c) =>
          c.query(
            "insert into integration.external_entity_map(tenant_id,id,external_system,entity_type,internal_id,external_id,sync_status,last_synced_at) values($1,$2,'VIVA','viva_profile',$3,$4,'synced',now())",
            [tenantId, randomUUID(), f.scope.userId, 'synthetic-duplicate'],
          ),
        ),
      ).rejects.toMatchObject({
        code: '23505',
        constraint: 'external_entity_map_canonical_internal_idx',
      });
      await expect(f.resolve()).resolves.toMatchObject({ userId: f.scope.userId });
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
      await expect(f.resolve()).rejects.toThrow();
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
      await expect(f.resolve()).resolves.toMatchObject({
        userId: f.scope.userId,
        providerMappingId: f.mapId,
      });
    });
  },
);
