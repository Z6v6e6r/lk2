import { quarterStationFixture } from '../../subscription-runtime-adapter/src/quarter-create-station.test-fixture.js';
import { Pool } from 'pg';
import { randomUUID, createHash } from 'node:crypto';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import {
  createQuarterCreateRepository,
  createQuarterStationFactRepository,
} from './game-quarter-create-repository.js';
import { createGameRepository, type CreateStoredGameInput } from './game-repository.js';
import {
  createLegacyGameImportRepository,
  type LegacyGameImportSnapshot,
} from './legacy-game-import-repository.js';
import { withTenantTransaction } from './connection.js';
import { quarterFixture } from '../../subscription-runtime-adapter/src/quarter-create.test-fixture.js';
function ci() {
  if (process.env.GITHUB_ACTIONS !== 'true' || process.env.APP_ENV !== 'ci') return undefined;
  if (!process.env.DATABASE_URL) throw new Error('QUARTER_CI_DATABASE_REQUIRED');
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
    throw new Error('QUARTER_CI_DATABASE_REQUIRED');
  return u.href;
}
const url = ci();
(url ? describe : describe.skip)('quarter CREATE existing disposable CI PostgreSQL', () => {
  const admin = new Pool({ connectionString: url, max: 2 }),
    tenantId = randomUUID(),
    foreign = randomUUID(),
    actorId = randomUUID(),
    stationId = randomUUID(),
    role = 'quarter_' + randomUUID().replaceAll('-', ''),
    password = randomUUID();
  let one: Pool,
    two: Pool,
    a: ReturnType<typeof createQuarterCreateRepository>,
    b: ReturnType<typeof createQuarterCreateRepository>;
  beforeAll(async () => {
    await admin.query(
      `create role ${role} login password '${password}' nosuperuser nobypassrls noinherit nocreatedb nocreaterole`,
    );
    await admin.query(
      `grant usage on schema identity,integration,locations,games,audit,eligibility to ${role}`,
    );
    await admin.query(
      `grant select,insert,update,delete on all tables in schema games,audit to ${role}`,
    );
    await admin.query(
      `grant select,update on identity.users,identity.tenants,locations.profiles,integration.external_entity_map,integration.legacy_game_merge_redirects,eligibility.canonical_levels to ${role}`,
    );
    const u = new URL(url!);
    u.username = role;
    u.password = password;
    one = new Pool({ connectionString: u.href, max: 2 });
    two = new Pool({ connectionString: u.href, max: 2 });
    a = createQuarterCreateRepository(one);
    b = createQuarterCreateRepository(two);
    await admin.query(
      "insert into identity.tenants(id,tenant_key,display_name) values($1,$2,'Synthetic quarter'),($3,$4,'Other quarter')",
      [tenantId, 'quarter-' + tenantId, foreign, 'quarter-' + foreign],
    );
    await withTenantTransaction(admin, tenantId, async (c) => {
      await c.query("insert into identity.users(tenant_id,id,status) values($1,$2,'ACTIVE')", [
        tenantId,
        actorId,
      ]);
      await c.query(
        "insert into locations.profiles(tenant_id,id,slug,title,created_by,updated_by,publication_status,published_at) values($1,$2,$4,'Synthetic station',$3,$3,'PUBLISHED',now())",
        [tenantId, stationId, actorId, stationId],
      );
    });
    expect(await a.ready()).toBe(true);
    expect((await one.query<{ pid: number }>('select pg_backend_pid() pid')).rows[0]!.pid).not.toBe(
      (await two.query<{ pid: number }>('select pg_backend_pid() pid')).rows[0]!.pid,
    );
  });
  afterAll(async () => {
    await Promise.all([one?.end(), two?.end()]);
    try {
      await withTenantTransaction(admin, tenantId, async (c) => {
        for (const table of [
          'games.quarter_create_attempts',
          'audit.outbox_events',
          'audit.audit_log',
          'games.scheduled_commands',
          'games.command_idempotency',
          'games.operations',
          'games.participations',
          'integration.legacy_game_roster_sync_state',
          'integration.legacy_game_merge_redirects',
          'games.games',
          'integration.legacy_game_player_bindings',
          'profile.level_history',
          'profile.user_summaries',
          'integration.external_entity_map',
          'locations.profiles',
          'identity.users',
        ])
          await c.query(`delete from ${table} where tenant_id=$1`, [tenantId]);
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
  let sequence = 0;
  async function fixture(expired = false) {
    await Promise.resolve();
    return quarterFixture({
      tenantId,
      userId: actorId,
      stationId,
      startsAt: new Date(Date.parse('2035-04-02T09:00:00Z') + sequence++ * 3600000).toISOString(),
      key: 'synthetic-quarter-' + randomUUID(),
      observedAt: new Date(Date.now() - (expired ? 61000 : 1000)).toISOString(),
    });
  }
  async function prepare(f: Awaited<ReturnType<typeof fixture>>) {
    await a.begin(f.scope, f.input, f.context, 'synthetic-begin');
    const token = await a.claimPreparation(f.scope);
    expect(token).not.toBeNull();
    return a.prepared(f.scope, token!, f.admission, 'synthetic-prepared');
  }
  function oldInput(f: Awaited<ReturnType<typeof fixture>>): CreateStoredGameInput {
    return {
      tenantId,
      actorUserId: actorId,
      idempotencyKey: f.key,
      requestHash: createHash('sha256')
        .update('old-' + f.key)
        .digest('hex'),
      correlationId: 'synthetic-old',
      title: 'Ordinary legacy',
      kind: 'FRIENDLY',
      visibility: 'PUBLIC',
      stationId,
      startsAt: f.input.startsAt,
      endsAt: new Date(Date.parse(f.input.startsAt) + 3600000).toISOString(),
      timezone: 'Europe/Moscow',
      capacity: 4,
      waitlistEnabled: false,
      paymentMode: 'NO_PAYMENT',
    };
  }
  it('same-key parallel preparation converges, changed input rejects and original ACK read survives', async () => {
    const f = await fixture(),
      r = await Promise.all([
        a.begin(f.scope, f.input, f.context, 'synthetic-a'),
        b.begin(f.scope, f.input, f.context, 'synthetic-b'),
      ]);
    expect(r[0]).toEqual(r[1]);
    await expect(
      b.begin(
        f.scope,
        { ...f.input, subscriptionId: randomUUID() },
        f.context,
        'synthetic-conflict',
      ),
    ).rejects.toMatchObject({ code: 'GAME_QUARTER_CREATE_KEY_CONFLICT' });
    expect((await b.read(f.scope))?.id).toBe(r[0].id);
  });
  it('absent refusal wins before late initial and old ordinary create', async () => {
    const f = await fixture(),
      terminal = await a.begin(f.scope, f.input, null, 'synthetic-refuse', true);
    expect(terminal.state).toBe('REFUSED_NOT_DISPATCHED');
    expect((await b.begin(f.scope, f.input, f.context, 'synthetic-late')).state).toBe(
      'REFUSED_NOT_DISPATCHED',
    );
    expect(await createGameRepository(two).create(oldInput(f))).toEqual({
      outcome: 'idempotency_conflict',
    });
    expect(await a.claimPreparation(f.scope)).toBeNull();
  });
  it('old ordinary create wins before absent proof and remains unchanged', async () => {
    const f = await fixture(),
      old = await createGameRepository(one).create(oldInput(f));
    expect(old.outcome).toBe('applied');
    await expect(b.begin(f.scope, f.input, null, 'synthetic-late', true)).rejects.toMatchObject({
      code: 'GAME_QUARTER_CREATE_KEY_CONFLICT',
    });
    expect(await a.read(f.scope)).toBeNull();
  });
  it('independent old-writer versus refusal race has exactly one authority', async () => {
    const f = await fixture(),
      results = await Promise.allSettled([
        createGameRepository(one).create(oldInput(f)),
        b.begin(f.scope, f.input, null, 'synthetic-race', true),
      ]),
      stored = await b.read(f.scope);
    if (stored) {
      expect(stored.state).toBe('REFUSED_NOT_DISPATCHED');
      expect(results[0]).toMatchObject({
        status: 'fulfilled',
        value: { outcome: 'idempotency_conflict' },
      });
    } else {
      expect(results[0]).toMatchObject({ status: 'fulfilled', value: { outcome: 'applied' } });
      expect(results[1].status).toBe('rejected');
    }
  });
  it('late initial versus absent terminal always preserves single immutable result', async () => {
    const f = await fixture();
    await Promise.all([
      a.begin(f.scope, f.input, f.context, 'synthetic-initial'),
      b.begin(f.scope, f.input, null, 'synthetic-reconcile', true),
    ]);
    const row = await a.read(f.scope);
    expect(['PREPARING', 'REFUSED_NOT_DISPATCHED']).toContain(row?.state);
    expect(await b.read(f.scope)).toEqual(row);
  });
  it('lease reclaim fences stale preparation ACK and refusal', async () => {
    const f = await fixture();
    await a.begin(f.scope, f.input, f.context, 'synthetic-begin');
    const old = (await a.claimPreparation(f.scope))!;
    await withTenantTransaction(admin, tenantId, (c) =>
      c.query(
        "update games.quarter_create_attempts set lease_until=clock_timestamp()-interval '1 second' where tenant_id=$1 and id=$2",
        [tenantId, f.receipt.operationId],
      ),
    );
    const fresh = (await b.claimPreparation(f.scope))!;
    expect(fresh).not.toBe(old);
    expect((await a.prepared(f.scope, old, f.admission, 'synthetic-late'))?.state).toBe(
      'PREPARING',
    );
    expect((await a.refusePreparation(f.scope, old, 'synthetic-late-refuse'))?.state).toBe(
      'PREPARING',
    );
    expect((await b.prepared(f.scope, fresh, f.admission, 'synthetic-fresh'))?.state).toBe(
      'PREPARED',
    );
  });
  it('dispatch claims serialize and stale completion cannot overwrite retry ownership', async () => {
    const f = await fixture();
    await prepare(f);
    const claims = await Promise.all([
      a.claimDispatch(f.scope, 'synthetic-one'),
      b.claimDispatch(f.scope, 'synthetic-two'),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect((await b.read(f.scope))?.state).toBe('DISPATCH_STARTED');
    await withTenantTransaction(admin, tenantId, (c) =>
      c.query(
        "update games.quarter_create_attempts set lease_until=clock_timestamp()-interval '1 second' where tenant_id=$1 and id=$2",
        [tenantId, f.receipt.operationId],
      ),
    );
    const fresh = (await b.claimDispatch(f.scope, 'synthetic-recovery'))!;
    expect(fresh.recoveryOnly).toBe(true);
    await a.complete(f.scope, claims.find(Boolean)!.token, f.receipt, false, 'synthetic-stale');
    expect((await a.read(f.scope))?.state).toBe('DISPATCH_STARTED');
    await b.complete(f.scope, fresh.token, f.receipt, false, 'synthetic-complete');
    const committed = await a.read(f.scope);
    expect(committed?.state).toBe('CONFIRMED');
    expect(await b.complete(f.scope, fresh.token, f.receipt, false, 'synthetic-lost-ack')).toEqual(
      committed,
    );
    expect(await a.project(f.scope, false)).toBeNull();
  });
  it('expiry versus claim never dispatches expired original capsule; reads do not expire', async () => {
    const f = await fixture(true);
    await prepare(f);
    expect((await b.read(f.scope))?.state).toBe('PREPARED');
    const [claim] = await Promise.all([
      a.claimDispatch(f.scope, 'synthetic-claim'),
      b.expirePrepared(f.scope, 'synthetic-expire'),
    ]);
    expect(claim).toBeNull();
    expect((await a.read(f.scope))?.state).toBe('EXPIRED_NOT_DISPATCHED');
  });
  it('outbox failure rolls back journal and old-writer fence atomically', async () => {
    const f = await fixture();
    await admin.query(`revoke insert on audit.outbox_events from ${role}`);
    try {
      await expect(a.begin(f.scope, f.input, f.context, 'synthetic-fail')).rejects.toThrow();
      expect(await b.read(f.scope)).toBeNull();
      const rows = await withTenantTransaction(admin, tenantId, (c) =>
        c.query('select id from games.command_idempotency where tenant_id=$1 and id=$2', [
          tenantId,
          f.receipt.operationId,
        ]),
      );
      expect(rows.rowCount).toBe(0);
    } finally {
      await admin.query(`grant insert on audit.outbox_events to ${role}`);
    }
  });
  async function imported(f: Awaited<ReturnType<typeof fixture>>) {
    // Imported player association and private Viva profile use distinct namespaces.
    const playerAssociationId = createHash('sha256')
      .update('synthetic-quarter-player:' + tenantId + ':' + actorId)
      .digest('hex');
    await withTenantTransaction(admin, tenantId, async (c) => {
      await c.query(
        `insert into integration.external_entity_map(tenant_id,id,external_system,entity_type,internal_id,external_id,external_version,sync_status,last_synced_at) values($1,$2,'VIVA','viva_profile',$3,$4,'v1','synced',now()) on conflict do nothing`,
        [tenantId, f.context.providerMappingId, actorId, f.context.providerClientId],
      );
      for (const [type, id, external] of [
        ['game_station', stationId, 'synthetic-station'],
        ['game_court', f.input.courtId, 'synthetic-court'],
      ])
        await c.query(
          `insert into integration.external_entity_map(tenant_id,external_system,entity_type,internal_id,external_id,external_version,sync_status,last_synced_at) values($1,'LK_LEGACY_SNAPSHOT',$2,$3,$4,'v1','synced',now()) on conflict do nothing`,
          [tenantId, type, id, external],
        );
    });
    const snapshot: LegacyGameImportSnapshot = {
      externalId: f.receipt.providerExerciseId,
      externalVersion: 'v1',
      vivaExerciseExternalId: f.receipt.providerExerciseId,
      title: 'Synthetic imported game',
      kind: 'FRIENDLY',
      visibility: 'PUBLIC',
      cancelled: false,
      startsAt: f.input.startsAt,
      endsAt: f.admission.preparation.target.endsAt,
      timezone: 'Europe/Moscow',
      station: {
        externalId: 'synthetic-station',
        name: 'Synthetic station',
        courtExternalId: 'synthetic-court',
        courtName: 'Synthetic court',
      },
      capacity: 4,
      waitlistEnabled: false,
      paymentMode: 'SPLIT',
      levelFrom: null,
      levelTo: null,
      organizerExternalId: playerAssociationId,
      participants: [
        {
          externalId: playerAssociationId,
          displayName: 'Synthetic organizer',
          level: null,
          levelValue: null,
          role: 'ORGANIZER',
          paymentState: 'PAID',
        },
      ],
    };
    const r = await createLegacyGameImportRepository(admin).importSnapshots({
      tenantKey: 'quarter-' + tenantId,
      snapshots: [snapshot],
      correlationId: 'synthetic-import',
      participantUserBindings: [
        { externalId: playerAssociationId, userId: actorId, proofKind: 'VIVA_PROFILE' },
      ],
    });
    return [...r.imported, ...r.existing][0]!.gameId;
  }
  it.each(['before', 'after'] as const)(
    'canonical actual importer %s receipt converges without another game/roster writer',
    async (order) => {
      const f = await fixture();
      await prepare(f);
      let gameId: string | undefined;
      if (order === 'before') gameId = await imported(f);
      const claim = (await a.claimDispatch(f.scope, 'synthetic-dispatch'))!;
      await a.complete(f.scope, claim.token, f.receipt, false, 'synthetic-receipt');
      if (order === 'after') {
        expect(await b.project(f.scope, false)).toBeNull();
        gameId = await imported(f);
      }
      expect(await a.project(f.scope, true)).toBe(gameId);
      expect(await b.project(f.scope, false)).toBe(gameId);
      expect((await b.read(f.scope))?.gameId).toBe(gameId);
      const count = await withTenantTransaction(admin, tenantId, (c) =>
        c.query<{ n: number }>(
          'select count(*)::int n from games.participations where tenant_id=$1 and game_id=$2',
          [tenantId, gameId],
        ),
      );
      expect(count.rows[0]!.n).toBe(1);
      await withTenantTransaction(admin, tenantId, (c) =>
        c.query(
          "update integration.external_entity_map set sync_status='failed',sync_error_code='SYNTHETIC_FAILURE' where tenant_id=$1 and external_system='VIVA' and entity_type='exercise' and external_id=$2",
          [tenantId, f.receipt.providerExerciseId],
        ),
      );
      expect(await b.project(f.scope, false)).toBeNull();
    },
  );
  it('FORCE RLS denies cross-tenant reads and changed actor/key cannot read custody', async () => {
    const f = await fixture();
    await a.begin(f.scope, f.input, null, 'synthetic-terminal', true);
    expect(
      (
        await withTenantTransaction(one, foreign, (c) =>
          c.query('select id from games.quarter_create_attempts where tenant_id=$1', [tenantId]),
        )
      ).rowCount,
    ).toBe(0);
    expect(await b.read({ ...f.scope, userId: randomUUID() })).toBeNull();
    expect(await b.read({ ...f.scope, keySha256: 'sha256:' + 'a'.repeat(64) })).toBeNull();
  });
  async function adopted(f: Awaited<ReturnType<typeof fixture>>, blocked = false) {
    const r = createQuarterCreateRepository(one, { stationMembershipEnabled: true });
    await r.begin(f.scope, f.input, f.context, 'synthetic-station-begin');
    const token = (await r.claimPreparation(f.scope))!;
    await r.pinStationPreparation(f.scope, token, f.admission);
    const marker = await quarterStationFixture(f.admission, blocked);
    await r.prepared(f.scope, token, f.admission, 'synthetic-station-prepared', marker);
    return r;
  }
  it('adopted marker fences old prepared/dispatch/completion; atomic confirmed fact survives response loss', async () => {
    const f = await fixture(),
      r = createQuarterCreateRepository(one, { stationMembershipEnabled: true });
    expect(await r.ready()).toBe(true);
    await r.begin(f.scope, f.input, f.context, 'synthetic-adopt');
    const token = (await r.claimPreparation(f.scope))!;
    await expect(b.prepared(f.scope, token, f.admission, 'synthetic-old')).rejects.toThrow();
    expect(await b.claimDispatch(f.scope, 'synthetic-old')).toBeNull();
    await r.pinStationPreparation(f.scope, token, f.admission);
    await expect(
      withTenantTransaction(two, tenantId, (c) =>
        c.query(
          `update games.quarter_create_attempts set state='PREPARED',admission=$3::jsonb,admission_hash=$4,expires_at=$5,lease_token=null,lease_until=null where tenant_id=$1 and id=$2`,
          [
            tenantId,
            f.receipt.operationId,
            JSON.stringify(f.admission),
            f.receipt.admissionRequestSha256,
            f.admission.preparation.expiresAt,
          ],
        ),
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await r.prepared(
      f.scope,
      token,
      f.admission,
      'synthetic-settle',
      await quarterStationFixture(f.admission),
    );
    const claim = (await r.claimDispatch(f.scope, 'synthetic-dispatch'))!;
    await expect(
      withTenantTransaction(two, tenantId, (c) =>
        c.query(
          `update games.quarter_create_attempts set state='CONFIRMED',receipt=$3::jsonb,lease_token=null,lease_until=null where tenant_id=$1 and id=$2`,
          [tenantId, f.receipt.operationId, JSON.stringify(f.receipt)],
        ),
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await r.complete(f.scope, claim.token, f.receipt, false, 'synthetic-complete');
    const readback = await b.read(f.scope);
    expect(readback?.stationMembership?.outcome).toBe('CONFIRMED_FACT');
    await b.complete(f.scope, claim.token, f.receipt, false, 'synthetic-lost-ack');
    const events = await withTenantTransaction(two, tenantId, (c) =>
      c.query<{ id: string; payload: { generationId: string } }>(
        "select id,payload from audit.outbox_events where tenant_id=$1 and aggregate_id=$2 and event_type='game.quarter-create.organizer-confirmed.v1'",
        [tenantId, f.receipt.operationId],
      ),
    );
    expect(events.rows).toHaveLength(1);
    expect(JSON.stringify(events.rows)).not.toContain('synthetic-exercise');
    const e = events.rows[0]!,
      input = {
        tenantId,
        eventId: e.id,
        operationId: f.receipt.operationId,
        draftId: f.request.target.draftId,
        userId: actorId,
        generationId: e.payload.generationId,
      };
    const loader = createQuarterStationFactRepository(two),
      fact = await loader.loadQuarterConfirmedFact(input);
    expect(fact.request.confirmation.kind).toBe('GAME_CREATE_ORGANIZER');
    expect(fact.request.confirmation.activityId).toBe(f.request.target.draftId);
    for (const altered of [
      { ...input, tenantId: foreign },
      { ...input, userId: randomUUID() },
      { ...input, generationId: randomUUID() },
      { ...input, draftId: randomUUID() },
    ])
      await expect(loader.loadQuarterConfirmedFact(altered)).rejects.toThrow();
  });
  it('independent preparation claims serialize; handled failure releases only original lease, stale ACK cannot settle', async () => {
    const f = await fixture(),
      r = createQuarterCreateRepository(one, { stationMembershipEnabled: true });
    await r.begin(f.scope, f.input, f.context, 'synthetic-begin');
    const claims = await Promise.all([r.claimPreparation(f.scope), b.claimPreparation(f.scope)]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const old = claims.find(Boolean)!;
    await r.pinStationPreparation(f.scope, old, f.admission);
    await b.releasePreparation(f.scope, old);
    const next = (await b.claimPreparation(f.scope))!;
    expect(next).not.toBe(old);
    await r.releasePreparation(f.scope, old);
    expect((await b.read(f.scope))?.leaseToken).toBe(next);
    await r.prepared(
      f.scope,
      old,
      f.admission,
      'synthetic-stale',
      await quarterStationFixture(f.admission),
    );
    expect((await b.read(f.scope))?.state).toBe('PREPARING');
    await b.prepared(
      f.scope,
      next,
      f.admission,
      'synthetic-current',
      await quarterStationFixture(f.admission),
    );
    expect((await r.read(f.scope))?.state).toBe('PREPARED');
  });
  it('expired original INTENT races late admission ACK without new capsule or dispatch', async () => {
    const f = await fixture(true),
      r = createQuarterCreateRepository(one, { stationMembershipEnabled: true });
    await r.begin(f.scope, f.input, f.context, 'synthetic-begin');
    const token = (await r.claimPreparation(f.scope))!;
    await r.pinStationPreparation(f.scope, token, f.admission);
    await Promise.all([
      r.expireStationIntent(f.scope, 'synthetic-expire'),
      b.prepared(
        f.scope,
        token,
        f.admission,
        'synthetic-late',
        await quarterStationFixture(f.admission),
      ),
    ]);
    const a = await r.read(f.scope);
    expect(a?.state).toBe('EXPIRED_NOT_DISPATCHED');
    expect(a?.admission).toEqual(f.admission);
    expect(a?.stationMembership?.outcome).toBe('INTENT');
    expect(await b.claimDispatch(f.scope, 'synthetic-never')).toBeNull();
  });
  it('explicit NO_ENROLLMENT confirms original operation with no enrollment event; null history never adopts', async () => {
    const f = await fixture(),
      r = await adopted(f, true),
      claim = (await r.claimDispatch(f.scope, 'synthetic-dispatch'))!;
    await r.complete(f.scope, claim.token, f.receipt, false, 'synthetic-blocked');
    expect((await b.read(f.scope))?.stationMembership?.outcome).toBe('CONFIRMED_FACT');
    const events = await withTenantTransaction(two, tenantId, (c) =>
      c.query(
        "select id from audit.outbox_events where tenant_id=$1 and aggregate_id=$2 and event_type='game.quarter-create.organizer-confirmed.v1'",
        [tenantId, f.receipt.operationId],
      ),
    );
    expect(events.rowCount).toBe(0);
    const old = await fixture();
    await a.begin(old.scope, old.input, old.context, 'synthetic-legacy');
    await r.begin(old.scope, old.input, old.context, 'synthetic-no-adopt');
    const token = (await a.claimPreparation(old.scope))!;
    expect(await r.pinStationPreparation(old.scope, token, old.admission)).toBeNull();
    expect((await r.read(old.scope))?.stationMembership).toBeNull();
  });
  it('corrupt stored hash fails closed on reload and outbox insertion failure rolls back completion', async () => {
    const f = await fixture(),
      r = await adopted(f),
      claim = (await r.claimDispatch(f.scope, 'synthetic-dispatch'))!;
    await admin.query(`revoke insert on audit.outbox_events from ${role}`);
    try {
      await expect(
        r.complete(f.scope, claim.token, f.receipt, false, 'synthetic-rollback'),
      ).rejects.toThrow();
      expect((await b.read(f.scope))?.state).toBe('DISPATCH_STARTED');
      expect((await b.read(f.scope))?.receipt).toBeNull();
    } finally {
      await admin.query(`grant insert on audit.outbox_events to ${role}`);
    }
    await r.complete(f.scope, claim.token, f.receipt, false, 'synthetic-retry');
    await withTenantTransaction(admin, tenantId, (c) =>
      c.query(
        `update games.quarter_create_attempts set station_membership=jsonb_set(station_membership,'{receiptSha256}',to_jsonb($3::text)) where tenant_id=$1 and id=$2`,
        [tenantId, f.receipt.operationId, 'sha256:' + 'b'.repeat(64)],
      ),
    );
    await expect(b.read(f.scope)).rejects.toThrow();
  });
  it('adopted pre-prepare refusal and compensated owner rejection retain terminal marker without enrollment', async () => {
    const f = await fixture(),
      r = createQuarterCreateRepository(one, { stationMembershipEnabled: true });
    await r.begin(f.scope, f.input, f.context, 'synthetic-before-prepare');
    const lease = (await r.claimPreparation(f.scope))!;
    await r.refusePreparation(f.scope, lease, 'synthetic-refused');
    expect((await b.read(f.scope))?.stationMembership?.outcome).toBe('PENDING_ADMISSION');
    expect((await b.read(f.scope))?.state).toBe('REFUSED_NOT_DISPATCHED');
    const g = await fixture();
    await adopted(g);
    const claim = (await r.claimDispatch(g.scope, 'synthetic-dispatch'))!;
    await r.complete(
      g.scope,
      claim.token,
      {
        schemaVersion: 1,
        outcome: 'REJECTED',
        operationId: g.receipt.operationId,
        admissionRequestSha256: g.receipt.admissionRequestSha256,
        actor: g.receipt.actor,
        target: g.receipt.target,
        reason: 'PROVIDER_REJECTED',
        providerStatusCode: 422,
        providerRejectedAt: g.receipt.confirmedAt,
        rejectedAt: g.receipt.confirmedAt,
        entitlement: {
          subscriptionInstanceId: g.receipt.entitlement.subscriptionInstanceId,
          usageOperationId: g.receipt.entitlement.usageOperationId,
          operationState: 'FAILED',
          compensationState: 'APPLIED',
          releaseReason: 'PROVIDER_REJECTED',
          providerBookingId: null,
        },
      },
      true,
      'synthetic-compensated',
    );
    expect((await b.read(g.scope))?.state).toBe('REJECTED');
    expect((await b.read(g.scope))?.stationMembership?.outcome).toBe('OWNER_ADMISSION');
    const events = await withTenantTransaction(two, tenantId, (c) =>
      c.query(
        "select id from audit.outbox_events where tenant_id=$1 and aggregate_id=any($2::uuid[]) and event_type='game.quarter-create.organizer-confirmed.v1'",
        [tenantId, [f.receipt.operationId, g.receipt.operationId]],
      ),
    );
    expect(events.rowCount).toBe(0);
  });
});
