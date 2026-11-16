import { createHash } from 'node:crypto';
import type { PoolClient, QueryResultRow } from 'pg';
import { GAME_RESULT_WINDOW_HOURS } from '@phub/games';
export interface FinishedUnscoredUiPreimage {
  readonly sha256: string;
  readonly revision: number;
  readonly syncRevision: number;
  readonly checkedAt: Date;
}
function need(v: unknown, code: string): asserts v {
  if (!v) throw new Error('LEGACY_GAME_UI_FINISHED_' + code);
}
interface PhaseGame extends QueryResultRow {
  id: string;
  revision: string;
  lifecycle_state: string;
  result_state: string;
  starts_at: Date;
  ends_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  timezone: string;
  capacity: number;
}
interface PhaseCommand extends QueryResultRow {
  id: string;
  command_type: string;
  state: string;
  expected_revision: string;
  attempts: number;
  due_at: Date;
  completed_at: Date | null;
}
interface PhaseAudit extends QueryResultRow {
  id: string;
  action: string;
  reason: string;
  correlation_id: string;
  old_value: { revision: number; lifecycleState: string };
  new_value: { revision: number; lifecycleState: string };
}
interface PhaseEvent extends QueryResultRow {
  id: string;
  event_type: string;
  correlation_id: string;
  payload: { gameId: string; aggregateRevision: string; causationId: string };
}
/** One exact finished, unscored, still-open result window. This never advances lifecycle or time.
 * With lock=true the command->game order matches the lifecycle executor and blocks result submit. */
export async function readFinishedUnscoredUiPreimage(
  client: PoolClient,
  input: { tenantId: string; gameId: string; lock: boolean },
): Promise<FinishedUnscoredUiPreimage> {
  const args = [input.tenantId, input.gameId];
  const commands = (
    await client.query<PhaseCommand>(
      `select id,command_type,state,expected_revision,attempts,due_at,completed_at
 from games.scheduled_commands where tenant_id=$1 and game_id=$2 and command_type in('game.lifecycle.start.v1','game.lifecycle.finish.v1')
 order by id limit 3${input.lock ? ' for update nowait' : ''}`,
      args,
    )
  ).rows;
  const game = (
    await client.query<PhaseGame>(
      `select id,revision,lifecycle_state,result_state,starts_at,ends_at,started_at,finished_at,timezone,capacity
 from games.games where tenant_id=$1 and id=$2${input.lock ? ' for update' : ''}`,
      args,
    )
  ).rows[0];
  const sync = (
    await client.query<
      {
        last_synced_game_revision: string;
        mode: string;
        conflict_code: string | null;
        source_external_version: string;
      } & QueryResultRow
    >(
      `select last_synced_game_revision,mode,conflict_code,source_external_version from integration.legacy_game_roster_sync_state where tenant_id=$1 and game_id=$2${input.lock ? ' for update' : ''}`,
      args,
    )
  ).rows[0];
  need(game && sync, 'TARGET');
  const revision = Number(game.revision),
    baseline = Number(sync.last_synced_game_revision);
  need(
    game.lifecycle_state === 'FINISHED' &&
      game.result_state === 'AWAITING_SUBMISSION' &&
      game.started_at !== null &&
      game.finished_at !== null,
    'STATE',
  );
  need(
    Number.isSafeInteger(revision) &&
      Number.isSafeInteger(baseline) &&
      baseline > 0 &&
      revision === baseline + 2 &&
      sync.mode === 'CONFLICT' &&
      [
        'LEGACY_GAME_ROSTER_BASELINE_MISMATCH',
        'LEGACY_GAME_ROSTER_REPAIR_REQUIRES_LOCAL_REMOVAL',
      ].includes(sync.conflict_code ?? ''),
    'PREDECESSOR',
  );
  need(
    commands.length === 2 &&
      commands.every((c) => c.state === 'COMPLETED' && c.completed_at !== null),
    'COMMANDS',
  );
  const start = commands.find((c) => c.command_type === 'game.lifecycle.start.v1'),
    finish = commands.find((c) => c.command_type === 'game.lifecycle.finish.v1');
  need(
    start &&
      finish &&
      Number(start.expected_revision) === baseline &&
      Number(finish.expected_revision) === baseline + 1,
    'COMMANDS',
  );
  need(
    new Date(game.started_at).getTime() === new Date(game.starts_at).getTime() &&
      new Date(game.finished_at).getTime() === new Date(game.ends_at).getTime() &&
      new Date(start.due_at).getTime() === new Date(game.starts_at).getTime() &&
      new Date(finish.due_at).getTime() === new Date(game.ends_at).getTime(),
    'SCHEDULE',
  );
  const audits = (
    await client.query<PhaseAudit>(
      `select id,action,reason,correlation_id,old_value,new_value from audit.audit_log
 where tenant_id=$1 and resource_id=$2 and result='SUCCESS' and action in('GAME_LIFECYCLE_STARTED','GAME_LIFECYCLE_FINISHED') order by occurred_at,id limit 3`,
      args,
    )
  ).rows;
  const events = (
    await client.query<PhaseEvent>(
      `select id,event_type,correlation_id,payload from audit.outbox_events
 where tenant_id=$1 and aggregate_id=$2 and event_type in('game.started.v1','game.finished.v1') order by occurred_at,id limit 3`,
      args,
    )
  ).rows;
  need(audits.length === 2 && events.length === 2, 'PREDECESSOR');
  for (const [action, type, before, after, phase, oldPhase, command] of [
    [
      'GAME_LIFECYCLE_STARTED',
      'game.started.v1',
      baseline,
      baseline + 1,
      'IN_PROGRESS',
      'SCHEDULED',
      start,
    ],
    [
      'GAME_LIFECYCLE_FINISHED',
      'game.finished.v1',
      baseline + 1,
      revision,
      'FINISHED',
      'IN_PROGRESS',
      finish,
    ],
  ] as const) {
    const a = audits.find((a) => a.action === action),
      e = events.find((e) => e.event_type === type);
    need(
      a &&
        e &&
        a.reason === 'SCHEDULED_COMMAND' &&
        Number(a.old_value.revision) === before &&
        Number(a.new_value.revision) === after &&
        a.old_value.lifecycleState === oldPhase &&
        a.new_value.lifecycleState === phase &&
        e.correlation_id === a.correlation_id &&
        e.payload.gameId === input.gameId &&
        Number(e.payload.aggregateRevision) === after &&
        e.payload.causationId === command.id,
      'PREDECESSOR',
    );
  }
  const tables = [
    'games.result_submissions',
    'games.result_submission_reviews',
    'games.results',
    'games.result_sets',
    'games.result_set_players',
    'games.player_set_facts',
  ];
  const residue = (
    await client.query<{ result_residue: boolean } & QueryResultRow>(
      `select exists(
 ${tables.map((t) => `select 1 from ${t} where tenant_id=$1 and game_id=$2`).join(' union all ')}
 union all select 1 from audit.audit_log where tenant_id=$1 and resource_id=$2 and result='SUCCESS' and action like 'GAME_RESULT%'
 union all select 1 from audit.outbox_events where tenant_id=$1 and aggregate_id=$2 and event_type like 'game.result.%'
 union all select 1 from audit.inbox_events i join audit.outbox_events o on o.tenant_id=i.tenant_id and o.id=i.event_id where i.tenant_id=$1 and o.aggregate_id=$2 and o.event_type like 'game.result.%'
 union all select 1 from booking.activity_history_projection where tenant_id=$1 and game_id=$2 and source_revision like 'game-result:%'
 ) as result_residue`,
      args,
    )
  ).rows[0];
  need(residue?.result_residue === false, 'RESULT_EXISTS');
  const clock = (
    await client.query<{ server_now: Date } & QueryResultRow>(
      'select clock_timestamp() as server_now',
    )
  ).rows[0];
  need(clock, 'CLOCK');
  const checkedAt = new Date(clock.server_now),
    ends = new Date(game.ends_at).getTime();
  need(
    Number.isFinite(checkedAt.getTime()) &&
      checkedAt.getTime() >= ends &&
      checkedAt.getTime() < ends + GAME_RESULT_WINDOW_HOURS * 3600000,
    'WINDOW',
  );
  return {
    revision,
    syncRevision: baseline,
    checkedAt,
    sha256: createHash('sha256')
      .update(
        JSON.stringify({
          policy: 'EXACT_UI_PROOF_FINISHED_UNSCORED',
          game,
          sync,
          commands,
          audits,
          events,
          resultResidue: false,
        }),
      )
      .digest('hex'),
  };
}
