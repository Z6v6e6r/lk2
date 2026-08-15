import { describe, expect, it, vi } from 'vitest';

import { createCommunityMembershipPinService } from './membership-pin.js';

const command = {
  tenantId: '86afbe01-0318-4dd2-bc25-303b7bf0d430',
  actorUserId: '49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca',
  communityId: '11111111-1111-4111-8111-111111111111',
  pinned: true,
  expectedRevision: 2,
  idempotencyKey: 'community-pin-test-0001',
  requestHash: 'a'.repeat(64),
  correlationId: 'community-pin-correlation',
} as const;

describe('community membership pin service', () => {
  it('validates the command and returns the canonical repository state', async () => {
    const setPin = vi.fn().mockResolvedValue({
      outcome: 'applied',
      replayed: false,
      membership: {
        communityId: command.communityId,
        pinned: true,
        revision: 3,
        updatedAt: '2026-08-03T10:00:00.000Z',
      },
    });

    await expect(
      createCommunityMembershipPinService({ setPin }).setPin(command),
    ).resolves.toMatchObject({
      outcome: 'applied',
      membership: { revision: 3, pinned: true },
    });
    expect(setPin).toHaveBeenCalledWith(command);
  });
});
