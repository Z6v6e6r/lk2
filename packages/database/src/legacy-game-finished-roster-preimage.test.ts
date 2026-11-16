import { expect, it, vi } from 'vitest';
import { readFinishedUnscoredUiPreimage } from './legacy-game-finished-roster-preimage.js';

function fixture() {
  const gameId = '11111111-1111-4111-8111-111111111111';
  const game = {
    id: gameId,
    revision: '3',
    lifecycle_state: 'FINISHED',
    result_state: 'AWAITING_SUBMISSION',
    starts_at: new Date('2026-11-16T06:00:00Z'),
    ends_at: new Date('2026-11-16T07:00:00Z'),
    started_at: new Date('2026-11-16T06:00:00Z'),
    finished_at: new Date('2026-11-16T07:00:00Z'),
    timezone: 'Europe/Moscow',
    capacity: 4,
  };
  const sync = {
    last_synced_game_revision: '1',
    mode: 'CONFLICT',
    conflict_code: 'LEGACY_GAME_ROSTER_BASELINE_MISMATCH',
    source_external_version: 'a'.repeat(64),
  };
  const commands = ['start', 'finish'].map((kind, i) => ({
    id: `command-${kind}`,
    command_type: `game.lifecycle.${kind}.v1`,
    state: 'COMPLETED',
    expected_revision: String(i + 1),
    attempts: 1,
    due_at: i ? game.ends_at : game.starts_at,
    completed_at: i ? game.ends_at : game.starts_at,
  }));
  const audits = ['STARTED', 'FINISHED'].map((phase, i) => ({
    id: `audit-${i}`,
    action: `GAME_LIFECYCLE_${phase}`,
    reason: 'SCHEDULED_COMMAND',
    correlation_id: `corr-${i}`,
    old_value: { revision: i + 1, lifecycleState: i ? 'IN_PROGRESS' : 'SCHEDULED' },
    new_value: { revision: i + 2, lifecycleState: i ? 'FINISHED' : 'IN_PROGRESS' },
  }));
  const events = ['started', 'finished'].map((kind, i) => ({
    id: `event-${i}`,
    event_type: `game.${kind}.v1`,
    correlation_id: `corr-${i}`,
    payload: { gameId, aggregateRevision: String(i + 2), causationId: commands[i]!.id },
  }));
  const residue = { result_residue: false },
    clock = { server_now: new Date('2026-11-16T08:00:00Z') };
  const query = vi.fn(async (sql: string) => {
    await Promise.resolve();
    return {
      rows: sql.includes('from games.scheduled_commands')
        ? commands
        : sql.includes('from games.games')
          ? [game]
          : sql.includes('from integration.legacy_game_roster_sync_state')
            ? [sync]
            : sql.includes('select exists(')
              ? [residue]
              : sql.includes('from audit.audit_log')
                ? audits
                : sql.includes('from audit.outbox_events')
                  ? events
                  : sql.includes('clock_timestamp()')
                    ? [clock]
                    : [],
    };
  });
  return {
    gameId,
    game,
    sync,
    commands,
    audits,
    events,
    residue,
    clock,
    query,
    read: (lock = false) =>
      readFinishedUnscoredUiPreimage({ query } as never, {
        tenantId: 'synthetic-tenant',
        gameId,
        lock,
      }),
  };
}
it('binds the exact native finished lineage without changing time, state or emitting events', async () => {
  const f = fixture(),
    first = await f.read(true);
  expect(first).toMatchObject({ revision: 3, syncRevision: 1, checkedAt: f.clock.server_now });
  f.clock.server_now = new Date('2026-11-16T08:05:00Z');
  expect((await f.read()).sha256).toBe(first.sha256);
  expect(f.query.mock.calls[0]![0]).toContain('for update nowait');
  expect(f.query.mock.calls[1]![0]).toContain('for update');
  expect(
    f.query.mock.calls.every(([sql]) => !/(insert into|update games\.|delete from)/u.test(sql)),
  ).toBe(true);
});
it.each([
  'in-progress',
  'result-state',
  'revision',
  'mode',
  'command-pending',
  'missing-command',
  'extra-command',
  'wrong-due',
  'wrong-started',
  'audit-reason',
  'audit-revision',
  'audit-phase',
  'event-revision',
  'event-cause',
  'event-correlation',
  'result-residue',
  'before-end',
  'at-deadline',
  'after-deadline',
  'invalid-clock',
])('refuses finished recovery on %s', async (scenario) => {
  const f = fixture();
  switch (scenario) {
    case 'in-progress':
      f.game.lifecycle_state = 'IN_PROGRESS';
      break;
    case 'result-state':
      f.game.result_state = 'SUBMITTED';
      break;
    case 'revision':
      f.game.revision = '4';
      break;
    case 'mode':
      f.sync.mode = 'MIRROR';
      break;
    case 'command-pending':
      f.commands[1]!.state = 'PENDING';
      break;
    case 'missing-command':
      f.commands.pop();
      break;
    case 'extra-command':
      f.commands.push({ ...f.commands[0]!, id: 'duplicate' });
      break;
    case 'wrong-due':
      f.commands[0]!.due_at = new Date('2026-11-16T06:01:00Z');
      break;
    case 'wrong-started':
      f.game.started_at = new Date('2026-11-16T06:01:00Z');
      break;
    case 'audit-reason':
      f.audits[0]!.reason = 'OPERATOR';
      break;
    case 'audit-revision':
      f.audits[0]!.new_value.revision = 4;
      break;
    case 'audit-phase':
      f.audits[0]!.old_value.lifecycleState = 'FINISHED';
      break;
    case 'event-revision':
      f.events[0]!.payload.aggregateRevision = '4';
      break;
    case 'event-cause':
      f.events[1]!.payload.causationId = 'other';
      break;
    case 'event-correlation':
      f.events[0]!.correlation_id = 'other';
      break;
    case 'result-residue':
      f.residue.result_residue = true;
      break;
    case 'before-end':
      f.clock.server_now = new Date('2026-11-16T06:59:59Z');
      break;
    case 'at-deadline':
      f.clock.server_now = new Date('2026-11-16T19:00:00Z');
      break;
    case 'after-deadline':
      f.clock.server_now = new Date('2026-11-16T19:00:01Z');
      break;
    case 'invalid-clock':
      f.clock.server_now = new Date('invalid');
      break;
  }
  await expect(f.read()).rejects.toThrow('LEGACY_GAME_UI_FINISHED_');
});
