import { randomUUID } from 'node:crypto';

import {
  beginLegacyGameReminderSourceCycle,
  completeLegacyGameReminderSourceCycle,
  createLegacyGameImportRepository,
  readGameStartReminderTarget,
  readPreparingLegacyGameStartReminderTarget,
  withTenantTransaction,
} from '@phub/database';
import { MongoClient } from 'mongodb';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { LegacyGamesMongoAdapter } from './index.js';

function ciTargets(): { readonly postgres: string; readonly mongo: string } | undefined {
  if (process.env.GITHUB_ACTIONS !== 'true' || process.env.APP_ENV !== 'ci') return undefined;
  const postgres = process.env.DATABASE_URL;
  const mongo = process.env.LEGACY_GAME_REMINDER_CI_MONGODB_URI;
  if (!postgres || !mongo) return undefined;
  const pgUrl = new URL(postgres);
  const mongoUrl = new URL(mongo);
  if (
    !['postgres:', 'postgresql:'].includes(pgUrl.protocol) ||
    !['localhost', '127.0.0.1'].includes(pgUrl.hostname) ||
    pgUrl.username !== 'phub' ||
    pgUrl.password !== 'ci-password' ||
    pgUrl.pathname !== '/phub' ||
    pgUrl.port !== '5432' ||
    pgUrl.search ||
    pgUrl.hash ||
    mongoUrl.protocol !== 'mongodb:' ||
    !['localhost', '127.0.0.1'].includes(mongoUrl.hostname) ||
    mongoUrl.port !== '27017' ||
    mongoUrl.username ||
    mongoUrl.password ||
    mongoUrl.pathname !== '/' ||
    mongoUrl.search !== '?directConnection=true' ||
    mongoUrl.hash
  )
    throw new Error('GAME_REMINDER_CI_TARGET_INVALID');
  return { postgres, mongo };
}

const targets = ciTargets();
const physical = targets ? describe.sequential : describe.skip;

physical('isolated legacy game reminder Mongo to PostgreSQL source fence', () => {
  const tenantId = randomUUID();
  const tenantKey = `reminder-${tenantId}`;
  const userId = randomUUID();
  const databaseName = `game_reminder_${tenantId.replaceAll('-', '')}`;
  const sourceGameId = `synthetic-${randomUUID()}`;
  const sourcePlayerId = `player-${randomUUID()}`;
  const postgres = new Pool({ connectionString: targets?.postgres, max: 2 });
  const mongo = new MongoClient(targets?.mongo ?? 'mongodb://127.0.0.1:27017');
  const now = new Date();
  const startsAt = new Date(now.getTime() + 2 * 3_600_000);
  const endsAt = new Date(now.getTime() + 3 * 3_600_000);
  const source = new LegacyGamesMongoAdapter({
    uri: targets?.mongo ?? 'mongodb://127.0.0.1:27017/?directConnection=true',
    dbName: databaseName,
    timeoutMs: 5_000,
    maxAttempts: 1,
    consistency: 'reminder-primary',
  });
  let gameId = '';

  async function sourceCycle(at: Date) {
    const windowTo = new Date(at.getTime() + 7 * 86_400_000);
    const admission = await beginLegacyGameReminderSourceCycle(postgres, {
      tenantKey,
      generationId: randomUUID(),
      now: at,
      trackedLimit: 20,
    });
    const window = await source.readReminderWindow({
      from: at.toISOString(),
      to: windowTo.toISOString(),
      limit: 20,
    });
    const exact = await source.readByExternalIds({
      externalIds: [...new Set(admission.tracked.flatMap((target) => target.externalIds))],
      limit: 20,
    });
    const snapshots = [
      ...new Map([...window, ...exact].map((item) => [item.externalId, item])).values(),
    ];
    return completeLegacyGameReminderSourceCycle(postgres, {
      admission,
      snapshots,
      now: at,
      windowTo,
      beforeFinalize: () => Promise.resolve(),
    });
  }

  async function target(at: Date) {
    return withTenantTransaction(postgres, tenantId, (client) =>
      readGameStartReminderTarget(client, {
        tenantId,
        gameId,
        now: at,
        maxLegacySourceAgeMs: 600_000,
      }),
    );
  }

  async function genericCounts() {
    const tables = [
      'identity.users',
      'profile.user_summaries',
      'games.games',
      'games.participations',
      'audit.outbox_events',
    ];
    const counts: Record<string, number> = {};
    for (const table of tables) {
      const count = await postgres.query<{ count: string }>(
        `select count(*)::text count from ${table} where tenant_id=$1`,
        [tenantId],
      );
      counts[table] = Number(count.rows[0]?.count ?? 0);
    }
    return counts;
  }

  async function seedHistoricalTerminalSources(): Promise<void> {
    await postgres.query(
      `insert into games.games(
         tenant_id,id,organizer_user_id,title,kind,visibility,lifecycle_state,station_id,
         starts_at,ends_at,timezone,capacity,payment_mode
       ) select $1,md5('terminal-game-' || item)::uuid,$2,
                'Historical terminal reminder ' || item,'FRIENDLY','PRIVATE','SCHEDULED',
                md5('terminal-station-' || item)::uuid,
                now()+interval '30 days',now()+interval '30 days 1 hour',
                'Europe/Moscow',4,'NO_PAYMENT'
           from generate_series(1,201) item`,
      [tenantId, userId],
    );
    await postgres.query(
      `insert into integration.external_entity_map(
         tenant_id,external_system,entity_type,internal_id,external_id,external_version,
         last_synced_at,sync_status
       ) select $1,'LK_LEGACY_SNAPSHOT','game',md5('terminal-game-' || item)::uuid,
                'terminal-source-' || item,md5(item::text) || md5(item::text),now(),'synced'
           from generate_series(1,201) item`,
      [tenantId],
    );
    await postgres.query(
      `insert into integration.legacy_game_roster_sync_state(
         tenant_id,game_id,source_external_version,last_synced_game_revision,mode
       ) select $1,md5('terminal-game-' || item)::uuid,
                md5(item::text) || md5(item::text),1,'MIRROR'
           from generate_series(1,201) item`,
      [tenantId],
    );
    await postgres.query(
      `insert into notifications.legacy_game_reminder_sources(
         tenant_id,game_id,source_revision,source_external_version,source_updated_at,
         source_checked_at,generation_id,source_state,fingerprint,title,starts_at,ends_at,
         timezone,location_name
       ) select $1,md5('terminal-game-' || item)::uuid,1,
                md5(item::text) || md5(item::text),now(),now(),$2,'MISSING',
                md5('fingerprint-' || item) || md5('fingerprint-' || item),
                'Historical terminal reminder ' || item,
                now()+interval '30 days',now()+interval '30 days 1 hour',
                'Europe/Moscow','Historical club'
           from generate_series(1,201) item`,
      [tenantId, randomUUID()],
    );
  }

  beforeAll(async () => {
    await mongo.connect();
    await postgres.query(
      `insert into identity.tenants(id,tenant_key,display_name)
       values($1,$2,'Synthetic game reminder source')`,
      [tenantId, tenantKey],
    );
    await postgres.query(`insert into identity.users(id,tenant_id) values($1,$2)`, [
      userId,
      tenantId,
    ]);
    await postgres.query(
      `insert into profile.user_summaries(tenant_id,user_id,display_name,phone_e164)
       values($1,$2,'Existing verified admin','+79990000001')`,
      [tenantId, userId],
    );
    await mongo
      .db(databaseName)
      .collection('lk_games')
      .insertOne({
        id: sourceGameId,
        status: 'PAID',
        updatedAt: new Date(now.getTime() - 60_000).toISOString(),
        organizer: {
          id: sourcePlayerId,
          name: 'Existing verified admin',
          status: 'PAID',
        },
        participants: [{ id: sourcePlayerId, name: 'Existing verified admin', status: 'PAID' }],
        settings: { isPrivate: true, ratingGame: false },
        metadata: { gameFormat: 'doubles', gameTitle: 'Synthetic private reminder game' },
        booking: {
          studioId: 'synthetic-station',
          studioName: 'Synthetic club',
          timeFromIso: startsAt.toISOString(),
          timeToIso: endsAt.toISOString(),
        },
      });
    const [snapshot] = await source.readReminderWindow({
      from: now.toISOString(),
      to: new Date(now.getTime() + 7 * 86_400_000).toISOString(),
      limit: 20,
    });
    if (!snapshot) throw new Error('GAME_REMINDER_BOOTSTRAP_SNAPSHOT_MISSING');
    const repository = createLegacyGameImportRepository(postgres);
    const imported = await repository.importSnapshots({
      tenantKey,
      snapshots: [snapshot],
      correlationId: `reminder-bootstrap-${randomUUID()}`,
      participantUserBindings: [
        {
          externalId: snapshot.participants[0]!.externalId,
          sourcePlayerAssociationId: snapshot.participants[0]!.externalId,
          userId,
          proofKind: 'VIVA_PROFILE',
        },
      ],
      now,
    });
    gameId = imported.imported[0]?.gameId ?? imported.existing[0]!.gameId;
    // The reminder-only pilot starts from an already admitted MIRROR game. Establish that exact
    // precondition directly: the generic roster synchronizer is outside this source-cycle test and
    // may legitimately quarantine multi-alias fixture mappings for operator reconciliation.
    await withTenantTransaction(postgres, tenantId, async (client) => {
      const sourceExternalIds = [snapshot.externalId, ...(snapshot.externalAliases ?? [])];
      for (const externalId of sourceExternalIds) {
        await client.query(
          `insert into integration.external_entity_map(
             tenant_id,external_system,entity_type,internal_id,external_id,external_version,
             last_synced_at,sync_status,sync_error_code
           ) values($1,'LK_LEGACY_SNAPSHOT','game',$2,$3,$4,now(),'synced',null)
           on conflict(tenant_id,external_system,entity_type,external_id) do update set
             internal_id=excluded.internal_id,external_version=excluded.external_version,
             last_synced_at=excluded.last_synced_at,sync_status='synced',sync_error_code=null`,
          [tenantId, gameId, externalId, snapshot.externalVersion],
        );
      }
      const admitted = await client.query(
        `insert into integration.legacy_game_roster_sync_state(
           tenant_id,game_id,source_external_version,last_synced_game_revision,mode
         ) select $1,$2,$3,revision,'MIRROR'
             from games.games where tenant_id=$1 and id=$2`,
        [tenantId, gameId, snapshot.externalVersion],
      );
      expect(admitted.rowCount).toBe(1);
      const resolvable = await client.query<{ game_id: string }>(
        `select distinct mapping.internal_id game_id
           from integration.external_entity_map mapping
           join integration.legacy_game_roster_sync_state mirror
             on mirror.tenant_id=mapping.tenant_id and mirror.game_id=mapping.internal_id
            and mirror.mode='MIRROR'
          where mapping.tenant_id=$1 and mapping.external_system='LK_LEGACY_SNAPSHOT'
            and mapping.entity_type='game' and mapping.external_id=any($2::text[])
            and not exists(
              select 1 from integration.legacy_game_merge_redirects redirect
               where redirect.tenant_id=mapping.tenant_id
                 and redirect.source_game_id=mapping.internal_id
            )`,
        [tenantId, sourceExternalIds],
      );
      expect(resolvable.rows).toEqual([{ game_id: gameId }]);
    });
    await seedHistoricalTerminalSources();
  }, 30_000);

  afterAll(async () => {
    await mongo
      .db(databaseName)
      .dropDatabase()
      .catch(() => undefined);
    await mongo.close();
    await postgres.end();
  });

  it('does not write generic game/profile/identity/outbox state and invalidates every source state', async () => {
    const before = await genericCounts();
    const first = await sourceCycle(now);
    expect(first).toMatchObject({ changedGameIds: [gameId], missing: 0 });
    await expect(target(now)).resolves.toMatchObject({
      state: 'READY',
      target: { recipientUserIds: [userId] },
    });
    const bounded = await beginLegacyGameReminderSourceCycle(postgres, {
      tenantKey,
      generationId: randomUUID(),
      now: new Date(now.getTime() + 30_000),
      trackedLimit: 20,
    });
    expect(bounded.tracked).toHaveLength(1);

    const interruptedAt = new Date(now.getTime() + 60_000);
    await beginLegacyGameReminderSourceCycle(postgres, {
      tenantKey,
      generationId: randomUUID(),
      now: interruptedAt,
      trackedLimit: 20,
    });
    await expect(target(interruptedAt)).resolves.toEqual({ state: 'SOURCE_STALE' });
    await sourceCycle(new Date(now.getTime() + 120_000));

    await mongo
      .db(databaseName)
      .collection('lk_games')
      .updateOne(
        { id: sourceGameId },
        {
          $set: {
            updatedAt: new Date(now.getTime() + 180_000).toISOString(),
            'booking.timeFromIso': new Date(now.getTime() + 9 * 86_400_000).toISOString(),
            'booking.timeToIso': new Date(now.getTime() + 9 * 86_400_000 + 3_600_000).toISOString(),
          },
        },
      );
    await sourceCycle(new Date(now.getTime() + 180_000));
    await expect(target(new Date(now.getTime() + 180_000))).resolves.toEqual({
      state: 'GAME_UNAVAILABLE',
    });

    await mongo
      .db(databaseName)
      .collection('lk_games')
      .updateOne(
        { id: sourceGameId },
        {
          $set: {
            status: 'CANCELLED',
            updatedAt: new Date(now.getTime() + 240_000).toISOString(),
            'booking.timeFromIso': startsAt.toISOString(),
            'booking.timeToIso': endsAt.toISOString(),
          },
        },
      );
    await sourceCycle(new Date(now.getTime() + 240_000));
    await expect(target(new Date(now.getTime() + 240_000))).resolves.toEqual({
      state: 'GAME_UNAVAILABLE',
    });

    await mongo
      .db(databaseName)
      .collection('lk_games')
      .updateOne(
        { id: sourceGameId },
        {
          $set: {
            status: 'PAID',
            updatedAt: new Date(now.getTime() + 270_000).toISOString(),
          },
        },
      );
    await sourceCycle(new Date(now.getTime() + 270_000));
    await expect(target(new Date(now.getTime() + 270_000))).resolves.toMatchObject({
      state: 'READY',
    });

    await mongo.db(databaseName).collection('lk_games').deleteOne({ id: sourceGameId });
    const missing = await sourceCycle(new Date(now.getTime() + 300_000));
    expect(missing.missing).toBe(1);
    await expect(target(new Date(now.getTime() + 300_000))).resolves.toEqual({
      state: 'GAME_UNAVAILABLE',
    });
    await expect(genericCounts()).resolves.toEqual(before);
  }, 30_000);

  it('holds normal dispatch until every preparing-generation refresh commits without deadlock', async () => {
    const atomicAt = new Date(now.getTime() + 360_000);
    await mongo
      .db(databaseName)
      .collection('lk_games')
      .insertOne({
        id: sourceGameId,
        status: 'PAID',
        updatedAt: atomicAt.toISOString(),
        organizer: { id: sourcePlayerId, name: 'Existing verified admin', status: 'PAID' },
        participants: [{ id: sourcePlayerId, name: 'Existing verified admin', status: 'PAID' }],
        settings: { isPrivate: true, ratingGame: false },
        metadata: { gameFormat: 'doubles', gameTitle: 'Synthetic private reminder game' },
        booking: {
          studioId: 'synthetic-station',
          studioName: 'Synthetic club',
          timeFromIso: startsAt.toISOString(),
          timeToIso: endsAt.toISOString(),
        },
      });
    const generationId = randomUUID();
    const admission = await beginLegacyGameReminderSourceCycle(postgres, {
      tenantKey,
      generationId,
      now: atomicAt,
      trackedLimit: 20,
    });
    const windowTo = new Date(atomicAt.getTime() + 7 * 86_400_000);
    const snapshots = await source.readReminderWindow({
      from: atomicAt.toISOString(),
      to: windowTo.toISOString(),
      limit: 20,
    });
    let prepared!: () => void;
    let release!: () => void;
    const preparedPromise = new Promise<void>((resolve) => {
      prepared = resolve;
    });
    const releasePromise = new Promise<void>((resolve) => {
      release = resolve;
    });
    const completion = completeLegacyGameReminderSourceCycle(postgres, {
      admission,
      snapshots,
      now: atomicAt,
      windowTo,
      beforeFinalize: async (client, result) => {
        expect(result.refreshGameIds).toEqual([gameId]);
        await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [
          `scenario-target:${tenantId}:${gameId}`,
        ]);
        await expect(
          readPreparingLegacyGameStartReminderTarget(client, {
            tenantId,
            gameId,
            generationId,
            now: atomicAt,
            maxLegacySourceAgeMs: 600_000,
          }),
        ).resolves.toMatchObject({ state: 'READY' });
        prepared();
        await releasePromise;
      },
    });
    await Promise.race([
      preparedPromise,
      completion.then(() => {
        throw new Error('GAME_REMINDER_FINALIZED_BEFORE_BARRIER');
      }),
    ]);
    let providerSettled = false;
    const providerRead = withTenantTransaction(postgres, tenantId, async (client) => {
      await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [
        `scenario-admin:${tenantId}`,
      ]);
      return readGameStartReminderTarget(client, {
        tenantId,
        gameId,
        now: atomicAt,
        maxLegacySourceAgeMs: 600_000,
      });
    }).finally(() => {
      providerSettled = true;
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(providerSettled).toBe(false);
    } finally {
      release();
    }
    await expect(completion).resolves.toMatchObject({ generationId });
    await expect(providerRead).resolves.toMatchObject({ state: 'READY' });
  }, 30_000);
});
