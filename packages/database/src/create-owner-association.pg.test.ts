import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import {
  createFinancialProofResolver,
  type CreateOriginalBinding,
} from '../../games/src/create-financial-proof-resolver.js';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  originalBinding,
  ownerSnapshot,
  recordedAt,
  syntheticHash,
  syntheticId,
} from '../../games/src/create-financial-proof.test-fixture.js';
import {
  createMappingBindingSha256,
  createOwnerAssociationReader,
} from './create-owner-association-reader.js';

const url = process.env.FIN01_TEST_DATABASE_URL;
if (url) {
  const target = new URL(url);
  if (
    target.hostname !== '127.0.0.1' ||
    target.port !== '55431' ||
    target.pathname !== '/fin01_synthetic'
  ) {
    throw new Error('FIN01_TEST_REQUIRES_OWNED_LOOPBACK_DATABASE');
  }
}
const postgres = url ? describe : describe.skip;
postgres('CREATE original custody and resolver on task-owned real PostgreSQL', () => {
  const admin = new Pool({ connectionString: url, max: 4 });
  const readerUrl = url ? new URL(url) : null;
  if (readerUrl) readerUrl.username = 'fin01_test_runtime';
  const runtime = new Pool({ connectionString: readerUrl?.toString(), max: 4 });
  const ids = new Map(Array.from({ length: 24 }, (_, n) => [syntheticId(n), randomUUID()]));
  const remap = <T>(value: T): T =>
    JSON.parse(
      JSON.stringify(value).replace(/00000000-0000-4000-8000-\d{12}/g, (id) => ids.get(id) ?? id),
    ) as T;
  const binding = remap(originalBinding());
  const key = `fin01-synthetic-key-${randomUUID()}`;
  binding.keySha256 = syntheticHash(key);
  binding.mappingBindingSha256 = createMappingBindingSha256({
    actor: { ...binding.mappings.actor, externalId: ids.get(syntheticId(20))! },
    subscription: { ...binding.mappings.subscription, externalId: ids.get(syntheticId(21))! },
    slot: { ...binding.mappings.slot, slotVersion: binding.slotVersion },
  });
  const lookup = {
    tenantId: binding.tenantId,
    actorUserId: binding.actorUserId,
    operationId: binding.operationId,
  };
  const source = { externalSystem: 'FIN01_SYNTHETIC_SLOT', entityType: 'slot' };
  const originals = createOwnerAssociationReader(runtime, { slotSource: source });
  const rawSnapshot = () => {
    const snapshot = remap(ownerSnapshot());
    snapshot.binding = structuredClone(binding);
    snapshot.receipts.forEach((receipt) => {
      receipt.binding = structuredClone(binding);
      receipt.bindingSha256 = binding.bindingSha256;
    });
    return snapshot;
  };
  // The synthetic owner has its own stored aggregate. No mock returns SUCCEEDED,
  // and this test port is never a production financial/benefit authority.
  const owner = {
    async read(original: { binding: CreateOriginalBinding }) {
      const result = await runtime.query<{ payload: unknown }>(
        'select payload from public.fin01_test_owner_snapshots where tenant_id=$1 and actor_user_id=$2 and operation_id=$3 limit 2',
        [original.binding.tenantId, original.binding.actorUserId, original.binding.operationId],
      );
      if (result.rows.length !== 1) throw new Error('SYNTHETIC_OWNER_AMBIGUOUS_OR_MISSING');
      return result.rows[0]!.payload;
    },
  };
  const resolver = createFinancialProofResolver({ originals, owner });
  const requestHash = syntheticHash('games-request').slice(7);
  async function seedCanonical(value: CreateOriginalBinding, rawKey: string) {
    await admin.query(
      `insert into games.games (tenant_id,id,organizer_user_id,title,kind,visibility,lifecycle_state,station_id,starts_at,ends_at,timezone,capacity,payment_mode)
       values ($1,$2,$3,'FIN01 synthetic game','FRIENDLY','PUBLIC','PROVISIONING',$4,'2027-01-01T12:00:00Z','2027-01-01T13:30:00Z','Europe/Moscow',4,'SUBSCRIPTION')
       on conflict do nothing`,
      [value.tenantId, value.gameId, value.actorUserId, ids.get(syntheticId(22))],
    );
    await admin.query(
      `insert into games.operations (tenant_id,id,game_id,kind,requested_by_user_id)
       values ($1,$2,$3,'CREATE_GAME',$4)`,
      [value.tenantId, value.operationId, value.gameId, value.actorUserId],
    );
    await admin.query(
      `insert into games.command_idempotency (tenant_id,id,actor_user_id,principal_key,idempotency_key,command_type,request_hash,aggregate_id,state,result_payload,completed_at)
       values ($1,$2,$3,$4,$5,'game.create.v1',$6,$7,'COMPLETED',$8,now())`,
      [
        value.tenantId,
        value.operationId,
        value.actorUserId,
        `user:${value.actorUserId}`,
        rawKey,
        requestHash,
        value.gameId,
        { operationId: value.operationId, gameId: value.gameId },
      ],
    );
  }
  async function insert(value: CreateOriginalBinding) {
    const client = await runtime.connect();
    try {
      await client.query('begin');
      await client.query("select set_config('app.tenant_id',$1,true)", [value.tenantId]);
      await client.query(
        `insert into games.create_owner_associations (tenant_id,operation_id,game_id,actor_user_id,owner_contract_version,binding_schema_version,game_request_hash,intent_sha256,key_sha256,binding,recorded_at)
         values ($1,$2,$3,$4,'C1-v1.2',1,$5,$6,$7,$8,$9)`,
        [
          value.tenantId,
          value.operationId,
          value.gameId,
          value.actorUserId,
          requestHash,
          value.intentSha256,
          value.keySha256,
          value,
          recordedAt,
        ],
      );
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }
  async function saveSnapshot(payload: unknown) {
    await admin.query(
      'update public.fin01_test_owner_snapshots set payload=$1 where tenant_id=$2 and operation_id=$3',
      [payload, binding.tenantId, binding.operationId],
    );
  }
  beforeAll(async () => {
    const role = await admin.query("select 1 from pg_roles where rolname='fin01_test_runtime'");
    if (!role.rows.length)
      await admin.query('create role fin01_test_runtime login nosuperuser nobypassrls');
    await admin.query(
      'grant usage on schema games,identity,integration,public to fin01_test_runtime',
    );
    await admin.query(
      'grant select on games.games,games.operations,games.command_idempotency,integration.external_entity_map to fin01_test_runtime',
    );
    await admin.query(
      'grant select,insert,update,delete on games.create_owner_associations to fin01_test_runtime',
    );
    await admin.query(
      'create table if not exists public.fin01_test_owner_snapshots (tenant_id uuid, actor_user_id uuid, operation_id uuid, payload jsonb)',
    );
    await admin.query('grant select on public.fin01_test_owner_snapshots to fin01_test_runtime');
    await admin.query(
      'insert into identity.tenants (id,tenant_key,display_name) values ($1,$2,$3)',
      [binding.tenantId, `fin01-${binding.tenantId}`, 'FIN01 synthetic'],
    );
    await admin.query('insert into identity.users (tenant_id,id) values ($1,$2)', [
      binding.tenantId,
      binding.actorUserId,
    ]);
    await seedCanonical(binding, key);
    for (const kind of ['actor', 'subscription', 'slot'] as const) {
      const map = binding.mappings[kind];
      await admin.query(
        `insert into integration.external_entity_map (id,tenant_id,external_system,entity_type,internal_id,external_id,external_version,last_synced_at,sync_status)
         values ($1,$2,$3,$4,$5,$6,$7,now(),'synced')`,
        [
          map.id,
          map.tenantId,
          kind === 'slot' ? source.externalSystem : 'VIVA',
          kind === 'slot' ? source.entityType : kind === 'actor' ? 'viva_profile' : 'subscription',
          map.internalId,
          kind === 'slot' ? 'synthetic-slot' : ids.get(syntheticId(kind === 'actor' ? 20 : 21)),
          map.revision,
        ],
      );
    }
    await insert(binding);
    await admin.query('insert into public.fin01_test_owner_snapshots values ($1,$2,$3,$4)', [
      binding.tenantId,
      binding.actorUserId,
      binding.operationId,
      rawSnapshot(),
    ]);
  });
  afterAll(async () => {
    await runtime.end();
    await admin.end();
  });

  it('uses real PG original and synthetic owner load paths to verify all three receipts', async () => {
    expect(await originals.load(lookup)).toEqual({ binding, recordedAt });
    expect(await resolver.resolve(lookup)).toMatchObject({
      state: 'EVIDENCE_CONSISTENT',
      canFinalize: false,
      projection: {
        status: 'PROCESSING',
        booking: { status: 'CONFIRMED' },
        benefit: { status: 'APPLIED' },
        settlement: { status: 'CONFIRMED' },
      },
    });
  });
  it('RLS hides foreign tenant and actor custody from a non-owner NOBYPASSRLS role', async () => {
    expect(await originals.load({ ...lookup, tenantId: randomUUID() })).toBeNull();
    expect(await originals.load({ ...lookup, actorUserId: randomUUID() })).toBeNull();
    const result = await runtime.query('select * from games.create_owner_associations');
    expect(result.rows).toHaveLength(0);
    const role = await admin.query(
      "select rolsuper,rolbypassrls from pg_roles where rolname='fin01_test_runtime'",
    );
    expect(role.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
  });
  it('permanent original rejects UPDATE and DELETE even for a same-tenant mutator', async () => {
    for (const command of [
      'update games.create_owner_associations set binding=binding',
      'delete from games.create_owner_associations',
    ]) {
      const client = await runtime.connect();
      try {
        await client.query('begin');
        await client.query("select set_config('app.tenant_id',$1,true)", [binding.tenantId]);
        await expect(
          client.query(`${command} where tenant_id=$1`, [binding.tenantId]),
        ).rejects.toMatchObject({ code: '23514' });
      } finally {
        await client.query('rollback');
        client.release();
      }
    }
    expect(await originals.load(lookup)).toEqual({ binding, recordedAt });
  });
  it('ties command key and Games request independently of a supplied binding hash', async () => {
    await expect(
      insert({ ...binding, keySha256: syntheticHash('forged-key') }),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(insert({ ...binding, gameId: randomUUID() })).rejects.toMatchObject({
      code: '23514',
    });
    await expect(insert(binding)).rejects.toMatchObject({ code: '23505' });
  });
  it('one game has one association even with another operation/key/intent', async () => {
    const nextKey = `fin01-game-fence-${randomUUID()}`;
    const next = {
      ...binding,
      operationId: randomUUID(),
      keySha256: syntheticHash(nextKey),
      intentSha256: syntheticHash(nextKey),
    };
    await seedCanonical(next, nextKey);
    await expect(insert(next)).rejects.toMatchObject({ code: '23505' });
  });
  it('permanent intent uniqueness survives terminal success and concurrent new keys', async () => {
    await admin.query(
      "update games.operations set state='SUCCEEDED',completed_at=now() where tenant_id=$1 and id=$2",
      [binding.tenantId, binding.operationId],
    );
    const candidates = await Promise.all(
      [1, 2].map(async () => {
        const rawKey = `fin01-intent-fence-${randomUUID()}`;
        const next = {
          ...binding,
          operationId: randomUUID(),
          gameId: randomUUID(),
          keySha256: syntheticHash(rawKey),
        };
        await seedCanonical(next, rawKey);
        return next;
      }),
    );
    const rejected = await Promise.allSettled(candidates.map(insert));
    expect(
      rejected.every(
        (result) =>
          result.status === 'rejected' && (result.reason as { code: string }).code === '23505',
      ),
    ).toBe(true);
    expect(await originals.load(lookup)).toEqual({ binding, recordedAt });
  });
  it('concurrent first association claims commit exactly one permanent intent owner', async () => {
    const intent = syntheticHash(randomUUID());
    const candidates = await Promise.all(
      [1, 2].map(async () => {
        const rawKey = `fin01-concurrent-${randomUUID()}`;
        const next = {
          ...binding,
          operationId: randomUUID(),
          gameId: randomUUID(),
          keySha256: syntheticHash(rawKey),
          intentSha256: intent,
        };
        await seedCanonical(next, rawKey);
        return next;
      }),
    );
    const results = await Promise.allSettled(candidates.map(insert));
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(
      results.filter(
        (result) =>
          result.status === 'rejected' && (result.reason as { code: string }).code === '23505',
      ),
    ).toHaveLength(1);
  });
  it('terminal pre-attempt rejection never releases the original intent', async () => {
    await admin.query(
      "update games.operations set state='FAILED',error_code='QUOTE_EXPIRED',completed_at=now() where tenant_id=$1 and id=$2",
      [binding.tenantId, binding.operationId],
    );
    const rawKey = `fin01-rejected-intent-${randomUUID()}`;
    const next = {
      ...binding,
      operationId: randomUUID(),
      gameId: randomUUID(),
      keySha256: syntheticHash(rawKey),
    };
    await seedCanonical(next, rawKey);
    await expect(insert(next)).rejects.toMatchObject({ code: '23505' });
    expect(await originals.load(lookup)).toEqual({ binding, recordedAt });
  });
  it('null current mapping revision stays unavailable', async () => {
    await admin.query(
      'update integration.external_entity_map set external_version=null where id=$1',
      [binding.mappings.slot.id],
    );
    try {
      expect((await resolver.resolve(lookup)).reason).toBe('MAPPING_UNAVAILABLE');
    } finally {
      await admin.query(
        'update integration.external_entity_map set external_version=$1 where id=$2',
        [binding.mappings.slot.revision, binding.mappings.slot.id],
      );
    }
  });
  it('refuses an association attached to the wrong commercial variant', async () => {
    const rawKey = `fin01-wrong-variant-${randomUUID()}`;
    const next = {
      ...binding,
      operationId: randomUUID(),
      gameId: randomUUID(),
      keySha256: syntheticHash(rawKey),
      intentSha256: syntheticHash(rawKey),
    };
    await seedCanonical(next, rawKey);
    await admin.query(
      "update games.games set payment_mode='NO_PAYMENT' where tenant_id=$1 and id=$2",
      [binding.tenantId, next.gameId],
    );
    await expect(insert(next)).rejects.toMatchObject({ code: '23514' });
  });
  it.each(['external_version', 'external_id', 'sync_status'] as const)(
    'actual Integration %s drift invalidates proof without rebinding',
    async (column) => {
      const changed =
        column === 'external_version'
          ? 'changed-v2'
          : column === 'sync_status'
            ? 'pending'
            : randomUUID();
      const row = await admin.query<Record<string, string>>(
        `select ${column} from integration.external_entity_map where id=$1`,
        [binding.mappings.actor.id],
      );
      try {
        await admin.query(`update integration.external_entity_map set ${column}=$1 where id=$2`, [
          changed,
          binding.mappings.actor.id,
        ]);
        expect((await resolver.resolve(lookup)).reason).toBe(
          column === 'sync_status' ? 'MAPPING_UNAVAILABLE' : 'MAPPING_CONFLICT',
        );
      } finally {
        await admin.query(`update integration.external_entity_map set ${column}=$1 where id=$2`, [
          row.rows[0]![column],
          binding.mappings.actor.id,
        ]);
      }
    },
  );
  it('an unspecified slot owner is unavailable rather than a convenient mapped source', async () => {
    await expect(createOwnerAssociationReader(runtime).load(lookup)).rejects.toMatchObject({
      reason: 'MAPPING_UNAVAILABLE',
    });
  });
  it('persisted foreign proof and duplicate owner records remain UNKNOWN', async () => {
    const foreign = rawSnapshot();
    foreign.receipts[0]!.binding.operationId = randomUUID();
    await saveSnapshot(foreign);
    expect((await resolver.resolve(lookup)).reason).toBe('EVIDENCE_CONFLICT');
    await saveSnapshot(rawSnapshot());
    await admin.query('insert into public.fin01_test_owner_snapshots values ($1,$2,$3,$4)', [
      binding.tenantId,
      binding.actorUserId,
      binding.operationId,
      rawSnapshot(),
    ]);
    expect((await resolver.resolve(lookup)).reason).toBe('OWNER_UNAVAILABLE');
    await admin.query(
      'delete from public.fin01_test_owner_snapshots where ctid in (select ctid from public.fin01_test_owner_snapshots where tenant_id=$1 and operation_id=$2 limit 1)',
      [binding.tenantId, binding.operationId],
    );
  });
  it('lost response and repeated concurrent reads leave all business records unchanged', async () => {
    const before = await admin.query(
      'select jsonb_agg(to_jsonb(a) order by operation_id) as rows from games.create_owner_associations a where tenant_id=$1',
      [binding.tenantId],
    );
    const counts = async () =>
      (
        await admin.query<{ games: string; operations: string; commands: string; outbox: string }>(
          `select
      (select count(*) from games.games where tenant_id=$1) as games,
      (select count(*) from games.operations where tenant_id=$1) as operations,
      (select count(*) from games.command_idempotency where tenant_id=$1) as commands,
      (select count(*) from audit.outbox_events where tenant_id=$1) as outbox`,
          [binding.tenantId],
        )
      ).rows;
    const beforeCounts = await counts();
    const lost = createFinancialProofResolver({
      originals,
      owner: {
        read: async () => {
          await owner.read({ binding });
          throw new Error('lost response');
        },
      },
    });
    expect((await lost.resolve(lookup)).reason).toBe('OWNER_UNAVAILABLE');
    const results = await Promise.all(Array.from({ length: 8 }, () => resolver.resolve(lookup)));
    expect(
      results.every((result) => result.state === 'EVIDENCE_CONSISTENT' && !result.canFinalize),
    ).toBe(true);
    expect(await counts()).toEqual(beforeCounts);
    const after = await admin.query(
      'select jsonb_agg(to_jsonb(a) order by operation_id) as rows from games.create_owner_associations a where tenant_id=$1',
      [binding.tenantId],
    );
    expect(after.rows).toEqual(before.rows);
  });
  it('migration ledger reapply preserves custody and incompatible direct SQL reapply refuses', async () => {
    const sql = await readFile(
      new URL('../migrations/0098_create_owner_associations.sql', import.meta.url),
      'utf8',
    );
    await expect(admin.query(sql)).rejects.toMatchObject({ code: '42P07' });
    expect(await originals.load(lookup)).toEqual({ binding, recordedAt });
  });
});
