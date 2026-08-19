import { createDatabasePool, createParticipationCommandRepository } from '@phub/database';

const fixtures = {
  tenantA: '00000000-0000-4000-8000-000000000331',
  tenantB: '00000000-0000-4000-8000-000000000332',
  playerA: '00000000-0000-4000-8000-000000000333',
  allowedActivity: '00000000-0000-4000-8000-000000000341',
  deniedActivity: '00000000-0000-4000-8000-000000000342',
  paymentOperation: '00000000-0000-4000-8000-000000000343',
  writerOperation: '00000000-0000-4000-8000-000000000344',
} as const;

function fail(code: string): never {
  throw new Error(code);
}

function cloneDatabaseUrl(value: string | undefined, label: string): URL {
  if (!value) fail(`${label}_REQUIRED`);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    fail(`${label}_INVALID`);
  }
  let database: string;
  try {
    database = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  } catch {
    fail(`${label}_INVALID`);
  }
  if (
    !['postgres:', 'postgresql:'].includes(parsed.protocol) ||
    parsed.hostname !== 'postgres' ||
    (parsed.port || '5432') !== '5432' ||
    parsed.search ||
    parsed.hash ||
    !/^phub_restore_[0-9]+(?:_[0-9]+)+$/.test(database)
  ) {
    fail(`${label}_INVALID`);
  }
  return parsed;
}

async function prepareRuntimeFixtures(runtimeConnectionString: string): Promise<void> {
  const pool = createDatabasePool(runtimeConnectionString);
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query("select set_config('app.tenant_id', $1, true)", [fixtures.tenantA]);
    await client.query(
      `update eligibility.level_policies
          set mode = 'BLOCK', missing_activity_constraint_action = 'BLOCK'
        where tenant_id = $1 and sport_code = 'PADEL' and activity_type = 'GAME' and active`,
      [fixtures.tenantA],
    );
    await client.query(
      `insert into eligibility.activity_level_projections (
         tenant_id, activity_type, activity_id, sport_code, constraint_mode,
         min_level_id, max_level_id, constraint_source, data_quality, scale_version,
         source_revision, projected_at
       )
       select $1, 'GAME', activity.id, 'PADEL', 'RANGE', minimum.id, maximum.id,
              'CANONICAL', 'VALID', 1, 1, now()
         from (values ($2::uuid, 'C+'::text, 'C+'::text),
                      ($3::uuid, 'C'::text, 'C'::text)) activity(id, minimum_code, maximum_code)
         join eligibility.canonical_levels minimum
           on minimum.tenant_id = $1 and minimum.sport_code = 'PADEL'
          and minimum.scale_version = 1 and minimum.code = activity.minimum_code
         join eligibility.canonical_levels maximum
           on maximum.tenant_id = $1 and maximum.sport_code = 'PADEL'
          and maximum.scale_version = 1 and maximum.code = activity.maximum_code`,
      [fixtures.tenantA, fixtures.allowedActivity, fixtures.deniedActivity],
    );
    await client.query('commit');
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

async function visibleCount(
  runtimeConnectionString: string,
  tenantId: string,
  table: 'activity_level_projections' | 'participation_commands',
): Promise<number> {
  const pool = createDatabasePool(runtimeConnectionString);
  const client = await pool.connect();
  try {
    await client.query('begin read only');
    await client.query("select set_config('app.tenant_id', $1, true)", [tenantId]);
    const result = await client.query<{ count: string }>(
      `select count(*)::text as count from eligibility.${table}`,
    );
    await client.query('rollback');
    return Number(result.rows[0]?.count ?? '-1');
  } finally {
    client.release();
    await pool.end();
  }
}

async function probe(runtimeConnectionString: string): Promise<void> {
  await prepareRuntimeFixtures(runtimeConnectionString);
  const pool = createDatabasePool(runtimeConnectionString);
  try {
    const repository = createParticipationCommandRepository(pool);
    const baseInput = {
      tenantId: fixtures.tenantA,
      principalKey: 'rehearsal-writer',
      idempotencyKey: 'rehearsal-participation-0001',
      requestHash: 'a'.repeat(64),
      actorUserId: fixtures.playerA,
      activityType: 'GAME' as const,
      activityId: fixtures.allowedActivity,
      action: 'JOIN' as const,
      expectedActivityRevision: 1,
      payment: { operationId: fixtures.paymentOperation, mode: 'SUBSCRIPTION' as const },
      correlationId: 'rehearsal-participation-correlation-0001',
      authorizationTtlSeconds: 300,
    };
    const authorized = await repository.authorize(baseInput);
    if (authorized.outcome !== 'command' || authorized.state !== 'AUTHORIZED') {
      fail('PARTICIPATION_COMMAND_REHEARSAL_AUTHORIZE_FAILED');
    }
    const replay = await repository.authorize(baseInput);
    if (replay.outcome !== 'command' || !replay.replayed) {
      fail('PARTICIPATION_COMMAND_REHEARSAL_REPLAY_FAILED');
    }
    const reused = await repository.authorize({ ...baseInput, requestHash: 'b'.repeat(64) });
    if (reused.outcome !== 'idempotency_conflict') {
      fail('PARTICIPATION_COMMAND_REHEARSAL_IDEMPOTENCY_REUSE_ACCEPTED');
    }
    const { payment: _payment, ...baseWithoutPayment } = baseInput;
    void _payment;
    const denied = await repository.authorize({
      ...baseWithoutPayment,
      idempotencyKey: 'rehearsal-participation-0002',
      requestHash: 'c'.repeat(64),
      activityId: fixtures.deniedActivity,
      correlationId: 'rehearsal-participation-correlation-0002',
    });
    if (denied.outcome !== 'command' || denied.state !== 'REJECTED') {
      fail('PARTICIPATION_COMMAND_REHEARSAL_DENY_FAILED');
    }
    const crossTenant = await repository.authorize({
      ...baseWithoutPayment,
      tenantId: fixtures.tenantB,
      idempotencyKey: 'rehearsal-participation-0003',
      requestHash: 'd'.repeat(64),
      actorUserId: fixtures.playerA,
      correlationId: 'rehearsal-participation-correlation-0003',
    });
    if (crossTenant.outcome !== 'actor_not_found') {
      fail('PARTICIPATION_COMMAND_REHEARSAL_CROSS_TENANT_VISIBLE');
    }
    const applied = await repository.acknowledge({
      tenantId: fixtures.tenantA,
      principalKey: baseInput.principalKey,
      commandId: authorized.commandId,
      idempotencyKey: 'rehearsal-acknowledgement-0001',
      requestHash: 'e'.repeat(64),
      writerOperationId: fixtures.writerOperation,
      result: { outcome: 'APPLIED' },
      correlationId: 'rehearsal-participation-correlation-0004',
    });
    if (applied.outcome !== 'command' || applied.state !== 'APPLIED') {
      fail('PARTICIPATION_COMMAND_REHEARSAL_ACKNOWLEDGE_FAILED');
    }
  } finally {
    await pool.end();
  }

  if (
    (await visibleCount(
      runtimeConnectionString,
      fixtures.tenantA,
      'activity_level_projections',
    )) !== 2 ||
    (await visibleCount(runtimeConnectionString, fixtures.tenantA, 'participation_commands')) !==
      2 ||
    (await visibleCount(
      runtimeConnectionString,
      fixtures.tenantB,
      'activity_level_projections',
    )) !== 0 ||
    (await visibleCount(runtimeConnectionString, fixtures.tenantB, 'participation_commands')) !== 0
  ) {
    fail('PARTICIPATION_COMMAND_REHEARSAL_RLS_INVALID');
  }
}

const runtimeUrl = cloneDatabaseUrl(process.env.RUNTIME_DATABASE_URL, 'RUNTIME_DATABASE_URL');
await probe(runtimeUrl.toString());
process.stdout.write(
  'PARTICIPATION_COMMAND_REHEARSAL_PROBE authorize=passed deny=passed replay=passed idempotency=passed payment_snapshot=passed acknowledgement=passed cross_tenant_rls=passed\n',
);
