import { describe, expect, it, vi } from 'vitest';

import { createCommunityDirectInviteRepository } from './community-direct-invite-repository.js';

const tenantId = '86afbe01-0318-4dd2-bc25-303b7bf0d430';
const actorUserId = '49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca';
const otherActorUserId = '77777777-7777-4777-8777-777777777777';
const overrideActorUserId = '88888888-8888-4888-8888-888888888888';
const issuerUserId = '33333333-3333-4333-8333-333333333333';
const communityId = '11111111-1111-4111-8111-111111111111';
const inviteId = '22222222-2222-4222-8222-222222222222';
const grantId = '66666666-6666-4666-8666-666666666666';
const tokenHash = 'd'.repeat(64);
const tokenKeyId = 'community-invite-2026-08';
const createdAt = new Date('2026-08-04T10:00:00.000Z');
const updatedAt = new Date('2026-08-04T11:00:00.000Z');
const expiresAt = new Date('2099-08-11T10:00:00.000Z');

const commandBase = {
  tenantId,
  actorUserId,
  idempotencyKey: 'community-direct-invite-command-0001',
  requestHash: 'a'.repeat(64),
  correlationId: 'community-direct-invite-correlation',
} as const;

function inviteRow(
  overrides: Partial<{
    issued_by_user_id: string;
    token_key_id: string;
    state: 'ACTIVE' | 'REVOKED' | 'EXPIRED';
    revision: number;
    expires_at: Date;
    updated_at: Date;
  }> = {},
) {
  return {
    id: inviteId,
    community_id: communityId,
    issued_by_user_id: issuerUserId,
    token_key_id: tokenKeyId,
    state: 'ACTIVE' as const,
    revision: 1,
    expires_at: expiresAt,
    created_at: createdAt,
    updated_at: createdAt,
    ...overrides,
  };
}

function inviteView(
  overrides: Partial<{ tokenKeyId: string; state: string; revision: number }> = {},
) {
  return {
    id: inviteId,
    communityId,
    issuedByUserId: issuerUserId,
    tokenKeyId,
    state: 'ACTIVE',
    revision: 1,
    expiresAt: expiresAt.toISOString(),
    createdAt: createdAt.toISOString(),
    updatedAt: createdAt.toISOString(),
    ...overrides,
  };
}

function grantRow(
  overrides: Partial<{
    state: 'ACTIVE' | 'CONSUMED' | 'EXPIRED';
    revision: number;
    expires_at: Date;
    updated_at: Date;
    consumed_at: Date | null;
  }> = {},
) {
  return {
    id: grantId,
    community_id: communityId,
    authorized_by_user_id: overrideActorUserId,
    state: 'ACTIVE' as const,
    revision: 1,
    expires_at: new Date('2099-08-05T10:00:00.000Z'),
    created_at: createdAt,
    updated_at: createdAt,
    consumed_at: null,
    ...overrides,
  };
}

function grantView(overrides: Partial<{ state: string; revision: number }> = {}) {
  return {
    id: grantId,
    communityId,
    authorizedByUserId: overrideActorUserId,
    state: 'ACTIVE',
    revision: 1,
    expiresAt: '2099-08-05T10:00:00.000Z',
    createdAt: createdAt.toISOString(),
    updatedAt: createdAt.toISOString(),
    consumedAt: null,
    ...overrides,
  };
}

function poolWithQuery(handler: (text: string, values: readonly unknown[]) => unknown) {
  const query = vi.fn((text: string, values: readonly unknown[] = []) => {
    if (text === 'begin' || text === 'commit' || text === 'rollback') {
      return Promise.resolve({ rows: [] });
    }
    if (text.includes("set_config('app.tenant_id'")) return Promise.resolve({ rows: [] });
    const handled = (handler(text, values) as readonly unknown[]) ?? [];
    if (text.includes('as active_count') && handled.length === 0) {
      return Promise.resolve({
        rows: [
          {
            active_count: 0,
            active_retry_after_seconds: null,
            daily_count: 0,
            daily_retry_after_seconds: null,
          },
        ],
      });
    }
    return Promise.resolve({ rows: handled });
  });
  const connect = vi.fn().mockResolvedValue({ query, release: vi.fn() });
  const pool = { connect };
  return { pool: pool as never, query, connect };
}

function activeActor(text: string): readonly unknown[] | undefined {
  if (text.includes('from identity.users') && !text.includes('join identity.users')) {
    return [{ status: 'ACTIVE' }];
  }
  return undefined;
}

describe('community direct invite repository', () => {
  it('issues a seven-day hash-only invite with issuer revision, audit and outbox atomically', async () => {
    const input = {
      ...commandBase,
      communityId,
      tokenHash,
      tokenKeyId,
      expectedIssuerMembershipRevision: 3,
    };
    const { pool, query } = poolWithQuery((text, values) => {
      if (
        text.includes('from communities.direct_invite_commands') &&
        !text.includes('as active_count')
      ) {
        return [];
      }
      const actor = activeActor(text);
      if (actor) return actor;
      if (text.includes('select id from communities.communities')) return [{ id: communityId }];
      if (text.includes('from communities.memberships membership')) {
        return [{ status: 'ACTIVE', role: 'OWNER', revision: 3, updated_at: createdAt }];
      }
      if (text.includes('insert into communities.direct_invites')) {
        expect(text).toContain("now() + interval '7 days'");
        expect(values).toEqual([tenantId, communityId, tokenHash, tokenKeyId, actorUserId]);
        return [inviteRow({ issued_by_user_id: actorUserId })];
      }
      return [];
    });

    await expect(createCommunityDirectInviteRepository(pool).issue(input)).resolves.toMatchObject({
      outcome: 'issued',
      invite: { id: inviteId, tokenKeyId, revision: 1 },
      replayed: false,
    });
    expect(
      query.mock.calls.filter(([text]) => String(text).includes('pg_advisory_xact_lock')),
    ).toHaveLength(3);
    expect(
      query.mock.calls.some(([text]) =>
        String(text).includes('insert into communities.direct_invite_commands'),
      ),
    ).toBe(true);
    const commandInsert = query.mock.calls.find(([text]) =>
      String(text).includes('insert into communities.direct_invite_commands'),
    );
    expect(String(commandInsert?.[0])).toContain('community_id');
    expect(commandInsert?.[1]).toEqual(expect.arrayContaining([communityId]));
    expect(
      query.mock.calls.some(([text]) => String(text).includes('insert into audit.audit_log')),
    ).toBe(true);
    expect(
      query.mock.calls.some(([text]) => String(text).includes('insert into audit.outbox_events')),
    ).toBe(true);
    expect(
      query.mock.calls.some(([text]) =>
        String(text).includes('communities.direct_invite_quota_grants'),
      ),
    ).toBe(false);
    for (const [text, values] of query.mock.calls) {
      if (
        String(text).includes('direct_invite_commands') ||
        String(text).includes('audit.audit_log') ||
        String(text).includes('audit.outbox_events')
      ) {
        expect(JSON.stringify(values)).not.toContain(tokenHash);
      }
    }
    expect(query).toHaveBeenCalledWith('commit');
  });

  it('replays issue metadata with the original key id across active-key rotation', async () => {
    const oldKeyId = 'community-invite-2026-07';
    const { pool, query } = poolWithQuery((text) =>
      text.includes('from communities.direct_invite_commands')
        ? [
            {
              command_type: 'ISSUE',
              request_hash: commandBase.requestHash,
              result_payload: {
                outcome: 'issued',
                invite: inviteView({ tokenKeyId: oldKeyId }),
              },
            },
          ]
        : [],
    );

    await expect(
      createCommunityDirectInviteRepository(pool).issue({
        ...commandBase,
        communityId,
        tokenHash: 'e'.repeat(64),
        tokenKeyId: 'community-invite-2026-09',
        expectedIssuerMembershipRevision: 3,
      }),
    ).resolves.toMatchObject({
      outcome: 'issued',
      invite: { tokenKeyId: oldKeyId },
      replayed: true,
    });
    expect(
      query.mock.calls.some(([text]) =>
        String(text).includes('insert into communities.direct_invites'),
      ),
    ).toBe(false);
    expect(query.mock.calls.some(([text]) => String(text).includes('as active_count'))).toBe(false);
    expect(
      query.mock.calls.some(([, values]) =>
        String(JSON.stringify(values)).includes('community-direct-invite-issuance:'),
      ),
    ).toBe(false);
  });

  it('rejects the sixth unexpired ACTIVE link with a stable retry value', async () => {
    const { pool, query } = poolWithQuery((text) => {
      if (
        text.includes('from communities.direct_invite_commands') &&
        !text.includes('as active_count')
      ) {
        return [];
      }
      const actor = activeActor(text);
      if (actor) return actor;
      if (text.includes('select id from communities.communities')) return [{ id: communityId }];
      if (text.includes('from communities.memberships membership')) {
        return [{ status: 'ACTIVE', role: 'OWNER', revision: 3, updated_at: createdAt }];
      }
      if (text.includes('as active_count')) {
        return [
          {
            active_count: 5,
            active_retry_after_seconds: 600,
            daily_count: 5,
            daily_retry_after_seconds: 3_600,
          },
        ];
      }
      return [];
    });

    await expect(
      createCommunityDirectInviteRepository(pool).issue({
        ...commandBase,
        communityId,
        tokenHash,
        tokenKeyId,
        expectedIssuerMembershipRevision: 3,
      }),
    ).resolves.toEqual({ outcome: 'active_limit_exceeded', retryAfterSeconds: 600 });
    expect(
      query.mock.calls.some(([text]) =>
        String(text).includes('insert into communities.direct_invites'),
      ),
    ).toBe(false);
  });

  it('counts successful ISSUE commands in a rolling 24-hour window even after links are revoked', async () => {
    const { pool, query } = poolWithQuery((text) => {
      if (
        text.includes('from communities.direct_invite_commands') &&
        !text.includes('as active_count')
      ) {
        return [];
      }
      const actor = activeActor(text);
      if (actor) return actor;
      if (text.includes('select id from communities.communities')) return [{ id: communityId }];
      if (text.includes('from communities.memberships membership')) {
        return [{ status: 'ACTIVE', role: 'ADMIN', revision: 3, updated_at: createdAt }];
      }
      if (text.includes('as active_count')) {
        return [
          {
            active_count: 0,
            active_retry_after_seconds: null,
            daily_count: 20,
            daily_retry_after_seconds: 1_800,
          },
        ];
      }
      return [];
    });

    await expect(
      createCommunityDirectInviteRepository(pool).issue({
        ...commandBase,
        communityId,
        tokenHash,
        tokenKeyId,
        expectedIssuerMembershipRevision: 3,
      }),
    ).resolves.toEqual({ outcome: 'daily_limit_exceeded', retryAfterSeconds: 1_800 });
    const quotaSql = String(
      query.mock.calls.find(([text]) => String(text).includes('as active_count'))?.[0],
    );
    expect(quotaSql).toContain('cmd.community_id = $2');
    expect(quotaSql).toContain('cmd.community_id is null');
    expect(quotaSql).toContain('invite.community_id = $2');
    expect(quotaSql).toContain('union all');
    expect(quotaSql).toContain("cmd.created_at > now() - interval '24 hours'");
    expect(quotaSql.match(/from issue_window/g)).toHaveLength(1);
    expect(quotaSql).not.toContain("cmd.state = 'ACTIVE'");
  });

  it('serializes different admins for one community on the same quota lock', async () => {
    function racingPool(actorId: string, activeCount: number) {
      return poolWithQuery((text) => {
        if (
          text.includes('from communities.direct_invite_commands') &&
          !text.includes('as active_count')
        ) {
          return [];
        }
        const actor = activeActor(text);
        if (actor) return actor;
        if (text.includes('select id from communities.communities')) return [{ id: communityId }];
        if (text.includes('from communities.memberships membership')) {
          return [{ status: 'ACTIVE', role: 'ADMIN', revision: 3, updated_at: createdAt }];
        }
        if (text.includes('as active_count')) {
          return [
            {
              active_count: activeCount,
              active_retry_after_seconds: 300,
              daily_count: 4,
              daily_retry_after_seconds: 3_600,
            },
          ];
        }
        if (text.includes('insert into communities.direct_invites')) {
          return [inviteRow({ issued_by_user_id: actorId })];
        }
        return [];
      });
    }
    const first = racingPool(actorUserId, 4);
    const second = racingPool(otherActorUserId, 5);

    const [firstResult, secondResult] = await Promise.all([
      createCommunityDirectInviteRepository(first.pool).issue({
        ...commandBase,
        communityId,
        tokenHash,
        tokenKeyId,
        expectedIssuerMembershipRevision: 3,
      }),
      createCommunityDirectInviteRepository(second.pool).issue({
        ...commandBase,
        actorUserId: otherActorUserId,
        idempotencyKey: 'community-direct-invite-command-0002',
        communityId,
        tokenHash: 'e'.repeat(64),
        tokenKeyId,
        expectedIssuerMembershipRevision: 3,
      }),
    ]);
    expect(firstResult).toMatchObject({ outcome: 'issued' });
    expect(secondResult).toEqual({ outcome: 'active_limit_exceeded', retryAfterSeconds: 300 });
    const quotaLock = `community-direct-invite-issuance:${tenantId}:${communityId}`;
    for (const repository of [first, second]) {
      expect(
        repository.query.mock.calls.some(([, values]) => values?.includes(quotaLock) ?? false),
      ).toBe(true);
    }
  });

  it('creates one trusted 24-hour grant with idempotency, audit and outbox evidence', async () => {
    const input = {
      ...commandBase,
      actorUserId: overrideActorUserId,
      communityId,
      capability: 'communities.invite.quota.override' as const,
      reasonCode: 'INCIDENT_RESPONSE',
      ticketId: 'CUP-1234',
    };
    const { pool, query } = poolWithQuery((text, values) => {
      if (text.includes('from communities.direct_invite_quota_grant_commands')) return [];
      const actor = activeActor(text);
      if (actor) return actor;
      if (text.includes('select id from communities.communities')) return [{ id: communityId }];
      if (text.includes('update communities.direct_invite_quota_grants')) return [];
      if (
        text.includes('from communities.direct_invite_quota_grants') &&
        text.includes('for update')
      ) {
        return [];
      }
      if (text.includes('insert into communities.direct_invite_quota_grants')) {
        expect(text).toContain("now() + interval '24 hours'");
        expect(values).toEqual([
          tenantId,
          communityId,
          overrideActorUserId,
          input.capability,
          input.reasonCode,
          input.ticketId,
        ]);
        return [grantRow()];
      }
      return [];
    });

    await expect(
      createCommunityDirectInviteRepository(pool).createQuotaGrant(input),
    ).resolves.toMatchObject({
      outcome: 'granted',
      replayed: false,
      grant: { id: grantId, state: 'ACTIVE', authorizedByUserId: overrideActorUserId },
    });
    const commandCall = query.mock.calls.find(([text]) =>
      String(text).includes('insert into communities.direct_invite_quota_grant_commands'),
    );
    expect(commandCall?.[1]).toEqual(expect.arrayContaining([overrideActorUserId, grantId]));
    const auditCall = query.mock.calls.find(([text]) =>
      String(text).includes('insert into audit.audit_log'),
    );
    expect(JSON.stringify(auditCall?.[1])).toContain(overrideActorUserId);
    expect(JSON.stringify(auditCall?.[1])).toContain(input.reasonCode);
    expect(JSON.stringify(auditCall?.[1])).toContain(input.ticketId);
    expect(
      query.mock.calls.some(([text]) => String(text).includes('insert into audit.outbox_events')),
    ).toBe(true);
  });

  it('rejects a second unexpired ACTIVE grant for the same community', async () => {
    const { pool, query } = poolWithQuery((text) => {
      if (text.includes('from communities.direct_invite_quota_grant_commands')) return [];
      const actor = activeActor(text);
      if (actor) return actor;
      if (text.includes('select id from communities.communities')) return [{ id: communityId }];
      if (text.includes('update communities.direct_invite_quota_grants')) return [];
      if (text.includes('from communities.direct_invite_quota_grants')) return [grantRow()];
      return [];
    });
    await expect(
      createCommunityDirectInviteRepository(pool).createQuotaGrant({
        ...commandBase,
        actorUserId: overrideActorUserId,
        communityId,
        capability: 'communities.invite.quota.override',
        reasonCode: 'INCIDENT_RESPONSE',
        ticketId: 'CUP-1234',
      }),
    ).resolves.toMatchObject({
      outcome: 'active_grant_exists',
      currentGrantId: grantId,
      currentRevision: 1,
    });
    expect(
      query.mock.calls.some(([text]) =>
        String(text).includes('insert into communities.direct_invite_quota_grants'),
      ),
    ).toBe(false);
  });

  it('replays grant creation before community or ACTIVE-grant checks', async () => {
    const stored = { outcome: 'granted', grant: grantView() };
    const { pool, query } = poolWithQuery((text) =>
      text.includes('from communities.direct_invite_quota_grant_commands')
        ? [{ request_hash: commandBase.requestHash, result_payload: stored }]
        : [],
    );
    await expect(
      createCommunityDirectInviteRepository(pool).createQuotaGrant({
        ...commandBase,
        actorUserId: overrideActorUserId,
        communityId,
        capability: 'communities.invite.quota.override',
        reasonCode: 'INCIDENT_RESPONSE',
        ticketId: 'CUP-1234',
      }),
    ).resolves.toMatchObject({ outcome: 'granted', replayed: true, grant: { id: grantId } });
    expect(
      query.mock.calls.some(([text]) =>
        String(text).includes('select id from communities.communities'),
      ),
    ).toBe(false);
    expect(
      query.mock.calls.some(([text]) =>
        String(text).includes('from communities.direct_invite_quota_grants'),
      ),
    ).toBe(false);
  });

  it('consumes one active grant only when quota is exceeded and links it to the ISSUE command', async () => {
    const consumedAt = new Date('2026-08-04T10:05:00.000Z');
    const { pool, query } = poolWithQuery((text) => {
      if (
        text.includes('from communities.direct_invite_commands') &&
        !text.includes('as active_count')
      ) {
        return [];
      }
      const actor = activeActor(text);
      if (actor) return actor;
      if (text.includes('select id from communities.communities')) return [{ id: communityId }];
      if (text.includes('from communities.memberships membership')) {
        return [{ status: 'ACTIVE', role: 'OWNER', revision: 3, updated_at: createdAt }];
      }
      if (text.includes('as active_count')) {
        return [
          {
            active_count: 5,
            active_retry_after_seconds: 600,
            daily_count: 5,
            daily_retry_after_seconds: 600,
          },
        ];
      }
      if (text.includes("set state = 'EXPIRED'")) return [];
      if (text.includes('from communities.direct_invite_quota_grants')) return [grantRow()];
      if (text.includes('insert into communities.direct_invites')) {
        return [inviteRow({ issued_by_user_id: actorUserId })];
      }
      if (text.includes("set state = 'CONSUMED'")) {
        return [
          grantRow({
            state: 'CONSUMED',
            revision: 2,
            consumed_at: consumedAt,
            updated_at: consumedAt,
          }),
        ];
      }
      return [];
    });

    await expect(
      createCommunityDirectInviteRepository(pool).issue({
        ...commandBase,
        communityId,
        tokenHash,
        tokenKeyId,
        expectedIssuerMembershipRevision: 3,
      }),
    ).resolves.toMatchObject({ outcome: 'issued', replayed: false });
    expect(
      query.mock.calls.filter(([text]) => String(text).includes("set state = 'CONSUMED'")),
    ).toHaveLength(1);
    const issueCommand = query.mock.calls.find(([text]) =>
      String(text).includes('insert into communities.direct_invite_commands'),
    );
    expect(String(issueCommand?.[0])).toContain('quota_grant_id');
    expect(issueCommand?.[1]).toEqual(expect.arrayContaining([grantId]));
  });

  it('does not use expired or already consumed grants to bypass a quota', async () => {
    function unavailableGrant(expireNow: boolean) {
      return poolWithQuery((text) => {
        if (
          text.includes('from communities.direct_invite_commands') &&
          !text.includes('as active_count')
        ) {
          return [];
        }
        const actor = activeActor(text);
        if (actor) return actor;
        if (text.includes('select id from communities.communities')) return [{ id: communityId }];
        if (text.includes('from communities.memberships membership')) {
          return [{ status: 'ACTIVE', role: 'OWNER', revision: 3, updated_at: createdAt }];
        }
        if (text.includes('as active_count')) {
          return [
            {
              active_count: 5,
              active_retry_after_seconds: 600,
              daily_count: 5,
              daily_retry_after_seconds: 600,
            },
          ];
        }
        if (text.includes("set state = 'EXPIRED'")) {
          return expireNow ? [grantRow({ state: 'EXPIRED', revision: 2 })] : [];
        }
        if (text.includes('from communities.direct_invite_quota_grants')) return [];
        return [];
      });
    }
    for (const scenario of [unavailableGrant(true), unavailableGrant(false)]) {
      await expect(
        createCommunityDirectInviteRepository(scenario.pool).issue({
          ...commandBase,
          communityId,
          tokenHash,
          tokenKeyId,
          expectedIssuerMembershipRevision: 3,
        }),
      ).resolves.toEqual({ outcome: 'active_limit_exceeded', retryAfterSeconds: 600 });
      expect(
        scenario.query.mock.calls.some(([text]) =>
          String(text).includes('insert into communities.direct_invites'),
        ),
      ).toBe(false);
    }
  });

  it('rolls grant consumption back when ISSUE evidence persistence fails', async () => {
    const consumedAt = new Date('2026-08-04T10:05:00.000Z');
    const { pool, query } = poolWithQuery((text) => {
      if (
        text.includes('from communities.direct_invite_commands') &&
        !text.includes('as active_count')
      ) {
        return [];
      }
      const actor = activeActor(text);
      if (actor) return actor;
      if (text.includes('select id from communities.communities')) return [{ id: communityId }];
      if (text.includes('from communities.memberships membership')) {
        return [{ status: 'ACTIVE', role: 'OWNER', revision: 3, updated_at: createdAt }];
      }
      if (text.includes('as active_count')) {
        return [
          {
            active_count: 5,
            active_retry_after_seconds: 600,
            daily_count: 5,
            daily_retry_after_seconds: 600,
          },
        ];
      }
      if (text.includes("set state = 'EXPIRED'")) return [];
      if (text.includes('from communities.direct_invite_quota_grants')) return [grantRow()];
      if (text.includes('insert into communities.direct_invites')) return [inviteRow()];
      if (text.includes("set state = 'CONSUMED'")) {
        return [
          grantRow({
            state: 'CONSUMED',
            revision: 2,
            consumed_at: consumedAt,
            updated_at: consumedAt,
          }),
        ];
      }
      if (text.includes('insert into communities.direct_invite_commands')) {
        throw new Error('forced command write failure');
      }
      return [];
    });
    await expect(
      createCommunityDirectInviteRepository(pool).issue({
        ...commandBase,
        communityId,
        tokenHash,
        tokenKeyId,
        expectedIssuerMembershipRevision: 3,
      }),
    ).rejects.toThrow('forced command write failure');
    expect(query).toHaveBeenCalledWith('rollback');
    expect(query).not.toHaveBeenCalledWith('commit');
  });

  it('rejects a stale issuer membership revision before invite creation', async () => {
    const { pool, query } = poolWithQuery((text) => {
      if (text.includes('from communities.direct_invite_commands')) return [];
      const actor = activeActor(text);
      if (actor) return actor;
      if (text.includes('select id from communities.communities')) return [{ id: communityId }];
      if (text.includes('from communities.memberships membership')) {
        return [{ status: 'ACTIVE', role: 'ADMIN', revision: 4, updated_at: createdAt }];
      }
      return [];
    });

    await expect(
      createCommunityDirectInviteRepository(pool).issue({
        ...commandBase,
        communityId,
        tokenHash,
        tokenKeyId,
        expectedIssuerMembershipRevision: 3,
      }),
    ).resolves.toEqual({ outcome: 'issuer_membership_revision_conflict', currentRevision: 4 });
    expect(
      query.mock.calls.some(([text]) =>
        String(text).includes('insert into communities.direct_invites'),
      ),
    ).toBe(false);
  });

  it('previews a valid HIDDEN invite without mutating membership or exposing token material', async () => {
    const { pool, query } = poolWithQuery((text, values) => {
      const actor = activeActor(text);
      if (actor) return actor;
      if (text.includes('from communities.direct_invites invite')) {
        expect(values).toEqual([tenantId, tokenHash, actorUserId]);
        return [
          {
            invite_id: inviteId,
            invite_revision: 7,
            community_id: communityId,
            title: 'Закрытое сообщество',
            visibility: 'HIDDEN',
            is_verified: true,
            expires_at: expiresAt,
            viewer_status: null,
            viewer_revision: null,
          },
        ];
      }
      return [];
    });

    await expect(
      createCommunityDirectInviteRepository(pool).preview({
        tenantId,
        actorUserId,
        tokenHash,
        correlationId: commandBase.correlationId,
      }),
    ).resolves.toEqual({
      outcome: 'found',
      preview: {
        inviteId,
        inviteRevision: 7,
        communityId,
        title: 'Закрытое сообщество',
        visibility: 'HIDDEN',
        isVerified: true,
        expiresAt: expiresAt.toISOString(),
        membershipRevision: 0,
        redeemAction: 'CONFIRM_MEMBERSHIP',
      },
    });
    expect(query.mock.calls.some(([text]) => /insert|update|delete/i.test(String(text)))).toBe(
      false,
    );
    const previewSql = String(
      query.mock.calls.find(([text]) =>
        String(text).includes('from communities.direct_invites invite'),
      )?.[0],
    );
    expect(previewSql.slice(0, previewSql.indexOf('from'))).not.toContain('token_hash');
  });

  it('maps invalid, expired, revoked or issuer-ineligible preview to one result', async () => {
    const { pool, query } = poolWithQuery((text) => activeActor(text) ?? []);
    await expect(
      createCommunityDirectInviteRepository(pool).preview({
        tenantId,
        actorUserId,
        tokenHash,
        correlationId: commandBase.correlationId,
      }),
    ).resolves.toEqual({ outcome: 'invalid' });
    expect(query.mock.calls.some(([text]) => String(text).includes('audit.'))).toBe(false);

    const malformed = poolWithQuery((text) => activeActor(text) ?? []);
    await expect(
      createCommunityDirectInviteRepository(malformed.pool).preview({
        tenantId,
        actorUserId,
        tokenHash: 'not-a-hash',
        correlationId: commandBase.correlationId,
      }),
    ).resolves.toEqual({ outcome: 'invalid' });
    expect(
      malformed.query.mock.calls.some(([text]) =>
        String(text).includes('from communities.direct_invites invite'),
      ),
    ).toBe(false);
  });

  it('fails preview closed for a banned authenticated viewer without returning detail', async () => {
    const { pool } = poolWithQuery((text) => {
      const actor = activeActor(text);
      if (actor) return actor;
      if (text.includes('from communities.direct_invites invite')) {
        return [
          {
            invite_id: inviteId,
            invite_revision: 1,
            community_id: communityId,
            title: 'Не должно попасть в ответ',
            visibility: 'HIDDEN',
            is_verified: false,
            expires_at: expiresAt,
            viewer_status: 'BANNED',
            viewer_revision: 6,
          },
        ];
      }
      return [];
    });

    await expect(
      createCommunityDirectInviteRepository(pool).preview({
        tenantId,
        actorUserId,
        tokenHash,
        correlationId: commandBase.correlationId,
      }),
    ).resolves.toEqual({ outcome: 'membership_banned' });
  });

  it('returns REQUEST_PENDING without inventing a pending redemption transition', async () => {
    const { pool } = poolWithQuery((text) => {
      const actor = activeActor(text);
      if (actor) return actor;
      if (text.includes('from communities.direct_invites invite')) {
        return [
          {
            invite_id: inviteId,
            invite_revision: 1,
            community_id: communityId,
            title: 'Сообщество',
            visibility: 'PUBLIC',
            is_verified: false,
            expires_at: expiresAt,
            viewer_status: 'PENDING',
            viewer_revision: 4,
          },
        ];
      }
      return [];
    });

    await expect(
      createCommunityDirectInviteRepository(pool).preview({
        tenantId,
        actorUserId,
        tokenHash,
        correlationId: commandBase.correlationId,
      }),
    ).resolves.toMatchObject({
      outcome: 'found',
      preview: { membershipRevision: 4, redeemAction: 'REQUEST_PENDING' },
    });
  });

  it('requires explicit confirmation before opening a redemption transaction', async () => {
    const { pool, connect } = poolWithQuery(() => {
      throw new Error('database must not be touched');
    });
    await expect(
      createCommunityDirectInviteRepository(pool).redeem({
        ...commandBase,
        tokenHash,
        confirmed: false,
        expectedInviteRevision: 1,
        expectedMembershipRevision: 0,
      }),
    ).resolves.toEqual({ outcome: 'confirmation_required' });
    expect(connect).not.toHaveBeenCalled();
  });

  it('restores REMOVED without serializing every redemption on a hot invite counter', async () => {
    const input = {
      ...commandBase,
      tokenHash,
      confirmed: true,
      expectedInviteRevision: 1,
      expectedMembershipRevision: 4,
    };
    const { pool, query } = poolWithQuery((text, values) => {
      if (text.includes('from communities.direct_invite_commands')) return [];
      const actor = activeActor(text);
      if (actor) return actor;
      if (
        text.includes('select id, community_id, issued_by_user_id') &&
        text.includes('token_hash')
      ) {
        return [{ id: inviteId, community_id: communityId, issued_by_user_id: issuerUserId }];
      }
      if (text.includes('from communities.direct_invites invite') && text.includes('for share')) {
        return [inviteRow()];
      }
      if (text.includes('from communities.memberships') && text.includes('for update')) {
        return [{ status: 'REMOVED', role: 'MEMBER', revision: 4, updated_at: createdAt }];
      }
      if (text.includes("status in ('LEFT', 'REMOVED')")) {
        expect(values).toEqual([tenantId, communityId, actorUserId, 4]);
        return [{ status: 'ACTIVE', role: 'MEMBER', revision: 5, updated_at: updatedAt }];
      }
      return [];
    });

    await expect(createCommunityDirectInviteRepository(pool).redeem(input)).resolves.toMatchObject({
      outcome: 'redeemed',
      invite: { id: inviteId, revision: 1 },
      membership: { status: 'ACTIVE', role: 'MEMBER', revision: 5 },
      replayed: false,
    });
    const lockValues = query.mock.calls
      .filter(([text]) => String(text).includes('pg_advisory_xact_lock'))
      .map(([, values]) => String((values as readonly unknown[])[0]));
    expect(lockValues).toEqual([
      `community-direct-invite-command:${tenantId}:${actorUserId}:${commandBase.idempotencyKey}`,
      `community-membership:${tenantId}:${communityId}:${issuerUserId}`,
      `community-membership:${tenantId}:${communityId}:${actorUserId}`,
    ]);
    expect(
      query.mock.calls.some(([text]) => String(text).includes('set use_count = use_count + 1')),
    ).toBe(false);
    const privateWrites = query.mock.calls.filter(([text]) =>
      /direct_invite_commands|audit\.audit_log|audit\.outbox_events/.test(String(text)),
    );
    expect(privateWrites).toHaveLength(4);
    for (const [, values] of privateWrites) expect(JSON.stringify(values)).not.toContain(tokenHash);
    expect(query).toHaveBeenCalledWith('commit');
  });

  it('fails closed for BANNED/PENDING and stale invite revision before membership mutation', async () => {
    function redemption(status: 'BANNED' | 'PENDING', inviteRevision = 1) {
      return poolWithQuery((text) => {
        if (text.includes('from communities.direct_invite_commands')) return [];
        const actor = activeActor(text);
        if (actor) return actor;
        if (
          text.includes('select id, community_id, issued_by_user_id') &&
          text.includes('token_hash')
        ) {
          return [{ id: inviteId, community_id: communityId, issued_by_user_id: issuerUserId }];
        }
        if (text.includes('from communities.direct_invites invite') && text.includes('for share')) {
          return [inviteRow({ revision: inviteRevision })];
        }
        if (text.includes('from communities.memberships') && text.includes('for update')) {
          return [{ status, role: 'MEMBER', revision: 2, updated_at: createdAt }];
        }
        return [];
      });
    }

    const banned = redemption('BANNED');
    await expect(
      createCommunityDirectInviteRepository(banned.pool).redeem({
        ...commandBase,
        tokenHash,
        confirmed: true,
        expectedInviteRevision: 1,
        expectedMembershipRevision: 99,
      }),
    ).resolves.toEqual({ outcome: 'membership_banned' });

    const pending = redemption('PENDING');
    await expect(
      createCommunityDirectInviteRepository(pending.pool).redeem({
        ...commandBase,
        tokenHash,
        confirmed: true,
        expectedInviteRevision: 1,
        expectedMembershipRevision: 2,
      }),
    ).resolves.toEqual({ outcome: 'request_pending' });

    const stale = redemption('PENDING', 4);
    await expect(
      createCommunityDirectInviteRepository(stale.pool).redeem({
        ...commandBase,
        tokenHash,
        confirmed: true,
        expectedInviteRevision: 3,
        expectedMembershipRevision: 2,
      }),
    ).resolves.toEqual({ outcome: 'invite_revision_conflict', currentRevision: 4 });
    expect(
      stale.query.mock.calls.some(([text]) =>
        String(text).includes('from communities.memberships'),
      ),
    ).toBe(false);
  });

  it('replays redemption without reusing the invite or membership', async () => {
    const stored = {
      outcome: 'redeemed',
      invite: inviteView(),
      membership: {
        communityId,
        status: 'ACTIVE',
        role: 'MEMBER',
        revision: 5,
        updatedAt: updatedAt.toISOString(),
        joinAction: 'OPEN_COMMUNITY',
      },
    };
    const { pool } = poolWithQuery((text) =>
      text.includes('from communities.direct_invite_commands')
        ? [
            {
              command_type: 'REDEEM',
              request_hash: commandBase.requestHash,
              result_payload: stored,
            },
          ]
        : [],
    );

    await expect(
      createCommunityDirectInviteRepository(pool).redeem({
        ...commandBase,
        tokenHash,
        confirmed: true,
        expectedInviteRevision: 1,
        expectedMembershipRevision: 4,
      }),
    ).resolves.toMatchObject({ outcome: 'redeemed', replayed: true });
  });

  it('revokes under an ACTIVE OWNER/ADMIN revision and does not depend on issuer eligibility', async () => {
    const input = { ...commandBase, inviteId, expectedInviteRevision: 1 };
    const { pool, query } = poolWithQuery((text) => {
      const actor = activeActor(text);
      if (actor) return actor;
      if (text.includes('from communities.direct_invite_commands')) return [];
      if (text.includes('from communities.direct_invites') && text.includes('for update')) {
        return [inviteRow()];
      }
      if (text.includes('from communities.direct_invites') && text.includes('select id,')) {
        return [{ id: inviteId, community_id: communityId, issued_by_user_id: issuerUserId }];
      }
      if (text.includes('from communities.memberships membership')) {
        return [{ status: 'ACTIVE', role: 'ADMIN', revision: 9, updated_at: createdAt }];
      }
      if (text.includes("set state = 'REVOKED'")) {
        return [inviteRow({ state: 'REVOKED', revision: 2, updated_at: updatedAt })];
      }
      return [];
    });

    await expect(createCommunityDirectInviteRepository(pool).revoke(input)).resolves.toMatchObject({
      outcome: 'revoked',
      invite: { state: 'REVOKED', revision: 2 },
      replayed: false,
    });
    expect(query.mock.calls.some(([text]) => String(text).includes('issued_by_user_id'))).toBe(
      true,
    );
    expect(query).toHaveBeenCalledWith('commit');
  });

  it('lists active invites with a token-free scope-bound keyset cursor', async () => {
    const secondInviteId = '44444444-4444-4444-8444-444444444444';
    const { pool, query } = poolWithQuery((text) => {
      const actor = activeActor(text);
      if (actor) return actor;
      if (text.includes('select id from communities.communities')) return [{ id: communityId }];
      if (text.includes('from communities.memberships membership')) {
        return [{ status: 'ACTIVE', role: 'OWNER', revision: 3, updated_at: createdAt }];
      }
      if (text.includes('from communities.direct_invites') && text.includes('sort_created_at')) {
        return [
          { ...inviteRow(), sort_created_at: createdAt.toISOString() },
          {
            ...inviteRow(),
            id: secondInviteId,
            created_at: new Date('2026-08-03T10:00:00.000Z'),
            sort_created_at: '2026-08-03 10:00:00+00',
          },
        ];
      }
      return [];
    });

    const first = await createCommunityDirectInviteRepository(pool).listActive({
      tenantId,
      actorUserId,
      communityId,
      limit: 1,
      correlationId: commandBase.correlationId,
    });
    expect(first).toMatchObject({ outcome: 'found', items: [{ id: inviteId }] });
    if (first.outcome !== 'found' || !first.nextCursor) throw new Error('cursor missing');
    await createCommunityDirectInviteRepository(pool).listActive({
      tenantId,
      actorUserId,
      communityId,
      limit: 1,
      cursor: first.nextCursor,
      correlationId: commandBase.correlationId,
    });
    const listCalls = query.mock.calls.filter(([text]) => String(text).includes('sort_created_at'));
    expect(String(listCalls[0]?.[0])).not.toContain('token_hash');
    expect(listCalls[0]?.[1]).toEqual([tenantId, communityId, null, null, 2]);
    expect(listCalls[1]?.[1]).toEqual([
      tenantId,
      communityId,
      createdAt.toISOString(),
      inviteId,
      2,
    ]);
    expect(JSON.stringify(first)).not.toContain(tokenHash);
  });
});
