import { describe, expect, it, vi } from 'vitest';

import { listDueHomeBaseUsers, projectHomeBaseUser } from '@phub/database';

const tenantId = '86afbe01-0318-4dd2-bc25-303b7bf0d430';
const userId = '49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca';

describe('HomeBase local projector', () => {
  it('selects all active users while prioritizing a current Viva delegation', async () => {
    const sql: string[] = [];
    const query = vi.fn((text: string, values: readonly unknown[] = []) => {
      sql.push(text);
      if (
        text === 'begin' ||
        text === 'commit' ||
        text === 'rollback' ||
        text.includes("set_config('app.tenant_id'")
      ) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (text.includes('from identity.users identity_user')) {
        expect(values).toEqual([
          tenantId,
          new Date('2026-07-29T11:58:00.000Z'),
          20,
          '1785326400000',
        ]);
        return Promise.resolve({ rows: [{ user_id: userId }], rowCount: 1 });
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const pool = { connect: vi.fn().mockResolvedValue({ query, release: vi.fn() }) };

    await expect(
      listDueHomeBaseUsers({
        pool: pool as never,
        tenantId,
        dueBefore: new Date('2026-07-29T11:58:00.000Z'),
        limit: 20,
        cycleSeed: '1785326400000',
      }),
    ).resolves.toEqual([{ userId }]);

    expect(sql.join('\n')).toContain('integration.user_delegations');
    expect(sql.join('\n')).not.toMatch(
      /where[\s\S]*identity_user\.status = 'ACTIVE'[\s\S]*and exists/i,
    );
    expect(sql.join('\n')).toContain('snapshot.checked_at');
    expect(sql.join('\n')).toContain('hashtextextended(identity_user.id::text, $4::bigint)');
  });

  it('isolates invalid optional sources and still projects the local base', async () => {
    const sql: string[] = [];
    const query = vi.fn((text: string, values: readonly unknown[] = []) => {
      sql.push(text);
      if (
        text === 'begin isolation level repeatable read' ||
        text === 'commit' ||
        text === 'rollback' ||
        text.includes("set_config('app.tenant_id'") ||
        text.includes('pg_advisory_xact_lock')
      ) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (text.includes('from locations.profiles')) {
        expect(values).toEqual([tenantId]);
        return Promise.resolve({
          rows: [
            {
              id: '11111111-1111-4111-8111-111111111111',
              title: 'Селигерская',
              short_title: null,
              court_count: 3,
              gallery: [],
            },
          ],
          rowCount: 1,
        });
      }
      if (text.includes('from identity.users identity_user')) {
        expect(values).toEqual([tenantId, userId]);
        return Promise.resolve({
          rows: [{ roles: ['client'], permissions: ['profile.read', 'games.play'] }],
          rowCount: 1,
        });
      }
      if (text.includes('from integration.community_home_source_components')) {
        return Promise.resolve({
          rows: [
            {
              source_revision: '5',
              payload: { unexpected: true },
              fetched_at: new Date('2026-07-29T11:59:00.000Z'),
            },
          ],
          rowCount: 1,
        });
      }
      if (text.includes('from integration.promotion_home_source_components')) {
        return Promise.resolve({
          rows: [
            {
              source_revision: '8',
              payload: { hero: 'invalid', standard: null },
              fetched_at: new Date('2026-07-29T11:59:00.000Z'),
            },
          ],
          rowCount: 1,
        });
      }
      if (text.includes('from home.base_snapshots') && text.includes('for update')) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (text.includes('insert into home.base_snapshots')) {
        const payload = JSON.parse(String(values[5])) as Record<string, unknown>;
        expect(payload).not.toHaveProperty('profile');
        expect(payload).not.toHaveProperty('upcoming');
        expect(payload).not.toHaveProperty('subscriptions');
        expect(payload).not.toHaveProperty('counters');
        expect(payload).toMatchObject({
          viewerUserId: userId,
          communities: { status: 'UNAVAILABLE' },
          promotions: { status: 'UNAVAILABLE' },
        });
        return Promise.resolve({ rows: [], rowCount: 1 });
      }
      if (text.includes('insert into audit.audit_log')) {
        return Promise.resolve({ rows: [], rowCount: 1 });
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const pool = { connect: vi.fn().mockResolvedValue({ query, release: vi.fn() }) };

    await expect(
      projectHomeBaseUser({
        pool: pool as never,
        tenantId,
        userId,
        correlationId: 'home-base-test-123',
        ttlSeconds: 300,
        now: new Date('2026-07-29T12:00:00.000Z'),
      }),
    ).resolves.toMatchObject({
      outcome: 'projected',
      sourceRevision: '1',
      snapshotVersion: 'home-base-v1-1',
      communities: 'UNAVAILABLE',
      promotions: 'UNAVAILABLE',
      invalidSections: ['communities', 'promotions'],
    });

    expect(sql.join('\n')).not.toContain('viva_home_source_components');
  });

  it('does not rewrite or audit an unchanged projection', async () => {
    let persistedPayload: unknown;
    let insertCount = 0;
    let auditCount = 0;
    let watermarkCount = 0;
    const query = vi.fn((text: string, values: readonly unknown[] = []) => {
      if (
        text === 'begin isolation level repeatable read' ||
        text === 'commit' ||
        text === 'rollback' ||
        text.includes("set_config('app.tenant_id'") ||
        text.includes('pg_advisory_xact_lock')
      ) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (text.includes('from locations.profiles')) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (text.includes('from identity.users identity_user')) {
        return Promise.resolve({
          rows: [{ roles: ['client'], permissions: ['profile.read', 'games.play'] }],
          rowCount: 1,
        });
      }
      if (text.includes('from integration.community_home_source_components')) {
        return Promise.resolve({
          rows: [
            {
              source_revision: '7',
              payload: [],
              fetched_at: new Date('2026-07-29T11:59:00.000Z'),
            },
          ],
          rowCount: 1,
        });
      }
      if (text.includes('from integration.promotion_home_source_components')) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (text.includes('from home.base_snapshots') && text.includes('for update')) {
        return Promise.resolve({
          rows:
            persistedPayload === undefined
              ? []
              : [
                  {
                    source_revision: '1',
                    snapshot_version: 'home-base-v1-1',
                    payload: persistedPayload,
                  },
                ],
          rowCount: persistedPayload === undefined ? 0 : 1,
        });
      }
      if (text.includes('insert into home.base_snapshots')) {
        insertCount += 1;
        persistedPayload = JSON.parse(String(values[5]));
        return Promise.resolve({ rows: [], rowCount: 1 });
      }
      if (text.includes('insert into audit.audit_log')) {
        auditCount += 1;
        return Promise.resolve({ rows: [], rowCount: 1 });
      }
      if (text.includes('update home.base_snapshots') && text.includes('set checked_at')) {
        watermarkCount += 1;
        expect(values).toEqual([tenantId, userId, new Date('2026-07-29T12:05:00.000Z')]);
        return Promise.resolve({ rows: [], rowCount: 1 });
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const pool = { connect: vi.fn().mockResolvedValue({ query, release: vi.fn() }) };
    const input = {
      pool: pool as never,
      tenantId,
      userId,
      correlationId: 'home-base-unchanged-test',
      ttlSeconds: 300,
      now: new Date('2026-07-29T12:00:00.000Z'),
    };

    await expect(projectHomeBaseUser(input)).resolves.toMatchObject({ outcome: 'projected' });
    await expect(
      projectHomeBaseUser({
        ...input,
        now: new Date('2026-07-29T12:05:00.000Z'),
      }),
    ).resolves.toMatchObject({
      outcome: 'unchanged',
      sourceRevision: '1',
      snapshotVersion: 'home-base-v1-1',
    });
    expect(insertCount).toBe(1);
    expect(auditCount).toBe(1);
    expect(watermarkCount).toBe(1);
  });
});
