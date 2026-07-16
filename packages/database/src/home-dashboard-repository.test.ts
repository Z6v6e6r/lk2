import { describe, expect, it, vi } from 'vitest';

import { createHomeDashboardProjectionRepository } from './home-dashboard-repository.js';

const tenantId = '86afbe01-0318-4dd2-bc25-303b7bf0d430';
const userId = '49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca';
const sourceEventId = '55555555-5555-4555-8555-555555555555';
const generatedAt = '2026-07-15T10:00:00.000Z';
const staleAt = '2026-07-15T10:05:00.000Z';
const payload = {
  snapshot: {
    version: 'home-v1-42',
    generatedAt,
    staleAt,
    source: 'LOCAL_PROJECTION',
  },
  profile: { userId },
};

function projectionRow(overrides: Record<string, unknown> = {}) {
  return {
    tenant_id: tenantId,
    user_id: userId,
    source_revision: '42',
    source_event_id: sourceEventId,
    producer: 'HOME_IMPORT',
    snapshot_version: 'home-v1-42',
    payload,
    payload_checksum: 'a'.repeat(64),
    generated_at: new Date(generatedAt),
    stale_at: new Date(staleAt),
    updated_at: new Date(generatedAt),
    ...overrides,
  };
}

function repositoryWithQueries(
  handler: (text: string, values: readonly unknown[]) => { rows: unknown[] },
) {
  const query = vi.fn((text: string, values: readonly unknown[] = []) => {
    if (text === 'begin' || text === 'commit' || text === 'rollback') {
      return Promise.resolve({ rows: [] });
    }
    if (text.includes("set_config('app.tenant_id'")) return Promise.resolve({ rows: [] });
    return Promise.resolve(handler(text, values));
  });
  const release = vi.fn();
  const pool = { connect: vi.fn().mockResolvedValue({ query, release }) };
  return { repository: createHomeDashboardProjectionRepository(pool as never), query, release };
}

describe('Home dashboard projection repository', () => {
  it('reads one user snapshot under tenant RLS', async () => {
    const { repository, query } = repositoryWithQueries((text) => {
      if (text.includes('from home.dashboard_snapshots')) return { rows: [projectionRow()] };
      throw new Error(`Unexpected query: ${text}`);
    });

    await expect(repository.get(tenantId, userId)).resolves.toMatchObject({
      tenantId,
      userId,
      sourceRevision: '42',
      snapshotVersion: 'home-v1-42',
      generatedAt,
      staleAt,
    });
    expect(query).toHaveBeenCalledWith("select set_config('app.tenant_id', $1, true)", [tenantId]);
  });

  it('atomically applies a newer revision and writes metadata-only audit', async () => {
    const { repository, query } = repositoryWithQueries((text, values) => {
      if (text.includes('insert into home.dashboard_snapshots')) {
        const checksum = values[7];
        return { rows: [projectionRow({ payload_checksum: checksum })] };
      }
      if (text.includes('insert into audit.audit_log')) return { rows: [] };
      throw new Error(`Unexpected query: ${text}`);
    });

    await expect(
      repository.upsert({
        tenantId,
        userId,
        sourceRevision: '42',
        sourceEventId,
        producer: 'HOME_IMPORT',
        snapshotVersion: 'home-v1-42',
        payload,
        generatedAt,
        staleAt,
        correlationId: 'home-import-test-1234',
      }),
    ).resolves.toEqual({ outcome: 'applied', sourceRevision: '42' });

    const auditCall = query.mock.calls.find(([text]) =>
      String(text).includes('insert into audit.audit_log'),
    );
    expect(auditCall?.[1]).toContain('home-import-test-1234');
    expect(JSON.stringify(auditCall?.[1])).not.toContain('profile');
  });

  it('rejects a different payload at the same revision', async () => {
    const { repository } = repositoryWithQueries((text) => {
      if (text.includes('insert into home.dashboard_snapshots')) return { rows: [] };
      if (text.includes('from home.dashboard_snapshots')) return { rows: [projectionRow()] };
      throw new Error(`Unexpected query: ${text}`);
    });

    await expect(
      repository.upsert({
        tenantId,
        userId,
        sourceRevision: '42',
        sourceEventId,
        producer: 'HOME_IMPORT',
        snapshotVersion: 'home-v1-42',
        payload: { ...payload, changed: true },
        generatedAt,
        staleAt,
        correlationId: 'home-import-test-1234',
      }),
    ).resolves.toEqual({ outcome: 'revision_conflict', sourceRevision: '42' });
  });
});
