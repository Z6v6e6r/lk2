import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import {
  createCommunityDirectInviteService,
  type CommunityDirectInviteRepositoryPort,
  type CommunityDirectInviteView,
} from './community-direct-invite.js';

const command = {
  tenantId: '10000000-0000-4000-8000-000000000001',
  actorUserId: '20000000-0000-4000-8000-000000000002',
  communityId: '30000000-0000-4000-8000-000000000003',
  expectedIssuerMembershipRevision: 7,
  idempotencyKey: 'invite-command-key-0001',
  requestHash: 'a'.repeat(64),
  correlationId: 'correlation-1',
};

function invite(tokenKeyId = 'current'): CommunityDirectInviteView {
  return {
    id: '40000000-0000-4000-8000-000000000004',
    communityId: command.communityId,
    issuedByUserId: command.actorUserId,
    tokenKeyId,
    state: 'ACTIVE',
    revision: 1,
    expiresAt: '2026-08-11T12:00:00.000Z',
    createdAt: '2026-08-04T12:00:00.000Z',
    updatedAt: '2026-08-04T12:00:00.000Z',
  };
}

function repository(
  overrides: Partial<CommunityDirectInviteRepositoryPort> = {},
): CommunityDirectInviteRepositoryPort {
  return {
    issue: vi.fn().mockResolvedValue({ outcome: 'issued', invite: invite(), replayed: false }),
    createQuotaGrant: vi.fn().mockResolvedValue({ outcome: 'community_not_found' }),
    preview: vi.fn().mockResolvedValue({ outcome: 'invalid' }),
    redeem: vi.fn().mockResolvedValue({ outcome: 'invalid_invite' }),
    revoke: vi.fn().mockResolvedValue({ outcome: 'invite_not_found' }),
    listActive: vi.fn().mockResolvedValue({ outcome: 'found', items: [] }),
    ...overrides,
  };
}

describe('community DIRECT invite service', () => {
  it('derives a deterministic 256-bit token while the repository sees only its hash', async () => {
    const issue = vi
      .fn<CommunityDirectInviteRepositoryPort['issue']>()
      .mockResolvedValue({ outcome: 'issued', invite: invite(), replayed: false });
    const service = createCommunityDirectInviteService(repository({ issue }), {
      tokenKeys: { current: Buffer.alloc(32, 7) },
      activeKeyId: 'current',
    });

    const first = await service.issue(command);
    const second = await service.issue(command);
    expect(first.outcome).toBe('issued');
    expect(second.outcome).toBe('issued');
    if (first.outcome !== 'issued' || second.outcome !== 'issued') return;
    expect(first.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(second.token).toBe(first.token);
    expect(issue).toHaveBeenCalledWith(
      expect.objectContaining({
        tokenKeyId: 'current',
        tokenHash: createHash('sha256').update(first.token).digest('hex'),
      }),
    );
    expect(JSON.stringify(issue.mock.calls)).not.toContain(first.token);
  });

  it('regenerates an idempotent replay with its retained old key after rotation', async () => {
    const service = createCommunityDirectInviteService(
      repository({
        issue: vi.fn().mockResolvedValue({
          outcome: 'issued',
          invite: invite('previous'),
          replayed: true,
        }),
      }),
      {
        tokenKeys: { current: Buffer.alloc(32, 8), previous: Buffer.alloc(32, 5) },
        activeKeyId: 'current',
      },
    );

    const result = await service.issue(command);
    expect(result.outcome).toBe('issued');
    if (result.outcome === 'issued') expect(result.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('exposes quota grants only through a validated trusted admin command', async () => {
    const createQuotaGrant = vi
      .fn<CommunityDirectInviteRepositoryPort['createQuotaGrant']>()
      .mockResolvedValue({
        outcome: 'granted',
        replayed: false,
        grant: {
          id: '88888888-8888-4888-8888-888888888888',
          communityId: command.communityId,
          authorizedByUserId: command.actorUserId,
          state: 'ACTIVE',
          revision: 1,
          expiresAt: '2026-08-05T12:00:00.000Z',
          createdAt: '2026-08-04T12:00:00.000Z',
          updatedAt: '2026-08-04T12:00:00.000Z',
          consumedAt: null,
        },
      });
    const service = createCommunityDirectInviteService(repository({ createQuotaGrant }), {
      tokenKeys: { current: Buffer.alloc(32, 4) },
      activeKeyId: 'current',
    });
    const grantCommand = {
      ...command,
      capability: 'communities.invite.quota.override' as const,
      reasonCode: 'INCIDENT_RESPONSE',
      ticketId: 'CUP-1234',
    };

    await expect(service.createQuotaGrant(grantCommand)).resolves.toMatchObject({
      outcome: 'granted',
    });
    expect(createQuotaGrant).toHaveBeenCalledWith(grantCommand);
    expect(() =>
      service.createQuotaGrant({ ...grantCommand, ticketId: 'contains whitespace' }),
    ).toThrow('COMMUNITY_DIRECT_INVITE_QUOTA_GRANT_AUTHORIZATION_INVALID');
    expect(createQuotaGrant).toHaveBeenCalledTimes(1);
  });

  it('does not expose any quota selector on normal issue input', async () => {
    const issue = vi
      .fn<CommunityDirectInviteRepositoryPort['issue']>()
      .mockResolvedValue({ outcome: 'issued', invite: invite(), replayed: false });
    const service = createCommunityDirectInviteService(repository({ issue }), {
      tokenKeys: { current: Buffer.alloc(32, 6) },
      activeKeyId: 'current',
    });

    await service.issue(command);
    expect(issue.mock.calls[0]?.[0]).not.toHaveProperty('quotaOverride');
    expect(issue.mock.calls[0]?.[0]).not.toHaveProperty('quotaGrantId');
  });

  it('fails closed before persistence for malformed tokens and missing confirmation', async () => {
    const preview = vi.fn<CommunityDirectInviteRepositoryPort['preview']>();
    const redeem = vi.fn<CommunityDirectInviteRepositoryPort['redeem']>();
    const service = createCommunityDirectInviteService(repository({ preview, redeem }), {
      tokenKeys: { current: Buffer.alloc(32, 9) },
      activeKeyId: 'current',
    });

    await expect(
      service.preview({
        tenantId: command.tenantId,
        actorUserId: command.actorUserId,
        token: 'short',
        correlationId: command.correlationId,
      }),
    ).resolves.toEqual({ outcome: 'invalid' });
    await expect(
      service.redeem({
        ...command,
        token: 'b'.repeat(43),
        confirmed: false,
        expectedMembershipRevision: 0,
        expectedInviteRevision: 1,
      }),
    ).resolves.toEqual({ outcome: 'confirmation_required' });
    expect(preview).not.toHaveBeenCalled();
    expect(redeem).not.toHaveBeenCalled();
  });
});
