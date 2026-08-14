import { describe, expect, it, vi } from 'vitest';

import {
  CommunityOwnershipTransferError,
  createCommunityOwnershipTransferService,
} from './ownership-transfer.js';

const input = {
  tenantId: '86afbe01-0318-4dd2-bc25-303b7bf0d430',
  actorUserId: '49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca',
  communityId: '11111111-1111-4111-8111-111111111111',
  targetUserId: '22222222-2222-4222-8222-222222222222',
  expectedOwnerRevision: 4,
  expectedTargetRevision: 2,
  idempotencyKey: 'owner-transfer-test-0001',
  requestHash: 'a'.repeat(64),
  correlationId: 'owner-transfer-correlation',
} as const;

const transfer = {
  communityId: input.communityId,
  previousOwner: { userId: input.actorUserId, role: 'ADMIN', revision: 5 },
  owner: {
    userId: input.targetUserId,
    previousRole: 'MEMBER',
    role: 'OWNER',
    revision: 3,
  },
  transferredAt: '2026-08-04T12:00:00.000Z',
} as const;

describe('community ownership transfer service', () => {
  it('validates and delegates a revision-checked transfer', async () => {
    const repository = {
      transfer: vi.fn().mockResolvedValue({ outcome: 'transferred', transfer, replayed: false }),
    };
    await expect(
      createCommunityOwnershipTransferService(repository).transfer(input),
    ).resolves.toEqual({
      outcome: 'transferred',
      transfer,
      replayed: false,
    });
    expect(repository.transfer).toHaveBeenCalledWith(input);
  });

  it('rejects self-transfer and malformed revisions before persistence', async () => {
    const repository = { transfer: vi.fn() };
    const service = createCommunityOwnershipTransferService(repository);
    await expect(service.transfer({ ...input, targetUserId: input.actorUserId })).rejects.toEqual(
      new CommunityOwnershipTransferError('COMMUNITY_OWNERSHIP_TRANSFER_INVALID'),
    );
    await expect(service.transfer({ ...input, expectedOwnerRevision: 0 })).rejects.toEqual(
      new CommunityOwnershipTransferError('COMMUNITY_OWNERSHIP_TRANSFER_INVALID'),
    );
    expect(repository.transfer).not.toHaveBeenCalled();
  });

  it('rejects malformed persisted transfer state', async () => {
    const repository = {
      transfer: vi.fn().mockResolvedValue({
        outcome: 'transferred',
        transfer: { ...transfer, previousOwner: { ...transfer.previousOwner, role: 'MEMBER' } },
        replayed: false,
      }),
    };
    await expect(
      createCommunityOwnershipTransferService(repository).transfer(input),
    ).rejects.toEqual(new CommunityOwnershipTransferError('COMMUNITY_OWNERSHIP_TRANSFER_INVALID'));
  });
});
