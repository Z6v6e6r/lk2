import { describe, expect, it, vi } from 'vitest';

import { runProfilePhotoMaintenanceCycle } from './viva-home-sync.js';

describe('profile photo maintenance', () => {
  it('runs independently while Home synchronization is disabled', async () => {
    const tenantId = '86afbe01-0318-4dd2-bc25-303b7bf0d430';
    const transactionQuery = vi.fn((text: string) => {
      if (
        text === 'begin' ||
        text === 'commit' ||
        text === 'rollback' ||
        text.includes("set_config('app.tenant_id'")
      ) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (text.includes('from integration.profile_photo_object_gc')) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (text.includes('delete from integration.profile_photo_client_commands')) {
        return Promise.resolve({ rows: [], rowCount: 2 });
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const pool = {
      query: vi.fn().mockResolvedValue({ rows: [{ id: tenantId }], rowCount: 1 }),
      connect: vi.fn().mockResolvedValue({ query: transactionQuery, release: vi.fn() }),
    };
    const store = {
      put: vi.fn(),
      createReadUrl: vi.fn(),
      delete: vi.fn(),
    };

    await expect(
      runProfilePhotoMaintenanceCycle({
        pool: pool as never,
        config: {
          HOME_VIVA_SYNC_ENABLED: false,
          PROFILE_PHOTO_CLIENT_SYNC_ENABLED: false,
          PROFILE_PHOTO_MAINTENANCE_ENABLED: true,
          PROFILE_PHOTO_GC_BATCH_SIZE: 20,
        } as never,
        logger: { warn: vi.fn() } as never,
        profilePhotoStore: store,
      }),
    ).resolves.toEqual({ deleted: 0, deferred: 0, commandsDeleted: 2 });
    expect(pool.query).toHaveBeenCalledWith('select id from identity.tenants order by id');
    expect(store.delete).not.toHaveBeenCalled();
  });

  it('defers and reschedules a failed object deletion', async () => {
    const tenantId = '86afbe01-0318-4dd2-bc25-303b7bf0d430';
    const userId = '49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca';
    const objectKey = `profile-photos/${tenantId}/${userId}/${'a'.repeat(64)}.webp`;
    const transactionQuery = vi.fn((text: string) => {
      if (
        text === 'begin' ||
        text === 'commit' ||
        text === 'rollback' ||
        text.includes("set_config('app.tenant_id'") ||
        text.includes('pg_advisory_xact_lock')
      ) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (
        text.includes('from integration.profile_photo_object_gc') &&
        !text.includes('for update')
      ) {
        return Promise.resolve({ rows: [{ object_key: objectKey }], rowCount: 1 });
      }
      if (
        text.includes('from integration.profile_photo_object_gc') &&
        text.includes('for update')
      ) {
        return Promise.resolve({ rows: [{ object_key: objectKey }], rowCount: 1 });
      }
      if (
        text.includes('from integration.user_profile_photo_sync') ||
        text.includes('from integration.profile_photo_client_commands')
      ) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (text.includes('update integration.profile_photo_object_gc')) {
        return Promise.resolve({ rows: [], rowCount: 1 });
      }
      if (text.includes('delete from integration.profile_photo_client_commands')) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const pool = {
      query: vi.fn().mockResolvedValue({ rows: [{ id: tenantId }], rowCount: 1 }),
      connect: vi.fn().mockResolvedValue({ query: transactionQuery, release: vi.fn() }),
    };
    const store = {
      put: vi.fn(),
      createReadUrl: vi.fn(),
      delete: vi.fn().mockRejectedValue(new Error('storage timeout')),
    };

    await expect(
      runProfilePhotoMaintenanceCycle({
        pool: pool as never,
        config: { PROFILE_PHOTO_GC_BATCH_SIZE: 20 } as never,
        logger: { warn: vi.fn() } as never,
        profilePhotoStore: store,
      }),
    ).resolves.toEqual({ deleted: 0, deferred: 1, commandsDeleted: 0 });
    expect(store.delete).toHaveBeenCalledWith(objectKey);
    expect(
      transactionQuery.mock.calls.some(([text]) =>
        String(text).includes('update integration.profile_photo_object_gc'),
      ),
    ).toBe(true);
  });
});
