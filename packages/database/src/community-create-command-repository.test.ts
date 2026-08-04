import { describe, expect, it, vi } from 'vitest';

import { createCommunityCreateRepository } from './community-create-command-repository.js';

const input = {
  tenantId: '86afbe01-0318-4dd2-bc25-303b7bf0d430',
  actorUserId: '49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca',
  title: 'Padel Moscow',
  description: 'Community description',
  visibility: 'PUBLIC',
  joinPolicy: 'MODERATED',
  publishingPreset: 'STAFF_FEED',
  quotaOverride: false,
  idempotencyKey: 'community-create-test-0001',
  requestHash: 'a'.repeat(64),
  correlationId: 'community-create-correlation',
} as const;

const createdAt = new Date('2026-08-03T10:00:00.000Z');
const communityRow = {
  id: '11111111-1111-4111-8111-111111111111',
  title: input.title,
  description: input.description,
  visibility: input.visibility,
  join_policy: input.joinPolicy,
  publishing_preset: input.publishingPreset,
  status: 'ACTIVE',
  revision: 1,
  created_by: input.actorUserId,
  created_at: createdAt,
  updated_at: createdAt,
};

const storedCommunity = {
  id: communityRow.id,
  title: input.title,
  description: input.description,
  visibility: input.visibility,
  joinPolicy: input.joinPolicy,
  publishingPreset: input.publishingPreset,
  status: 'ACTIVE',
  revision: 1,
  ownerUserId: input.actorUserId,
  createdAt: createdAt.toISOString(),
  updatedAt: createdAt.toISOString(),
};

function poolWithQuery(handler: (text: string, values: readonly unknown[]) => unknown) {
  const query = vi.fn((text: string, values: readonly unknown[] = []) => {
    if (text === 'begin' || text === 'commit' || text === 'rollback') {
      return Promise.resolve({ rows: [] });
    }
    if (text.includes("set_config('app.tenant_id'")) return Promise.resolve({ rows: [] });
    return Promise.resolve({ rows: (handler(text, values) as readonly unknown[]) ?? [] });
  });
  const pool = { connect: vi.fn().mockResolvedValue({ query, release: vi.fn() }) };
  return { pool: pool as never, query };
}

function successfulPool() {
  return poolWithQuery((text, values) => {
    if (text.includes('select request_hash')) return [];
    if (text.includes('from identity.users')) {
      expect(values).toEqual([input.tenantId, input.actorUserId]);
      return [{ status: 'ACTIVE' }];
    }
    if (text.includes('select count(*)::integer')) return [{ count: 2 }];
    if (text.includes('as retry_after_seconds')) return [];
    if (text.includes('insert into communities.communities')) return [communityRow];
    return [];
  });
}

describe('community create repository', () => {
  it('atomically creates the aggregate, owner, command, audit and outbox', async () => {
    const { pool, query } = successfulPool();

    await expect(createCommunityCreateRepository(pool).create(input)).resolves.toEqual({
      outcome: 'created',
      community: storedCommunity,
      replayed: false,
    });
    expect(query).toHaveBeenCalledWith("select set_config('app.tenant_id', $1, true)", [
      input.tenantId,
    ]);
    expect(
      query.mock.calls.some(([text]) =>
        String(text).includes('insert into communities.memberships'),
      ),
    ).toBe(true);
    expect(
      query.mock.calls.some(([text]) =>
        String(text).includes('insert into communities.create_commands'),
      ),
    ).toBe(true);
    expect(
      query.mock.calls.some(([text]) => String(text).includes('insert into audit.audit_log')),
    ).toBe(true);
    expect(
      query.mock.calls.some(([text]) => String(text).includes('insert into audit.outbox_events')),
    ).toBe(true);
    expect(query).toHaveBeenCalledWith('commit');
  });

  it('replays before actor and quota checks, and rejects a changed request hash', async () => {
    const matching = poolWithQuery((text) =>
      text.includes('select request_hash')
        ? [{ request_hash: input.requestHash, result_payload: storedCommunity }]
        : [],
    );
    await expect(createCommunityCreateRepository(matching.pool).create(input)).resolves.toEqual({
      outcome: 'created',
      community: storedCommunity,
      replayed: true,
    });
    expect(
      matching.query.mock.calls.some(([text]) => String(text).includes('from identity.users')),
    ).toBe(false);

    const conflict = poolWithQuery((text) =>
      text.includes('select request_hash')
        ? [{ request_hash: 'b'.repeat(64), result_payload: storedCommunity }]
        : [],
    );
    await expect(createCommunityCreateRepository(conflict.pool).create(input)).resolves.toEqual({
      outcome: 'idempotency_conflict',
    });
  });

  it('enforces active-owner and rolling daily quotas with a stable retry value', async () => {
    const ownerLimit = poolWithQuery((text) => {
      if (text.includes('select request_hash')) return [];
      if (text.includes('from identity.users')) return [{ status: 'ACTIVE' }];
      if (text.includes('select count(*)::integer')) return [{ count: 3 }];
      return [];
    });
    await expect(createCommunityCreateRepository(ownerLimit.pool).create(input)).resolves.toEqual({
      outcome: 'active_owner_quota_exceeded',
    });

    const dailyLimit = poolWithQuery((text) => {
      if (text.includes('select request_hash')) return [];
      if (text.includes('from identity.users')) return [{ status: 'ACTIVE' }];
      if (text.includes('select count(*)::integer')) return [{ count: 0 }];
      if (text.includes('as retry_after_seconds')) return [{ retry_after_seconds: 3_600 }];
      return [];
    });
    await expect(createCommunityCreateRepository(dailyLimit.pool).create(input)).resolves.toEqual({
      outcome: 'daily_create_quota_exceeded',
      retryAfterSeconds: 3_600,
    });
  });

  it('requires an active actor and lets only an authorized internal override bypass quotas', async () => {
    const inactive = poolWithQuery((text) => {
      if (text.includes('select request_hash')) return [];
      if (text.includes('from identity.users')) return [{ status: 'DISABLED' }];
      return [];
    });
    await expect(createCommunityCreateRepository(inactive.pool).create(input)).resolves.toEqual({
      outcome: 'actor_not_active',
    });

    const override = successfulPool();
    await expect(
      createCommunityCreateRepository(override.pool).create({ ...input, quotaOverride: true }),
    ).resolves.toMatchObject({ outcome: 'created', replayed: false });
    expect(
      override.query.mock.calls.some(([text]) => String(text).includes('select count(*)::integer')),
    ).toBe(false);
    expect(
      override.query.mock.calls.some(([text]) => String(text).includes('as retry_after_seconds')),
    ).toBe(false);
  });
});
