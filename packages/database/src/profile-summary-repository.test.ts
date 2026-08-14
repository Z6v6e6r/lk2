import { describe, expect, it, vi } from 'vitest';

import {
  createProfileSummaryRepository,
  ProfilePhotoGrantStaleError,
  ProfilePhotoIdempotencyConflictError,
} from './profile-summary-repository.js';

const tenantId = '86afbe01-0318-4dd2-bc25-303b7bf0d430';
const firstUserId = '49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca';
const secondUserId = 'bd35543d-c565-443a-bd3d-eea68eb2fbe6';

describe('profile summary repository', () => {
  it('rejects an old browser grant after a newer provider removal tombstone', async () => {
    const query = vi.fn((text: string) => {
      if (
        text === 'begin' ||
        text === 'rollback' ||
        text.includes("set_config('app.tenant_id'") ||
        text.includes('pg_advisory_xact_lock')
      ) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (text.includes('from integration.profile_photo_client_commands')) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (text.includes('from integration.user_profile_photo_sync')) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (text.includes('from integration.profile_photo_observation_watermarks')) {
        return Promise.resolve({
          rows: [{ observed_at: '2026-08-14T10:00:00.000Z' }],
          rowCount: 1,
        });
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = createProfileSummaryRepository({
      connect: vi.fn().mockResolvedValue({ query, release: vi.fn() }),
    } as never);

    await expect(
      repository.reserveClientAssistedPhoto?.({
        tenantId,
        userId: firstUserId,
        objectKey: `profile-photos/${tenantId}/${firstUserId}/${'a'.repeat(64)}.webp`,
        contentSha256: 'a'.repeat(64),
        requestSha256: 'b'.repeat(64),
        idempotencyKey: 'stale-after-removal',
        grantId: '33333333-3333-4333-8333-333333333333',
        grantIssuedAt: '2026-08-14T09:59:00.000Z',
        expiresAt: '2026-08-14T11:00:00.000Z',
      }),
    ).rejects.toBeInstanceOf(ProfilePhotoGrantStaleError);
  });

  it('activates a client-assisted WebP without persisting its provider URL', async () => {
    const objectKey = `profile-photos/${tenantId}/${firstUserId}/${'a'.repeat(64)}.webp`;
    let commandReads = 0;
    const query = vi.fn((text: string, values?: readonly unknown[]) => {
      if (
        text === 'begin' ||
        text === 'commit' ||
        text === 'rollback' ||
        text.includes("set_config('app.tenant_id'") ||
        text.includes('pg_advisory_xact_lock') ||
        text.includes('delete from integration.profile_photo_object_gc') ||
        text.includes('insert into audit.audit_log')
      ) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (text.includes('select delivery_id, object_key, content_sha256')) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (text.includes('from integration.profile_photo_observation_watermarks')) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (text.includes('from integration.profile_photo_client_commands')) {
        commandReads += 1;
        return Promise.resolve({
          rows:
            commandReads === 1
              ? []
              : [
                  {
                    idempotency_key: 'profile-photo-client-sync-test',
                    grant_id: '33333333-3333-4333-8333-333333333333',
                    request_sha256: 'b'.repeat(64),
                    content_sha256: 'a'.repeat(64),
                    object_key: objectKey,
                    grant_issued_at: '2026-08-14T09:59:00.000Z',
                    avatar_url: null,
                  },
                ],
          rowCount: commandReads === 1 ? 0 : 1,
        });
      }
      if (text.includes('update profile.user_summaries')) {
        expect(values?.[0]).toBe(tenantId);
        expect(values?.[1]).toBe(firstUserId);
        return Promise.resolve({ rows: [], rowCount: 1 });
      }
      if (text.includes('insert into integration.user_profile_photo_sync')) {
        expect(text).toContain('values ($1, $2, $3, null, null, null, $4, $5, $6, $7)');
        return Promise.resolve({ rows: [], rowCount: 1 });
      }
      if (text.includes('insert into integration.profile_photo_observation_watermarks')) {
        expect(values?.[2]).toBe('2026-08-14T09:59:00.000Z');
        return Promise.resolve({ rows: [], rowCount: 1 });
      }
      if (
        text.includes('insert into integration.profile_photo_client_commands') ||
        text.includes('insert into integration.profile_photo_object_gc') ||
        text.includes('update integration.profile_photo_client_commands')
      ) {
        return Promise.resolve({ rows: [], rowCount: 1 });
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const pool = {
      connect: vi.fn().mockResolvedValue({ query, release: vi.fn() }),
    };
    const repository = createProfileSummaryRepository(pool as never);

    const command = {
      tenantId,
      userId: firstUserId,
      objectKey,
      contentSha256: 'a'.repeat(64),
      requestSha256: 'b'.repeat(64),
      idempotencyKey: 'profile-photo-client-sync-test',
      grantId: '33333333-3333-4333-8333-333333333333',
      grantIssuedAt: '2026-08-14T09:59:00.000Z',
    } as const;
    await expect(
      repository.reserveClientAssistedPhoto?.({
        ...command,
        expiresAt: '2026-08-14T11:00:00.000Z',
      }),
    ).resolves.toEqual({ replayed: false });
    const result = await repository.finalizeClientAssistedPhoto?.({
      ...command,
      syncedAt: '2026-08-14T10:00:00.000Z',
      previousObjectRetentionSeconds: 3_600,
      correlationId: 'profile-photo-client-sync-test',
    });
    expect(result?.avatarUrl).toMatch(
      new RegExp(`^/public/api/v1/media/profile-photos/${tenantId}/[0-9a-f-]{36}$`),
    );
    expect(result?.replayed).toBe(false);
  });

  it('replays only the exact idempotency key, grant, and request digest', async () => {
    const avatarUrl = `/public/api/v1/media/profile-photos/${tenantId}/33333333-3333-4333-8333-333333333333`;
    const query = vi.fn((text: string) => {
      if (
        text === 'begin' ||
        text === 'commit' ||
        text.includes("set_config('app.tenant_id'") ||
        text.includes('pg_advisory_xact_lock')
      ) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (text.includes('from integration.profile_photo_client_commands')) {
        return Promise.resolve({
          rows: [
            {
              idempotency_key: 'profile-photo-client-sync-replay',
              grant_id: '33333333-3333-4333-8333-333333333333',
              request_sha256: 'b'.repeat(64),
              content_sha256: 'a'.repeat(64),
              object_key: `profile-photos/${tenantId}/${firstUserId}/${'a'.repeat(64)}.webp`,
              grant_issued_at: '2026-08-14T09:59:00.000Z',
              avatar_url: avatarUrl,
            },
          ],
          rowCount: 1,
        });
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = createProfileSummaryRepository({
      connect: vi.fn().mockResolvedValue({ query, release: vi.fn() }),
    } as never);

    await expect(
      repository.reserveClientAssistedPhoto?.({
        tenantId,
        userId: firstUserId,
        objectKey: `profile-photos/${tenantId}/${firstUserId}/${'a'.repeat(64)}.webp`,
        contentSha256: 'a'.repeat(64),
        requestSha256: 'b'.repeat(64),
        idempotencyKey: 'profile-photo-client-sync-replay',
        grantId: '33333333-3333-4333-8333-333333333333',
        grantIssuedAt: '2026-08-14T09:59:00.000Z',
        expiresAt: '2026-08-14T11:00:00.000Z',
      }),
    ).resolves.toEqual({ avatarUrl, replayed: true });
    expect(
      query.mock.calls.some(([text]) => String(text).includes('user_profile_photo_sync')),
    ).toBe(false);
  });

  it('rejects reuse of a grant under another idempotency key', async () => {
    const query = vi.fn((text: string) => {
      if (
        text === 'begin' ||
        text === 'rollback' ||
        text.includes("set_config('app.tenant_id'") ||
        text.includes('pg_advisory_xact_lock')
      ) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (text.includes('from integration.profile_photo_client_commands')) {
        return Promise.resolve({
          rows: [
            {
              idempotency_key: 'original-key',
              grant_id: '33333333-3333-4333-8333-333333333333',
              request_sha256: 'b'.repeat(64),
              content_sha256: 'a'.repeat(64),
              object_key: `profile-photos/${tenantId}/${firstUserId}/${'a'.repeat(64)}.webp`,
              grant_issued_at: '2026-08-14T09:59:00.000Z',
              avatar_url: '/public/api/v1/media/profile-photos/example',
            },
          ],
          rowCount: 1,
        });
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = createProfileSummaryRepository({
      connect: vi.fn().mockResolvedValue({ query, release: vi.fn() }),
    } as never);

    await expect(
      repository.reserveClientAssistedPhoto?.({
        tenantId,
        userId: firstUserId,
        objectKey: `profile-photos/${tenantId}/${firstUserId}/${'a'.repeat(64)}.webp`,
        contentSha256: 'a'.repeat(64),
        requestSha256: 'b'.repeat(64),
        idempotencyKey: 'different-key',
        grantId: '33333333-3333-4333-8333-333333333333',
        grantIssuedAt: '2026-08-14T09:59:00.000Z',
        expiresAt: '2026-08-14T11:00:00.000Z',
      }),
    ).rejects.toBeInstanceOf(ProfilePhotoIdempotencyConflictError);
  });

  it('loads current display names for game-card initials in one batch', async () => {
    const query = vi.fn((text: string) => {
      if (text.includes('select user_id, display_name')) {
        return Promise.resolve({
          rows: [
            { user_id: firstUserId, display_name: 'Мария Шмакина' },
            { user_id: secondUserId, display_name: 'Артур Ситдиков' },
          ],
        });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });
    const pool = {
      connect: vi.fn().mockResolvedValue({ query, release: vi.fn() }),
    };
    const repository = createProfileSummaryRepository(pool as never);

    await expect(
      repository.getDisplayNames(tenantId, [firstUserId, secondUserId]),
    ).resolves.toEqual(
      new Map([
        [firstUserId, 'Мария Шмакина'],
        [secondUserId, 'Артур Ситдиков'],
      ]),
    );
    expect(
      query.mock.calls.some(([text]) => String(text).includes('select user_id, display_name')),
    ).toBe(true);
  });

  it('loads normalized CUP level values for game-card progress rings', async () => {
    const query = vi.fn((text: string) => {
      if (text.includes('select user_id, level_value')) {
        return Promise.resolve({
          rows: [
            { user_id: firstUserId, level_value: '3.43844' },
            { user_id: secondUserId, level_value: 4.82 },
          ],
        });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });
    const pool = {
      connect: vi.fn().mockResolvedValue({ query, release: vi.fn() }),
    };
    const repository = createProfileSummaryRepository(pool as never);

    await expect(repository.getLevelValues(tenantId, [firstUserId, secondUserId])).resolves.toEqual(
      new Map([
        [firstUserId, 3.43844],
        [secondUserId, 4.82],
      ]),
    );
    expect(
      query.mock.calls.some(([text]) => String(text).includes('level_value is not null')),
    ).toBe(true);
  });
});
