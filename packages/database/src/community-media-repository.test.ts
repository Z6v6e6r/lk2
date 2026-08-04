import { describe, expect, it, vi } from 'vitest';

import { createCommunityMediaRepository } from './community-media-repository.js';

const tenantId = '86afbe01-0318-4dd2-bc25-303b7bf0d430';
const actorUserId = '49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca';
const communityId = '11111111-1111-4111-8111-111111111111';
const mediaId = '22222222-2222-4222-8222-222222222222';
const postId = '33333333-3333-4333-8333-333333333333';
const variantId = '44444444-4444-4444-8444-444444444444';
const now = new Date('2030-08-04T10:00:00.000Z');

const command = {
  tenantId,
  actorUserId,
  communityId,
  idempotencyKey: 'community-media-repository-0001',
  requestHash: 'a'.repeat(64),
  correlationId: 'community-media-correlation',
} as const;

function mediaRow(overrides: Record<string, unknown> = {}) {
  return {
    id: mediaId,
    community_id: communityId,
    uploader_user_id: actorUserId,
    state: 'UPLOADING',
    source_object_key: `community-media/quarantine/${tenantId}/${communityId}/${mediaId}/source`,
    source_object_version: null,
    source_etag: null,
    declared_content_type: 'image/jpeg',
    declared_size_bytes: 1_024,
    declared_sha256: 'b'.repeat(64),
    revision: 1,
    upload_expires_at: new Date('2030-08-04T10:15:00.000Z'),
    finalized_at: null,
    ready_at: null,
    rejected_at: null,
    rejection_code: null,
    unattached_expires_at: null,
    expired_at: null,
    purged_at: null,
    bound_post_id: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

function scanningStatus() {
  return {
    id: mediaId,
    communityId,
    uploaderUserId: actorUserId,
    mediaType: 'IMAGE',
    state: 'SCANNING',
    revision: 2,
    declaredContentType: 'image/jpeg',
    declaredByteSize: 1_024,
    declaredSha256: 'b'.repeat(64),
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    finalizedAt: now.toISOString(),
  };
}

function poolWithQuery(
  handler: (
    text: string,
    values: readonly unknown[],
  ) => readonly unknown[] | { rows: readonly unknown[]; rowCount?: number },
) {
  const query = vi.fn((text: string, values: readonly unknown[] = []) => {
    if (text === 'begin' || text === 'commit' || text === 'rollback') {
      return Promise.resolve({ rows: [], rowCount: 0 });
    }
    if (text.includes("set_config('app.tenant_id'")) {
      return Promise.resolve({ rows: [], rowCount: 0 });
    }
    const result = handler(text, values);
    if ('rows' in result) {
      return Promise.resolve({
        rows: result.rows,
        rowCount: result.rowCount ?? result.rows.length,
      });
    }
    return Promise.resolve({ rows: result, rowCount: result.length });
  });
  return {
    pool: { connect: vi.fn().mockResolvedValue({ query, release: vi.fn() }) } as never,
    query,
  };
}

describe('community media repository', () => {
  it('issues a tracked quarantine key with command, audit and outbox in one transaction', async () => {
    const { pool, query } = poolWithQuery((text, values) => {
      if (text.includes('from community_content.media_commands')) return [];
      if (text.includes('left join identity.users current_user')) {
        return [
          {
            actor_active: true,
            community_found: true,
            member_active: true,
            publishing_allowed: true,
          },
        ];
      }
      if (text.includes('insert into community_content.media_assets')) {
        return [
          mediaRow({
            id: values[1],
            source_object_key: values[4],
            declared_content_type: values[5],
            declared_size_bytes: values[6],
            declared_sha256: values[7],
          }),
        ];
      }
      return [];
    });

    const result = await createCommunityMediaRepository(pool).issueUpload({
      ...command,
      contentType: 'image/jpeg',
      byteSize: 1_024,
      sha256: 'b'.repeat(64),
    });
    expect(result).toMatchObject({ outcome: 'issued', replayed: false });
    if (!('intent' in result)) throw new Error('expected intent');
    expect(result.intent.objectKey).toContain(
      `/community-media/`.replace('/community', 'community'),
    );
    expect(result.intent.objectKey).toMatch(/^community-media\/quarantine\//);
    expect(query.mock.calls.some(([text]) => String(text).includes('media_commands'))).toBe(true);
    expect(query.mock.calls.some(([text]) => String(text).includes('audit.audit_log'))).toBe(true);
    const outbox = query.mock.calls.find(([text]) => String(text).includes('audit.outbox_events'));
    expect(outbox?.[1]?.[1]).toBe('community.media.upload_requested.v1');
    expect(query).toHaveBeenCalledWith('commit');
  });

  it('replays finalize before inspecting the object store target', async () => {
    const { pool, query } = poolWithQuery((text) => {
      if (text.includes('from community_content.media_commands')) {
        return [
          {
            command_type: 'FINALIZE_UPLOAD',
            request_hash: command.requestHash,
            result_payload: scanningStatus(),
          },
        ];
      }
      return [];
    });
    await expect(
      createCommunityMediaRepository(pool).getFinalizeTarget({
        ...command,
        mediaId,
        expectedRevision: 1,
      }),
    ).resolves.toMatchObject({ outcome: 'replayed', media: { state: 'SCANNING' } });
    expect(
      query.mock.calls.some(([text]) => String(text).includes('community_content.media_assets')),
    ).toBe(false);
  });

  it('does not issue upload capacity to a member who cannot publish in STAFF_FEED', async () => {
    const { pool, query } = poolWithQuery((text) => {
      if (text.includes('from community_content.media_commands')) return [];
      if (text.includes('left join identity.users current_user')) {
        return [
          {
            actor_active: true,
            community_found: true,
            member_active: true,
            publishing_allowed: false,
          },
        ];
      }
      return [];
    });
    await expect(
      createCommunityMediaRepository(pool).issueUpload({
        ...command,
        contentType: 'image/jpeg',
        byteSize: 1_024,
        sha256: 'b'.repeat(64),
      }),
    ).resolves.toEqual({ outcome: 'publishing_forbidden' });
    expect(
      query.mock.calls.some(([text]) =>
        String(text).includes('insert into community_content.media_assets'),
      ),
    ).toBe(false);
  });

  it('rejects observed metadata mismatch without transitioning to SCANNING', async () => {
    const { pool, query } = poolWithQuery((text) => {
      if (text.includes('from community_content.media_commands')) return [];
      if (text.includes('from community_content.media_assets') && text.includes('for update')) {
        return [mediaRow()];
      }
      return [];
    });
    await expect(
      createCommunityMediaRepository(pool).finalizeUpload({
        ...command,
        mediaId,
        expectedRevision: 1,
        observed: {
          byteSize: 2_048,
          contentType: 'image/jpeg',
          etag: 'etag-one',
          versionId: 'version-one',
          checksumSha256: 'b'.repeat(64),
        },
      }),
    ).resolves.toEqual({ outcome: 'object_mismatch' });
    expect(query.mock.calls.some(([text]) => String(text).includes("set state = 'SCANNING'"))).toBe(
      false,
    );
  });

  it('persists immutable VersionId and ETag before emitting scan_requested', async () => {
    const { pool, query } = poolWithQuery((text, values) => {
      if (text.includes('from community_content.media_commands')) return [];
      if (text.includes('from community_content.media_assets') && text.includes('for update')) {
        return [mediaRow()];
      }
      if (text.includes("set state = 'SCANNING'")) {
        expect(values[4]).toBe('version-one');
        expect(values[5]).toBe('etag-one');
        return [
          mediaRow({
            state: 'SCANNING',
            source_object_version: values[4],
            source_etag: values[5],
            revision: 2,
            finalized_at: now,
          }),
        ];
      }
      return [];
    });
    await expect(
      createCommunityMediaRepository(pool).finalizeUpload({
        ...command,
        mediaId,
        expectedRevision: 1,
        observed: {
          byteSize: 1_024,
          contentType: 'image/jpeg',
          etag: 'etag-one',
          versionId: 'version-one',
          checksumSha256: 'b'.repeat(64),
        },
      }),
    ).resolves.toMatchObject({ outcome: 'finalized', media: { state: 'SCANNING' } });
    const outbox = query.mock.calls.find(([text]) => String(text).includes('audit.outbox_events'));
    expect(outbox?.[1]?.[1]).toBe('community.media.scan_requested.v1');
  });

  it('claims scans with SKIP LOCKED and returns exact source version plus ETag', async () => {
    const { pool, query } = poolWithQuery((text) => {
      if (text.includes('with candidates as') && text.includes('scan_lease_owner')) {
        return [
          mediaRow({
            state: 'SCANNING',
            source_object_version: 'version-one',
            source_etag: 'etag-one',
            finalized_at: now,
            scan_attempts: 2,
          }),
        ];
      }
      return [];
    });
    await expect(
      createCommunityMediaRepository(pool).claimScans({
        tenantId,
        leaseOwner: 'worker-1',
        leaseSeconds: 60,
        limit: 10,
      }),
    ).resolves.toMatchObject([
      { sourceObjectVersion: 'version-one', sourceEtag: 'etag-one', scanAttempt: 2 },
    ]);
    expect(query.mock.calls.some(([text]) => String(text).includes('for update skip locked'))).toBe(
      true,
    );
  });

  it('completes a leased scan, persists versioned variants and schedules exact source GC', async () => {
    const { pool, query } = poolWithQuery((text) => {
      if (text.includes('from community_content.media_assets') && text.includes('for update')) {
        return [
          mediaRow({
            state: 'SCANNING',
            source_object_version: 'source-v1',
            source_etag: 'source-etag',
            finalized_at: now,
          }),
        ];
      }
      if (text.includes('scan_lease_owner = $3')) return [{ valid: true }];
      if (text.includes("set state = 'READY'")) {
        return [mediaRow({ state: 'READY', revision: 2, ready_at: now })];
      }
      return [];
    });
    await expect(
      createCommunityMediaRepository(pool).completeScan({
        tenantId,
        mediaId,
        leaseOwner: 'worker-1',
        computedSourceSha256: 'b'.repeat(64),
        correlationId: command.correlationId,
        variants: [
          {
            variant: 'FEED',
            objectKey: `community-media/ready/${tenantId}/${communityId}/${mediaId}/feed/${'c'.repeat(64)}.webp`,
            objectVersion: 'variant-v1',
            objectEtag: 'variant-etag',
            sha256: 'c'.repeat(64),
            byteSize: 512,
            width: 800,
            height: 600,
          },
        ],
      }),
    ).resolves.toBe('ready');
    expect(query.mock.calls.some(([text]) => String(text).includes('media_variants'))).toBe(true);
    const sourceGc = query.mock.calls.find(([text]) =>
      String(text).includes("values ($1, $2, 'SOURCE', $3, $4)"),
    );
    expect(sourceGc?.[1]?.[3]).toBe('source-v1');
  });

  it('attaches only READY media to one immutable post revision', async () => {
    const { pool, query } = poolWithQuery((text) => {
      if (text.includes('join community_content.post_revisions')) {
        return [{ author_user_id: actorUserId }];
      }
      if (text.includes('from community_content.post_revision_media')) return [];
      if (text.includes('from community_content.media_assets') && text.includes('for update')) {
        return [
          {
            id: mediaId,
            state: 'READY',
            uploader_user_id: actorUserId,
            bound_post_id: null,
          },
        ];
      }
      return [];
    });
    await expect(
      createCommunityMediaRepository(pool).attachReadyMediaToPostRevision({
        tenantId,
        actorUserId,
        communityId,
        postId,
        postRevision: 3,
        mediaIds: [mediaId],
        correlationId: command.correlationId,
      }),
    ).resolves.toEqual({ outcome: 'attached', mediaIds: [mediaId], replayed: false });
    const snapshot = query.mock.calls.find(([text]) =>
      String(text).includes('insert into community_content.post_revision_media'),
    );
    expect(snapshot?.[1]?.slice(2)).toEqual([postId, 3, mediaId, 1]);
  });

  it('authorizes delivery only through current published revision and active visibility', async () => {
    const { pool, query } = poolWithQuery((text) => {
      if (text.includes('select variant.object_key')) {
        return [
          {
            object_key: 'ready-key',
            object_version: 'ready-version',
            object_etag: 'ready-etag',
          },
        ];
      }
      return [];
    });
    await expect(
      createCommunityMediaRepository(pool).getAuthorizedVariant({
        tenantId,
        viewerUserId: actorUserId,
        communityId,
        mediaId,
        variant: 'FEED',
      }),
    ).resolves.toEqual({
      objectKey: 'ready-key',
      objectVersion: 'ready-version',
      objectEtag: 'ready-etag',
    });
    const sql = String(
      query.mock.calls.find(([text]) => String(text).includes('select variant'))?.[0],
    );
    expect(sql).toContain('attachment.post_revision = post.revision');
    expect(sql).toContain("post.status = 'PUBLISHED'");
    expect(sql).toContain("community.status = 'ACTIVE'");
    expect(sql).toContain("community.visibility = 'PUBLIC'");
  });

  it('claims GC by exact object version and uses a lease', async () => {
    const { pool, query } = poolWithQuery((text) => {
      if (text.includes('community_content.media_gc_jobs job')) {
        return [
          {
            id: variantId,
            media_id: mediaId,
            object_kind: 'VARIANT',
            object_key: 'ready-key',
            object_version: 'ready-v1',
            attempts: 1,
          },
        ];
      }
      return [];
    });
    await expect(
      createCommunityMediaRepository(pool).claimGc({
        tenantId,
        leaseOwner: 'gc-1',
        leaseSeconds: 60,
        limit: 10,
      }),
    ).resolves.toEqual([
      {
        jobId: variantId,
        mediaId,
        objectKind: 'VARIANT',
        objectKey: 'ready-key',
        objectVersion: 'ready-v1',
        attempt: 1,
      },
    ]);
    expect(query.mock.calls.some(([text]) => String(text).includes('for update skip locked'))).toBe(
      true,
    );
  });

  it('replays an issued upload and rejects mismatched idempotency reuse before authorization', async () => {
    const intent = {
      id: mediaId,
      communityId,
      uploaderUserId: actorUserId,
      mediaType: 'IMAGE',
      state: 'UPLOADING',
      revision: 1,
      declaredContentType: 'image/jpeg',
      declaredByteSize: 1_024,
      declaredSha256: 'b'.repeat(64),
      objectKey: `community-media/quarantine/${tenantId}/${communityId}/${mediaId}/source`,
      uploadExpiresAt: new Date('2030-08-04T10:15:00.000Z').toISOString(),
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    const replay = poolWithQuery((text) =>
      text.includes('from community_content.media_commands')
        ? [
            {
              command_type: 'ISSUE_UPLOAD',
              request_hash: command.requestHash,
              result_payload: intent,
            },
          ]
        : [],
    );
    await expect(
      createCommunityMediaRepository(replay.pool).issueUpload({
        ...command,
        contentType: 'image/jpeg',
        byteSize: 1_024,
        sha256: 'b'.repeat(64),
      }),
    ).resolves.toEqual({ outcome: 'issued', intent, replayed: true });
    expect(replay.query.mock.calls.some(([text]) => String(text).includes('current_user'))).toBe(
      false,
    );

    const conflict = poolWithQuery((text) =>
      text.includes('from community_content.media_commands')
        ? [
            {
              command_type: 'FINALIZE_UPLOAD',
              request_hash: command.requestHash,
              result_payload: intent,
            },
          ]
        : [],
    );
    await expect(
      createCommunityMediaRepository(conflict.pool).issueUpload({
        ...command,
        contentType: 'image/jpeg',
        byteSize: 1_024,
        sha256: 'b'.repeat(64),
      }),
    ).resolves.toEqual({ outcome: 'idempotency_conflict' });
  });

  it.each([
    {
      name: 'inactive actor',
      context: undefined,
      outcome: 'actor_not_active',
    },
    {
      name: 'missing community',
      context: {
        actor_active: true,
        community_found: false,
        member_active: false,
        publishing_allowed: false,
      },
      outcome: 'community_not_found',
    },
    {
      name: 'inactive membership',
      context: {
        actor_active: true,
        community_found: true,
        member_active: false,
        publishing_allowed: false,
      },
      outcome: 'membership_required',
    },
  ])('does not allocate media for $name', async ({ context, outcome }) => {
    const { pool, query } = poolWithQuery((text) => {
      if (text.includes('from community_content.media_commands')) return [];
      if (text.includes('left join identity.users current_user')) return context ? [context] : [];
      return [];
    });
    await expect(
      createCommunityMediaRepository(pool).issueUpload({
        ...command,
        contentType: 'image/jpeg',
        byteSize: 1_024,
        sha256: 'b'.repeat(64),
      }),
    ).resolves.toEqual({ outcome });
    expect(
      query.mock.calls.some(([text]) =>
        String(text).includes('insert into community_content.media_assets'),
      ),
    ).toBe(false);
  });

  it.each([
    {
      name: 'inactive actor',
      actor: [] as readonly unknown[],
      row: mediaRow(),
      outcome: 'actor_not_active',
    },
    {
      name: 'missing media',
      actor: [{ active: true }],
      row: undefined,
      outcome: 'media_not_found',
    },
    {
      name: 'stale revision',
      actor: [{ active: true }],
      row: mediaRow({ revision: 2 }),
      outcome: 'invalid_state',
    },
    {
      name: 'wrong lifecycle state',
      actor: [{ active: true }],
      row: mediaRow({ state: 'SCANNING' }),
      outcome: 'invalid_state',
    },
    {
      name: 'expired upload',
      actor: [{ active: true }],
      row: mediaRow({ upload_expires_at: new Date('2020-01-01T00:00:00.000Z') }),
      outcome: 'upload_expired',
    },
  ])('returns $outcome for finalize target with $name', async ({ actor, row, outcome }) => {
    const { pool } = poolWithQuery((text) => {
      if (text.includes('from community_content.media_commands')) return [];
      if (text.includes("select status = 'ACTIVE' as active")) return actor;
      if (text.includes('from community_content.media_assets')) return row ? [row] : [];
      return [];
    });
    await expect(
      createCommunityMediaRepository(pool).getFinalizeTarget({
        ...command,
        mediaId,
        expectedRevision: 1,
      }),
    ).resolves.toEqual({ outcome });
  });

  it('rejects invalid worker bounds, variants and stable error codes before opening transactions', () => {
    const repository = createCommunityMediaRepository({ connect: vi.fn() } as never);
    expect(() =>
      repository.claimScans({ tenantId, leaseOwner: 'worker', leaseSeconds: 60, limit: 0 }),
    ).toThrow('COMMUNITY_MEDIA_SCAN_CLAIM_LIMIT_INVALID');
    expect(() =>
      repository.claimGc({ tenantId, leaseOwner: 'worker', leaseSeconds: 3_601, limit: 1 }),
    ).toThrow('COMMUNITY_MEDIA_GC_LEASE_INVALID');
    expect(() =>
      repository.completeScan({
        tenantId,
        mediaId,
        leaseOwner: 'worker',
        computedSourceSha256: 'b'.repeat(64),
        correlationId: command.correlationId,
        variants: [],
      }),
    ).toThrow('COMMUNITY_MEDIA_VARIANTS_INVALID');
    expect(() =>
      repository.rejectScan({
        tenantId,
        mediaId,
        leaseOwner: 'worker',
        rejectionCode: 'bad-code',
        correlationId: command.correlationId,
      }),
    ).toThrow('COMMUNITY_MEDIA_REJECTION_CODE_INVALID');
    expect(() =>
      repository.releaseScan({
        tenantId,
        mediaId,
        leaseOwner: 'worker',
        retryAt: now.toISOString(),
        errorCode: 'bad-code',
      }),
    ).toThrow('COMMUNITY_MEDIA_SCAN_ERROR_CODE_INVALID');
    expect(() =>
      repository.failGc({
        tenantId,
        jobId: variantId,
        leaseOwner: 'worker',
        retryAt: now.toISOString(),
        errorCode: 'bad-code',
      }),
    ).toThrow('COMMUNITY_MEDIA_GC_ERROR_CODE_INVALID');
  });

  it('fails a scan claim when immutable source version evidence is missing', async () => {
    const { pool } = poolWithQuery((text) =>
      text.includes('with candidates as')
        ? [
            mediaRow({
              state: 'SCANNING',
              source_object_version: null,
              source_etag: null,
              scan_attempts: 1,
            }),
          ]
        : [],
    );
    await expect(
      createCommunityMediaRepository(pool).claimScans({
        tenantId,
        leaseOwner: 'worker',
        leaseSeconds: 60,
        limit: 1,
      }),
    ).rejects.toThrow('COMMUNITY_MEDIA_SOURCE_VERSION_MISSING');
  });
});
