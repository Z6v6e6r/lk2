import { describe, expect, it, vi } from 'vitest';

import { CommunityCreateError, createCommunityCreateService } from './community-create.js';

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

const community = {
  id: '11111111-1111-4111-8111-111111111111',
  title: input.title,
  description: input.description,
  visibility: input.visibility,
  joinPolicy: input.joinPolicy,
  publishingPreset: input.publishingPreset,
  status: 'ACTIVE',
  revision: 1,
  ownerUserId: input.actorUserId,
  createdAt: '2026-08-03T10:00:00.000Z',
  updatedAt: '2026-08-03T10:00:00.000Z',
} as const;

describe('community create service', () => {
  it('validates and delegates an explicit canonical create command', async () => {
    const repository = {
      create: vi.fn().mockResolvedValue({ outcome: 'created', community, replayed: false }),
    };
    await expect(createCommunityCreateService(repository).create(input)).resolves.toEqual({
      outcome: 'created',
      community,
      replayed: false,
    });
    expect(repository.create).toHaveBeenCalledWith(input);
  });

  it.each([
    { ...input, title: ' '.repeat(2) },
    { ...input, title: 'a'.repeat(121) },
    { ...input, description: 'a'.repeat(2_001) },
    { ...input, visibility: 'OPEN' },
    { ...input, publishingPreset: 'DEFAULT' },
    { ...input, quotaOverride: 'true' },
  ])('rejects an invalid command before persistence', async (invalidInput) => {
    const repository = { create: vi.fn() };
    await expect(
      createCommunityCreateService(repository).create(invalidInput as never),
    ).rejects.toEqual(new CommunityCreateError('COMMUNITY_CREATE_COMMAND_INVALID'));
    expect(repository.create).not.toHaveBeenCalled();
  });

  it('rejects malformed persisted state', async () => {
    const repository = {
      create: vi.fn().mockResolvedValue({
        outcome: 'created',
        community: { ...community, revision: 0 },
        replayed: false,
      }),
    };
    await expect(createCommunityCreateService(repository).create(input)).rejects.toEqual(
      new CommunityCreateError('COMMUNITY_CREATE_COMMAND_INVALID'),
    );
  });
});
