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
  idempotencyKey: 'community-create-test-0001',
  requestHash: 'a'.repeat(64),
  correlationId: 'community-create-correlation',
} as const;

const createdAt = new Date('2026-08-03T10:00:00.000Z');
const quotaGrantInput = {
  tenantId: input.tenantId,
  actorUserId: '44444444-4444-4444-8444-444444444444',
  subjectUserId: input.actorUserId,
  capability: 'communities.create.quota.override',
  scopes: ['ACTIVE_OWNER_LIMIT', 'DAILY_CREATE_LIMIT'],
  reasonCode: 'OPERATIONS_EXCEPTION',
  ticketId: 'CUP-1842',
  idempotencyKey: 'community-create-grant-0001',
  requestHash: 'b'.repeat(64),
  correlationId: 'community-create-grant-correlation',
} as const;
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
    if (text.includes('from communities.create_quota_grants')) return [];
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
      query.mock.calls.some(
        ([text, values]) =>
          String(text).includes('pg_advisory_xact_lock') &&
          values?.[0] === `community-owner-quota:${input.tenantId}:${input.actorUserId}`,
      ),
    ).toBe(true);
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

  it('requires an active actor', async () => {
    const inactive = poolWithQuery((text) => {
      if (text.includes('select request_hash')) return [];
      if (text.includes('from identity.users')) return [{ status: 'DISABLED' }];
      return [];
    });
    await expect(createCommunityCreateRepository(inactive.pool).create(input)).resolves.toEqual({
      outcome: 'actor_not_active',
    });
  });

  it('consumes a matching user-scoped grant only after the successful create writes', async () => {
    const grantId = '33333333-3333-4333-8333-333333333333';
    const grant = poolWithQuery((text) => {
      if (text.includes('select request_hash')) return [];
      if (text.includes('from identity.users')) return [{ status: 'ACTIVE' }];
      if (text.includes('select count(*)::integer')) return [{ count: 3 }];
      if (text.includes('as retry_after_seconds')) return [{ retry_after_seconds: 3_600 }];
      if (text.includes('from communities.create_quota_grants')) {
        return [
          {
            id: grantId,
            subject_user_id: input.actorUserId,
            authorized_by_user_id: '44444444-4444-4444-8444-444444444444',
            scopes: ['ACTIVE_OWNER_LIMIT', 'DAILY_CREATE_LIMIT'],
            state: 'ACTIVE',
            revision: 1,
            expires_at: new Date('2026-08-06T10:00:00.000Z'),
            created_at: createdAt,
            updated_at: createdAt,
            consumed_at: null,
          },
        ];
      }
      if (text.includes('insert into communities.communities')) return [communityRow];
      if (text.includes("set state = 'CONSUMED'")) {
        return [
          {
            id: grantId,
            subject_user_id: input.actorUserId,
            authorized_by_user_id: '44444444-4444-4444-8444-444444444444',
            scopes: ['ACTIVE_OWNER_LIMIT', 'DAILY_CREATE_LIMIT'],
            state: 'CONSUMED',
            revision: 2,
            expires_at: new Date('2026-08-06T10:00:00.000Z'),
            created_at: createdAt,
            updated_at: createdAt,
            consumed_at: createdAt,
          },
        ];
      }
      return [];
    });

    await expect(createCommunityCreateRepository(grant.pool).create(input)).resolves.toMatchObject({
      outcome: 'created',
      replayed: false,
    });
    const calls = grant.query.mock.calls.map(([text]) => String(text));
    expect(
      calls.findIndex((text) => text.includes('insert into communities.communities')),
    ).toBeLessThan(calls.findIndex((text) => text.includes("set state = 'CONSUMED'")));
    const command = grant.query.mock.calls.find(([text]) =>
      String(text).includes('insert into communities.create_commands'),
    );
    expect(command?.[1]).toContain(grantId);
  });

  it('does not consume a grant whose scopes do not cover every exceeded quota', async () => {
    const insufficient = poolWithQuery((text) => {
      if (text.includes('select request_hash')) return [];
      if (text.includes('from identity.users')) return [{ status: 'ACTIVE' }];
      if (text.includes('select count(*)::integer')) return [{ count: 3 }];
      if (text.includes('as retry_after_seconds')) return [{ retry_after_seconds: 3_600 }];
      if (text.includes('from communities.create_quota_grants')) {
        return [
          {
            id: '33333333-3333-4333-8333-333333333333',
            subject_user_id: input.actorUserId,
            authorized_by_user_id: '44444444-4444-4444-8444-444444444444',
            scopes: ['DAILY_CREATE_LIMIT'],
            state: 'ACTIVE',
            revision: 1,
            expires_at: new Date('2026-08-06T10:00:00.000Z'),
            created_at: createdAt,
            updated_at: createdAt,
            consumed_at: null,
          },
        ];
      }
      return [];
    });

    await expect(createCommunityCreateRepository(insufficient.pool).create(input)).resolves.toEqual(
      {
        outcome: 'active_owner_quota_exceeded',
      },
    );
    expect(
      insufficient.query.mock.calls.some(([text]) =>
        String(text).includes("set state = 'CONSUMED'"),
      ),
    ).toBe(false);
  });

  it('creates one audited 24-hour user-scoped grant with server capability evidence', async () => {
    const grantId = '33333333-3333-4333-8333-333333333333';
    const grant = poolWithQuery((text) => {
      if (text.includes('from communities.create_quota_grant_commands')) return [];
      if (text.includes('select id, status from identity.users')) {
        return [
          { id: quotaGrantInput.actorUserId, status: 'ACTIVE' },
          { id: quotaGrantInput.subjectUserId, status: 'ACTIVE' },
        ];
      }
      if (text.includes('update communities.create_quota_grants')) return [];
      if (text.includes('from communities.create_quota_grants')) return [];
      if (text.includes('insert into communities.create_quota_grants')) {
        return [
          {
            id: grantId,
            subject_user_id: quotaGrantInput.subjectUserId,
            authorized_by_user_id: quotaGrantInput.actorUserId,
            scopes: [...quotaGrantInput.scopes],
            state: 'ACTIVE',
            revision: 1,
            expires_at: new Date('2026-08-04T10:00:00.000Z'),
            created_at: createdAt,
            updated_at: createdAt,
            consumed_at: null,
          },
        ];
      }
      return [];
    });

    await expect(
      createCommunityCreateRepository(grant.pool).createQuotaGrant(quotaGrantInput),
    ).resolves.toMatchObject({
      outcome: 'granted',
      replayed: false,
      grant: {
        id: grantId,
        subjectUserId: quotaGrantInput.subjectUserId,
        scopes: [...quotaGrantInput.scopes],
      },
    });
    expect(
      grant.query.mock.calls.some(([text]) =>
        String(text).includes('insert into communities.create_quota_grant_commands'),
      ),
    ).toBe(true);
    expect(
      grant.query.mock.calls.some(([text]) => String(text).includes('insert into audit.audit_log')),
    ).toBe(true);
    expect(
      grant.query.mock.calls.some(([text]) =>
        String(text).includes('insert into audit.outbox_events'),
      ),
    ).toBe(true);
  });
});
