import { createHash, randomUUID } from 'node:crypto';

import {
  notificationScenarioCategory,
  type NotificationScenarioInput,
  type NotificationScenarioView,
  type NotificationScenarioRunView,
} from '@phub/domain';
import type { Pool, PoolClient, QueryResultRow } from 'pg';

import { withTenantTransaction } from './connection.js';

interface ScenarioRow extends QueryResultRow {
  id: string;
  version: number;
  definition: NotificationScenarioInput;
  updated_at: Date;
}
interface RunRow extends QueryResultRow {
  id: string;
  scenario_id: string;
  scenario_version: number;
  recipient_user_id: string;
  target_id: string;
  state: string;
  reason: string | null;
  due_at: Date;
  expires_at: Date;
  goal_state: NotificationScenarioRunView['goalState'];
  goal_achieved_at: Date | null;
  delivery_states: NotificationScenarioRunView['deliveryStates'];
}
function view(row: ScenarioRow): NotificationScenarioView {
  return {
    id: row.id,
    version: row.version,
    definition: row.definition,
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}
export interface NotificationScenarioRepository {
  list(tenantId: string): Promise<readonly NotificationScenarioView[]>;
  save(input: {
    readonly tenantId: string;
    readonly actorUserId: string;
    readonly id?: string;
    readonly expectedVersion: number;
    readonly definition: NotificationScenarioInput;
    readonly idempotencyKey: string;
    readonly correlationId: string;
  }): Promise<NotificationScenarioView>;
  runs(tenantId: string, scenarioId?: string): Promise<readonly NotificationScenarioRunView[]>;
}
export async function assertScenarioAdmin(
  client: PoolClient,
  tenantId: string,
  actorId: string,
): Promise<void> {
  const access = await client.query(
    `select 1 from identity.user_access_profiles a join identity.users u on u.tenant_id=a.tenant_id and u.id=a.user_id where a.tenant_id=$1 and a.user_id=$2 and u.status='ACTIVE' and 'admin'=any(a.roles) and 'notifications.manage'=any(a.permissions) for share of a,u`,
    [tenantId, actorId],
  );
  if (access.rowCount !== 1) throw new Error('ADMIN_PERMISSION_REQUIRED');
}
export function createNotificationScenarioRepository(pool: Pool): NotificationScenarioRepository {
  return {
    list(tenantId) {
      return withTenantTransaction(pool, tenantId, async (client) => {
        const result = await client.query<ScenarioRow>(
          'select id,version,definition,updated_at from notifications.scenarios where tenant_id=$1 order by updated_at desc,id limit 100',
          [tenantId],
        );
        return result.rows.map(view);
      });
    },
    save(input) {
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        await client.query(
          "select set_config('lock_timeout','5s',true),set_config('statement_timeout','15s',true)",
        );
        await assertScenarioAdmin(client, input.tenantId, input.actorUserId);
        await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [
          `scenario-admin:${input.tenantId}`,
        ]);
        const hash = createHash('sha256')
          .update(
            JSON.stringify({
              id: input.id ?? null,
              expectedVersion: input.expectedVersion,
              definition: input.definition,
            }),
          )
          .digest('hex');
        const replay = await client.query<{
          request_hash: string;
          result: NotificationScenarioView;
        }>(
          `select request_hash,result from notifications.scenario_commands where tenant_id=$1 and actor_user_id=$2 and idempotency_key=$3`,
          [input.tenantId, input.actorUserId, input.idempotencyKey],
        );
        if (replay.rows[0]) {
          if (replay.rows[0].request_hash !== hash) throw new Error('IDEMPOTENCY_KEY_REUSED');
          return replay.rows[0].result;
        }
        const id = input.id ?? randomUUID();
        const current = await client.query<ScenarioRow>(
          'select id,version,definition,updated_at from notifications.scenarios where tenant_id=$1 and id=$2 for update',
          [input.tenantId, id],
        );
        if (input.id && !current.rows[0]) throw new Error('SCENARIO_NOT_FOUND');
        if ((current.rows[0]?.version ?? 0) !== input.expectedVersion)
          throw new Error('SCENARIO_VERSION_CONFLICT');
        if (!input.id) {
          const count = await client.query<{ count: string }>(
            'select count(*)::text count from notifications.scenarios where tenant_id=$1',
            [input.tenantId],
          );
          if (Number(count.rows[0]?.count) >= 100) throw new Error('SCENARIO_LIMIT_REACHED');
        }
        const version = input.expectedVersion + 1;
        const result = await client.query<ScenarioRow>(
          `insert into notifications.scenarios(tenant_id,id,version,definition,active,updated_by) values($1,$2,$3,$4::jsonb,$5,$6) on conflict(tenant_id,id) do update set version=excluded.version,definition=excluded.definition,active=excluded.active,updated_by=excluded.updated_by,updated_at=now() returning id,version,definition,updated_at`,
          [
            input.tenantId,
            id,
            version,
            JSON.stringify(input.definition),
            input.definition.active,
            input.actorUserId,
          ],
        );
        const template = await client.query<{ id: string }>(
          `insert into notifications.templates(tenant_id,template_key,version,category,channels,title_template,body_template,active,created_by_user_id) values($1,$2,$3,$4,$5::text[],$6,$7,false,$8) returning id`,
          [
            input.tenantId,
            `scenario.${id}`,
            version,
            notificationScenarioCategory(input.definition),
            [
              ...new Set(
                input.definition.channels.map((c) => (c === 'IN_APP' ? 'IN_APP' : 'PUSH')),
              ),
            ],
            input.definition.title,
            input.definition.body,
            input.actorUserId,
          ],
        );
        await client.query(
          `insert into notifications.scenario_versions(tenant_id,scenario_id,version,definition,template_id,created_by) values($1,$2,$3,$4::jsonb,$5,$6)`,
          [
            input.tenantId,
            id,
            version,
            JSON.stringify(input.definition),
            template.rows[0]?.id,
            input.actorUserId,
          ],
        );
        // A revision change never rewrites a pending run's immutable definition.
        await client.query(
          `update notifications.scenario_runs set state='CANCELLED',reason='SCENARIO_REVISED',updated_at=now() where tenant_id=$1 and scenario_id=$2 and state='PENDING'`,
          [input.tenantId, id],
        );
        const suppressed = await client.query<{ intent_id: string }>(
          `update notifications.deliveries d set state='SUPPRESSED',last_error_code='SCENARIO_REVISED',completed_at=now(),updated_at=now() from notifications.scenario_runs r where r.tenant_id=$1 and r.scenario_id=$2 and d.tenant_id=r.tenant_id and d.intent_id=r.intent_id and d.state='PENDING' returning d.intent_id`,
          [input.tenantId, id],
        );
        await resolveScenarioIntentStates(
          client,
          input.tenantId,
          suppressed.rows.map((row) => row.intent_id),
        );
        const response = view(result.rows[0]!);
        await client.query(
          `insert into notifications.scenario_commands(tenant_id,actor_user_id,idempotency_key,request_hash,result) values($1,$2,$3,$4,$5::jsonb)`,
          [input.tenantId, input.actorUserId, input.idempotencyKey, hash, JSON.stringify(response)],
        );
        await client.query(
          `insert into audit.audit_log(tenant_id,actor_id,action,resource_type,resource_id,correlation_id,new_value,result) values($1,$2,'NOTIFICATION_SCENARIO_SAVED','notification_scenario',$3,$4,$5::jsonb,'SUCCESS')`,
          [
            input.tenantId,
            input.actorUserId,
            id,
            input.correlationId,
            JSON.stringify({ version, active: input.definition.active }),
          ],
        );
        await client.query(
          `insert into audit.outbox_events(tenant_id,event_type,aggregate_id,correlation_id,payload) values($1,'notifications.scenario.changed.v1',$2,$3,$4::jsonb)`,
          [input.tenantId, id, input.correlationId, JSON.stringify({ scenarioId: id, version })],
        );
        return response;
      });
    },
    runs(tenantId, scenarioId) {
      return withTenantTransaction(pool, tenantId, async (client) => {
        const result = await client.query<RunRow>(
          `select r.*,coalesce((select jsonb_agg(x) from (select channel,state,count(*)::integer count from notifications.deliveries d where d.tenant_id=r.tenant_id and d.intent_id=r.intent_id group by channel,state) x),'[]'::jsonb) delivery_states from notifications.scenario_runs r where r.tenant_id=$1 and ($2::uuid is null or r.scenario_id=$2) order by r.created_at desc,r.id desc limit 100`,
          [tenantId, scenarioId ?? null],
        );
        return result.rows.map((r) => ({
          id: r.id,
          scenarioId: r.scenario_id,
          scenarioVersion: r.scenario_version,
          recipientUserId: r.recipient_user_id,
          targetId: r.target_id,
          state: r.state,
          reason: r.reason,
          dueAt: new Date(r.due_at).toISOString(),
          expiresAt: new Date(r.expires_at).toISOString(),
          goalState: r.goal_state,
          goalAchievedAt: r.goal_achieved_at ? new Date(r.goal_achieved_at).toISOString() : null,
          deliveryStates: r.delivery_states,
        }));
      });
    },
  };
}

/** Shared cancellation roll-up for the CUP command and source-event executor. */
export async function resolveScenarioIntentStates(
  client: PoolClient,
  tenantId: string,
  intentIds: readonly string[],
): Promise<void> {
  if (!intentIds.length) return;
  await client.query(
    `with states as (
    select intent_id,bool_or(state in ('PENDING','SENDING')) pending,bool_or(state in ('SENT','DELIVERED')) delivered,bool_or(state in ('FAILED','DEAD')) failed,bool_or(state='SUPPRESSED') suppressed
    from notifications.deliveries where tenant_id=$1 and intent_id=any($2::uuid[]) group by intent_id
  ) update notifications.intents i set state=case when s.pending then 'PROCESSING' when s.delivered and (s.failed or s.suppressed) then 'PARTIAL' when s.delivered then 'DELIVERED' when s.failed then 'FAILED' else 'SUPPRESSED' end,completed_at=case when s.pending then null else clock_timestamp() end from states s where i.tenant_id=$1 and i.id=s.intent_id`,
    [tenantId, [...new Set(intentIds)]],
  );
}
