import { describe, expect, it, vi } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import {
  nextScenarioPushTime,
  scenarioDeliveryDueSql,
  ingestNotificationScenarioEvent,
  checkScenarioPushDelivery,
  refreshPreparingLegacyGameStartReminderTarget,
  terminalizeExpiredScenarioDispatches,
} from './notification-scenarios.js';

describe('scenario quiet hours', () => {
  it('defers a midnight window in the user timezone', () =>
    expect(
      nextScenarioPushTime(new Date('2026-10-21T21:30:00Z'), {
        quiet_from: '23:00',
        quiet_until: '08:00',
        timezone: 'Europe/Moscow',
      }).toISOString(),
    ).toBe('2026-10-22T05:00:00.000Z'));
  it('preserves an allowed instant without adding a delay', () => {
    const now = new Date('2026-10-21T12:00:00Z');
    expect(
      nextScenarioPushTime(now, {
        quiet_from: '23:00',
        quiet_until: '08:00',
        timezone: 'Europe/Moscow',
      }),
    ).toBe(now);
  });
  it('handles a spring DST gap using actual UTC instants', () =>
    expect(
      nextScenarioPushTime(new Date('2026-03-29T00:30:00Z'), {
        quiet_from: '22:00',
        quiet_until: '03:00',
        timezone: 'Europe/Berlin',
      }).toISOString(),
    ).toBe('2026-03-29T01:00:00.000Z'));
  it('handles the autumn repeated hour', () =>
    expect(
      nextScenarioPushTime(new Date('2026-10-25T00:30:00Z'), {
        quiet_from: '22:00',
        quiet_until: '03:00',
        timezone: 'Europe/Berlin',
      }).toISOString(),
    ).toBe('2026-10-25T02:00:00.000Z'));
  it('treats equal window endpoints as no quiet hours', () => {
    const now = new Date();
    expect(
      nextScenarioPushTime(now, {
        quiet_from: '08:00',
        quiet_until: '08:00',
        timezone: 'Europe/Moscow',
      }),
    ).toBe(now);
  });
});
function pool(rows: (sql: string) => unknown[]) {
  const query = vi.fn((sql: string) => Promise.resolve({ rows: rows(sql), rowCount: 1 }));
  const release = vi.fn();
  return {
    pool: { connect: () => Promise.resolve({ query, release }) } as unknown as Pool,
    query,
    release,
  };
}
describe('scenario execution guards', () => {
  it('rejects unsupported source events before opening a connection', async () => {
    const connect = vi.fn();
    await expect(
      ingestNotificationScenarioEvent({ connect } as never, {
        id: '11111111-1111-4111-8111-111111111111',
        type: 'unknown.event.v1',
        tenantId: '22222222-2222-4222-8222-222222222222',
        aggregateId: '33333333-3333-4333-8333-333333333333',
        occurredAt: new Date().toISOString(),
        correlationId: 'scenario-test',
        payload: {},
      }),
    ).rejects.toThrow('SCENARIO_EVENT_UNSUPPORTED');
    expect(connect).not.toHaveBeenCalled();
  });
  it('does not query optional scenario tables for a legacy delivery', async () => {
    const fixture = pool((sql) => (sql.includes('render_data') ? [{ run_id: null }] : []));
    expect(
      await checkScenarioPushDelivery({
        pool: fixture.pool,
        tenantId: 'tenant',
        deliveryId: 'delivery',
        attemptNo: 1,
        enabled: false,
      }),
    ).toBe('SEND');
    expect(fixture.query.mock.calls.some(([sql]) => sql.includes('scenario_runs'))).toBe(false);
    expect(fixture.release).toHaveBeenCalled();
  });
  it('rolls back and releases a connection on policy lookup failure', async () => {
    const fixture = pool((sql) => {
      if (sql.includes('render_data')) throw new Error('offline');
      return [];
    });
    await expect(
      checkScenarioPushDelivery({
        pool: fixture.pool,
        tenantId: 'tenant',
        deliveryId: 'delivery',
        attemptNo: 1,
        enabled: true,
      }),
    ).rejects.toThrow('offline');
    expect(fixture.query).toHaveBeenCalledWith('rollback');
    expect(fixture.release).toHaveBeenCalled();
  });

  it('fails source finalization instead of silently skipping a stale preparing generation', async () => {
    const query = vi.fn((sql: string) => {
      if (sql.includes('from games.games game'))
        return Promise.resolve({
          rows: [
            {
              revision: '1',
              title: 'Legacy game',
              starts_at: new Date('2026-11-01T18:00:00Z'),
              lifecycle_state: 'SCHEDULED',
              location_name: 'Club',
              legacy_source: true,
              legacy_mapping: true,
            },
          ],
          rowCount: 1,
        });
      if (sql.includes('from notifications.legacy_game_reminder_sources source'))
        return Promise.resolve({
          rows: [
            {
              source_revision: '3',
              title: 'Legacy game',
              starts_at: new Date('2026-11-01T18:00:00Z'),
              location_name: 'Club',
              source_state: 'SCHEDULED',
              source_checked_at: new Date('2026-11-01T11:59:00Z'),
              status_checked_at: null,
              healthy: false,
              source_generation_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
              status_generation_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
              error_code: 'REFRESH_IN_PROGRESS',
            },
          ],
          rowCount: 1,
        });
      return Promise.resolve({ rows: [], rowCount: 0 });
    });
    await expect(
      refreshPreparingLegacyGameStartReminderTarget({ query } as unknown as PoolClient, {
        tenantId: '22222222-2222-4222-8222-222222222222',
        gameId: '33333333-3333-4333-8333-333333333333',
        generationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        sourceEventId: '44444444-4444-4444-8444-444444444444',
        occurredAt: new Date('2026-11-01T12:00:00Z'),
        maxLegacySourceAgeMs: 600_000,
      }),
    ).rejects.toThrow('LEGACY_GAME_REMINDER_PREPARING_TARGET_UNAVAILABLE');
    expect(
      query.mock.calls.some(([sql]) => String(sql).includes('games.participations participant')),
    ).toBe(false);
  });
});

describe('mixed-fleet scenario delivery fence', () => {
  it('makes the old/disabled selector independent of the new schema', () => {
    expect(scenarioDeliveryDueSql(false)).toBe('d.next_attempt_at <= now()');
    expect(scenarioDeliveryDueSql()).not.toContain('scenario_available_at');
  });
  it('requires a canonical run and legacy infinity before selecting a scenario', () => {
    const sql = scenarioDeliveryDueSql(true);
    expect(sql).toContain('coalesce(d.scenario_v2_available_at,d.scenario_available_at) <= now()');
    expect(sql).toContain("d.next_attempt_at='infinity'::timestamptz");
    expect(sql).toContain('scenario_run.intent_id=d.intent_id');
    expect(sql).toContain('scenario_run.tenant_id=d.tenant_id');
  });
  it('terminalizes an expired fenced provider call instead of making it reclaimable', async () => {
    const calls: { sql: string; values: readonly unknown[] }[] = [];
    const startedAt = new Date('2026-11-01T12:00:00Z');
    const query = vi.fn((sql: string, values: readonly unknown[] = []) => {
      calls.push({ sql, values });
      if (sql.includes("set state='DEAD'"))
        return Promise.resolve({
          rows: [
            {
              id: '11111111-1111-4111-8111-111111111111',
              intent_id: '22222222-2222-4222-8222-222222222222',
              attempt_count: 1,
              scenario_dispatch_started_at: startedAt,
            },
          ],
          rowCount: 1,
        });
      return Promise.resolve({ rows: [], rowCount: 1 });
    });
    await expect(
      terminalizeExpiredScenarioDispatches({ query } as never, {
        tenantId: '33333333-3333-4333-8333-333333333333',
        provider: 'WEB_PUSH',
        platform: 'WEB',
        appId: 'padlhub-web',
        environment: 'PRODUCTION',
      }),
    ).resolves.toBe(1);
    const terminal = calls.find(({ sql }) => sql.includes("set state='DEAD'"));
    expect(terminal?.sql).toContain('scenario_dispatch_started_at is not null');
    expect(terminal?.values).toContain('WEB_PUSH_OUTCOME_UNKNOWN');
    const attempt = calls.find(({ sql }) => sql.includes('delivery_attempts'));
    expect(attempt?.values).toEqual([
      '33333333-3333-4333-8333-333333333333',
      '11111111-1111-4111-8111-111111111111',
      1,
      'WEB_PUSH_OUTCOME_UNKNOWN',
      startedAt,
    ]);
  });
});
