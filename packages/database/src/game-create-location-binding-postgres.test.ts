import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { withTenantTransaction } from './connection.js';
import {
  createGameCreateLocationBindingRepository,
  resolveGameCreateLocationBinding,
  type CreateLocationCandidate,
} from './game-create-location-binding-repository.js';
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
    throw new Error('CREATE_LOCATION_DISPOSABLE_CI_DATABASE_REQUIRED');
  return url.toString();
}
const adminUrl = ciDatabase();
const suite = adminUrl ? describe : describe.skip;
suite('CREATE location binding physical PostgreSQL (existing CI database only)', () => {
  const admin = new Pool({ connectionString: adminUrl, max: 4 });
  const tenantId = randomUUID(),
    otherTenant = randomUUID(),
    actorId = randomUUID(),
    stationId = randomUUID(),
    courtId = randomUUID(),
    mappingId = randomUUID();
  const role = `create_location_${randomUUID().replaceAll('-', '')}`,
    password = randomUUID();
  let runtime: Pool;
  let repository: ReturnType<typeof createGameCreateLocationBindingRepository>;
  let candidate: CreateLocationCandidate;
  beforeAll(async () => {
    await admin.query(
      `create role ${role} login password '${password}' nosuperuser nobypassrls noinherit nocreatedb nocreaterole`,
    );
    await admin.query(
      `grant usage on schema identity,integration,locations,games,audit to ${role}`,
    );
    await admin.query(
      `grant select on identity.tenants,integration.identity_provider_bindings,integration.external_entity_map,locations.profiles,games.games to ${role}`,
    );
    await admin.query(
      `grant update on integration.identity_provider_bindings,integration.external_entity_map,locations.profiles,games.games to ${role}`,
    ); // FOR SHARE permission in disposable role only.
    await admin.query(
      `grant select,insert,update on integration.game_create_location_bindings to ${role}`,
    );
    await admin.query(`grant insert on audit.audit_log,audit.outbox_events to ${role}`);
    const url = new URL(adminUrl!);
    url.username = role;
    url.password = password;
    runtime = new Pool({ connectionString: url.toString(), max: 4 });
    repository = createGameCreateLocationBindingRepository(runtime);
    await admin.query(
      `insert into identity.tenants(id,tenant_key,display_name) values($1,$2,'Synthetic CREATE fixture'),($3,$4,'Other CREATE fixture')`,
      [tenantId, `create-location-${tenantId}`, otherTenant, `create-location-${otherTenant}`],
    );
    await withTenantTransaction(admin, tenantId, async (client) => {
      await client.query(`insert into identity.users(tenant_id,id,status) values($1,$2,'ACTIVE')`, [
        tenantId,
        actorId,
      ]);
      await client.query(
        `insert into integration.identity_provider_bindings(tenant_id,provider,provider_tenant_key) values($1,'VIVA','iSkq6G')`,
        [tenantId],
      );
      await client.query(
        `insert into locations.profiles(tenant_id,id,slug,title,created_by,updated_by,publication_status,published_at) values($1,$2,'synthetic-create-location','Synthetic location',$3,$3,'PUBLISHED',now())`,
        [tenantId, stationId, actorId],
      );
      await client.query(
        `insert into integration.external_entity_map(tenant_id,id,external_system,entity_type,internal_id,external_id,external_version,sync_status,last_synced_at) values($1,$2,'LK_LEGACY_SNAPSHOT','game_court',$3,'synthetic-room','v1','synced',now())`,
        [tenantId, mappingId, courtId],
      );
    });
    const snapshot = await repository.snapshot(tenantId);
    expect(snapshot).not.toBeNull();
    candidate = {
      courtId,
      stationId,
      courtMappingId: mappingId,
      studioId: 'synthetic-studio',
      roomId: 'synthetic-room',
      lineageDigest: snapshot!.lineage.digest,
      evidenceDigest: 'a'.repeat(64),
      verifiedAt: new Date().toISOString(),
    };
  });
  afterAll(async () => {
    if (runtime) await runtime.end();
    for (const id of [tenantId, otherTenant])
      await withTenantTransaction(admin, id, async (client) => {
        for (const table of [
          'integration.game_create_location_bindings',
          'audit.outbox_events',
          'audit.audit_log',
          'integration.external_entity_map',
          'locations.profiles',
          'integration.identity_provider_bindings',
          'identity.users',
        ])
          await client.query(`delete from ${table} where tenant_id=$1`, [id]);
      });
    await admin.query('delete from identity.tenants where id=any($1::uuid[])', [
      [tenantId, otherTenant],
    ]);
    await admin.query(`drop owned by ${role}`);
    await admin.query(`drop role if exists ${role}`);
    await admin.end();
  });
  it('concurrent absent-row CAS produces one binding, one audit and one outbox; lost ACK exact replay changes nothing', async () => {
    const commands = [
      { tenantId, candidate, expectedRevision: null, commandId: randomUUID() },
      { tenantId, candidate, expectedRevision: null, commandId: randomUUID() },
    ];
    const results = await Promise.all(commands.map((command) => repository.publish(command)));
    expect([...results].sort()).toEqual(['APPLIED', 'CONFLICT']);
    const winner = commands[results[0] === 'APPLIED' ? 0 : 1]!;
    // Determine winner from the durable row, rather than completion order.
    const stored = await withTenantTransaction(runtime, tenantId, (c) =>
      c.query<{ last_command_id: string }>(
        'select last_command_id from integration.game_create_location_bindings where tenant_id=$1',
        [tenantId],
      ),
    );
    const original =
      commands.find((c) => c.commandId === stored.rows[0]!.last_command_id) ?? winner;
    expect(await repository.publish(original)).toBe('REPLAYED');
    expect(
      await repository.publish({ ...original, candidate: { ...candidate, roomId: 'wrong' } }),
    ).toBe('CONFLICT');
    const counts = await withTenantTransaction(admin, tenantId, (c) =>
      c.query(
        `select (select count(*) from integration.game_create_location_bindings where tenant_id=$1)::int bindings,(select count(*) from audit.audit_log where tenant_id=$1)::int audits,(select count(*) from audit.outbox_events where tenant_id=$1)::int events`,
        [tenantId],
      ),
    );
    expect(counts.rows[0]).toEqual({ bindings: 1, audits: 1, events: 1 });
  });
  it('FORCE RLS conceals foreign tenant and rejects cross-tenant insertion', async () => {
    const hidden = await withTenantTransaction(runtime, otherTenant, (c) =>
      c.query('select * from integration.game_create_location_bindings where tenant_id=$1', [
        tenantId,
      ]),
    );
    expect(hidden.rows).toHaveLength(0);
    await expect(
      withTenantTransaction(runtime, otherTenant, (c) =>
        c.query(
          `insert into integration.game_create_location_bindings
      (tenant_id,court_id,station_id,court_mapping_id,provider_tenant_key,provider_studio_id,provider_room_id,revision,state,lineage_digest,evidence_digest,verified_at,expires_at,last_command_id,last_command_hash)
      values($1,$2,$3,$4,'iSkq6G','synthetic-studio','other-room',1,'ACTIVE',$5,$5,now(),now()+interval '5 minutes',$6,$5)`,
          [tenantId, randomUUID(), stationId, mappingId, 'a'.repeat(64), randomUUID()],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    const forced = await admin.query(
      `select relrowsecurity,relforcerowsecurity from pg_class where oid='integration.game_create_location_bindings'::regclass`,
    );
    expect(forced.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
  });
  it('audit failure rolls back a renewal, then stale CAS cannot revoke renewed revision', async () => {
    await admin.query(`revoke insert on audit.outbox_events from ${role}`);
    await expect(
      repository.publish({ tenantId, candidate, expectedRevision: '1', commandId: randomUUID() }),
    ).rejects.toThrow();
    await admin.query(`grant insert on audit.outbox_events to ${role}`);
    expect((await repository.snapshot(tenantId))!.bindings[0]!.revision).toBe('1');
    expect(
      await repository.publish({
        tenantId,
        candidate,
        expectedRevision: '1',
        commandId: randomUUID(),
      }),
    ).toBe('APPLIED');
    expect(
      await repository.revoke({
        tenantId,
        courtId,
        expectedRevision: '1',
        correlationId: randomUUID(),
      }),
    ).toBe(false);
  });
  it('the active-room unique index rejects a second court independently of producer CAS', async () => {
    await expect(
      withTenantTransaction(admin, tenantId, (client) =>
        client.query(
          `
      insert into integration.game_create_location_bindings
        (tenant_id,court_id,station_id,court_mapping_id,provider_tenant_key,provider_studio_id,provider_room_id,
         revision,state,lineage_digest,evidence_digest,verified_at,expires_at,last_command_id,last_command_hash)
      select tenant_id,$2,station_id,court_mapping_id,provider_tenant_key,provider_studio_id,provider_room_id,
         1,'ACTIVE',lineage_digest,evidence_digest,verified_at,expires_at,$3,last_command_hash
      from integration.game_create_location_bindings where tenant_id=$1 and court_id=$4`,
          [tenantId, randomUUID(), randomUUID(), courtId],
        ),
      ),
    ).rejects.toMatchObject({
      code: '23505',
      constraint: 'game_create_location_binding_active_room_unique',
    });
  });
  it('expiry closes reads; fresh timestamps cannot bypass an absent parent FK', async () => {
    await withTenantTransaction(admin, tenantId, (c) =>
      c.query(
        `update integration.game_create_location_bindings set verified_at=statement_timestamp()-interval '6 minutes',expires_at=statement_timestamp()-interval '1 minute' where tenant_id=$1`,
        [tenantId],
      ),
    );
    expect(
      await withTenantTransaction(runtime, tenantId, (c) =>
        resolveGameCreateLocationBinding(c, { tenantId, courtId, stationId }),
      ),
    ).toBeNull();
    await withTenantTransaction(admin, tenantId, (c) =>
      c.query(
        `update integration.game_create_location_bindings set verified_at=statement_timestamp(),expires_at=statement_timestamp()+interval '5 minutes' where tenant_id=$1`,
        [tenantId],
      ),
    );
    await expect(
      withTenantTransaction(admin, tenantId, (c) =>
        c.query(
          `update integration.game_create_location_bindings set station_id=$2 where tenant_id=$1`,
          [tenantId, randomUUID()],
        ),
      ),
    ).rejects.toMatchObject({ code: '23503' });
  });
  it('reads fresh binding, rejects retargeted alias without constraining old importer, and honors revocation', async () => {
    const read = () =>
      withTenantTransaction(runtime, tenantId, (c) =>
        resolveGameCreateLocationBinding(c, { tenantId, courtId, stationId }),
      );
    expect(await read()).not.toBeNull();
    await withTenantTransaction(admin, tenantId, (c) =>
      c.query(
        'update integration.external_entity_map set internal_id=$3 where tenant_id=$1 and id=$2',
        [tenantId, mappingId, randomUUID()],
      ),
    );
    expect(await read()).toBeNull();
    expect(
      await repository.revoke({
        tenantId,
        courtId,
        expectedRevision: '2',
        correlationId: randomUUID(),
      }),
    ).toBe(true);
    expect(await read()).toBeNull();
  });
});
