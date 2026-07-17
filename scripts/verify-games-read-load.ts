import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';

import { createDatabasePool, createGameRepository, withTenantTransaction } from '@phub/database';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required');
const databaseName = new URL(connectionString).pathname.replace(/^\//, '');
if (!databaseName.endsWith('_verify')) {
  throw new Error('Games read load verification requires an isolated *_verify database');
}

function boundedInteger(name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = process.env[name];
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

const cardCount = boundedInteger('GAMES_LOAD_CARD_COUNT', 10_000, 1_000, 50_000);
const iterations = boundedInteger('GAMES_LOAD_ITERATIONS', 200, 20, 2_000);
const concurrency = boundedInteger('GAMES_LOAD_CONCURRENCY', 20, 1, 50);
const p95TargetMs = boundedInteger('GAMES_LOAD_P95_TARGET_MS', 200, 25, 2_000);
const pageSize = 20;

const pool = createDatabasePool(connectionString);
const repository = createGameRepository(pool);
const tenantId = randomUUID();
const organizerUserId = randomUUID();
const stationId = randomUUID();
const gameIds = Array.from({ length: cardCount }, () => randomUUID());
const startsBase = new Date(Date.now() + 86_400_000).toISOString();

function percentile(values: readonly number[], quantile: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1);
  return sorted[index] ?? 0;
}

async function measure(operation: () => Promise<void>): Promise<number> {
  const started = performance.now();
  await operation();
  return performance.now() - started;
}

async function concurrentMeasurements(operation: () => Promise<void>): Promise<number[]> {
  const measurements: number[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (next < iterations) {
        next += 1;
        measurements.push(await measure(operation));
      }
    }),
  );
  return measurements;
}

try {
  await pool.query(
    `insert into identity.tenants (id, tenant_key, display_name)
     values ($1, $2, 'Games read load verification')`,
    [tenantId, `games-load-${tenantId.slice(0, 8)}`],
  );
  await withTenantTransaction(pool, tenantId, async (client) => {
    await client.query(`insert into identity.users (id, tenant_id) values ($1, $2)`, [
      organizerUserId,
      tenantId,
    ]);
    await client.query(
      `insert into locations.profiles (
         tenant_id, id, slug, title, address, publication_status,
         created_by, updated_by, published_at
       ) values ($1, $2, 'games-load-station', 'Load station', 'Moscow', 'PUBLISHED', $3, $3, now())`,
      [tenantId, stationId, organizerUserId],
    );
    await client.query(
      `insert into games.games (
         tenant_id, id, organizer_user_id, title, kind, visibility, lifecycle_state,
         station_id, starts_at, ends_at, timezone, capacity, waitlist_enabled,
         join_cutoff_at, payment_mode, card_projection_revision
       )
       select $1, source.game_id, $2, 'Load game ' || source.ordinality,
              'FRIENDLY', 'PUBLIC', 'SCHEDULED', $3,
              $5::timestamptz + source.ordinality * interval '1 minute',
              $5::timestamptz + source.ordinality * interval '1 minute' + interval '90 minutes',
              'Europe/Moscow', 4, true,
              $5::timestamptz + source.ordinality * interval '1 minute' - interval '1 hour',
              'NO_PAYMENT', 1
         from unnest($4::uuid[]) with ordinality source(game_id, ordinality)`,
      [tenantId, organizerUserId, stationId, gameIds, startsBase],
    );
    await client.query(
      `insert into games.card_projections (
         tenant_id, game_id, aggregate_revision, projection_revision, lifecycle_state,
         visibility, starts_at, ends_at, base_payload
       )
       select g.tenant_id, g.id, 1, 1, g.lifecycle_state, g.visibility, g.starts_at, g.ends_at,
              jsonb_build_object(
                'id', g.id,
                'tenantId', g.tenant_id,
                'revision', 1,
                'organizerUserId', g.organizer_user_id,
                'title', g.title,
                'kind', g.kind,
                'visibility', g.visibility,
                'lifecycleState', g.lifecycle_state,
                'startsAt', g.starts_at,
                'endsAt', g.ends_at,
                'timezone', g.timezone,
                'station', jsonb_build_object(
                  'id', g.station_id, 'name', 'Load station', 'shortAddress', 'Moscow'
                ),
                'levelRange', jsonb_build_object('from', 'D', 'to', 'C'),
                'capacity', g.capacity,
                'participants', jsonb_build_array(jsonb_build_object(
                  'userId', g.organizer_user_id,
                  'displayName', 'Load organizer',
                  'avatarUrl', null,
                  'level', 'D',
                  'role', 'ORGANIZER',
                  'paymentState', 'NOT_REQUIRED'
                )),
                'seatReservations', '[]'::jsonb,
                'waitlist', '[]'::jsonb,
                'waitlistEnabled', true,
                'joinCutoffAt', g.join_cutoff_at,
                'priceSummary', null
              )
         from games.games g
        where g.tenant_id = $1`,
      [tenantId],
    );
  });

  for (let warmup = 0; warmup < 10; warmup += 1) {
    await repository.listPublicCardProjections({ tenantId, limit: pageSize });
    await repository.listViewerCardProjections({
      tenantId,
      viewerUserId: organizerUserId,
      scope: 'UPCOMING',
      limit: pageSize,
    });
  }

  const firstPage = await repository.listPublicCardProjections({ tenantId, limit: 100 });
  const secondPage = firstPage.next
    ? await repository.listPublicCardProjections({ tenantId, limit: 100, after: firstPage.next })
    : undefined;
  const uniqueIds = new Set([
    ...firstPage.items.map((item) => item.gameId),
    ...(secondPage?.items.map((item) => item.gameId) ?? []),
  ]);
  if (
    firstPage.items.length !== 100 ||
    secondPage?.items.length !== 100 ||
    uniqueIds.size !== 200
  ) {
    throw new Error('Public keyset pagination returned a duplicate or incomplete page');
  }

  const publicMeasurements = await concurrentMeasurements(async () => {
    const page = await repository.listPublicCardProjections({ tenantId, limit: pageSize });
    if (page.items.length !== pageSize) throw new Error('Public load page is incomplete');
  });
  const viewerMeasurements = await concurrentMeasurements(async () => {
    const page = await repository.listViewerCardProjections({
      tenantId,
      viewerUserId: organizerUserId,
      scope: 'UPCOMING',
      limit: pageSize,
    });
    if (page.items.length !== pageSize) throw new Error('Viewer load page is incomplete');
  });
  const publicP95Ms = percentile(publicMeasurements, 0.95);
  const viewerP95Ms = percentile(viewerMeasurements, 0.95);
  if (publicP95Ms > p95TargetMs || viewerP95Ms > p95TargetMs) {
    throw new Error(
      `Games read p95 target failed: ${JSON.stringify({ publicP95Ms, viewerP95Ms, p95TargetMs })}`,
    );
  }

  process.stdout.write(
    `${JSON.stringify({
      cardCount,
      iterations,
      concurrency,
      pageSize,
      p95TargetMs,
      public: {
        p50Ms: percentile(publicMeasurements, 0.5),
        p95Ms: publicP95Ms,
        p99Ms: percentile(publicMeasurements, 0.99),
        maxMs: Math.max(...publicMeasurements),
      },
      viewer: {
        p50Ms: percentile(viewerMeasurements, 0.5),
        p95Ms: viewerP95Ms,
        p99Ms: percentile(viewerMeasurements, 0.99),
        maxMs: Math.max(...viewerMeasurements),
      },
      keysetUniqueCards: uniqueIds.size,
    })}\n`,
  );
} finally {
  await pool.end();
}
