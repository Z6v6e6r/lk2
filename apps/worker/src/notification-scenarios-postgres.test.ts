import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenantTransaction } from '@phub/database';
import { createNotificationScenarioRepository } from '@phub/database/notification-scenarios';
import type { NotificationScenarioInput } from '@phub/domain/notification-scenarios';
import {
  ingestNotificationScenarioEvent,
  runNotificationScenarioBatch,
} from './notification-scenarios.js';

// Only the already-declared, empty Actions service is eligible. Never inherit a local/shared URL.
function ciUrl(): string | undefined {
  if (process.env.GITHUB_ACTIONS !== 'true' || process.env.APP_ENV !== 'ci') return undefined;
  const value = process.env.DATABASE_URL;
  if (!value) return undefined;
  const url = new URL(value);
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !['localhost', '127.0.0.1'].includes(url.hostname) ||
    url.username !== 'phub' ||
    url.pathname !== '/phub' ||
    url.port !== '5432' ||
    url.search ||
    url.hash
  )
    throw new Error('SCENARIO_CI_DATABASE_TARGET_INVALID');
  return value;
}
const url = ciUrl();
const physical = url ? describe.sequential : describe.skip;
physical('notification scenario physical transactions and non-owner RLS', () => {
  const tenant = randomUUID(),
    foreignTenant = randomUUID(),
    actor = randomUUID(),
    recipient = randomUUID(),
    role = `scenario_test_${randomUUID().replaceAll('-', '')}`,
    password = randomUUID();
  const owner = new Pool({ connectionString: url, max: 4 });
  let runtime: Pool;
  const base: NotificationScenarioInput = {
    name: 'Синтетический сценарий',
    trigger: 'BOOKING_CONFIRMED',
    delayMinutes: 0,
    ttlMinutes: 60,
    title: 'Подтверждение',
    body: '{{serviceTitle}}',
    channels: ['IN_APP'],
    quietHours: 'DEFER',
    dailyLimit: 1,
    goal: 'NONE',
    goalWindowMinutes: 60,
    active: true,
  };
  let sequence = 0;
  const save = (
    definition = base,
    id?: string,
    version = 0,
    key = `scenario-test-${randomUUID()}`,
  ) =>
    createNotificationScenarioRepository(runtime).save({
      tenantId: tenant,
      actorUserId: actor,
      expectedVersion: version,
      ...(id ? { id } : {}),
      definition,
      idempotencyKey: key,
      correlationId: `scenario-test-${sequence++}`,
    });
  function event(target = randomUUID(), revision = '1', type = 'booking.confirmed.v1') {
    return {
      id: randomUUID(),
      type,
      tenantId: tenant,
      aggregateId: target,
      occurredAt: new Date().toISOString(),
      correlationId: `scenario-test-${randomUUID()}`,
      payload: {
        bookingId: target,
        revision,
        recipientUserIds: [recipient],
        serviceTitle: 'Синтетическая тренировка',
        startsAt: new Date(Date.now() + 3_600_000).toISOString(),
        timezone: 'Europe/Moscow',
        locationName: 'Синтетический клуб',
        ...(type === 'booking.changed.v1' ? { changedFields: ['TIME'] } : {}),
      },
    };
  }
  beforeAll(async () => {
    await owner.query(
      `create role ${role} login password '${password}' nosuperuser nobypassrls nocreatedb nocreaterole noinherit`,
    );
    await owner.query(
      `grant usage on schema identity,notifications,integration,audit,games,profile to ${role}`,
    );
    await owner.query(
      `grant select on identity.users,identity.user_access_profiles,notifications.user_preferences,notifications.tenant_runtime_settings,notifications.booking_notification_projection_fences,integration.notification_endpoints,integration.notification_provider_accounts,games.participations to ${role}`,
    );
    await owner.query(
      `grant update(updated_at) on identity.users,identity.user_access_profiles to ${role}`,
    );
    await owner.query(
      `grant select,insert,update on notifications.scenarios,notifications.scenario_runs,notifications.scenario_contexts,notifications.intents,notifications.inbox_items,notifications.deliveries,audit.inbox_events to ${role}`,
    );
    await owner.query(
      `grant select,insert on notifications.scenario_versions,notifications.scenario_commands,notifications.templates to ${role}`,
    );
    await owner.query(`grant insert on audit.audit_log,audit.outbox_events to ${role}`);
    const parsed = new URL(url!);
    parsed.username = role;
    parsed.password = password;
    runtime = new Pool({ connectionString: parsed.toString(), max: 6 });
    await owner.query(
      `insert into identity.tenants(id,tenant_key,display_name) values($1,$2,'Scenario synthetic'),($3,$4,'Scenario foreign synthetic')`,
      [tenant, `scenario-${tenant}`, foreignTenant, `scenario-${foreignTenant}`],
    );
    await withTenantTransaction(owner, tenant, async (client) => {
      await client.query(
        `insert into identity.users(tenant_id,id,status) values($1,$2,'ACTIVE'),($1,$3,'ACTIVE')`,
        [tenant, actor, recipient],
      );
      await client.query(
        `insert into identity.user_access_profiles(tenant_id,user_id,roles,permissions) values($1,$2,array['admin'],array['notifications.manage'])`,
        [tenant, actor],
      );
      await client.query(
        `insert into notifications.tenant_runtime_settings(tenant_id,in_app_enabled) values($1,true)`,
        [tenant],
      );
    });
  }, 30_000);
  afterAll(async () => {
    if (runtime) await runtime.end();
    await owner.query(`drop owned by ${role}`);
    await owner.query(`drop role if exists ${role}`);
    await owner.end();
  });
  it('replays an exact command, rejects a different body and preserves immutable versions', async () => {
    const key = `scenario-test-${randomUUID()}`;
    const first = await save(base, undefined, 0, key);
    expect(await save(base, undefined, 0, key)).toEqual(first);
    await expect(save({ ...base, name: 'Другая команда' }, undefined, 0, key)).rejects.toThrow(
      'IDEMPOTENCY_KEY_REUSED',
    );
    const second = await save({ ...base, active: false }, first.id, 1);
    expect(second.version).toBe(2);
    await expect(save(base, first.id, 1)).rejects.toThrow('SCENARIO_VERSION_CONFLICT');
    await expect(
      withTenantTransaction(owner, tenant, (client) =>
        client.query(
          `update notifications.scenario_versions set definition='{}'::jsonb where tenant_id=$1 and scenario_id=$2`,
          [tenant, first.id],
        ),
      ),
    ).rejects.toThrow('SCENARIO_VERSION_IMMUTABLE');
  });
  it('denies absent/foreign tenant contexts and cross-tenant composite references', async () => {
    const first = await save();
    await ingestNotificationScenarioEvent(runtime, event());
    for (const table of [
      'scenarios',
      'scenario_versions',
      'scenario_commands',
      'scenario_contexts',
      'scenario_runs',
    ]) {
      expect(
        (
          await withTenantTransaction(runtime, tenant, (client) =>
            client.query(`select 1 from notifications.${table} where tenant_id=$1`, [tenant]),
          )
        ).rowCount,
      ).toBeGreaterThan(0);
      expect((await runtime.query(`select * from notifications.${table}`)).rows).toEqual([]);
      expect(
        (
          await withTenantTransaction(runtime, foreignTenant, (client) =>
            client.query(`select 1 from notifications.${table} where tenant_id=$1`, [tenant]),
          )
        ).rowCount,
      ).toBe(0);
    }
    expect(
      (
        await withTenantTransaction(runtime, foreignTenant, (client) =>
          client.query('select * from notifications.scenarios where id=$1', [first.id]),
        )
      ).rowCount,
    ).toBe(0);
    const template = await withTenantTransaction(owner, tenant, (client) =>
      client.query<{ template_id: string }>(
        'select template_id from notifications.scenario_versions where tenant_id=$1 and scenario_id=$2 and version=1',
        [tenant, first.id],
      ),
    );
    // All referenced tenant-A rows are valid except the deliberately foreign scenario identifier.
    await expect(
      withTenantTransaction(runtime, tenant, (client) =>
        client.query(
          `insert into notifications.scenario_versions(tenant_id,scenario_id,version,definition,template_id,created_by) values($1,$2,1,'{}'::jsonb,$3,$4)`,
          [tenant, randomUUID(), template.rows[0]!.template_id, actor],
        ),
      ),
    ).rejects.toMatchObject({ constraint: 'scenario_versions_tenant_id_scenario_id_fkey' });
    await expect(
      withTenantTransaction(owner, tenant, (client) =>
        client.query(
          'update notifications.scenarios set version=version+100 where tenant_id=$1 and id=$2',
          [tenant, first.id],
        ),
      ),
    ).rejects.toMatchObject({ constraint: 'scenario_current_version_fk' });
    expect(
      (await createNotificationScenarioRepository(runtime).list(tenant)).find(
        (item) => item.id === first.id,
      )?.version,
    ).toBe(1);
    await expect(
      withTenantTransaction(owner, tenant, (client) =>
        client.query(
          'delete from notifications.scenario_versions where tenant_id=$1 and scenario_id=$2',
          [tenant, first.id],
        ),
      ),
    ).rejects.toThrow('SCENARIO_VERSION_IMMUTABLE');
  });
  it('deduplicates concurrent facts and atomically creates a single inbox per run', async () => {
    const scenario = await save();
    const source = event();
    await Promise.all([
      ingestNotificationScenarioEvent(runtime, source),
      ingestNotificationScenarioEvent(runtime, source),
    ]);
    await Promise.all([
      runNotificationScenarioBatch({ pool: runtime, tenantId: tenant }),
      runNotificationScenarioBatch({ pool: runtime, tenantId: tenant }),
    ]);
    const rows = await withTenantTransaction(owner, tenant, (client) =>
      client.query(
        `select r.state,count(i.id)::integer count from notifications.scenario_runs r left join notifications.inbox_items i on i.tenant_id=r.tenant_id and i.intent_id=r.intent_id where r.tenant_id=$1 and r.scenario_id=$2 and r.source_event_id=$3 group by r.state`,
        [tenant, scenario.id, source.id],
      ),
    );
    expect(rows.rows).toEqual([{ state: 'QUEUED', count: 1 }]);
    const before = (await createNotificationScenarioRepository(runtime).runs(tenant, scenario.id))
      .length;
    expect(await ingestNotificationScenarioEvent(runtime, source)).toBe('DUPLICATE');
    expect(
      (await createNotificationScenarioRepository(runtime).runs(tenant, scenario.id)).length,
    ).toBe(before);
  });
  it('cancels pending work on pause and on a newer booking revision', async () => {
    const scenario = await save({ ...base, delayMinutes: 10 });
    const source = event();
    await ingestNotificationScenarioEvent(runtime, source);
    await save({ ...base, delayMinutes: 10, active: false }, scenario.id, 1);
    expect(
      (await createNotificationScenarioRepository(runtime).runs(tenant, scenario.id))[0]?.state,
    ).toBe('CANCELLED');
    const second = await save({ ...base, delayMinutes: 10 });
    const next = event();
    await ingestNotificationScenarioEvent(runtime, next);
    const changed = event(next.aggregateId, '2', 'booking.changed.v1');
    await ingestNotificationScenarioEvent(runtime, changed);
    expect(
      (await createNotificationScenarioRepository(runtime).runs(tenant, second.id))[0]?.reason,
    ).toBe('SOURCE_CHANGED');
    const stale = { ...next, id: randomUUID() };
    expect(await ingestNotificationScenarioEvent(runtime, stale)).toBe('STALE');
    const sameRevision = { ...changed, id: randomUUID() };
    expect(await ingestNotificationScenarioEvent(runtime, sameRevision)).toBe('DUPLICATE');
    const processed = await withTenantTransaction(owner, tenant, (client) =>
      client.query<{ processed_at: Date | null }>(
        'select processed_at from audit.inbox_events where tenant_id=$1 and event_id=any($2::uuid[])',
        [tenant, [stale.id, sameRevision.id]],
      ),
    );
    expect(processed.rows).toHaveLength(2);
    expect(processed.rows.every((row) => row.processed_at !== null)).toBe(true);
  });
  it('attributes a delayed confirmation only to its exact user, game, participation and exposure window', async () => {
    const scenario = await save({ ...base, trigger: 'FRIEND_GAME_PUBLISHED', goal: 'GAME_JOINED' });
    const game = randomUUID(),
      participation = randomUUID(),
      run = randomUUID(),
      intent = randomUUID();
    const exposed = new Date(Date.now() - 120_000),
      deadline = new Date(Date.now() - 30_000),
      confirmed = new Date(Date.now() - 60_000);
    await withTenantTransaction(owner, tenant, async (client) => {
      await client.query(
        `insert into games.games(tenant_id,id,organizer_user_id,title,kind,visibility,lifecycle_state,station_id,starts_at,ends_at,timezone,capacity,payment_mode) values($1,$2,$3,'Synthetic goal game','FRIENDLY','PUBLIC','SCHEDULED',$4,now()+interval '1 hour',now()+interval '2 hours','Europe/Moscow',4,'NO_PAYMENT')`,
        [tenant, game, actor, randomUUID()],
      );
      await client.query(
        `insert into games.participations(tenant_id,game_id,id,user_id,role) values($1,$2,$3,$4,'PLAYER')`,
        [tenant, game, participation, recipient],
      );
      const version = await client.query<{ template_id: string }>(
        'select template_id from notifications.scenario_versions where tenant_id=$1 and scenario_id=$2 and version=1',
        [tenant, scenario.id],
      );
      await client.query(
        `insert into notifications.intents(tenant_id,id,recipient_user_id,source_event_id,template_id,dedupe_key,rendered_title,rendered_body,state,completed_at) values($1,$2,$3,$4,$5,$6,'Synthetic invitation','Synthetic body','DELIVERED',$7)`,
        [
          tenant,
          intent,
          recipient,
          randomUUID(),
          version.rows[0]!.template_id,
          `scenario-goal-${run}`,
          exposed,
        ],
      );
      await client.query(
        `insert into notifications.inbox_items(tenant_id,intent_id,user_id,category,title,body,created_at) values($1,$2,$3,'GAME_RECOMMENDATION','Synthetic invitation','Synthetic body',$4)`,
        [tenant, intent, recipient, exposed],
      );
      await client.query(
        `insert into notifications.scenario_runs(tenant_id,id,scenario_id,scenario_version,recipient_user_id,target_id,source_event_id,context_kind,context_revision,rendered_title,rendered_body,deep_link,state,intent_id,queued_at,goal_state,goal_deadline,due_at,expires_at) values($1,$2,$3,1,$4,$5,$6,'GAME',1,'Synthetic invitation','Synthetic body','/notifications','QUEUED',$7,$8,'EXPIRED',$9,$8,now()+interval '1 hour')`,
        [tenant, run, scenario.id, recipient, game, randomUUID(), intent, exposed, deadline],
      );
    });
    const fact = {
      id: randomUUID(),
      type: 'game.participation.confirmed.v1',
      tenantId: tenant,
      aggregateId: game,
      occurredAt: confirmed.toISOString(),
      correlationId: `scenario-goal-${run}`,
      payload: {
        gameId: game,
        aggregateRevision: '2',
        causationId: randomUUID(),
        actorUserId: recipient,
        userId: recipient,
        participationId: participation,
      },
    };
    const state = async () =>
      (await createNotificationScenarioRepository(runtime).runs(tenant, scenario.id))[0]?.goalState;
    await ingestNotificationScenarioEvent(runtime, {
      ...fact,
      id: randomUUID(),
      payload: { ...fact.payload, participationId: randomUUID() },
    });
    expect(await state()).toBe('EXPIRED');
    await ingestNotificationScenarioEvent(runtime, {
      ...fact,
      id: randomUUID(),
      payload: { ...fact.payload, userId: actor },
    });
    expect(await state()).toBe('EXPIRED');
    await ingestNotificationScenarioEvent(runtime, {
      ...fact,
      id: randomUUID(),
      occurredAt: new Date(exposed.getTime() - 1000).toISOString(),
    });
    expect(await state()).toBe('EXPIRED');
    await ingestNotificationScenarioEvent(runtime, {
      ...fact,
      id: randomUUID(),
      occurredAt: new Date(deadline.getTime() + 1000).toISOString(),
    });
    expect(await state()).toBe('EXPIRED');
    await ingestNotificationScenarioEvent(runtime, fact);
    const result = (
      await createNotificationScenarioRepository(runtime).runs(tenant, scenario.id)
    )[0];
    expect(result?.goalState).toBe('ACHIEVED');
    expect(result?.goalAchievedAt).toBe(confirmed.toISOString());
  });
  it('honours a current opt-out and expires an old source instead of backdating sends', async () => {
    const scenario = await save();
    await withTenantTransaction(owner, tenant, (client) =>
      client.query(
        `insert into notifications.user_preferences(tenant_id,user_id,category,channel,enabled) values($1,$2,'BOOKING','IN_APP',false) on conflict(tenant_id,user_id,category,channel) do update set enabled=false`,
        [tenant, recipient],
      ),
    );
    const source = event();
    await ingestNotificationScenarioEvent(runtime, source);
    await runNotificationScenarioBatch({ pool: runtime, tenantId: tenant });
    expect(
      (await createNotificationScenarioRepository(runtime).runs(tenant, scenario.id))[0]?.reason,
    ).toBe('NO_ALLOWED_CHANNEL');
    const old = { ...event(), occurredAt: new Date(Date.now() - 86_400_000).toISOString() };
    await ingestNotificationScenarioEvent(runtime, old);
    await runNotificationScenarioBatch({ pool: runtime, tenantId: tenant });
    const runs = await createNotificationScenarioRepository(runtime).runs(tenant, scenario.id);
    expect(runs.some((run) => run.targetId === old.aggregateId && run.state === 'EXPIRED')).toBe(
      true,
    );
  });
});
