import { describe, expect, it, vi } from 'vitest';

import {
  COMMUNITY_MEDIA_MAX_SOURCE_BYTES,
  CommunityMediaError,
  communityMediaStatusSchema,
  communityPostMediaSnapshotSchema,
  createCommunityMediaService,
  type CommunityFinalizeMediaUploadPersistenceInput,
} from './community-media.js';

const command = {
  tenantId: '86afbe01-0318-4dd2-bc25-303b7bf0d430',
  actorUserId: '49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca',
  communityId: '11111111-1111-4111-8111-111111111111',
  idempotencyKey: 'community-media-test-0001',
  requestHash: 'a'.repeat(64),
  correlationId: 'community-media-correlation',
} as const;

const baseMedia = {
  id: '22222222-2222-4222-8222-222222222222',
  communityId: command.communityId,
  uploaderUserId: command.actorUserId,
  mediaType: 'IMAGE',
  revision: 1,
  declaredContentType: 'image/jpeg',
  declaredByteSize: 1024,
  declaredSha256: 'b'.repeat(64),
  createdAt: '2026-08-04T10:00:00.000Z',
  updatedAt: '2026-08-04T10:00:00.000Z',
} as const;

function repository() {
  return {
    issueUpload: vi.fn().mockResolvedValue({
      outcome: 'issued',
      replayed: false,
      intent: {
        ...baseMedia,
        state: 'UPLOADING',
        objectKey: `community-media/${command.tenantId}/${baseMedia.id}/source`,
        uploadExpiresAt: '2030-08-04T10:15:00.000Z',
      },
    }),
    getFinalizeTarget: vi.fn(),
    finalizeUpload: vi.fn(),
    getMedia: vi.fn(),
  };
}

function service(repo = repository()) {
  return createCommunityMediaService({
    repository: repo,
    uploadSigner: {
      issueUploadTarget: vi.fn().mockResolvedValue({
        method: 'PUT',
        url: 'https://quarantine.padlhub.test/upload',
        requiredHeaders: { 'Content-Type': 'image/jpeg' },
        expiresAt: '2030-08-04T10:15:00.000Z',
      }),
    },
    objectInspector: { inspectCurrentVersion: vi.fn() },
  });
}

describe('community media domain', () => {
  it.each(['image/jpeg', 'image/png', 'image/webp'] as const)(
    'issues a bounded %s upload without exposing an object key',
    async (contentType) => {
      const repo = repository();
      const result = await service(repo).issueUpload({
        ...command,
        contentType,
        byteSize: COMMUNITY_MEDIA_MAX_SOURCE_BYTES,
        sha256: 'b'.repeat(64),
      });
      expect(result.outcome).toBe('issued');
      expect(repo.issueUpload).toHaveBeenCalledWith(
        expect.objectContaining({ contentType, byteSize: COMMUNITY_MEDIA_MAX_SOURCE_BYTES }),
      );
      expect(JSON.stringify(result)).not.toContain('objectKey');
    },
  );

  it.each([
    { contentType: 'image/gif', byteSize: 1024, sha256: 'b'.repeat(64) },
    {
      contentType: 'image/jpeg',
      byteSize: COMMUNITY_MEDIA_MAX_SOURCE_BYTES + 1,
      sha256: 'b'.repeat(64),
    },
    { contentType: 'image/jpeg', byteSize: 1024, sha256: 'not-a-sha' },
  ])('rejects unsupported or unbounded issue input', async (invalid) => {
    const repo = repository();
    await expect(service(repo).issueUpload({ ...command, ...invalid } as never)).rejects.toEqual(
      new CommunityMediaError('COMMUNITY_MEDIA_COMMAND_INVALID'),
    );
    expect(repo.issueUpload).not.toHaveBeenCalled();
  });

  it('accepts only PadlHub variant URLs for READY media', () => {
    const parsed = communityMediaStatusSchema.safeParse({
      ...baseMedia,
      state: 'READY',
      revision: 3,
      width: 1280,
      height: 853,
      variants: [
        {
          variant: 'FEED',
          url: `/user/api/v1/local-padel/communities/${command.communityId}/media/${baseMedia.id}/variants/FEED`,
          contentType: 'image/webp',
          width: 1280,
          height: 853,
          byteSize: 100_000,
        },
      ],
      readyAt: '2026-08-04T10:01:00.000Z',
      unattachedExpiresAt: '2026-08-05T10:01:00.000Z',
      updatedAt: '2026-08-04T10:01:00.000Z',
    });
    expect(parsed.success).toBe(true);
    expect(
      communityMediaStatusSchema.safeParse({
        ...(parsed.success ? parsed.data : {}),
        variants: [
          {
            variant: 'FEED',
            url: 'https://s3.example.test/private/object?signature=secret',
            contentType: 'image/webp',
            width: 1280,
            height: 853,
            byteSize: 100_000,
          },
        ],
      }).success,
    ).toBe(false);
  });

  it('finalizes only after inspecting the exact immutable object version', async () => {
    const repo = repository();
    repo.getFinalizeTarget.mockResolvedValue({
      outcome: 'inspect',
      objectKey: `community-media/${command.tenantId}/${baseMedia.id}/source`,
    });
    repo.finalizeUpload.mockResolvedValue({
      outcome: 'finalized',
      replayed: false,
      media: {
        ...baseMedia,
        state: 'SCANNING',
        revision: 2,
        finalizedAt: '2026-08-04T10:01:00.000Z',
        updatedAt: '2026-08-04T10:01:00.000Z',
      },
    });
    const observed = {
      byteSize: baseMedia.declaredByteSize,
      contentType: baseMedia.declaredContentType,
      etag: 'immutable-etag',
      versionId: 'immutable-version-id',
      checksumSha256: baseMedia.declaredSha256,
    };
    const mediaService = createCommunityMediaService({
      repository: repo,
      uploadSigner: { issueUploadTarget: vi.fn() },
      objectInspector: { inspectCurrentVersion: vi.fn().mockResolvedValue(observed) },
    });
    await mediaService.finalizeUpload({
      ...command,
      mediaId: baseMedia.id,
      expectedRevision: 1,
    });
    const applied = repo.finalizeUpload.mock.calls[0]?.[0] as
      CommunityFinalizeMediaUploadPersistenceInput | undefined;
    expect(applied?.observed.versionId).toBe(observed.versionId);
  });

  it('replays a finalized command before inspecting a quarantine object that may be gone', async () => {
    const repo = repository();
    const scanning = {
      ...baseMedia,
      state: 'SCANNING' as const,
      revision: 2,
      finalizedAt: '2026-08-04T10:01:00.000Z',
      updatedAt: '2026-08-04T10:01:00.000Z',
    };
    repo.getFinalizeTarget.mockResolvedValue({ outcome: 'replayed', media: scanning });
    const inspectCurrentVersion = vi.fn();
    const mediaService = createCommunityMediaService({
      repository: repo,
      uploadSigner: { issueUploadTarget: vi.fn() },
      objectInspector: { inspectCurrentVersion },
    });
    await expect(
      mediaService.finalizeUpload({
        ...command,
        mediaId: baseMedia.id,
        expectedRevision: 1,
      }),
    ).resolves.toEqual({ outcome: 'finalized', media: scanning, replayed: true });
    expect(inspectCurrentVersion).not.toHaveBeenCalled();
    expect(repo.finalizeUpload).not.toHaveBeenCalled();
  });

  it('bounds an immutable ordered post revision snapshot to ten unique media IDs', () => {
    const media = Array.from({ length: 10 }, (_, index) => ({
      id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      mediaType: 'IMAGE' as const,
      width: 1280,
      height: 853,
      variants: [
        {
          variant: 'FEED' as const,
          url: `/user/api/v1/local/media/${index}`,
          contentType: 'image/webp' as const,
          width: 1280,
          height: 853,
          byteSize: 1,
        },
      ],
    }));
    const snapshot = {
      postId: '33333333-3333-4333-8333-333333333333',
      postRevision: 4,
      media,
    };
    expect(communityPostMediaSnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(
      communityPostMediaSnapshotSchema.safeParse({ ...snapshot, media: [...media, media[0]] })
        .success,
    ).toBe(false);
  });

  it('passes through issue authorization failures without signing an upload', async () => {
    const repo = repository();
    repo.issueUpload.mockResolvedValue({ outcome: 'membership_required' });
    const uploadSigner = { issueUploadTarget: vi.fn() };
    const mediaService = createCommunityMediaService({
      repository: repo,
      uploadSigner,
      objectInspector: { inspectCurrentVersion: vi.fn() },
    });
    await expect(
      mediaService.issueUpload({
        ...command,
        contentType: 'image/jpeg',
        byteSize: 1_024,
        sha256: 'b'.repeat(64),
      }),
    ).resolves.toEqual({ outcome: 'membership_required' });
    expect(uploadSigner.issueUploadTarget).not.toHaveBeenCalled();
  });

  it('rejects an invalid persisted upload intent before asking the signer', async () => {
    const repo = repository();
    repo.issueUpload.mockResolvedValue({
      outcome: 'issued',
      replayed: false,
      intent: {
        ...baseMedia,
        state: 'UPLOADING',
        objectKey: '',
        uploadExpiresAt: '2026-08-04T10:15:00.000Z',
      },
    });
    const uploadSigner = { issueUploadTarget: vi.fn() };
    const mediaService = createCommunityMediaService({
      repository: repo,
      uploadSigner,
      objectInspector: { inspectCurrentVersion: vi.fn() },
    });
    await expect(
      mediaService.issueUpload({
        ...command,
        contentType: 'image/jpeg',
        byteSize: 1_024,
        sha256: 'b'.repeat(64),
      }),
    ).rejects.toEqual(new CommunityMediaError('COMMUNITY_MEDIA_STATE_INVALID'));
    expect(uploadSigner.issueUploadTarget).not.toHaveBeenCalled();
  });

  it('does not sign a persisted upload intent that has already expired', async () => {
    const repo = repository();
    repo.issueUpload.mockResolvedValue({
      outcome: 'issued',
      replayed: true,
      intent: {
        ...baseMedia,
        state: 'UPLOADING',
        objectKey: `community-media/quarantine/${command.tenantId}/${command.communityId}/${baseMedia.id}/source`,
        uploadExpiresAt: '2020-08-04T10:15:00.000Z',
      },
    });
    const uploadSigner = { issueUploadTarget: vi.fn() };
    const mediaService = createCommunityMediaService({
      repository: repo,
      uploadSigner,
      objectInspector: { inspectCurrentVersion: vi.fn() },
    });

    await expect(
      mediaService.issueUpload({
        ...command,
        contentType: 'image/jpeg',
        byteSize: 1_024,
        sha256: 'b'.repeat(64),
      }),
    ).resolves.toEqual({ outcome: 'upload_expired' });
    expect(uploadSigner.issueUploadTarget).not.toHaveBeenCalled();
  });

  it('handles missing and malformed immutable objects without finalizing', async () => {
    const repo = repository();
    repo.getFinalizeTarget.mockResolvedValue({ outcome: 'inspect', objectKey: 'quarantine-key' });
    const inspectCurrentVersion = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({
        byteSize: 1_024,
        contentType: 'image/jpeg',
        etag: '',
        versionId: 'version-one',
        checksumSha256: 'b'.repeat(64),
      });
    const mediaService = createCommunityMediaService({
      repository: repo,
      uploadSigner: { issueUploadTarget: vi.fn() },
      objectInspector: { inspectCurrentVersion },
    });
    const input = { ...command, mediaId: baseMedia.id, expectedRevision: 1 };
    await expect(mediaService.finalizeUpload(input)).resolves.toEqual({
      outcome: 'object_missing',
    });
    await expect(mediaService.finalizeUpload(input)).rejects.toEqual(
      new CommunityMediaError('COMMUNITY_MEDIA_STATE_INVALID'),
    );
    expect(repo.finalizeUpload).not.toHaveBeenCalled();
  });

  it('passes through finalize failures and rejects invalid replay or persisted status', async () => {
    const repo = repository();
    const mediaService = service(repo);
    const input = { ...command, mediaId: baseMedia.id, expectedRevision: 1 };

    repo.getFinalizeTarget.mockResolvedValueOnce({ outcome: 'upload_expired' });
    await expect(mediaService.finalizeUpload(input)).resolves.toEqual({
      outcome: 'upload_expired',
    });

    repo.getFinalizeTarget.mockResolvedValueOnce({
      outcome: 'replayed',
      media: { ...baseMedia, state: 'SCANNING', finalizedAt: 'not-a-date' },
    });
    await expect(mediaService.finalizeUpload(input)).rejects.toEqual(
      new CommunityMediaError('COMMUNITY_MEDIA_STATE_INVALID'),
    );

    repo.getFinalizeTarget.mockResolvedValueOnce({
      outcome: 'inspect',
      objectKey: 'quarantine-key',
    });
    repo.finalizeUpload.mockResolvedValueOnce({
      outcome: 'finalized',
      replayed: false,
      media: { ...baseMedia, state: 'READY', variants: [] },
    });
    const observed = {
      byteSize: 1_024,
      contentType: 'image/jpeg',
      etag: 'etag-one',
      versionId: 'version-one',
      checksumSha256: 'b'.repeat(64),
    };
    const inspectedService = createCommunityMediaService({
      repository: repo,
      uploadSigner: { issueUploadTarget: vi.fn() },
      objectInspector: { inspectCurrentVersion: vi.fn().mockResolvedValue(observed) },
    });
    await expect(inspectedService.finalizeUpload(input)).rejects.toEqual(
      new CommunityMediaError('COMMUNITY_MEDIA_STATE_INVALID'),
    );
  });

  it('validates get requests and persisted media states', async () => {
    const repo = repository();
    const mediaService = service(repo);
    await expect(
      mediaService.getMedia({
        tenantId: command.tenantId,
        actorUserId: command.actorUserId,
        communityId: command.communityId,
        mediaId: 'invalid',
        correlationId: command.correlationId,
      }),
    ).rejects.toEqual(new CommunityMediaError('COMMUNITY_MEDIA_COMMAND_INVALID'));

    repo.getMedia.mockResolvedValueOnce({ outcome: 'media_not_found' });
    await expect(
      mediaService.getMedia({
        tenantId: command.tenantId,
        actorUserId: command.actorUserId,
        communityId: command.communityId,
        mediaId: baseMedia.id,
        correlationId: command.correlationId,
      }),
    ).resolves.toEqual({ outcome: 'media_not_found' });

    repo.getMedia.mockResolvedValueOnce({
      outcome: 'found',
      media: { ...baseMedia, state: 'UPLOADING', uploadExpiresAt: 'not-a-date' },
    });
    await expect(
      mediaService.getMedia({
        tenantId: command.tenantId,
        actorUserId: command.actorUserId,
        communityId: command.communityId,
        mediaId: baseMedia.id,
        correlationId: command.correlationId,
      }),
    ).rejects.toEqual(new CommunityMediaError('COMMUNITY_MEDIA_STATE_INVALID'));
  });
});
