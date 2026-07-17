import type { HomeProjectionComponent, HomeProjectionEvent } from '@phub/home-projection';
import { describe, expect, it, vi } from 'vitest';

import { applyHomeProjectionEvent, isVivaHomeSourceBatchCoherent } from './home-projector.js';

const tenantId = '86afbe01-0318-4dd2-bc25-303b7bf0d430';
const userId = '49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca';
const event: HomeProjectionEvent = {
  id: '11111111-1111-4111-8111-111111111111',
  type: 'home.projection.component.changed.v1',
  aggregateId: userId,
  tenantId,
  occurredAt: '2026-07-15T12:00:00.000Z',
  correlationId: 'home-projector-test-123',
  payload: {
    userId,
    component: 'messaging',
    componentRevision: '2',
    value: { unreadChats: 3 },
  },
};

const componentRows = [
  {
    component: 'profile',
    component_revision: '1',
    payload: {
      userId,
      displayName: 'Алексей',
      firstName: 'Алексей',
      avatarUrl: null,
      phoneLast4: '3190',
      balanceMinor: 0,
      currency: 'RUB',
      level: { label: 'D', value: 0, assessmentRequired: true },
    },
  },
  { component: 'messaging', component_revision: '2', payload: { unreadChats: 3 } },
  { component: 'upcoming', component_revision: '1', payload: [] },
  { component: 'subscriptions', component_revision: '1', payload: [] },
  { component: 'communities', component_revision: '1', payload: [] },
  {
    component: 'promotion',
    component_revision: '1',
    payload: { rotationEnabled: false, intervalSeconds: 6, items: [] },
  },
  { component: 'locations', component_revision: '1', payload: [] },
  {
    component: 'navigation',
    component_revision: '1',
    payload: { quickActions: [], additionalLinks: [] },
  },
  {
    component: 'capabilities',
    component_revision: '1',
    payload: {
      canCreateGame: true,
      canManageTournaments: false,
      canViewCommunities: true,
    },
  },
].map((row) => ({
  ...row,
  payload_checksum: 'a'.repeat(64),
  occurred_at: new Date('2026-07-15T12:00:00.000Z'),
}));

describe('Home projector transaction', () => {
  it('waits for one coherent Viva source batch before rebuilding', () => {
    const sourceTimes = componentRows.map((row) => ({
      component: row.component as HomeProjectionComponent,
      occurred_at: row.occurred_at,
    }));
    expect(isVivaHomeSourceBatchCoherent(sourceTimes)).toBe(true);
    expect(
      isVivaHomeSourceBatchCoherent(
        sourceTimes.map((row) =>
          row.component === 'profile'
            ? { ...row, occurred_at: new Date('2026-07-15T12:01:00.000Z') }
            : row,
        ),
      ),
    ).toBe(false);
  });
  it('stores the component, rebuilds a snapshot and records inbox/audit atomically', async () => {
    const query = vi.fn((text: string, values: readonly unknown[] = []) => {
      if (
        text === 'begin' ||
        text === 'commit' ||
        text === 'rollback' ||
        text.includes("set_config('app.tenant_id'") ||
        text.includes('pg_advisory_xact_lock')
      ) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (text.includes('insert into audit.inbox_events')) {
        return Promise.resolve({ rows: [{ event_id: event.id }], rowCount: 1 });
      }
      if (text.includes('insert into home.dashboard_components')) {
        return Promise.resolve({ rows: [componentRows[1]], rowCount: 1 });
      }
      if (text.includes('from home.dashboard_components') && text.includes('order by component')) {
        return Promise.resolve({ rows: componentRows, rowCount: componentRows.length });
      }
      if (text.includes('from home.dashboard_snapshots') && text.includes('for update')) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (
        text.includes('insert into home.dashboard_snapshots') ||
        text.includes('insert into audit.audit_log') ||
        text.includes('update audit.inbox_events')
      ) {
        return Promise.resolve({ rows: [], rowCount: 1 });
      }
      throw new Error(`Unexpected query: ${text} ${JSON.stringify(values)}`);
    });
    const release = vi.fn();
    const pool = { connect: vi.fn().mockResolvedValue({ query, release }) };

    await expect(
      applyHomeProjectionEvent({
        pool: pool as never,
        event,
        ttlSeconds: 300,
        now: new Date('2026-07-15T12:00:00.000Z'),
      }),
    ).resolves.toEqual({
      outcome: 'projected',
      component: 'messaging',
      sourceRevision: '1',
      snapshotVersion: 'home-v1-1',
    });

    expect(query).toHaveBeenCalledWith("select set_config('app.tenant_id', $1, true)", [tenantId]);
    expect(
      query.mock.calls.some(([text]) => String(text).includes('insert into audit.audit_log')),
    ).toBe(true);
    expect(release).toHaveBeenCalledOnce();
  });

  it('acks a previously consumed event without rebuilding', async () => {
    const query = vi.fn((text: string) => {
      if (
        text === 'begin' ||
        text === 'commit' ||
        text.includes("set_config('app.tenant_id'") ||
        text.includes('pg_advisory_xact_lock')
      ) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (text.includes('insert into audit.inbox_events')) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const pool = {
      connect: vi.fn().mockResolvedValue({ query, release: vi.fn() }),
    };

    await expect(
      applyHomeProjectionEvent({ pool: pool as never, event, ttlSeconds: 300 }),
    ).resolves.toEqual({ outcome: 'duplicate' });
    expect(query.mock.calls.some(([text]) => String(text).includes('dashboard_components'))).toBe(
      false,
    );
  });
});
